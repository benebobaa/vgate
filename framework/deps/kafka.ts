/**
 * Events the service publishes, read back from Kafka and held to each topic's JSON Schema.
 *
 * One consumer per worker reads every configured topic from the earliest offset into memory, in its own consumer
 * group. Tests find their message by a value they made unique (a customer id, an order id), so parallel tests never
 * see each other's events. `expectNone` is only meaningful once the consumer has read everything published so far:
 * it waits for the settle time, then until the consumer has caught up with every partition's end, then looks.
 */
import { readFileSync } from 'node:fs';
import { Consumer, stringDeserializers, type Message } from '@platformatic/kafka';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import type { KafkaDependency } from './config.ts';

const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (
  ajv: Ajv2020,
) => Ajv2020;

export interface ReceivedEvent {
  topic: string;
  partition: number;
  offset: bigint;
  key: string | undefined;
  headers: Record<string, string>;
  /** The parsed JSON value. */
  value: unknown;
  timestamp: bigint;
}

export interface WaitOptions {
  /** How long `expect` waits for a match. Default 10s. */
  timeoutMs?: number;
}

export interface NoneOptions {
  /** How long to give the service to publish (asynchronous publishers, outboxes). Default 1.5s. */
  settleMs?: number;
}

export class EventSchemaViolation extends Error {}

/** Compiles the schemas of the configured topics. Exported for the self-tests. */
export function topicValidators(topics: Record<string, { schema: string }>): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return new Map(
    Object.entries(topics).map(([topic, { schema }]) => [
      topic,
      ajv.compile(JSON.parse(readFileSync(schema, 'utf8')) as object),
    ]),
  );
}

/** Violations of one event's value against its topic's schema; [] when it conforms. */
export function eventViolations(validate: ValidateFunction | undefined, topic: string, value: unknown): string[] {
  if (!validate) return [`topic ${topic} is not configured (no schema to hold its events to)`];
  return validate(value)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class KafkaEvents {
  private readonly received: ReceivedEvent[] = [];
  /** topic/partition -> the next offset to read (last read + 1). */
  private readonly position = new Map<string, bigint>();
  private readonly validators: Map<string, ValidateFunction>;
  private readonly consumers: Array<Consumer<string, string, string, string>> = [];
  private readonly topicConsumer = new Map<string, Consumer<string, string, string, string>>();
  private failure: Error | undefined;

  private constructor(private readonly deps: Record<string, KafkaDependency>) {
    this.validators = topicValidators(Object.assign({}, ...Object.values(deps).map((dep) => dep.topics)) as never);
  }

  /** Starts one consumer per Kafka dependency, reading its topics from the earliest offset. */
  static async start(deps: Record<string, KafkaDependency>, groupPrefix: string): Promise<KafkaEvents> {
    const events = new KafkaEvents(deps);
    for (const [name, dep] of Object.entries(deps)) {
      const consumer = new Consumer({
        // A group of its own: no other consumer (another worker, the service itself) shares its partitions.
        groupId: `${groupPrefix}.${name}`,
        clientId: `${groupPrefix}.${name}`,
        bootstrapBrokers: dep.brokers,
        deserializers: stringDeserializers,
        autocommit: false,
        maxWaitTime: 200,
      });
      events.consumers.push(consumer);
      const topics = Object.keys(dep.topics);
      for (const topic of topics) events.topicConsumer.set(topic, consumer);
      const stream = await consumer.consume({ topics, mode: 'earliest', autocommit: false, maxWaitTime: 200 });
      stream.on('data', (message: Message<string, string, string, string>) => events.push(message));
      stream.on('error', (error: Error) => {
        events.failure = error;
      });
    }
    return events;
  }

  private push(message: Message<string, string, string, string>): void {
    let value: unknown = message.value;
    try {
      value = JSON.parse(message.value) as unknown;
    } catch {
      // not JSON: the schema check reports it when a test looks at the event
    }
    this.received.push({
      topic: message.topic,
      partition: message.partition,
      offset: message.offset,
      key: message.key || undefined,
      headers: Object.fromEntries(message.headerEntries),
      value,
      timestamp: message.timestamp,
    });
    this.position.set(`${message.topic}/${message.partition}`, message.offset + 1n);
  }

  private check(event: ReceivedEvent): void {
    const violations = eventViolations(this.validators.get(event.topic), event.topic, event.value);
    if (violations.length > 0)
      throw new EventSchemaViolation(
        `Event on ${event.topic} (partition ${event.partition}, offset ${event.offset}) breaks its schema:\n  ` +
          `${violations.join('\n  ')}\n  value: ${JSON.stringify(event.value)}`,
      );
  }

  private consumerOf(topic: string): Consumer<string, string, string, string> {
    const consumer = this.topicConsumer.get(topic);
    if (!consumer) throw new Error(`Topic ${topic} is not configured in any kafka dependency of service.yaml`);
    return consumer;
  }

  /** The first event on `topic` that satisfies `predicate`, schema-checked; fails after the timeout. */
  async expect<T = unknown>(
    topic: string,
    predicate: (value: T, event: ReceivedEvent) => boolean,
    options: WaitOptions = {},
  ): Promise<ReceivedEvent & { value: T }> {
    this.consumerOf(topic);
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    for (;;) {
      if (this.failure) throw this.failure;
      const found = this.received.find((event) => event.topic === topic && predicate(event.value as T, event));
      if (found) {
        this.check(found);
        return found as ReceivedEvent & { value: T };
      }
      if (Date.now() > deadline)
        throw new Error(
          `No event on ${topic} matched within ${options.timeoutMs ?? 10_000}ms ` +
            `(${this.received.filter((e) => e.topic === topic).length} events read from it)`,
        );
      await sleep(50);
    }
  }

  /** Every event on `topic` that satisfies `predicate`, after the consumer caught up; each schema-checked. */
  async published<T = unknown>(
    topic: string,
    predicate: (value: T, event: ReceivedEvent) => boolean,
    options: NoneOptions = {},
  ) {
    await sleep(options.settleMs ?? 1500);
    await this.catchUp(topic);
    const matches = this.received.filter((event) => event.topic === topic && predicate(event.value as T, event));
    matches.forEach((event) => this.check(event));
    return matches as Array<ReceivedEvent & { value: T }>;
  }

  /** Fails when an event on `topic` satisfies `predicate`: nothing was published for this test's data. */
  async expectNone<T = unknown>(
    topic: string,
    predicate: (value: T, event: ReceivedEvent) => boolean,
    options: NoneOptions = {},
  ): Promise<void> {
    const matches = await this.published(topic, predicate, options);
    if (matches.length > 0)
      throw new Error(
        `Expected no event on ${topic}, found ${matches.length}: ${matches.map((e) => JSON.stringify(e.value)).join(', ')}`,
      );
  }

  /** Waits until this consumer has read up to the end every partition of `topic` had when this was called. */
  private async catchUp(topic: string, timeoutMs = 15_000): Promise<void> {
    const consumer = this.consumerOf(topic);
    const ends = (await consumer.listOffsets({ topics: [topic] })).get(topic) ?? [];
    // Kafka's "earliest" timestamp (-2): a partition whose old messages were deleted starts above 0.
    const starts = (await consumer.listOffsets({ topics: [topic], timestamp: -2n })).get(topic) ?? [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.failure) throw this.failure;
      const behind = ends.flatMap((end, partition) =>
        (this.position.get(`${topic}/${partition}`) ?? starts[partition] ?? 0n) < end ? [partition] : [],
      );
      if (behind.length === 0) return;
      if (Date.now() > deadline)
        throw new Error(
          `The test consumer did not catch up with ${topic} partitions ${behind.join(', ')} in ${timeoutMs}ms`,
        );
      await sleep(50);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.consumers.map((consumer) => consumer.close(true).catch(() => undefined)));
  }
}

/**
 * A RabbitMQ broker (AMQP 0-9-1), for asserting what the service published and for feeding it messages.
 *
 * To observe without stealing: `spy(exchange, routingKey)` binds a private, exclusive queue to the exchange BEFORE the
 * test acts, so the service's own consumers still get every message and the test sees a copy. Reading a work queue
 * directly (`take`) consumes its messages; use it only on a queue nothing else drains.
 */
import { connect, type Channel, type ChannelModel, type Message } from 'amqplib';
import type { DependencyGuard } from '../http/write-guard.ts';

export interface AmqpMessage {
  routingKey: string;
  body: string;
  /** The body parsed as JSON, or the raw string. */
  value: unknown;
  headers: Record<string, unknown>;
}

const toMessage = (msg: Message): AmqpMessage => {
  const body = msg.content.toString('utf8');
  let value: unknown = body;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    // not JSON
  }
  return {
    routingKey: msg.fields.routingKey,
    body,
    value,
    headers: msg.properties.headers ?? {},
  };
};

export class AmqpSpy {
  private readonly received: AmqpMessage[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly channel: Channel,
    readonly queue: string,
    private readonly tag: string,
  ) {}

  /** @internal */
  push(message: AmqpMessage): void {
    this.received.push(message);
    for (const wake of this.waiters) wake();
  }

  /** The first message (since the spy started) for which `match` holds, within `timeoutMs`. */
  async expect(match: (message: AmqpMessage) => boolean, { timeoutMs = 10_000 } = {}): Promise<AmqpMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.received.find(match);
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(
          `No matching message on ${this.queue} after ${timeoutMs} ms (${this.received.length} others: ${
            this.received
              .slice(0, 3)
              .map((m) => `${m.routingKey} ${m.body.slice(0, 80)}`)
              .join(' | ') || 'none'
          })`,
        );
      await new Promise<void>((done) => {
        const wake = () => {
          this.waiters.delete(wake);
          clearTimeout(timer);
          done();
        };
        const timer = setTimeout(wake, left);
        this.waiters.add(wake);
      });
    }
  }

  /** No message matching `match` arrives within `withinMs`. */
  async expectNone(match: (message: AmqpMessage) => boolean = () => true, { withinMs = 2_000 } = {}): Promise<void> {
    await new Promise((done) => setTimeout(done, withinMs));
    const hit = this.received.find(match);
    if (hit) throw new Error(`Expected no message on ${this.queue}, got ${hit.routingKey} ${hit.body.slice(0, 120)}`);
  }

  get messages(): readonly AmqpMessage[] {
    return this.received;
  }

  async stop(): Promise<void> {
    await this.channel.cancel(this.tag).catch(() => undefined);
    await this.channel.deleteQueue(this.queue).catch(() => undefined);
  }
}

export class AmqpBroker {
  private constructor(
    private readonly connection: ChannelModel,
    private readonly channel: Channel,
    private readonly guard: DependencyGuard,
  ) {}

  /**
   * `amqp://user:password@host:port[/vhost]`. `guard` runs before each operation that changes the broker: `spy`
   * (declares a temporary queue and binding), `publish`, `take` (consumes a message). In a non-disposable environment
   * it refuses what `allowWrites` does not list (`<dependency>:publish`).
   */
  static async connect(url: string, guard: DependencyGuard = () => undefined): Promise<AmqpBroker> {
    const connection = await connect(url);
    // A broker-side error otherwise surfaces as an unhandled 'error' event that kills the worker.
    connection.on('error', () => undefined);
    const channel = await connection.createChannel();
    channel.on('error', () => undefined);
    return new AmqpBroker(connection, channel, guard);
  }

  /**
   * Starts observing `exchange` for `routingKey` (`#` for everything on a topic exchange). Call it before the action
   * that should publish; messages published earlier are not seen.
   */
  async spy(exchange: string, routingKey = '#'): Promise<AmqpSpy> {
    this.guard('spy');
    const { queue } = await this.channel.assertQueue('', { exclusive: true, autoDelete: true });
    await this.channel.bindQueue(queue, exchange, routingKey);
    // The consumer can deliver before `consume` resolves with the tag the spy needs: hold those messages until then.
    const sink: { spy?: AmqpSpy; pending: AmqpMessage[] } = { pending: [] };
    const { consumerTag } = await this.channel.consume(
      queue,
      (msg) => {
        if (!msg) return;
        const message = toMessage(msg);
        if (sink.spy) sink.spy.push(message);
        else sink.pending.push(message);
      },
      { noAck: true },
    );
    const spy = new AmqpSpy(this.channel, queue, consumerTag);
    for (const message of sink.pending) spy.push(message);
    sink.spy = spy;
    return spy;
  }

  /** Publishes to an exchange ('' is the default exchange: the routing key is then a queue name). */
  publish(exchange: string, routingKey: string, body: string | object, headers: Record<string, unknown> = {}): void {
    this.guard('publish');
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const contentType = typeof body === 'string' ? 'text/plain' : 'application/json';
    this.channel.publish(exchange, routingKey, Buffer.from(text), { headers, contentType, persistent: true });
  }

  /** Takes (and acknowledges) one message from a queue, or undefined when it is empty. Consumes it. */
  async take(queue: string): Promise<AmqpMessage | undefined> {
    this.guard('take');
    const msg = await this.channel.get(queue, { noAck: true });
    return msg ? toMessage(msg) : undefined;
  }

  async close(): Promise<void> {
    await this.channel.close().catch(() => undefined);
    await this.connection.close().catch(() => undefined);
  }
}

/**
 * SQS queues on LocalStack (or any SQS-compatible endpoint), for asserting what the service queued and for feeding it
 * messages. The query protocol (form-encoded, XML answers), which every SQS implementation speaks.
 */
import type { DependencyGuard } from '../http/write-guard.ts';
import { awsFetch, xmlValues, type AwsCredentials } from './aws-sign.ts';

export interface SqsConfig {
  endpoint: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
}

export interface QueueMessage {
  id: string;
  body: string;
  /** The body parsed as JSON, or the raw string. */
  value: unknown;
}

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
};

export class SqsQueues {
  private readonly endpoint: string;
  private readonly creds: AwsCredentials;

  /**
   * `guard` runs before each operation that changes a queue: `create`, `send`, and `receive` (which deletes what it
   * receives). In a non-disposable environment it refuses what `allowWrites` does not list (`<dependency>:send`).
   */
  constructor(
    config: SqsConfig,
    private readonly guard: DependencyGuard = () => undefined,
  ) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.creds = {
      accessKey: config.accessKey ?? 'test',
      secretKey: config.secretKey ?? 'test',
      region: config.region ?? 'us-east-1',
      service: 'sqs',
    };
  }

  private async action(params: Record<string, string>, url = `${this.endpoint}/`): Promise<string> {
    const body = new URLSearchParams({ ...params, Version: '2012-11-05' }).toString();
    const res = await awsFetch(
      { method: 'POST', url, body, headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      this.creds,
    );
    if (res.status >= 300) throw new Error(`SQS ${params.Action}: ${res.status} ${res.text}`);
    return res.text;
  }

  /**
   * A queue URL as the server wrote it, moved onto the configured endpoint. Servers build queue URLs from their own
   * idea of their address (ElasticMQ: localhost:9324, LocalStack: a *.localstack.cloud host on 4566), which is not the
   * per-run port the tests reach them on; only the path identifies the queue.
   */
  rebase(queueUrl: string): string {
    return `${this.endpoint}${new URL(queueUrl).pathname}`;
  }

  async create(name: string): Promise<string> {
    this.guard('create');
    return this.rebase(xmlValues(await this.action({ Action: 'CreateQueue', QueueName: name }), 'QueueUrl')[0]);
  }

  async urlOf(name: string): Promise<string> {
    const url = xmlValues(await this.action({ Action: 'GetQueueUrl', QueueName: name }), 'QueueUrl')[0];
    if (!url) throw new Error(`SQS: no queue ${name}`);
    return this.rebase(url);
  }

  async send(name: string, body: string | object): Promise<string> {
    this.guard('send');
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const xml = await this.action({ Action: 'SendMessage', MessageBody: text }, await this.urlOf(name));
    return xmlValues(xml, 'MessageId')[0];
  }

  /** Receives (and deletes) up to 10 messages, waiting up to `waitSeconds` for the first. */
  async receive(name: string, { waitSeconds = 1 } = {}): Promise<QueueMessage[]> {
    this.guard('receive');
    const url = await this.urlOf(name);
    const xml = await this.action(
      { Action: 'ReceiveMessage', MaxNumberOfMessages: '10', WaitTimeSeconds: String(waitSeconds) },
      url,
    );
    const ids = xmlValues(xml, 'MessageId');
    const bodies = xmlValues(xml, 'Body');
    const handles = xmlValues(xml, 'ReceiptHandle');
    for (const handle of handles) await this.action({ Action: 'DeleteMessage', ReceiptHandle: handle }, url);
    return ids.map((id, i) => ({ id, body: bodies[i], value: parse(bodies[i]) }));
  }

  /**
   * The first message on `name` for which `match` holds, within `timeoutMs`. Messages that do not match are consumed:
   * use a queue only the test reads (the service's output queue), never one another consumer drains.
   */
  async expectMessage(
    name: string,
    match: (message: QueueMessage) => boolean,
    { timeoutMs = 10_000 } = {},
  ): Promise<QueueMessage> {
    const deadline = Date.now() + timeoutMs;
    const seen: string[] = [];
    while (Date.now() < deadline) {
      for (const message of await this.receive(name, { waitSeconds: 1 })) {
        if (match(message)) return message;
        seen.push(message.body.slice(0, 120));
      }
    }
    throw new Error(
      `No matching message on SQS queue ${name} after ${timeoutMs} ms (${seen.length} others: ${seen.slice(0, 3).join(' | ') || 'none'})`,
    );
  }
}

/**
 * An S3-compatible store (the `s3` kind, LocalStack's S3, or any endpoint), for asserting what the service stored:
 * an object exists, its content, what a prefix holds. Path-style addressing, which every local store supports.
 */
import type { DependencyGuard } from '../http/write-guard.ts';
import { awsEncode, awsFetch, xmlValues, type AwsCredentials } from './aws-sign.ts';

export interface S3Config {
  endpoint: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
}

export interface StoredObject {
  body: string;
  contentType: string | null;
  size: number;
}

export class S3Store {
  private readonly endpoint: string;
  private readonly creds: AwsCredentials;

  /**
   * `guard` runs before each operation that changes the store (`create-bucket`, `put`); in a non-disposable environment
   * it refuses what `allowWrites` does not list (`<dependency>:put`). Reads are never guarded.
   */
  constructor(
    config: S3Config,
    private readonly guard: DependencyGuard = () => undefined,
  ) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.creds = {
      accessKey: config.accessKey ?? 'vgate',
      secretKey: config.secretKey ?? 'vgate-secret',
      region: config.region ?? 'us-east-1',
      service: 's3',
    };
  }

  private url(bucket: string, key = '', query = ''): string {
    const path = key ? `/${awsEncode(bucket)}/${key.split('/').map(awsEncode).join('/')}` : `/${awsEncode(bucket)}`;
    return `${this.endpoint}${path}${query}`;
  }

  private call(method: string, url: string, body?: string, headers?: Record<string, string>) {
    return awsFetch({ method, url, body, headers, contentSha256Header: true }, this.creds);
  }

  async createBucket(bucket: string): Promise<void> {
    this.guard('create-bucket');
    const res = await this.call('PUT', this.url(bucket));
    // 409: it exists already, owned by us (BucketAlreadyOwnedByYou) - fine for a test setup.
    if (res.status >= 300 && res.status !== 409)
      throw new Error(`S3 create bucket ${bucket}: ${res.status} ${res.text}`);
  }

  async put(bucket: string, key: string, body: string, contentType = 'application/octet-stream'): Promise<void> {
    this.guard('put');
    const res = await this.call('PUT', this.url(bucket, key), body, { 'content-type': contentType });
    if (res.status >= 300) throw new Error(`S3 put ${bucket}/${key}: ${res.status} ${res.text}`);
  }

  /** The object, or undefined when there is none. */
  async get(bucket: string, key: string): Promise<StoredObject | undefined> {
    const res = await this.call('GET', this.url(bucket, key));
    if (res.status === 404) return undefined;
    if (res.status >= 300) throw new Error(`S3 get ${bucket}/${key}: ${res.status} ${res.text}`);
    return {
      body: res.text,
      contentType: res.headers.get('content-type'),
      size: Number(res.headers.get('content-length') ?? res.text.length),
    };
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    const res = await this.call('HEAD', this.url(bucket, key));
    if (res.status === 404) return false;
    if (res.status >= 300) throw new Error(`S3 head ${bucket}/${key}: ${res.status}`);
    return true;
  }

  /** Every key under `prefix`, following continuation tokens. */
  async list(bucket: string, prefix = ''): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query = `?list-type=2&prefix=${awsEncode(prefix)}${token ? `&continuation-token=${awsEncode(token)}` : ''}`;
      const res = await this.call('GET', this.url(bucket, '', query));
      if (res.status >= 300) throw new Error(`S3 list ${bucket}/${prefix}: ${res.status} ${res.text}`);
      keys.push(...xmlValues(res.text, 'Key'));
      token =
        xmlValues(res.text, 'IsTruncated')[0] === 'true' ? xmlValues(res.text, 'NextContinuationToken')[0] : undefined;
    } while (token);
    return keys;
  }

  /** Waits until `bucket/key` exists (the service may store it after answering) and returns it. */
  async expectObject(bucket: string, key: string, { timeoutMs = 10_000 } = {}): Promise<StoredObject> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await this.get(bucket, key);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`No object ${bucket}/${key} after ${timeoutMs} ms`);
      await new Promise((done) => setTimeout(done, 250));
    }
  }
}

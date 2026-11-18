/** Read access to the service's Redis, for asserting what a call cached (or did not cache) and for how long. */
import { createClient } from 'redis';

export interface CachedEntry {
  /** The raw string value. */
  raw: string;
  /** The value parsed as JSON, or the raw string when it is not JSON. */
  value: unknown;
  /** Seconds left; -1 when the key never expires. */
  ttlSeconds: number;
}

function newClient(url: string) {
  return createClient({ url });
}

export class RedisCache {
  private constructor(private readonly client: ReturnType<typeof newClient>) {}

  static async connect(url: string): Promise<RedisCache> {
    const client = newClient(url);
    // A connection error otherwise surfaces as an unhandled 'error' event that kills the worker.
    client.on('error', () => undefined);
    await client.connect();
    return new RedisCache(client);
  }

  /** The entry at `key`, or undefined when there is none. Only string values (what caches usually hold). */
  async get(key: string): Promise<CachedEntry | undefined> {
    const raw = await this.client.get(key);
    if (raw === null) return undefined;
    let value: unknown = raw;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      // a plain string
    }
    return { raw, value, ttlSeconds: await this.client.ttl(key) };
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  /** Seconds left at `key`: -1 without expiry, -2 when the key does not exist (Redis's own convention). */
  ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  /** Keys matching a glob pattern, by SCAN (never KEYS, which blocks a shared Redis). */
  async keys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    for await (const batch of this.client.scanIterator({ MATCH: pattern, COUNT: 200 })) found.push(...batch);
    return found;
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

/**
 * A third party replaced by WireMock, held to the provider's own contract in both directions:
 * - `stub()` refuses a response the contract does not document for that operation and status, or whose body breaks
 *   its schema. A stub that lies about the provider makes a green test that proves nothing.
 * - `calls()` returns what the service under test sent, each request checked against the provider's request schema.
 *
 * Isolation under parallel workers is by design, not by luck: every stub must match on a value of the request that
 * the test made unique (`match`), so one test's stub never answers another test's call, and `calls()` only sees the
 * requests that carry it. The stubs a test created are removed when it ends.
 */
import { OpenApiContract } from '../http/openapi.ts';
import type { HttpStubDependency } from './config.ts';
import { frameworkFetch } from '../http/write-guard.ts';

/** JSONPath (as WireMock reads it) -> the exact value the request must carry there, e.g. `{ '$.customer': id }`. */
export type BodyMatch = Record<string, string | number | boolean>;

export interface StubSpec {
  /** `POST /charges`: an operation of the provider's contract, path as documented (templates allowed). */
  operation: string;
  /** What makes the request this test's own. Required and non-empty: a catch-all stub would steal other tests' calls. */
  match: BodyMatch;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** WireMock's own delay before answering (no toxiproxy needed); use faults for outages. */
  delayMs?: number;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** What the coverage of a provider's contract counts: which documented (operation, status) a test stubbed. */
export interface StubRecord {
  dependency: string;
  operation: string;
  status: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A WireMock URL matcher for a documented path: templates become a regex, anything else is matched exactly. */
export function urlMatcher(path: string): { urlPath: string } | { urlPathPattern: string } {
  if (!path.includes('{')) return { urlPath: path };
  const escaped = path
    .split(/\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return { urlPathPattern: `^${escaped}$` };
}

/** `$.a.b[0]`: the JSONPaths a match may use, so the framework evaluates them exactly as WireMock does. */
const SIMPLE_PATH = /^\$(\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])+$/;

/** The value at a simple JSONPath, or undefined. */
export function jsonPathValue(body: unknown, expression: string): unknown {
  if (!SIMPLE_PATH.test(expression)) throw new Error(`Not a simple JSONPath: ${expression}`);
  let at: unknown = body;
  for (const [, field, index] of expression.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g)) {
    if (field !== undefined) at = isRecord(at) ? at[field] : undefined;
    else at = Array.isArray(at) ? (at as unknown[])[Number(index)] : undefined;
  }
  return at;
}

/** Whether `body` carries every value of `match` (compared as strings, like WireMock's equalTo). */
export function bodyMatches(body: unknown, match: BodyMatch): boolean {
  return Object.entries(match).every(([expression, expected]) => {
    const value = jsonPathValue(body, expression);
    const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    return scalar && String(value) === String(expected);
  });
}

/** WireMock body patterns: one `matchesJsonPath` + `equalTo` per matched field. */
export function bodyPatterns(match: BodyMatch): unknown[] {
  return Object.entries(match).map(([expression, value]) => ({
    matchesJsonPath: { expression, equalTo: String(value) },
  }));
}

export function splitOperation(operation: string): { method: string; path: string } {
  const match = /^([A-Z]+)\s+(\/\S*)$/.exec(operation.trim());
  if (!match) throw new Error(`"${operation}" is not an operation; write it as "<METHOD> /path", e.g. "POST /charges"`);
  return { method: match[1], path: match[2] };
}

/**
 * Why a stub may not be created, or [] when the contract allows it. Pure: the core of the rule that a stub may not
 * lie about the provider.
 */
export function stubViolations(contract: OpenApiContract, spec: StubSpec): string[] {
  const { method, path } = splitOperation(spec.operation);
  const op = contract.operation(method, path);
  if (!op) return [`${spec.operation} is not an operation of the provider's contract`];
  if (Object.keys(spec.match).length === 0)
    return ['match is empty: a stub must match on a value this test made unique, or it answers other tests too'];
  const unsupported = Object.keys(spec.match).filter((expression) => !SIMPLE_PATH.test(expression));
  if (unsupported.length > 0)
    return [`match supports only simple JSONPaths like $.a.b[0], not ${unsupported.join(', ')}`];
  const status = String(spec.status);
  if (!op.responses.has(status) && !op.responses.has(`${status[0]}XX`) && !op.responses.has('default'))
    return [
      `status ${spec.status} is not documented for ${op.key} (documented: ${[...op.responses.keys()].join(', ')})`,
    ];
  return contract.validateResponse(method, path, spec.status, spec.body ?? null);
}

export class StubViolation extends Error {}

export class HttpStub {
  private readonly created: string[] = [];

  constructor(
    readonly name: string,
    private readonly config: HttpStubDependency,
    readonly contract: OpenApiContract,
    /** Called for every stub created, for the provider-coverage report. */
    private readonly onStub: (record: StubRecord) => void = () => {},
  ) {}

  static forDependency(name: string, config: HttpStubDependency, onStub?: (record: StubRecord) => void): HttpStub {
    return new HttpStub(
      name,
      config,
      OpenApiContract.load(config.contract, { strictResponseProperties: true }),
      onStub,
    );
  }

  private async admin(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await frameworkFetch(`${this.config.adminUrl}/__admin${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`WireMock ${this.name}: ${init.method ?? 'GET'} ${path} -> ${response.status} ${text}`);
    return text ? (JSON.parse(text) as unknown) : undefined;
  }

  /** Answers the matching requests with `spec`; refuses what the provider's contract does not document. */
  async stub(spec: StubSpec): Promise<StubHandle> {
    const violations = stubViolations(this.contract, spec);
    if (violations.length > 0)
      throw new StubViolation(
        `Stub of ${this.name} ${spec.operation} -> ${spec.status} refused: the provider's contract ` +
          `(${this.config.contract}) does not allow it:\n  ${violations.join('\n  ')}`,
      );
    const { method, path } = splitOperation(spec.operation);
    const response: Record<string, unknown> = {
      status: spec.status,
      headers: { ...(spec.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...spec.headers },
    };
    if (spec.body !== undefined) response.jsonBody = spec.body;
    if (spec.delayMs) response.fixedDelayMilliseconds = spec.delayMs;
    const mapping = (await this.admin('/mappings', {
      method: 'POST',
      body: JSON.stringify({
        request: { method, ...urlMatcher(path), bodyPatterns: bodyPatterns(spec.match) },
        response,
        // Ours, not WireMock's defaults: a fixed priority above any catch-all a stack may define.
        priority: 1,
        metadata: { vgate: { dependency: this.name, operation: spec.operation } },
      }),
    })) as { id: string };
    this.created.push(mapping.id);
    this.onStub({ dependency: this.name, operation: `${method} ${path}`, status: spec.status });
    return new StubHandle(this, mapping.id, spec.operation, spec.match);
  }

  /** The requests the service sent to `operation` that carry `match`, each held to the provider's request schema. */
  async calls(operation: string, match: BodyMatch): Promise<RecordedCall[]> {
    const { method, path } = splitOperation(operation);
    const unsupported = Object.keys(match).filter((expression) => !SIMPLE_PATH.test(expression));
    if (unsupported.length > 0)
      throw new Error(`calls() supports only simple JSONPaths like $.a.b[0], not ${unsupported.join(', ')}`);
    // The body match is evaluated here, not by WireMock: its journal search caches parsed bodies by Java String
    // hashCode, so two bodies with colliding hashes (run-unique ids such as `cus.r.3n` and `cus.r.50` do) return each
    // other's requests, or none. Live stub matching is not affected; only the search is.
    const found = (await this.admin('/requests/find', {
      method: 'POST',
      body: JSON.stringify({ method, ...urlMatcher(path) }),
    })) as { requests: Array<{ method: string; url: string; headers?: Record<string, string>; body?: string }> };
    return found.requests.flatMap((request) => {
      let body: unknown;
      try {
        body = request.body ? (JSON.parse(request.body) as unknown) : undefined;
      } catch {
        return []; // not JSON: it cannot carry the match
      }
      if (!bodyMatches(body, match)) return [];
      const violations = this.contract.validateRequest(method, path, body);
      if (violations.length > 0)
        throw new StubViolation(
          `The service sent ${this.name} a request its contract does not allow: ${operation}\n  ` +
            `${violations.join('\n  ')}\n  body: ${request.body ?? ''}`,
        );
      return [
        {
          method: request.method,
          url: request.url,
          headers: isRecord(request.headers) ? request.headers : {},
          body,
        },
      ];
    });
  }

  /** Removes one stub this instance created, e.g. to answer the same request differently later in the test. */
  async remove(id: string): Promise<void> {
    const index = this.created.indexOf(id);
    if (index === -1) throw new Error(`Stub ${id} was not created by this test's ${this.name} stubs`);
    await this.admin(`/mappings/${id}`, { method: 'DELETE' });
    this.created.splice(index, 1);
  }

  /** Removes the stubs this instance created. Requests stay in WireMock's journal; `calls()` filters by `match`. */
  async cleanup(): Promise<void> {
    const ids = this.created.splice(0);
    await Promise.all(ids.map((id) => this.admin(`/mappings/${id}`, { method: 'DELETE' }).catch(() => undefined)));
  }
}

/** A created stub: `calls()` returns the requests it answered (or would have), by the same match. */
export class StubHandle {
  constructor(
    private readonly stub: HttpStub,
    readonly id: string,
    readonly operation: string,
    readonly match: BodyMatch,
  ) {}

  calls(): Promise<RecordedCall[]> {
    return this.stub.calls(this.operation, this.match);
  }

  /** Stops answering (the calls it answered stay readable through `calls()`). */
  remove(): Promise<void> {
    return this.stub.remove(this.id);
  }
}

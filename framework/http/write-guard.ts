/**
 * The write guard: in an environment that is not disposable (staging, production), a test may read, never write.
 * The guard sits in the client, in front of every request the tests make through the framework (calls, streams,
 * webhooks, session logins, Playwright's `request` fixture): a request that is not read-only fails the test before it
 * leaves the machine, unless the environment lists the operation in `allowWrites` (a synthetic account's login, for
 * instance). Read-only means GET, HEAD or OPTIONS, or an operation the contract's owners marked as writing nothing
 * (`schemathesis.readOnlyPaths` / `readOnlyMethods`, the same rule the contract step uses).
 *
 * The same rule covers what else a test can reach: the dependency helpers (a queue publish, an object put, an SQL
 * write; `dependency:operation` in `allowWrites`, see guardDependency), and a test's own `fetch` or node:http(s)
 * request (installRawGuard: judged by its path when it goes to the base URL, refused when it writes anywhere else).
 * http2, a raw socket or a child process stays outside it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { ClientRequest } from 'node:http';
import type { APIRequestContext } from '@playwright/test';
import type { EnvironmentConfig, SchemathesisConfig } from '../config.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class WriteRefused extends Error {
  constructor(
    readonly environment: string,
    readonly operation: string,
  ) {
    super(
      `write refused in environment ${environment}: ${operation} is not read-only, and the environment is not ` +
        `disposable. Mark the test out of the smoke subset, or list the operation in environments.${environment}.` +
        `allowWrites when it is safe there (docs/after-deploy.md).`,
    );
    this.name = 'WriteRefused';
  }
}

/** Is `METHOD template` read-only: a safe method, or an operation the service marks as writing nothing? */
export function isReadOnly(method: string, template: string, readOnly: SchemathesisConfig = {}): boolean {
  const verb = method.toUpperCase();
  if (SAFE_METHODS.has(verb)) return true;
  const { readOnlyPaths, readOnlyMethods } = readOnly;
  if (readOnlyPaths === undefined && readOnlyMethods === undefined) return false;
  const pathOk = readOnlyPaths === undefined || new RegExp(readOnlyPaths).test(template);
  const methodOk = readOnlyMethods === undefined || readOnlyMethods.map((m) => m.toUpperCase()).includes(verb);
  return pathOk && methodOk;
}

/** Does `allowWrites` list `METHOD template` (or the bare template, for every method)? */
export function isAllowedWrite(method: string, template: string, allowWrites: string[] = []): boolean {
  const verb = method.toUpperCase();
  return allowWrites.some((entry) => {
    const [first, second] = entry.trim().split(/\s+/);
    return second === undefined ? first === template : first.toUpperCase() === verb && second === template;
  });
}

/** Headers some servers take for the request's real method (method spoofing). */
const OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override'];

/** The methods a request with these headers may be taken for, besides its own. */
function overriddenMethods(headers: Record<string, string> = {}): string[] {
  return Object.entries(headers)
    .filter(([name, value]) => OVERRIDE_HEADERS.includes(name.toLowerCase()) && typeof value === 'string')
    .map(([, value]) => value.trim());
}

/**
 * A path the server sees as written: no query or fragment, no backslash or encoded slash, no `.` or `..` segment
 * (plain or percent-encoded). Anything else can resolve to another operation than the one judged, e.g.
 * `/search/../items`, so a write to it is never read-only or allowed.
 */
export function isPlainPath(path: string): boolean {
  if (!path.startsWith('/') || /[?#\\]|%(2f|5c)/i.test(path)) return false;
  return !path.split('/').some((segment) => /^(\.|%2e){1,2}$/i.test(segment));
}

/**
 * Throws WriteRefused when the environment is not disposable and `METHOD template` is neither read-only nor allowed.
 * A disposable environment (local, a sealed run) is never guarded: writing is what its tests are for. `request` is
 * what goes out: the path with its parameters filled in, and the headers (a method-override header is judged as the
 * method it names).
 */
export function guardWrite(
  env: Pick<EnvironmentConfig, 'name' | 'disposable' | 'allowWrites'>,
  method: string,
  template: string,
  readOnly?: SchemathesisConfig,
  request: { path?: string; headers?: Record<string, string> } = {},
): void {
  if (env.disposable) return;
  const plain = isPlainPath(template) && isPlainPath(request.path ?? template);
  for (const verb of [method, ...overriddenMethods(request.headers)]) {
    if (SAFE_METHODS.has(verb.toUpperCase())) continue;
    if (plain && (isReadOnly(verb, template, readOnly) || isAllowedWrite(verb, template, env.allowWrites))) continue;
    throw new WriteRefused(env.name, `${verb.toUpperCase()} ${request.path ?? template}`);
  }
}

const UNGUARDED = Symbol('unguarded request context');
const VERBS: Record<string, string> = {
  get: 'GET',
  head: 'HEAD',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
};

/**
 * Playwright's own `request` fixture with the same guard in front: a test that calls the service without the client
 * is held to the same rule. A URL of the environment is judged by its path below the base URL; a write to any other
 * host is never allowed.
 */
export function guardRequest(
  request: APIRequestContext,
  env: Pick<EnvironmentConfig, 'name' | 'disposable' | 'allowWrites' | 'baseUrl'>,
  readOnly?: SchemathesisConfig,
): APIRequestContext {
  if (env.disposable) return request;
  const base = new URL(env.baseUrl);
  const basePath = base.pathname.replace(/\/$/, '');
  const check = (method: string, url: string, headers?: Record<string, string>) => {
    const target = new URL(url, base);
    const own = target.origin === base.origin && (target.pathname + '/').startsWith(`${basePath}/`);
    const path = own ? target.pathname.slice(basePath.length) || '/' : target.href;
    guardWrite(env, method, path, readOnly, { headers });
  };
  return new Proxy(request, {
    get(target, prop) {
      if (prop === UNGUARDED) return target;
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (typeof prop !== 'string' || (!Object.hasOwn(VERBS, prop) && prop !== 'fetch')) return fn.bind(target);
      return async (urlOrRequest: string | { url(): string; method(): string }, options?: FetchOptions) => {
        const url = typeof urlOrRequest === 'string' ? urlOrRequest : urlOrRequest.url();
        const method =
          VERBS[prop] ?? options?.method ?? (typeof urlOrRequest === 'string' ? 'GET' : urlOrRequest.method());
        check(method, url, options?.headers);
        return await fn.call(target, urlOrRequest, options);
      };
    },
  });
}

type FetchOptions = { method?: string; headers?: Record<string, string> };

/** The context behind guardRequest (the client guards each call by its operation's template itself). */
export function unguarded(request: APIRequestContext): APIRequestContext {
  return (request as unknown as Record<symbol, APIRequestContext | undefined>)[UNGUARDED] ?? request;
}

/** Is `dependency:operation` listed in `allowWrites`? Only the exact pair: no wildcards. */
export function isAllowedDependencyWrite(dependency: string, operation: string, allowWrites: string[] = []): boolean {
  return allowWrites.some((entry) => entry.trim() === `${dependency}:${operation}`);
}

/** A check a dependency helper runs before each operation that changes the dependency's data. */
export type DependencyGuard = (operation: string) => void;

/**
 * The guard of one dependency in one environment: a no-op when the environment is disposable, else a check that
 * throws WriteRefused for every writing operation not listed as `dependency:operation` in `allowWrites`.
 */
export function guardDependency(
  env: Pick<EnvironmentConfig, 'name' | 'disposable' | 'allowWrites'>,
  dependency: string,
): DependencyGuard {
  if (env.disposable) return () => undefined;
  return (operation) => {
    if (!isAllowedDependencyWrite(dependency, operation, env.allowWrites))
      throw new WriteRefused(env.name, `${dependency}:${operation}`);
  };
}

/**
 * The statement as MySQL parses it, for isReadOnlySql: quoted strings and names blanked, comments dropped, so that
 * neither can hide a `;` or a keyword (`SELECT '#'; DELETE ...`). Undefined when that is not clear: an unterminated
 * string or comment, or a `/*! ... *\/` comment, whose body MySQL runs.
 */
function sqlCode(sql: string): string | undefined {
  let code = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== c) j += sql[j] === '\\' && c !== '`' ? 2 : 1;
      if (j >= sql.length) return undefined;
      code += ' ? ';
      i = j + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (sql[i + 2] === '!' || end < 0) return undefined;
      code += ' ';
      i = end + 2;
    } else if (c === '#' || (sql.startsWith('--', i) && (i + 2 >= sql.length || /\s/.test(sql[i + 2])))) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
    } else {
      code += c;
      i += 1;
    }
  }
  return code.trim();
}

/** SQL that only reads: one SELECT, SHOW, DESCRIBE/DESC, EXPLAIN or WITH statement without a writing keyword. */
export function isReadOnlySql(sql: string): boolean {
  const text = sqlCode(sql);
  if (text === undefined || text.replace(/;\s*$/, '').includes(';')) return false; // several statements
  const first = /^\(*\s*([a-z]+)/i.exec(text)?.[1]?.toUpperCase();
  if (first === undefined || !['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH'].includes(first)) return false;
  return !/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|INTO\s+(OUT|DUMP)FILE|LOCK\s+IN\s+SHARE\s+MODE)\b/i.test(text);
}

/** The environment whose writes the raw guard judges. */
export interface RawTargets {
  /** The environment's base URL: a write to it is judged by its path like the client's (readOnlyPaths, allowWrites). */
  baseUrl: string;
}

type FetchFn = typeof globalThis.fetch;

// The fetch as it was when the framework loaded.
const originalFetch: FetchFn = globalThis.fetch.bind(globalThis);

/** Marks the framework's own requests while they are made, through every await and redirect. */
const frameworkCall = new AsyncLocalStorage<true>();

/**
 * Runs `fn` as one of the framework's own calls (the client's, stream calls, session logins, stubs, Keycloak,
 * dependency helpers). Each of those is guarded by its own rule (the operation's template, `dependency:operation`), so
 * the raw guard, which judges a test's own requests by their concrete URL, leaves the requests made inside `fn` alone.
 * Never for test code: the lint step refuses importing it in a service's tests and support code.
 */
export function asFramework<T>(fn: () => T): T {
  return frameworkCall.run(true, fn);
}

/** fetch for the framework's own calls (see asFramework). */
export const frameworkFetch: FetchFn = (input, init) => asFramework(() => originalFetch(input, init));

/** Request headers as a lower-cased record: undici's flat `[name, value, ...]` list, its raw text, or an object. */
function headerRecord(headers: unknown): Record<string, string> {
  const pairs: Array<[unknown, unknown]> = [];
  if (Array.isArray(headers)) for (let i = 0; i + 1 < headers.length; i += 2) pairs.push([headers[i], headers[i + 1]]);
  else if (typeof headers === 'string')
    for (const line of headers.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) pairs.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
    }
  else if (headers && typeof headers === 'object') pairs.push(...Object.entries(headers));
  return Object.fromEntries(pairs.map(([name, value]) => [String(name).toLowerCase(), String(value)]));
}

interface UndiciRequest {
  method: string;
  origin: unknown;
  path: string;
  headers: unknown;
  onError(error: Error): void;
}

/**
 * Holds a test's own HTTP requests to the guard, however it makes them: `fetch` (also a reference to it taken before
 * the guard was installed, and every redirect it follows) and node's http/https (`request`, `get`, a ClientRequest, a
 * library on top of them). They are judged on node's diagnostics channels as they go out: after redirects, with their
 * final URL, method and headers. A write to the environment's base URL is judged by its path, like the client's calls;
 * a write to any other host is refused, as Playwright's `request` fixture does (it may be the environment under
 * another name: an IP address, another port, a trailing dot). The framework's own calls (asFramework) are left alone.
 * http2, raw sockets and child processes are not seen. Returns the function that removes the guard. A no-op in a
 * disposable environment.
 */
export function installRawGuard(
  env: Pick<EnvironmentConfig, 'name' | 'disposable' | 'allowWrites'>,
  targets: RawTargets,
  readOnly?: SchemathesisConfig,
): () => void {
  if (env.disposable) return () => undefined;
  const base = new URL(targets.baseUrl);
  const basePath = base.pathname.replace(/\/$/, '');
  /** The WriteRefused a request earns, if any. `rawPath`: the path as sent, before URL parsing tidies it. */
  const refusal = (
    method: string,
    url: string,
    headers: Record<string, string>,
    rawPath?: string,
  ): WriteRefused | undefined => {
    let target: URL | undefined;
    try {
      target = new URL(url);
    } catch {
      target = undefined;
    }
    const own =
      target !== undefined && target.origin === base.origin && `${target.pathname}/`.startsWith(`${basePath}/`);
    const template = own ? target!.pathname.slice(basePath.length) || '/' : (target?.href ?? url);
    const sent = own
      ? ((rawPath?.startsWith(basePath) ? rawPath.slice(basePath.length) : undefined) ?? template + target!.search)
      : undefined;
    try {
      guardWrite(env, method, template, readOnly, { path: sent, headers });
      return undefined;
    } catch (error) {
      if (error instanceof WriteRefused) return error;
      throw error;
    }
  };
  const onFetch = (message: unknown) => {
    if (frameworkCall.getStore()) return;
    const request = (message as { request: UndiciRequest }).request;
    const refused = refusal(
      request.method,
      `${String(request.origin).replace(/\/$/, '')}${request.path}`,
      headerRecord(request.headers),
    );
    if (refused) request.onError(refused);
  };
  const onHttp = (message: unknown) => {
    if (frameworkCall.getStore()) return;
    const request = (message as { request: ClientRequest }).request;
    const host = request.getHeader('host') ?? request.host;
    const refused = refusal(
      request.method,
      `${request.protocol}//${String(host)}${request.path}`,
      headerRecord(request.getHeaders()),
      request.path,
    );
    if (refused) request.destroy(refused);
  };
  subscribe('undici:request:create', onFetch);
  subscribe('http.client.request.start', onHttp);
  // A direct fetch fails with the guard's own error, not fetch's generic 'fetch failed' with it as the cause.
  const before = globalThis.fetch;
  const withReason = ((input, init) =>
    before(input, init).catch((error: unknown) => {
      const cause = (error as { cause?: unknown } | undefined)?.cause;
      throw cause instanceof WriteRefused ? cause : error;
    })) as FetchFn;
  globalThis.fetch = withReason;
  return () => {
    unsubscribe('undici:request:create', onFetch);
    unsubscribe('http.client.request.start', onHttp);
    if (globalThis.fetch === withReason) globalThis.fetch = before;
  };
}

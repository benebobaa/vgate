import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, type APIRequestContext } from '@playwright/test';
import type { Auth, AuthHeaders } from '../auth/auth.ts';
import type { EnvelopeRules, ServiceConfig, StreamingRules } from '../config.ts';
import { signWebhook, type SignOptions } from '../webhooks/sign.ts';
import type { OpenApiContract } from './openapi.ts';
import { checkDatetimeOffsets, checkHeaders } from './rules.ts';
import { isEventStream, isMarkerOnly, parseSse, SseParser, terminalOf, type SseEvent } from './sse.ts';
import { guardWrite } from './write-guard.ts';

// ---- Types derived from openapi-typescript's `paths` ------------------------------------------------------------

type SuccessStatus = 200 | 201 | 202 | 204 | '200' | '201' | '202' | '204';
type ContentOf<R> = R extends { content: infer C } ? C[keyof C] : never;
type Responses<O> = O extends { responses: infer R } ? R : never;

/** The methods a contract types (openapi-typescript keys, lower case). */
export type TypedMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
/** Paths of the contract that answer `M`. */
export type PathOf<P, M extends TypedMethod> = {
  [K in keyof P]-?: P[K] extends Record<M, infer O> ? ([O] extends [undefined] ? never : K) : never;
}[keyof P] &
  string;
/** The operation object of `M path`. */
export type OpOf<P, K, M extends TypedMethod> = K extends keyof P
  ? P[K] extends Record<M, infer O>
    ? O
    : never
  : never;
export type PostPath<P> = PathOf<P, 'post'>;
export type PostOp<P, K> = OpOf<P, K, 'post'>;
export type RequestBodyOf<O> = O extends { requestBody?: { content: infer C } } ? C[keyof C] : never;
type ParametersIn<O, In extends 'query' | 'path'> = O extends { parameters: infer Ps }
  ? Ps extends Partial<Record<In, infer X>>
    ? NonNullable<X>
    : never
  : never;
/** The operation's query parameters (never when it documents none). */
export type QueryOf<O> = ParametersIn<O, 'query'>;
/** The operation's path parameters, or any `{name}` values when the contract types none. */
export type PathParamsOf<O> = [ParametersIn<O, 'path'>] extends [never] ? PathParams : ParametersIn<O, 'path'>;
/** The call options of one operation, typed by its contract. */
export type OptionsOf<O> = CallOptions<RequestBodyOf<O>, QueryOf<O>, PathParamsOf<O>>;
/** Any documented response body of the operation. */
export type ResponseUnion<O> = { [S in keyof Responses<O>]: ContentOf<Responses<O>[S]> }[keyof Responses<O>];
export type SuccessBody<O> = {
  [S in Extract<keyof Responses<O>, SuccessStatus>]: ContentOf<Responses<O>[S]>;
}[Extract<keyof Responses<O>, SuccessStatus>];
export type ErrorBody<O> = {
  [S in Exclude<keyof Responses<O>, SuccessStatus>]: ContentOf<Responses<O>[S]>;
}[Exclude<keyof Responses<O>, SuccessStatus>];
/** The envelope's data of a success response (or the whole body for services without an envelope). */
export type SuccessData<O> = NonNullable<SuccessBody<O>> extends { data?: infer D } ? NonNullable<D> : SuccessBody<O>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type PathParams = Record<string, string | number>;
export type QueryValue = string | number | boolean | Array<string | number | boolean> | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface CallOptions<B = unknown, Q = QueryParams, PP = PathParams> {
  /** Values for `{name}` segments of the path template. */
  params?: PP;
  /** Query parameters that match the contract (type-checked); arrays repeat the key (`form`, `explode`). */
  query?: Q;
  /** Deliberately invalid query parameters (not type-checked), for validation scenarios. */
  invalidQuery?: Record<string, unknown>;
  /** A body that matches the contract (type-checked). */
  body?: B;
  /** A deliberately invalid body (not type-checked), for validation scenarios. */
  invalidBody?: unknown;
  /** Sent verbatim, e.g. malformed JSON. */
  rawBody?: string;
  headers?: Record<string, string>;
  /** Origin header; defaults to the environment's origin, `null` sends none. */
  origin?: string | null;
  /**
   * `false` skips the contract, header and datetime checks, for calls that are deliberately outside the contract
   * (an undocumented method, an unknown path). Say why in the test.
   */
  validate?: boolean;
  /**
   * Streams only: accept a stream that ends without its terminal marker (cut off, stalled), for a test that asserts
   * exactly that. Every event that arrived is still validated; `complete` and `ending` say what happened.
   */
  allowIncomplete?: boolean;
  /** Streams only (`stream()`): the longest wait for the next event; default `rules.streaming.eventTimeoutMs`, 30s. */
  eventTimeoutMs?: number;
}

/** How a stream ended. */
export type StreamEnding =
  /** A terminal marker arrived (or, with no terminal configured, the server closed the stream). */
  | 'terminal'
  /** The server closed the stream before a terminal marker. */
  | 'closed'
  /** The connection broke while the stream was open. */
  | 'cut-off'
  /** No event arrived within the event timeout. */
  | 'stalled';

/** Options of a signed webhook delivery (ApiClient.webhook). */
export interface WebhookOptions extends SignOptions {
  /** Deliver without any signature header. */
  unsigned?: boolean;
  /** The body actually sent, after signing the original: a tampered delivery. */
  bodyAfterSigning?: string;
  headers?: Record<string, string>;
  validate?: boolean;
}

export interface CallRecord {
  method: string;
  path: string;
  url: string;
  status: number;
  code?: string;
  requestId?: string;
  durationMs: number;
  requestBody?: string;
  responseBody: string;
  /** Streams: how many events arrived and how the stream ended. */
  events?: number;
  ending?: StreamEnding;
  /** False for calls made outside the contract on purpose: they neither cover nor violate it. */
  validated: boolean;
}

/** Collects the calls of one test: the observed-coverage feed and the failure attachment. */
export class CallRecorder {
  readonly calls: CallRecord[] = [];

  constructor(
    private readonly observedFile: string | undefined,
    private readonly test: string,
  ) {
    if (observedFile) mkdirSync(dirname(observedFile), { recursive: true });
  }

  record(call: CallRecord): void {
    this.calls.push(call);
    if (this.observedFile) {
      const { method, path, status, code, validated } = call;
      appendFileSync(
        this.observedFile,
        `${JSON.stringify({ method, path, status, code: code ?? null, validated, test: this.test })}\n`,
      );
    }
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function expandPath(template: string, params: object = {}): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = (params as Record<string, string | number | undefined>)[name];
    if (value === undefined) throw new Error(`Path ${template} needs params.${name}`);
    return encodeURIComponent(String(value));
  });
}

/** `?a=1&tag=x&tag=y`: arrays repeat the key, undefined is left out, objects are sent as JSON. */
export function queryString(query: object | undefined): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    for (const item of Array.isArray(value) ? (value as unknown[]) : [value]) {
      if (item === undefined) continue;
      search.append(name, typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

export class ApiResult<O = unknown> {
  /** The events of a `text/event-stream` response, in order; empty for other responses. */
  events: SseEvent[] = [];

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    /** Lower-cased header names. */
    readonly headers: Record<string, string>,
    readonly text: string,
    readonly body: ResponseUnion<O>,
    private readonly envelope?: EnvelopeRules,
  ) {}

  get requestId(): string | undefined {
    return this.headers['x-request-id'];
  }

  /** The envelope code, when the service has an envelope. */
  get code(): string | undefined {
    const value = this.envelope ? field(this.body, this.envelope.codeField) : undefined;
    return typeof value === 'string' ? value : undefined;
  }

  private describe(): string {
    return `${this.method} ${this.path} -> ${this.status} [X-Request-Id ${this.requestId ?? '-'}] ${this.text.slice(0, 600)}`;
  }

  /** Asserts a 2xx answer (and the envelope's success code); returns the envelope data. */
  expectSuccess(status = 200): SuccessData<O> {
    expect(this.status, this.describe()).toBe(status);
    if (!this.envelope) return this.body;
    expect(this.code, this.describe()).toBe(this.envelope.successCode);
    return field(this.body, this.envelope.dataField) as SuccessData<O>;
  }

  /** The JSON data of every event (non-JSON markers such as `[DONE]` left out). */
  get eventData(): unknown[] {
    return this.events.filter((event) => event.json !== undefined).map((event) => event.json);
  }

  /** Asserts the status and, with an envelope, the error code; returns the error body. */
  expectError(status: number, code?: string): ErrorBody<O> {
    expect(this.status, this.describe()).toBe(status);
    if (code !== undefined) expect(this.code, this.describe()).toBe(code);
    return this.body;
  }
}

/** A response read as a stream: its events, when each arrived, and how it ended. */
export class StreamResult<O = unknown> extends ApiResult<O> {
  /** True when the stream ended the way the contract says a stream ends (`ending` is `terminal`). */
  complete = false;
  ending: StreamEnding = 'terminal';
  /** Milliseconds from sending the request to each event's arrival (e.g. time to first token: `eventAt[0]`). */
  eventAt: number[] = [];
}

/**
 * One caller identity. `get`, `post`, `put`, `patch` and `delete` are typed by the contract (path, path and query
 * parameters, body, response); `send` is the untyped escape hatch for calls outside it.
 */
export class Caller<P> {
  constructor(
    private readonly client: ApiClient<P>,
    private readonly auth: AuthHeaders,
  ) {}

  get<K extends PathOf<P, 'get'>>(path: K, options: OptionsOf<OpOf<P, K, 'get'>> = {}) {
    return this.client.call<OpOf<P, K, 'get'>>('GET', path, options, this.auth);
  }

  post<K extends PathOf<P, 'post'>>(path: K, options: OptionsOf<OpOf<P, K, 'post'>> = {}) {
    return this.client.call<OpOf<P, K, 'post'>>('POST', path, options, this.auth);
  }

  put<K extends PathOf<P, 'put'>>(path: K, options: OptionsOf<OpOf<P, K, 'put'>> = {}) {
    return this.client.call<OpOf<P, K, 'put'>>('PUT', path, options, this.auth);
  }

  patch<K extends PathOf<P, 'patch'>>(path: K, options: OptionsOf<OpOf<P, K, 'patch'>> = {}) {
    return this.client.call<OpOf<P, K, 'patch'>>('PATCH', path, options, this.auth);
  }

  delete<K extends PathOf<P, 'delete'>>(path: K, options: OptionsOf<OpOf<P, K, 'delete'>> = {}) {
    return this.client.call<OpOf<P, K, 'delete'>>('DELETE', path, options, this.auth);
  }

  send(method: HttpMethod, path: string, options: CallOptions = {}): Promise<ApiResult<unknown>> {
    return this.client.call<unknown>(method, path, options, this.auth);
  }

  /**
   * Reads the response as it arrives: each Server-Sent Event is parsed and held to the contract's event schema, the
   * wait for every event is bounded, and a stream that ends before its terminal marker fails the call (see
   * `allowIncomplete`). A response that is not a stream (an error answered as JSON) is checked like any call.
   */
  stream<M extends 'get' | 'post', K extends PathOf<P, M>>(
    method: M,
    path: K,
    options: OptionsOf<OpOf<P, K, M>> = {},
  ): Promise<StreamResult<OpOf<P, K, M>>> {
    return this.client.stream<OpOf<P, K, M>>(method.toUpperCase() as HttpMethod, path, options, this.auth);
  }

  /** The untyped `stream`, for calls outside the typed contract. */
  sendStream(method: HttpMethod, path: string, options: CallOptions = {}): Promise<StreamResult<unknown>> {
    return this.client.stream<unknown>(method, path, options, this.auth);
  }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

interface Prepared {
  url: string;
  origin?: string;
  headers: Record<string, string>;
  data?: string;
}

/**
 * Calls the service under test and holds every response to the contract: documented status, response schema,
 * header rules and datetime offsets. A violation fails the test with the full list.
 */
export class ApiClient<P = Record<string, unknown>> {
  constructor(
    private readonly request: APIRequestContext,
    private readonly svc: ServiceConfig,
    private readonly contract: OpenApiContract,
    private readonly auth: Auth,
    readonly recorder: CallRecorder,
  ) {}

  /**
   * A seeded user from service.yaml (password, token or anonymous, see Auth). A session user shares one login per
   * worker; `newSession` gives this caller its own, for a test that logs out or revokes sessions.
   */
  as(user: string, options: { newSession?: boolean } = {}): Caller<P> {
    return new Caller(this, this.auth.forUser(user, options));
  }

  /** An account created during the run (e.g. a persona): a session login, or a Keycloak password grant. */
  asCredentials(
    credentials: { username: string; password: string },
    options: { newSession?: boolean } = {},
  ): Caller<P> {
    return new Caller(this, this.auth.forCredentials(credentials, options));
  }

  /** A session cookie the test obtained itself (from a login it made), with its CSRF token when the service uses one. */
  asSession(cookie: string, csrf?: string): Caller<P> {
    return new Caller(this, this.auth.forSession(cookie, csrf));
  }

  /** A token the test obtained itself, sent the way the environment's `auth` says. */
  asToken(token: string): Caller<P> {
    return new Caller(this, this.auth.forToken(token));
  }

  anonymous(): Caller<P> {
    return new Caller(this, () => Promise.resolve({}));
  }

  /**
   * Delivers a webhook signed the way the provider `name` of service.yaml (`webhooks`) signs it, to the endpoint the
   * config names, and holds the answer to the contract. `timestamp`, `secret`, `unsigned` and `bodyAfterSigning`
   * build the deliveries a verifier must refuse (old, forged, unsigned, tampered).
   */
  async webhook(name: string, payload: unknown, options: WebhookOptions = {}): Promise<ApiResult<unknown>> {
    const cfg = this.svc.env.webhooks?.[name];
    if (!cfg) {
      throw new Error(
        `No webhook "${name}" in service.yaml environments.${this.svc.env.name}.webhooks (have: ${Object.keys(this.svc.env.webhooks ?? {}).join(', ') || 'none'})`,
      );
    }
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const signed = options.unsigned ? undefined : signWebhook(cfg, body, options);
    return this.call<unknown>(
      (cfg.method ?? 'POST').toUpperCase() as HttpMethod,
      cfg.path,
      {
        rawBody: options.bodyAfterSigning ?? body,
        headers: { 'Content-Type': 'application/json', ...signed?.headers, ...options.headers },
        // A provider is not a browser: it sends no Origin.
        origin: null,
        validate: options.validate,
      },
      () => Promise.resolve({}),
    );
  }

  private async prepare(
    method: string,
    template: string,
    options: CallOptions<unknown, object, object>,
    auth: AuthHeaders,
    extra: Record<string, string> = {},
  ): Promise<Prepared> {
    // Before anything is sent, even a login: a shared environment is read, never written (write-guard.ts). Judged on
    // what goes out: the filled-in path (no `..` past the operation) and any method-override header.
    const path = expandPath(template, options.params);
    guardWrite(this.svc.env, method, template, this.svc.schemathesis, {
      path,
      headers: { ...extra, ...options.headers },
    });
    const query = queryString(options.invalidQuery ?? options.query);
    const url = `${this.svc.env.baseUrl}${path}${query}`;
    const origin = options.origin === null ? undefined : (options.origin ?? this.svc.env.origin);
    const headers: Record<string, string> = {
      ...(await auth()),
      ...(origin ? { Origin: origin } : {}),
      ...extra,
      ...options.headers,
    };
    let data: string | undefined;
    if (options.rawBody !== undefined) data = options.rawBody;
    else if (options.body !== undefined) data = JSON.stringify(options.body);
    else if (options.invalidBody !== undefined) data = JSON.stringify(options.invalidBody);
    if (data !== undefined && header(headers, 'content-type') === undefined)
      headers['Content-Type'] = 'application/json';
    return { url, origin, headers, data };
  }

  /** Every check of one response: contract (per event for a stream), header rules, datetime offsets. */
  private violations(
    method: string,
    template: string,
    result: ApiResult<unknown>,
    origin: string | undefined,
    stream?: { ending: StreamEnding; allowIncomplete?: boolean; partial: boolean; timeoutMs: number },
  ): string[] {
    const contentType = result.headers['content-type'];
    const violations = [
      ...this.contract.validateResponse(method, template, result.status, result.body, contentType),
      ...checkHeaders(this.svc.rules.headers, {
        status: result.status,
        headers: result.headers,
        hasBody: result.text.length > 0,
        origin,
      }),
    ];
    if (!isEventStream(contentType))
      return [...violations, ...checkDatetimeOffsets(result.body, this.svc.rules.datetimeOffset)];

    const { terminal: terminals } = this.streaming(method, template);
    result.events.forEach((event, index) => {
      if (isMarkerOnly(terminalOf(event, terminals))) return;
      const where = `event ${index} (${event.event})`;
      for (const problem of this.contract.validateEvent(method, template, result.status, event)) {
        violations.push(`${where}: ${problem}`);
      }
      for (const problem of checkDatetimeOffsets(event.json, this.svc.rules.datetimeOffset)) {
        violations.push(`${where}: ${problem}`);
      }
    });
    if (stream && stream.ending !== 'terminal' && !stream.allowIncomplete) {
      const expected = terminals?.length
        ? `before its terminal marker (${terminals.map((t) => (t.event ? `event: ${t.event}` : `data: ${t.data ?? ''}`)).join(' or ')})`
        : '';
      const what = {
        closed: `the stream closed ${expected}`,
        'cut-off': `the connection broke ${expected || 'while the stream was open'}`,
        stalled: `no event arrived within ${stream.timeoutMs}ms ${expected}`,
        terminal: '',
      }[stream.ending];
      violations.push(
        `${what.trim()} after ${result.events.length} events${stream.partial ? ', inside an event' : ''}`,
      );
    }
    return violations;
  }

  /** The streaming rules of one operation: service-wide, overridden per operation. */
  private streaming(
    method: string,
    template: string,
  ): { terminal?: StreamingRules['terminal']; eventTimeoutMs: number } {
    const rules = this.svc.rules.streaming;
    const own = rules?.operations?.[`${method.toUpperCase()} ${template}`];
    return {
      terminal: own?.terminal ?? rules?.terminal,
      eventTimeoutMs: own?.eventTimeoutMs ?? rules?.eventTimeoutMs ?? 30_000,
    };
  }

  private check(violations: string[], method: string, template: string, result: ApiResult<unknown>): void {
    expect(
      violations,
      `Contract violations: ${method} ${template} -> ${result.status} [X-Request-Id ${result.requestId ?? '-'}]`,
    ).toEqual([]);
  }

  async stream<O>(
    method: HttpMethod,
    template: string,
    options: CallOptions<unknown, object, object>,
    auth: AuthHeaders,
  ): Promise<StreamResult<O>> {
    const { url, origin, headers, data } = await this.prepare(method, template, options, auth, {
      Accept: 'text/event-stream',
    });
    const rules = this.streaming(method, template);
    const timeoutMs = options.eventTimeoutMs ?? rules.eventTimeoutMs;
    const controller = new AbortController();
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, timeoutMs);
    };

    const started = Date.now();
    arm();
    let response: Response;
    try {
      response = await fetch(url, { method, headers, body: data, signal: controller.signal, redirect: 'manual' });
    } catch (error) {
      clearTimeout(timer);
      throw new Error(
        stalled
          ? `${method} ${template}: no response within ${timeoutMs}ms`
          : `${method} ${template}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => (responseHeaders[name.toLowerCase()] = value));
    const contentType = responseHeaders['content-type'];
    const streaming = isEventStream(contentType);

    const events: SseEvent[] = [];
    const eventAt: number[] = [];
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const terminals = rules.terminal;
    let raw = '';
    let cutOff = false;
    let sawTerminal = false;
    const take = (batch: SseEvent[]) => {
      for (const event of batch) {
        events.push(event);
        eventAt.push(Date.now() - started);
        if (terminalOf(event, terminals)) sawTerminal = true;
      }
      if (batch.length > 0) arm();
    };
    if (response.body) {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          if (!stalled) cutOff = true;
          break;
        }
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        raw += text;
        if (streaming) take(parser.push(text));
      }
    }
    clearTimeout(timer);
    raw += decoder.decode();
    const end = streaming ? parser.end() : { events: [], partial: false };

    const ending: StreamEnding = stalled
      ? 'stalled'
      : cutOff
        ? 'cut-off'
        : sawTerminal || !terminals?.length
          ? 'terminal'
          : 'closed';
    const result = new StreamResult<O>(
      method,
      template,
      response.status,
      responseHeaders,
      raw,
      (streaming ? raw : parseJson(raw)) as ResponseUnion<O>,
      this.svc.rules.envelope,
    );
    result.events = events;
    result.eventAt = eventAt;
    result.ending = streaming ? ending : stalled ? 'stalled' : cutOff ? 'cut-off' : 'terminal';
    result.complete = result.ending === 'terminal';
    this.recorder.record({
      method,
      path: template,
      url,
      status: result.status,
      code: result.code,
      requestId: result.requestId,
      durationMs: Date.now() - started,
      requestBody: data,
      responseBody: raw.slice(0, 4000),
      validated: options.validate !== false,
      events: events.length,
      ending: result.ending,
    });
    if (options.validate !== false) {
      const violations = this.violations(method, template, result, origin, {
        ending: result.ending,
        allowIncomplete: options.allowIncomplete,
        partial: end.partial,
        timeoutMs,
      });
      this.check(violations, method, template, result);
    }
    return result;
  }

  async call<O>(
    method: HttpMethod,
    template: string,
    options: CallOptions<unknown, object, object>,
    auth: AuthHeaders,
  ): Promise<ApiResult<O>> {
    const { url, origin, headers, data } = await this.prepare(method, template, options, auth);

    const started = Date.now();
    const response = await this.request.fetch(url, { method, headers, data, failOnStatusCode: false, maxRedirects: 0 });
    const text = await response.text();
    const streaming = isEventStream(response.headers()['content-type']);
    const result = new ApiResult<O>(
      method,
      template,
      response.status(),
      response.headers(),
      text,
      (streaming ? text : parseJson(text)) as ResponseUnion<O>,
      this.svc.rules.envelope,
    );
    // A stream read whole: the events are still parsed and checked; use `stream()` to see how and when they arrive.
    const sse = streaming ? parseSse(text) : undefined;
    if (sse) result.events = sse.events;
    const { terminal: terminals, eventTimeoutMs } = this.streaming(method, template);
    const ending: StreamEnding =
      !sse || !terminals?.length || sse.events.some((event) => terminalOf(event, terminals)) ? 'terminal' : 'closed';
    this.recorder.record({
      method,
      path: template,
      url,
      status: result.status,
      code: result.code,
      requestId: result.requestId,
      durationMs: Date.now() - started,
      requestBody: data,
      responseBody: text.slice(0, 4000),
      validated: options.validate !== false,
      ...(sse ? { events: sse.events.length, ending } : {}),
    });

    if (options.validate !== false) {
      const violations = this.violations(
        method,
        template,
        result,
        origin,
        sse
          ? { ending, allowIncomplete: options.allowIncomplete, partial: sse.partial, timeoutMs: eventTimeoutMs }
          : undefined,
      );
      this.check(violations, method, template, result);
    }
    return result;
  }
}

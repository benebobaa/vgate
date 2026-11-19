import { readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { parse } from 'yaml';
import type { ServiceConfig } from '../config.ts';

// ajv-formats is CommonJS: under ESM its callable lives on `.default`.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (
  ajv: Ajv2020,
) => Ajv2020;

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;
// An http(s) id: Ajv's URI library rejects a URN without a namespace segment.
const CONTRACT_ID = 'https://vgate.local/contract.json';
const LOCAL_SCHEMA_REF = '#/components/schemas/';
const CONTRACT_DEFS = `${CONTRACT_ID}#/$defs/`;
// Under strictResponseProperties, the components as allOf members see them: not closed at their own level.
const OPEN_ID = 'https://vgate.local/contract-open.json';
const OPEN_DEFS = `${OPEN_ID}#/$defs/`;
// Keywords whose value maps names to schemas: the map itself is not a schema and must not be closed.
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
// Keywords whose schemas apply at the parent's instance location, like allOf members: closed at their own level they
// would reject the parent's properties. The parent's closing sees what they evaluate.
const SAME_LOCATION = new Set(['allOf', 'then', 'else']);
// Keywords whose result is a condition, not an assertion: closing them flips it. Under \`if\` a closed schema fails on a
// body with more properties and skips \`then\`; under \`not\` it fails and so makes \`not\` pass. Left as written.
const CONDITIONS = new Set(['if', 'not']);

/** How the events of a `text/event-stream` response are described (docs/streaming.md). */
export type EventSchemas =
  /** OpenAPI 3.2 `itemSchema`: one schema for the event object `{ event, data, id, retry }`, data parsed. */
  | { kind: 'item'; schema: unknown }
  /** `x-vgate-events`: the schema of each event's data, by event name (`message` for unnamed events). */
  | { kind: 'byName'; schemas: Record<string, unknown> };

export interface MediaType {
  schema?: unknown;
  events?: EventSchemas;
}

export interface DocumentedResponse {
  status: string;
  description: string;
  /** Codes named in the description (via the envelope code pattern); the success code for 2xx without any. */
  codes: string[];
  /** The schema of the preferred media type (JSON first). */
  schema?: unknown;
  /** Every documented media type, by lower-cased type without parameters. */
  media: Map<string, MediaType>;
}

export interface Operation {
  /** `POST /notes` */
  key: string;
  method: string;
  path: string;
  operationId?: string;
  requestSchema?: string;
  responses: Map<string, DocumentedResponse>;
}

export interface DocumentedPair {
  operation: string;
  status: string;
  code: string | null;
}

export interface ContractOptions {
  strictResponseProperties?: boolean;
  /** Accept `null` for properties the schema does not list as required (see Rules.optionalPropertiesNullable). */
  optionalPropertiesNullable?: boolean;
  codePattern?: string;
  successCode?: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withNull(schema: Json): Json {
  if (typeof schema.$ref === 'string' || schema.type === undefined) return { anyOf: [schema, { type: 'null' }] };
  const copy = { ...schema };
  if (typeof copy.type === 'string') copy.type = [copy.type, 'null'];
  else if (Array.isArray(copy.type) && !copy.type.includes('null')) copy.type = [...(copy.type as unknown[]), 'null'];
  if (Array.isArray(copy.enum) && !copy.enum.includes(null)) copy.enum = [...(copy.enum as unknown[]), null];
  return copy;
}

/** Lets every property that is not in its object's `required` list also be `null`. */
function allowNullOnOptional(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(allowNullOnOptional);
  if (!isObject(node)) return;
  if (isObject(node.properties)) {
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    const properties = node.properties;
    for (const [name, property] of Object.entries(properties)) {
      if (!required.has(name) && isObject(property)) properties[name] = withNull(property);
    }
  }
  Object.values(node).forEach(allowNullOnOptional);
}

/** The contract of a service, with the rules of its service.yaml applied. */
export function loadContract(svc: ServiceConfig): OpenApiContract {
  return OpenApiContract.load(svc.specPath, {
    strictResponseProperties: svc.rules.strictResponseProperties,
    optionalPropertiesNullable: svc.rules.optionalPropertiesNullable,
    codePattern: svc.rules.envelope?.codePattern,
    successCode: svc.rules.envelope?.successCode,
  });
}

/** Points `#/components/schemas/X` at the contract document registered in Ajv. */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (!isObject(node)) return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) =>
      key === '$ref' && typeof value === 'string' && value.startsWith(LOCAL_SCHEMA_REF)
        ? [key, `${CONTRACT_ID}#/$defs/${value.slice(LOCAL_SCHEMA_REF.length)}`]
        : [key, rewriteRefs(value)],
    ),
  );
}

/**
 * Returns a function that forbids properties an object schema does not declare, unless the schema already decides
 * that itself (strictResponseProperties). `unevaluatedProperties` only sees what was evaluated inside its own
 * subschema, so a member of an `allOf` closed on its own would reject the properties its siblings declare. The closing
 * therefore happens at the node holding the `allOf`, which sees the properties of every member (also through `$ref`),
 * and members are walked "open": not closed at their own level, and their `$ref`s point at the open copy of the
 * component (OPEN_ID), because the same component may be used standalone elsewhere and must stay closed there. Objects
 * nested inside a member are a different instance location and are closed as usual. The alternatives of a `oneOf` or
 * `anyOf` are each a complete object, so they stay closed on their own: opening them would let one alternative match
 * a body meant for another and break `oneOf`.
 */
function objectCloser(defs: Json): (node: unknown, open?: boolean) => void {
  const pristine = structuredClone(defs);
  const component = (ref: unknown): unknown => {
    if (typeof ref !== 'string') return undefined;
    const prefix = [CONTRACT_DEFS, OPEN_DEFS].find((p) => ref.startsWith(p));
    return prefix === undefined ? undefined : pristine[ref.slice(prefix.length)];
  };
  // Whether a schema, or anything it composes at the same instance location, declares properties. An allOf made only
  // of free-form objects stays as open as those objects are.
  const declares = (node: unknown, seen: Set<unknown>): boolean => {
    if (!isObject(node) || seen.has(node)) return false;
    seen.add(node);
    if (isObject(node.properties)) return true;
    if (declares(component(node.$ref), seen)) return true;
    return Array.isArray(node.allOf) && node.allOf.some((member) => declares(member, seen));
  };
  // Inside a condition nothing is closed, and components are read open, so the condition says what the spec says.
  const asWritten = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(asWritten);
    if (!isObject(node)) return;
    if (typeof node.$ref === 'string' && node.$ref.startsWith(CONTRACT_DEFS)) {
      node.$ref = OPEN_DEFS + node.$ref.slice(CONTRACT_DEFS.length);
    }
    Object.values(node).forEach(asWritten);
  };
  const walk = (node: unknown, open: boolean): void => {
    if (Array.isArray(node)) return node.forEach((item) => walk(item, false));
    if (!isObject(node)) return;
    const allOf = Array.isArray(node.allOf) ? node.allOf : [];
    // Other schemas evaluate this instance location too: the allOf members, or the properties next to a $ref.
    const shared = allOf.length > 0 || isObject(node.properties);
    if (
      !open &&
      (isObject(node.properties) || (allOf.length > 0 && declares(node, new Set()))) &&
      node.additionalProperties === undefined &&
      node.unevaluatedProperties === undefined
    ) {
      node.unevaluatedProperties = false;
    }
    if ((open || shared) && typeof node.$ref === 'string' && node.$ref.startsWith(CONTRACT_DEFS)) {
      node.$ref = OPEN_DEFS + node.$ref.slice(CONTRACT_DEFS.length);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'allOf' && Array.isArray(value)) value.forEach((member) => walk(member, true));
      else if (SAME_LOCATION.has(key)) walk(value, true);
      else if (CONDITIONS.has(key)) asWritten(value);
      else if (key === 'dependentSchemas' && isObject(value))
        Object.values(value).forEach((schema) => walk(schema, true));
      else if (SCHEMA_MAPS.has(key) && isObject(value)) Object.values(value).forEach((schema) => walk(schema, false));
      else walk(value, false);
    }
  };
  return (node, open = false) => walk(node, open);
}

/**
 * Follows a local `$ref` to a reusable component (`#/components/responses/X`, `#/components/requestBodies/X`), as
 * generators emit for shared error responses. Without this a referenced response would carry no schema and pass
 * every body unchecked.
 */
function deref(spec: Json, node: unknown): unknown {
  let current = node;
  for (let hops = 0; isObject(current) && typeof current.$ref === 'string' && hops < 10; hops++) {
    const ref = current.$ref;
    if (!ref.startsWith('#/')) throw new Error(`Only local $refs are supported, not ${ref}`);
    current = ref
      .slice(2)
      .split('/')
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<unknown>((at, part) => (isObject(at) ? at[part] : undefined), spec);
    if (current === undefined) throw new Error(`Unresolved $ref ${ref}`);
  }
  return current;
}

/** `text/event-stream; charset=utf-8` -> `text/event-stream`. */
export function mediaTypeOf(contentType: string | undefined): string | undefined {
  const type = contentType?.split(';')[0].trim().toLowerCase();
  return type ? type : undefined;
}

/**
 * An `itemSchema` describes the event object with `data` as a string carrying `contentMediaType` and
 * `contentSchema`. The framework validates the parsed data, so each `data` property with a `contentSchema` is replaced
 * by that schema. Local `$ref`s on the way (the item schema itself, `oneOf` variants) are inlined a few levels deep
 * so the replacement reaches them.
 */
function eventObjectSchema(spec: Json, node: unknown, depth = 0): unknown {
  if (Array.isArray(node)) return node.map((item) => eventObjectSchema(spec, item, depth));
  if (!isObject(node)) return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/') && depth < 4) {
    return eventObjectSchema(spec, structuredClone(deref(spec, node)), depth + 1);
  }
  const copy: Json = {};
  for (const [key, value] of Object.entries(node)) {
    copy[key] = ['oneOf', 'anyOf', 'allOf'].includes(key) ? eventObjectSchema(spec, value, depth) : value;
  }
  if (isObject(copy.properties)) {
    const properties = { ...copy.properties };
    const data = properties.data;
    if (isObject(data) && data.contentSchema !== undefined) properties.data = data.contentSchema;
    copy.properties = properties;
  }
  return copy;
}

function readMedia(spec: Json, raw: unknown): MediaType {
  if (!isObject(raw)) return {};
  const media: MediaType = { schema: raw.schema === undefined ? undefined : rewriteRefs(raw.schema) };
  if (raw.itemSchema !== undefined) {
    media.events = { kind: 'item', schema: rewriteRefs(eventObjectSchema(spec, raw.itemSchema)) };
  } else if (isObject(raw['x-vgate-events'])) {
    media.events = {
      kind: 'byName',
      schemas: Object.fromEntries(
        Object.entries(raw['x-vgate-events']).map(([name, schema]) => [name, rewriteRefs(schema)]),
      ),
    };
  }
  return media;
}

function pickContent(content: unknown): unknown {
  if (!isObject(content)) return undefined;
  const media = content['application/json'] ?? content['*/*'] ?? Object.values(content)[0];
  return isObject(media) ? media.schema : undefined;
}

function formatError(error: ErrorObject): string {
  const where = error.instancePath || '/';
  const extra =
    'unevaluatedProperty' in error.params
      ? ` "${String(error.params.unevaluatedProperty)}"`
      : 'additionalProperty' in error.params
        ? ` "${String(error.params.additionalProperty)}"`
        : 'allowedValues' in error.params
          ? ` ${JSON.stringify(error.params.allowedValues)}`
          : '';
  return `${where} ${error.message ?? 'is invalid'}${extra}`;
}

/** The vendored OpenAPI contract: the approved behaviour every response is held to. */
export class OpenApiContract {
  readonly operations: Operation[] = [];
  private readonly byKey = new Map<string, Operation>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv: Ajv2020;
  /** Closes object schemas under strictResponseProperties; unset otherwise. */
  private readonly close?: (node: unknown) => void;

  static load(path: string, options: ContractOptions = {}): OpenApiContract {
    return new OpenApiContract(parse(readFileSync(path, 'utf8')) as Json, options);
  }

  constructor(
    readonly spec: Json,
    private readonly options: ContractOptions = {},
  ) {
    this.ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(this.ajv);
    const components = isObject(spec.components) ? spec.components : {};
    const defs = rewriteRefs(structuredClone(components.schemas ?? {}));
    if (options.optionalPropertiesNullable) allowNullOnOptional(defs);
    if (options.strictResponseProperties && isObject(defs)) {
      const close = objectCloser(defs);
      const open = structuredClone(defs);
      Object.values(open).forEach((schema) => close(schema, true));
      Object.values(defs).forEach((schema) => close(schema));
      this.ajv.addSchema({ $id: OPEN_ID, $defs: open });
      this.close = close;
    }
    this.ajv.addSchema({ $id: CONTRACT_ID, $defs: defs });

    const codeRe = options.codePattern ? new RegExp(options.codePattern, 'g') : undefined;
    for (const [path, item] of Object.entries(isObject(spec.paths) ? spec.paths : {})) {
      if (!isObject(item)) continue;
      for (const method of METHODS) {
        const op = item[method];
        if (!isObject(op)) continue;
        const responses = new Map<string, DocumentedResponse>();
        for (const [status, raw] of Object.entries(isObject(op.responses) ? op.responses : {})) {
          const response = deref(spec, raw);
          if (!isObject(response)) continue;
          const description = typeof response.description === 'string' ? response.description : '';
          const named = codeRe ? [...new Set(description.match(codeRe) ?? [])] : [];
          const codes =
            named.length === 0 && status.startsWith('2') && options.successCode ? [options.successCode] : named;
          const schema = pickContent(response.content);
          const media = new Map<string, MediaType>();
          for (const [type, raw] of Object.entries(isObject(response.content) ? response.content : {})) {
            media.set(type.toLowerCase(), readMedia(spec, raw));
          }
          responses.set(status, {
            status,
            description,
            codes,
            schema: schema === undefined ? undefined : rewriteRefs(schema),
            media,
          });
        }
        const requestBody = deref(spec, op.requestBody);
        const requestRef = pickContent(isObject(requestBody) ? requestBody.content : undefined);
        const operation: Operation = {
          key: `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase(),
          path,
          operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
          requestSchema:
            isObject(requestRef) && typeof requestRef.$ref === 'string'
              ? requestRef.$ref.slice(LOCAL_SCHEMA_REF.length)
              : undefined,
          responses,
        };
        this.operations.push(operation);
        this.byKey.set(operation.key, operation);
      }
    }
  }

  operation(method: string, path: string): Operation | undefined {
    return this.byKey.get(`${method.toUpperCase()} ${path}`);
  }

  /** The documented response for a status: exact, then `4XX`-style, then `default`. */
  response(method: string, path: string, status: number): DocumentedResponse | undefined {
    const op = this.operation(method, path);
    return (
      op?.responses.get(String(status)) ?? op?.responses.get(`${String(status)[0]}XX`) ?? op?.responses.get('default')
    );
  }

  /**
   * Contract violations of one response; empty when the response is exactly as documented. With `contentType`, a
   * response whose media type is documented is held to that media type's schema (a stream to its `text/event-stream`
   * entry, not to the JSON one); otherwise to the preferred (JSON) schema.
   */
  validateResponse(method: string, path: string, status: number, body: unknown, contentType?: string): string[] {
    const op = this.operation(method, path);
    if (!op) return [`${method} ${path} is not in the contract`];
    const response = this.response(method, path, status);
    if (!response) {
      return [`status ${status} is not documented for ${op.key} (documented: ${[...op.responses.keys()].join(', ')})`];
    }
    const type = mediaTypeOf(contentType);
    const media = type === undefined ? undefined : response.media.get(type);
    const schema = media ? media.schema : response.schema;
    if (schema === undefined) return [];
    const validate = this.compiled(`${op.key} ${response.status} ${media ? type : ''}`, schema);
    return validate(body) ? [] : (validate.errors ?? []).map(formatError);
  }

  /** The event schemas of a documented stream, if the contract describes its events. */
  eventSchemas(method: string, path: string, status: number): EventSchemas | undefined {
    return this.response(method, path, status)?.media.get('text/event-stream')?.events;
  }

  /**
   * Violations of one event of a `text/event-stream` response. Empty when the contract describes no event schema
   * (the stream is then checked for its framing only, see docs/streaming.md).
   */
  validateEvent(
    method: string,
    path: string,
    status: number,
    event: { event: string; data: string; json?: unknown; id?: string; retry?: number },
  ): string[] {
    const events = this.eventSchemas(method, path, status);
    if (!events) return [];
    const data = event.json === undefined ? event.data : event.json;
    const key = `${method.toUpperCase()} ${path} ${status} event`;
    if (events.kind === 'item') {
      const object = {
        event: event.event,
        data,
        ...(event.id === undefined ? {} : { id: event.id }),
        ...(event.retry === undefined ? {} : { retry: event.retry }),
      };
      const validate = this.compiled(key, events.schema);
      return validate(object) ? [] : (validate.errors ?? []).map(formatError);
    }
    const schema = events.schemas[event.event];
    if (schema === undefined) {
      return [`event "${event.event}" is not documented (documented: ${Object.keys(events.schemas).join(', ')})`];
    }
    const validate = this.compiled(`${key} ${event.event}`, schema);
    return validate(data) ? [] : (validate.errors ?? []).map((error) => `data${formatError(error)}`);
  }

  private compiled(key: string, raw: unknown): ValidateFunction {
    let validate = this.validators.get(key);
    if (!validate) {
      const schema = structuredClone(raw);
      if (this.options.optionalPropertiesNullable) allowNullOnOptional(schema);
      this.close?.(schema);
      validate = this.ajv.compile(isObject(schema) ? schema : {});
      this.validators.set(key, validate);
    }
    return validate;
  }

  /**
   * Violations of a request body against the operation's documented request schema (a `$ref` to a component). Used
   * for what the service under test sends to a stubbed provider: the provider's contract binds the caller too.
   */
  validateRequest(method: string, path: string, body: unknown): string[] {
    const op = this.operation(method, path);
    if (!op) return [`${method} ${path} is not in the contract`];
    if (!op.requestSchema) return [];
    const key = `${op.key} request`;
    let validate = this.validators.get(key);
    if (!validate) {
      validate = this.ajv.compile({ $ref: `${CONTRACT_ID}#/$defs/${op.requestSchema}` });
      this.validators.set(key, validate);
    }
    return validate(body) ? [] : (validate.errors ?? []).map(formatError);
  }

  /** Every documented (operation, status, code) combination: the denominator of the coverage gate. */
  documentedPairs(): DocumentedPair[] {
    return this.operations.flatMap((op) =>
      [...op.responses.values()].flatMap((response): DocumentedPair[] =>
        response.codes.length === 0
          ? [{ operation: op.key, status: response.status, code: null }]
          : response.codes.map((code) => ({ operation: op.key, status: response.status, code })),
      ),
    );
  }
}

/**
 * Before OpenAPI 3.2 a stream's `schema` is read by Schemathesis as the schema of each event (its check ST108). A
 * contract that writes `text/event-stream: { schema: { type: string } }` means "the body is text", so every event
 * would violate it. This returns the contract without those string `schema`s on streams that have no `itemSchema`,
 * and where it removed one: the client's own stream validation still checks those streams (docs/streaming.md).
 */
export function withoutTextStreamSchemas(spec: Json): { spec: Json; removed: string[] } {
  const copy = structuredClone(spec);
  const removed: string[] = [];
  const walk = (node: unknown, where: string[]): void => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, [...where, String(i)]));
    if (!isObject(node)) return;
    if (isObject(node.content)) {
      for (const [type, media] of Object.entries(node.content)) {
        if (!/^text\/event-stream\b/i.test(type) || !isObject(media) || media.itemSchema !== undefined) continue;
        if (isObject(media.schema) && media.schema.type === 'string') {
          delete media.schema;
          removed.push(where.join(' '));
        }
      }
    }
    for (const [key, value] of Object.entries(node)) walk(value, [...where, key]);
  };
  walk(copy.paths, []);
  walk(copy.components, ['components']);
  return { spec: copy, removed };
}

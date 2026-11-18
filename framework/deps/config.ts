/**
 * The `dependencies` block of an environment in service.yaml: what the service under test talks to besides its own
 * database, and how the tests reach it. Pure parsing, so the rules are self-tested without any container.
 *
 *   dependencies:
 *     payments: { kind: http-stub, adminUrl: http://localhost:58080, contract: deps/payments.openapi.yaml, proxy: payments }
 *     events:   { kind: kafka, brokers: [localhost:59092], topics: { orders.created: { schema: deps/events/x.json } } }
 *     cache:    { kind: redis, url: redis://localhost:56379 }
 *     proxies:  { kind: toxiproxy, url: http://localhost:58474 }
 *     mail:     { kind: mailpit, apiUrl: '{mail.apiUrl}' }     # and the catalog's other kinds (catalog-config.ts)
 */
import { resolve } from 'node:path';
import { CATALOG_DEPENDENCY_KINDS, parseCatalogDependency, type CatalogDependency } from './catalog-config.ts';

/** A third party or sibling service replaced by a WireMock stub that may only answer what its contract documents. */
export interface HttpStubDependency {
  kind: 'http-stub';
  /** WireMock's base URL; its admin API lives under /__admin. */
  adminUrl: string;
  /** Absolute path of the provider's vendored OpenAPI contract. */
  contract: string;
  /** The toxiproxy proxy between the service and the stub, for latency and outage faults. */
  proxy?: string;
}

export interface KafkaDependency {
  kind: 'kafka';
  brokers: string[];
  /** topic -> absolute path of the JSON Schema every message on it must satisfy. */
  topics: Record<string, { schema: string }>;
}

export interface RedisDependency {
  kind: 'redis';
  url: string;
}

export interface ToxiproxyDependency {
  kind: 'toxiproxy';
  /** Toxiproxy's API, e.g. http://localhost:8474. */
  url: string;
}

export type DependencyConfig =
  HttpStubDependency | KafkaDependency | RedisDependency | ToxiproxyDependency | CatalogDependency;

export const DEPENDENCY_KINDS = ['http-stub', 'kafka', 'redis', 'toxiproxy', ...CATALOG_DEPENDENCY_KINDS] as const;

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);

function text(raw: Raw, field: string, where: string): string {
  const value = raw[field];
  if (typeof value !== 'string' || value === '') throw new Error(`${where}.${field} is required`);
  return value;
}

/**
 * Parses and checks the block. `dir` is the service directory (relative paths resolve against it); `disposable` is
 * the environment's flag: a stub replaces a real provider and a fault breaks a shared one, so both are refused on a
 * shared environment rather than skipped silently.
 */
export function parseDependencies(
  raw: unknown,
  dir: string,
  disposable: boolean,
  where = 'dependencies',
): Record<string, DependencyConfig> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new Error(`${where} must be a map of name -> dependency`);
  const out: Record<string, DependencyConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const at = `${where}.${name}`;
    if (!isRecord(value)) throw new Error(`${at} must be a map`);
    const kind = value.kind;
    switch (kind) {
      case 'http-stub':
        out[name] = {
          kind,
          adminUrl: text(value, 'adminUrl', at).replace(/\/$/, ''),
          contract: resolve(dir, text(value, 'contract', at)),
          proxy: typeof value.proxy === 'string' && value.proxy !== '' ? value.proxy : undefined,
        };
        break;
      case 'kafka': {
        const brokers = value.brokers;
        if (!Array.isArray(brokers) || brokers.length === 0 || !brokers.every((b) => typeof b === 'string' && b))
          throw new Error(`${at}.brokers must be a non-empty list of host:port`);
        if (!isRecord(value.topics) || Object.keys(value.topics).length === 0)
          throw new Error(`${at}.topics must name at least one topic with its schema`);
        const topics: Record<string, { schema: string }> = {};
        for (const [topic, spec] of Object.entries(value.topics)) {
          if (!isRecord(spec)) throw new Error(`${at}.topics.${topic} must be { schema: <path> }`);
          // A topic without a schema would let any message through: every event is held to one, like every response.
          topics[topic] = { schema: resolve(dir, text(spec, 'schema', `${at}.topics.${topic}`)) };
        }
        out[name] = { kind, brokers: brokers as string[], topics };
        break;
      }
      case 'redis':
        out[name] = { kind, url: text(value, 'url', at) };
        break;
      case 'toxiproxy':
        out[name] = { kind, url: text(value, 'url', at).replace(/\/$/, '') };
        break;
      default: {
        // The catalog's kinds (mail, object stores, AWS, MySQL, MongoDB, RabbitMQ): framework/deps/catalog-config.ts.
        const extra = parseCatalogDependency(kind, value, at);
        if (extra) {
          out[name] = extra;
          break;
        }
        throw new Error(`${at}.kind must be one of ${DEPENDENCY_KINDS.join(', ')} (got ${JSON.stringify(kind)})`);
      }
    }
  }

  const proxies = Object.values(out).filter((dep) => dep.kind === 'toxiproxy');
  for (const [name, dep] of Object.entries(out)) {
    if (!disposable && (dep.kind === 'http-stub' || dep.kind === 'toxiproxy'))
      throw new Error(
        `${where}.${name}: ${dep.kind} is only allowed on a disposable environment (stubs replace and faults break ` +
          'real dependencies); set disposable: true or remove it',
      );
    if (dep.kind === 'http-stub' && dep.proxy && proxies.length !== 1)
      throw new Error(
        `${where}.${name}.proxy needs exactly one toxiproxy dependency in the environment (found ${proxies.length})`,
      );
  }
  return out;
}

/** The dependencies of one kind, by name. */
export function ofKind<K extends DependencyConfig['kind']>(
  deps: Record<string, DependencyConfig>,
  kind: K,
): Record<string, Extract<DependencyConfig, { kind: K }>> {
  return Object.fromEntries(Object.entries(deps).filter(([, dep]) => dep.kind === kind)) as Record<
    string,
    Extract<DependencyConfig, { kind: K }>
  >;
}

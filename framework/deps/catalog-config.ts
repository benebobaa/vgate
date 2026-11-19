/**
 * The test side of the catalog's kinds: how the tests reach a mail server, an object store, AWS (LocalStack), MySQL,
 * MongoDB or RabbitMQ, as written under environments.<env>.dependencies in service.yaml. In a sealed environment the
 * values are placeholders the run fills in (`{mail.apiUrl}`); against a shared environment they are real URLs.
 *
 *   mail:   { kind: mailpit, apiUrl: '{mail.apiUrl}' }
 *   files:  { kind: s3, endpoint: '{files.url}', region: us-east-1 }
 *   aws:    { kind: aws, endpoint: '{aws.url}', region: eu-west-1 }      # LocalStack: S3 and SQS
 *   orders: { kind: mysql, url: '{orders.url}' }
 *   docs:   { kind: mongodb, url: '{docs.url}' }
 *   broker: { kind: rabbitmq, url: '{broker.url}' }
 */

export type CatalogDependency =
  | { kind: 'mailpit'; apiUrl: string }
  | { kind: 's3'; endpoint: string; region: string; accessKey?: string; secretKey?: string }
  | { kind: 'aws'; endpoint: string; region: string; accessKey?: string; secretKey?: string }
  | { kind: 'mysql'; url: string }
  | { kind: 'mongodb'; url: string }
  | { kind: 'rabbitmq'; url: string };

export const CATALOG_DEPENDENCY_KINDS = ['mailpit', 's3', 'aws', 'mysql', 'mongodb', 'rabbitmq'] as const;

type Raw = Record<string, unknown>;

function text(raw: Raw, field: string, at: string): string {
  const value = raw[field];
  if (typeof value !== 'string' || value === '') throw new Error(`${at}.${field} is required`);
  return value;
}

function optional(raw: Raw, field: string, at: string): string | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw new Error(`${at}.${field} must be a non-empty string`);
  return value;
}

function url(raw: Raw, field: string, at: string, schemes: string[]): string {
  const value = text(raw, field, at);
  // `{name.export}` is filled in once this run's environment is up; until then it stays as written (config.ts).
  if (/\{[a-z][\w-]*\.[\w-]+\}/i.test(value)) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${at}.${field} must be a URL (got ${JSON.stringify(value)})`);
  }
  if (!schemes.includes(parsed.protocol.replace(/:$/, '')))
    throw new Error(`${at}.${field} must be a ${schemes.join(' or ')} URL (got ${parsed.protocol})`);
  return value.replace(/\/$/, '');
}

/** The parsed dependency when `kind` is one of the catalog's test-side kinds; undefined for any other kind. */
export function parseCatalogDependency(kind: unknown, raw: Raw, at: string): CatalogDependency | undefined {
  switch (kind) {
    case 'mailpit':
      return { kind, apiUrl: url(raw, 'apiUrl', at, ['http', 'https']) };
    case 's3':
    case 'aws':
      return {
        kind,
        endpoint: url(raw, 'endpoint', at, ['http', 'https']),
        region: optional(raw, 'region', at) ?? 'us-east-1',
        accessKey: optional(raw, 'accessKey', at),
        secretKey: optional(raw, 'secretKey', at),
      };
    case 'mysql':
      return { kind, url: url(raw, 'url', at, ['mysql']) };
    case 'mongodb':
      return { kind, url: url(raw, 'url', at, ['mongodb', 'mongodb+srv']) };
    case 'rabbitmq':
      return { kind, url: url(raw, 'url', at, ['amqp', 'amqps']) };
    default:
      return undefined;
  }
}

/** The one dependency of `kinds` in an environment; a fixture names what is missing or ambiguous. */
export function soleOf<K extends CatalogDependency['kind']>(
  deps: Record<string, { kind: string }>,
  kinds: readonly K[],
  fixture: string,
  environment: string,
): Extract<CatalogDependency, { kind: K }> {
  return soleEntryOf(deps, kinds, fixture, environment)[1];
}

/** soleOf with the dependency's name (what `allowWrites` entries name: `<name>:<operation>`). */
export function soleEntryOf<K extends CatalogDependency['kind']>(
  deps: Record<string, { kind: string }>,
  kinds: readonly K[],
  fixture: string,
  environment: string,
): [string, Extract<CatalogDependency, { kind: K }>] {
  const found = Object.entries(deps).filter(([, dep]) => (kinds as readonly string[]).includes(dep.kind));
  if (found.length !== 1)
    throw new Error(
      `The ${fixture} fixture needs exactly one ${kinds.join(' or ')} dependency in environment ${environment} ` +
        `(found ${found.length}${found.length ? `: ${found.map(([name]) => name).join(', ')}` : ''})`,
    );
  return [found[0][0], found[0][1] as Extract<CatalogDependency, { kind: K }>];
}

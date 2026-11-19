import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { parseDependencies, type DependencyConfig } from './deps/config.ts';
import { parseEnvironment, type EnvironmentDecl } from './env/declare.ts';
import { readState } from './env/lifecycle.ts';
import { hasPlaceholders, resolveDeep } from './env/placeholders.ts';
import { project, readProject } from './project.ts';
import { parseUi, type UiConfig } from './ui/config.ts';

/** Absolute path of the project under test (framework/project.ts): its vgate.yaml's directory. */
export const projectRoot = project.root;
/** Where every step writes its evidence: the project's reports directory. */
export const reportsDir = project.reportsDir;

/** Header expectations: exact value, `/regex/`, or a template with `{origin}`. Names are case-insensitive. */
export interface HeaderRules {
  /** Checked on every response. */
  always?: Record<string, string>;
  /** Checked on every response that has a body. */
  withBody?: Record<string, string>;
  /** Checked when the request carried the configured Origin. */
  cors?: Record<string, string>;
  /** Checked on responses with that status. */
  onStatus?: Record<string, Record<string, string>>;
}

/**
 * A response envelope such as `{ code, message, data }`. Optional: services without one leave it out. Field names are
 * dotted paths into the body (`error.code` reads `{ "error": { "code": ... } }`); a name without a dot is a top-level
 * field. A key that itself contains a dot cannot be named.
 */
export interface EnvelopeRules {
  /** Where a response's code sits, e.g. `code` or `error.code`. Read on every response, for checks and coverage. */
  codeField: string;
  /**
   * Where a success response's data sits, e.g. `data` or `result.data`: what `expectSuccess` returns. Left out, it
   * returns the whole body, for an API that wraps its errors only. Declare the same path in the service's
   * `createTest<paths, 'result.data'>()` so `expectSuccess` is typed by it.
   */
  dataField?: string;
  /** The code of every success. Left out, a success is held to its status only: an API that codes its errors only. */
  successCode?: string;
  /** Regex that finds the documented codes in an OpenAPI response description, e.g. `ERR\d{4}`. */
  codePattern: string;
}

export interface Rules {
  headers?: HeaderRules;
  /** Every datetime string in a response body must carry this UTC offset, e.g. `+01:00`. */
  datetimeOffset?: string;
  /** Reject response properties the contract does not declare, so an undocumented field fails the gate. */
  strictResponseProperties?: boolean;
  /**
   * Accept `null` for every response property the contract does not mark required. OpenAPI 3.1 says a property is
   * nullable only when its type includes "null"; generators such as springdoc often omit that while the backend
   * serialises nulls. Turning this on is a policy decision that loosens the contract: record why in service.yaml.
   */
  optionalPropertiesNullable?: boolean;
  envelope?: EnvelopeRules;
  /** Server-Sent Events responses (docs/streaming.md). */
  streaming?: StreamingRules;
}

/** One marker that ends a stream: a data line (`[DONE]`) or a named event (`message_stop`). */
export interface StreamTerminal {
  data?: string;
  event?: string;
}

export interface StreamingRules {
  /**
   * The markers that end a stream. A stream that closes before one of them was cut off. Empty: a stream is complete
   * when the server closes it. A `data` marker is not validated against the event schema; an `event` one is.
   */
  terminal?: StreamTerminal[];
  /** The longest wait for the next event (and for the first one) before the stream counts as stalled. Default 30s. */
  eventTimeoutMs?: number;
  /** Per operation (`GET /feed`), what differs from the above: a stream of another style ends differently. */
  operations?: Record<string, Omit<StreamingRules, 'operations'>>;
}

/** A documented response the coverage gate does not demand, with the reason it is out of reach. */
export interface CoverageExclusion {
  /** `POST /path` or `*` (default). */
  operation?: string;
  status?: string;
  code?: string;
  reason: string;
}

export interface KeycloakConfig {
  url: string;
  realm: string;
  clientId: string;
  clientSecret?: string;
  /** Admin credentials for provisioning test users. Only for disposable environments. */
  admin?: { realm?: string; clientId?: string; username: string; password: string };
}

/** How a credential travels. Defaults: `Authorization` with the `Bearer` scheme. */
export interface AuthConfig {
  /** Header name, e.g. `Authorization` or `X-Api-Key`. */
  header?: string;
  /** Prefix before the credential, e.g. `Bearer`; empty for a bare API key. */
  scheme?: string;
  /** Password users log in through the service itself and send its session cookie (docs/auth.md). */
  session?: SessionConfig;
}

/** A login operation of the service under test that answers with a session cookie. */
export interface SessionConfig {
  login: {
    /** Default POST. */
    method?: string;
    path: string;
    /** JSON body; `{username}` and `{password}` in any string value are replaced. */
    body: unknown;
    headers?: Record<string, string>;
  };
  /** Name of the session cookie the login sets. */
  cookie: string;
  /** A CSRF token the service demands on calls with the cookie: read from a cookie or a login response field. */
  csrf?: {
    cookie?: string;
    /** Dot path into the login response body, e.g. `data.csrfToken`. */
    field?: string;
    /** The request header that carries it. */
    header: string;
  };
}

/**
 * An identity that exists before the run. `password`: a Keycloak account (password grant), or a login of the service
 * itself when `auth.session` is set. `token`: a static credential (bearer token or API key, usually `${VAR}`).
 * Neither: anonymous.
 */
export interface SeededUser {
  /** The login name when it differs from the user's key in service.yaml (e.g. an email address). */
  username?: string;
  password?: string;
  token?: string;
  /** For readers of the tests: the role the identity holds. */
  role?: string;
}

export interface EnvironmentConfig {
  name: string;
  baseUrl: string;
  healthPath?: string;
  /** Sent as the Origin header on every call, so every response is checked for CORS. */
  origin?: string;
  /** The identity provider of password users; absent for services that authenticate otherwise. */
  keycloak?: KeycloakConfig;
  auth?: AuthConfig;
  db?: { url: string; schema?: string };
  compose?: { file: string; project?: string };
  /** Seeded identities that exist before the run. */
  users: Record<string, SeededUser>;
  /**
   * False for shared environments (staging, production): tests that need disposable state (fault injection, fuzzing)
   * skip, and the client refuses every request that is not read-only before it leaves the machine, except the
   * operations listed in `allowWrites` (docs/after-deploy.md).
   */
  disposable: boolean;
  /**
   * Writes a non-disposable environment accepts from the tests: `METHOD /path/template` (e.g. `POST
   * /api/v1/auth/login` for a synthetic account's session), a bare template for every method, or
   * `<dependency>:<operation>` for a dependency helper (e.g. `payments-queue:publish`, docs/after-deploy.md).
   */
  allowWrites?: string[];
  /** A non-disposable environment accepts load from `vgate perf` (k6) only with `allowLoad: true`. */
  allowLoad?: boolean;
  /** Limits a canary must stay within while it takes traffic (`vgate canary`, docs/after-deploy.md). */
  canary?: CanaryConfig;
  /** What the service talks to besides its database: stubbed providers, Kafka, Redis, toxiproxy (deps/config.ts). */
  dependencies?: Record<string, DependencyConfig>;
  /** Signed webhooks the tests send to the service, by provider name (docs/webhooks.md). */
  webhooks?: Record<string, WebhookConfig>;
  /**
   * Set when the service declares an `environment` (docs/environments.md): whether this run's environment is up, so
   * its `{name.key}` placeholders above are resolved. Down, they stay as written and nothing answers at baseUrl.
   */
  declared?: { up: boolean; project?: string; runId?: string };
}

/**
 * Where a canary's health is read, and its limits. `prometheus`: `queries` are PromQL against `url`'s
 * `/api/v1/query`. `http`: `url` answers JSON and `queries` are dotted paths into it. A limit is the highest value
 * allowed; `baseline` (same kinds of query) adds a comparison: the canary may be at most `maxRatio` times the baseline.
 */
export interface CanaryConfig {
  source: 'prometheus' | 'http';
  url: string;
  queries: Record<string, string>;
  limits: Record<string, number>;
  baseline?: Record<string, string>;
  /** Default 2: a canary twice as bad as the version it replaces fails, whatever the absolute limit. */
  maxRatio?: number;
  /** Extra request headers for the metrics source (e.g. `Authorization: Bearer ${PROM_TOKEN}`). */
  headers?: Record<string, string>;
}

/** The scenarios `vgate smoke` runs against a deployed environment: explicit ids, a Playwright grep, or neither. */
export interface SmokeConfig {
  scenarios?: string[];
  grep?: string;
}

/** How a provider signs its webhooks: HMAC over a payload template, written into a header template. */
export interface WebhookConfig {
  /** The service's endpoint that receives them, e.g. `/api/v1/webhooks/doit`. */
  path: string;
  method?: string;
  secret: string;
  /** `utf8` (default) or `base64` (Standard Webhooks' `whsec_...` secrets: the part after the prefix is decoded). */
  secretEncoding?: 'utf8' | 'base64';
  algorithm?: 'sha256' | 'sha1' | 'sha512';
  encoding?: 'hex' | 'base64';
  /** What is signed; `{body}`, `{timestamp}`, `{id}`. Default `{body}`. */
  payload?: string;
  /** The signature header and its value template: `{signature}`, `{timestamp}`, `{id}`. Default `{signature}`. */
  header: string;
  format?: string;
  /** Extra headers, same placeholders, e.g. Standard Webhooks' `webhook-id` and `webhook-timestamp`. */
  headers?: Record<string, string>;
  /** Unix seconds (default) or milliseconds. */
  timestampUnit?: 's' | 'ms';
}

/** Spec-driven generated testing (Schemathesis). */
export interface SchemathesisConfig {
  /**
   * The operations safe in any environment (they write nothing), by path regex, by method, or both (an operation
   * must then match both): `readOnlyPaths: '/search$'` for an API that reads through POST, `readOnlyMethods: [GET]` for REST.
   */
  readOnlyPaths?: string;
  readOnlyMethods?: string[];
  /** Seeded users to run as: one run per identity, so each role's view of the API is exercised. */
  users?: string[];
  /** A check the service legitimately fails, with the documented rule that says so. */
  excludeChecks?: Array<{ check: string; reason: string }>;
  maxExamples?: number;
  seed?: number;
}

export interface ServiceConfig {
  name: string;
  /** Absolute path of services/<name>. */
  dir: string;
  /**
   * Absolute path of the vendored OpenAPI contract. A UI service (`ui:`) may have none: then this names where one
   * would be, the file does not exist, and the contract steps (Schemathesis, response coverage) do not apply.
   */
  specPath: string;
  backend?: { repo: string; syncedCommit?: string };
  /**
   * Repository paths (globs relative to the git top level) whose change can affect the service, so a pull request
   * gates only the services it can break (`vgate affected`). Absent: every change affects it.
   */
  paths?: string[];
  rules: Rules;
  coverage: { exclude: CoverageExclusion[] };
  schemathesis: SchemathesisConfig;
  /** `smoke:` of service.yaml (`vgate smoke`); absent: the read-only scenarios of the plan. */
  smoke?: SmokeConfig;
  env: EnvironmentConfig;
  /** The sealed environment a run starts for itself (`environment:`); absent when the service uses its stack.sh. */
  environment?: EnvironmentDecl;
  /** A web frontend verified in a real browser (`ui:`, framework/ui); absent for an API service. */
  ui?: UiConfig;
}

/** `paths:` of a service.yaml: a list of non-empty globs, or absent. Shared with `vgate affected`. */
export function parsePaths(value: unknown, where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === ''))
    throw new Error(`${where}: paths must be a list of path globs, e.g. ['services/api/**', 'libs/shared/**']`);
  return value as string[];
}

/** `smoke:` of a service.yaml: `{ scenarios: [ids] }`, `{ grep: <regex> }`, or absent. */
export function parseSmoke(value: unknown, where: string): SmokeConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = record(value);
  if (Object.keys(raw).length === 0 && (typeof value !== 'object' || Array.isArray(value)))
    throw new Error(`${where}: expected { scenarios: [ids] } or { grep: <regex> }`);
  const scenarios = raw.scenarios;
  if (
    scenarios !== undefined &&
    (!Array.isArray(scenarios) || scenarios.some((id) => typeof id !== 'string' || id === ''))
  )
    throw new Error(`${where}.scenarios: a list of scenario ids, e.g. [HLT-200, LST-200]`);
  if (raw.grep !== undefined && text(raw.grep) === undefined) throw new Error(`${where}.grep: a non-empty regex`);
  return { scenarios: scenarios as string[] | undefined, grep: text(raw.grep) };
}

/** `allowWrites:` of an environment: `METHOD /template`, `/template` or `dependency:operation` entries. */
export function parseAllowWrites(value: unknown, where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const valid = (entry: unknown) =>
    typeof entry === 'string' && (/^([A-Za-z]+\s+)?\/\S*$/.test(entry) || /^[A-Za-z][\w.-]*:[a-z][\w-]*$/.test(entry));
  if (!Array.isArray(value) || !value.every(valid))
    throw new Error(
      `${where}: a list of 'METHOD /path/template', '/path/template' or 'dependency:operation' (e.g. 'events:publish') entries`,
    );
  return value as string[];
}

/** `canary:` of an environment, validated: a source, a URL, queries and a limit for each query. */
export function parseCanary(value: unknown, where: string): CanaryConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = record(value);
  const source = raw.source;
  if (source !== 'prometheus' && source !== 'http') throw new Error(`${where}.source: prometheus or http`);
  const url = text(raw.url);
  if (!url || !/^https?:\/\//.test(url)) throw new Error(`${where}.url: an http(s) URL`);
  const strings = (map: unknown, what: string): Record<string, string> => {
    const entries = Object.entries(record(map));
    if (entries.some(([, q]) => typeof q !== 'string' || q === ''))
      throw new Error(`${where}.${what}: each entry a non-empty query`);
    return Object.fromEntries(entries) as Record<string, string>;
  };
  const queries = strings(raw.queries, 'queries');
  if (Object.keys(queries).length === 0) throw new Error(`${where}.queries: at least one metric`);
  const limits = Object.fromEntries(Object.entries(record(raw.limits)));
  for (const metric of Object.keys(queries)) {
    if (typeof limits[metric] !== 'number' || !Number.isFinite(limits[metric]))
      throw new Error(`${where}.limits.${metric}: a number (the highest value allowed)`);
  }
  const baseline = raw.baseline === undefined ? undefined : strings(raw.baseline, 'baseline');
  for (const metric of Object.keys(baseline ?? {})) {
    if (!(metric in queries)) throw new Error(`${where}.baseline.${metric}: no query of that name to compare with`);
  }
  const maxRatio = raw.maxRatio;
  if (maxRatio !== undefined && (typeof maxRatio !== 'number' || !(maxRatio > 0)))
    throw new Error(`${where}.maxRatio: a number above 0`);
  const headers = raw.headers === undefined ? undefined : strings(raw.headers, 'headers');
  return {
    source,
    url: url.replace(/\/$/, ''),
    queries,
    limits: limits as Record<string, number>,
    baseline,
    maxRatio,
    headers,
  };
}

/**
 * The environment without its dependencies' `sandbox` blocks: only `vgate drift` reads those (and interpolates them
 * itself), so a provider sandbox's secret that is not set never stops the gate.
 */
function withoutSandboxes(rawEnv: unknown): unknown {
  const env = record(rawEnv);
  const deps = env.dependencies;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return rawEnv;
  return {
    ...env,
    dependencies: Object.fromEntries(
      Object.entries(deps as Record<string, unknown>).map(([name, dep]) => [
        name,
        dep && typeof dep === 'object' && !Array.isArray(dep) ? { ...dep, sandbox: undefined } : dep,
      ]),
    ),
  };
}

const VAR = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

function interpolate(value: unknown, where: string): unknown {
  if (typeof value === 'string') {
    return value.replace(VAR, (_match, name: string, fallback: string | undefined) => {
      const found = process.env[name] ?? fallback;
      if (found === undefined) throw new Error(`${where}: environment variable ${name} is required`);
      return found;
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, where));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, where)]));
  }
  return value;
}

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === null || value === '') throw new Error(`service.yaml: ${what} is required`);
  return value;
}

/**
 * Loads services/<name>/service.yaml for one environment. Only the selected environment is interpolated, so a
 * missing secret of another environment never breaks a local run. `root` is the project (the directory of its
 * vgate.yaml, which names its services directory): VGATE_PROJECT, or the runtime's own directory, by default.
 */
export function loadService(
  name: string | undefined = process.env.SERVICE,
  envName: string = process.env.TEST_ENV ?? 'local',
  root: string = projectRoot,
): ServiceConfig {
  if (!name) throw new Error('Set SERVICE to the service under test, e.g. SERVICE=example (see vgate services)');
  const dir = resolve(readProject(root).servicesDir, name);
  const file = resolve(dir, 'service.yaml');
  if (!existsSync(file)) throw new Error(`No service.yaml for "${name}" at ${file}`);
  const raw = record(parse(readFileSync(file, 'utf8')));
  const environments = record(raw.environments);
  const rawEnv = environments[envName];
  if (!rawEnv)
    throw new Error(
      `service.yaml of ${name} has no environment "${envName}" (have: ${Object.keys(environments).join(', ')})`,
    );

  const top = record(interpolate({ ...raw, environments: undefined }, `${name} service.yaml`));
  const project = readProject(root);
  const environment = parseEnvironment(top.environment, { service: dir, project: project.root }, `${name} environment`);
  let env = record(interpolate(withoutSandboxes(rawEnv), `${name} environment ${envName}`));
  let declared: EnvironmentConfig['declared'];
  let composeOfRun: EnvironmentConfig['compose'];
  if (environment && hasPlaceholders(env)) {
    // `{name.key}` values exist once this run's environment is up (vgate up writes them); down, they stay as written.
    const state = readState(project.reportsDir, name);
    declared = { up: state !== undefined, project: state?.project, runId: state?.runId };
    if (state) {
      env = record(resolveDeep(env, state.external, `${name} environments.${envName}`));
      composeOfRun = { file: state.composeFile, project: state.project };
    }
  } else if (environment) {
    const state = readState(project.reportsDir, name);
    declared = { up: state !== undefined, project: state?.project, runId: state?.runId };
  }
  const backend = top.backend === undefined ? undefined : record(top.backend);
  const compose = env.compose === undefined ? undefined : record(env.compose);
  const keycloak = env.keycloak === undefined ? undefined : record(env.keycloak);
  const users = record(env.users) as EnvironmentConfig['users'];
  for (const [user, cfg] of Object.entries(users)) {
    if (cfg?.password !== undefined && !keycloak && record(record(env.auth).session).login === undefined)
      throw new Error(
        `service.yaml: user ${user} has a password but environments.${envName} has neither keycloak nor auth.session`,
      );
  }

  return {
    name,
    dir,
    // A UI service may have no contract of its own; an API service always has one.
    specPath: resolve(
      dir,
      top.ui === undefined ? required(text(top.spec), 'spec') : (text(top.spec) ?? 'openapi.yaml'),
    ),
    ui: parseUi(top.ui, `${name} service.yaml ui`),
    backend: backend
      ? { repo: resolve(dir, required(text(backend.repo), 'backend.repo')), syncedCommit: text(backend.syncedCommit) }
      : undefined,
    paths: parsePaths(top.paths, `${name} service.yaml`),
    rules: record(top.rules),
    coverage: { exclude: (record(top.coverage).exclude ?? []) as CoverageExclusion[] },
    schemathesis: record(top.schemathesis),
    smoke: parseSmoke(top.smoke, `${name} service.yaml smoke`),
    env: {
      name: envName,
      baseUrl: required(text(env.baseUrl), `environments.${envName}.baseUrl`).replace(/\/$/, ''),
      healthPath: text(env.healthPath),
      origin: text(env.origin),
      keycloak: keycloak && {
        url: required(text(keycloak.url), 'keycloak.url').replace(/\/$/, ''),
        realm: required(text(keycloak.realm), 'keycloak.realm'),
        clientId: required(text(keycloak.clientId), 'keycloak.clientId'),
        clientSecret: text(keycloak.clientSecret),
        admin:
          keycloak.admin === undefined ? undefined : (record(keycloak.admin) as unknown as KeycloakConfig['admin']),
      },
      auth: env.auth === undefined ? undefined : record(env.auth),
      db: env.db === undefined ? undefined : (record(env.db) as unknown as EnvironmentConfig['db']),
      compose: compose
        ? { file: resolve(dir, required(text(compose.file), 'compose.file')), project: text(compose.project) }
        : composeOfRun,
      declared,
      users,
      webhooks: env.webhooks === undefined ? undefined : (record(env.webhooks) as EnvironmentConfig['webhooks']),
      disposable: env.disposable === true,
      allowWrites: parseAllowWrites(env.allowWrites, `${name} service.yaml environments.${envName}.allowWrites`),
      allowLoad: (() => {
        if (env.allowLoad === undefined) return undefined;
        if (typeof env.allowLoad !== 'boolean')
          throw new Error(`${name} service.yaml environments.${envName}.allowLoad: true or false`);
        return env.allowLoad;
      })(),
      canary: parseCanary(env.canary, `${name} service.yaml environments.${envName}.canary`),
      dependencies: parseDependencies(
        env.dependencies,
        dir,
        env.disposable === true,
        `${name} service.yaml environments.${envName}.dependencies`,
      ),
    },
    environment,
  };
}

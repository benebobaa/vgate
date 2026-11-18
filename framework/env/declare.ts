/**
 * The `environment` block of service.yaml: the system a verification run starts for itself and destroys afterwards.
 * Pure parsing and checks, so the rules are self-tested without Docker.
 *
 *   environment:
 *     sealed: true                       # default; the app is a container with no route out of the environment
 *     app:
 *       build: { context: services/orders, dockerfile: Dockerfile }   # or image: <ref>, or command: <host command>
 *       port: 8080
 *       env: { DATABASE_URL: '{db.url}' }   # placeholders: {<dependency>.<export>}
 *       health: /health
 *     dependencies:
 *       db: { kind: postgres, options: { database: orders }, seed: seed.sql }
 *       payments: { kind: wiremock, faults: true }
 *
 * Paths: `build.context` and `build.dockerfile` resolve against the project root (where vgate.yaml is), `seed` against
 * the service directory.
 */
import { isAbsolute, resolve } from 'node:path';
import { catalogKinds, kindOf } from './catalog/index.ts';

export interface AppDecl {
  build?: { context: string; dockerfile?: string; target?: string };
  image?: string;
  /** A host command: the app runs outside any container, so the environment cannot be sealed. */
  command?: string;
  port: number;
  env: Record<string, string>;
  health: string;
}

export interface DependencyDecl {
  kind: string;
  image?: string;
  /** Everything else written on the dependency (options, topics, seed, migrate...), handed to its kind. */
  options: Record<string, unknown>;
  /** Route the app's calls to it through the edge, so the tests can slow or cut it. */
  faults: boolean;
}

export interface EnvironmentDecl {
  sealed: boolean;
  app: AppDecl;
  dependencies: Record<string, DependencyDecl>;
}

/** Names the generator uses itself. */
export const RESERVED = ['app', 'edge', 'dns'] as const;
const NAME = /^[a-z][a-z0-9-]{0,30}$/;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);

function text(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${at} must be a non-empty string`);
  return value;
}

/** Parses `environment`; undefined when service.yaml declares none (the service then uses its stack.sh). */
export function parseEnvironment(
  raw: unknown,
  dirs: { service: string; project: string },
  where = 'environment',
): EnvironmentDecl | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error(`${where} must be a map`);
  const unknownKeys = Object.keys(raw).filter((key) => !['sealed', 'app', 'dependencies'].includes(key));
  if (unknownKeys.length > 0) throw new Error(`${where}: unknown key(s) ${unknownKeys.join(', ')}`);

  const app = raw.app;
  if (!isRecord(app)) throw new Error(`${where}.app is required: how to run the service under test`);
  const sources = ['build', 'image', 'command'].filter((key) => app[key] !== undefined);
  if (sources.length !== 1) throw new Error(`${where}.app needs exactly one of build, image or command`);
  const port = app.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${where}.app.port must be the port the app listens on`);
  let build: AppDecl['build'];
  if (app.build !== undefined) {
    const b = typeof app.build === 'string' ? { context: app.build } : app.build;
    if (!isRecord(b)) throw new Error(`${where}.app.build must be a path or { context, dockerfile?, target? }`);
    const context = resolve(dirs.project, text(b.context, `${where}.app.build.context`));
    build = {
      context,
      dockerfile: b.dockerfile === undefined ? undefined : text(b.dockerfile, `${where}.app.build.dockerfile`),
      target: b.target === undefined ? undefined : text(b.target, `${where}.app.build.target`),
    };
  }
  const env = app.env ?? {};
  if (!isRecord(env)) throw new Error(`${where}.app.env must be a map of name -> value`);
  const command = app.command === undefined ? undefined : text(app.command, `${where}.app.command`);

  const sealedRaw = raw.sealed ?? true;
  if (typeof sealedRaw !== 'boolean') throw new Error(`${where}.sealed must be true or false`);
  if (sealedRaw && command)
    throw new Error(
      `${where}: an app run as a host command cannot be sealed; build it as a container (app.build or app.image) or set sealed: false`,
    );

  const deps = raw.dependencies ?? {};
  if (!isRecord(deps)) throw new Error(`${where}.dependencies must be a map of name -> dependency`);
  const dependencies: Record<string, DependencyDecl> = {};
  for (const [name, value] of Object.entries(deps)) {
    const at = `${where}.dependencies.${name}`;
    if (!NAME.test(name)) throw new Error(`${at}: a name is a lower-case DNS label (it is the host name inside)`);
    if ((RESERVED as readonly string[]).includes(name)) throw new Error(`${at}: "${name}" is reserved`);
    if (!isRecord(value)) throw new Error(`${at} must be a map`);
    const kind = text(value.kind, `${at}.kind`);
    if (!kindOf(kind)) throw new Error(`${at}.kind "${kind}" is not in the catalog (${catalogKinds().join(', ')})`);
    if (value.ports !== undefined)
      throw new Error(`${at}: host ports are chosen per run and never fixed, so runs cannot collide; remove ports`);
    const options: Record<string, unknown> = isRecord(value.options) ? { ...value.options } : {};
    for (const [key, item] of Object.entries(value))
      if (!['kind', 'image', 'options', 'faults'].includes(key)) options[key] = item;
    if (typeof options.seed === 'string' && !isAbsolute(options.seed))
      options.seed = resolve(dirs.service, options.seed);
    if (value.faults !== undefined && typeof value.faults !== 'boolean')
      throw new Error(`${at}.faults must be true or false`);
    dependencies[name] = {
      kind,
      image: value.image === undefined ? undefined : text(value.image, `${at}.image`),
      options,
      faults: value.faults === true,
    };
  }

  const health = app.health === undefined ? '/' : text(app.health, `${where}.app.health`);
  return {
    sealed: sealedRaw,
    app: {
      build,
      image: app.image === undefined ? undefined : text(app.image, `${where}.app.image`),
      command,
      port,
      env: Object.fromEntries(Object.entries(env).map(([key, item]) => [key, String(item)])),
      health: health.startsWith('/') ? health : `/${health}`,
    },
    dependencies,
  };
}

/**
 * Carries out a planned environment (framework/env/generate.ts) with Docker Compose: up (start, wait healthy, set up,
 * start the app), down (always removes containers, networks and volumes: an environment is disposable), status, and
 * the outbound watch (every name the environment's containers tried to resolve outside it).
 *
 * The state of a running environment is <reports>/env/<service>.json; config.ts reads it to resolve the tests'
 * placeholders. Its files (compose.yaml, edge.json, Corefile, the host app's log) live in <reports>/env/<service>/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { basename, join, relative, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import { kindOf } from './catalog/index.ts';
import type { EnvironmentDecl } from './declare.ts';
import { plan, type Plan, type PlannedMigration } from './generate.ts';
import type { Values } from './placeholders.ts';

export interface EnvState {
  schema: 'vgate.env/1';
  service: string;
  runId: string;
  project: string;
  composeFile: string;
  sealed: boolean;
  appInside: boolean;
  appPid?: number;
  /** The built app's image (`vgate/<service>-app:<hash>`), kept across runs and reused while the code is unchanged. */
  appImage?: string;
  /** Placeholder values from the tests' side. */
  external: Values;
  published: Plan['published'];
  /** Sealed-network address -> compose service, for naming who tried to go out. */
  addresses: Record<string, string>;
  startedAt: string;
}

export interface Outbound {
  from: string;
  host: string;
  /** DNS shows names, not ports; a connection to a literal IP is blocked by the network but not seen here. */
  port: number | null;
  blocked: boolean;
}

export interface EnvOptions {
  service: string;
  decl: EnvironmentDecl;
  reportsDir: string;
  /** Streams Docker's output (stderr). */
  live?: boolean;
  /** The project root: a dependency's `migrate.dir` resolves against it. Default: the reports dir's parent. */
  projectRoot?: string;
}

export const statePath = (reportsDir: string, service: string) => join(reportsDir, 'env', `${service}.json`);
const envDir = (reportsDir: string, service: string) => join(reportsDir, 'env', service);

export function readState(reportsDir: string, service: string): EnvState | undefined {
  const file = statePath(reportsDir, service);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as EnvState;
  } catch {
    return undefined;
  }
}

interface Ran {
  code: number | null;
  out: string;
}

function compose(state: Pick<EnvState, 'project' | 'composeFile'>, args: string[], live = false): Promise<Ran> {
  return run('docker', ['compose', '-p', state.project, '-f', state.composeFile, ...args], live);
}

function run(command: string, args: string[], live = false): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (chunk: Buffer) => {
      out += chunk.toString();
      if (live) process.stderr.write(chunk);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => done({ code: null, out: `${out}${error.message}` }));
    child.on('close', (code) => done({ code, out }));
  });
}

/** A free port on the loopback interface, chosen by the OS. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until(seconds: number, what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`Timed out after ${seconds}s waiting for ${what}`);
    await sleep(1000);
  }
}

async function httpOk(url: string): Promise<boolean> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return response.ok;
}

function tcpOk(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
    socket.once('timeout', () => {
      socket.destroy();
      done(false);
    });
  });
}

const randomSubnet = () => `10.${64 + Math.floor(Math.random() * 64)}.${Math.floor(Math.random() * 256)}.0/24`;

/**
 * Starts the service's environment for this run and waits until everything answers. Any failure tears it down again
 * (nothing half-started is left behind) and throws with the logs that explain it.
 */
export async function envUp(options: EnvOptions): Promise<EnvState> {
  // Whatever this project left of the service (a state file, or containers of a crashed run) goes first: an
  // environment is never adopted, always started by this run.
  await envDown(options.reportsDir, options.service);

  const dir = envDir(options.reportsDir, options.service);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const runId =
    (process.env.RUN_ID ?? '')
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 8)
      .toLowerCase() || randomBytes(3).toString('hex');

  const labels = runLabels(options.reportsDir, options.service);
  const build = options.decl.app.build;
  const appImage = build
    ? appImageName(options.service, contextHash(build.context, build.dockerfile, build.target), options.reportsDir)
    : undefined;

  let lastError = '';
  // A random subnet or a just-freed port can be taken by another run between choosing and starting: try again.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ports = new Map<string, number>();
    const keys = ['edge.api', 'app'];
    for (const [name, dep] of Object.entries(options.decl.dependencies)) keys.push(...depKeys(name, dep.kind));
    for (const key of keys) ports.set(key, await freePort());
    const planned = plan({
      service: options.service,
      runId: attempt === 1 ? runId : `${runId}${attempt}`,
      decl: options.decl,
      hostPort: (key) => ports.get(key) ?? 0,
      subnet: randomSubnet(),
      envDir: dir,
      appImage,
      labels,
      projectRoot: options.projectRoot ?? resolve(options.reportsDir, '..'),
    });
    const composeFile = join(dir, 'compose.yaml');
    writeFileSync(composeFile, stringify(planned.compose));
    writeFileSync(join(dir, 'edge.json'), JSON.stringify(planned.edgeConfig, null, 2));
    writeFileSync(join(dir, 'Corefile'), planned.corefile);
    const state: EnvState = {
      schema: 'vgate.env/1',
      service: options.service,
      runId: planned.project.slice(`vgate-${options.service}-`.length),
      project: planned.project,
      composeFile,
      sealed: planned.sealed,
      appInside: planned.appInside,
      external: planned.external,
      published: planned.published,
      addresses: {},
      startedAt: new Date().toISOString(),
      ...(appImage ? { appImage } : {}),
    };
    // Written before starting, so `down` can always find what to remove.
    writeFileSync(statePath(options.reportsDir, options.service), JSON.stringify(state, null, 2));

    // Build first, alone: building while JVM-based dependencies start can starve a small Docker VM. Then the
    // dependencies, waited for and set up; the app last, so it never starts against a half-ready dependency.
    // An image of exactly this build context exists already: reuse it instead of building again.
    if (planned.appInside && build && !(appImage && (await imageExists(appImage)))) {
      const built = await compose(state, ['build', 'app'], options.live);
      if (built.code !== 0) {
        await envDown(options.reportsDir, options.service);
        throw new Error(`The app of ${options.service} did not build:\n${tailOf(built.out, 40)}`);
      }
      // Older builds of this app are superseded: removing them now keeps one image per service on the machine.
      if (appImage) await removeSupersededImages(appImage);
    }
    const infrastructure = ['dns', 'edge', ...Object.keys(options.decl.dependencies)];
    const started = await compose(state, ['up', '-d', '--remove-orphans', ...infrastructure], options.live);
    if (started.code !== 0) {
      lastError = started.out;
      await envDown(options.reportsDir, options.service);
      mkdirSync(dir, { recursive: true });
      if (/overlap|address already in use|port is already allocated|Pool overlaps/i.test(started.out)) continue;
      throw new Error(`The environment of ${options.service} did not start:\n${tailOf(started.out, 30)}`);
    }

    try {
      await waitAndSetUp(planned, state, options);
      if (planned.appInside) {
        const app = await compose(state, ['up', '-d', '--no-deps', 'app'], options.live);
        if (app.code !== 0) throw new Error(`The app of ${options.service} did not start:\n${tailOf(app.out, 30)}`);
      } else {
        // A host app listens on a fixed port: something already there (another checkout's app) would answer the
        // health check and be tested in this code's place. Refuse instead of adopting it.
        const holder = await portHolder(options.decl.app.port);
        if (holder)
          throw new Error(
            `port ${options.decl.app.port} is already held by ${holder}, which this run did not start (another ` +
              `checkout's app?). Stop it or change environment.app.port; vgate never tests an app it did not start.`,
          );
        state.appPid = startHostApp(planned, options, dir);
      }
      await until(planned.appInside ? 180 : 60, `${options.service} at ${planned.appHealthUrl}`, () =>
        httpOk(planned.appHealthUrl),
      );
      if (!planned.appInside && state.appPid) {
        const listener = await listenerPid(options.decl.app.port);
        if (listener !== undefined && !isDescendant(listener, state.appPid))
          throw new Error(
            `the app answering on port ${options.decl.app.port} (pid ${listener}) is not the one this run started ` +
              `(pid ${state.appPid})`,
          );
      }
      state.addresses = await addresses(state);
      writeFileSync(statePath(options.reportsDir, options.service), JSON.stringify(state, null, 2));
      return state;
    } catch (error) {
      const logs = await compose(state, ['logs', '--no-color', '--tail', '40']);
      await envDown(options.reportsDir, options.service);
      throw new Error(`${(error as Error).message}\n${tailOf(logs.out, 60)}`, { cause: error });
    }
  }
  throw new Error(`The environment of ${options.service} did not start after 3 attempts:\n${tailOf(lastError, 30)}`);
}

/** Mirrors plan(): one host port per published port of the dependency. */
function depKeys(name: string, kind: string): string[] {
  const k = kindOf(kind);
  return (k?.published ?? Object.keys(k?.ports ?? {})).map((port) => `${name}.${port}`);
}

async function waitAndSetUp(planned: Plan, state: EnvState, options: EnvOptions): Promise<void> {
  await Promise.all(
    planned.dependencies.map(async (dep) => {
      const health = dep.kind.health;
      const seconds = dep.kind.healthTimeout ?? 60;
      if ('exec' in health) {
        await until(seconds, `${dep.name} (${dep.kind.kind})`, async () => {
          const ran = await compose(state, ['exec', '-T', dep.name, ...health.exec]);
          return ran.code === 0;
        });
      } else if ('http' in health) {
        const port = dep.hostPorts[health.http.port];
        await until(seconds, `${dep.name} (${dep.kind.kind})`, () =>
          httpOk(`http://127.0.0.1:${port}${health.http.path}`),
        );
      } else {
        const port = dep.hostPorts[health.tcp.port];
        await until(seconds, `${dep.name} (${dep.kind.kind})`, () => tcpOk(port));
      }
      const setupCommands = dep.kind.setup?.(dep.ctx) ?? [];
      const migration = planned.migrations.find((m) => m.dependency === dep.name);
      // With migrations: readiness (the first setup command), the migrations, then the rest (the seed fills migrated
      // tables). Without: every setup command, as before.
      const { before, after } = splitSetup(setupCommands, migration !== undefined);
      const setUp = async (command: string[]) =>
        // Setup commands may race the server's own start-up for a moment (a database still running its init scripts).
        until(seconds, `${dep.name} setup: ${command.join(' ')}`, async () => {
          const ran = await compose(state, ['exec', '-T', dep.name, ...command], options.live);
          return ran.code === 0;
        });
      for (const command of before) await setUp(command);
      if (migration) {
        const ran = await runMigration(state, migration, migration.config.command, options.live);
        if (ran.code !== 0)
          throw new Error(
            `The migrations of ${dep.name} failed (${migration.config.command}):\n${tailOf(ran.out, 40)}`,
          );
      }
      for (const command of after) await setUp(command);
    }),
  );
}

/**
 * Where a dependency's migrations go among its setup commands: after the first (its readiness query), before the rest
 * (the seed, which fills migrated tables). Without migrations every command runs as before. Pure; exported for tests.
 */
export function splitSetup(commands: string[][], migrating: boolean): { before: string[][]; after: string[][] } {
  return migrating ? { before: commands.slice(0, 1), after: commands.slice(1) } : { before: commands, after: [] };
}

/**
 * Runs `command` (the migrations, or their `down`) in a dependency's migrate tool service, with its migrations
 * directory mounted read-only at /migrations. Exported for the migration checks (cli/migrations.ts).
 */
export function runMigration(
  state: Pick<EnvState, 'project' | 'composeFile'>,
  migration: Pick<PlannedMigration, 'service' | 'config'>,
  command: string,
  live = false,
): Promise<{ code: number | null; out: string }> {
  return compose(
    state,
    ['run', '--rm', '--no-deps', '-T', '-v', `${migration.config.dir}:/migrations:ro`, migration.service, command],
    live,
  );
}

function startHostApp(planned: Plan, options: EnvOptions, dir: string): number {
  const log = openSync(join(dir, 'app.log'), 'a');
  const command = options.decl.app.command ?? '';
  const child = spawn('sh', ['-c', `exec ${command}`], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ...planned.appEnv },
  });
  child.unref();
  return child.pid ?? 0;
}

async function addresses(state: EnvState): Promise<Record<string, string>> {
  const ids = await compose(state, ['ps', '-q']);
  const list = ids.out
    .split('\n')
    .map((id) => id.trim())
    .filter(Boolean);
  if (list.length === 0) return {};
  const inspected = await run('docker', [
    'inspect',
    '--format',
    '{{index .Config.Labels "com.docker.compose.service"}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
    ...list,
  ]);
  const out: Record<string, string> = {};
  for (const line of inspected.out.split('\n')) {
    const [service, ...ips] = line.trim().split(/\s+/);
    for (const ip of ips) if (service && ip) out[ip] = service;
  }
  return out;
}

/**
 * Stops and removes everything the service's runs in this project created: containers, networks, volumes, the host
 * app, the files. Without a state file (a crash, a deleted reports dir) it still finds the runs by their labels.
 * Superseded app images go too; the current one stays for the next run to reuse.
 */
export async function envDown(reportsDir: string, service: string, live = false): Promise<boolean> {
  const state = readState(reportsDir, service);
  const orphans = (await labelledProjects(reportsDir, service)).filter((p) => p !== state?.project);
  for (const project of orphans) await removeProject(project, live);
  if (!state) {
    rmSync(envDir(reportsDir, service), { recursive: true, force: true });
    return orphans.length > 0;
  }
  if (state.appPid) {
    try {
      process.kill(-state.appPid, 'SIGTERM');
    } catch {
      try {
        process.kill(state.appPid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  if (existsSync(state.composeFile))
    await compose(state, ['--profile', 'tools', 'down', '--volumes', '--remove-orphans', '--timeout', '5'], live);
  else await removeProject(state.project, live);
  if (state.appImage) await removeSupersededImages(state.appImage);
  rmSync(statePath(reportsDir, service), { force: true });
  rmSync(envDir(reportsDir, service), { recursive: true, force: true });
  return true;
}

export interface EnvStatus {
  up: boolean;
  project?: string;
  containers: Array<{ service: string; state: string }>;
}

export async function envStatus(reportsDir: string, service: string): Promise<EnvStatus> {
  const state = readState(reportsDir, service);
  if (!state) return { up: false, containers: [] };
  const ps = await compose(state, ['ps', '--all', '--format', '{{.Service}}\t{{.State}}']);
  const containers = ps.out
    .split('\n')
    .map((line) => line.trim().split('\t'))
    .filter((parts) => parts.length === 2)
    .map(([svc, st]) => ({ service: svc, state: st }));
  const up = containers.length > 0 && containers.every((c) => c.state === 'running');
  return { up, project: state.project, containers };
}

// CoreDNS `log`: [INFO] 10.70.3.4:41234 - 2211 "A IN example.com. udp 29 false 512" NXDOMAIN ...
const QUERY = /\[INFO\] ([0-9.]+):\d+ - \d+ "\S+ IN (\S+?)\.? /;

/** Parses the DNS log into outbound attempts, one per (from, name). Pure; exported for the self-tests. */
export function parseOutbound(log: string, addresses: Record<string, string>, ownNames: string[]): Outbound[] {
  const seen = new Set<string>();
  const out: Outbound[] = [];
  for (const line of log.split('\n')) {
    const match = QUERY.exec(line);
    if (!match) continue;
    const [, ip, rawName] = match;
    const host = rawName.replace(/\.$/, '').toLowerCase();
    // Containers have no search domain (generate.ts NO_SEARCH): only a bare name of the environment is its own. A name
    // that merely starts with one (s3.amazonaws.com next to a dependency `s3`) is outbound.
    if (ownNames.includes(host)) continue;
    const from = addresses[ip] ?? ip;
    const key = `${from} ${host}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, host, port: null, blocked: true });
  }
  return out;
}

/** Every name the environment's containers asked for outside it, so far in this run. */
export async function envOutbound(reportsDir: string, service: string): Promise<Outbound[]> {
  const state = readState(reportsDir, service);
  if (!state) return [];
  const logs = await compose(state, ['logs', '--no-color', '--no-log-prefix', 'dns']);
  const own = ['app', 'edge', 'dns', ...Object.values(state.addresses)];
  return parseOutbound(logs.out, state.addresses, own);
}

/** The labels every container and network of a run carries: which project (its reports dir) and which service. */
export function runLabels(reportsDir: string, service: string): Record<string, string> {
  return { 'dev.vgate.reports': resolve(reportsDir), 'dev.vgate.service': service };
}

/**
 * `vgate/<service>-<project>-app:<hash>`: one stable name per project, service and build context, so builds are
 * reused and superseded ones found. The project part (a hash of its reports directory) keeps two projects with a
 * service of the same name from pruning each other's images.
 */
export function appImageName(service: string, hash: string, project: string): string {
  const owner = createHash('sha256').update(resolve(project)).digest('hex').slice(0, 8);
  return `vgate/${service.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}-${owner}-app:${hash}`;
}

/** .dockerignore lines as path tests: `name`, `dir/`, `*.log`, `**\/tmp` (enough for the common cases). */
function ignoreRules(context: string): Array<(path: string) => boolean> {
  const file = join(context, '.dockerignore');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  return lines
    .map((line) => line.trim().replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'))
    .map((pattern) => {
      const regex = new RegExp(
        `^${pattern
          .split('**/')
          .map((part) =>
            part
              .split('*')
              .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
              .join('[^/]*'),
          )
          .join('(?:.*/)?')}(?:/.*)?$`,
      );
      return (path: string) => regex.test(path);
    });
}

/**
 * A hash of what `docker build` would see: every file of the context (minus .git, node_modules and .dockerignore's
 * entries) with its content, plus the Dockerfile and target. Equal hashes mean an equal build. Exported for the tests.
 */
export function contextHash(context: string, dockerfile?: string, target?: string): string {
  const hash = createHash('sha256');
  const ignored = ignoreRules(context);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const path = join(dir, entry.name);
        const rel = relative(context, path).split(sep).join('/');
        if (entry.name === '.git' || entry.name === 'node_modules' || ignored.some((test) => test(rel))) return [];
        if (entry.isDirectory()) return walk(path);
        return entry.isFile() ? [rel] : [];
      })
      .sort();
  for (const rel of walk(context)) {
    hash.update(`${rel}\0`);
    hash.update(readFileSync(join(context, rel)));
    hash.update('\0');
  }
  if (dockerfile) {
    const path = resolve(context, dockerfile);
    hash.update(`dockerfile:${dockerfile}\0`);
    if (existsSync(path)) hash.update(readFileSync(path));
  }
  hash.update(`target:${target ?? ''}`);
  return hash.digest('hex').slice(0, 12);
}

/** The tags of `repository` to remove when `keep` is the current image: every other one. Pure; exported for tests. */
export function supersededTags(listing: string, keep: string): string[] {
  const [repository] = keep.split(':');
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((ref) => ref.startsWith(`${repository}:`) && ref !== keep && !ref.endsWith(':<none>'));
}

async function imageExists(ref: string): Promise<boolean> {
  return (await run('docker', ['image', 'inspect', '--format', '{{.Id}}', ref])).code === 0;
}

async function removeSupersededImages(keep: string): Promise<void> {
  const [repository] = keep.split(':');
  const listed = await run('docker', ['images', repository, '--format', '{{.Repository}}:{{.Tag}}']);
  const stale = supersededTags(listed.out, keep);
  if (stale.length > 0) await run('docker', ['rmi', ...stale]);
}

/** Compose project names that carry this project's and service's labels (containers or networks). Pure parsing. */
export function projectsFromListing(listing: string, service: string): string[] {
  return [
    ...new Set(
      listing
        .split('\n')
        .map((line) => line.trim())
        .filter((name) => name.startsWith(`vgate-${service.toLowerCase()}-`)),
    ),
  ];
}

async function labelledProjects(reportsDir: string, service: string): Promise<string[]> {
  const labels = runLabels(reportsDir, service);
  const filters = Object.entries(labels).flatMap(([key, value]) => ['--filter', `label=${key}=${value}`]);
  const format = ['--format', '{{.Label "com.docker.compose.project"}}'];
  const containers = await run('docker', ['ps', '--all', ...filters, ...format]);
  const networks = await run('docker', ['network', 'ls', ...filters, ...format]);
  if (containers.code !== 0 && networks.code !== 0) return [];
  return projectsFromListing(`${containers.out}\n${networks.out}`, service);
}

/** Removes a compose project by name: its containers, networks and volumes, with or without its compose file. */
async function removeProject(project: string, live = false): Promise<void> {
  await run(
    'docker',
    ['compose', '-p', project, '--profile', 'tools', 'down', '--volumes', '--remove-orphans', '--timeout', '5'],
    live,
  );
}

/**
 * The executable name of a process: `/proc/<pid>/exe` on Linux (where `ps -o comm=` is the thread name, which runtimes
 * such as Node 24 rename to `MainThread`), falling back to `ps -o comm=` elsewhere or when `/proc` cannot be read.
 */
export function processName(
  pid: number,
  procRoot = '/proc',
  readComm: (pid: number) => string = (p) =>
    spawnSync('ps', ['-o', 'comm=', '-p', String(p)], { encoding: 'utf8' }).stdout ?? '',
): string {
  try {
    const exe = readlinkSync(join(procRoot, String(pid), 'exe')).replace(/ \(deleted\)$/, '');
    const name = basename(exe);
    if (name) return name;
  } catch {
    // Not Linux, /proc unavailable, or another user's process: fall back to ps.
  }
  const comm = readComm(pid).trim();
  return comm ? basename(comm) : '';
}

/** `name (pid N)` of whatever listens on 127.0.0.1:port, or undefined when the port is free. */
async function portHolder(port: number): Promise<string | undefined> {
  const free = await new Promise<boolean>((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, () => server.close(() => done(true)));
  });
  if (free) return undefined;
  const pid = await listenerPid(port);
  if (pid === undefined) return `an unknown process`;
  const name = processName(pid);
  return `${name || 'a process'} (pid ${pid})`;
}

/** The pid listening on the TCP port (lsof); undefined when unknown. */
async function listenerPid(port: number): Promise<number | undefined> {
  const out = await run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
  const pid = Number(out.out.split('\n')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** True when `pid` is `ancestor` or one of its descendants. */
function isDescendant(pid: number, ancestor: number): boolean {
  let current = pid;
  for (let hops = 0; hops < 64 && current > 1; hops++) {
    if (current === ancestor) return true;
    const parent = Number(
      (spawnSync('ps', ['-o', 'ppid=', '-p', String(current)], { encoding: 'utf8' }).stdout ?? '').trim(),
    );
    if (!Number.isInteger(parent) || parent <= 0) return false;
    current = parent;
  }
  return false;
}

function tailOf(text: string, lines: number): string {
  return text.split('\n').filter(Boolean).slice(-lines).join('\n');
}

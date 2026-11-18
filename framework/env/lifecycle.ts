/**
 * Carries out a planned environment (framework/env/generate.ts) with Docker Compose: up (start, wait healthy, set up,
 * start the app), down (always removes containers, networks and volumes: an environment is disposable), status, and
 * the outbound watch (every name the environment's containers tried to resolve outside it).
 *
 * The state of a running environment is <reports>/env/<service>.json; config.ts reads it to resolve the tests'
 * placeholders. Its files (compose.yaml, edge.json, Corefile, the host app's log) live in <reports>/env/<service>/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { kindOf } from './catalog/index.ts';
import type { EnvironmentDecl } from './declare.ts';
import { plan, type Plan } from './generate.ts';
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
  const existing = readState(options.reportsDir, options.service);
  if (existing) await envDown(options.reportsDir, options.service);

  const dir = envDir(options.reportsDir, options.service);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const runId =
    (process.env.RUN_ID ?? '')
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 8)
      .toLowerCase() || randomBytes(3).toString('hex');

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
    };
    // Written before starting, so `down` can always find what to remove.
    writeFileSync(statePath(options.reportsDir, options.service), JSON.stringify(state, null, 2));

    // Build first, alone: building while JVM-based dependencies start can starve a small Docker VM. Then the
    // dependencies, waited for and set up; the app last, so it never starts against a half-ready dependency.
    if (planned.appInside && options.decl.app.build) {
      const built = await compose(state, ['build', 'app'], options.live);
      if (built.code !== 0) {
        await envDown(options.reportsDir, options.service);
        throw new Error(`The app of ${options.service} did not build:\n${tailOf(built.out, 40)}`);
      }
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
      } else state.appPid = startHostApp(planned, options, dir);
      await until(planned.appInside ? 180 : 60, `${options.service} at ${planned.appHealthUrl}`, () =>
        httpOk(planned.appHealthUrl),
      );
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
      for (const command of dep.kind.setup?.(dep.ctx) ?? []) {
        // Setup commands may race the server's own start-up for a moment (a database still running its init scripts).
        await until(seconds, `${dep.name} setup: ${command.join(' ')}`, async () => {
          const ran = await compose(state, ['exec', '-T', dep.name, ...command], options.live);
          return ran.code === 0;
        });
      }
    }),
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

/** Stops and removes everything the run created: containers, networks, volumes, the host app, its files. */
export async function envDown(reportsDir: string, service: string, live = false): Promise<boolean> {
  const state = readState(reportsDir, service);
  if (!state) return false;
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
    await compose(state, ['down', '--volumes', '--remove-orphans', '--timeout', '5'], live);
  else
    spawnSync('docker', ['compose', '-p', state.project, 'down', '--volumes', '--remove-orphans'], { stdio: 'ignore' });
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
    // A name inside the environment with the host's search domain appended (redis.home.lan) is not outbound.
    if (host.includes('.') && ownNames.includes(host.split('.')[0])) continue;
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

function tailOf(text: string, lines: number): string {
  return text.split('\n').filter(Boolean).slice(-lines).join('\n');
}

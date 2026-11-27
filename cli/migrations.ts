/**
 * `vgate migrations --service <s> --base <ref>`: are this change's database migrations safe to run against what
 * production has, and does the code already deployed keep working on the migrated schema? Migrations run before the
 * new code is live; that window is where a deploy takes production down.
 *
 *   1. lint      the migrations the change adds (Postgres: squawk), risky findings in plain words
 *   2. apply     a sealed environment of the merge base: its migrations, its seed, then this change's migrations
 *   3. round     with `down` configured: undo the added migrations, apply them again
 *   4. old code  the app built from the merge base (the deployed code) on the migrated database, checked by the base's
 *                own read-only tests (`migrate.smoke`)
 *
 * Writes <reports>/migrations.json (`vgate.migrations/1`, bound to the commit like a gate verdict), which `vgate decide`
 * reads as evidence. Exit 0 safe or nothing to check, 1 needs a human or blocked, 3 not ready (no Docker, no base).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { stringify } from 'yaml';
import { writeSignedOrPlainJson } from '../packages/verification/signing.ts';
import { loadService, type ServiceConfig } from '../framework/config.ts';
import { runLabels, runMigration, statePath, type EnvState } from '../framework/env/lifecycle.ts';
import { kindOf } from '../framework/env/catalog/index.ts';
import { plan, type Plan } from '../framework/env/generate.ts';
import {
  addedMigrations,
  applyOrder,
  editedMigrations,
  GOOSE_ANNOTATION,
  isMigrationFile,
  isUndoFile,
  migrateConfigs,
  migrationLayout,
  migrationsVerdict,
  parseSquawk,
  upSection,
  type LintFinding,
  type MigrateConfig,
  type MigrationStep,
  type MigrationsVerdict,
} from '../framework/env/migrate.ts';
import { readProject, type ProjectConfig } from '../framework/project.ts';
import { changeSet } from './affected.ts';
import { treeState, type TreeState } from './commit.ts';
import { git } from './guard.ts';
import { mergeSummaries, parseJunit, type TestFailure } from './junit.ts';
import { CLI, EXIT, UsageError, type Result } from './output.ts';
import { prepare, stepEnv, toolEnv, type Runtime } from './runtime.ts';

export const MIGRATIONS_FILE = 'migrations.json';
/** Pinned: a newer squawk may add rules, and a verdict must not change under the same code. */
export const SQUAWK = 'squawk-cli@2.73.0';

export interface MigrationsReport {
  schema: 'vgate.migrations/1';
  service: string;
  base: string;
  mergeBase: string;
  commit: TreeState;
  verdict: MigrationsVerdict;
  reasons: string[];
  /** Migrations directories (top-relative) and the files this change adds to them. */
  dirs: string[];
  added: string[];
  lint: LintFinding[];
  lintNote?: string;
  steps: MigrationStep[];
  oldCode?: { total: number; failed: number; failures: TestFailure[] };
  startedAt: string;
  durationMs: number;
}

interface Ran {
  code: number | null;
  out: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; live?: boolean } = {},
): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (chunk: Buffer) => {
      out += chunk.toString();
      if (options.live) process.stderr.write(chunk);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => done({ code: null, out: `${out}${error.message}` }));
    child.on('close', (code) => done({ code, out }));
  });
}

/** The last lines of a tool's output, without Docker's progress lines and the database's NOTICEs. */
const tail = (text: string, lines = 12) =>
  text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(
      (l) => l.trim() !== '' && !/^\s*(Container|Network|Volume) \S+ \S+/.test(l) && !/^(NOTICE|WARNING):/.test(l),
    )
    .slice(-lines)
    .join('\n');

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

function tcpOk(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => (socket.destroy(), done(true)));
    socket.once('error', () => done(false));
    socket.once('timeout', () => (socket.destroy(), done(false)));
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until(seconds: number, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await check().catch(() => false)) return true;
    if (Date.now() > deadline) return false;
    await sleep(1000);
  }
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** The migration files of a directory, as its tool names them: no README, dotfile or goose `embed.go`. */
function migrationFiles(cfg: Pick<MigrateConfig, 'dir' | 'command' | 'image'>): string[] {
  const files = listFiles(cfg.dir);
  const goose = files.some(
    (f) => f.endsWith('.sql') && (readText(join(cfg.dir, f)) ?? '').split('\n').some((l) => GOOSE_ANNOTATION.test(l)),
  );
  const layout = migrationLayout(cfg, goose);
  return files.filter((f) => isMigrationFile(f, layout));
}

/**
 * Lints the added .sql migrations of a Postgres dependency with squawk; other kinds and files are not linted. A goose
 * file is linted on its Up section only (`upSection`, through a copy with the Down lines blanked): its Down section runs
 * on a rollback, never on a deploy, and dropping there what the Up adds is what makes it reversible. Exported for the
 * tests.
 */
export async function lint(
  cfg: MigrateConfig,
  added: string[],
  top: string,
  live: boolean,
): Promise<{ findings: LintFinding[]; note?: string; unlinted?: string }> {
  const sql = added.filter((f) => f.endsWith('.sql'));
  if (sql.length === 0)
    return { findings: [], note: added.length > 0 ? 'the added migrations are not SQL files: not linted' : undefined };
  if (cfg.kind !== 'postgres')
    return { findings: [], note: `${cfg.kind} migrations are not linted (squawk reads PostgreSQL)` };
  const copies = mkdtempSync(join(tmpdir(), 'vgate-migrations-lint-'));
  const original = new Map<string, string>(); // a linted copy -> the migration it was made from
  const files = sql.map((f) => {
    const path = join(cfg.dir, f);
    const text = readText(path);
    const up = text === undefined ? text : upSection(text);
    if (up === text) return path;
    const copy = join(copies, f);
    mkdirSync(join(copy, '..'), { recursive: true });
    writeFileSync(copy, up ?? '');
    original.set(copy, path);
    return copy;
  });
  let ran: Ran;
  try {
    ran = await run('npx', ['--yes', SQUAWK, '--reporter', 'json', ...files], { env: toolEnv(), live: false });
  } finally {
    rmSync(copies, { recursive: true, force: true });
  }
  // squawk exits 1 when it finds anything; JSON on stdout either way. Anything else is a linter that did not run.
  const start = ran.out.indexOf('[');
  if (start < 0) {
    if (live) process.stderr.write(ran.out);
    const note = `squawk did not run (${tail(ran.out, 2) || `exit ${ran.code}`}): migrations not linted`;
    // A linter that did not run found nothing only because it looked at nothing: not a pass.
    return { findings: [], note, unlinted: `the added migrations were not linted: ${note}` };
  }
  const findings = parseSquawk(ran.out.slice(start, ran.out.lastIndexOf(']') + 1), (file) =>
    relative(top, original.get(file) ?? file)
      .split('\\')
      .join('/'),
  );
  return { findings };
}

interface Env {
  project: string;
  composeFile: string;
  planned: Plan;
  /** The compose service that runs the migration tool (`migrate-<dependency>`, profile `tools`). */
  tool: string;
}

function compose(env: Pick<Env, 'project' | 'composeFile'>, args: string[], live = false, cwd?: string): Promise<Ran> {
  return run('docker', ['compose', '-p', env.project, '-f', env.composeFile, ...args], { live, cwd });
}

/** Plans the base's environment, plus a `migrate` service on its sealed network that runs the migration tool. Exported for the tests. */
export async function planEnvironment(
  svc: ServiceConfig,
  cfg: MigrateConfig,
  projectRoot: string,
  dir: string,
  runId: string,
  reportsDir: string,
): Promise<Env> {
  const decl = svc.environment;
  if (!decl) throw new Error(`${svc.name} declares no environment`);
  // The host ports plan() asks for, as lifecycle.ts chooses them: free ones, per run.
  const keys = ['edge.api', 'app'];
  for (const [name, dep] of Object.entries(decl.dependencies)) {
    const kind = kindOf(dep.kind);
    for (const port of kind?.published ?? Object.keys(kind?.ports ?? {})) keys.push(`${name}.${port}`);
  }
  const ports = new Map<string, number>();
  for (const key of keys) ports.set(key, await freePort());
  const final = plan({
    service: `${svc.name}-mig`,
    runId,
    decl,
    hostPort: (key) => ports.get(key) ?? 0,
    subnet: `10.${64 + Math.floor(Math.random() * 64)}.${Math.floor(Math.random() * 256)}.0/24`,
    envDir: dir,
    projectRoot,
    // Labelled like a run of `<service>-mig`, so `vgate down --service <service>` removes what a killed check left.
    labels: runLabels(reportsDir, `${svc.name}-mig`),
  });
  const tool = final.migrations.find((m) => m.dependency === cfg.dependency);
  if (!tool) throw new Error(`migrate: no migrations planned for ${cfg.dependency}`);
  const composeFile = join(dir, 'compose.yaml');
  writeFileSync(composeFile, stringify(final.compose));
  writeFileSync(join(dir, 'edge.json'), JSON.stringify(final.edgeConfig, null, 2));
  writeFileSync(join(dir, 'Corefile'), final.corefile);
  return { project: final.project, composeFile, planned: final, tool: tool.service };
}

async function healthy(env: Env, name: string): Promise<boolean> {
  const dep = env.planned.dependencies.find((d) => d.name === name);
  if (!dep) return false;
  const health = dep.kind.health;
  const seconds = dep.kind.healthTimeout ?? 60;
  if ('exec' in health)
    return until(seconds, async () => (await compose(env, ['exec', '-T', name, ...health.exec])).code === 0);
  const port = 'http' in health ? dep.hostPorts[health.http.port] : dep.hostPorts[health.tcp.port];
  if ('http' in health)
    return until(
      seconds,
      async () =>
        (await fetch(`http://127.0.0.1:${port}${health.http.path}`, { signal: AbortSignal.timeout(3000) })).ok,
    );
  return until(seconds, () => tcpOk(port));
}

/** Runs a dependency's setup commands (all, or from index `from`), each retried while the server finishes starting. */
async function setup(env: Env, name: string, from = 0, to?: number): Promise<string | undefined> {
  const dep = env.planned.dependencies.find((d) => d.name === name);
  const commands = (dep?.kind.setup?.(dep.ctx) ?? []).slice(from, to);
  for (const command of commands) {
    let last = '';
    const ok = await until(dep?.kind.healthTimeout ?? 60, async () => {
      const ran = await compose(env, ['exec', '-T', name, ...command]);
      last = ran.out;
      return ran.code === 0;
    });
    if (!ok) return `${command.join(' ')}: ${tail(last, 4)}`;
  }
  return undefined;
}

function migrate(env: Env, cfg: MigrateConfig, dir: string, command: string, live: boolean): Promise<Ran> {
  return runMigration(env, { service: env.tool, config: { ...cfg, dir } }, command, live);
}

async function timed(
  name: MigrationStep['name'],
  action: () => Promise<{ ok: boolean; detail: string }>,
): Promise<MigrationStep> {
  const started = Date.now();
  const { ok, detail } = await action();
  return { name, status: ok ? 'pass' : 'fail', durationMs: Date.now() - started, detail };
}

export interface MigrationsOptions {
  service: string;
  base: string | undefined;
  env: string;
  live: boolean;
}

export async function migrations(
  project: ProjectConfig,
  runtime: Runtime,
  options: MigrationsOptions,
): Promise<Result> {
  const started = Date.now();
  const outFile = join(project.reportsDir, MIGRATIONS_FILE);
  rmSync(outFile, { force: true });
  const change = changeSet(project, options.base);
  if ('result' in change) return { ...change.result, command: 'migrations' };
  const commit = treeState(project);

  let head: ServiceConfig;
  try {
    head = loadService(options.service, options.env, project.root);
  } catch (error) {
    return notReady(options.service, (error as Error).message);
  }
  let configs: MigrateConfig[];
  try {
    // The real root, as changeSet measures `top` (so relative paths are right on systems where /var is a link).
    configs = migrateConfigs(head.environment, realpathSync(project.root));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const report: MigrationsReport = {
    schema: 'vgate.migrations/1',
    service: options.service,
    base: change.base,
    mergeBase: change.mergeBase,
    commit,
    verdict: 'not-configured',
    reasons: [],
    dirs: configs.map((c) => relative(change.top, c.dir).split('\\').join('/')),
    added: [],
    lint: [],
    steps: [],
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
  };
  const finish = (): Result => {
    report.durationMs = Date.now() - started;
    writeSignedOrPlainJson(outFile, report);
    return toResult(report, relative(process.cwd(), outFile) || outFile);
  };
  if (configs.length === 0) {
    report.reasons = [`${options.service} declares no migrations (environment.dependencies.<db>.migrate)`];
    return finish();
  }
  if (configs.length > 1)
    throw new UsageError('one migrating dependency per service is supported (more: open an issue)');
  const cfg = configs[0];

  // The merge base, checked out on its own: its migrations, its app (the deployed code), its tests.
  const worktree = mkdtempSync(join(tmpdir(), 'vgate-migrations-base-'));
  rmSync(worktree, { recursive: true, force: true });
  const added = git(change.top, ['worktree', 'add', '--detach', '--quiet', worktree, change.mergeBase]);
  if (added.code !== 0) return notReady(options.service, `could not check out the merge base: ${added.err.trim()}`);
  const runId = randomBytes(3).toString('hex');
  const envDir = mkdtempSync(join(tmpdir(), 'vgate-migrations-env-'));
  let env: Env | undefined;
  try {
    const baseRoot = join(worktree, change.prefix);
    let base: ServiceConfig | undefined;
    let baseCfg: MigrateConfig | undefined;
    if (existsSync(join(baseRoot, 'vgate.yaml')) || existsSync(join(baseRoot, 'framework', 'config.ts'))) {
      try {
        base = loadService(options.service, options.env, baseRoot);
        baseCfg = migrateConfigs(base.environment, baseRoot).find((c) => c.dependency === cfg.dependency);
      } catch {
        base = undefined; // the service did not exist (or had no environment) at the base: nothing is deployed
      }
    }
    // Where the base keeps the migrations: its own `migrate:`, else the same directory at the base. Migrations often
    // exist, and are deployed, before a vgate service declares them; they are then the base's, not this change's.
    let baseMig = baseCfg;
    if (!baseMig) {
      const rel = relative(change.top, cfg.dir);
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) baseMig = { ...cfg, dir: join(worktree, rel) };
    }
    const baseFiles = baseMig ? migrationFiles(baseMig) : [];
    const headFiles = migrationFiles(cfg);
    const baseForward = baseFiles.filter((f) => !isUndoFile(f));
    report.added = addedMigrations(baseFiles, headFiles);
    const changed = baseMig
      ? editedMigrations(baseFiles, headFiles, (f) =>
          readFileSync(join(baseMig.dir, f)).equals(readFileSync(join(cfg.dir, f))),
        )
      : { edited: [], removed: [] };
    // The base does not declare the service: nothing of it is deployed that vgate could start on the new schema.
    const newAtBase = base?.environment
      ? undefined
      : baseForward.length > 0
        ? `${options.service} is new at ${change.base}: the ${baseForward.length} migrations in ${report.dirs[0]} are already there`
        : `${options.service} is new at ${change.base}: nothing is deployed`;
    const unverified = [
      ...changed.edited.map(
        (f) => `${f} is edited, but the deployed databases already applied it and will not run it again`,
      ),
      ...changed.removed.map((f) => `${f} is removed, but the deployed databases already applied it`),
    ];
    if (report.added.length === 0) {
      report.verdict = unverified.length > 0 ? 'needs-approval' : 'safe';
      report.reasons =
        unverified.length > 0 ? unverified : ['this change adds no migration', ...(newAtBase ? [newAtBase] : [])];
      return finish();
    }

    const linted = await lint(cfg, report.added, change.top, options.live);
    report.lint = linted.findings;
    report.lintNote = linted.note;
    if (linted.unlinted) unverified.push(linted.unlinted);

    // The environment is the base's when the service existed there (its app is the deployed code), else this change's.
    const envSvc = base?.environment ? base : head;
    env = await planEnvironment(
      envSvc,
      cfg,
      envSvc === base ? baseRoot : project.root,
      envDir,
      runId,
      project.reportsDir,
    );
    const deps = Object.keys(envSvc.environment?.dependencies ?? {});
    const up = await compose(env, ['up', '-d', '--remove-orphans', 'dns', 'edge', ...deps], options.live);
    if (up.code !== 0) return notReady(options.service, `the environment did not start:\n${tail(up.out)}`);
    for (const dep of deps) {
      if (!(await healthy(env, dep))) return notReady(options.service, `${dep} did not become healthy`);
      // The migrating database only gets its readiness check now; its seed runs after the base's migrations.
      const problem = dep === cfg.dependency ? await setup(env, dep, 0, 1) : await setup(env, dep);
      if (problem) return notReady(options.service, `${dep} setup failed: ${problem}`);
    }

    const steps = report.steps;
    const current = env;
    if (baseMig && baseForward.length > 0)
      steps.push(
        await timed('apply-base', async () => {
          const ran = await migrate(current, baseMig, baseMig.dir, baseMig.command, options.live);
          return {
            ok: ran.code === 0,
            detail: ran.code === 0 ? `${baseForward.length} migrations` : tail(ran.out),
          };
        }),
      );
    else steps.push({ name: 'apply-base', status: 'skipped', durationMs: 0, detail: 'no migrations at the base' });
    const seed = () =>
      timed('seed', async () => {
        const problem = await setup(current, cfg.dependency, 1);
        return { ok: problem === undefined, detail: problem ?? 'seed loaded (or none declared)' };
      });
    const applyChange = () =>
      timed('apply-change', async () => {
        const ran = await migrate(current, cfg, cfg.dir, cfg.command, options.live);
        return {
          ok: ran.code === 0,
          detail: ran.code === 0 ? `${report.added.length} added: ${report.added.join(', ')}` : tail(ran.out),
        };
      });
    for (const name of applyOrder(!base?.environment))
      if (steps.every((s) => s.status !== 'fail')) steps.push(await (name === 'seed' ? seed() : applyChange()));
    const applied = steps.every((s) => s.status !== 'fail');
    if (applied && cfg.down) {
      const down = cfg.down;
      steps.push(
        await timed('round-trip', async () => {
          for (let i = 0; i < report.added.length; i++) {
            const ran = await migrate(current, cfg, cfg.dir, down, options.live);
            if (ran.code !== 0)
              return { ok: false, detail: `down ${i + 1} of ${report.added.length}: ${tail(ran.out)}` };
          }
          const again = await migrate(current, cfg, cfg.dir, cfg.command, options.live);
          return {
            ok: again.code === 0,
            detail: again.code === 0 ? 'undone and re-applied' : `re-apply: ${tail(again.out)}`,
          };
        }),
      );
    } else if (applied)
      steps.push({ name: 'round-trip', status: 'skipped', durationMs: 0, detail: 'no `down` configured' });

    if (applied && base?.environment) {
      if (!env.planned.appInside)
        steps.push({
          name: 'old-code',
          status: 'skipped',
          durationMs: 0,
          detail: 'the deployed app runs as a host command, not a container: not started against the new schema',
        });
      else {
        // The base's smoke filter: the deployed version's own checks, which this change cannot narrow.
        const smoke = baseCfg?.smoke ?? cfg.smoke;
        steps.push(await oldCode(project, runtime, base, baseRoot, current, { ...cfg, smoke }, options, report));
        if (report.oldCode?.total === 0)
          unverified.push(
            `no test of the deployed version matches the smoke filter "${smoke}": only its health was checked on the migrated schema`,
          );
      }
    } else if (applied) {
      steps.push({ name: 'old-code', status: 'skipped', durationMs: 0, detail: newAtBase ?? 'nothing is deployed' });
      // Migrations at the base mean a deployed schema, and code running on it that no check started: a person decides.
      if (baseForward.length > 0)
        unverified.push(
          `${options.service} is not declared at ${change.base}, so the deployed code was not started on the migrated schema (the ${baseForward.length} migrations there were applied first)`,
        );
    }

    const judged = migrationsVerdict(steps, report.lint, unverified);
    report.verdict = judged.verdict;
    // Safe and new (migrations at the base would have asked a person): say so, so the verdict is not read as more
    // than it is.
    report.reasons =
      judged.verdict === 'safe' && newAtBase
        ? [`${newAtBase}; its ${report.added.length} migration(s) were checked on an empty database`]
        : judged.reasons;
    return finish();
  } catch (error) {
    return notReady(options.service, (error as Error).message);
  } finally {
    if (env)
      await compose(env, [
        '--profile',
        'tools',
        'down',
        '--volumes',
        '--remove-orphans',
        '--rmi',
        'local',
        '--timeout',
        '5',
      ]);
    rmSync(envDir, { recursive: true, force: true });
    git(change.top, ['worktree', 'remove', '--force', worktree]);
    rmSync(worktree, { recursive: true, force: true });
  }
}

/** The deployed code (the base's app) on the migrated database, checked by the base's own read-only tests. */
async function oldCode(
  project: ProjectConfig,
  runtime: Runtime,
  base: ServiceConfig,
  baseRoot: string,
  env: Env,
  cfg: MigrateConfig,
  options: MigrationsOptions,
  report: MigrationsReport,
): Promise<MigrationStep> {
  const started = Date.now();
  const step = (ok: boolean, detail: string): MigrationStep => ({
    name: 'old-code',
    status: ok ? 'pass' : 'fail',
    durationMs: Date.now() - started,
    detail,
  });
  if (base.environment?.app.build) {
    const built = await compose(env, ['build', 'app'], options.live);
    if (built.code !== 0) return step(false, `the deployed app did not build: ${tail(built.out, 6)}`);
  }
  const app = await compose(env, ['up', '-d', '--no-deps', 'app'], options.live);
  if (app.code !== 0) return step(false, `the deployed app did not start: ${tail(app.out, 6)}`);
  const up = await until(
    120,
    async () => (await fetch(env.planned.appHealthUrl, { signal: AbortSignal.timeout(3000) })).ok,
  );
  if (!up) {
    const logs = await compose(env, ['logs', '--no-color', '--tail', '20', 'app']);
    return step(false, `the deployed app is not healthy on the migrated schema: ${tail(logs.out, 6)}`);
  }

  // The base's tests read their endpoints from the environment's state, as in any run.
  const baseProject = readProject(baseRoot);
  const state: EnvState = {
    schema: 'vgate.env/1',
    service: base.name,
    runId: env.project,
    project: env.project,
    composeFile: env.composeFile,
    sealed: env.planned.sealed,
    appInside: true,
    external: env.planned.external,
    published: env.planned.published,
    addresses: {},
    startedAt: new Date().toISOString(),
  };
  mkdirSync(join(baseProject.reportsDir, 'env'), { recursive: true });
  writeFileSync(statePath(baseProject.reportsDir, base.name), JSON.stringify(state, null, 2));
  const ready = prepare(baseProject, runtime, options.live);
  if (!ready.ok) return step(false, `the base's tests could not be prepared: ${ready.error ?? ''}`);
  const bin = join(runtime.root, 'node_modules', '.bin', 'playwright');
  const ran = await run(
    bin,
    [
      'test',
      '--config',
      join(runtime.root, 'playwright.config.ts'),
      '--project',
      'api',
      '--grep',
      cfg.smoke,
      '--pass-with-no-tests',
    ],
    {
      cwd: runtime.root,
      env: {
        ...toolEnv(),
        ...stepEnv(baseProject, runtime),
        SERVICE: base.name,
        TEST_ENV: options.env,
        PW_SUITE: 'api',
        RUN_ID: randomBytes(3).toString('hex'),
      },
      live: options.live,
    },
  );
  const junit = join(baseProject.reportsDir, 'junit', 'playwright-api.xml');
  const summary = existsSync(junit) ? mergeSummaries([parseJunit(readFileSync(junit, 'utf8'))]) : undefined;
  report.oldCode = summary
    ? { total: summary.total, failed: summary.failed, failures: summary.failures.slice(0, 10) }
    : undefined;
  if (!summary) return step(false, `the base's tests did not run: ${tail(ran.out, 6)}`);
  if (summary.total === 0)
    return step(true, `no base test matches the smoke filter "${cfg.smoke}": only health was checked`);
  if (ran.code !== 0 || summary.failed > 0) {
    const first = summary.failures[0];
    return step(
      false,
      `${summary.failed} of ${summary.total} of the deployed version's read-only tests fail${first ? `, e.g. ${first.id ?? first.title}: ${first.message}` : ''}`,
    );
  }
  return step(true, `${summary.total} of the deployed version's read-only tests pass on the migrated schema`);
}

function notReady(service: string, why: string): Result {
  return {
    command: 'migrations',
    ok: false,
    exitCode: EXIT.notReady,
    summary: `Migrations of ${service} not checked: ${why}`,
    next: [`${CLI} doctor --service ${service}`],
  };
}

function toResult(report: MigrationsReport, file: string): Result {
  const ok = report.verdict === 'safe' || report.verdict === 'not-configured';
  const label = {
    safe: 'MIGRATIONS SAFE',
    'needs-approval': 'MIGRATIONS NEED A HUMAN',
    blocked: 'MIGRATIONS BLOCKED',
    'not-configured': 'MIGRATIONS NOT CONFIGURED',
  }[report.verdict];
  const text = [
    ...report.steps.map(
      (s) => `${s.status.padEnd(7)} ${s.name.padEnd(12)} ${(s.durationMs / 1000).toFixed(1)}s  ${s.detail}`,
    ),
    ...report.lint.map(
      (f) => `${f.level === 'risky' ? 'RISKY ' : 'info  '} ${f.file}:${f.line} ${f.message} (${f.rule})`,
    ),
    ...(report.lintNote ? [`note    ${report.lintNote}`] : []),
    ...report.reasons.map((r) => `- ${r}`),
    `Report: ${file}`,
  ];
  return {
    command: 'migrations',
    ok,
    exitCode: ok ? EXIT.ok : EXIT.failed,
    summary: `${label} ${report.service}: ${report.reasons[0] ?? `${report.added.length} added migration(s) checked`}`,
    data: report,
    next: report.verdict === 'needs-approval' ? ['a human reviews the risky migration findings'] : [],
    text,
  };
}

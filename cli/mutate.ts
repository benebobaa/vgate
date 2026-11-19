/**
 * `vgate mutate --service <s> --base <ref>`: do the tests catch bugs in the code this change touched? Coverage shows a
 * line ran; mutation shows a test would notice it going wrong. vgate plants one small bug at a time in the changed
 * lines (framework/mutate/operators.ts), rebuilds and restarts the app the way the service runs, and runs the service's
 * own tests against it: a test that fails catches (kills) the mutant; when every test still passes, it survived, and
 * the report says what scenario would have caught it.
 *
 * Everything happens in a scratch copy of the working tree (a git worktree at HEAD plus the uncommitted changes) with
 * its own environment: the user's tree, stack and reports are never touched. The run is time-boxed (`--timeout`) and
 * sampled (`--budget`); what did not run is reported, never counted.
 *
 * Writes <reports>/mutation.json (`vgate.mutation/1`, bound to the commit like a gate verdict), which `vgate decide`
 * reads when vgate.yaml sets `policy.mutationScore`. Exit 0 at or above the threshold (or nothing to mutate), 1 below
 * it (or unmeasured with a threshold set), 3 not ready (the stack or the unmutated tests do not run).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { loadService, parsePaths, type ServiceConfig } from '../framework/config.ts';
import { envDown, envUp, type EnvState } from '../framework/env/lifecycle.ts';
import { apply, candidates, hint, sample, type Candidate } from '../framework/mutate/operators.ts';
import {
  changedLines,
  count,
  isMutationSource,
  mutationVerdict,
  type MutantResult,
  type MutationCounts,
  type MutationVerdict,
} from '../framework/mutate/score.ts';
import { DEFAULT_MUTATION, readProject, type ProjectConfig } from '../framework/project.ts';
import { changeSet, serviceMigrationDirs, type ChangeSet } from './affected.ts';
import { treeState, type TreeState } from './commit.ts';
import { matchesGlob } from './glob.ts';
import { git } from './guard.ts';
import { parseJunit, type TestSummary } from './junit.ts';
import { CLI, EXIT, UsageError, type Result } from './output.ts';
import { prepare, stepEnv, toolEnv, type Runtime } from './runtime.ts';

export const MUTATION_FILE = 'mutation.json';

export type MutationHow = 'declared-rebuild' | 'declared-restart' | 'script-restart';

export interface MutationReport {
  schema: 'vgate.mutation/1';
  service: string;
  base: string;
  mergeBase: string;
  /** The tree the mutants were planted in (the user's, before the run): decide accepts the report only for it. */
  commit: TreeState;
  verdict: MutationVerdict;
  /** policy.mutationScore when set. */
  threshold?: number;
  counts: MutationCounts;
  sites: { files: string[]; lines: number; candidates: number };
  budget: number;
  timeoutMs: number;
  how?: MutationHow;
  baseline?: { total: number; failed: number; durationMs: number };
  mutants: MutantResult[];
  reasons: string[];
  startedAt: string;
  durationMs: number;
}

export interface MutateOptions {
  service: string;
  base: string | undefined;
  env: string;
  budget?: number;
  timeoutMs?: number;
  live: boolean;
}

/** `paths:` of a service.yaml, read without loading the service (no environment variables needed). */
export function servicePathsOf(project: ProjectConfig, name: string): string[] | undefined {
  const file = join(project.servicesDir, name, 'service.yaml');
  if (!existsSync(file)) return undefined;
  const raw = (parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  return parsePaths(raw.paths, `${name} service.yaml`);
}

/** The changed source files of a service (top-relative), as decide and mutate both see them. */
export function mutationSources(
  project: ProjectConfig,
  change: ChangeSet,
  svc: Pick<ServiceConfig, 'name' | 'paths'>,
): string[] {
  const servicesDir = `${change.prefix}${project.servicesDirName}/`;
  const own = `${servicesDir}${svc.name}/`;
  const migrationDirs = serviceMigrationDirs(project, change, svc.name);
  return change.files.filter(
    (file) =>
      existsSync(join(change.top, file)) &&
      // A symlink's target may lie outside the scratch copy (the user's own tree): a mutant would be written there.
      !lstatSync(join(change.top, file)).isSymbolicLink() &&
      (svc.paths === undefined || file.startsWith(own) || svc.paths.some((glob) => matchesGlob(file, glob))) &&
      isMutationSource(file, {
        servicesDir,
        service: svc.name,
        migrationDirs,
        declared: (f) => (svc.paths ?? []).some((glob) => matchesGlob(f, glob)),
      }),
  );
}

interface Ran {
  code: number | null;
  out: string;
  timedOut: boolean;
  durationMs: number;
}

/** Runs a program to the end (or kills its whole process group at `timeoutMs`), keeping its output. */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; live?: boolean } = {},
): Promise<Ran> {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    let timedOut = false;
    const take = (chunk: Buffer) => {
      out += chunk.toString();
      if (options.live) process.stderr.write(chunk);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            try {
              process.kill(-(child.pid ?? 0), 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }, options.timeoutMs);
    const finish = (code: number | null) => {
      if (timer) clearTimeout(timer);
      done({ code, out, timedOut, durationMs: Date.now() - started });
    };
    child.on('error', (error) => ((out += error.message), finish(null)));
    child.on('close', (code) => finish(code));
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function healthy(url: string, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(3000) })).ok) return true;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) return false;
    await sleep(1000);
  }
}

const tail = (text: string, lines = 6) =>
  text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(-lines)
    .join('\n');

/** A scratch copy of the working tree: a worktree at HEAD, the uncommitted changes, the untracked files. */
function scratchCopy(project: ProjectConfig, change: ChangeSet, service: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-mutate-'));
  rmSync(dir, { recursive: true, force: true });
  const added = git(change.top, ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD']);
  if (added.code !== 0) throw new Error(`could not create a scratch worktree: ${added.err.trim()}`);
  const diff = spawnSync('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], {
    cwd: change.top,
    maxBuffer: 1 << 28,
  });
  if (diff.status !== 0) throw new Error(`could not read the uncommitted changes: ${diff.stderr.toString()}`);
  if (diff.stdout.length > 0) {
    const applied = spawnSync('git', ['apply', '--binary', '--whitespace=nowarn', '-'], {
      cwd: dir,
      input: diff.stdout,
    });
    if (applied.status !== 0)
      throw new Error(`could not copy the uncommitted changes: ${applied.stderr.toString().trim()}`);
  }
  const reports = relative(change.top, join(realpathSync(project.root), relative(project.root, project.reportsDir)));
  const services = `${change.prefix}${project.servicesDirName}/`;
  const others = git(change.top, ['ls-files', '-z', '--others', '--exclude-standard']).out.split('\0');
  for (const file of others) {
    if (file === '' || file === reports || file.startsWith(`${reports}/`)) continue;
    // vgate's own links beside the services (to the runtime): the scratch copy gets its own from prepare().
    if (
      file.startsWith(services) &&
      /^(node_modules|tsconfig\.json|package\.json)(\/|$)/.test(file.slice(services.length))
    )
      continue;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(change.top, file), join(dir, file));
  }
  // The contract types the tests are typed against are generated, never committed: bring the service's along.
  const generated = join(project.servicesDir, service, 'generated');
  if (existsSync(generated))
    cpSync(generated, join(dir, change.prefix, project.servicesDirName, service, 'generated'), { recursive: true });
  return dir;
}

/** The running app, however the service starts: restartable with or without a mutant in place. */
interface Stack {
  how: MutationHow;
  healthUrl: string;
  /** Rebuilds and restarts with the code now in the scratch tree. `undefined`: up and healthy. */
  restart(): Promise<{ problem?: 'build' | 'start'; detail?: string }>;
  stop(): Promise<void>;
}

async function startStack(
  scratch: ProjectConfig,
  runtime: Runtime,
  service: string,
  env: string,
  live: boolean,
): Promise<Stack> {
  const svc = loadService(service, env, scratch.root);
  const reload = () => loadService(service, env, scratch.root);
  const healthOf = (s: ServiceConfig) => `${s.env.baseUrl}${s.env.healthPath ?? '/'}`;
  if (svc.environment) {
    const decl = svc.environment;
    const up = () => envUp({ service, decl, reportsDir: scratch.reportsDir, live: false, projectRoot: scratch.root });
    let state: EnvState = await up();
    const images = new Set<string>();
    const remember = async () => {
      if (!state.appImage) return;
      const id = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', state.appImage]);
      if (id.code === 0) images.add(id.out.trim());
    };
    await remember();
    const compose = (args: string[]) =>
      run('docker', ['compose', '-p', state.project, '-f', state.composeFile, ...args], { live: false });
    const rebuild = state.appInside && decl.app.build !== undefined;
    return {
      how: rebuild ? 'declared-rebuild' : 'declared-restart',
      healthUrl: healthOf(reload()),
      async restart() {
        if (rebuild) {
          const built = await compose(['build', 'app']);
          if (built.code !== 0) return { problem: 'build', detail: tail(built.out) };
          await remember();
          const started = await compose(['up', '-d', '--no-deps', '--force-recreate', 'app']);
          if (started.code !== 0) return { problem: 'start', detail: tail(started.out) };
        } else {
          try {
            state = await up();
          } catch (error) {
            return { problem: 'start', detail: tail((error as Error).message) };
          }
        }
        return (await healthy(healthOf(reload()), 60))
          ? {}
          : { problem: 'start', detail: 'the app did not become healthy' };
      },
      async stop() {
        await envDown(scratch.reportsDir, service);
        if (images.size > 0) await run('docker', ['image', 'rm', '--force', ...images]);
      },
    };
  }

  // A service started by its stack.sh: restarted the same way, in the scratch tree.
  const script = join(scratch.servicesDir, service, 'stack.sh');
  if (!existsSync(script)) throw new Error(`${service} declares no environment and has no stack.sh`);
  const ready = prepare(scratch, runtime, live);
  if (!ready.ok) throw new Error(ready.error ?? 'the vgate runtime is not ready');
  const stack = (action: 'up' | 'down') =>
    run('bash', [script, action], {
      cwd: scratch.root,
      env: { ...toolEnv(), ...stepEnv(scratch, runtime), SERVICE: service, TEST_ENV: env },
      timeoutMs: 180_000,
    });
  const first = await stack('up');
  if (first.code !== 0) throw new Error(`${service} did not start in the scratch copy:\n${tail(first.out, 12)}`);
  return {
    how: 'script-restart',
    healthUrl: healthOf(svc),
    async restart() {
      await stack('down');
      const again = await stack('up');
      if (again.code !== 0) return { problem: 'start', detail: tail(again.out) };
      return (await healthy(healthOf(svc), 60)) ? {} : { problem: 'start', detail: 'the app did not become healthy' };
    },
    async stop() {
      await stack('down');
    },
  };
}

interface TestRun {
  summary?: TestSummary;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  out: string;
}

/** The service's API tests (not the fault tests, which pause containers) against the running scratch app. */
async function runTests(
  scratch: ProjectConfig,
  runtime: Runtime,
  service: string,
  env: string,
  options: { stopAtFirstFailure: boolean; timeoutMs?: number },
): Promise<TestRun> {
  const junit = join(scratch.reportsDir, 'junit', 'playwright-api.xml');
  rmSync(junit, { force: true });
  const ran = await run(
    join(runtime.root, 'node_modules', '.bin', 'playwright'),
    [
      'test',
      '--config',
      join(runtime.root, 'playwright.config.ts'),
      '--project',
      'api',
      '--pass-with-no-tests',
      ...(options.stopAtFirstFailure ? ['--max-failures', '1'] : []),
    ],
    {
      cwd: runtime.root,
      env: {
        ...toolEnv(),
        ...stepEnv(scratch, runtime),
        SERVICE: service,
        TEST_ENV: env,
        PW_SUITE: 'api',
        RUN_ID: randomBytes(3).toString('hex'),
      },
      timeoutMs: options.timeoutMs,
    },
  );
  const summary = existsSync(junit) ? parseJunit(readFileSync(junit, 'utf8')) : undefined;
  return { summary, code: ran.code, timedOut: ran.timedOut, durationMs: ran.durationMs, out: ran.out };
}

/**
 * A test's identity is its file and full title: one scenario id can name several tests (a table of cases), and one of
 * them failing before the mutation must not hide another that the mutant breaks.
 */
const testKey = (f: { file: string; title: string }) => `${f.file}\0${f.title}`;
/** How a catching test is shown: its scenario id, with the case when the id names several. */
const testLabel = (f: { id?: string; title: string }) =>
  f.id ? `${f.id}: ${f.title.replace(/^.*?\]\s*/, '')}` : f.title;

/** The tests that fail now and passed on the unmutated code, as people read them. Pure; exported for the tests. */
export function newlyFailing(
  before: Array<{ file: string; title: string }>,
  now: Array<{ id?: string; file: string; title: string }>,
): string[] {
  const failingBefore = new Set(before.map(testKey));
  return now.filter((f) => !failingBefore.has(testKey(f))).map(testLabel);
}

export async function mutate(project: ProjectConfig, runtime: Runtime, options: MutateOptions): Promise<Result> {
  const started = Date.now();
  const settings = project.mutation ?? DEFAULT_MUTATION;
  const budget = options.budget ?? settings.budget;
  const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
  const outFile = join(project.reportsDir, MUTATION_FILE);
  rmSync(outFile, { force: true });
  const change = changeSet(project, options.base);
  if ('result' in change) return { ...change.result, command: 'mutate' };
  const commit = treeState(project);

  let svc: ServiceConfig;
  try {
    svc = loadService(options.service, options.env, project.root);
  } catch (error) {
    return notReady(options.service, (error as Error).message);
  }
  // Every mutant restarts the app and runs the tests, which write: never in a shared environment.
  if (!svc.env.disposable)
    throw new UsageError(
      `mutate restarts ${options.service} with planted bugs: environment ${options.env} is not disposable`,
    );

  // The mutation sites: the changed lines of the service's source files.
  const files = mutationSources(project, change, svc);
  const tracked =
    files.length > 0
      ? git(change.top, ['diff', '-U0', '--no-color', '--no-ext-diff', change.mergeBase, '--', ...files])
      : undefined;
  const lines = changedLines(tracked?.out ?? '');
  const untracked = new Set(
    git(change.top, ['ls-files', '--others', '--exclude-standard', '--', ...files])
      .out.split('\n')
      .filter(Boolean),
  );
  const all: Candidate[] = files.flatMap((file) => {
    const text = readFileSync(join(change.top, file), 'utf8');
    return candidates(file, text, untracked.has(file) ? 'all' : (lines.get(file) ?? new Set<number>()));
  });
  const lineCount = files.reduce(
    (n, f) =>
      n + (untracked.has(f) ? readFileSync(join(change.top, f), 'utf8').split('\n').length : (lines.get(f)?.size ?? 0)),
    0,
  );
  const picked = sample(all, budget);

  const report: MutationReport = {
    schema: 'vgate.mutation/1',
    service: options.service,
    base: change.base,
    mergeBase: change.mergeBase,
    commit,
    verdict: 'not-applicable',
    threshold: project.policy.mutationScore,
    counts: count([]),
    sites: { files, lines: lineCount, candidates: all.length },
    budget,
    timeoutMs,
    mutants: [],
    reasons: [],
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
  };
  const finish = (): Result => {
    report.counts = count(report.mutants);
    report.verdict = mutationVerdict(all.length, report.counts, report.threshold);
    report.reasons = reasonsFor(report);
    report.durationMs = Date.now() - started;
    mkdirSync(project.reportsDir, { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
    return toResult(report, relative(process.cwd(), outFile) || outFile);
  };
  if (picked.length === 0) return finish();

  const progress = (line: string) => options.live && process.stderr.write(`${line}\n`);
  let dir: string | undefined;
  let stack: Stack | undefined;
  try {
    dir = scratchCopy(project, change, options.service);
    const scratch = readProject(join(dir, change.prefix));
    const ready = prepare(scratch, runtime, options.live);
    if (!ready.ok) return notReady(options.service, ready.error ?? 'the vgate runtime is not ready');
    progress(
      `mutate ${options.service}: ${picked.length} of ${all.length} mutants on ${lineCount} changed lines; starting the app`,
    );
    stack = await startStack(scratch, runtime, options.service, options.env, options.live);
    report.how = stack.how;

    // The unmutated code first: a mutant is caught only by a test that passes without it.
    const baseline = await runTests(scratch, runtime, options.service, options.env, { stopAtFirstFailure: false });
    if (!baseline.summary || baseline.summary.total === 0)
      return notReady(options.service, `the tests did not run on the unmutated code:\n${tail(baseline.out, 8)}`);
    const failingBefore = baseline.summary.failures;
    report.baseline = {
      total: baseline.summary.total,
      failed: baseline.summary.failed,
      durationMs: baseline.durationMs,
    };
    progress(
      `baseline: ${baseline.summary.total} tests, ${baseline.summary.failed} failing (${(baseline.durationMs / 1000).toFixed(1)}s)`,
    );
    const perMutant = Math.max(60_000, baseline.durationMs * 3 + 30_000);
    let broken: string | undefined;

    for (const [index, c] of picked.entries()) {
      if (Date.now() - started > timeoutMs || broken) {
        report.mutants.push({
          ...c,
          status: 'not-run',
          durationMs: 0,
          detail: broken ?? 'the run reached its time limit',
        });
        continue;
      }
      const at = Date.now();
      const path = join(dir, c.file);
      const original = readFileSync(path, 'utf8');
      let result: MutantResult;
      try {
        writeFileSync(path, apply(original, c));
        const restarted = await stack.restart();
        if (restarted.problem === 'build')
          result = { ...c, status: 'build-error', durationMs: 0, detail: `did not build: ${restarted.detail ?? ''}` };
        else if (restarted.problem === 'start') {
          // Caught only when the mutant is why: the unmutated app must come up again in its place.
          let unmutatedStarts: boolean | undefined;
          if (stack.how === 'declared-rebuild') {
            writeFileSync(path, original);
            unmutatedStarts = !(await stack.restart()).problem;
          }
          result = { ...c, ...notStarted(stack.how, unmutatedStarts, restarted.detail), durationMs: 0 };
          if (unmutatedStarts === false) broken = 'the app no longer starts, even without a mutant';
        } else {
          const tests = await runTests(scratch, runtime, options.service, options.env, {
            stopAtFirstFailure: failingBefore.length === 0,
            timeoutMs: perMutant,
          });
          const caught = newlyFailing(failingBefore, tests.summary?.failures ?? []);
          if (tests.timedOut)
            result = {
              ...c,
              status: 'timeout',
              durationMs: 0,
              detail: `the tests ran past ${Math.round(perMutant / 1000)}s`,
            };
          else if (caught.length > 0) result = { ...c, status: 'killed', killedBy: caught.slice(0, 5), durationMs: 0 };
          else if (!tests.summary)
            result = {
              ...c,
              status: 'build-error',
              durationMs: 0,
              detail: `the tests did not run: ${tail(tests.out, 4)}`,
            };
          else result = { ...c, status: 'survived', durationMs: 0, hint: hint(c) };
        }
      } finally {
        writeFileSync(path, original);
      }
      result.durationMs = Date.now() - at;
      report.mutants.push(result);
      progress(
        `[${index + 1}/${picked.length}] ${c.file}:${c.line} ${c.operator} \`${c.original}\` -> \`${c.replacement}\`: ${result.status} (${(result.durationMs / 1000).toFixed(1)}s)`,
      );
    }
    return finish();
  } catch (error) {
    return notReady(options.service, (error as Error).message);
  } finally {
    if (stack) await stack.stop();
    if (dir) {
      git(change.top, ['worktree', 'remove', '--force', dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * A mutant whose app did not come up. Caught (any test would notice) only where a build failure is told apart from a
 * crash, and the unmutated app came up again in its place; otherwise it says nothing about the tests: with a stack.sh
 * or an app started without a build, a mutant that does not compile looks the same, and an environment that broke
 * would read as bugs caught. Pure.
 */
export function notStarted(
  how: MutationHow,
  unmutatedStarts: boolean | undefined,
  detail: string | undefined,
): Pick<MutantResult, 'status' | 'killedBy' | 'detail'> {
  if (how === 'declared-rebuild' && unmutatedStarts === true)
    return { status: 'killed', killedBy: ['(the app did not start)'], detail };
  if (unmutatedStarts === false)
    return { status: 'not-run', detail: `the app did not start, nor without the mutant: ${detail ?? ''}`.trim() };
  return {
    status: 'build-error',
    detail: `the app did not start (a build failure cannot be told from a crash here): ${detail ?? ''}`.trim(),
  };
}

/** Why the verdict is what it is, in words: the PR comment and the CLI share these. */
export function reasonsFor(
  report: Pick<MutationReport, 'verdict' | 'counts' | 'threshold' | 'sites' | 'service'>,
): string[] {
  const { counts } = report;
  const pct = (n: number | null) => (n === null ? '-' : `${Math.round(n * 100)}%`);
  const caught = `the tests caught ${counts.killed} of ${counts.killed + counts.survived} planted bugs in the changed code (${pct(counts.score)})`;
  const extra = [
    counts.timeout > 0 ? `${counts.timeout} timed out` : '',
    counts.buildError > 0 ? `${counts.buildError} did not build` : '',
    counts.notRun > 0 ? `${counts.notRun} not run (time limit)` : '',
  ].filter(Boolean);
  const more = extra.length > 0 ? `; ${extra.join(', ')}` : '';
  switch (report.verdict) {
    case 'not-applicable':
      return [
        report.sites.files.length === 0
          ? `${report.service}: the change touches no source code vgate mutates`
          : `${report.service}: the changed lines hold nothing to mutate`,
      ];
    case 'unmeasured':
      return [`${report.service}: no planted bug could be judged${more}`];
    case 'below':
      return [`${report.service}: ${caught}, below policy.mutationScore ${pct(report.threshold ?? null)}${more}`];
    default:
      return [`${report.service}: ${caught}${more}`];
  }
}

function notReady(service: string, why: string): Result {
  return {
    command: 'mutate',
    ok: false,
    exitCode: EXIT.notReady,
    summary: `Mutation of ${service} not measured: ${why.split('\n')[0]}`,
    data: { service, error: why },
    next: [`${CLI} doctor --service ${service}`],
  };
}

function toResult(report: MutationReport, file: string): Result {
  const failing = report.verdict === 'below' || (report.verdict === 'unmeasured' && report.threshold !== undefined);
  const label = {
    pass: 'MUTATION OK',
    below: 'MUTATION BELOW POLICY',
    unmeasured: 'MUTATION UNMEASURED',
    'not-applicable': 'MUTATION NOT APPLICABLE',
  }[report.verdict];
  const survivors = report.mutants.filter((m) => m.status === 'survived');
  const text = [
    ...report.mutants.map(
      (m) =>
        `${m.status.padEnd(11)} ${m.file}:${m.line} ${m.operator.padEnd(13)} ${m.before}  ->  ${m.after}${m.killedBy ? `  [${m.killedBy.join(', ')}]` : ''}`,
    ),
    ...survivors.map((m) => `HINT ${m.hint ?? ''}`),
    `Report: ${file}`,
  ];
  return {
    command: 'mutate',
    ok: !failing,
    exitCode: failing ? EXIT.failed : EXIT.ok,
    summary: `${label} ${report.reasons[0] ?? report.service}`,
    data: report,
    next: survivors.length > 0 ? ['add the scenarios the survivors point at, then run mutate again'] : [],
    text,
  };
}

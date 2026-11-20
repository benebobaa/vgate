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
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { writeSignedOrPlainJson } from '../packages/verification/signing.ts';
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
import { operationsFor, planOperations, testsFor, type PlanOperation } from '../framework/mutate/select.ts';
import { DEFAULT_MUTATION, readProject, type ProjectConfig } from '../framework/project.ts';
import { changeSet, serviceMigrationDirs, type ChangeSet } from './affected.ts';
import { treeState, type TreeState } from './commit.ts';
import { matchesGlob } from './glob.ts';
import { git } from './guard.ts';
import { parseJunit, testcases, type TestFailure, type TestSummary } from './junit.ts';
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
  /** Mutants first run against only the tests of the operations their line serves, and how many those caught. */
  selection?: { scoped: number; caughtByScope: number };
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
  /** Run the whole suite for every mutant, never only the tests of the operations its line serves. */
  allTests?: boolean;
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

/** The process groups this run started and that are still running: an interrupt stops them before cleaning up. */
const children = new Set<number>();

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
    if (child.pid !== undefined) children.add(child.pid);
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
      if (child.pid !== undefined) children.delete(child.pid);
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

/**
 * What a run leaves on disk while it works, so that one stopped hard (SIGKILL, a crash, a closed terminal) can be
 * cleaned up by the next `vgate mutate` or `vgate down --service <s>`: the scratch worktree and the reports dir its
 * environment and images are labelled with.
 */
interface RunMarker {
  schema: 'vgate.mutate-run/1';
  pid: number;
  service: string;
  scratch: string;
  scratchReports: string;
  gitTop: string;
  startedAt: string;
}

const markerPath = (project: ProjectConfig, service: string) =>
  join(project.reportsDir, 'mutate', `${service}.run.json`);

function readMarker(project: ProjectConfig, service: string): RunMarker | undefined {
  try {
    const marker = JSON.parse(readFileSync(markerPath(project, service), 'utf8')) as RunMarker;
    return marker.schema === 'vgate.mutate-run/1' ? marker : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** When a process started (ms), from `ps`; undefined when that cannot be told. */
function startTime(pid: number): number | undefined {
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  const at = ps.status === 0 ? Date.parse(ps.stdout.trim()) : NaN;
  return Number.isNaN(at) ? undefined : at;
}

/**
 * Is `pid` still the process a marker recorded? A pid is reused once its process is gone (a reboot, days later): the
 * run's own process started before its marker was written, an app it started after. `ps` shows whole seconds.
 */
function sameProcess(pid: number, marker: RunMarker, role: 'run' | 'app'): boolean {
  if (!alive(pid)) return false;
  const started = startTime(pid);
  const written = Date.parse(marker.startedAt);
  if (started === undefined || Number.isNaN(written)) return role === 'run'; // unknown: never kill, never sweep a run
  return role === 'run' ? started <= written + 1000 : started >= written - 1000;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export interface Sweep {
  /** What was removed, in words; empty when nothing was left. */
  removed: string[];
  /** Another `vgate mutate` of the service is running (its pid): its scratch copy was left alone. */
  busy?: number;
}

/**
 * Removes what an earlier `vgate mutate` of the service left behind: its sealed environment and app images (found by
 * the labels of its scratch reports dir), a host app it started, its scratch worktree, and the marker. A run still
 * alive is left alone. `self`: the pid of the run calling it, whose own marker is never "busy".
 */
export async function sweepMutate(project: ProjectConfig, service: string, self?: number): Promise<Sweep> {
  const marker = readMarker(project, service);
  if (!marker) return { removed: [] };
  if (marker.pid !== self && sameProcess(marker.pid, marker, 'run')) return { removed: [], busy: marker.pid };
  const removed: string[] = [];
  if (await envDown(marker.scratchReports, service)) removed.push('its sealed environment');
  // A host app its stack.sh started (lib.sh keeps the pid of each app it starts).
  const pids = join(marker.scratchReports, 'stack');
  if (existsSync(pids))
    for (const file of readdirSync(pids).filter((f) => f.endsWith('.pid'))) {
      const pid = Number(readFileSync(join(pids, file), 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && sameProcess(pid, marker, 'app')) {
        killGroup(pid, 'SIGTERM');
        removed.push(`a host app (pid ${pid})`);
      }
    }
  // Images built for mutants carry the run's labels, tagged, untagged or intermediate (`--all`): a child goes before
  // its parent, so what a first pass cannot remove goes on a second.
  const labelled = async () => {
    const listed = await run('docker', [
      'images',
      '--all',
      '--quiet',
      '--filter',
      `label=dev.vgate.reports=${resolve(marker.scratchReports)}`,
    ]);
    return listed.code === 0
      ? [
          ...new Set(
            listed.out
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean),
          ),
        ]
      : [];
  };
  const ids = await labelled();
  if (ids.length > 0) {
    await run('docker', ['image', 'rm', '--force', ...ids]);
    const left = await labelled();
    if (left.length > 0) await run('docker', ['image', 'rm', '--force', ...left]);
    removed.push(`${ids.length} mutant image(s)`);
  }
  if (existsSync(marker.scratch)) {
    git(marker.gitTop, ['worktree', 'remove', '--force', marker.scratch]);
    rmSync(marker.scratch, { recursive: true, force: true });
    removed.push('its scratch worktree');
  }
  git(marker.gitTop, ['worktree', 'prune']);
  rmSync(markerPath(project, service), { force: true });
  return { removed };
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
  /** Every test case that ran (file and full title). */
  cases: Array<{ file: string; title: string }>;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  out: string;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Playwright filters for exactly these tests: their files (anchored) and their own titles (the last part of the
 * report's title). Exported for the tests.
 */
export function filtersFor(tests: Array<{ file: string; title: string }>): string[] {
  const files = [...new Set(tests.map((t) => t.file))].map((f) => `${escapeRegex(f)}$`);
  const titles = [...new Set(tests.map((t) => t.title.split(' › ').pop() ?? t.title))].map(escapeRegex);
  return [...files, '--grep', titles.join('|')];
}

/** The service's API tests (not the fault tests, which pause containers) against the running scratch app. */
async function runTests(
  scratch: ProjectConfig,
  runtime: Runtime,
  service: string,
  env: string,
  options: { stopAtFirstFailure: boolean; timeoutMs?: number; only?: Array<{ file: string; title: string }> },
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
      ...(options.only ? filtersFor(options.only) : []),
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
  const xml = existsSync(junit) ? readFileSync(junit, 'utf8') : undefined;
  const summary = xml === undefined ? undefined : parseJunit(xml);
  const cases = xml === undefined ? [] : testcases(xml);
  return { summary, cases, code: ran.code, timedOut: ran.timedOut, durationMs: ran.durationMs, out: ran.out };
}

/**
 * A test's identity is its file and full title: one scenario id can name several tests (a table of cases), and one of
 * them failing before the mutation must not hide another that the mutant breaks.
 */
const testKey = (f: { file: string; title: string }) => `${f.file}\0${f.title}`;
/** How a catching test is shown: its scenario id, with the case when the id names several. */
const testLabel = (f: { id?: string; title: string }) =>
  f.id ? `${f.id}: ${f.title.replace(/^.*?\]\s*/, '')}` : f.title;

/** The tests that fail now and passed on the unmutated code. Pure; exported for the tests. */
export function newlyFailingTests<T extends { file: string; title: string }>(
  before: Array<{ file: string; title: string }>,
  now: T[],
): T[] {
  const failingBefore = new Set(before.map(testKey));
  return now.filter((f) => !failingBefore.has(testKey(f)));
}

/** The same, as people read them. */
export function newlyFailing(
  before: Array<{ file: string; title: string }>,
  now: Array<{ id?: string; file: string; title: string }>,
): string[] {
  return newlyFailingTests(before, now).map(testLabel);
}

/**
 * Whose failure the mutant caused: the tests that failed with it, failed again with it, and passed on the unmutated
 * code. The rest failed for another reason (a flaky test, the environment) and catch nothing. Pure; exported for
 * the tests.
 */
export function confirmedKillers<T extends { file: string; title: string }>(
  caught: T[],
  again: Array<{ file: string; title: string }>,
  onOriginal: Array<{ file: string; title: string }>,
): { killers: T[]; flaky: T[] } {
  const failedAgain = new Set(again.map(testKey));
  const failOnOriginal = new Set(onOriginal.map(testKey));
  const killers = caught.filter((t) => failedAgain.has(testKey(t)) && !failOnOriginal.has(testKey(t)));
  return { killers, flaky: caught.filter((t) => !killers.includes(t)) };
}

type Tests = Array<{ file: string; title: string }>;

/** What judging one mutant needs: the tests against the app as it runs now, and swapping its code. */
export interface MutantTrial {
  /** Runs the tests (only those, when given) against the app as it runs now. */
  run(only?: Tests, stopAtFirstFailure?: boolean): Promise<TestRun>;
  /** Puts the unmutated code back and restarts the app; false when it did not come up. */
  original(): Promise<boolean>;
  /** Puts the mutant back and restarts the app; false when it did not come up. */
  mutant(): Promise<boolean>;
}

export interface MutantJudgement {
  result: Pick<MutantResult, 'status' | 'killedBy' | 'flakyTests' | 'detail'>;
  /** The scoped tests ran first, and whether they caught it. */
  scoped: boolean;
  caughtByScope: boolean;
  /** Set when the unmutated app stopped coming up: the run cannot go on. */
  broken?: string;
}

/**
 * Judges one mutant, the app already running with it: the scoped tests first (`subset`), the whole suite when they
 * miss, and a kill confirmed before it counts. A scoped catch that does not hold is no answer: the whole suite decides,
 * as for any mutant the scope missed. Exported for the tests.
 */
export async function judgeMutant(
  trial: MutantTrial,
  { subset, failingBefore, perMutant }: { subset?: Tests; failingBefore: Tests; perMutant: number },
): Promise<MutantJudgement> {
  const stop = failingBefore.length === 0;
  const judgement: MutantJudgement = {
    result: { status: 'survived' },
    scoped: subset !== undefined,
    caughtByScope: false,
  };
  const outcome = async (ran: TestRun, caught: TestFailure[]): Promise<MutantJudgement['result']> => {
    if (ran.timedOut) return { status: 'timeout', detail: `the tests ran past ${Math.round(perMutant / 1000)}s` };
    if (caught.length > 0) return confirm(caught);
    if (!ran.summary) return { status: 'build-error', detail: `the tests did not run: ${tail(ran.out, 4)}` };
    return { status: 'survived' };
  };
  const full = async () => {
    const ran = await trial.run(undefined, stop);
    return outcome(ran, newlyFailingTests(failingBefore, ran.summary?.failures ?? []));
  };

  /**
   * A kill holds only if it repeats: the failing tests fail again with the mutant, then pass with the unmutated code
   * (restored and restarted here; the next mutant restarts anyway). Both re-runs run the same tests, so that one test's
   * effect on another cannot pass for the mutant's.
   */
  async function confirm(caught: TestFailure[]): Promise<MutantJudgement['result']> {
    const again = await trial.run(caught, false);
    const reproduced = again.timedOut
      ? caught
      : caught.filter((f) => again.summary?.failures.some((g) => testKey(g) === testKey(f)));
    if (reproduced.length === 0)
      return {
        status: 'flaky',
        flakyTests: caught.map(testLabel),
        detail: 'the tests that failed with the mutant passed when run again with it',
      };
    if (!(await trial.original())) {
      judgement.broken = 'the app no longer starts, even without a mutant';
      return { status: 'not-run', detail: 'the unmutated app did not start again to confirm the kill' };
    }
    const onOriginal = await trial.run(caught, false);
    if (!onOriginal.summary) return { status: 'not-run', detail: 'the tests did not run on the unmutated app' };
    const { killers, flaky } = confirmedKillers(
      caught,
      again.timedOut ? caught : (again.summary?.failures ?? []),
      onOriginal.summary.failures,
    );
    if (killers.length === 0)
      return {
        status: 'flaky',
        flakyTests: flaky.map(testLabel),
        detail: 'the tests that failed with the mutant fail on the unmutated code too',
      };
    return {
      status: 'killed',
      killedBy: killers.map(testLabel).slice(0, 5),
      ...(flaky.length > 0 ? { flakyTests: flaky.map(testLabel) } : {}),
    };
  }

  if (!subset) {
    judgement.result = await full();
    return judgement;
  }
  const ran = await trial.run(subset, stop);
  const caught = newlyFailingTests(failingBefore, ran.summary?.failures ?? []);
  judgement.caughtByScope = caught.length > 0;
  judgement.result = caught.length === 0 && !ran.timedOut && ran.summary ? await full() : await outcome(ran, caught);
  if (judgement.caughtByScope && judgement.result.status === 'flaky' && !judgement.broken) {
    // The scoped tests failed for another reason (one may need a test outside the scope): the whole suite decides.
    if (!(await trial.mutant()))
      judgement.result = { status: 'not-run', detail: 'the mutant did not start again for the whole suite' };
    else judgement.result = await full();
  }
  return judgement;
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

  // What an earlier run stopped hard (SIGKILL, a crash) left behind goes first; a run still going is not disturbed.
  const leftovers = await sweepMutate(project, options.service, process.pid);
  if (leftovers.busy !== undefined)
    return notReady(options.service, `another vgate mutate of ${options.service} is running (pid ${leftovers.busy})`);
  if (leftovers.removed.length > 0 && options.live)
    process.stderr.write(`mutate: removed what an interrupted run left: ${leftovers.removed.join(', ')}\n`);

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
    writeSignedOrPlainJson(outFile, report);
    return toResult(report, relative(process.cwd(), outFile) || outFile);
  };
  if (picked.length === 0) return finish();

  const progress = (line: string) => options.live && process.stderr.write(`${line}\n`);
  let dir: string | undefined;
  let stack: Stack | undefined;
  let scratch: ProjectConfig | undefined;
  // Everything the run created goes, once, however it ends: done, failed, interrupted.
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      if (stack) await stack.stop().catch(() => undefined);
      if (scratch) await sweepMutate(project, options.service, process.pid).catch(() => undefined);
      if (dir) {
        git(change.top, ['worktree', 'remove', '--force', dir]);
        rmSync(dir, { recursive: true, force: true });
      }
      rmSync(markerPath(project, options.service), { force: true });
    })());
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = signal;
    process.stderr.write(`mutate: ${signal}: stopping and removing the scratch copy, its environment and images\n`);
    for (const pid of children) killGroup(pid, 'SIGTERM');
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    dir = scratchCopy(project, change, options.service);
    scratch = readProject(join(dir, change.prefix));
    mkdirSync(dirname(markerPath(project, options.service)), { recursive: true });
    const marker: RunMarker = {
      schema: 'vgate.mutate-run/1',
      pid: process.pid,
      service: options.service,
      scratch: dir,
      scratchReports: scratch.reportsDir,
      gitTop: change.top,
      startedAt: new Date(started).toISOString(),
    };
    writeFileSync(markerPath(project, options.service), `${JSON.stringify(marker, null, 2)}\n`);
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
    const plan = readPlan(scratch, options.service);
    const selection = { scoped: 0, caughtByScope: 0 };
    let broken: string | undefined;
    const tests = (only?: Array<{ file: string; title: string }>, stopAtFirstFailure = failingBefore.length === 0) =>
      runTests(scratch!, runtime, options.service, options.env, { stopAtFirstFailure, timeoutMs: perMutant, only });

    for (const [index, c] of picked.entries()) {
      if (interrupted) break;
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
      // The tests of the operations the line serves, when that is knowable: run first; the rest only if they miss.
      const scope = options.allTests ? undefined : operationsFor(c.file, original, c.line, plan);
      const scoped = scope ? testsFor(scope, baseline.cases) : [];
      const subset = scoped.length > 0 && scoped.length < baseline.cases.length ? scoped : undefined;
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
          const judged = await judgeMutant(
            {
              run: (only, stopAtFirstFailure) => tests(only, stopAtFirstFailure),
              original: async () => {
                writeFileSync(path, original);
                return !(await stack!.restart()).problem;
              },
              mutant: async () => {
                writeFileSync(path, apply(original, c));
                return !(await stack!.restart()).problem;
              },
            },
            { subset, failingBefore, perMutant },
          );
          if (judged.scoped) selection.scoped++;
          if (judged.caughtByScope) selection.caughtByScope++;
          if (judged.broken) broken = judged.broken;
          result = {
            ...c,
            ...judged.result,
            ...(judged.result.status === 'survived' ? { hint: hint(c) } : {}),
            durationMs: 0,
          };
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
    report.selection = selection;
    return finish();
  } catch (error) {
    return notReady(options.service, (error as Error).message);
  } finally {
    await cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/** The plan's operations and scenario ids (inventory.yaml), or none: then every mutant runs the whole suite. */
function readPlan(project: ProjectConfig, service: string): PlanOperation[] {
  const file = join(project.servicesDir, service, 'inventory.yaml');
  if (!existsSync(file)) return [];
  try {
    return planOperations(parse(readFileSync(file, 'utf8')));
  } catch {
    return [];
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
    counts.flaky > 0 ? `${counts.flaky} flaky (a test failed for another reason; not counted)` : '',
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
        `${m.status.padEnd(11)} ${m.file}:${m.line} ${m.operator.padEnd(13)} ${m.before}  ->  ${m.after}${m.killedBy ? `  [${m.killedBy.join(', ')}]` : ''}${m.flakyTests ? `  flaky: ${m.flakyTests.join(', ')}` : ''}`,
    ),
    ...(report.selection && report.selection.scoped > 0
      ? [
          `${report.selection.scoped} mutant(s) first ran only the tests of the operations their line serves; those caught ${report.selection.caughtByScope}`,
        ]
      : []),
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

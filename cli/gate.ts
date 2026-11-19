/**
 * `gate`: runs the regression gate and answers with one verdict. The steps are the Taskfile's; what this adds is the
 * answer in a form a caller can act on without reading logs: which step failed, which tests, which documented
 * responses are still unreached, and where the evidence is. The same verdict is written to reports/verdict.json.
 */
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { loadService, type ServiceConfig } from '../framework/config.ts';
import type { ProjectConfig } from '../framework/project.ts';
import { checkRegistry, describeEntry, loadRegistry, registryPath, today } from '../framework/known-failures.ts';
import { treeState, type TreeState } from './commit.ts';
import { stackUp } from './doctor.ts';
import { mergeSummaries, parseJunit, testcaseNames, type TestSummary } from './junit.ts';
import { CLI, EXIT, UsageError, tail, type Result } from './output.ts';
import { prepare, stepEnv, type Runtime } from './runtime.ts';
import { runStreamed } from './stack.ts';
import { envOutbound, type Outbound } from '../framework/env/lifecycle.ts';
import type { UiFindings } from '../framework/ui/fixtures.ts';

export const STEPS = ['selftest', 'typecheck', 'lint', 'test', 'contract', 'coverage'] as const;
export type Step = (typeof STEPS)[number];

/** Steps that call the running service. `coverage` only reads what `test` observed. */
const NEEDS_STACK: readonly Step[] = ['test', 'contract'];

/** The verdict, in the project's reports directory (vgate.yaml's reportsDir; `reports` by default). */
export const VERDICT_FILE = 'reports/verdict.json';
const JUNIT_FILES = ['junit/playwright-api.xml', 'junit/playwright-faults.xml'];

export interface StepResult {
  name: Step;
  status: 'pass' | 'fail';
  exitCode: number | null;
  durationMs: number;
  /** Path of the step's full output, relative to the project root. */
  log: string;
  /** The end of the log, for a failed step whose failure is not itemised elsewhere. */
  tail?: string[];
}

export interface CoverageSummary {
  covered: number;
  demanded: number;
  excluded: number;
  percent: number;
  /** Documented responses no test reached: `POST /path 409 CODE`. */
  gaps: string[];
  /** Responses the service gave that the contract does not document. */
  undocumented: string[];
  /** Inventory scenario ids without a test. */
  untested: string[];
  /** Incidents (framework/incidents.ts) no scenario and collected test guard: `incident INC-3 has no regression test`. */
  unguarded?: string[];
  /** A UI service's committed visual baselines no test compares (framework/ui/baselines.ts), relative to the service. */
  uncomparedBaselines?: string[];
}

/** The known-failures registry as this run saw it. Present when the service has one. */
export interface RegistrySummary {
  file: string;
  entries: number;
  /** Entries past their date: their tests count as normal tests again, and the test step fails. */
  expired: string[];
  /** Entries no test of the run matches. */
  stale: string[];
  /** The registry could not be read; the test step failed before any test ran. */
  error?: string;
}

export interface Verdict {
  schema: 'vgate.verdict/1';
  service: string;
  environment: string;
  verdict: 'pass' | 'fail';
  /** False when only some steps ran: such a verdict says nothing about the others. */
  complete: boolean;
  startedAt: string;
  durationMs: number;
  /** What the running stack was built from, when its stack.sh recorded it. */
  build?: string;
  /** sha256 of the files that hold the expectations, so a verdict names what it was computed against. */
  expectations: Record<string, string>;
  /** The commit and uncommitted state the gate ran on, taken before its first step; `sha` null outside git. */
  commit?: TreeState;
  steps: StepResult[];
  /** `tests.knownFailures` are the failures the registry tolerated; `tests.failed` are the ones that count. */
  tests?: TestSummary;
  registry?: RegistrySummary;
  coverage?: CoverageSummary;
  /**
   * Where the service ran (named `sandbox` because `environment` is the service.yaml environment's name): `declared` (a sealed environment of its own, docs/environments.md) or `script` (its
   * stack.sh). `outbound` lists every name a container of the environment tried to reach outside it; in a sealed
   * environment one from the app fails the verdict.
   */
  sandbox: EnvironmentFacts;
  /** A UI service's browser facts (framework/ui): what the tests' pages did. Each problem also failed its test. */
  ui?: UiFacts;
  evidence: Record<string, string | string[]>;
}

export interface UiFacts {
  tests: number;
  pages: number;
  outbound: string[];
  consoleErrors: number;
  a11y: string[];
  budgetBreaches: string[];
  /**
   * Visual baselines the run itself wrote or changed (a run with VGATE_UPDATE_SNAPSHOTS=1, set by hand or by anything
   * that ran before the gate in the same CI job): such a run compared nothing visual, so it never passes.
   */
  baselinesWritten?: string[];
}

/** Sums the browser findings this run's tests wrote (<reports>/ui/*.jsonl, framework/ui/fixtures.ts). */
export function uiFacts(findings: UiFindings[]): UiFacts {
  return {
    tests: findings.length,
    pages: new Set(findings.flatMap((f) => f.pages.map((url) => new URL(url).pathname))).size,
    outbound: [...new Set(findings.flatMap((f) => f.outbound.map((o) => new URL(o.url).host)))],
    consoleErrors: findings.reduce((sum, f) => sum + f.consoleErrors.length + f.pageErrors.length, 0),
    a11y: [...new Set(findings.flatMap((f) => f.a11y.map((a) => `${a.id} (${a.impact})`)))],
    budgetBreaches: [...new Set(findings.flatMap((f) => f.budgetBreaches))],
  };
}

/** Content hashes of a service's committed visual baselines, every platform (path relative to the service). */
export function baselineHashes(serviceDir: string): Map<string, string> {
  const root = join(serviceDir, 'tests', '__screenshots__');
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(serviceDir, path), createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** The baselines added, changed or removed between two hash sets. */
export function baselinesChanged(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

function readUi(reports: string, since: number): UiFacts | undefined {
  const dir = join(reports, 'ui');
  if (!existsSync(dir)) return undefined;
  const findings = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((file) => file.endsWith('.jsonl') && fresh(file, since))
    .flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as UiFindings),
    );
  return findings.length === 0 ? undefined : uiFacts(findings);
}

export interface EnvironmentFacts {
  kind: 'declared' | 'script';
  sealed: boolean;
  project?: string;
  outbound: Outbound[];
}

export interface GateOptions {
  service: string;
  env: string;
  /** A subset of STEPS; all of them when absent. */
  steps?: string[];
  live: boolean;
}

export function selectSteps(names: string[] | undefined): Step[] {
  if (!names || names.length === 0) return [...STEPS];
  const unknown = names.filter((name) => !(STEPS as readonly string[]).includes(name));
  if (unknown.length > 0) throw new UsageError(`Unknown step ${unknown.join(', ')}. Steps: ${STEPS.join(', ')}`);
  // The gate's own order, whatever order they were named in: coverage reads what test wrote.
  return STEPS.filter((step) => names.includes(step));
}

function fresh(file: string, since: number): boolean {
  return existsSync(file) && statSync(file).mtimeMs >= since;
}

function readRegistry(root: string, svc: ServiceConfig, junit: string[]): RegistrySummary | undefined {
  const file = relative(root, registryPath(svc.dir));
  if (!existsSync(registryPath(svc.dir))) return undefined;
  try {
    const entries = loadRegistry(svc.dir);
    const titles =
      junit.length > 0 ? junit.flatMap((path) => testcaseNames(readFileSync(join(root, path), 'utf8'))) : undefined;
    const { expired, stale } = checkRegistry(entries, today(), titles);
    return { file, entries: entries.length, expired: expired.map(describeEntry), stale: stale.map(describeEntry) };
  } catch (error) {
    return { file, entries: 0, expired: [], stale: [], error: (error as Error).message };
  }
}

/** The run's JUnit reports, as paths relative to the project root. */
function readTests(root: string, reports: string, since: number): { tests?: TestSummary; files: string[] } {
  const files = JUNIT_FILES.map((file) => join(reports, file)).filter((file) => fresh(file, since));
  if (files.length === 0) return { files };
  return {
    tests: mergeSummaries(files.map((file) => parseJunit(readFileSync(file, 'utf8')))),
    files: files.map((file) => relative(root, file)),
  };
}

interface CoverageFile {
  service?: string;
  covered?: number;
  demanded?: number;
  excluded?: number;
  percent?: number;
  rows?: Array<{ operation: string; status: string; code?: string | null; state: string }>;
  undocumented?: Array<{ method: string; path: string; status: number; code?: string | null }>;
  untested?: string[];
  incidents?: Array<{ state: string; detail: string }>;
  uncomparedBaselines?: string[];
}

function readCoverage(reports: string, service: string, since: number): CoverageSummary | undefined {
  const file = join(reports, 'coverage', 'coverage.json');
  if (!fresh(file, since)) return undefined;
  const report = JSON.parse(readFileSync(file, 'utf8')) as CoverageFile;
  if (report.service !== service) return undefined;
  return {
    covered: report.covered ?? 0,
    demanded: report.demanded ?? 0,
    excluded: report.excluded ?? 0,
    percent: report.percent ?? 0,
    gaps: (report.rows ?? [])
      .filter((row) => row.state === 'gap')
      .map((row) => `${row.operation} ${row.status} ${row.code ?? '-'}`),
    undocumented: (report.undocumented ?? []).map(
      (call) => `${call.method} ${call.path} ${call.status} ${call.code ?? '-'}`,
    ),
    untested: report.untested ?? [],
    unguarded: (report.incidents ?? [])
      .filter((i) => i.state === 'no-scenario' || i.state === 'no-test')
      .map((i) => i.detail),
    uncomparedBaselines: report.uncomparedBaselines ?? [],
  };
}

function expectations(root: string, svc: ServiceConfig): Record<string, string> {
  const files = [svc.specPath, join(svc.dir, 'inventory.yaml'), join(svc.dir, 'service.yaml')];
  return Object.fromEntries(
    files
      .filter((file) => existsSync(file))
      .map((file) => [relative(root, file), createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
}

function notReady(summary: string, data: unknown, next: string[]): Result {
  return { command: 'gate', ok: false, exitCode: EXIT.notReady, summary, data, next };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function summarise(verdict: Verdict): string {
  const failed = verdict.steps.filter((step) => step.status === 'fail').map((step) => step.name);
  const parts = [
    failed.length > 0
      ? `${failed.join(', ')} failed`
      : `${verdict.steps.length} step${verdict.steps.length === 1 ? '' : 's'} passed`,
  ];
  if (verdict.tests) {
    const { failed, total, knownFailures } = verdict.tests;
    if (total === 0) parts.push('no tests ran');
    else parts.push(failed > 0 ? `${failed} of ${total} tests failed` : `${total - knownFailures.length} tests passed`);
    if (knownFailures.length > 0) parts.push(`${knownFailures.length} known failures tolerated`);
  }
  const registry = verdict.registry;
  if (registry?.error) parts.push('known-failures registry invalid');
  else if (registry && registry.expired.length + registry.stale.length > 0)
    parts.push(`registry: ${registry.expired.length} expired, ${registry.stale.length} stale`);
  if (verdict.coverage) parts.push(`coverage ${verdict.coverage.covered}/${verdict.coverage.demanded}`);
  if (verdict.ui) {
    const ui = verdict.ui;
    const written = ui.baselinesWritten ?? [];
    const problems = [
      ...(written.length > 0
        ? [
            `the run wrote ${written.length} visual baseline${written.length === 1 ? '' : 's'} instead of comparing them`,
          ]
        : []),
      ...(ui.outbound.length > 0 ? [`the page tried to reach ${ui.outbound.join(', ')}`] : []),
      ...(ui.a11y.length > 0 ? [`accessibility: ${ui.a11y.join(', ')}`] : []),
      ...(ui.consoleErrors > 0 ? [`${ui.consoleErrors} console errors`] : []),
      ...ui.budgetBreaches,
    ];
    parts.push(
      problems.length > 0
        ? `browser: ${problems.join(', ')}`
        : `browser: ${ui.pages} page${ui.pages === 1 ? '' : 's'}, accessible, no outbound call`,
    );
  }
  if (!verdict.complete) parts.push('partial run');
  const env = verdict.sandbox;
  if (env?.kind === 'declared') {
    const escaped = env.sealed ? env.outbound.filter((a) => a.from === 'app') : [];
    parts.push(
      escaped.length > 0
        ? `the app tried to reach ${escaped.map((a) => a.host).join(', ')} from its sealed environment`
        : env.sealed
          ? 'sealed environment, no outbound call'
          : 'environment not sealed',
    );
  }
  const head = `GATE ${verdict.verdict === 'pass' ? 'PASSED' : 'FAILED'} ${verdict.service}/${verdict.environment}`;
  return `${head}: ${parts.join('; ')} (${seconds(verdict.durationMs)})`;
}

const SHOWN = 20;

export function render(verdict: Verdict): string[] {
  const lines = verdict.steps.map(
    (step) => `${step.status.padEnd(4)}  ${step.name.padEnd(9)}  ${seconds(step.durationMs).padStart(7)}  ${step.log}`,
  );
  const more = (hidden: number) => (hidden > 0 ? [`+${hidden} more in ${VERDICT_FILE}`] : []);
  const failures = verdict.tests?.failures ?? [];
  for (const failure of failures.slice(0, SHOWN)) {
    const where = failure.line ? `${failure.file}:${failure.line}` : failure.file;
    lines.push(`FAIL ${failure.id ? `[${failure.id}] ` : ''}${where}  ${failure.message || failure.title}`);
  }
  lines.push(...more(failures.length - SHOWN));
  const known = verdict.tests?.knownFailures ?? [];
  for (const hit of known.slice(0, SHOWN)) lines.push(`KNOWN [${hit.id}] ${hit.ticket}  ${hit.title}`);
  lines.push(...more(known.length - SHOWN));
  const registry = verdict.registry;
  if (registry?.error) lines.push(`REGISTRY INVALID  ${registry.error}`);
  lines.push(...(registry?.expired ?? []).map((entry) => `EXPIRED  ${entry}`));
  lines.push(...(registry?.stale ?? []).map((entry) => `STALE  ${entry}`));
  for (const step of verdict.steps.filter((s) => s.tail)) {
    lines.push(`--- ${step.name} (end of ${step.log})`, ...(step.tail ?? []).map((line) => `  ${line}`));
  }
  const coverage = verdict.coverage;
  if (coverage) {
    lines.push(...coverage.gaps.slice(0, SHOWN).map((gap) => `GAP  ${gap}`), ...more(coverage.gaps.length - SHOWN));
    lines.push(...coverage.undocumented.slice(0, SHOWN).map((call) => `UNDOCUMENTED  ${call}`));
    lines.push(...coverage.untested.slice(0, SHOWN).map((id) => `UNTESTED  ${id}`));
    lines.push(...(coverage.unguarded ?? []).slice(0, SHOWN).map((detail) => `INCIDENT  ${detail}`));
    lines.push(
      ...(coverage.uncomparedBaselines ?? [])
        .slice(0, SHOWN)
        .map((path) => `UNCOMPARED  ${path} (a committed visual baseline no test compares)`),
    );
  }
  for (const path of verdict.ui?.baselinesWritten ?? []) lines.push(`BASELINE WRITTEN  ${path}`);
  return lines;
}

export async function gate(project: ProjectConfig, runtime: Runtime, options: GateOptions): Promise<Result> {
  const steps = selectSteps(options.steps);
  const { service, env } = options;
  const root = project.root;
  const reports = project.reportsDir;
  const shown = (path: string) => relative(root, path) || '.';
  // An earlier run's verdict must not outlive this one: a gate that stops before its steps (the stack is down, the
  // runtime will not install) would otherwise leave a stale `pass` for whoever reads the file.
  rmSync(join(reports, 'verdict.json'), { force: true });

  let svc: ServiceConfig;
  try {
    svc = loadService(service, env, root);
  } catch (error) {
    return notReady((error as Error).message, { service, environment: env }, [`${CLI} doctor --service ${service}`]);
  }
  // The judge is the runtime: installed once per version, and reached from the project through its links.
  const ready = prepare(project, runtime, options.live);
  if (!ready.ok) {
    return notReady(ready.error ?? 'the vgate runtime is not ready', { service, runtime: runtime.root }, [
      `${CLI} doctor --fix`,
    ]);
  }
  const task = join(runtime.root, 'node_modules', '.bin', 'task');
  if (steps.some((step) => NEEDS_STACK.includes(step)) && (await stackUp(svc)) === false) {
    return notReady(
      `The ${service} stack is DOWN at ${svc.env.baseUrl}${svc.env.healthPath ?? ''}: nothing was verified`,
      { service, environment: env },
      [`${CLI} up --service ${service}`],
    );
  }

  // The code under judgement is the tree as it stands now, before any step runs (they only write vgate's output).
  const commit = treeState(project);
  const startedAt = new Date();
  const started = startedAt.getTime();
  const logDir = join(reports, 'gate');
  mkdirSync(logDir, { recursive: true });

  // A run must compare the committed baselines, never write them: Playwright writes them when VGATE_UPDATE_SNAPSHOTS=1
  // reaches it, and in CI anything that ran earlier in the job (the app, its stack.sh) can set that for later steps.
  const baselinesBefore = svc.ui ? baselineHashes(svc.dir) : undefined;

  const results: StepResult[] = [];
  // One run id per gate, never inherited: global setup keeps only the observed-call files of the current run id, so a
  // RUN_ID left in the caller's environment would let coverage count calls from an earlier run.
  // Short, like the Taskfile's own: it becomes part of generated usernames, which have length caps.
  const runId = Date.now().toString(36).slice(-6);
  // Every step runs, even after a failure: the caller gets the whole picture from one run.
  for (const name of steps) {
    const logFile = join(logDir, `${name}.log`);
    const log = createWriteStream(logFile);
    if (options.live) process.stderr.write(`\n=== ${name} ===\n`);
    const run = await runStreamed(
      task,
      ['--taskfile', join(runtime.root, 'Taskfile.yml'), name, `SERVICE=${service}`, `TEST_ENV=${env}`],
      {
        cwd: runtime.root,
        env: { ...process.env, ...stepEnv(project, runtime), SERVICE: service, TEST_ENV: env, RUN_ID: runId },
        live: options.live,
        log,
      },
    );
    await new Promise<void>((done) => log.end(done));
    results.push({
      name,
      status: run.code === 0 ? 'pass' : 'fail',
      exitCode: run.code,
      durationMs: run.durationMs,
      log: relative(root, logFile),
      tail: run.code === 0 ? undefined : tail(run.output, 25),
    });
  }

  const { tests, files: junit } = steps.includes('test')
    ? readTests(root, reports, started)
    : { tests: undefined, files: [] };
  const registry = steps.includes('test') ? readRegistry(root, svc, junit) : undefined;
  const coverage = steps.includes('coverage') ? readCoverage(reports, service, started) : undefined;
  // Failed tests are itemised from JUnit, and coverage problems from its report: the log's end adds nothing then.
  for (const result of results) {
    if (result.name === 'test' && tests && tests.failed > 0) delete result.tail;
    if (result.name === 'coverage' && coverage) delete result.tail;
  }

  const sandbox: EnvironmentFacts = svc.environment
    ? {
        kind: 'declared',
        sealed: svc.environment.sealed && svc.environment.app.command === undefined,
        project: svc.env.declared?.project,
        outbound: await envOutbound(reports, service),
      }
    : { kind: 'script', sealed: false, outbound: [] };
  // The point of a sealed environment: the app reached nothing outside it. An attempt is a failure, not a warning.
  const escaped = sandbox.sealed ? sandbox.outbound.filter((attempt) => attempt.from === 'app') : [];

  const buildFile = join(reports, 'stack', `${service}.build`);
  const failed = results.filter((result) => result.status === 'fail').map((result) => result.name);
  const baselinesWritten = baselinesBefore ? baselinesChanged(baselinesBefore, baselineHashes(svc.dir)) : [];
  let ui = svc.ui && steps.includes('test') ? readUi(reports, started) : undefined;
  if (baselinesWritten.length > 0)
    ui = {
      ...(ui ?? uiFacts([])),
      baselinesWritten: baselinesWritten.map((path) => relative(root, join(svc.dir, path))),
    };
  const pass = failed.length === 0 && escaped.length === 0 && baselinesWritten.length === 0;
  const verdict: Verdict = {
    schema: 'vgate.verdict/1',
    service,
    environment: env,
    verdict: pass ? 'pass' : 'fail',
    complete: steps.length === STEPS.length,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    build: existsSync(buildFile) ? readFileSync(buildFile, 'utf8').trim() : undefined,
    expectations: expectations(root, svc),
    commit,
    steps: results,
    tests,
    registry,
    coverage,
    sandbox,
    ui,
    evidence: {
      junit,
      traces: shown(join(reports, 'test-results')),
      coverage: shown(join(reports, 'coverage', 'coverage.md')),
      logs: shown(logDir),
      verdict: shown(join(reports, 'verdict.json')),
    },
  };
  writeFileSync(join(reports, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);

  const next = failed.length === 0 ? [] : [`${CLI} gate --service ${service} --steps ${failed.join(',')}`];
  // The summary names the hosts; the fix is in the app's configuration, after which the gate runs again.
  if (escaped.length > 0 && next.length === 0) next.push(`${CLI} gate --service ${service}`);
  if (baselinesWritten.length > 0)
    next.push(
      `review the written baselines (git diff), commit them if they are right, and run ${CLI} gate --service ${service} without VGATE_UPDATE_SNAPSHOTS`,
    );
  return {
    command: 'gate',
    ok: pass,
    exitCode: pass ? EXIT.ok : EXIT.failed,
    summary: summarise(verdict),
    data: verdict,
    next,
    text: render(verdict),
  };
}

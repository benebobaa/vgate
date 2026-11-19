/**
 * `smoke`: verifies a deployed environment (staging, production) right after a deploy, without changing it. It runs
 * the service's smoke subset of its own tests against an existing environment of service.yaml; in an environment that
 * is not disposable the client refuses every request that is not read-only before it is sent (framework/http/
 * write-guard.ts), so whatever a test tries, the environment is only read. Zero selected tests is a failure: a smoke run
 * that verified nothing must never read as a pass.
 *
 * The subset: `smoke.scenarios` (ids) or `smoke.grep` of service.yaml; by default the plan's scenarios of read-only
 * operations. Writes <reports>/smoke.json (`vgate.verdict/1`, `kind: deployed`), which `decide` never takes for a gate
 * verdict.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { loadService, type SchemathesisConfig, type ServiceConfig } from '../framework/config.ts';
import type { ProjectConfig } from '../framework/project.ts';
import { isReadOnly } from '../framework/http/write-guard.ts';
import { stackUp } from './doctor.ts';
import { mergeSummaries, parseJunit, type TestSummary } from './junit.ts';
import { CLI, EXIT, tail, type Result } from './output.ts';
import { prepare, stepEnv, type Runtime } from './runtime.ts';
import { runStreamed } from './stack.ts';

export const SMOKE_FILE = 'smoke.json';
const JUNIT_FILES = ['junit/playwright-api.xml', 'junit/playwright-faults.xml'];

export interface Selection {
  /** How the subset was chosen. */
  by: 'scenarios' | 'grep' | 'read-only plan';
  /** The Playwright --grep it becomes. Undefined when nothing could be selected. */
  grep?: string;
  /** The scenario ids, when known. */
  scenarios: string[];
}

export interface SmokeVerdict {
  schema: 'vgate.verdict/1';
  kind: 'deployed';
  service: string;
  environment: string;
  verdict: 'pass' | 'fail';
  /** A smoke run is never a gate verdict: `decide` treats an incomplete verdict as missing. */
  complete: false;
  /** Whether the write guard was on (the environment is not disposable). */
  guarded: boolean;
  startedAt: string;
  durationMs: number;
  selection: Selection;
  tests?: TestSummary;
  /** Why it failed when no test result says so (nothing selected, nothing ran, the run broke). */
  reason?: string;
  evidence: Record<string, string | string[]>;
}

const escapeId = (id: string) => id.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** The Playwright grep that selects exactly these scenario ids, as they appear in test titles: `[ID]`. */
export function grepForScenarios(ids: string[]): string | undefined {
  const unique = [...new Set(ids)];
  return unique.length === 0 ? undefined : `\\[(${unique.map(escapeId).join('|')})\\]`;
}

/** Scenario ids of the plan's read-only operations (`operations[].operation` is `METHOD /template`). */
export function readOnlyScenarios(inventory: unknown, readOnly: SchemathesisConfig): string[] {
  const operations = (inventory as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(operations)) return [];
  const ids: string[] = [];
  for (const op of operations as Array<{ operation?: unknown; scenarios?: unknown }>) {
    if (typeof op?.operation !== 'string') continue;
    const [method, template] = op.operation.trim().split(/\s+/);
    if (!method || !template || !isReadOnly(method, template, readOnly)) continue;
    for (const scenario of Array.isArray(op.scenarios) ? (op.scenarios as Array<{ id?: unknown }>) : []) {
      if (typeof scenario?.id === 'string' && scenario.id !== '') ids.push(scenario.id);
    }
  }
  return ids;
}

/** The smoke subset of a service: explicit ids, a grep, or the read-only scenarios of its plan. */
export function selectSmoke(svc: Pick<ServiceConfig, 'smoke' | 'schemathesis' | 'dir'>): Selection {
  if (svc.smoke?.scenarios && svc.smoke.scenarios.length > 0)
    return { by: 'scenarios', scenarios: svc.smoke.scenarios, grep: grepForScenarios(svc.smoke.scenarios) };
  if (svc.smoke?.grep) return { by: 'grep', scenarios: [], grep: svc.smoke.grep };
  const file = join(svc.dir, 'inventory.yaml');
  const inventory = existsSync(file) ? (parse(readFileSync(file, 'utf8')) as unknown) : undefined;
  const ids = readOnlyScenarios(inventory, svc.schemathesis);
  return { by: 'read-only plan', scenarios: ids, grep: grepForScenarios(ids) };
}

/** A smoke run passes only when tests ran and none failed: skipped-only or empty is a failure. */
export function judgeSmoke(tests: TestSummary | undefined): { pass: boolean; reason?: string } {
  if (!tests) return { pass: false, reason: 'no test report: the run did not get as far as the tests' };
  const ran = tests.total - tests.skipped;
  if (ran <= 0) return { pass: false, reason: 'no smoke test ran: nothing was verified' };
  if (tests.failed > 0) return { pass: false };
  return { pass: true };
}

export interface SmokeOptions {
  service: string;
  env: string;
  live: boolean;
}

function fresh(file: string, since: number): boolean {
  return existsSync(file) && statSync(file).mtimeMs >= since;
}

export async function smoke(project: ProjectConfig, runtime: Runtime, options: SmokeOptions): Promise<Result> {
  const { service, env } = options;
  const reports = project.reportsDir;
  const out = join(reports, SMOKE_FILE);
  rmSync(out, { force: true });
  const notReady = (summary: string, next: string[] = []): Result => ({
    command: 'smoke',
    ok: false,
    exitCode: EXIT.notReady,
    summary,
    data: { service, environment: env },
    next,
  });

  let svc: ServiceConfig;
  try {
    svc = loadService(service, env, project.root);
  } catch (error) {
    return notReady((error as Error).message, [`${CLI} doctor --service ${service}`]);
  }
  const ready = prepare(project, runtime, options.live);
  if (!ready.ok) return notReady(ready.error ?? 'the vgate runtime is not ready', [`${CLI} doctor --fix`]);
  if ((await stackUp(svc)) === false)
    return notReady(
      `${service} does not answer at ${svc.env.baseUrl}${svc.env.healthPath ?? ''} (${env}): nothing was verified`,
    );

  const selection = selectSmoke(svc);
  const startedAt = new Date();
  const started = startedAt.getTime();
  const logDir = join(reports, 'smoke');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'test.log');

  let tests: TestSummary | undefined;
  let reason: string | undefined;
  let junit: string[] = [];
  if (!selection.grep) {
    reason =
      selection.by === 'read-only plan'
        ? `no smoke scenario: the plan has no scenario of a read-only operation; list some in service.yaml smoke.scenarios`
        : 'no smoke scenario selected';
  } else {
    const task = join(runtime.root, 'node_modules', '.bin', 'task');
    const log = createWriteStream(logFile);
    const run = await runStreamed(
      task,
      [
        '--taskfile',
        join(runtime.root, 'Taskfile.yml'),
        'test',
        `SERVICE=${service}`,
        `TEST_ENV=${env}`,
        '--',
        '--grep',
        selection.grep,
      ],
      {
        cwd: runtime.root,
        env: {
          ...process.env,
          ...stepEnv(project, runtime),
          SERVICE: service,
          TEST_ENV: env,
          RUN_ID: Date.now().toString(36).slice(-6),
        },
        live: options.live,
        log,
      },
    );
    await new Promise<void>((done) => log.end(done));
    const files = JUNIT_FILES.map((file) => join(reports, file)).filter((file) => fresh(file, started));
    junit = files.map((file) => relative(project.root, file));
    tests = files.length > 0 ? mergeSummaries(files.map((file) => parseJunit(readFileSync(file, 'utf8')))) : undefined;
    const judged = judgeSmoke(tests);
    reason = judged.reason;
    if (judged.pass && run.code !== 0) reason = `the test run failed: ${tail(run.output, 3).join(' / ')}`;
  }

  const pass = reason === undefined && judgeSmoke(tests).pass;
  const verdict: SmokeVerdict = {
    schema: 'vgate.verdict/1',
    kind: 'deployed',
    service,
    environment: env,
    verdict: pass ? 'pass' : 'fail',
    complete: false,
    guarded: !svc.env.disposable,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    selection,
    tests,
    reason,
    evidence: {
      junit,
      log: relative(project.root, logFile),
      traces: relative(project.root, join(reports, 'test-results')),
    },
  };
  writeFileSync(out, `${JSON.stringify(verdict, null, 2)}\n`);

  const ran = tests ? tests.total - tests.skipped : 0;
  const failures = tests?.failures ?? [];
  const summary = pass
    ? `SMOKE PASSED ${service}/${env}: ${ran} test${ran === 1 ? '' : 's'} passed${verdict.guarded ? ', writes refused' : ' (disposable: not guarded)'}`
    : `SMOKE FAILED ${service}/${env}: ${reason ?? `${tests?.failed ?? 0} of ${ran} tests failed`}`;
  return {
    command: 'smoke',
    ok: pass,
    exitCode: pass ? EXIT.ok : EXIT.failed,
    summary,
    data: verdict,
    next: pass ? [] : [`${CLI} smoke --service ${service} --env ${env}`],
    text: failures
      .slice(0, 20)
      .map(
        (f) => `FAIL ${f.id ? `[${f.id}] ` : ''}${f.line ? `${f.file}:${f.line}` : f.file}  ${f.message || f.title}`,
      ),
  };
}

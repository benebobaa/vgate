/**
 * CLI handlers for vgate's 3-layer agentic factory commands (M1-M4):
 *   lint, verify, eval, maintain, formal, statechart, benchmark, ship, maturity, metrics, factory, stop, resume, mcp.
 *
 * Every command returns the standard vgate Result envelope (`--json`), meaningful exit codes (0/1/2/3), and `next`
 * hints without interactive prompts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ProjectConfig } from '../framework/project.ts';
import { VgateMcpServer, createDefaultTools, runAgent } from '../packages/adapters/index.ts';
import {
  GUARDRAILS_FILE,
  loadGuardrails,
  parseGuardrails,
  runGuardrails,
  testGuardrailFixtures,
} from '../packages/guardrails/index.ts';
import {
  appendTrailRow,
  auditWorkers,
  CiRunnerSandbox,
  clearStopOrder,
  createFactoryServer,
  DockerSandbox,
  formatUntrustedSignalBrief,
  issueStopOrder,
  latestWorkerStates,
  LocalWorktreeSandbox,
  normalizeSignal,
  readStopOrder,
  type SignalSource,
  type WorkerTrailRow,
} from '../packages/factory/index.ts';
import { enforceMaturityGate, inspectProjectMaturity } from '../packages/maturity/index.ts';
import { runBlindedEval, type EvalSpec } from '../packages/playbooks/index.ts';
import {
  checkRebaseCeiling,
  computeSemanticPatchId,
  maintainFeatureMap,
  parseTlaStates,
  planContiguousLanding,
  renderStatechart,
  runAlternatingBenchmark,
  runFormalChecks,
  writeSignedOrPlainJson,
  type StackedPr,
} from '../packages/verification/index.ts';
import {
  appendKpiEvent,
  parseRolesConfig,
  readKpiEvents,
  renderMetricsHtml,
  renderPrometheusMetrics,
  runVerifierSwarm,
  summarizeKpis,
  type KpiEvent,
  type VerifierMode,
} from '../packages/verifier/index.ts';
import { changeSet } from './affected.ts';
import { treeState } from './commit.ts';
import { CLI, EXIT, UsageError, type Result } from './output.ts';
import { capture, listServices, resolveService } from './project.ts';
import { VERSION } from './version.ts';

export function lintCommand(
  project: ProjectConfig,
  options: {
    testFixtures?: boolean;
    updateRatchet?: boolean;
    skipNative?: boolean;
    files?: string[];
    configPath?: string;
    ratchetPath?: string;
  },
): Result {
  const config = options.configPath
    ? (() => {
        const abs = resolve(project.root, options.configPath);
        if (!existsSync(abs)) throw new UsageError(`No guardrails config at ${abs}`);
        return parseGuardrails(readFileSync(abs, 'utf8'));
      })()
    : loadGuardrails(project.root);
  if (!config) {
    return {
      command: 'lint',
      ok: true,
      exitCode: EXIT.ok,
      summary: `No ${GUARDRAILS_FILE} in ${project.root}: nothing to check`,
      data: { configured: false, file: GUARDRAILS_FILE },
      next: [`create ${GUARDRAILS_FILE} to enable polyglot guardrails and ratchets`],
    };
  }

  if (options.testFixtures) {
    const fx = testGuardrailFixtures(config);
    return {
      command: 'lint',
      ok: fx.ok,
      exitCode: fx.ok ? EXIT.ok : EXIT.failed,
      summary: fx.ok
        ? `Guardrail fixtures passed: ${fx.rulesTested} rule(s) proven able to fail`
        : `Guardrail fixture test failed across ${fx.results.filter((r) => !r.ok).length} of ${fx.rulesTested} rule(s)`,
      data: fx,
      next: fx.ok ? [`${CLI} lint --json`] : [`fix failing fixtures in ${GUARDRAILS_FILE}`],
      text: [
        ...fx.results.map(
          (r) =>
            `${r.ok ? 'PASS' : 'FAIL'}  ${r.ruleId}  bad ${r.badPassed}/${r.badTotal}  good ${r.goodPassed}/${r.goodTotal}`,
        ),
        ...fx.results.flatMap((r) => r.failures.map((f) => `  - ${f}`)),
        ...(fx.rulesWithoutFixtures.length > 0
          ? [`warn: rules without fixtures: ${fx.rulesWithoutFixtures.join(', ')}`]
          : []),
      ],
    };
  }

  const report = runGuardrails(project.root, {
    config,
    ratchetPath: options.ratchetPath ? resolve(project.root, options.ratchetPath) : undefined,
    files: options.files,
    updateRatchet: options.updateRatchet,
    skipNativeLinters: options.skipNative,
  });
  writeSignedOrPlainJson(join(project.reportsDir, 'lint.json'), report);

  const errors = report.violations.filter((v) => v.severity === 'error');
  return {
    command: 'lint',
    ok: report.ok,
    exitCode: report.ok ? EXIT.ok : EXIT.failed,
    summary: report.ok
      ? `LINT PASSED: ${report.filesScanned} files scanned, ${report.baselined} baselined, ${report.tightenings.length} ratchet tightening(s)`
      : `LINT FAILED: ${errors.length} violation(s) across ${report.filesScanned} files`,
    data: report,
    next: report.ok
      ? report.tightenings.length > 0
        ? [`${CLI} lint --update-ratchet`]
        : []
      : [`fix violations or escalate via vgate-correct`],
    text: [
      ...report.violations
        .slice(0, 30)
        .map(
          (v) =>
            `${v.severity.toUpperCase().padEnd(5)} ${v.ruleId}  ${v.file}${v.line ? `:${v.line}` : ''}  ${v.message}${v.replaceWith ? ` -> ${v.replaceWith}` : ''}`,
        ),
      ...report.tightenings.slice(0, 10).map((t) => `TIGHTEN  ${t.ruleId}  ${t.file}  ${t.baseline} -> ${t.actual}`),
    ],
  };
}

export async function verifyCommand(
  project: ProjectConfig,
  options: {
    base?: string;
    mode?: string;
    verifiers?: number;
    authorHarness?: string;
    authorModel?: string;
  },
): Promise<Result> {
  const change = changeSet(project, options.base);
  if ('result' in change) return { ...change.result, command: 'verify' };

  const roles = project.roles ?? parseRolesConfig(undefined);
  const now = treeState(project);
  const semantic = computeSemanticPatchId(change.top, change.mergeBase);
  const explicitMode =
    options.mode && options.mode !== 'auto'
      ? (options.mode as VerifierMode)
      : project.verifier?.mode && project.verifier.mode !== 'auto'
        ? project.verifier.mode
        : undefined;
  if (explicitMode === 'skip' && project.verifier?.required === true) {
    throw new UsageError('Cannot use --mode skip when verifier.required is true in vgate.yaml');
  }
  const verifiers = options.verifiers ?? project.verifier?.verifiers ?? 1;
  // Capture signing key in memory before invoking verifier agents (runAgent strips VGATE_SIGNING_* from child env).
  const signingKey = process.env.VGATE_SIGNING_PRIVATE_KEY ?? process.env.VGATE_SIGNING_KEY;

  const report = await runVerifierSwarm({
    cwd: project.root,
    reportsDir: project.reportsDir,
    headSha: now.sha,
    treeFingerprint: now.fingerprint,
    patchId: semantic.patchId,
    changedFiles: change.files,
    roles,
    author: options.authorHarness ? { harness: options.authorHarness, model: options.authorModel } : undefined,
    mode: explicitMode,
    verifiers,
    budgets: project.budgets,
    verifyCommands: [`${CLI} lint --json`, `${CLI} gate --json`],
    artifactPaths: [join(project.reportsDir, 'verdict.json'), join(project.reportsDir, 'guard.json')],
    executor: async (opts) => {
      const res = await runAgent({
        harness: opts.harness,
        model: opts.model,
        effort: opts.effort,
        prompt: opts.prompt,
        cwd: opts.cwd,
        customRunners: project.agents?.runners,
      });
      return {
        ok: res.ok,
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
      };
    },
  });

  if (signingKey) {
    writeSignedOrPlainJson(join(project.reportsDir, 'verifier.json'), report, signingKey);
  }

  const ok = report.verdict !== 'FAIL';
  return {
    command: 'verify',
    ok,
    exitCode: ok ? EXIT.ok : EXIT.failed,
    summary: `VERIFY ${report.verdict} (${report.mode}, ${report.lanes.length} verifier(s))`,
    data: report,
    next: ok
      ? [`${CLI} decide --base ${change.base} --evidence ${relative(project.root, project.reportsDir) || 'reports'}`]
      : [],
    text: [
      ...report.lanes.map((l) => `${l.verdict.padEnd(10)}  ${l.lane}  [${l.harness}/${l.family}]  ${l.summary}`),
      ...report.reasons.map((r) => `- ${r}`),
    ],
  };
}

export async function evalCommand(project: ProjectConfig, specFile: string | undefined): Promise<Result> {
  if (!specFile) throw new UsageError(`Pass --spec <eval.json>, e.g. ${CLI} eval --spec evals/verify-skill.json`);
  const abs = resolve(project.root, specFile);
  if (!existsSync(abs)) throw new UsageError(`No eval spec at ${abs}`);
  const spec = JSON.parse(readFileSync(abs, 'utf8')) as EvalSpec;
  const report = await runBlindedEval(
    spec,
    async (opts) => {
      const res = await runAgent({
        harness: opts.harness,
        model: opts.model,
        prompt: opts.prompt,
        cwd: opts.cwd,
        customRunners: project.agents?.runners,
      });
      return {
        ok: res.ok,
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
      };
    },
    { reportsDir: project.reportsDir },
  );
  return {
    command: 'eval',
    ok: true,
    exitCode: EXIT.ok,
    summary: `Eval "${report.id}" complete: ${report.variants.length} variant(s), winner ${report.winner ?? 'tie'}`,
    data: report,
    next: [],
    text: report.variants.map(
      (v) => `${v.id.padEnd(20)}  score ${v.total.toFixed(2)}  adhered=${String(v.adherence.adhered)}`,
    ),
  };
}

export function maintainCommand(project: ProjectConfig, serviceFlag: string | undefined): Result {
  const names = serviceFlag ? [resolveService(project.root, serviceFlag)] : listServices(project.root);
  if (names.length === 0) {
    return {
      command: 'maintain',
      ok: true,
      exitCode: EXIT.ok,
      summary: 'No services configured to maintain',
      data: { services: [] },
      next: [],
    };
  }
  const reports = names.map((name) =>
    maintainFeatureMap({
      projectRoot: project.root,
      serviceDir: join(project.servicesDir, name),
      serviceName: name,
    }),
  );
  const blocked = reports.filter((r) => r.outcome === 'blocked');
  const changed = reports.filter((r) => r.outcome === 'changed');
  const ok = blocked.length === 0;
  return {
    command: 'maintain',
    ok,
    exitCode: ok ? EXIT.ok : EXIT.failed,
    summary: `MAINTAIN: ${reports.length} service(s) — ${reports.length - changed.length - blocked.length} clean, ${changed.length} changed, ${blocked.length} blocked`,
    data: { reports },
    next:
      changed.length > 0
        ? [`update features/ for ${changed.map((r) => r.service).join(', ')} (do not edit product code)`]
        : [],
    text: reports.flatMap((r) => [
      `${r.outcome.toUpperCase().padEnd(8)}  ${r.service}  (${r.featuresChecked} feature(s))`,
      ...r.drifted.map((d) => `  - ${d.featureId}: ${d.reason}`),
    ]),
  };
}

export function formalCommand(project: ProjectConfig, verifyMutation: boolean): Result {
  const specs = project.formal ?? [];
  if (specs.length === 0) {
    return {
      command: 'formal',
      ok: true,
      exitCode: EXIT.ok,
      summary: 'No formal: specs configured in vgate.yaml',
      data: { configured: false, results: [] },
      next: [],
    };
  }
  const report = runFormalChecks(project.root, specs, { verifyMutation });
  mkdirSync(project.reportsDir, { recursive: true });
  writeFileSync(join(project.reportsDir, 'formal.json'), `${JSON.stringify(report, null, 2)}\n`);
  return {
    command: 'formal',
    ok: report.ok,
    exitCode: report.ok ? EXIT.ok : EXIT.failed,
    summary: report.ok
      ? `FORMAL PASSED: ${report.results.length} spec(s) verified`
      : `FORMAL FAILED: ${report.results.filter((r) => !r.ok).length} of ${report.results.length} spec(s) failed`,
    data: report,
    next: [],
    text: report.results.map(
      (r) =>
        `${r.ok ? 'PASS' : 'FAIL'}  ${r.id} (${r.engine})  stale=${String(r.stale)}${r.mutationProven !== undefined ? `  mutationProven=${String(r.mutationProven)}` : ''}  ${r.detail}`,
    ),
  };
}

export function statechartCommand(
  project: ProjectConfig,
  options: { input?: string; output?: string; maxArrows?: number },
): Result {
  if (!options.input) throw new UsageError(`Pass --input <spec.tla>, e.g. ${CLI} statechart --input specs/sync.tla`);
  const abs = resolve(project.root, options.input);
  if (!existsSync(abs)) throw new UsageError(`No TLA+/DOT file at ${abs}`);
  const parsed = parseTlaStates(readFileSync(abs, 'utf8'));
  const rendered = renderStatechart({
    title: relative(project.root, abs),
    transitions: parsed.transitions,
    maxArrows: options.maxArrows,
  });
  if (options.output) {
    const outPath = resolve(project.root, options.output);
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, `${rendered.mermaid}\n`);
  }
  return {
    command: 'statechart',
    ok: true,
    exitCode: EXIT.ok,
    summary: `Best-effort statechart rendered (${rendered.stateCount} states, ${rendered.arrowCount} arrows${rendered.truncated ? ', truncated' : ''})`,
    data: { ...rendered, invariants: parsed.invariants, bestEffort: true },
    next: [],
    text: [rendered.mermaid],
  };
}

export function benchmarkCommand(
  project: ProjectConfig,
  options: { baseline?: string; candidate?: string; limiter?: string; runs?: number; productionTuned?: boolean },
): Result {
  if (!options.baseline || !options.candidate) {
    throw new UsageError(
      `Pass --baseline "<cmd>" and --candidate "<cmd>", e.g. ${CLI} benchmark --baseline "node a.js" --candidate "node b.js" --limiter "CPU-bound JSON parse"`,
    );
  }
  const splitCmd = (raw: string): [string, string[]] => {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) throw new UsageError('Benchmark command must be non-empty');
    return [parts[0], parts.slice(1)];
  };
  const report = runAlternatingBenchmark({
    baselineCmd: splitCmd(options.baseline),
    candidateCmd: splitCmd(options.candidate),
    runs: options.runs ?? 5,
    cwd: project.root,
    checklist: {
      limiter: options.limiter ?? '',
      productionTuned: options.productionTuned ?? false,
      withinPhysicalLimits: true,
      zeroErrors: true,
      alternatingReproducible: true,
      endToEndUserPath: true,
      insideTimedRegion: true,
    },
  });
  mkdirSync(project.reportsDir, { recursive: true });
  writeFileSync(join(project.reportsDir, 'benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
  return {
    command: 'benchmark',
    ok: report.verdict !== 'slower',
    exitCode: report.verdict === 'slower' ? EXIT.failed : EXIT.ok,
    summary: `BENCHMARK ${report.verdict.toUpperCase()}: ${report.summary}`,
    data: report,
    next:
      report.missingChecks.length > 0 ? [`resolve missing benchmark checks: ${report.missingChecks.join(', ')}`] : [],
    text: [
      `Verdict:   ${report.verdict}`,
      `Baseline:  median ${report.baseline.medianMs.toFixed(1)}ms (range ${report.baseline.minMs.toFixed(1)}-${report.baseline.maxMs.toFixed(1)}ms)`,
      `Candidate: median ${report.candidate.medianMs.toFixed(1)}ms (range ${report.candidate.minMs.toFixed(1)}-${report.candidate.maxMs.toFixed(1)}ms)`,
      ...(report.missingChecks.length > 0 ? [`Missing:   ${report.missingChecks.join(', ')}`] : []),
    ],
  };
}

export function shipCommand(
  project: ProjectConfig,
  action: string | undefined,
  options: { base?: string; rebases?: number; stackFile?: string },
): Result {
  if (action === 'patch-id') {
    if (!options.base) throw new UsageError(`Pass --base <git ref>, e.g. ${CLI} ship patch-id --base origin/main`);
    const res = computeSemanticPatchId(project.root, options.base);
    return {
      command: 'ship patch-id',
      ok: res.patchId !== null,
      exitCode: res.patchId !== null ? EXIT.ok : EXIT.notReady,
      summary: res.patchId
        ? `Semantic patch-id: ${res.patchId} (${res.codeFiles.length} code file(s), ${res.ignoredNoiseFiles.length} noise file(s) ignored)`
        : 'No semantic code diff vs base',
      data: res,
      next: [],
    };
  }
  if (action === 'rebase-check') {
    const count = options.rebases ?? 0;
    const guard = checkRebaseCeiling(count);
    return {
      command: 'ship rebase-check',
      ok: guard.ok,
      exitCode: guard.ok ? EXIT.ok : EXIT.failed,
      summary: `${guard.action}: ${guard.reason}`,
      data: guard,
      next: guard.ok ? [] : ['halt merge prep and escalate to coordinator to sequence colliding PRs'],
    };
  }
  if (action === 'plan') {
    if (!options.stackFile) throw new UsageError(`Pass --stack <stack.json>, e.g. ${CLI} ship plan --stack stack.json`);
    const abs = resolve(project.root, options.stackFile);
    if (!existsSync(abs)) throw new UsageError(`No stack file at ${abs}`);
    const stack = JSON.parse(readFileSync(abs, 'utf8')) as StackedPr[];
    const plan = planContiguousLanding(stack);
    return {
      command: 'ship plan',
      ok: plan.landable.length > 0,
      exitCode: EXIT.ok,
      summary: `Contiguous landing plan: ${plan.landable.length} landable PR(s)${plan.ceilingPr ? `, ceiling at #${plan.ceilingPr.number}` : ''}`,
      data: plan,
      next: [],
      text: [
        ...plan.landable.map((pr) => `LAND     #${pr.number}  ${pr.branch}`),
        ...(plan.ceilingPr
          ? [`CEILING  #${plan.ceilingPr.number}  ${plan.ceilingPr.branch}  (${plan.blockedReason ?? 'unverified'})`]
          : []),
      ],
    };
  }
  throw new UsageError(`Usage: ${CLI} ship patch-id|rebase-check|plan (see ${CLI} help)`);
}

export function maturityCommand(project: ProjectConfig, requirePhase?: number): Result {
  const report = inspectProjectMaturity(project.root, {
    servicesDir: project.servicesDir,
    reportsDir: project.reportsDir,
  });
  if (requirePhase !== undefined) {
    if (![1, 2, 3, 4, 5].includes(requirePhase)) throw new UsageError('--require must be 1, 2, 3, 4, or 5');
    const gate = enforceMaturityGate(report, requirePhase as 1 | 2 | 3 | 4 | 5);
    return {
      command: 'maturity',
      ok: gate.allowed,
      exitCode: gate.allowed ? EXIT.ok : EXIT.failed,
      summary: gate.reason,
      data: { report, gate },
      next: gate.blockers.slice(0, 5),
      text: [
        `Level: ${report.level}/5 (required ${requirePhase}${gate.advisory ? ', advisory' : ''})`,
        ...gate.blockers.map((b) => `  - ${b}`),
      ],
    };
  }
  return {
    command: 'maturity',
    ok: true,
    exitCode: EXIT.ok,
    summary: `Maturity Level ${report.level}/5 (${report.nextPhaseBlockers.length} blocker(s) for next phase)`,
    data: report,
    next: report.nextPhaseBlockers.slice(0, 5),
    text: report.phases.flatMap((p) => [
      `Phase ${p.phase} (${p.name}): ${p.met ? 'MET' : 'OPEN'}`,
      ...p.checks.map((c) => `  ${c.met ? 'ok  ' : 'todo'} ${c.id}: ${c.detail}`),
    ]),
  };
}

export function metricsCommand(
  project: ProjectConfig,
  action: string | undefined,
  options: {
    kind?: string;
    pr?: string;
    service?: string;
    reviewMinutes?: number;
    tokens?: number;
    usd?: number;
    role?: string;
    days?: number;
    format?: string;
  },
): Result {
  if (action === 'record') {
    const validKinds: KpiEvent['kind'][] = ['pr-merged', 'pr-reverted', 'incident-escaped', 'rework', 'agent-spend'];
    if (!options.kind || !(validKinds as string[]).includes(options.kind)) {
      throw new UsageError(`--kind must be one of ${validKinds.join(', ')}`);
    }
    const event: KpiEvent = {
      timestamp: new Date().toISOString(),
      kind: options.kind as KpiEvent['kind'],
      ...(options.pr ? { pr: options.pr } : {}),
      ...(options.service ? { service: options.service } : {}),
      ...(options.reviewMinutes !== undefined ? { humanReviewMinutes: options.reviewMinutes } : {}),
      ...(options.tokens !== undefined ? { tokens: options.tokens } : {}),
      ...(options.usd !== undefined ? { usd: options.usd } : {}),
      ...(options.role ? { role: options.role } : {}),
    };
    const file = appendKpiEvent(project.root, event);
    return {
      command: 'metrics record',
      ok: true,
      exitCode: EXIT.ok,
      summary: `Recorded ${event.kind} event in ${relative(project.root, file) || file}`,
      data: { file, event },
      next: [`${CLI} metrics report`],
    };
  }

  if (action === 'report' || action === undefined) {
    const days = options.days ?? 30;
    const events = readKpiEvents(project.root, days);
    const summary = summarizeKpis(events, days);
    const fmt = options.format ?? 'text';
    if (fmt === 'html') {
      mkdirSync(project.reportsDir, { recursive: true });
      const htmlPath = join(project.reportsDir, 'metrics.html');
      writeFileSync(htmlPath, renderMetricsHtml(summary, events));
      return {
        command: 'metrics report',
        ok: true,
        exitCode: EXIT.ok,
        summary: `Wrote static KPI dashboard to ${relative(project.root, htmlPath) || htmlPath}`,
        data: { file: htmlPath, summary },
        next: [],
      };
    }
    if (fmt === 'otel' || fmt === 'prometheus') {
      const prom = renderPrometheusMetrics(summary);
      return {
        command: 'metrics report',
        ok: true,
        exitCode: EXIT.ok,
        summary: `Prometheus/OTel KPI metrics (${days}d window, ${summary.events} events)`,
        data: { summary, prometheus: prom },
        next: [],
        text: [prom.trimEnd()],
      };
    }
    const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(2)}%`);
    return {
      command: 'metrics report',
      ok: true,
      exitCode: EXIT.ok,
      summary: `KPIs (${days}d): ${summary.acceptedFixes} accepted fixes, revert rate ${pct(summary.revertRate)}, $${summary.totalUsd.toFixed(2)} total`,
      data: summary,
      next: [],
      text: [
        `Window:             ${summary.windowDays} days (${summary.events} events)`,
        `Accepted fixes:     ${summary.acceptedFixes}`,
        `Revert rate:        ${pct(summary.revertRate)} (${summary.revertedPrs} reverted)`,
        `Escaped defects:    ${summary.escapedDefects} (${pct(summary.escapedDefectRate)})`,
        `Rework rate:        ${pct(summary.postReviewReworkRate)}`,
        `Avg review time:    ${summary.avgHumanReviewMinutes === null ? 'n/a' : `${summary.avgHumanReviewMinutes.toFixed(1)} min`}`,
        `Cost / accepted:    ${summary.usdPerAcceptedChange === null ? 'n/a' : `$${summary.usdPerAcceptedChange.toFixed(2)}`}`,
      ],
    };
  }
  throw new UsageError(`Usage: ${CLI} metrics record|report (see ${CLI} help)`);
}

export function stopCommand(project: ProjectConfig, reason: string | undefined): Result {
  const order = issueStopOrder(project.root, reason ?? 'Operator issued emergency zero-writes stop');
  return {
    command: 'stop',
    ok: true,
    exitCode: EXIT.ok,
    summary: `ZERO-WRITES STOP ACTIVE: ${order.reason}`,
    data: order,
    next: [`${CLI} resume`],
  };
}

export function resumeCommand(project: ProjectConfig): Result {
  const order = clearStopOrder(project.root);
  return {
    command: 'resume',
    ok: true,
    exitCode: EXIT.ok,
    summary: 'Zero-writes stop order cleared; factory dispatches resumed',
    data: order,
    next: [`${CLI} factory status`],
  };
}

export async function factoryCommand(
  project: ProjectConfig,
  action: string | undefined,
  options: { host?: string; port?: number; source?: string; payloadFile?: string; sandbox?: string },
): Promise<Result> {
  if (action === 'status' || action === undefined) {
    const stopOrder = readStopOrder(project.root);
    const workers = [...latestWorkerStates(project.root).values()];
    return {
      command: 'factory status',
      ok: !stopOrder.stopped,
      exitCode: EXIT.ok,
      summary: `Factory ${stopOrder.stopped ? 'STOPPED' : 'READY'}: ${workers.length} tracked worker(s)`,
      data: { stopOrder, workers },
      next: stopOrder.stopped ? [`${CLI} resume`] : [`${CLI} factory audit`],
      text: [
        `State:   ${stopOrder.stopped ? `STOPPED (${stopOrder.reason ?? ''})` : 'READY'}`,
        `Workers: ${workers.length}`,
        ...workers.map((w) => `  ${w.state.padEnd(10)} ${w.workerId}  [${w.coordinator}]  branch=${w.branch}`),
      ],
    };
  }

  if (action === 'audit') {
    const report = auditWorkers(project.root, (row: WorkerTrailRow) => {
      const sha = capture('git', ['rev-parse', '--verify', '--quiet', row.branch], project.root, 5_000);
      return {
        commitSha: sha.code === 0 ? sha.out.trim() : row.lastCommitSha,
        artifactCount: row.lastArtifactCount,
        // Honest liveness: CLI audit without a container/PID runtime probe never fabricates processAlive: true.
        processAlive: false,
      };
    });
    return {
      command: 'factory audit',
      ok: true,
      exitCode: EXIT.ok,
      summary: `Factory side-effect audit: checked ${report.checked} worker(s)${report.stopped ? ' (STOPPED)' : ''}`,
      data: report,
      next: [],
      text: report.actions.map((a) => `${a.decision.padEnd(16)}  ${a.workerId}  ${a.reason}`),
    };
  }

  if (action === 'dispatch') {
    const stopOrder = readStopOrder(project.root);
    if (stopOrder.stopped) {
      return {
        command: 'factory dispatch',
        ok: false,
        exitCode: EXIT.failed,
        summary: `Blocked by zero-writes stop order: ${stopOrder.reason ?? 'stopped'}`,
        data: { stopOrder },
        next: [`${CLI} resume`],
      };
    }
    const maturity = inspectProjectMaturity(project.root, {
      servicesDir: project.servicesDir,
      reportsDir: project.reportsDir,
    });
    const gate = enforceMaturityGate(maturity, 5);
    if (!gate.allowed) {
      return {
        command: 'factory dispatch',
        ok: false,
        exitCode: EXIT.failed,
        summary: gate.reason,
        data: { maturity, gate },
        next: gate.blockers.slice(0, 3),
      };
    }
    if (!options.source || !options.payloadFile) {
      throw new UsageError(`Pass --source <github|slack|linear|...> --payload <file.json>`);
    }
    const payload = JSON.parse(readFileSync(resolve(project.root, options.payloadFile), 'utf8')) as Record<
      string,
      unknown
    >;
    const signal = normalizeSignal(options.source as SignalSource, payload);
    const framed = formatUntrustedSignalBrief(signal);
    if (!options.sandbox) {
      return {
        command: 'factory dispatch',
        ok: true,
        exitCode: EXIT.ok,
        summary: `Normalized ${signal.source} signal ${signal.id} -> coordinator "${signal.coordinator}" (normalize-only; pass --sandbox docker|local-worktree|ci-runner to prepare a worker sandbox)`,
        data: { mode: 'normalize-only', dispatched: false, signal, ...framed },
        next: [`${CLI} factory dispatch --source ${signal.source} --payload ${options.payloadFile} --sandbox docker`],
      };
    }
    const kind = options.sandbox;
    const backend =
      kind === 'docker'
        ? new DockerSandbox()
        : kind === 'local-worktree'
          ? new LocalWorktreeSandbox()
          : kind === 'ci-runner'
            ? new CiRunnerSandbox()
            : null;
    if (!backend) {
      throw new UsageError(`--sandbox must be docker, local-worktree, or ci-runner (got "${kind}")`);
    }
    const runId = `worker-${Date.now()}`;
    const branch = `factory/${runId}`;
    const handle = await backend.prepare({ projectRoot: project.root, runId, branch });
    const nowIso = new Date().toISOString();
    appendTrailRow(project.root, {
      workerId: runId,
      signalId: signal.id,
      branch,
      sandboxId: handle.id,
      coordinator: signal.coordinator,
      startedAt: nowIso,
      stuckAfterMs: 30 * 60 * 1000,
      lastCommitSha: null,
      lastArtifactCount: 0,
      lastSideEffectAt: nowIso,
      state: 'prepared',
      note: 'Sandbox prepared without launching an autonomous worker process',
    });
    return {
      command: 'factory dispatch',
      ok: true,
      exitCode: EXIT.ok,
      summary: `Prepared ${handle.backend} sandbox ${handle.id} on branch ${branch} for signal ${signal.id} (idle; no worker process launched)`,
      data: { mode: 'sandbox-prepared', dispatched: false, sandbox: handle, signal, ...framed },
      next: [`${CLI} factory status`, `${CLI} factory audit`],
    };
  }

  if (action === 'serve') {
    const controlToken = process.env.VGATE_FACTORY_TOKEN;
    if (!controlToken) {
      throw new UsageError(
        'Set VGATE_FACTORY_TOKEN before starting `vgate factory serve` so control endpoints (/stop, /resume, /audit) require authentication.',
      );
    }
    const webhookSecrets: Partial<Record<SignalSource, string>> = {};
    for (const source of ['github', 'gitlab', 'linear', 'jira', 'slack', 'sentry', 'post-release-fuzz'] as const) {
      const envKey = `VGATE_WEBHOOK_SECRET_${source.toUpperCase().replace(/-/g, '_')}`;
      const val = process.env[envKey] ?? process.env.VGATE_WEBHOOK_SECRET;
      if (val) webhookSecrets[source] = val;
    }
    const handle = createFactoryServer({
      projectRoot: project.root,
      host: options.host ?? project.factory?.host ?? '127.0.0.1',
      port: options.port ?? project.factory?.port ?? 8787,
      controlToken,
      webhookSecrets,
    });
    const started = await handle.start();
    process.stderr.write(`vgate factory control plane listening at ${started.url}\n`);
    await new Promise<void>((resolveStop) => {
      const shutdown = () => {
        void handle.stop().finally(resolveStop);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    return {
      command: 'factory serve',
      ok: true,
      exitCode: EXIT.ok,
      summary: `Factory server stopped (${started.url})`,
      data: started,
      next: [],
    };
  }

  throw new UsageError(`Usage: ${CLI} factory serve|status|audit|dispatch (see ${CLI} help)`);
}

export async function mcpCommand(project: ProjectConfig | undefined): Promise<Result> {
  const root = project?.root ?? process.cwd();
  const isCompiled = VERSION !== 'dev';
  const entryScript = resolve(process.argv[1] ?? join(root, 'cli', 'main.ts'));
  const tsxBin = join(root, 'node_modules', '.bin', 'tsx');
  const tools = createDefaultTools((cmd, args) => {
    const run = isCompiled
      ? capture(process.execPath, [cmd, ...args, '--json'], root, 120_000)
      : existsSync(tsxBin)
        ? capture(tsxBin, [entryScript, cmd, ...args, '--json'], root, 120_000)
        : capture('pnpm', ['exec', 'tsx', entryScript, cmd, ...args, '--json'], root, 120_000);
    try {
      return Promise.resolve(JSON.parse(run.out) as unknown);
    } catch {
      return Promise.resolve({ ok: run.code === 0, exitCode: run.code, output: run.out });
    }
  });
  const server = new VgateMcpServer(tools, { name: 'vgate', version: VERSION });
  await server.serveStdio();
  return { command: 'mcp', ok: true, exitCode: EXIT.ok, summary: 'MCP server closed', next: [] };
}

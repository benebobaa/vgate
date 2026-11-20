/**
 * `vgate decide`: the one verdict of a pull request. It works out which services the change affects and how risky it
 * is, reads the evidence the CI jobs left (every `verdict.json` and `guard.json` under `--evidence`), applies the
 * project's policy and answers:
 *
 *   blocked         an affected service has no complete, passing, current gate verdict (missing evidence never passes)
 *   needs-approval  the guard found weakened expectations (or did not run), a service was deleted, the change edits
 *                   the judge's own files (JUDGE_RISK, whatever the policy), or it is riskier than `policy.autoMerge`
 *                   allows
 *   merge           none of the above: a green gate may merge without a human
 *
 * With a `deploy:` block in vgate.yaml it also asks whether the change is safe to put next to what runs in each
 * environment (docs/deploy-safety.md): a contract that breaks the clients of the deployed version needs a human (or
 * blocks, per `deploy.policy.breaking`); a required configuration key an environment lacks blocks, since deploying
 * would fail; a deployed contract or config source that cannot be read needs a human, never passes.
 *
 * When a change adds to a service's migrations it needs that service's `vgate migrations` evidence: a migration that
 * does not apply or undo, or that breaks the deployed code on the migrated schema, blocks; a risky one needs a human;
 * no current evidence blocks (docs/deploy-safety.md).
 *
 * With `policy.mutationScore` in vgate.yaml, a change to a service's source code needs that service's `vgate mutate`
 * evidence: tests that catch fewer planted bugs than the policy asks, a score that could not be measured, or no current
 * evidence need a human (docs/mutation.md). Never a block: mutation measures the tests, not the code's correctness.
 *
 * It writes reports/decision.json (`vgate.decision/1`) and reports/decision.md, the pull-request comment: a person
 * who never reads code can see what was verified and why the change can or cannot merge.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { touchedMigrations } from '../framework/env/migrate.ts';
import type { Policy, ProjectConfig } from '../framework/project.ts';
import { GUARDRAILS_FILE, type LintReport } from '../packages/guardrails/index.ts';
import { buildReviewBundle, type ReviewBundle } from '../packages/verification/artifacts.ts';
import type { FlakeEvaluation } from '../packages/verification/flake.ts';
import { canCarryVerdict, computeSemanticPatchId } from '../packages/verification/patch-id.ts';
import { verifyEvidenceSignature, type SignedEnvelope } from '../packages/verification/signing.ts';
import { judgeVerifierReport, selectVerifierMode, type VerifierReport } from '../packages/verifier/swarm.ts';
import { changeSet, computeAffected, serviceMigrationDirs } from './affected.ts';
import { staleTree, treeState, type TreeState } from './commit.ts';
import { compatFor, serviceSources, type CompatResult } from './compat.ts';
import { configFor, describeMissing, type ConfigResult } from './config-check.ts';
import type { Verdict } from './gate.ts';
import { git, type Finding, type GuardReport } from './guard.ts';
import type { KnownFailureHit, TestFailure } from './junit.ts';
import type { MigrationsReport } from './migrations.ts';
import { mutationSources, servicePathsOf, type MutationReport } from './mutate.ts';
import { CLI, EXIT, UsageError, type Result } from './output.ts';
import { assessRisk, tierAbove, type RiskReport } from './risk.ts';

export const DECISION_FILE = 'reports/decision.json';
export const DECISION_MARKER = '<!-- vgate:decision -->';
const SHOWN = 10;

export type DecisionKind = 'merge' | 'needs-approval' | 'blocked';

export interface ServiceDecision {
  name: string;
  /** `deleted`: present at the base, gone now; it cannot be gated, only guarded. */
  change: 'affected' | 'deleted';
  gate: 'pass' | 'fail' | 'missing';
  /** Why the gate is not `pass`, in words. */
  gateDetail?: string;
  guard: 'auto' | 'needs-human' | 'missing';
  guardDetail?: string;
  tests?: { total: number; failed: number; knownFailures: number };
  coverage?: { covered: number; demanded: number };
  failures: TestFailure[];
  guardFindings: Finding[];
  knownFailures: KnownFailureHit[];
}

/**
 * Deploy safety per (affected service, environment). Computed by decide itself from the repository (git tags and
 * refs, the config files) or the live contract URL, not read from evidence: nothing a CI job could leave behind
 * stands in for it, and it needs no running stack.
 */
export interface DeploySafety {
  configured: boolean;
  breakingPolicy?: 'needs-approval' | 'block';
  checks: Array<{
    service: string;
    compat: CompatResult;
    config: ConfigResult;
    /** Config sources of the environment that the change itself edits (top-relative). */
    configEdited?: string[];
  }>;
}

/** A service whose migrations the change touches, judged from its `vgate migrations` evidence. */
export interface MigrationCheck {
  service: string;
  state: 'safe' | 'needs-approval' | 'blocked' | 'missing';
  /** The migration files the change touches (top-relative). */
  touched: string[];
  reasons: string[];
}

/** How well the tests catch bugs in a service's changed code, from its `vgate mutate` evidence. */
export interface MutationCheck {
  service: string;
  /**
   * pass: at or above policy.mutationScore (or no policy: shown for information); below: under it; unmeasured: no
   * mutant could be judged; missing: no current evidence. Only below, unmeasured and missing with a policy need a human.
   */
  state: 'pass' | 'below' | 'unmeasured' | 'missing';
  score: number | null;
  threshold?: number;
  killed: number;
  survived: number;
  reasons: string[];
  survivors: Array<{
    file: string;
    line: number;
    original: string;
    replacement: string;
    before: string;
    after: string;
    hint?: string;
  }>;
}

export interface VerifierCheck {
  state: 'pass' | 'pass-notes' | 'fail' | 'missing' | 'not-required';
  reasons: string[];
  mode?: VerifierReport['mode'];
  lanes?: number;
}

export interface Decision {
  schema: 'vgate.decision/1';
  decision: DecisionKind;
  reasons: string[];
  base: string;
  mergeBase: string;
  head: string;
  patchId?: string | null;
  policy: Policy;
  risk: RiskReport;
  services: ServiceDecision[];
  deploy: DeploySafety;
  migrations: MigrationCheck[];
  /** Absent in decisions written before `vgate mutate` existed. */
  mutation?: MutationCheck[];
  /** Independent live-app verifier result stacked fail-closed over deterministic gates. */
  verifier?: VerifierCheck;
  /** Flake policy evaluation when live-app flake telemetry is present. */
  flake?: FlakeEvaluation;
  /** Codebase guardrails lint report when present in evidence. */
  lint?: { ok: boolean; violations: number; baselined: number };
  /** Artifact-first review gallery metadata. */
  reviewBundle?: { file: string; artifacts: number };
  knownFailures: Array<KnownFailureHit & { service: string }>;
  changedFiles: number;
  detailsUrl?: string;
  /** Evidence files that were read, and ones that were not usable. */
  evidence: { read: string[]; ignored: string[] };
}

interface Evidence {
  verdicts: Map<string, Verdict & { file: string; patchId?: string | null }>;
  migrations: Map<string, MigrationsReport & { file: string }>;
  mutation: Map<string, MutationReport & { file: string }>;
  guards: Map<string, Array<GuardReport & { file: string }>>;
  verifier?: VerifierReport & { file: string };
  flake?: FlakeEvaluation & { file: string };
  lint?: LintReport & { file: string };
  signatureErrors: string[];
  read: string[];
  ignored: string[];
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.git' ? [] : walk(path);
    return [
      'verdict.json',
      'guard.json',
      'migrations.json',
      'mutation.json',
      'verifier.json',
      'flake.json',
      'lint.json',
    ].includes(entry.name)
      ? [path]
      : [];
  });
}

const FLAKE_RANK: Record<FlakeEvaluation['outcome'], number> = {
  pass: 0,
  quarantined: 1,
  'flaky-passed': 2,
  inconclusive: 3,
  fail: 4,
};

function unwrapSignedEvidence(
  raw: Record<string, unknown>,
  verifyKey: string | undefined,
  shown: string,
): { data?: Record<string, unknown>; sigError?: string } {
  const isEnvelope =
    raw.payload !== undefined &&
    typeof raw.payload === 'object' &&
    raw.payload !== null &&
    raw.signature !== undefined &&
    typeof raw.signature === 'object';
  if (isEnvelope) {
    if (!verifyKey) {
      return { sigError: `${shown}: signed evidence present but no VGATE_SIGNING key configured to verify it` };
    }
    const check = verifyEvidenceSignature(raw as unknown as SignedEnvelope<unknown>, {
      key: verifyKey,
      expectedIssuer: process.env.VGATE_EXPECTED_OIDC_ISSUER,
      expectedRepository: process.env.VGATE_EXPECTED_OIDC_REPO,
    });
    if (!check.ok) return { sigError: `${shown}: ${check.reason ?? 'signature verification failed'}` };
    return { data: raw.payload as Record<string, unknown> };
  }
  if (verifyKey) {
    return { sigError: `${shown}: unsigned evidence rejected (VGATE_SIGNING key is configured)` };
  }
  return { data: raw };
}

/**
 * Every verdict.json and guard.json under `dir`, keyed by service. Of two verdicts of one service the worse wins (a
 * failing or partial run over a complete pass), then the newer: an extra file that claims a pass, whatever date it
 * gives itself, cannot hide a failure.
 */
export function readEvidence(dir: string, cwd: string): Evidence {
  const verifyKey = process.env.VGATE_SIGNING_PUBLIC_KEY ?? process.env.VGATE_SIGNING_KEY;
  const evidence: Evidence = {
    verdicts: new Map(),
    guards: new Map(),
    migrations: new Map(),
    mutation: new Map(),
    signatureErrors: [],
    read: [],
    ignored: [],
  };
  for (const file of walk(dir).sort()) {
    const shown = relative(cwd, file) || file;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      evidence.ignored.push(`${shown} (not JSON)`);
      continue;
    }
    const unwrapped = unwrapSignedEvidence(raw, verifyKey, shown);
    if (unwrapped.sigError) {
      evidence.signatureErrors.push(unwrapped.sigError);
      evidence.ignored.push(unwrapped.sigError);
      continue;
    }
    const data = unwrapped.data!;
    if (data.schema === 'vgate.verifier/1') {
      const report = { ...(data as unknown as VerifierReport), file };
      // Fail-closed: FAIL wins over PASS+NOTES which wins over PASS.
      const rank = (v: VerifierReport['verdict']) => (v === 'FAIL' ? 2 : v === 'PASS+NOTES' ? 1 : 0);
      if (!evidence.verifier || rank(report.verdict) >= rank(evidence.verifier.verdict)) evidence.verifier = report;
      evidence.read.push(shown);
      continue;
    }
    if (data.schema === 'vgate.flake/1') {
      const report = { ...(data as unknown as FlakeEvaluation), file };
      // Fail-closed: worst outcome wins (fail > inconclusive > flaky-passed > quarantined > pass).
      if (!evidence.flake || (FLAKE_RANK[report.outcome] ?? 4) >= (FLAKE_RANK[evidence.flake.outcome] ?? 0)) {
        evidence.flake = report;
      }
      evidence.read.push(shown);
      continue;
    }
    if (data.schema === 'vgate.lint/1') {
      const report = { ...(data as unknown as LintReport), file };
      if (!evidence.lint || !report.ok) evidence.lint = report;
      evidence.read.push(shown);
      continue;
    }
    if (typeof data.service !== 'string' || data.service === '') {
      evidence.ignored.push(`${shown} (no service)`);
      continue;
    }
    if (data.schema === 'vgate.verdict/1') {
      const verdict = { ...(data as unknown as Verdict & { patchId?: string | null }), file };
      const previous = evidence.verdicts.get(verdict.service);
      const passed = (v: Verdict) => v.complete === true && v.verdict === 'pass';
      if (
        !previous ||
        (passed(previous) && !passed(verdict)) ||
        (passed(previous) === passed(verdict) && String(verdict.startedAt) > String(previous.startedAt))
      )
        evidence.verdicts.set(verdict.service, verdict);
      evidence.read.push(shown);
    } else if (data.schema === 'vgate.guard/1') {
      const report = { ...(data as unknown as GuardReport), file };
      evidence.guards.set(report.service, [...(evidence.guards.get(report.service) ?? []), report]);
      evidence.read.push(shown);
    } else if (data.schema === 'vgate.migrations/1') {
      const report = { ...(data as unknown as MigrationsReport), file };
      const previous = evidence.migrations.get(report.service);
      // The worse verdict wins: an extra file that claims `safe` cannot hide a blocked or risky migration.
      if (!previous || MIGRATION_WEIGHT[report.verdict] > MIGRATION_WEIGHT[previous.verdict])
        evidence.migrations.set(report.service, report);
      evidence.read.push(shown);
    } else if (data.schema === 'vgate.mutation/1') {
      const report = { ...(data as unknown as MutationReport), file };
      const previous = evidence.mutation.get(report.service);
      // The weaker result wins: an extra file that claims a high score cannot hide a low one.
      if (!previous || mutationRank(report) < mutationRank(previous)) evidence.mutation.set(report.service, report);
      evidence.read.push(shown);
    } else evidence.ignored.push(`${shown} (unknown schema ${String(data.schema)})`);
  }
  return evidence;
}

const MIGRATION_WEIGHT: Record<string, number> = { 'not-configured': 0, safe: 1, 'needs-approval': 2, blocked: 3 };

/**
 * Lower is weaker: unmeasured below any score; a score of null counts as -1. "Nothing to mutate" is the strongest
 * claim: a file making it never hides a measured score.
 */
function mutationRank(report: Pick<MutationReport, 'verdict' | 'counts'>): number {
  if (report.verdict === 'not-applicable') return Infinity;
  if (report.verdict === 'unmeasured') return -2;
  return report.counts?.score ?? -1;
}

/**
 * The test strength of a service whose source code the change touches, from its `vgate mutate` evidence. Evidence from
 * another merge base or another tree says nothing about this change: it counts as missing.
 */
export function judgeMutation(
  service: string,
  report: (MutationReport & { file?: string }) | undefined,
  mergeBase: string,
  now: TreeState,
  threshold: number | undefined,
): MutationCheck {
  const base = { service, score: null, threshold, killed: 0, survived: 0, survivors: [] };
  const missing = (why: string): MutationCheck => ({
    ...base,
    state: 'missing',
    reasons: [`${service}: test strength not measured: ${why}`],
  });
  if (!report) return missing(`no mutation evidence (run ${CLI} mutate --service ${service} --base <base>)`);
  if (report.mergeBase !== mergeBase) return missing('the evidence was measured against another base');
  const otherTree = staleTree(report.commit, now);
  if (otherTree) return missing(`the evidence is stale: ${otherTree}`);
  const counts = report.counts ?? { killed: 0, survived: 0, score: null };
  const survivors = (report.mutants ?? [])
    .filter((m) => m.status === 'survived')
    .map((m) => ({
      file: m.file,
      line: m.line,
      original: m.original,
      replacement: m.replacement,
      before: m.before,
      after: m.after,
      hint: m.hint,
    }));
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const judged = { ...base, score: counts.score, killed: counts.killed, survived: counts.survived, survivors };
  if (report.verdict === 'not-applicable') return { ...judged, state: 'pass', reasons: [] };
  if (counts.score === null)
    return {
      ...judged,
      state: 'unmeasured',
      reasons: [`${service}: no planted bug could be judged (${report.reasons?.[0] ?? 'see the report'})`],
    };
  if (threshold !== undefined && counts.score < threshold)
    return {
      ...judged,
      state: 'below',
      reasons: [
        `${service}: the tests caught ${counts.killed} of ${counts.killed + counts.survived} bugs planted in the changed code (${pct(counts.score)}), below policy.mutationScore ${pct(threshold)}`,
      ],
    };
  return { ...judged, state: 'pass', reasons: [] };
}

/**
 * The migrations a change touches in an affected service, judged from that service's `vgate migrations` evidence.
 * Evidence from another merge base or another tree (commit) says nothing about this change: it counts as missing.
 */
export function judgeMigrations(
  service: string,
  touched: string[],
  report: (MigrationsReport & { file?: string }) | undefined,
  mergeBase: string,
  now: TreeState,
): MigrationCheck {
  const missing = (why: string): MigrationCheck => ({
    service,
    state: 'missing',
    touched,
    reasons: [
      `${service}: the change touches ${touched.length} migration file${touched.length === 1 ? '' : 's'}, ${why}`,
    ],
  });
  if (!report) return missing(`but they were not verified (run ${CLI} migrations --service ${service} --base <base>)`);
  if (report.mergeBase !== mergeBase) return missing('and their verification ran against another base');
  const otherTree = staleTree(report.commit, now);
  if (otherTree) return missing(`and their verification is stale: ${otherTree}`);
  if (report.verdict === 'blocked' || report.verdict === 'needs-approval')
    return {
      service,
      state: report.verdict,
      touched,
      reasons: report.reasons.map((r) => `${service} migrations: ${r}`),
    };
  if (report.verdict !== 'safe') return missing(`but their verification says "${String(report.verdict)}"`);
  return { service, state: 'safe', touched, reasons: [] };
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A verdict computed against other expectations than the working tree's says nothing about this change. */
function staleExpectation(verdict: Verdict, root: string): string | undefined {
  for (const [path, hash] of Object.entries(verdict.expectations ?? {})) {
    const file = resolve(root, path);
    if (!existsSync(file)) return `${path} no longer exists`;
    if (sha256(file) !== hash) return `${path} changed after the gate ran`;
  }
  return undefined;
}

function judgeGate(
  verdict: (Verdict & { file: string; patchId?: string | null }) | undefined,
  root: string,
  now: TreeState,
  currentPatchId?: string | null,
): Pick<ServiceDecision, 'gate' | 'gateDetail'> {
  if (!verdict) return { gate: 'missing', gateDetail: 'no gate verdict in the evidence' };
  const stale = staleExpectation(verdict, root);
  if (stale) return { gate: 'missing', gateDetail: `the verdict is stale: ${stale}` };
  // A verdict from another commit (an earlier push, another branch) or a tree edited since says nothing about this one,
  // unless BOTH trees are clean (no uncommitted edits) and the semantic Patch-ID matches across a clean rebase.
  const otherTree = staleTree(verdict.commit, now);
  if (otherTree) {
    const cleanRebase = !now.dirty && verdict.commit?.dirty !== true;
    const carry = cleanRebase
      ? canCarryVerdict(
          { patchId: verdict.patchId, hasBuildOutputs: verdict.build !== undefined },
          { patchId: currentPatchId },
        )
      : { carry: false, reason: 'uncommitted changes prevent patch-id carry' };
    if (!carry.carry) return { gate: 'missing', gateDetail: `the verdict is stale: ${otherTree}` };
  }
  if (!verdict.complete)
    return { gate: 'missing', gateDetail: `partial run (${verdict.steps.map((s) => s.name).join(', ')} only)` };
  if (verdict.verdict !== 'pass') {
    const failed = verdict.steps.filter((s) => s.status === 'fail').map((s) => s.name);
    return { gate: 'fail', gateDetail: `failed: ${failed.join(', ') || 'see the verdict'}` };
  }
  if (!verdict.commit || verdict.commit.sha === null)
    return {
      gate: 'pass',
      gateDetail: 'not bound to a commit (the gate ran outside git): checked by the expectation hashes only',
    };
  return { gate: 'pass' };
}

function commitOf(top: string, ref: string): string | undefined {
  const run = git(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return run.code === 0 ? run.out.trim() : undefined;
}

function judgeGuard(
  reports: Array<GuardReport & { file: string }> | undefined,
  top: string,
  base: string,
  now: TreeState,
): Pick<ServiceDecision, 'guard' | 'guardDetail' | 'guardFindings'> {
  if (!reports || reports.length === 0)
    return { guard: 'missing', guardDetail: 'the guard did not run', guardFindings: [] };
  const want = commitOf(top, base);
  // A guard run against another base compared the expectations with something else than this change's base.
  const sameBase = reports.filter((r) => want !== undefined && commitOf(top, r.base) === want);
  if (sameBase.length === 0)
    return {
      guard: 'missing',
      guardDetail: `the guard ran against another base (${[...new Set(reports.map((r) => r.base))].join(', ')})`,
      guardFindings: [],
    };
  // And on this change's head: a report from an earlier push judged other expectations than the ones here.
  const current = sameBase.filter((r) => staleTree(r.head, now) === undefined);
  if (current.length === 0)
    return {
      guard: 'missing',
      guardDetail: `the guard report is stale: ${staleTree(sameBase[0].head, now) ?? 'another head'}`,
      guardFindings: [],
    };
  // The same report can reach the evidence twice (an artifact downloaded into two folders): count each finding once.
  const seen = new Set<string>();
  const findings = current
    .flatMap((r) => r.findings ?? [])
    .filter((f) => {
      const key = `${f.rule}\0${f.file}\0${f.detail}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
  if (current.some((r) => r.decision !== 'auto') || findings.length > 0)
    return { guard: 'needs-human', guardFindings: findings };
  return { guard: 'auto', guardFindings: [] };
}

export interface DecideOptions {
  base: string | undefined;
  evidence: string | undefined;
  detailsUrl?: string;
}

/** The decision itself: pure over its inputs, so the rules can be tested without CI. */
export function decideFrom(input: {
  affected: string[];
  risk: RiskReport;
  policy: Policy;
  services: ServiceDecision[];
  deploy?: DeploySafety;
  migrations?: MigrationCheck[];
  mutation?: MutationCheck[];
  verifier?: VerifierCheck;
  flake?: FlakeEvaluation;
  lint?: { ok: boolean; violations: number };
  signatureErrors?: string[];
}): { decision: DecisionKind; reasons: string[] } {
  const reasons: string[] = [];
  const affected = input.services.filter((s) => s.change === 'affected');
  const notGreen = affected.filter((s) => s.gate !== 'pass');
  const checks = input.deploy?.checks ?? [];
  const block = input.deploy?.breakingPolicy === 'block';
  const blocked = [
    ...(input.signatureErrors ?? []),
    ...(input.lint && !input.lint.ok ? [`guardrails lint failed (${input.lint.violations} violation(s))`] : []),
    ...notGreen.map((s) => `${s.name}: gate ${s.gate === 'fail' ? 'failed' : 'evidence missing'} (${s.gateDetail})`),
    // Deploying would fail: the code needs a setting the environment does not have.
    ...checks.filter((c) => c.config.state === 'missing').map((c) => describeMissing(c.service, c.config)),
    ...(block ? checks.filter((c) => c.compat.state === 'breaking').map((c) => breakingReason(c)) : []),
    // A migration that does not apply, cannot be undone or breaks the running version; or one nobody verified.
    ...(input.migrations ?? []).filter((m) => m.state === 'blocked' || m.state === 'missing').flatMap((m) => m.reasons),
    // Stacked fail-closed AI verifier: FAIL or missing required verifier blocks; PASS can never override red gates.
    ...(input.verifier && (input.verifier.state === 'fail' || input.verifier.state === 'missing')
      ? input.verifier.reasons
      : []),
    ...(input.flake && input.flake.outcome === 'fail' ? input.flake.reasons : []),
  ];
  if (blocked.length > 0) return { decision: 'blocked', reasons: blocked };
  if (input.verifier && input.verifier.state === 'pass-notes') reasons.push(...input.verifier.reasons);
  if (input.flake && input.flake.outcome === 'inconclusive')
    reasons.push(
      ...(input.flake.reasons.length > 0
        ? input.flake.reasons
        : ['live-app verification was inconclusive due to unquarantined flaky test(s)']),
    );
  for (const c of checks) {
    if (c.compat.state === 'breaking') reasons.push(breakingReason(c));
    if (c.compat.state === 'unknown')
      reasons.push(
        `${c.service} → ${c.compat.environment}: compatibility with the deployed version was not checked (${c.compat.note})`,
      );
    // The change wrote the declaration it is checked against: only a person can say the setting really exists there.
    if (c.configEdited && c.configEdited.length > 0)
      reasons.push(
        `${c.service} → ${c.config.environment}: the change edits ${c.configEdited.join(', ')}, which declares what ${c.config.environment} provides: a person confirms the settings exist there`,
      );
    if (c.config.state === 'unknown')
      reasons.push(
        `${c.service} → ${c.config.environment}: the environment's configuration was not checked (${c.config.notes[0] ?? 'unreadable'})`,
      );
  }
  for (const m of input.migrations ?? []) if (m.state === 'needs-approval') reasons.push(...m.reasons);
  // Weak or unmeasured tests need a person only where the project asks for a score (policy.mutationScore).
  if (input.policy.mutationScore !== undefined)
    for (const m of input.mutation ?? []) if (m.state !== 'pass') reasons.push(...m.reasons);
  for (const s of input.services) {
    if (s.change === 'deleted') reasons.push(`${s.name}: the service was deleted, with all its expectations`);
    if (s.guard === 'needs-human')
      reasons.push(
        `${s.name}: the guard found ${s.guardFindings.length} weakened expectation${s.guardFindings.length === 1 ? '' : 's'}`,
      );
    else if (s.guard === 'missing') reasons.push(`${s.name}: ${s.guardDetail}`);
  }
  const judge = input.risk.matches.filter((m) => m.judge).map((m) => m.file);
  if (judge.length > 0)
    reasons.push(
      `the change edits the files that decide how changes are judged (${judge.slice(0, 3).join(', ')}${judge.length > 3 ? ` +${judge.length - 3}` : ''}): a person approves this whatever policy.autoMerge says`,
    );
  // Taste vs. Mechanical boundary: user-facing UX/UI changes always require human taste & dogfooding approval.
  const uxFiles = input.risk.matches.filter((m) => m.ux).map((m) => m.file);
  if (uxFiles.length > 0)
    reasons.push(
      `the change touches user-facing UX/UI files (${uxFiles.slice(0, 3).join(', ')}${uxFiles.length > 3 ? ` +${uxFiles.length - 3}` : ''}): requires human taste and dogfooding approval`,
    );
  if (tierAbove(input.risk.tier, input.policy.autoMerge))
    reasons.push(
      input.policy.autoMerge === 'none'
        ? `policy: every change needs a human (policy.autoMerge: none in vgate.yaml)`
        : `risk ${input.risk.tier} is above what may merge alone (policy.autoMerge: ${input.policy.autoMerge})`,
    );
  if (reasons.length > 0) return { decision: 'needs-approval', reasons };
  if (input.affected.length === 0) return { decision: 'merge', reasons: ['no service is affected by this change'] };
  return {
    decision: 'merge',
    reasons: [
      `${affected.length} affected service${affected.length === 1 ? '' : 's'} verified; no expectation weakened; risk ${input.risk.tier}`,
    ],
  };
}

function breakingReason(c: DeploySafety['checks'][number]): string {
  const n = c.compat.breaking.length;
  return `${c.service} → ${c.compat.environment}: breaks ${n} thing${n === 1 ? '' : 's'} that clients of the deployed version (${c.compat.source}) rely on: ${c.compat.breaking[0]}${n > 1 ? ' …' : ''}`;
}

const PLAIN: Record<string, string> = {
  'contract-breaking': 'The API contract loses or narrows something clients may rely on',
  'plan-weakened': 'The test plan drops or excludes a scenario',
  'config-loosened': 'A verification rule was relaxed',
  'known-failure-added': 'A failure is newly tolerated',
  'tests-weakened': 'Tests were removed or now check less',
  'machinery-changed': 'The verification setup itself changed',
};

/**
 * Text that reaches the comment from names and messages (service and file names, scenario titles, failure messages:
 * all of them under the pull request's control) is shown as text, never as markup: no raw HTML, no links or images,
 * no table or line breaks, no @mentions, and no second `<!-- vgate:decision -->` marker.
 */
export function mdText(value: unknown): string {
  return String(value)
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]#!|~]/g, (char) => `\\${char}`)
    .replace(/@/g, '@\u200b');
}

/** A code span that holds any text: a fence longer than the longest backtick run in it, on one line. */
export function mdCode(value: unknown): string {
  // Literal inside the span, but kept from spelling the comment marker, which finds the comment to update.
  const text = String(value)
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
    .replace(/<!--/g, '<!-\u200b-');
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || text === '' ? ' ' : '';
  // A pipe splits a table cell even inside a code span; these spans are only used outside tables, so it stays.
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** "Safe to deploy": per affected service and environment, in words; one line when it is not configured. */
function renderDeploy(deploy: DeploySafety | undefined): string[] {
  if (!deploy || !deploy.configured)
    return ['**Safe to deploy:** not checked (no `deploy:` in vgate.yaml, see docs/deploy-safety.md)', ''];
  if (deploy.checks.length === 0) return ['**Safe to deploy:** no affected service to check', ''];
  const lines = ['**Safe to deploy**', ''];
  for (const { service, compat, config } of deploy.checks) {
    const contract = {
      compatible: `✅ compatible with what runs there${compat.source ? ` (${mdText(compat.source)})` : ''}`,
      breaking: `❌ breaks clients of the deployed version (${mdText(compat.source ?? '?')})`,
      unknown: `⚪ contract not checked: ${mdText(compat.note ?? 'unknown')}`,
      'not-configured': '➖ contract: no source configured',
    }[compat.state];
    const settings = {
      complete: `✅ all ${config.required.length} required settings present`,
      missing: `❌ missing settings: ${config.missing.map((k) => mdCode(k)).join(', ')}`,
      unknown: `⚪ settings not checked: ${mdText(config.notes[0] ?? 'unknown')}`,
      'not-configured': '➖ settings: nothing declared',
    }[config.state];
    lines.push(`- ${mdText(service)} → ${mdText(compat.environment)}: ${contract}; ${settings}`);
    for (const b of compat.breaking.slice(0, 5)) lines.push(`  - breaks: ${mdText(b)}`);
    if (compat.breaking.length > 5) lines.push(`  - … and ${compat.breaking.length - 5} more`);
    if (compat.note && compat.state === 'compatible') lines.push(`  - ${mdText(compat.note)}`);
    for (const k of config.newlyRequired) lines.push(`  - ${mdCode(k)} is newly required by this change`);
  }
  lines.push('');
  return lines;
}

/** The migrations of the change: what was checked, in words. Nothing when the change touches none. */
function renderMigrations(checks: MigrationCheck[]): string[] {
  if (checks.length === 0) return [];
  const lines = ['**Database migrations**', ''];
  for (const m of checks) {
    const state = {
      safe: '✅ apply, undo, and the deployed version keeps working on the new schema',
      'needs-approval': '🟡 risky for the running version, or not fully verified: a person decides',
      blocked: '❌ not safe to deploy',
      missing: '⚪ not verified',
    }[m.state];
    lines.push(`- ${mdText(m.service)} (${m.touched.length} file${m.touched.length === 1 ? '' : 's'}): ${state}`);
    for (const r of m.reasons.slice(0, 5)) lines.push(`  - ${mdText(r)}`);
  }
  lines.push('');
  return lines;
}

/** How well the tests catch bugs in the changed code; nothing when it was neither required nor measured. */
function renderMutation(checks: MutationCheck[], threshold: number | undefined): string[] {
  if (checks.length === 0) return [];
  const pct = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${Math.round(n * 100)}%`);
  const lines = [
    `**Test strength** (bugs planted in the changed code that the tests caught${threshold !== undefined ? `; policy ${pct(threshold)}` : ''})`,
    '',
  ];
  for (const m of checks) {
    const state = {
      pass: `✅ ${pct(m.score)} (${m.killed} of ${m.killed + m.survived})`,
      below: `🟡 ${pct(m.score)} (${m.killed} of ${m.killed + m.survived}): below the policy`,
      unmeasured: '⚪ not measured: no planted bug could be judged',
      missing: '⚪ not measured',
    }[m.state];
    lines.push(`- ${mdText(m.service)}: ${state}`);
    if (m.state === 'missing' || m.state === 'unmeasured') for (const r of m.reasons) lines.push(`  - ${mdText(r)}`);
    // The change itself, not the whole line: `>=` → `>` at the place, and what scenario would have caught it.
    for (const s of m.survivors.slice(0, 5))
      lines.push(
        `  - survived ${mdCode(`${s.file}:${s.line}`)}: ${mdCode(s.original)} → ${mdCode(s.replacement === '' ? '(removed)' : s.replacement)}${s.hint ? ` (${mdText(s.hint.replace(/^.*?: /, ''))})` : ''}`,
      );
    if (m.survivors.length > 5) lines.push(`  - … and ${m.survivors.length - 5} more survivors (see the details)`);
  }
  lines.push('');
  return lines;
}

export function renderMarkdown(d: Decision): string {
  const banner =
    d.decision === 'merge'
      ? `### ✅ Verified: may merge`
      : d.decision === 'needs-approval'
        ? `### 🟡 Needs a human approval`
        : `### ❌ Blocked`;
  const lines = [DECISION_MARKER, banner, '', ...d.reasons.map((r) => `- ${mdText(r)}`), ''];
  if (d.services.length > 0) {
    lines.push('| Service | Gate | Tests | Coverage | Guard |', '| --- | --- | --- | --- | --- |');
    for (const s of d.services) {
      const gate = { pass: '✅ pass', fail: '❌ fail', missing: '⚪ missing' }[s.gate];
      const guard = { auto: '✅ nothing weakened', 'needs-human': '🟡 needs a human', missing: '⚪ did not run' }[
        s.guard
      ];
      const tests = s.tests
        ? `${s.tests.total - s.tests.failed - s.tests.knownFailures} passed, ${s.tests.failed} failed` +
          (s.tests.knownFailures > 0 ? `, ${s.tests.knownFailures} known` : '')
        : '-';
      const coverage = s.coverage ? `${s.coverage.covered}/${s.coverage.demanded}` : '-';
      lines.push(
        `| ${mdText(s.name)}${s.change === 'deleted' ? ' (deleted)' : ''} | ${gate} | ${tests} | ${coverage} | ${guard} |`,
      );
    }
    lines.push('');
  }
  lines.push(...renderDeploy(d.deploy));
  lines.push(...renderMigrations(d.migrations ?? []));
  lines.push(...renderMutation(d.mutation ?? [], d.policy.mutationScore));
  if (d.lint) {
    lines.push(
      `**Guardrails lint**: ${d.lint.ok ? '✅ pass' : `❌ fail (${d.lint.violations} violation(s))`} (${d.lint.baselined} baselined)`,
      '',
    );
  }
  if (d.verifier && d.verifier.state !== 'not-required') {
    const icon = d.verifier.state === 'pass' ? '✅' : d.verifier.state === 'pass-notes' ? '🟡' : '❌';
    lines.push(
      `**Independent verifier**: ${icon} ${mdText(d.verifier.state)}${d.verifier.mode ? ` (${mdText(d.verifier.mode)}, ${d.verifier.lanes ?? 0} lane(s))` : ''}`,
      '',
    );
  }
  if (d.flake && d.flake.outcome !== 'pass') {
    lines.push(`**Flake policy**: ${mdText(d.flake.outcome)}`, '');
  }
  for (const s of d.services.filter((x) => x.failures.length > 0 || (x.gate !== 'pass' && x.gateDetail))) {
    lines.push(`**${mdText(s.name)}: what failed**`, '');
    if (s.gateDetail) lines.push(`- ${mdText(s.gateDetail)}`);
    for (const f of s.failures.slice(0, SHOWN))
      lines.push(
        `- ${f.id ? `${mdCode(f.id)} ` : ''}${mdCode(`${f.file}${f.line ? `:${f.line}` : ''}`)}: ${mdText(f.message)}`,
      );
    if (s.failures.length > SHOWN) lines.push(`- … and ${s.failures.length - SHOWN} more (see the details)`);
    lines.push('');
  }
  const findings = d.services.flatMap((s) => s.guardFindings.map((f) => ({ ...f, service: s.name })));
  if (findings.length > 0) {
    lines.push('**What a human must look at**', '');
    for (const f of findings.slice(0, 25))
      lines.push(`- ${PLAIN[f.rule] ?? mdText(f.rule)} (${mdText(f.service)}, ${mdCode(f.file)}): ${mdText(f.detail)}`);
    if (findings.length > 25) lines.push(`- … and ${findings.length - 25} more`);
    lines.push('');
  }
  if (d.risk.matches.length > 0) {
    lines.push(
      `**Risk: ${d.risk.tier}** (${d.risk.rules === 'built-in' ? 'built-in rules' : 'rules in vgate.yaml'})`,
      '',
    );
    for (const m of d.risk.matches.slice(0, 15))
      lines.push(`- ${m.tier}: ${mdCode(m.file)}${m.reason ? ` (${mdText(m.reason)})` : ''}`);
    if (d.risk.matches.length > 15) lines.push(`- … and ${d.risk.matches.length - 15} more`);
    lines.push('');
  }
  if (d.knownFailures.length > 0) {
    lines.push('**Known failures tolerated** (each has a ticket and an expiry date)', '');
    for (const k of d.knownFailures.slice(0, SHOWN))
      lines.push(`- ${mdCode(k.id)} (${mdText(k.service)}): ${mdText(k.ticket)}`);
    lines.push('');
  }
  const footer = [`${d.changedFiles} changed files`, `base ${mdText(d.base)}`, `head ${mdText(d.head)}`];
  // The details link comes from the CI job (--details-url), not from the change; only an http(s) URL becomes a link.
  if (d.detailsUrl && /^https?:\/\/[^\s()<>]+$/.test(d.detailsUrl))
    footer.push(`[evidence and reports](${d.detailsUrl})`);
  lines.push(`<sub>vgate · ${footer.join(' · ')}</sub>`, '');
  return lines.join('\n');
}

/** Compatibility and configuration of every affected service in every environment of `deploy:`. */
export async function deploySafety(
  project: ProjectConfig,
  services: string[],
  mergeBase: string,
  /** The change's files (top-relative) and top level, to tell which config sources it edits. */
  change?: { files: string[]; top: string },
): Promise<DeploySafety> {
  if (!project.deploy) return { configured: false, checks: [] };
  const checks: DeploySafety['checks'] = [];
  for (const service of services) {
    const sources = serviceSources(project, service);
    for (const env of project.deploy.environments) {
      const compat: CompatResult =
        'error' in sources
          ? { environment: env.name, state: 'unknown', breaking: [], additive: [], note: sources.error }
          : await compatFor(sources, env);
      const configEdited = change
        ? env.config
            .map((source) =>
              relative(change.top, join(realpathSync(project.root), source.file))
                .split('\\')
                .join('/'),
            )
            .filter((file) => change.files.includes(file))
        : [];
      checks.push({ service, compat, config: configFor(project, service, env, mergeBase), configEdited });
    }
  }
  return { configured: true, breakingPolicy: project.deploy.policy.breaking, checks };
}

export async function decide(project: ProjectConfig, options: DecideOptions): Promise<Result> {
  if (!options.evidence)
    throw new UsageError(
      `Pass --evidence <dir>: where the gate and guard reports are, e.g. ${CLI} decide --base origin/main --evidence reports`,
    );
  const evidenceDir = resolve(options.evidence);
  if (!existsSync(evidenceDir)) throw new UsageError(`No evidence directory at ${evidenceDir}`);
  const jsonFile = join(project.reportsDir, 'decision.json');
  const mdFile = join(project.reportsDir, 'decision.md');
  // An earlier decision (or one committed with the change) must not outlive a run that stops before deciding.
  for (const file of [jsonFile, mdFile]) rmSync(file, { force: true });
  const change = changeSet(project, options.base);
  if ('result' in change) return { ...change.result, command: 'decide' };
  // Security invariant: read trunk's vgate.yaml & guardrails.yaml presence from change.mergeBase when judging a PR so
  // PR edits to vgate.yaml or deleting guardrails.yaml cannot downgrade hard-blocked gates into needs-approval.
  const relProject = relative(change.top, realpathSync(project.root)).split('\\').join('/');
  const projectPrefix = relProject === '' ? '' : `${relProject}/`;
  const trunkVgateRun = git(change.top, ['show', `${change.mergeBase}:${projectPrefix}vgate.yaml`]);
  const trunkVgate =
    trunkVgateRun.code === 0
      ? (() => {
          try {
            const parsed: unknown = parseYaml(trunkVgateRun.out);
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined;
  const effectivePolicy: Policy = (() => {
    const tp = trunkVgate?.policy;
    if (tp && typeof tp === 'object' && !Array.isArray(tp)) {
      const r = tp as Record<string, unknown>;
      const am = r.autoMerge;
      const autoMerge: Policy['autoMerge'] =
        am === 'none' || am === 'low' || am === 'medium' || am === 'high' ? am : project.policy.autoMerge;
      const ms = typeof r.mutationScore === 'number' ? r.mutationScore : project.policy.mutationScore;
      return { autoMerge, ...(ms !== undefined ? { mutationScore: ms } : {}) };
    }
    return project.policy;
  })();
  const effectiveUxPaths =
    Array.isArray(trunkVgate?.uxPaths) && trunkVgate.uxPaths.every((p): p is string => typeof p === 'string')
      ? trunkVgate.uxPaths
      : project.uxPaths;
  const trunkVerifier =
    trunkVgate?.verifier && typeof trunkVgate.verifier === 'object' && !Array.isArray(trunkVgate.verifier)
      ? (trunkVgate.verifier as Record<string, unknown>)
      : undefined;
  const effectiveVerifierRequired =
    typeof trunkVerifier?.required === 'boolean' ? trunkVerifier.required : project.verifier?.required === true;
  const effectiveWordingGlobs =
    Array.isArray(trunkVerifier?.wordingOnlyGlobs) &&
    trunkVerifier.wordingOnlyGlobs.every((g): g is string => typeof g === 'string')
      ? trunkVerifier.wordingOnlyGlobs
      : project.verifier?.wordingOnlyGlobs;
  const guardrailsOnTrunk =
    git(change.top, ['cat-file', '-e', `${change.mergeBase}:${projectPrefix}${GUARDRAILS_FILE}`]).code === 0;

  const affected = computeAffected(project, change);
  const risk = assessRisk(change.files, project.risk, effectiveUxPaths);
  const evidence = readEvidence(evidenceDir, process.cwd());
  // The tree this decision is about; the evidence directory is vgate's own input, not part of the change.
  const now = treeState(project, [evidenceDir]);
  const semanticPatch = computeSemanticPatchId(change.top, change.mergeBase);

  const services: ServiceDecision[] = [
    ...affected.services.map(({ name }) => ({ name, change: 'affected' as const })),
    ...affected.deleted.map((name) => ({ name, change: 'deleted' as const })),
  ].map(({ name, change: kind }) => {
    const verdict = evidence.verdicts.get(name);
    const gate =
      kind === 'deleted'
        ? { gate: 'missing' as const, gateDetail: 'deleted: nothing to run' }
        : judgeGate(verdict, project.root, now, semanticPatch.patchId);
    const usable = gate.gate !== 'missing' ? verdict : undefined;
    return {
      name,
      change: kind,
      ...gate,
      ...judgeGuard(evidence.guards.get(name), change.top, change.base, now),
      tests: usable?.tests
        ? {
            total: usable.tests.total,
            failed: usable.tests.failed,
            knownFailures: usable.tests.knownFailures?.length ?? 0,
          }
        : undefined,
      coverage: usable?.coverage ? { covered: usable.coverage.covered, demanded: usable.coverage.demanded } : undefined,
      failures: usable?.tests?.failures ?? [],
      knownFailures: usable?.tests?.knownFailures ?? [],
    };
  });

  const repoGuardReports = evidence.guards.get('_repo');
  if (repoGuardReports && repoGuardReports.length > 0) {
    const repoJudged = judgeGuard(repoGuardReports, change.top, change.base, now);
    if (repoJudged.guard !== 'auto') {
      services.push({
        name: '_repo',
        change: 'affected',
        gate: 'pass',
        ...repoJudged,
        failures: [],
        knownFailures: [],
      });
    }
  }

  const deploy = await deploySafety(
    project,
    affected.services.map((s) => s.name),
    change.mergeBase,
    change,
  );
  const migrations: MigrationCheck[] = [];
  for (const { name } of affected.services) {
    // The directories of now and of the base: moving `migrate.dir` or dropping `migrate:` hides no migration.
    const touched = touchedMigrations(change.files, serviceMigrationDirs(project, change, name));
    if (touched.length > 0)
      migrations.push(judgeMigrations(name, touched, evidence.migrations.get(name), change.mergeBase, now));
  }
  // Test strength: required with policy.mutationScore, shown whenever a service's changed source was measured.
  const mutation: MutationCheck[] = [];
  for (const { name } of affected.services) {
    const report = evidence.mutation.get(name);
    if (project.policy.mutationScore === undefined && !report) continue;
    let sources: string[];
    try {
      sources = mutationSources(project, change, { name, paths: servicePathsOf(project, name) });
    } catch {
      sources = change.files; // an unreadable service.yaml: assume its code changed rather than skip the check
    }
    if (sources.length > 0)
      mutation.push(judgeMutation(name, report, change.mergeBase, now, project.policy.mutationScore));
  }
  const verifierRequired = effectiveVerifierRequired;
  const allowSkip =
    selectVerifierMode({
      changedFiles: change.files,
      wordingOnlyGlobs: effectiveWordingGlobs,
    }).mode === 'skip';
  const verifierJudged =
    verifierRequired || evidence.verifier
      ? {
          ...judgeVerifierReport(evidence.verifier, now.sha, semanticPatch.patchId, verifierRequired, {
            allowSkip,
            expectedTreeFingerprint: now.fingerprint,
          }),
          mode: evidence.verifier?.mode,
          lanes: evidence.verifier?.lanes.length,
        }
      : undefined;
  const guardrailsConfigured = guardrailsOnTrunk || existsSync(join(project.root, GUARDRAILS_FILE));
  const lintSummary = evidence.lint
    ? {
        ok: evidence.lint.ok,
        violations: evidence.lint.violations.filter((v) => v.severity === 'error').length,
        baselined: evidence.lint.baselined,
      }
    : guardrailsConfigured
      ? { ok: false, violations: 1, baselined: 0 }
      : undefined;
  const extraBlockers =
    guardrailsConfigured && !evidence.lint
      ? [`${GUARDRAILS_FILE} is configured, but lint evidence (lint.json) is missing: run ${CLI} lint`]
      : [];

  const { decision, reasons } = decideFrom({
    affected: affected.services.map((s) => s.name),
    risk,
    policy: effectivePolicy,
    services,
    deploy,
    migrations,
    mutation,
    verifier: verifierJudged,
    flake: evidence.flake,
    lint: lintSummary,
    signatureErrors: [...evidence.signatureErrors, ...extraBlockers],
  });
  const headSha = git(change.top, ['rev-parse', '--short', 'HEAD']).out.trim() || 'unknown';
  const dirty = git(change.top, ['status', '--porcelain']).out.trim() !== '';

  // Artifact-first review bundle (screenshots, videos, traces, statecharts, benchmarks, verifier receipts).
  const bundle: ReviewBundle = buildReviewBundle(evidenceDir);
  const bundleFile = join(project.reportsDir, 'review-bundle.json');
  mkdirSync(project.reportsDir, { recursive: true });
  writeFileSync(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);

  const result: Decision = {
    schema: 'vgate.decision/1',
    decision,
    reasons,
    base: change.base,
    mergeBase: change.mergeBase,
    head: dirty ? `${headSha}+uncommitted` : headSha,
    patchId: semanticPatch.patchId,
    policy: project.policy,
    risk,
    services,
    deploy,
    migrations,
    mutation,
    ...(verifierJudged ? { verifier: verifierJudged } : {}),
    ...(evidence.flake ? { flake: evidence.flake } : {}),
    ...(lintSummary ? { lint: lintSummary } : {}),
    reviewBundle: { file: relative(project.root, bundleFile) || bundleFile, artifacts: bundle.artifacts.length },
    knownFailures: services.flatMap((s) => s.knownFailures.map((k) => ({ ...k, service: s.name }))),
    changedFiles: change.files.length,
    detailsUrl: options.detailsUrl,
    evidence: { read: evidence.read, ignored: evidence.ignored },
  };

  writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`);
  const rendered =
    bundle.artifacts.length > 0 ? `${renderMarkdown(result)}\n${bundle.markdown}\n` : renderMarkdown(result);
  writeFileSync(mdFile, rendered);

  const blockedOn = services.filter((s) => s.change === 'affected' && s.gate !== 'pass').map((s) => s.name);
  return {
    command: 'decide',
    ok: decision === 'merge',
    exitCode: decision === 'merge' ? EXIT.ok : EXIT.failed,
    summary: `DECISION ${decision}: ${reasons[0] ?? ''}${reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ''}`,
    data: result,
    next:
      decision === 'blocked'
        ? blockedOn.map((name) => `${CLI} gate --service ${name}`)
        : decision === 'needs-approval'
          ? [`a human reviews ${relative(process.cwd(), mdFile) || mdFile} and approves`]
          : [],
    text: [...reasons.map((r) => `- ${r}`), `Comment: ${relative(process.cwd(), mdFile) || mdFile}`],
  };
}

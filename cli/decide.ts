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
 * It writes reports/decision.json (`vgate.decision/1`) and reports/decision.md, the pull-request comment: a person
 * who never reads code can see what was verified and why the change can or cannot merge.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Policy, ProjectConfig } from '../framework/project.ts';
import { changeSet, computeAffected } from './affected.ts';
import { staleTree, treeState, type TreeState } from './commit.ts';
import type { Verdict } from './gate.ts';
import { git, type Finding, type GuardReport } from './guard.ts';
import type { KnownFailureHit, TestFailure } from './junit.ts';
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

export interface Decision {
  schema: 'vgate.decision/1';
  decision: DecisionKind;
  reasons: string[];
  base: string;
  mergeBase: string;
  head: string;
  policy: Policy;
  risk: RiskReport;
  services: ServiceDecision[];
  knownFailures: Array<KnownFailureHit & { service: string }>;
  changedFiles: number;
  detailsUrl?: string;
  /** Evidence files that were read, and ones that were not usable. */
  evidence: { read: string[]; ignored: string[] };
}

interface Evidence {
  verdicts: Map<string, Verdict & { file: string }>;
  guards: Map<string, Array<GuardReport & { file: string }>>;
  read: string[];
  ignored: string[];
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.git' ? [] : walk(path);
    return entry.name === 'verdict.json' || entry.name === 'guard.json' ? [path] : [];
  });
}

/**
 * Every verdict.json and guard.json under `dir`, keyed by service. Of two verdicts of one service the worse wins (a
 * failing or partial run over a complete pass), then the newer: an extra file that claims a pass, whatever date it
 * gives itself, cannot hide a failure.
 */
export function readEvidence(dir: string, cwd: string): Evidence {
  const evidence: Evidence = { verdicts: new Map(), guards: new Map(), read: [], ignored: [] };
  for (const file of walk(dir).sort()) {
    const shown = relative(cwd, file) || file;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      evidence.ignored.push(`${shown} (not JSON)`);
      continue;
    }
    if (typeof data.service !== 'string' || data.service === '') {
      evidence.ignored.push(`${shown} (no service)`);
      continue;
    }
    if (data.schema === 'vgate.verdict/1') {
      const verdict = { ...(data as unknown as Verdict), file };
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
    } else evidence.ignored.push(`${shown} (unknown schema ${String(data.schema)})`);
  }
  return evidence;
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
  verdict: (Verdict & { file: string }) | undefined,
  root: string,
  now: TreeState,
): Pick<ServiceDecision, 'gate' | 'gateDetail'> {
  if (!verdict) return { gate: 'missing', gateDetail: 'no gate verdict in the evidence' };
  const stale = staleExpectation(verdict, root);
  if (stale) return { gate: 'missing', gateDetail: `the verdict is stale: ${stale}` };
  // A verdict from another commit (an earlier push, another branch) or a tree edited since says nothing about this one.
  const otherTree = staleTree(verdict.commit, now);
  if (otherTree) return { gate: 'missing', gateDetail: `the verdict is stale: ${otherTree}` };
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
}): { decision: DecisionKind; reasons: string[] } {
  const reasons: string[] = [];
  const affected = input.services.filter((s) => s.change === 'affected');
  const notGreen = affected.filter((s) => s.gate !== 'pass');
  if (notGreen.length > 0) {
    for (const s of notGreen)
      reasons.push(`${s.name}: gate ${s.gate === 'fail' ? 'failed' : 'evidence missing'} (${s.gateDetail})`);
    return { decision: 'blocked', reasons };
  }
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

export function decide(project: ProjectConfig, options: DecideOptions): Result {
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
  const affected = computeAffected(project, change);
  const risk = assessRisk(change.files, project.risk);
  const evidence = readEvidence(evidenceDir, process.cwd());
  // The tree this decision is about; the evidence directory is vgate's own input, not part of the change.
  const now = treeState(project, [evidenceDir]);

  const services: ServiceDecision[] = [
    ...affected.services.map(({ name }) => ({ name, change: 'affected' as const })),
    ...affected.deleted.map((name) => ({ name, change: 'deleted' as const })),
  ].map(({ name, change: kind }) => {
    const verdict = evidence.verdicts.get(name);
    const gate =
      kind === 'deleted'
        ? { gate: 'missing' as const, gateDetail: 'deleted: nothing to run' }
        : judgeGate(verdict, project.root, now);
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

  const { decision, reasons } = decideFrom({
    affected: affected.services.map((s) => s.name),
    risk,
    policy: project.policy,
    services,
  });
  const headSha = git(change.top, ['rev-parse', '--short', 'HEAD']).out.trim() || 'unknown';
  const dirty = git(change.top, ['status', '--porcelain']).out.trim() !== '';
  const result: Decision = {
    schema: 'vgate.decision/1',
    decision,
    reasons,
    base: change.base,
    mergeBase: change.mergeBase,
    head: dirty ? `${headSha}+uncommitted` : headSha,
    policy: project.policy,
    risk,
    services,
    knownFailures: services.flatMap((s) => s.knownFailures.map((k) => ({ ...k, service: s.name }))),
    changedFiles: change.files.length,
    detailsUrl: options.detailsUrl,
    evidence: { read: evidence.read, ignored: evidence.ignored },
  };

  mkdirSync(project.reportsDir, { recursive: true });
  writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(mdFile, renderMarkdown(result));

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

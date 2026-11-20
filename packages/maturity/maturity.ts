import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { inferFamily } from '../verifier/roles.ts';

export type MaturityLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface PhaseCheck {
  id: string;
  met: boolean;
  detail: string;
  fix?: string;
}

export interface PhaseStatus {
  phase: 1 | 2 | 3 | 4 | 5;
  name: string;
  met: boolean;
  checks: PhaseCheck[];
}

export interface MaturityReport {
  schema: 'vgate.maturity/1';
  level: MaturityLevel;
  allowSkipGates: boolean;
  phases: PhaseStatus[];
  nextPhaseBlockers: string[];
}

export interface MaturityInputs {
  projectRoot: string;
  hasGuardrails: boolean;
  guardrailsRuleCount: number;
  hasRuleTable: boolean;
  serviceCount: number;
  hasFeatureMapOrVerifySkill: boolean;
  hasPassingVerdict: boolean;
  ratchetGrowing: boolean;
  hasMutationOrFormalProof: boolean;
  hasDistinctVerifierRole: boolean;
  hasEvalOrVerifierEvidence: boolean;
  revertRate: number | null;
  hasIrreversibleRiskRules: boolean;
  hasFactoryBudgetsAndStop: boolean;
  allowSkipGates?: boolean;
}

const MAX_REVERT_RATE = 0.05;

function formatBlocker(check: PhaseCheck): string {
  return check.fix ? `[${check.id}] ${check.detail} — ${check.fix}` : `[${check.id}] ${check.detail}`;
}

export function evaluateMaturity(inputs: MaturityInputs): MaturityReport {
  const phases: PhaseStatus[] = [
    {
      phase: 1,
      name: 'Guardrails & Rule Table',
      met: false,
      checks: [
        {
          id: 'guardrails-present',
          met: inputs.hasGuardrails && inputs.guardrailsRuleCount > 0,
          detail:
            inputs.hasGuardrails && inputs.guardrailsRuleCount > 0
              ? `guardrails.yaml defines ${inputs.guardrailsRuleCount} rule(s).`
              : 'guardrails.yaml is missing or has zero rules.',
          fix: 'Add guardrails.yaml with at least one deterministic rule.',
        },
        {
          id: 'rule-table',
          met: inputs.hasRuleTable,
          detail: inputs.hasRuleTable
            ? 'AGENTS.md contains a structured rule table.'
            : 'No rule table found in AGENTS.md.',
          fix: 'Add a markdown rule table to AGENTS.md.',
        },
      ],
    },
    {
      phase: 2,
      name: 'Service Verification & Evidence',
      met: false,
      checks: [
        {
          id: 'services-defined',
          met: inputs.serviceCount > 0,
          detail:
            inputs.serviceCount > 0
              ? `${inputs.serviceCount} service(s) configured.`
              : 'No services registered under services/.',
          fix: 'Define at least one service under services/.',
        },
        {
          id: 'feature-map-or-skill',
          met: inputs.hasFeatureMapOrVerifySkill,
          detail: inputs.hasFeatureMapOrVerifySkill
            ? 'Feature map or verify-* skill present.'
            : 'No feature map or verify-* skill detected.',
          fix: 'Add services/*/features or a verify-* skill under .agents/skills/ or .claude/skills/.',
        },
        {
          id: 'passing-verdict',
          met: inputs.hasPassingVerdict,
          detail: inputs.hasPassingVerdict
            ? 'Passing gate verdict recorded in reports/.'
            : 'No passing verdict.json found in reports/.',
          fix: 'Run `vgate gate` to produce a passing reports/verdict.json.',
        },
      ],
    },
    {
      phase: 3,
      name: 'Ratchet & Deep Proof',
      met: false,
      checks: [
        {
          id: 'ratchet-growing',
          met: inputs.ratchetGrowing,
          detail: inputs.ratchetGrowing
            ? 'Verification ratchet is active and growing.'
            : 'No growing verification ratchet evidence found.',
          fix: 'Enable and grow assertion/coverage ratchets across PRs.',
        },
        {
          id: 'mutation-or-formal',
          met: inputs.hasMutationOrFormalProof,
          detail: inputs.hasMutationOrFormalProof
            ? 'Mutation testing or formal proof report present.'
            : 'No mutation.json or formal.json proof evidence found.',
          fix: 'Run `vgate mutate` or formal checks to write reports/mutation.json or reports/formal.json.',
        },
      ],
    },
    {
      phase: 4,
      name: 'Independent AI Verifier & Telemetry',
      met: false,
      checks: [
        {
          id: 'distinct-verifier-role',
          met: inputs.hasDistinctVerifierRole,
          detail: inputs.hasDistinctVerifierRole
            ? 'Cross-vendor independent verifier role is configured.'
            : 'No distinct cross-vendor verifier role configured.',
          fix: 'Configure distinct author and verifier vendor families in vgate.yaml roles.',
        },
        {
          id: 'eval-or-verifier-evidence',
          met: inputs.hasEvalOrVerifierEvidence,
          detail: inputs.hasEvalOrVerifierEvidence
            ? 'Independent verifier or eval evidence is present.'
            : 'No verifier.json or eval evidence found in reports/.',
          fix: 'Run `vgate verify` to produce reports/verifier.json.',
        },
        {
          id: 'revert-rate-healthy',
          met: inputs.revertRate !== null && Number.isFinite(inputs.revertRate) && inputs.revertRate <= MAX_REVERT_RATE,
          detail:
            inputs.revertRate === null || !Number.isFinite(inputs.revertRate)
              ? 'Revert rate is unknown (no .vgate/metrics.jsonl merge history).'
              : inputs.revertRate <= MAX_REVERT_RATE
                ? `Revert rate ${(inputs.revertRate * 100).toFixed(1)}% is within the ${(MAX_REVERT_RATE * 100).toFixed(0)}% threshold.`
                : `Revert rate ${(inputs.revertRate * 100).toFixed(1)}% exceeds ${(MAX_REVERT_RATE * 100).toFixed(0)}%.`,
          fix: 'Log PR merges/reverts to .vgate/metrics.jsonl and maintain revert rate <= 5%.',
        },
      ],
    },
    {
      phase: 5,
      name: 'Autonomous Factory Safety',
      met: false,
      checks: [
        {
          id: 'irreversible-risk-rules',
          met: inputs.hasIrreversibleRiskRules,
          detail: inputs.hasIrreversibleRiskRules
            ? 'Irreversible / high-risk change rules are configured.'
            : 'No irreversible risk rules configured in vgate.yaml.',
          fix: 'Define risk rules for irreversible changes in vgate.yaml.',
        },
        {
          id: 'factory-budgets-and-stop',
          met: inputs.hasFactoryBudgetsAndStop,
          detail: inputs.hasFactoryBudgetsAndStop
            ? 'Hard budget circuit breakers and stop controls are configured.'
            : 'Factory budget caps or emergency stop controls are missing.',
          fix: 'Configure hard budgets and stop/kill-switch controls in vgate.yaml.',
        },
      ],
    },
  ];

  for (const phase of phases) {
    phase.met = phase.checks.every((check) => check.met);
  }

  let level: MaturityLevel = 0;
  for (const phase of phases) {
    if (phase.met) {
      level = phase.phase;
    } else {
      break;
    }
  }

  const nextPhase = level < 5 ? phases[level] : undefined;
  const nextPhaseBlockers = nextPhase ? nextPhase.checks.filter((c) => !c.met).map(formatBlocker) : [];

  return {
    schema: 'vgate.maturity/1',
    level,
    allowSkipGates: inputs.allowSkipGates ?? false,
    phases,
    nextPhaseBlockers,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeReadYaml(filePath: string): unknown {
  if (!existsSync(filePath)) return undefined;
  try {
    return parseYaml(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function safeReadJson(filePath: string): unknown {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    // Unwrap vgate.signature/1 envelopes transparently so signed evidence counts identically.
    if (isRecord(parsed) && isRecord(parsed['payload']) && isRecord(parsed['signature'])) {
      return parsed['payload'];
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function countGuardrailRules(parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.length;
  if (!isRecord(parsed)) return 0;
  let total = 0;
  for (const key of ['rules', 'checks', 'boundaries', 'bannedPatterns', 'nativeLinters', 'presets']) {
    if (Array.isArray(parsed[key])) total += parsed[key].length;
  }
  if (isRecord(parsed['comments'])) total += 1;
  return total;
}

function assignmentFamily(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw['family'] === 'string' && raw['family'].trim().length > 0) {
    return raw['family'].trim().toLowerCase();
  }
  const harness = typeof raw['harness'] === 'string' ? raw['harness'].trim() : '';
  if (!harness) return undefined;
  const model = typeof raw['model'] === 'string' ? raw['model'].trim() : undefined;
  return inferFamily(harness, model);
}

function hasDistinctVerifierInConfig(vgateConfig: unknown): boolean {
  if (!isRecord(vgateConfig) || !isRecord(vgateConfig['roles'])) return false;
  const roles = vgateConfig['roles'];
  if (roles['requireDistinctVerifierFamily'] === false) return false;

  const assignments = isRecord(roles['assignments']) ? roles['assignments'] : roles;
  const authorFam = assignmentFamily(assignments['author']);
  const verifierFam = assignmentFamily(assignments['verifier']);

  if (authorFam && verifierFam && authorFam !== 'unknown' && verifierFam !== 'unknown' && authorFam !== verifierFam) {
    return true;
  }

  if (authorFam && authorFam !== 'unknown' && Array.isArray(roles['panel']) && roles['panel'].length > 0) {
    const panelFamilies = roles['panel'].map(assignmentFamily);
    return panelFamilies.every((fam) => fam !== undefined && fam !== 'unknown' && fam !== authorFam);
  }

  return false;
}

function hasIrreversibleRiskInConfig(vgateConfig: unknown): boolean {
  if (!isRecord(vgateConfig)) return false;
  const risk = vgateConfig['risk'];
  if (isRecord(risk) && Array.isArray(risk['high']) && risk['high'].length > 0) return true;
  return false;
}

function hasPositiveBudgetLimit(budgets: unknown): boolean {
  if (!isRecord(budgets)) return false;
  const keys = ['maxTokensPerPr', 'maxUsdPerPr', 'maxUsdPerRun', 'maxDailyUsd', 'maxRetriesPerPr'];
  return keys.some((k) => typeof budgets[k] === 'number' && Number.isFinite(budgets[k]) && budgets[k] > 0);
}

function hasFactoryBudgetsAndStopInConfig(vgateConfig: unknown): boolean {
  if (!isRecord(vgateConfig)) return false;
  const factory = isRecord(vgateConfig['factory']) ? vgateConfig['factory'] : undefined;
  const budgets = vgateConfig['budgets'];
  if (!hasPositiveBudgetLimit(budgets)) return false;
  const hasFactoryOrAutoPause =
    factory !== undefined ||
    (isRecord(budgets) &&
      typeof budgets['routineZeroFixPauseUsd'] === 'number' &&
      budgets['routineZeroFixPauseUsd'] > 0);
  return hasFactoryOrAutoPause;
}

function findFilesByNames(rootDir: string, names: ReadonlySet<string>): string[] {
  if (!existsSync(rootDir)) return [];
  const found: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (names.has(entry.name)) {
        found.push(fullPath);
      }
    }
  }
  return found;
}

function hasVerifySkillDir(projectRoot: string): boolean {
  const skillRoots = [join(projectRoot, '.agents', 'skills'), join(projectRoot, '.claude', 'skills')];
  for (const root of skillRoots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith('verify-')) return true;
    }
  }
  return false;
}

function computeRevertRate(projectRoot: string): number | null {
  const metricsPath = join(projectRoot, '.vgate', 'metrics.jsonl');
  if (!existsSync(metricsPath)) return null;
  let merged = 0;
  let reverted = 0;
  for (const line of readFileSync(metricsPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) continue;
      if (parsed['kind'] === 'pr-merged') merged++;
      else if (parsed['kind'] === 'pr-reverted') reverted++;
    } catch {
      // Ignore malformed lines.
    }
  }
  return merged > 0 ? Math.round((reverted / merged) * 1_000_000) / 1_000_000 : null;
}

export function inspectProjectMaturity(
  projectRoot: string,
  opts?: { allowSkipGates?: boolean; servicesDir?: string; reportsDir?: string },
): MaturityReport {
  const root = resolve(projectRoot);
  const vgateConfig = safeReadYaml(join(root, 'vgate.yaml')) ?? safeReadYaml(join(root, 'vgate.yml'));
  const configObj = isRecord(vgateConfig) ? vgateConfig : undefined;

  // Guardrails
  const guardrailsPath = existsSync(join(root, 'guardrails.yaml'))
    ? join(root, 'guardrails.yaml')
    : join(root, 'guardrails.yml');
  const hasGuardrails = existsSync(guardrailsPath);
  const guardrailsRuleCount = hasGuardrails ? countGuardrailRules(safeReadYaml(guardrailsPath)) : 0;

  // AGENTS.md rule-to-enforcer table (must have Rule + Enforc* header columns, not any arbitrary table)
  const agentsPath = join(root, 'AGENTS.md');
  const agentsText = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  const hasRuleTable = /^\|[^\n]*rule[^\n]*\|[^\n]*enforc[^\n]*\|\s*\r?\n\|[\s:|-]+\|/im.test(agentsText);

  // Services & feature maps / verify skills
  const configuredServicesDir = typeof configObj?.['servicesDir'] === 'string' ? configObj['servicesDir'] : 'services';
  const servicesRoot = resolve(root, opts?.servicesDir ?? configuredServicesDir);
  let serviceCount = 0;
  let hasFeatureMap = false;

  if (existsSync(servicesRoot)) {
    for (const entry of readdirSync(servicesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      serviceCount++;
      const svcDir = join(servicesRoot, entry.name);
      if (
        existsSync(join(svcDir, 'features')) ||
        existsSync(join(svcDir, 'features.yaml')) ||
        existsSync(join(svcDir, 'features.yml')) ||
        existsSync(join(svcDir, 'features.json'))
      ) {
        hasFeatureMap = true;
      }
    }
  }

  const hasFeatureMapOrVerifySkill = hasFeatureMap || hasVerifySkillDir(root);

  // Reports
  const reportsRoot = resolve(root, opts?.reportsDir ?? 'reports');
  const verdictFiles = findFilesByNames(reportsRoot, new Set(['verdict.json']));
  let hasPassingVerdict = false;
  let ratchetGrowing = false;

  for (const file of verdictFiles) {
    const data = safeReadJson(file);
    if (!isRecord(data)) continue;
    // Require genuine vgate.verdict/1 schema with complete === true and verdict === 'pass' (not arbitrary {ok: true}).
    if (data['schema'] === 'vgate.verdict/1' && data['verdict'] === 'pass' && data['complete'] === true) {
      hasPassingVerdict = true;
    }
    if (
      data['schema'] === 'vgate.verdict/1' &&
      isRecord(data['coverage']) &&
      typeof data['coverage']['covered'] === 'number' &&
      typeof data['coverage']['demanded'] === 'number' &&
      data['coverage']['demanded'] > 0 &&
      data['coverage']['covered'] >= data['coverage']['demanded']
    ) {
      ratchetGrowing = true;
    }
  }

  const ratchetBaseline = safeReadJson(join(root, '.vgate-ratchet.json'));
  if (
    isRecord(ratchetBaseline) &&
    ratchetBaseline['schema'] === 'vgate.ratchet/1' &&
    isRecord(ratchetBaseline['counts']) &&
    Object.keys(ratchetBaseline['counts']).length > 0
  ) {
    ratchetGrowing = true;
  }

  const proofFiles = findFilesByNames(reportsRoot, new Set(['mutation.json', 'formal.json']));
  const hasMutationOrFormalProof = proofFiles.some((file) => {
    const data = safeReadJson(file);
    if (!isRecord(data)) return false;
    if (data['schema'] === 'vgate.formal/1') return data['ok'] === true;
    if (data['schema'] === 'vgate.mutation/1') return data['verdict'] !== 'fail';
    return false;
  });

  const verifierFiles = findFilesByNames(reportsRoot, new Set(['verifier.json', 'eval.json', 'evals.json']));
  const hasEvalOrVerifierEvidence = verifierFiles.some((file) => {
    const data = safeReadJson(file);
    if (!isRecord(data)) return false;
    if (file.endsWith('verifier.json')) {
      const lanes = Array.isArray(data['lanes']) ? data['lanes'] : [];
      return (
        data['schema'] === 'vgate.verifier/1' &&
        (data['verdict'] === 'PASS' || data['verdict'] === 'PASS+NOTES') &&
        (data['mode'] === 'skip' || lanes.length > 0)
      );
    }
    return typeof data['id'] === 'string' && Array.isArray(data['variants']);
  });

  // Security invariant: Phase 4/5 autonomy overrides NEVER come from PR-editable vgate.yaml.
  // Only an explicit out-of-band org/CI environment variable (VGATE_ALLOW_AUTONOMY=1) or caller override enables it.
  const envAutonomy = process.env.VGATE_ALLOW_AUTONOMY === '1' || process.env.VGATE_ALLOW_AUTONOMY === 'true';
  const allowSkipGates = opts?.allowSkipGates ?? envAutonomy;

  return evaluateMaturity({
    projectRoot: root,
    hasGuardrails,
    guardrailsRuleCount,
    hasRuleTable,
    serviceCount,
    hasFeatureMapOrVerifySkill,
    hasPassingVerdict,
    ratchetGrowing,
    hasMutationOrFormalProof,
    hasDistinctVerifierRole: hasDistinctVerifierInConfig(vgateConfig),
    hasEvalOrVerifierEvidence,
    revertRate: computeRevertRate(root),
    hasIrreversibleRiskRules: hasIrreversibleRiskInConfig(vgateConfig),
    hasFactoryBudgetsAndStop: hasFactoryBudgetsAndStopInConfig(vgateConfig),
    allowSkipGates,
  });
}

export function enforceMaturityGate(
  report: MaturityReport,
  requiredPhase: 1 | 2 | 3 | 4 | 5,
): { allowed: boolean; overridden: boolean; advisory: boolean; reason: string; blockers: string[] } {
  if (report.level >= requiredPhase) {
    return {
      allowed: true,
      overridden: false,
      advisory: requiredPhase <= 3,
      reason: `Maturity level ${report.level} meets required phase ${requiredPhase}.`,
      blockers: [],
    };
  }

  const blockers: string[] = [];
  for (const phase of report.phases) {
    if (phase.phase > requiredPhase) break;
    for (const check of phase.checks) {
      if (!check.met) {
        blockers.push(`Phase ${phase.phase}: ${formatBlocker(check)}`);
      }
    }
  }

  // Phases 1-3 are advisory readiness guides; Phases 4-5 (auto-merge & unattended writes) enforce an out-of-band seatbelt.
  if (requiredPhase <= 3) {
    return {
      allowed: true,
      overridden: false,
      advisory: true,
      reason: `Advisory: maturity level ${report.level} is below recommended phase ${requiredPhase}.`,
      blockers,
    };
  }

  if (report.allowSkipGates) {
    return {
      allowed: true,
      overridden: true,
      advisory: false,
      reason: `Maturity level ${report.level} is below required phase ${requiredPhase}, overridden via out-of-band VGATE_ALLOW_AUTONOMY.`,
      blockers,
    };
  }

  return {
    allowed: false,
    overridden: false,
    advisory: false,
    reason: `Maturity level ${report.level} is below required phase ${requiredPhase} (set org/CI env VGATE_ALLOW_AUTONOMY=1 to override out-of-band).`,
    blockers,
  };
}

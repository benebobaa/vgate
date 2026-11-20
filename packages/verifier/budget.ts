export interface BudgetLimits {
  maxTokensPerPr?: number;
  maxUsdPerPr?: number;
  maxUsdPerRun?: number;
  maxDailyUsd?: number;
  maxRetriesPerPr?: number;
  routineZeroFixPauseUsd?: number;
}

export interface SpendSnapshot {
  prTokens?: number;
  prUsd?: number;
  runUsd?: number;
  dailyUsd?: number;
  retries?: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  breached: Array<{ limit: string; actual: number; max: number }>;
}

const BUDGET_CHECKS: ReadonlyArray<{
  limitKey: keyof Pick<
    BudgetLimits,
    'maxTokensPerPr' | 'maxUsdPerPr' | 'maxUsdPerRun' | 'maxDailyUsd' | 'maxRetriesPerPr'
  >;
  spendKey: keyof SpendSnapshot;
}> = [
  { limitKey: 'maxTokensPerPr', spendKey: 'prTokens' },
  { limitKey: 'maxUsdPerPr', spendKey: 'prUsd' },
  { limitKey: 'maxUsdPerRun', spendKey: 'runUsd' },
  { limitKey: 'maxDailyUsd', spendKey: 'dailyUsd' },
  { limitKey: 'maxRetriesPerPr', spendKey: 'retries' },
];

export function checkBudget(limits: BudgetLimits, spend: SpendSnapshot): BudgetCheckResult {
  const breached: Array<{ limit: string; actual: number; max: number }> = [];

  for (const { limitKey, spendKey } of BUDGET_CHECKS) {
    const max = limits[limitKey];
    const actual = spend[spendKey];
    if (max === undefined || actual === undefined) continue;
    if (!Number.isFinite(actual) || !Number.isFinite(max) || actual > max) {
      breached.push({ limit: limitKey, actual, max });
    }
  }

  return {
    allowed: breached.length === 0,
    breached,
  };
}

export interface RoutineRunRecord {
  routineId: string;
  timestamp: string;
  tokens: number;
  usd: number;
  acceptedFixes: number;
  status: 'ok' | 'fail' | 'noop';
}

export interface RoutineAuditResult {
  routineId: string;
  runs: number;
  totalTokens: number;
  totalUsd: number;
  acceptedFixes: number;
  usdPerFix: number | null;
  action: 'keep' | 'warn' | 'auto-pause';
  reason: string;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Dr. Eggbot Routine ROI Auditor: flags or auto-pauses recurring agent routines that burn tokens/USD
 * without producing accepted fixes or whose cost per accepted fix exceeds target bounds.
 */
export function auditRoutines(
  records: RoutineRunRecord[],
  opts?: { zeroFixPauseUsd?: number; maxUsdPerFix?: number; minRuns?: number },
): RoutineAuditResult[] {
  const zeroFixPauseUsd = opts?.zeroFixPauseUsd ?? 5;
  const maxUsdPerFix = opts?.maxUsdPerFix ?? 25;
  const minRuns = opts?.minRuns ?? 1;

  const grouped = new Map<string, RoutineRunRecord[]>();
  for (const record of records) {
    const bucket = grouped.get(record.routineId);
    if (bucket) {
      bucket.push(record);
    } else {
      grouped.set(record.routineId, [record]);
    }
  }

  const results: RoutineAuditResult[] = [];
  const routineIds = [...grouped.keys()].sort();

  for (const routineId of routineIds) {
    const group = grouped.get(routineId) ?? [];
    const runs = group.length;
    const totalTokens = group.reduce((sum, r) => sum + (Number.isFinite(r.tokens) ? r.tokens : 0), 0);
    const totalUsd = round6(group.reduce((sum, r) => sum + (Number.isFinite(r.usd) ? r.usd : 0), 0));
    const acceptedFixes = group.reduce((sum, r) => sum + (Number.isFinite(r.acceptedFixes) ? r.acceptedFixes : 0), 0);
    const usdPerFix = acceptedFixes > 0 ? round6(totalUsd / acceptedFixes) : null;

    let action: RoutineAuditResult['action'];
    let reason: string;

    if (runs < minRuns) {
      action = 'keep';
      reason = `Only ${runs} run(s) recorded (minimum ${minRuns} before ROI enforcement).`;
    } else if (acceptedFixes === 0) {
      if (totalUsd >= zeroFixPauseUsd) {
        action = 'auto-pause';
        reason = `Spent $${totalUsd.toFixed(2)} across ${runs} run(s) with 0 accepted fixes (auto-pause threshold: $${zeroFixPauseUsd.toFixed(2)}).`;
      } else if (totalUsd > 0 && totalUsd >= zeroFixPauseUsd * 0.5) {
        action = 'warn';
        reason = `Spent $${totalUsd.toFixed(2)} across ${runs} run(s) with 0 accepted fixes (approaching auto-pause threshold $${zeroFixPauseUsd.toFixed(2)}).`;
      } else {
        action = 'keep';
        reason = `0 accepted fixes across ${runs} run(s), spend $${totalUsd.toFixed(2)} is below warning threshold.`;
      }
    } else if (usdPerFix !== null && usdPerFix > maxUsdPerFix) {
      if (usdPerFix >= maxUsdPerFix * 2) {
        action = 'auto-pause';
        reason = `Cost per accepted fix ($${usdPerFix.toFixed(2)}) exceeds 2x limit ($${maxUsdPerFix.toFixed(2)}).`;
      } else {
        action = 'warn';
        reason = `Cost per accepted fix ($${usdPerFix.toFixed(2)}) exceeds target ($${maxUsdPerFix.toFixed(2)}).`;
      }
    } else {
      action = 'keep';
      reason = `Healthy ROI: ${acceptedFixes} accepted fix(es) at $${(usdPerFix ?? 0).toFixed(2)}/fix.`;
    }

    results.push({
      routineId,
      runs,
      totalTokens,
      totalUsd,
      acceptedFixes,
      usdPerFix,
      action,
      reason,
    });
  }

  return results;
}

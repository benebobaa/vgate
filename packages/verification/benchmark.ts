import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export interface BenchmarkChecklist {
  limiter: string;
  productionTuned: boolean;
  withinPhysicalLimits: boolean;
  zeroErrors: boolean;
  alternatingReproducible: boolean;
  endToEndUserPath: boolean;
  insideTimedRegion: boolean;
}

export type BenchmarkVerdict = 'faster' | 'slower' | 'no-difference' | 'inconclusive';

export interface BenchmarkStats {
  samplesMs: number[];
  medianMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  errors: number;
}

export interface BenchmarkReport {
  schema: 'vgate.benchmark/1';
  verdict: BenchmarkVerdict;
  speedupPct: number | null;
  baseline: BenchmarkStats;
  candidate: BenchmarkStats;
  checklist: BenchmarkChecklist;
  missingChecks: string[];
  summary: string;
}

const BOOLEAN_CHECKLIST_KEYS: ReadonlyArray<Exclude<keyof BenchmarkChecklist, 'limiter'>> = [
  'productionTuned',
  'withinPhysicalLimits',
  'zeroErrors',
  'alternatingReproducible',
  'endToEndUserPath',
  'insideTimedRegion',
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Computes descriptive statistics (median, min, max, p95) over millisecond timing samples.
 */
export function computeStats(samplesMs: number[], errors: number): BenchmarkStats {
  const copy = [...samplesMs];
  if (copy.length === 0) {
    return { samplesMs: [], medianMs: 0, minMs: 0, maxMs: 0, p95Ms: 0, errors };
  }

  const sorted = [...copy].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));

  return {
    samplesMs: copy,
    medianMs: round2(medianMs),
    minMs: round2(sorted[0]),
    maxMs: round2(sorted[sorted.length - 1]),
    p95Ms: round2(sorted[p95Index]),
    errors,
  };
}

/**
 * Evaluates a candidate benchmark against a baseline under the 7-question Explain-the-Number rigor checklist.
 * Defaults strictly to `inconclusive` whenever any checklist item is missing/false, errors occurred,
 * or baseline and candidate ranges overlap heavily.
 */
export function evaluateBenchmark(
  baseline: BenchmarkStats,
  candidate: BenchmarkStats,
  checklist: Partial<BenchmarkChecklist>,
  minEffectPct = 5,
): BenchmarkReport {
  const normalized: BenchmarkChecklist = {
    limiter: (checklist.limiter ?? '').trim(),
    productionTuned: checklist.productionTuned === true,
    withinPhysicalLimits: checklist.withinPhysicalLimits === true,
    zeroErrors: checklist.zeroErrors === true,
    alternatingReproducible: checklist.alternatingReproducible === true,
    endToEndUserPath: checklist.endToEndUserPath === true,
    insideTimedRegion: checklist.insideTimedRegion === true,
  };

  const missingChecks: string[] = [];
  if (!normalized.limiter) {
    missingChecks.push('limiter');
  }
  for (const key of BOOLEAN_CHECKLIST_KEYS) {
    if (!normalized[key]) {
      missingChecks.push(key);
    }
  }

  const hasSamples = baseline.samplesMs.length > 0 && candidate.samplesMs.length > 0 && baseline.medianMs > 0;
  const speedupPct = hasSamples ? round2(((baseline.medianMs - candidate.medianMs) / baseline.medianMs) * 100) : null;

  let verdict: BenchmarkVerdict;
  let reason: string;

  if (missingChecks.length > 0) {
    verdict = 'inconclusive';
    reason = `Missing checklist items: ${missingChecks.join(', ')}`;
  } else if (baseline.errors > 0 || candidate.errors > 0) {
    verdict = 'inconclusive';
    reason = `Non-zero errors observed (baseline: ${baseline.errors}, candidate: ${candidate.errors})`;
  } else if (!hasSamples || speedupPct === null) {
    verdict = 'inconclusive';
    reason = 'Insufficient timing samples for baseline or candidate';
  } else {
    const overlapStart = Math.max(baseline.minMs, candidate.minMs);
    const overlapEnd = Math.min(baseline.maxMs, candidate.maxMs);
    const overlap = Math.max(0, overlapEnd - overlapStart);
    const unionSpan = Math.max(baseline.maxMs, candidate.maxMs) - Math.min(baseline.minMs, candidate.minMs);
    const overlapRatio = unionSpan > 0 ? overlap / unionSpan : 0;

    const candidateMedianInsideBaseline = candidate.medianMs >= baseline.minMs && candidate.medianMs <= baseline.maxMs;
    const baselineMedianInsideCandidate = baseline.medianMs >= candidate.minMs && baseline.medianMs <= candidate.maxMs;

    if (Math.abs(speedupPct) < minEffectPct) {
      const baseSpread = baseline.medianMs > 0 ? (baseline.maxMs - baseline.minMs) / baseline.medianMs : 0;
      const candSpread = candidate.medianMs > 0 ? (candidate.maxMs - candidate.minMs) / candidate.medianMs : 0;
      if (baseSpread > 0.5 || candSpread > 0.5) {
        verdict = 'inconclusive';
        reason = `Measurement variance too wide to distinguish (baseline spread ${round2(baseSpread * 100)}%, candidate spread ${round2(candSpread * 100)}%)`;
      } else {
        verdict = 'no-difference';
        reason = `Effect ${speedupPct}% is within ±${minEffectPct}% threshold`;
      }
    } else if (overlap > 0 && (candidateMedianInsideBaseline || baselineMedianInsideCandidate || overlapRatio > 0.5)) {
      verdict = 'inconclusive';
      reason = `Baseline [${baseline.minMs}..${baseline.maxMs}ms] and candidate [${candidate.minMs}..${candidate.maxMs}ms] ranges overlap heavily`;
    } else if (speedupPct > 0) {
      verdict = 'faster';
      reason = `Candidate is ${speedupPct}% faster (${baseline.medianMs}ms -> ${candidate.medianMs}ms, limiter: ${normalized.limiter})`;
    } else {
      verdict = 'slower';
      reason = `Candidate is ${Math.abs(speedupPct)}% slower (${baseline.medianMs}ms -> ${candidate.medianMs}ms, limiter: ${normalized.limiter})`;
    }
  }

  return {
    schema: 'vgate.benchmark/1',
    verdict,
    speedupPct,
    baseline,
    candidate,
    checklist: normalized,
    missingChecks,
    summary: `[${verdict}] ${reason}`,
  };
}

/**
 * Runs alternating A-B-A-B trials for baseline and candidate commands so thermal/cache drift
 * affects both equally, then evaluates the result against the benchmark rigor checklist.
 */
export function runAlternatingBenchmark(options: {
  baselineCmd: [string, string[]];
  candidateCmd: [string, string[]];
  runs?: number;
  cwd: string;
  checklist: Partial<BenchmarkChecklist>;
  minEffectPct?: number;
}): BenchmarkReport {
  const runs = Math.max(1, options.runs ?? 5);
  const baselineSamples: number[] = [];
  const candidateSamples: number[] = [];
  let baselineErrors = 0;
  let candidateErrors = 0;

  const runOnce = (cmd: [string, string[]]): { ok: boolean; elapsedMs: number } => {
    const start = performance.now();
    const res = spawnSync(cmd[0], cmd[1], {
      cwd: options.cwd,
      encoding: 'utf8',
      shell: false,
    });
    const elapsedMs = performance.now() - start;
    return { ok: !res.error && res.status === 0, elapsedMs };
  };

  for (let i = 0; i < runs; i++) {
    const baseRes = runOnce(options.baselineCmd);
    if (baseRes.ok) baselineSamples.push(round2(baseRes.elapsedMs));
    else baselineErrors++;

    const candRes = runOnce(options.candidateCmd);
    if (candRes.ok) candidateSamples.push(round2(candRes.elapsedMs));
    else candidateErrors++;
  }

  const baselineStats = computeStats(baselineSamples, baselineErrors);
  const candidateStats = computeStats(candidateSamples, candidateErrors);
  return evaluateBenchmark(baselineStats, candidateStats, options.checklist, options.minEffectPct);
}

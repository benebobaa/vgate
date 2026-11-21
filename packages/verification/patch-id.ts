import { spawnSync } from 'node:child_process';
import { matchesGlob } from '../../cli/glob.ts';

// Never ignore linter/formatter configs or SKILL.md/AGENTS.md: those are judge/instruction machinery.
export const DEFAULT_TOLERATED_NOISE = ['docs/**/*.md', 'docs/**/*.txt', 'README.md', 'CHANGELOG.md'] as const;

export interface SemanticPatchIdResult {
  patchId: string | null;
  codeFiles: string[];
  ignoredNoiseFiles: string[];
}

export interface VerdictCarryDecision {
  carry: boolean;
  reason: string;
}

export interface RebaseGuardResult {
  ok: boolean;
  rebases: number;
  ceiling: number;
  action: 'proceed' | 'halt-and-sequence';
  reason: string;
}

export interface StackedPr {
  number: number;
  branch: string;
  verified: boolean;
  ciGreen: boolean;
  merged: boolean;
  patchId?: string;
}

export interface ContiguousPlan {
  landable: StackedPr[];
  ceilingPr?: StackedPr;
  alreadyMerged: StackedPr[];
  blockedReason?: string;
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Computes a rebase-stable semantic patch ID over `baseRef..headRef`, excluding tolerated noise files
 * (docs, markdown, formatter/lint config). Two rebased commits with identical semantic code diffs
 * produce the exact same `patchId`.
 */
export function computeSemanticPatchId(
  repoRoot: string,
  baseRef: string,
  headRef = 'HEAD',
  toleratedGlobs?: string[],
): SemanticPatchIdResult {
  const noiseGlobs = toleratedGlobs ?? [...DEFAULT_TOLERATED_NOISE];

  const namesRes = spawnSync('git', ['diff', '--name-only', `${baseRef}..${headRef}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
  });

  if (namesRes.error || namesRes.status !== 0) {
    return { patchId: null, codeFiles: [], ignoredNoiseFiles: [] };
  }

  const allFiles = (namesRes.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => normalizePath(line.trim()))
    .filter((line) => line.length > 0);

  const codeFiles: string[] = [];
  const ignoredNoiseFiles: string[] = [];

  for (const file of allFiles) {
    if (noiseGlobs.some((glob) => matchesGlob(file, glob))) {
      ignoredNoiseFiles.push(file);
    } else {
      codeFiles.push(file);
    }
  }

  if (codeFiles.length === 0) {
    return { patchId: null, codeFiles, ignoredNoiseFiles };
  }

  const diffRes = spawnSync('git', ['diff', '--no-ext-diff', `${baseRef}..${headRef}`, '--', ...codeFiles], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (diffRes.error || diffRes.status !== 0 || !diffRes.stdout) {
    return { patchId: null, codeFiles, ignoredNoiseFiles };
  }

  const patchIdRes = spawnSync('git', ['patch-id', '--stable'], {
    cwd: repoRoot,
    input: diffRes.stdout,
    encoding: 'utf8',
    shell: false,
  });

  if (patchIdRes.error || patchIdRes.status !== 0) {
    return { patchId: null, codeFiles, ignoredNoiseFiles };
  }

  const token = (patchIdRes.stdout ?? '').trim().split(/\s+/)[0] ?? '';
  return {
    patchId: token.length > 0 ? token : null,
    codeFiles,
    ignoredNoiseFiles,
  };
}

/**
 * Decides whether a prior verification verdict can be safely carried across a rebase.
 * Refuses carry when `hasBuildOutputs === false` (live dev server lanes must rerun),
 * when either patchId is missing, or when semantic patchIds differ.
 */
export function canCarryVerdict(
  previous: { patchId?: string | null; hasBuildOutputs?: boolean },
  current: { patchId?: string | null },
): VerdictCarryDecision {
  if (previous.hasBuildOutputs === false) {
    return {
      carry: false,
      reason: 'Cannot carry verdict when hasBuildOutputs is false (live dev server lanes must rerun)',
    };
  }
  if (!previous.patchId || !current.patchId) {
    return {
      carry: false,
      reason: 'Cannot carry verdict without both previous and current semantic patch IDs',
    };
  }
  if (previous.patchId !== current.patchId) {
    return {
      carry: false,
      reason: `Semantic patch ID changed (${previous.patchId.slice(0, 12)} -> ${current.patchId.slice(0, 12)})`,
    };
  }
  return {
    carry: true,
    reason: `Semantic patch ID unchanged (${current.patchId.slice(0, 12)})`,
  };
}

/**
 * Enforces the rebase ceiling (default 3). Reaching or exceeding the ceiling halts blind rebases
 * and requires sequencing the landing queue.
 */
export function checkRebaseCeiling(rebaseCount: number, ceiling = 3): RebaseGuardResult {
  if (rebaseCount >= ceiling) {
    return {
      ok: false,
      rebases: rebaseCount,
      ceiling,
      action: 'halt-and-sequence',
      reason: `Rebase count ${rebaseCount} reached ceiling ${ceiling}; halt rebasing and sequence merges`,
    };
  }
  return {
    ok: true,
    rebases: rebaseCount,
    ceiling,
    action: 'proceed',
    reason: `Rebase count ${rebaseCount} is below ceiling ${ceiling}`,
  };
}

/**
 * Walks a PR stack from bottom to top, skipping already-merged PRs and collecting contiguous
 * verified + CI-green PRs until the FIRST unverified or non-green PR ("the ceiling").
 */
export function planContiguousLanding(stackBottomToTop: StackedPr[]): ContiguousPlan {
  const alreadyMerged: StackedPr[] = [];
  const landable: StackedPr[] = [];
  let ceilingPr: StackedPr | undefined;
  let blockedReason: string | undefined;

  for (const pr of stackBottomToTop) {
    if (pr.merged) {
      alreadyMerged.push(pr);
      continue;
    }

    if (pr.verified && pr.ciGreen) {
      landable.push(pr);
      continue;
    }

    ceilingPr = pr;
    const issues: string[] = [];
    if (!pr.verified) issues.push('not verified');
    if (!pr.ciGreen) issues.push('CI not green');
    blockedReason = `Stopped at ceiling PR #${pr.number} (${pr.branch}): ${issues.join(' and ')}`;
    break;
  }

  return {
    landable,
    ...(ceilingPr !== undefined ? { ceilingPr, blockedReason } : {}),
    alreadyMerged,
  };
}

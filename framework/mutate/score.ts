/**
 * What a mutation run means: which changed lines are mutation sites, how mutants are counted, and when a score is good
 * enough for the project's policy. Pure; `vgate mutate` and `vgate decide` share it.
 */
import { languageOf } from './tokenize.ts';
import type { Candidate } from './operators.ts';

/**
 * - killed: a test that passes on the unmutated code failed (or the app would not start with it)
 * - survived: every test passed: no test noticed the bug
 * - timeout: the tests ran past their time; counted apart (a hang is noticed, but by no assertion)
 * - build-error: the mutated code did not build; it says nothing about the tests
 * - not-run: the run's time ran out first
 * - flaky: tests failed with the mutant, but did not fail again with it or failed on the unmutated code too: their
 *   failure was not the mutant's doing, so it says nothing either way
 */
export type MutantStatus = 'killed' | 'survived' | 'timeout' | 'build-error' | 'not-run' | 'flaky';

export interface MutantResult extends Candidate {
  status: MutantStatus;
  /** Scenario ids (or titles) of the tests that caught it. */
  killedBy?: string[];
  durationMs: number;
  detail?: string;
  /** For a survivor: what to add, in words. */
  hint?: string;
  /** For a flaky mutant: the tests whose failure did not hold. */
  flakyTests?: string[];
}

export interface MutationCounts {
  total: number;
  killed: number;
  survived: number;
  timeout: number;
  buildError: number;
  notRun: number;
  flaky: number;
  /** killed / (killed + survived); null when no mutant could be judged. */
  score: number | null;
}

export function count(results: Array<Pick<MutantResult, 'status'>>): MutationCounts {
  const by = (s: MutantStatus) => results.filter((r) => r.status === s).length;
  const killed = by('killed');
  const survived = by('survived');
  return {
    total: results.length,
    killed,
    survived,
    timeout: by('timeout'),
    buildError: by('build-error'),
    notRun: by('not-run'),
    flaky: by('flaky'),
    score: killed + survived === 0 ? null : Math.round((killed / (killed + survived)) * 1000) / 1000,
  };
}

export type MutationVerdict = 'pass' | 'below' | 'unmeasured' | 'not-applicable';

/**
 * - not-applicable: the change touches no code vgate mutates
 * - unmeasured: there was code, but no mutant could be judged (all failed to build, timed out or did not run)
 * - below: the score is under `policy.mutationScore`
 * - pass: at or above it (or no threshold set)
 */
export function mutationVerdict(sites: number, counts: MutationCounts, threshold: number | undefined): MutationVerdict {
  if (sites === 0) return 'not-applicable';
  if (counts.score === null) return 'unmeasured';
  if (threshold !== undefined && counts.score < threshold) return 'below';
  return 'pass';
}

/** Lines added or changed in the working tree, per file, from `git diff -U0` output (`+++ b/<file>` and hunks). */
export function changedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      file = path === '/dev/null' ? undefined : path.replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const set = out.get(file) ?? new Set<number>();
      for (let n = start; n < start + length; n++) set.add(n);
      if (length > 0) out.set(file, set);
    }
  }
  return out;
}

/** Test code by name, in the conventions of the common languages: never a mutation site. */
const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec|specs|testdata|fixtures?)\/|(^|\/)src\/test\/|[._-](test|spec)\.[^/]+$|_test\.go$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs|scala)$/;
/** Generated or vendored code, and build output. */
const NOT_SOURCE =
  /(^|\/)(node_modules|vendor|dist|build|target|out|generated|\.git)\/|\.(pb|gen|generated)\.[a-z]+$|_gen\.go$|\.d\.ts$|\.min\.js$/;

/**
 * Whether a changed file (top-relative) is code of the service under test that vgate mutates: a language it knows,
 * not a test, not generated, not documentation or a migration, and not the service's own verification files.
 */
export function isMutationSource(
  file: string,
  options: {
    /** `<prefix><servicesDir>/` (top-relative, trailing slash). */
    servicesDir: string;
    service: string;
    /** Migration directories (top-relative) of the service, now and at the base. */
    migrationDirs: string[];
    /** The service's `paths:` name this file: its code, even beside the service's verification files. */
    declared?: (file: string) => boolean;
  },
): boolean {
  if (!languageOf(file)) return false;
  if (TEST_FILE.test(file) || NOT_SOURCE.test(file)) return false;
  if (options.migrationDirs.some((dir) => file === dir || file.startsWith(`${dir}/`))) return false;
  if (file.startsWith(options.servicesDir)) {
    const rest = file.slice(options.servicesDir.length).split('/');
    // Another service's files, or this one's verification: its tests, support, stubs and the helpers beside them
    // (unless `paths:` names the file as the service's code).
    if (rest[0] !== options.service) return false;
    if (['tests', 'support', 'deps', 'perf', 'generated', 'node_modules'].includes(rest[1])) return false;
    if (rest.length < 3 && !options.declared?.(file)) return false;
  }
  return true;
}

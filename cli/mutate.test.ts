import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { count, type MutantResult } from '../framework/mutate/score.ts';
import type { TreeState } from './commit.ts';
import {
  decideFrom,
  judgeMutation,
  readEvidence,
  renderMarkdown,
  type Decision,
  type MutationCheck,
} from './decide.ts';
import type { MutationReport } from './mutate.ts';
import { mutate, mutationSources, newlyFailing, notStarted, reasonsFor } from './mutate.ts';
import { readProject } from '../framework/project.ts';
import { git } from './guard.ts';
import type { Runtime } from './runtime.ts';
import type { RiskReport } from './risk.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const now: TreeState = { sha: 'a'.repeat(40), dirty: false, fingerprint: 'f' };
const mutant = (status: MutantResult['status'], line = 1): MutantResult => ({
  id: `M${line}`,
  file: 'app/orders.ts',
  line,
  column: 10,
  offset: 0,
  operator: 'boundary',
  original: '>=',
  replacement: '>',
  before: 'if (n >= max)',
  after: 'if (n > max)',
  status,
  durationMs: 1,
  ...(status === 'survived'
    ? { hint: 'no test noticed when `>=` became `>` in app/orders.ts:1: add a scenario at the exact limit value' }
    : {}),
});
function report(mutants: MutantResult[], overrides: Partial<MutationReport> = {}): MutationReport {
  const counts = count(mutants);
  return {
    schema: 'vgate.mutation/1',
    service: 'orders',
    base: 'main',
    mergeBase: 'mb',
    commit: now,
    verdict: counts.score === null ? 'unmeasured' : 'pass',
    counts,
    sites: { files: ['app/orders.ts'], lines: 3, candidates: mutants.length },
    budget: 20,
    timeoutMs: 600_000,
    mutants,
    reasons: [],
    startedAt: '2026-11-19T00:00:00Z',
    durationMs: 1,
    ...overrides,
  };
}

describe('judgeMutation', () => {
  const killed3 = [mutant('killed', 1), mutant('killed', 2), mutant('killed', 3), mutant('survived', 4)];

  it('passes at or above the policy, and is below it under', () => {
    assert.equal(judgeMutation('orders', report(killed3), 'mb', now, 0.75).state, 'pass');
    const below = judgeMutation('orders', report(killed3), 'mb', now, 0.8);
    assert.equal(below.state, 'below');
    assert.match(
      below.reasons[0],
      /caught 3 of 4 bugs planted in the changed code \(75%\), below policy\.mutationScore 80%/,
    );
    assert.deepEqual(
      below.survivors.map((s) => `${s.file}:${s.line}`),
      ['app/orders.ts:4'],
    );
  });

  it('counts evidence from another base, another tree or none as missing, and no judged mutant as unmeasured', () => {
    assert.equal(judgeMutation('orders', undefined, 'mb', now, 0.7).state, 'missing');
    assert.equal(judgeMutation('orders', report(killed3), 'other', now, 0.7).state, 'missing');
    const stale = judgeMutation('orders', report(killed3, { commit: { ...now, sha: 'b'.repeat(40) } }), 'mb', now, 0.7);
    assert.equal(stale.state, 'missing');
    assert.match(stale.reasons[0], /stale/);
    const unbound = judgeMutation(
      'orders',
      report(killed3, { commit: { sha: null, dirty: false, fingerprint: null } }),
      'mb',
      now,
      0.7,
    );
    assert.equal(unbound.state, 'missing', 'evidence that names no commit could be a committed file');
    assert.equal(judgeMutation('orders', report([mutant('build-error')]), 'mb', now, 0.7).state, 'unmeasured');
    assert.equal(
      judgeMutation('orders', report([], { verdict: 'not-applicable' }), 'mb', now, 0.7).state,
      'pass',
      'nothing to mutate needs nobody',
    );
  });
});

describe('decide with mutation evidence', () => {
  const risk: RiskReport = { tier: 'low', matches: [], low: 1, rules: 'built-in' } as unknown as RiskReport;
  const green = {
    name: 'orders',
    change: 'affected' as const,
    gate: 'pass' as const,
    guard: 'auto' as const,
    failures: [],
    guardFindings: [],
    knownFailures: [],
  };
  const check = (state: MutationCheck['state']): MutationCheck => ({
    service: 'orders',
    state,
    score: state === 'below' ? 0.5 : 0.9,
    killed: 1,
    survived: 1,
    reasons: state === 'pass' ? [] : [`orders: ${state}`],
    survivors: [],
  });
  const decideWith = (state: MutationCheck['state'], mutationScore?: number) =>
    decideFrom({
      affected: ['orders'],
      risk,
      policy: { autoMerge: 'low', ...(mutationScore === undefined ? {} : { mutationScore }) },
      services: [green],
      mutation: [check(state)],
    });

  it('sends weak, unmeasured or missing test strength to a person when the policy asks for a score; never blocks', () => {
    for (const state of ['below', 'unmeasured', 'missing'] as const) {
      const d = decideWith(state, 0.7);
      assert.equal(d.decision, 'needs-approval', state);
      assert.deepEqual(d.reasons, [`orders: ${state}`]);
    }
    assert.equal(decideWith('pass', 0.7).decision, 'merge');
  });

  it('without policy.mutationScore, test strength is shown but never required', () => {
    for (const state of ['below', 'unmeasured', 'missing'] as const)
      assert.equal(decideWith(state).decision, 'merge', state);
  });

  it('the PR comment lists survivors with what to add, as plain text', () => {
    const below = judgeMutation('orders', report([mutant('killed', 1), mutant('survived', 2)]), 'mb', now, 0.9);
    const d = {
      schema: 'vgate.decision/1',
      decision: 'needs-approval',
      reasons: below.reasons,
      base: 'main',
      mergeBase: 'mb',
      head: 'abc',
      policy: { autoMerge: 'low', mutationScore: 0.9 },
      risk,
      services: [green],
      deploy: { configured: false, checks: [] },
      migrations: [],
      mutation: [below],
      knownFailures: [],
      changedFiles: 1,
      evidence: { read: [], ignored: [] },
    } as Decision;
    const md = renderMarkdown(d);
    assert.match(md, /\*\*Test strength\*\*/);
    assert.match(md, /policy 90%/);
    assert.match(md, /🟡 50% \(1 of 2\): below the policy/);
    assert.match(md, /survived `app\/orders\.ts:2`: `>=` → `>` \(add a scenario at the exact limit value\)/);
  });
});

describe('mutation evidence', () => {
  it('of two reports for one service, the weaker wins: a second file claiming a high score cannot hide a low one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vgate-mut-evidence-'));
    dirs.push(dir);
    const low = report([mutant('killed', 1), mutant('survived', 2)]);
    const high = report([mutant('killed', 1), mutant('killed', 2)]);
    for (const [name, r] of [
      ['a', high],
      ['b', low],
      ['c', high],
    ] as const) {
      const sub = join(dir, name);
      rmSync(sub, { recursive: true, force: true });
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, 'mutation.json'), JSON.stringify(r));
    }
    const evidence = readEvidence(dir, dir);
    assert.equal(evidence.mutation.get('orders')?.counts.score, 0.5);
    assert.equal(evidence.read.length, 3);
  });

  it('a second file claiming there was nothing to mutate cannot hide a measured low score either', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vgate-mut-evidence-'));
    dirs.push(dir);
    const low = report([mutant('killed', 1), mutant('survived', 2)]);
    const nothing = report([], { verdict: 'not-applicable' });
    for (const [name, r] of [
      ['a', low],
      ['b', nothing],
    ] as const) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'mutation.json'), JSON.stringify(r));
    }
    const kept = readEvidence(dir, dir).mutation.get('orders');
    assert.equal(kept?.verdict, 'pass');
    assert.equal(judgeMutation('orders', kept, 'mb', now, 0.7).state, 'below');
  });

  it('says why, in words', () => {
    const base = { service: 'orders', sites: { files: ['x.ts'], lines: 1, candidates: 2 }, threshold: 0.8 };
    assert.match(
      reasonsFor({
        ...base,
        verdict: 'below',
        counts: count([{ status: 'killed' }, { status: 'survived' }, { status: 'not-run' }]),
      })[0],
      /caught 1 of 2 planted bugs in the changed code \(50%\), below policy\.mutationScore 80%; 1 not run \(time limit\)/,
    );
    assert.match(
      reasonsFor({
        ...base,
        sites: { files: [], lines: 0, candidates: 0 },
        verdict: 'not-applicable',
        counts: count([]),
      })[0],
      /touches no source code vgate mutates/,
    );
  });
});

describe('a mutant whose app did not come up', () => {
  it('is caught only where a build is told apart from a crash and the unmutated app comes up again', () => {
    assert.equal(notStarted('declared-rebuild', true, 'exit 1').status, 'killed');
    // A stack.sh or an app started without a build: a mutant that does not compile looks the same.
    assert.equal(notStarted('script-restart', undefined, 'exit 1').status, 'build-error');
    assert.equal(notStarted('declared-restart', undefined, 'exit 1').status, 'build-error');
    // The environment broke, not the app: nothing caught.
    assert.equal(notStarted('declared-rebuild', false, 'exit 1').status, 'not-run');
  });
});

describe('mutate in a shared environment', () => {
  it('refuses before anything starts: every mutant restarts the app', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vgate-mut-shared-'));
    dirs.push(root);
    writeFileSync(join(root, 'vgate.yaml'), 'version: 0.3.0\nservicesDir: services\n');
    mkdirSync(join(root, 'services', 'api'), { recursive: true });
    writeFileSync(
      join(root, 'services', 'api', 'service.yaml'),
      'spec: openapi.yaml\nenvironments:\n  production:\n    baseUrl: http://127.0.0.1:1\n    disposable: false\n    users: {}\n',
    );
    for (const args of [
      ['init', '-q'],
      ['add', '-A'],
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'],
    ])
      git(root, args);
    await assert.rejects(
      mutate(readProject(root), { root } as Runtime, { service: 'api', base: 'HEAD', env: 'production', live: false }),
      /environment production is not disposable/,
    );
  });
});

describe('mutation sources', () => {
  it('leave out a symlink: a mutant written through it would land outside the scratch copy', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'vgate-mut-link-')));
    dirs.push(root);
    writeFileSync(join(root, 'vgate.yaml'), 'version: 0.3.0\nservicesDir: services\n');
    const app = join(root, 'services', 'api', 'app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'own.ts'), 'export const f = (a: number) => a < 1;\n');
    const outside = join(root, '..', `${basename(root)}-outside.ts`);
    dirs.push(outside);
    writeFileSync(outside, 'export const g = (a: number) => a < 1;\n');
    symlinkSync(outside, join(app, 'link.ts'));
    git(root, ['init', '-q']);
    const change = {
      base: 'HEAD',
      mergeBase: 'HEAD',
      top: root,
      prefix: '',
      files: ['services/api/app/link.ts', 'services/api/app/own.ts'],
    };
    assert.deepEqual(mutationSources(readProject(root), change, { name: 'api', paths: undefined }), [
      'services/api/app/own.ts',
    ]);
  });
});

describe('newlyFailing', () => {
  it('tells apart the cases of one scenario id: one failing before does not hide another the mutant breaks', () => {
    const f = (title: string) => ({ id: 'LST-400-LIMIT', file: 'notes.spec.ts', title });
    const before = [f('[LST-400-LIMIT] refuses limit=ten')];
    assert.deepEqual(newlyFailing(before, [f('[LST-400-LIMIT] refuses limit=ten')]), []);
    assert.deepEqual(
      newlyFailing(before, [f('[LST-400-LIMIT] refuses limit=ten'), f('[LST-400-LIMIT] refuses limit=0')]),
      ['LST-400-LIMIT: refuses limit=0'],
    );
    assert.deepEqual(newlyFailing([], [{ file: 'a.spec.ts', title: 'no id here' }]), ['no id here']);
  });
});

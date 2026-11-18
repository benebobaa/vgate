import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readProject, type Policy } from '../framework/project.ts';
import { affectedServices, changeSet, computeAffected } from './affected.ts';
import { treeState } from './commit.ts';
import {
  decide,
  decideFrom,
  DECISION_MARKER,
  mdCode,
  mdText,
  renderMarkdown,
  type Decision,
  type ServiceDecision,
} from './decide.ts';
import { matchesGlob } from './glob.ts';
import { EXIT } from './output.ts';
import { assessRisk, type RiskReport } from './risk.ts';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function run(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A monorepo: two services with `paths:`, their code under apps/, a shared lib, docs; base committed on main. */
function monorepo(vgate = 'version: 0.2.0\nservicesDir: regression\npolicy:\n  autoMerge: low\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'vgate-decide-'));
  dirs.push(root);
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'config', 'user.email', 't@example.invalid');
  run(root, 'config', 'user.name', 't');
  write(root, 'vgate.yaml', vgate);
  write(root, 'regression/notes/service.yaml', "spec: openapi.yaml\npaths: ['apps/notes/**']\n");
  write(root, 'regression/notes/openapi.yaml', 'openapi: 3.1.0\n');
  write(root, 'regression/orders/service.yaml', "spec: openapi.yaml\npaths: ['apps/orders/**', 'libs/shared/**']\n");
  write(root, 'regression/orders/openapi.yaml', 'openapi: 3.1.0\n');
  write(root, 'apps/notes/main.go', 'package main\n');
  write(root, 'apps/orders/main.go', 'package main\n');
  write(root, 'libs/shared/util.go', 'package shared\n');
  write(root, 'README.md', '# repo\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'base');
  return root;
}

const sha = (root: string, path: string) =>
  createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex');

function verdict(root: string, service: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 'vgate.verdict/1',
    service,
    environment: 'local',
    verdict: 'pass',
    complete: true,
    startedAt: '2026-11-18T00:00:00.000Z',
    durationMs: 1,
    expectations: { [`regression/${service}/openapi.yaml`]: sha(root, `regression/${service}/openapi.yaml`) },
    steps: [{ name: 'test', status: 'pass', exitCode: 0, durationMs: 1, log: 'x' }],
    tests: { total: 10, failed: 0, skipped: 0, failures: [], knownFailures: [] },
    coverage: { covered: 4, demanded: 4, excluded: 0, percent: 100, gaps: [], undocumented: [], untested: [] },
    evidence: {},
    ...overrides,
  });
}

const guardJson = (service: string, decision = 'auto', base = 'main', findings: unknown[] = []) =>
  JSON.stringify({ schema: 'vgate.guard/1', service, base, decision, findings, info: [] });

describe('matchesGlob', () => {
  it('reads *, ?, ** and {a,b} like .gitignore, over the whole path', () => {
    assert.ok(matchesGlob('db/migrations/001.sql', 'db/migrations/**'));
    assert.ok(matchesGlob('svc/internal/auth/token.go', '**/{auth,security}/**'));
    assert.ok(matchesGlob('auth/x.go', '**/{auth,security}/**'), '**/ matches zero directories');
    assert.ok(matchesGlob('.env.local', '**/{.env,.env.*}'));
    assert.ok(!matchesGlob('apps/notes/main.go', 'apps/*.go'), '* stays within a directory');
    assert.ok(matchesGlob('apps/a.go', 'apps/?.go'));
    assert.ok(!matchesGlob('authors/x.go', '**/auth/**'), 'a directory name matches whole, not as a prefix');
    assert.ok(matchesGlob('src/Data/Migrations/0001_Init.cs', '**/migrations/**'), 'case does not hide a path');
  });
});

describe('affectedServices', () => {
  const paths: Record<string, string[] | undefined> = {
    notes: ['apps/notes/**'],
    orders: ['apps/orders/**', 'libs/shared/**'],
  };
  const of = (files: string[], pathsOf = (s: string) => paths[s]) =>
    affectedServices(files, ['notes', 'orders'], '', 'regression', pathsOf).map((s) => s.name);

  it('maps code changes to the services whose paths cover them', () => {
    assert.deepEqual(of(['apps/notes/main.go']), ['notes']);
    assert.deepEqual(of(['libs/shared/util.go']), ['orders']);
  });
  it('affects a service through its own directory, and every service through vgate.yaml or shared test files', () => {
    assert.deepEqual(of(['regression/orders/tests/x.spec.ts']), ['orders']);
    assert.deepEqual(of(['vgate.yaml']), ['notes', 'orders']);
    assert.deepEqual(of(['regression/tsconfig.json']), ['notes', 'orders']);
  });
  it('leaves a docs-only change with no affected service', () => {
    assert.deepEqual(of(['README.md', 'docs/guide.md']), []);
  });
  it('treats a service without paths: as depending on every change outside the other services', () => {
    const noPaths = (s: string) => (s === 'notes' ? undefined : paths[s]);
    assert.deepEqual(of(['README.md'], noPaths), ['notes']);
    assert.deepEqual(
      of(['regression/orders/tests/x.spec.ts'], noPaths),
      ['orders'],
      'another service is not a dependency',
    );
  });
});

describe('computeAffected (git)', () => {
  it('reads commits, uncommitted and untracked changes since the merge base, and lists deleted services', () => {
    const root = monorepo();
    run(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'apps/notes/main.go', 'package main // changed\n');
    run(root, 'commit', '-qam', 'notes');
    write(root, 'libs/shared/new.go', 'package shared\n'); // untracked
    rmSync(join(root, 'regression/notes'), { recursive: true });
    write(root, 'apps/notes/main.go', 'package main // again\n');
    const project = readProject(root);
    const change = changeSet(project, 'main');
    assert.ok(!('result' in change));
    const report = computeAffected(project, change);
    assert.ok(report.changedFiles.includes('libs/shared/new.go'), 'untracked files count');
    assert.deepEqual(
      report.services.map((s) => s.name),
      ['orders'],
    );
    assert.deepEqual(report.deleted, ['notes']);
  });
  it('refuses to answer when git cannot list the change, rather than reporting an empty one', () => {
    const root = monorepo();
    run(root, 'checkout', '-q', '-b', 'feature');
    const tree = run(root, 'rev-parse', 'main^{tree}');
    rmSync(join(root, '.git/objects', tree.slice(0, 2), tree.slice(2)), { force: true });
    const change = changeSet(readProject(root), 'main');
    assert.ok('result' in change, 'a missing base tree is not "no change"');
    assert.equal(change.result.exitCode, EXIT.notReady);
  });
  it("sees paths git would quote (non-ASCII) and a submodule bump under a service's paths", () => {
    const root = monorepo();
    const lib = mkdtempSync(join(tmpdir(), 'vgate-sub-'));
    dirs.push(lib);
    run(lib, 'init', '-q', '-b', 'main');
    write(lib, 'x.go', 'package x\n');
    run(lib, 'add', '-A');
    run(lib, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'one');
    run(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'libs/shared/vendored');
    run(root, 'commit', '-q', '-m', 'submodule');
    run(root, 'checkout', '-q', '-b', 'feature');
    write(lib, 'x.go', 'package x // two\n');
    run(lib, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qam', 'two');
    run(join(root, 'libs/shared/vendored'), 'pull', '-q', 'origin', 'main');
    write(root, 'apps/notes/übersicht.go', 'package main\n');
    write(root, '.github/workflows/çi.yml', 'on: push\n');
    run(root, 'add', '-A');
    run(root, 'commit', '-q', '-m', 'feature');
    const project = readProject(root);
    const change = changeSet(project, 'main');
    assert.ok(!('result' in change));
    assert.deepEqual(change.files, ['.github/workflows/çi.yml', 'apps/notes/übersicht.go', 'libs/shared/vendored/']);
    assert.deepEqual(
      computeAffected(project, change).services.map((s) => s.name),
      ['notes', 'orders'],
    );
    assert.equal(assessRisk(change.files, project.risk).tier, 'high', 'a new workflow is a judge file');
  });
});

describe('assessRisk', () => {
  const tier = (files: string[], rules?: Parameters<typeof assessRisk>[1]) => assessRisk(files, rules).tier;

  it('uses the built-in rules without a risk: block', () => {
    assert.equal(tier(['services/api/db/migrations/0042_add.sql']), 'high');
    assert.equal(tier(['internal/billing/charge.go']), 'high');
    assert.equal(tier(['go.sum']), 'medium');
    assert.equal(tier(['internal/notes/list.go']), 'low');
    assert.equal(tier(['internal/billing/README.md']), 'low', 'documentation first, wherever it lives');
  });
  it('keeps the judge files high whatever the project says, and lets the first matching rule win', () => {
    const rules = [
      { tier: 'low' as const, path: '**' },
      { tier: 'high' as const, path: 'db/**' },
    ];
    assert.equal(tier(['vgate.yaml'], rules), 'high');
    assert.equal(tier(['.github/workflows/ci.yml'], rules), 'high');
    assert.equal(tier(['db/x.sql'], rules), 'low', 'the earlier low rule matched first');
  });
  it('is the highest tier of the change and lists what placed it there', () => {
    const report = assessRisk(['README.md', 'go.sum', 'db/migrations/1.sql'], undefined);
    assert.equal(report.tier, 'high');
    assert.deepEqual(
      report.matches.map((m) => [m.file, m.tier]),
      [
        ['db/migrations/1.sql', 'high'],
        ['go.sum', 'medium'],
      ],
    );
    assert.equal(report.low, 1);
  });
});

describe('decideFrom', () => {
  const lowRisk: RiskReport = { tier: 'low', matches: [], low: 1, rules: 'built-in' };
  const policy: Policy = { autoMerge: 'low' };
  const svc = (overrides: Partial<ServiceDecision> = {}): ServiceDecision => ({
    name: 'notes',
    change: 'affected',
    gate: 'pass',
    guard: 'auto',
    failures: [],
    guardFindings: [],
    knownFailures: [],
    ...overrides,
  });
  const decision = (services: ServiceDecision[], risk = lowRisk, p = policy) =>
    decideFrom({
      affected: services.filter((s) => s.change === 'affected').map((s) => s.name),
      risk,
      policy: p,
      services,
    }).decision;

  it('merges a green, unweakened, low-risk change', () => {
    assert.equal(decision([svc()]), 'merge');
  });
  it('blocks on a failed gate or missing evidence, before anything else', () => {
    assert.equal(decision([svc({ gate: 'fail', gateDetail: 'test' })]), 'blocked');
    assert.equal(decision([svc({ gate: 'missing', gateDetail: 'none', guard: 'needs-human' })]), 'blocked');
  });
  it('asks a human when the guard found weakened expectations or did not run, or a service was deleted', () => {
    assert.equal(decision([svc({ guard: 'needs-human' })]), 'needs-approval');
    assert.equal(decision([svc({ guard: 'missing', guardDetail: 'no guard' })]), 'needs-approval');
    assert.equal(decision([svc(), svc({ name: 'orders', change: 'deleted', gate: 'missing' })]), 'needs-approval');
  });
  it('asks a human when the change is riskier than the policy allows, and always under autoMerge: none', () => {
    const high: RiskReport = { tier: 'high', matches: [], low: 0, rules: 'built-in' };
    assert.equal(decision([svc()], high), 'needs-approval');
    assert.equal(decision([svc()], lowRisk, { autoMerge: 'none' }), 'needs-approval');
    assert.equal(decision([svc()], high, { autoMerge: 'high' }), 'merge');
  });
  it("asks a human for a change to the judge's own files even under autoMerge: high", () => {
    const judge = assessRisk(['CODEOWNERS', 'src/x.go'], undefined);
    assert.equal(decision([svc()], judge, { autoMerge: 'high' }), 'needs-approval');
    assert.equal(decision([svc()], assessRisk(['db/migrations/1.sql'], undefined), { autoMerge: 'high' }), 'merge');
  });
  it('merges a change that affects no service, saying so', () => {
    const result = decideFrom({ affected: [], risk: lowRisk, policy, services: [] });
    assert.deepEqual(result, { decision: 'merge', reasons: ['no service is affected by this change'] });
  });
});

describe('decide (git and evidence files)', () => {
  function featureRepo(): string {
    const root = monorepo();
    run(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'apps/notes/main.go', 'package main // feature\n');
    run(root, 'commit', '-qam', 'feature');
    return root;
  }

  it('merges with a current, passing verdict and an auto guard, and writes the comment', () => {
    const root = featureRepo();
    write(root, 'evidence/notes/verdict.json', verdict(root, 'notes'));
    write(root, 'evidence/notes/guard.json', guardJson('notes'));
    const result = decide(readProject(root), { base: 'main', evidence: join(root, 'evidence') });
    assert.equal(result.exitCode, EXIT.ok, result.summary);
    const md = readFileSync(join(root, 'reports/decision.md'), 'utf8');
    assert.ok(md.startsWith(DECISION_MARKER));
    assert.match(md, /Verified: may merge/);
    assert.equal((JSON.parse(readFileSync(join(root, 'reports/decision.json'), 'utf8')) as Decision).decision, 'merge');
  });
  it('blocks when the verdict was computed against other expectations (stale evidence)', () => {
    const root = featureRepo();
    write(root, 'evidence/notes/verdict.json', verdict(root, 'notes'));
    write(root, 'evidence/notes/guard.json', guardJson('notes'));
    write(root, 'regression/notes/openapi.yaml', 'openapi: 3.1.0\n# changed after the gate\n');
    const result = decide(readProject(root), { base: 'main', evidence: join(root, 'evidence') });
    assert.equal((result.data as Decision).decision, 'blocked');
    assert.match((result.data as Decision).reasons[0], /stale/);
  });
  it('does not accept a guard that compared with another base', () => {
    const root = featureRepo();
    write(root, 'evidence/notes/verdict.json', verdict(root, 'notes'));
    write(root, 'evidence/notes/guard.json', guardJson('notes', 'auto', 'feature'));
    const result = decide(readProject(root), { base: 'main', evidence: join(root, 'evidence') });
    assert.equal((result.data as Decision).decision, 'needs-approval');
    assert.equal(result.exitCode, EXIT.failed);
  });
  it('lets a failing or partial verdict win over another file that claims a pass, whatever its date', () => {
    for (const [first, second] of [
      ['a', 'z'],
      ['z', 'a'],
    ]) {
      const root = featureRepo();
      write(root, `evidence/${first}/notes/verdict.json`, verdict(root, 'notes', { verdict: 'fail' }));
      const forged = verdict(root, 'notes', { startedAt: '9999-01-01T00:00:00.000Z' });
      write(root, `evidence/${second}/notes/verdict.json`, forged);
      write(root, 'evidence/notes/guard.json', guardJson('notes'));
      const result = decide(readProject(root), { base: 'main', evidence: join(root, 'evidence') });
      assert.equal((result.data as Decision).decision, 'blocked', `${first} fails, ${second} claims a pass`);
    }
  });
  it('removes an earlier decision before deciding, so a run that stops early leaves none behind', () => {
    const root = featureRepo();
    write(root, 'reports/decision.json', '{"decision":"merge"}');
    write(root, 'regression/notes/service.yaml', 'paths: not-a-list\n');
    assert.throws(() => decide(readProject(root), { base: 'main', evidence: join(root, 'regression') }));
    assert.ok(!existsSync(join(root, 'reports/decision.json')));
  });
  it('blocks on a partial gate run', () => {
    const root = featureRepo();
    write(root, 'evidence/notes/verdict.json', verdict(root, 'notes', { complete: false }));
    write(root, 'evidence/notes/guard.json', guardJson('notes'));
    assert.equal(
      (decide(readProject(root), { base: 'main', evidence: join(root, 'evidence') }).data as Decision).decision,
      'blocked',
    );
  });
});

describe('decide: evidence bound to the commit', () => {
  function featureRepo(): string {
    const root = monorepo();
    run(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'apps/notes/main.go', 'package main // feature\n');
    run(root, 'commit', '-qam', 'feature');
    return root;
  }
  /** Evidence as CI makes it: verdict and guard taken on the tree as it is now. */
  function evidenceNow(root: string, overrides: Record<string, unknown> = {}): void {
    const head = treeState(readProject(root));
    write(root, 'evidence/notes/verdict.json', verdict(root, 'notes', { commit: head, ...overrides }));
    write(root, 'evidence/notes/guard.json', JSON.stringify({ ...(JSON.parse(guardJson('notes')) as object), head }));
  }
  const decision = (root: string) =>
    decide(readProject(root), { base: 'main', evidence: join(root, 'evidence') }).data as Decision;

  it('merges on evidence taken on this commit and this tree (vgate output and the evidence itself do not count)', () => {
    const root = featureRepo();
    evidenceNow(root);
    // Written by vgate after the gate ran: reports and generated types are its output, not the code under judgement.
    write(root, 'reports/stack/notes.log', 'vgate output, not part of the change');
    write(root, 'regression/notes/generated/openapi.ts', 'export {};');
    const d = decision(root);
    assert.equal(d.decision, 'merge', d.reasons.join('; '));
    assert.equal(d.services[0].gateDetail, undefined);
  });
  it('blocks on a verdict from an earlier commit, and asks again for a guard from one', () => {
    const root = featureRepo();
    evidenceNow(root);
    write(root, 'apps/notes/main.go', 'package main // pushed after the gate\n');
    run(root, 'commit', '-qam', 'later push');
    const d = decision(root);
    assert.equal(d.decision, 'blocked');
    assert.match(d.services[0].gateDetail ?? '', /computed on commit [0-9a-f]{12}, this is [0-9a-f]{12}/);
    assert.match(d.services[0].guardDetail ?? '', /stale/);
  });
  it('blocks on a verdict when the working tree changed after the gate ran', () => {
    const root = featureRepo();
    evidenceNow(root);
    write(root, 'apps/notes/main.go', 'package main // edited, not committed\n');
    const d = decision(root);
    assert.equal(d.decision, 'blocked');
    assert.match(d.services[0].gateDetail ?? '', /working tree changed/);
  });
  it('accepts a verdict from outside git on its expectation hashes alone, and says so', () => {
    const root = featureRepo();
    evidenceNow(root, { commit: { sha: null, dirty: false, fingerprint: null } });
    const d = decision(root);
    assert.equal(d.decision, 'merge', d.reasons.join('; '));
    assert.match(d.services[0].gateDetail ?? '', /not bound to a commit/);
  });
  it('records no commit outside git, and a full sha with a clean or dirty state inside', () => {
    const plain = mkdtempSync(join(tmpdir(), 'vgate-tree-'));
    dirs.push(plain);
    write(plain, 'vgate.yaml', 'version: 0.2.0\n');
    assert.deepEqual(treeState(readProject(plain)), { sha: null, dirty: false, fingerprint: null });
    const root = featureRepo();
    const clean = treeState(readProject(root));
    assert.match(clean.sha ?? '', /^[0-9a-f]{40}$/);
    assert.equal(clean.dirty, false);
    write(root, 'apps/notes/new.go', 'package main\n');
    const dirty = treeState(readProject(root));
    assert.equal(dirty.sha, clean.sha);
    assert.equal(dirty.dirty, true);
    assert.notEqual(dirty.fingerprint, clean.fingerprint);
  });
});

describe('decision comment escaping', () => {
  const hostile =
    'a|b`c\n<img src=x onerror=alert(1)> [click](http://evil.invalid) ![](http://t.invalid) @everyone <!-- vgate:decision -->';
  const md = renderMarkdown({
    schema: 'vgate.decision/1',
    decision: 'blocked',
    reasons: [`${hostile}: gate failed`],
    base: 'main',
    mergeBase: 'abc',
    head: 'def',
    policy: { autoMerge: 'low' },
    risk: {
      tier: 'high',
      matches: [{ file: hostile, tier: 'high', rule: 'x', reason: hostile }],
      low: 0,
      rules: 'built-in',
    },
    services: [
      {
        name: hostile,
        change: 'affected',
        gate: 'fail',
        gateDetail: hostile,
        guard: 'needs-human',
        tests: { total: 1, failed: 1, knownFailures: 0 },
        failures: [{ id: 'X-1', title: hostile, file: hostile, line: 3, message: hostile }],
        guardFindings: [{ rule: 'tests-weakened', file: hostile, detail: hostile }],
        knownFailures: [{ id: hostile, ticket: hostile, title: hostile }],
      },
    ],
    knownFailures: [{ id: hostile, ticket: hostile, title: hostile, service: hostile }],
    changedFiles: 1,
    detailsUrl: 'javascript:alert(1)',
    evidence: { read: [], ignored: [] },
  } as unknown as Decision);

  // Code spans show their content literally (no HTML, links or mentions there): judge the text outside them.
  const outsideCode = (text: string) => text.replace(/(?<![\\`])(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, '');
  it('keeps every hostile value on its own line, as text: no HTML, links, images, mentions or second marker', () => {
    const lines = md.split('\n');
    assert.equal(lines[0], DECISION_MARKER);
    assert.equal(md.split(DECISION_MARKER).length, 2, 'the marker appears once, at the top');
    const text = outsideCode(md.slice(DECISION_MARKER.length));
    assert.ok(!/<img|<!--/.test(text), 'no raw HTML or comment');
    for (const line of lines.filter((l) => l.includes('onerror')))
      assert.match(line, /^(- |\| |\*\*)/, `stays inside its list item, row or heading: ${line}`);
    assert.ok(!/(^|[^\\])\[click/.test(text), 'no link');
    assert.ok(!/(^|[^\\])!\[/.test(text), 'no image');
    assert.ok(!text.includes('@everyone'), 'no mention');
    assert.ok(!md.includes('javascript:'), 'only an http(s) details link');
  });
  it('keeps the table to its five columns', () => {
    const row = md.split('\n').find((l) => l.startsWith('| ') && l.includes('onerror'));
    assert.ok(row);
    assert.equal(row.replace(/\\\|/g, '').split('|').length - 1, 6);
  });
  it('fences code spans past any backtick run, on one line', () => {
    assert.equal(mdCode('a`b'), '``a`b``');
    assert.equal(mdCode('`x'), '`` `x ``');
    assert.equal(mdCode('a\nb'), '`a b`');
    assert.equal(mdText('<b>|x\ny'), '&lt;b&gt;\\|x y');
  });
});

describe('renderMarkdown', () => {
  it('names failures by scenario and guard findings in plain words', () => {
    const md = renderMarkdown({
      schema: 'vgate.decision/1',
      decision: 'blocked',
      reasons: ['notes: gate failed (failed: test)'],
      base: 'main',
      mergeBase: 'abc',
      head: 'def',
      policy: { autoMerge: 'low' },
      risk: {
        tier: 'medium',
        matches: [{ file: 'go.sum', tier: 'medium', rule: 'x', reason: 'dependencies' }],
        low: 0,
        rules: 'built-in',
      },
      services: [
        {
          name: 'notes',
          change: 'affected',
          gate: 'fail',
          gateDetail: 'failed: test',
          guard: 'needs-human',
          tests: { total: 3, failed: 1, knownFailures: 0 },
          failures: [{ id: 'CRT-201', title: 't', file: 'notes.spec.ts', line: 12, message: 'POST /notes -> 500' }],
          guardFindings: [
            { rule: 'tests-weakened', file: 'regression/notes/tests/notes.spec.ts', detail: 'assertions 5 -> 3' },
          ],
          knownFailures: [],
        },
      ],
      knownFailures: [],
      changedFiles: 2,
      evidence: { read: [], ignored: [] },
    });
    assert.match(md, /❌ Blocked/);
    assert.match(md, /`CRT-201` `notes\.spec\.ts:12`: POST \/notes -&gt; 500/);
    assert.match(md, /Tests were removed or now check less/);
    assert.match(md, /medium: `go\.sum` \(dependencies\)/);
    assert.ok(!md.includes('{'), 'no raw JSON');
  });
});

describe('vgate.yaml policy and risk', () => {
  const project = (text: string) => {
    const root = mkdtempSync(join(tmpdir(), 'vgate-policy-'));
    dirs.push(root);
    write(root, 'vgate.yaml', text);
    return () => readProject(root);
  };
  it('defaults to every change needing a human, and reads tiers in the order written', () => {
    assert.deepEqual(project('version: 1.0.0\n')().policy, { autoMerge: 'none' });
    const read = project(
      "policy: { autoMerge: medium }\nrisk:\n  low: ['docs/**']\n  high: [{ path: 'db/**', reason: schema }]\n",
    )();
    assert.deepEqual(read.policy, { autoMerge: 'medium' });
    assert.deepEqual(read.risk, [
      { tier: 'low', path: 'docs/**', reason: undefined },
      { tier: 'high', path: 'db/**', reason: 'schema' },
    ]);
  });
  it('refuses an unknown tier or policy value with the field named', () => {
    assert.throws(project('policy: { autoMerge: always }\n'), /policy\.autoMerge/);
    assert.throws(project('risk: { critical: [] }\n'), /risk\.critical is not a tier/);
    assert.throws(project('risk: { high: [{ reason: x }] }\n'), /risk\.high\[0\] needs a path/);
  });
});

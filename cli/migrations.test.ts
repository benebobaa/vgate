import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readProject } from '../framework/project.ts';
import { treeState, type TreeState } from './commit.ts';
import { decide, decideFrom, judgeMigrations, renderMarkdown, type Decision } from './decide.ts';
import { lint, migrations, planEnvironment, type MigrationsReport } from './migrations.ts';
import { parseEnvironment } from '../framework/env/declare.ts';
import { migrateConfigs } from '../framework/env/migrate.ts';
import type { ServiceConfig } from '../framework/config.ts';
import type { Runtime } from './runtime.ts';
import type { RiskReport } from './risk.ts';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};

const report = (over: Partial<MigrationsReport>): MigrationsReport => ({
  schema: 'vgate.migrations/1',
  service: 'items',
  base: 'main',
  mergeBase: 'mb',
  commit: { sha: 'abc', dirty: false, fingerprint: 'f' },
  verdict: 'safe',
  reasons: [],
  dirs: ['db/migrations'],
  added: ['2.up.sql'],
  lint: [],
  steps: [],
  startedAt: '2026-11-18T00:00:00.000Z',
  durationMs: 1,
  ...over,
});
const now: TreeState = { sha: 'abc', dirty: false, fingerprint: 'f' };
const touched = ['db/migrations/2.up.sql'];

describe('judgeMigrations', () => {
  it('counts no evidence, another merge base or another tree as not verified', () => {
    assert.equal(judgeMigrations('items', touched, undefined, 'mb', now).state, 'missing');
    assert.equal(judgeMigrations('items', touched, report({ mergeBase: 'other' }), 'mb', now).state, 'missing');
    const stale = judgeMigrations('items', touched, report({ commit: { ...now, sha: 'old' } }), 'mb', now);
    assert.equal(stale.state, 'missing');
    assert.match(stale.reasons[0], /stale/);
  });
  it('carries a blocked or risky verdict with its reasons, and passes a safe one', () => {
    const blocked = judgeMigrations('items', touched, report({ verdict: 'blocked', reasons: ['x'] }), 'mb', now);
    assert.deepEqual([blocked.state, blocked.reasons], ['blocked', ['items migrations: x']]);
    assert.equal(
      judgeMigrations('items', touched, report({ verdict: 'needs-approval' }), 'mb', now).state,
      'needs-approval',
    );
    assert.equal(judgeMigrations('items', touched, report({}), 'mb', now).state, 'safe');
  });
});

describe('decide with migrations', () => {
  const lowRisk: RiskReport = { tier: 'low', rules: 'built-in', matches: [], low: 1 } as unknown as RiskReport;
  const green = [
    {
      name: 'items',
      change: 'affected' as const,
      gate: 'pass' as const,
      guard: 'auto' as const,
      failures: [],
      guardFindings: [],
      knownFailures: [],
    },
  ];
  const decideWith = (state: 'safe' | 'needs-approval' | 'blocked' | 'missing') =>
    decideFrom({
      affected: ['items'],
      risk: lowRisk,
      policy: { autoMerge: 'low' },
      services: green,
      migrations: [{ service: 'items', state, touched, reasons: [`items: ${state}`] }],
    });
  it('blocks on blocked or unverified migrations, asks a human on risky ones, merges safe ones', () => {
    assert.equal(decideWith('blocked').decision, 'blocked');
    assert.equal(decideWith('missing').decision, 'blocked');
    assert.deepEqual(decideWith('needs-approval'), { decision: 'needs-approval', reasons: ['items: needs-approval'] });
    assert.equal(decideWith('safe').decision, 'merge');
  });

  it('reads migrations.json evidence end to end: unverified blocks, current and safe merges', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vgate-decide-migrations-'));
    dirs.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@example.invalid');
    git(root, 'config', 'user.name', 't');
    // autoMerge: high, so the migrations rule is what decides (a migrations directory is high risk by default).
    write(root, 'vgate.yaml', 'version: 0.2.0\nservicesDir: regression\npolicy:\n  autoMerge: high\n');
    write(
      root,
      'regression/items/service.yaml',
      [
        'spec: openapi.yaml',
        "paths: ['app/**']",
        'environment:',
        '  app: { image: items:1, port: 8080 }',
        '  dependencies:',
        '    db:',
        '      kind: postgres',
        '      migrate: { dir: app/db/migrations, command: up }',
        '',
      ].join('\n'),
    );
    write(root, 'regression/items/openapi.yaml', 'openapi: 3.1.0\n');
    write(root, 'app/db/migrations/1.up.sql', 'CREATE TABLE items (id int);\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'app/db/migrations/2.up.sql', 'ALTER TABLE items ADD COLUMN note text;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'feature');
    const project = readProject(root);
    const head = treeState(project);
    const mergeBase = git(root, 'merge-base', 'main', 'HEAD');
    write(
      root,
      'evidence/items/verdict.json',
      JSON.stringify({
        schema: 'vgate.verdict/1',
        service: 'items',
        verdict: 'pass',
        complete: true,
        startedAt: '2026-11-18T00:00:00.000Z',
        expectations: {},
        steps: [],
        commit: head,
      }),
    );
    write(
      root,
      'evidence/items/guard.json',
      JSON.stringify({ schema: 'vgate.guard/1', service: 'items', base: 'main', head, decision: 'auto', findings: [] }),
    );
    const evidence = join(root, 'evidence');
    const first = (await decide(project, { base: 'main', evidence })).data as Decision;
    assert.equal(first.decision, 'blocked', first.reasons.join('; '));
    assert.match(first.reasons.join(' '), /touches 1 migration file, but they were not verified/);

    write(root, 'evidence/items/migrations.json', JSON.stringify(report({ mergeBase, commit: head })));
    const second = (await decide(project, { base: 'main', evidence })).data as Decision;
    assert.equal(second.decision, 'merge', second.reasons.join('; '));
    assert.deepEqual(
      second.migrations.map((m) => [m.service, m.state, m.touched]),
      [['items', 'safe', ['app/db/migrations/2.up.sql']]],
    );
    const md = readFileSync(join(root, 'reports/decision.md'), 'utf8');
    assert.match(md, /Database migrations/);
    assert.match(md, /the deployed version keeps working on the new schema/);

    // Read in name order, the blocked file comes first and the safe one last: the worse verdict still wins.
    write(
      root,
      'evidence/aa/migrations.json',
      JSON.stringify(report({ mergeBase, commit: head, verdict: 'blocked', reasons: ['old code fails'] })),
    );
    const third = (await decide(project, { base: 'main', evidence })).data as Decision;
    assert.equal(third.decision, 'blocked');
    assert.match(renderMarkdown(third), /not safe to deploy/);
  });

  /** A repo whose base declares `migrate:` on app/db/migrations; `change` edits the branch, then decide runs. */
  async function decideAfter(change: (root: string) => void, paths = "['app/**']"): Promise<Decision> {
    const root = mkdtempSync(join(tmpdir(), 'vgate-decide-migrations-'));
    dirs.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@example.invalid');
    git(root, 'config', 'user.name', 't');
    write(root, 'vgate.yaml', 'version: 0.2.0\nservicesDir: regression\npolicy:\n  autoMerge: high\n');
    const service = (migrate: string) =>
      `spec: openapi.yaml\npaths: ${paths}\nenvironment:\n  app: { image: items:1, port: 8080 }\n  dependencies:\n    db:\n      kind: postgres\n${migrate}`;
    write(root, 'regression/items/service.yaml', service('      migrate: { dir: app/db/migrations, command: up }\n'));
    write(root, 'regression/items/openapi.yaml', 'openapi: 3.1.0\n');
    write(root, 'app/db/migrations/1.up.sql', 'CREATE TABLE items (id int);\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    change(root);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'feature');
    const project = readProject(root);
    const head = treeState(project);
    write(
      root,
      'evidence/items/verdict.json',
      JSON.stringify({
        schema: 'vgate.verdict/1',
        service: 'items',
        verdict: 'pass',
        complete: true,
        startedAt: '2026-11-18T00:00:00.000Z',
        expectations: {},
        steps: [],
        commit: head,
      }),
    );
    write(
      root,
      'evidence/items/guard.json',
      JSON.stringify({ schema: 'vgate.guard/1', service: 'items', base: 'main', head, decision: 'auto', findings: [] }),
    );
    return (await decide(project, { base: 'main', evidence: join(root, 'evidence') })).data as Decision;
  }

  it('still sees a migration added where the base kept them after `migrate:` is dropped', async () => {
    const d = await decideAfter((root) => {
      write(
        root,
        'regression/items/service.yaml',
        "spec: openapi.yaml\npaths: ['app/**']\nenvironment:\n  app: { image: items:1, port: 8080 }\n  dependencies:\n    db: { kind: postgres }\n",
      );
      write(root, 'app/db/migrations/2.up.sql', 'ALTER TABLE items DROP COLUMN id;\n');
    });
    assert.equal(d.decision, 'blocked', d.reasons.join('; '));
    assert.deepEqual(
      d.migrations.map((m) => [m.state, m.touched]),
      [['missing', ['app/db/migrations/2.up.sql']]],
    );
  });

  it("counts a service's migrations as affecting it even when its paths: leave them out", async () => {
    const d = await decideAfter(
      (root) => write(root, 'app/db/migrations/2.up.sql', 'ALTER TABLE items DROP COLUMN id;\n'),
      "['app/src/**']",
    );
    assert.equal(d.decision, 'blocked', d.reasons.join('; '));
    assert.deepEqual(
      d.migrations.map((m) => [m.service, m.state]),
      [['items', 'missing']],
    );
  });
});

describe('vgate migrations: what it cannot verify is not safe', () => {
  it('asks a human for an edited migration the deployed databases already applied, without Docker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vgate-migrations-edit-'));
    dirs.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@example.invalid');
    git(root, 'config', 'user.name', 't');
    write(root, 'vgate.yaml', 'version: 0.2.0\nservicesDir: regression\n');
    write(
      root,
      'regression/items/service.yaml',
      [
        'spec: openapi.yaml',
        "environments: { local: { baseUrl: 'http://127.0.0.1:1' } }",
        'environment:',
        '  app: { image: items:1, port: 8080 }',
        '  dependencies:',
        '    db: { kind: postgres, migrate: { dir: app/db/migrations, command: up } }',
        '',
      ].join('\n'),
    );
    write(root, 'regression/items/openapi.yaml', 'openapi: 3.1.0\n');
    write(root, 'app/db/migrations/1.up.sql', 'CREATE TABLE items (id int);\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'app/db/migrations/1.up.sql', 'CREATE TABLE items (id bigint, note text);\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'edit an applied migration');
    const result = await migrations(readProject(root), {} as Runtime, {
      service: 'items',
      base: 'main',
      env: 'local',
      live: false,
    });
    const data = result.data as MigrationsReport;
    assert.equal(result.exitCode, 1, result.summary);
    assert.equal(data.verdict, 'needs-approval');
    assert.match(data.reasons[0], /1\.up\.sql is edited, but the deployed databases already applied it/);
  });

  /** A repo on `main` (`base` writes it) and a `feature` branch (`change` edits it); `vgate migrations` then runs. */
  async function migrationsAfter(
    service: string,
    base: (root: string) => void,
    change: (root: string) => void,
  ): Promise<{ result: Awaited<ReturnType<typeof migrations>>; data: MigrationsReport }> {
    const root = mkdtempSync(join(tmpdir(), 'vgate-migrations-files-'));
    dirs.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@example.invalid');
    git(root, 'config', 'user.name', 't');
    write(root, 'vgate.yaml', 'version: 0.2.0\nservicesDir: regression\n');
    base(root);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    change(root);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'feature');
    const result = await migrations(readProject(root), {} as Runtime, {
      service,
      base: 'main',
      env: 'local',
      live: false,
    });
    return { result, data: result.data as MigrationsReport };
  }
  const serviceYaml = (migrate: string) =>
    [
      'spec: openapi.yaml',
      "environments: { local: { baseUrl: 'http://127.0.0.1:1' } }",
      'environment:',
      '  app: { image: items:1, port: 8080 }',
      '  dependencies:',
      `    db: { kind: postgres, migrate: ${migrate} }`,
      '',
    ].join('\n');

  it('counts no README or dotfile in the migrations directory as a migration, added or edited', async () => {
    const { result, data } = await migrationsAfter(
      'items',
      (root) => {
        write(root, 'regression/items/service.yaml', serviceYaml('{ dir: app/db/migrations, command: up }'));
        write(root, 'regression/items/openapi.yaml', 'openapi: 3.1.0\n');
        write(root, 'app/db/migrations/1.up.sql', 'CREATE TABLE items (id int);\n');
        write(root, 'app/db/migrations/README.md', 'Plain SQL, applied in name order.\n');
      },
      (root) => {
        write(root, 'app/db/migrations/README.md', 'Plain SQL, applied in name order by psql.\n');
        write(root, 'app/db/migrations/.gitkeep', '');
      },
    );
    assert.equal(result.exitCode, 0, result.summary);
    assert.deepEqual([data.verdict, data.added, data.reasons], ['safe', [], ['this change adds no migration']]);
  });

  it("reads the base's migrations from the same directory when the base does not declare the service yet", async () => {
    // larasrouter: goose migrations (and a README) deployed for months, the vgate service that checks them is new.
    const goose = 'goose -dir /migrations postgres "$DATABASE_URL" up';
    const { result, data } = await migrationsAfter(
      'api-migrations',
      (root) => {
        write(root, 'services/api/db/migrations/00001_init.sql', '-- +goose Up\nCREATE TABLE a (id int);\n');
        write(root, 'services/api/db/migrations/00002_b.sql', '-- +goose Up\nCREATE TABLE b (id int);\n');
        write(root, 'services/api/db/migrations/README.md', 'goose migrations\n');
      },
      (root) => {
        write(
          root,
          'regression/api-migrations/service.yaml',
          serviceYaml(`{ dir: services/api/db/migrations, command: '${goose}' }`),
        );
        write(root, 'regression/api-migrations/openapi.yaml', 'openapi: 3.1.0\n');
      },
    );
    assert.equal(result.exitCode, 0, result.summary);
    assert.equal(data.verdict, 'safe');
    assert.deepEqual(data.added, []);
    assert.equal(data.reasons[0], 'this change adds no migration');
    assert.match(data.reasons[1], /api-migrations is new at main: the 2 migrations in services\/api\/db\/migrations/);
  });

  it("lints only a goose migration's Up section, with findings on the file's own lines", async (t) => {
    const top = mkdtempSync(join(tmpdir(), 'vgate-migrations-lint-'));
    dirs.push(top);
    // Reversible and additive: its Down drops what its Up adds, which is not a risk for the running version.
    write(
      top,
      'db/00003_note.sql',
      '-- +goose Up\nALTER TABLE items ADD COLUMN note text;\n\n-- +goose Down\nALTER TABLE items DROP COLUMN note;\n',
    );
    // The Up section itself drops a column, on line 3 of the file.
    write(
      top,
      'db/00004_drop.sql',
      '-- +goose Up\n-- the legacy column is unused since v2\nALTER TABLE items DROP COLUMN legacy;\n-- +goose Down\nALTER TABLE items ADD COLUMN legacy text;\n',
    );
    const cfg = { dependency: 'db', kind: 'postgres', dir: join(top, 'db'), command: 'goose up', smoke: 'GET /' };
    const linted = await lint(cfg, ['00003_note.sql', '00004_drop.sql'], top, false);
    if (linted.unlinted) return t.skip(`squawk is not available here: ${linted.unlinted}`);
    const risky = linted.findings.filter((f) => f.level === 'risky').map((f) => [f.file, f.line, f.rule]);
    assert.deepEqual(risky, [['db/00004_drop.sql', 3, 'ban-drop-column']]);
  });

  it('reports a squawk that did not run as unlinted, never as no findings', async () => {
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const cfg = { dependency: 'db', kind: 'postgres', dir: '/tmp', command: 'up', smoke: 'GET /' };
      const linted = await lint(cfg, ['2.up.sql'], '/tmp', false);
      assert.deepEqual(linted.findings, []);
      assert.match(linted.unlinted ?? '', /not linted: squawk did not run/);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("labels the check's environment, so `vgate down` finds what a killed check left", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vgate-migrations-plan-'));
    dirs.push(dir);
    const decl = parseEnvironment(
      {
        app: { image: 'items:1', port: 8080 },
        dependencies: { db: { kind: 'postgres', migrate: { dir: 'db', command: 'up' } } },
      },
      { service: dir, project: dir },
    );
    const [cfg] = migrateConfigs(decl, dir);
    const env = await planEnvironment(
      { name: 'items', environment: decl } as ServiceConfig,
      cfg,
      dir,
      dir,
      'r1',
      '/p/reports',
    );
    const compose = readFileSync(env.composeFile, 'utf8');
    assert.match(compose, /dev\.vgate\.service: items-mig/);
    assert.match(compose, /dev\.vgate\.reports: \/p\/reports/);
    assert.equal(env.project, 'vgate-items-mig-r1');
  });
});

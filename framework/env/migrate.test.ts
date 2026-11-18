import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnvironment } from './declare.ts';
import {
  addedMigrations,
  applyOrder,
  DEFAULT_SMOKE,
  isUndoFile,
  migrateConfigs,
  migrationDirsOf,
  migrationsVerdict,
  editedMigrations,
  parseSquawk,
  touchedMigrations,
  type MigrationStep,
} from './migrate.ts';

const env = (migrate: unknown) =>
  parseEnvironment(
    { app: { image: 'app:1', port: 8080 }, dependencies: { db: { kind: 'postgres', migrate } } },
    { service: '/p/services/svc', project: '/p' },
  );

describe('migrateConfigs', () => {
  it('reads migrate: of a dependency, resolving dir against the project root', () => {
    const [cfg] = migrateConfigs(env({ dir: 'db/migrations', command: 'up', down: 'down' }), '/p');
    assert.deepEqual(cfg, {
      dependency: 'db',
      kind: 'postgres',
      dir: '/p/db/migrations',
      command: 'up',
      down: 'down',
      image: undefined,
      smoke: DEFAULT_SMOKE,
    });
  });
  it('refuses an incomplete or misspelled block, and is empty without one', () => {
    assert.throws(() => migrateConfigs(env({ dir: 'db' }), '/p'), /migrate\.command/);
    assert.throws(() => migrateConfigs(env({ dir: 'db', command: 'up', donw: 'x' }), '/p'), /unknown key\(s\) donw/);
    assert.deepEqual(migrateConfigs(undefined, '/p'), []);
  });
});

describe('the files a change touches and adds', () => {
  const yaml =
    'environment:\n  dependencies:\n    db:\n      kind: postgres\n      migrate: { dir: db/migrations, command: up }\n';
  it('finds the migrations directories relative to the repository top, below a project prefix too', () => {
    assert.deepEqual(migrationDirsOf(yaml, '/r/backend', '/r'), ['backend/db/migrations']);
    assert.deepEqual(migrationDirsOf('{ not: [yaml', '/r', '/r'), []);
    assert.deepEqual(migrationDirsOf(undefined, '/r', '/r'), []);
  });
  it('counts only files inside a migrations directory', () => {
    assert.deepEqual(
      touchedMigrations(['db/migrations/2.up.sql', 'db/migrations-old/x.sql', 'db/seed.sql'], ['db/migrations']),
      ['db/migrations/2.up.sql'],
    );
  });
  it('adds the forward files the base lacks, in apply order, and never the undo files', () => {
    assert.deepEqual(
      addedMigrations(['1.up.sql', '1.down.sql'], ['3.up.sql', '1.up.sql', '1.down.sql', '2.up.sql', '2.down.sql']),
      ['2.up.sql', '3.up.sql'],
    );
    assert.ok(isUndoFile('0002_x.down.sql') && isUndoFile('U2__drop.sql'));
    assert.ok(!isUndoFile('V2__add.sql') && !isUndoFile('20260101_goose.sql') && !isUndoFile('download.sql'));
  });
});

describe('parseSquawk', () => {
  const out = JSON.stringify([
    { file: '/r/db/2.sql', line: 0, rule_name: 'require-lock-timeout', message: 'missing lock_timeout' },
    { file: '/r/db/2.sql', line: 1, rule_name: 'renaming-column', message: 'renaming a column may break' },
    { file: '/r/db/2.sql', line: 1, rule_name: 'renaming-column', message: 'twice' },
  ]);
  it('makes deploy risks risky, hygiene info, lines 1-based, each once, risky first', () => {
    const findings = parseSquawk(out, (f) => f.replace('/r/', ''));
    assert.deepEqual(
      findings.map((f) => [f.level, f.file, f.line, f.rule]),
      [
        ['risky', 'db/2.sql', 2, 'renaming-column'],
        ['info', 'db/2.sql', 1, 'require-lock-timeout'],
      ],
    );
    assert.match(findings[0].message, /running code still uses the old name/);
  });
  it('reads nothing from output that is not its JSON', () => {
    assert.deepEqual(parseSquawk('error: no such file'), []);
  });
});

describe('migrationsVerdict', () => {
  const step = (name: MigrationStep['name'], status: MigrationStep['status'], detail = 'x'): MigrationStep => ({
    name,
    status,
    durationMs: 1,
    detail,
  });
  const green = [step('apply-base', 'pass'), step('seed', 'pass'), step('apply-change', 'pass')];
  const risky = { file: 'a.sql', line: 1, rule: 'renaming-column', level: 'risky' as const, message: 'renames' };
  const info = { ...risky, rule: 'prefer-robust-stmts', level: 'info' as const };
  it('is safe when everything applies and only hygiene is flagged, with skipped checks', () => {
    assert.equal(migrationsVerdict([...green, step('round-trip', 'skipped')], [info]).verdict, 'safe');
  });
  it('blocks a migration that does not apply or undo', () => {
    assert.equal(migrationsVerdict([step('apply-change', 'fail')], []).verdict, 'blocked');
    assert.equal(migrationsVerdict([...green, step('round-trip', 'fail')], []).verdict, 'blocked');
  });
  it('blocks when the deployed code fails on the migrated schema, saying why in deploy terms', () => {
    const v = migrationsVerdict([...green, step('old-code', 'fail', '1 of 2 fail')], [risky]);
    assert.equal(v.verdict, 'blocked');
    assert.match(v.reasons[0], /deploying this migration before the new code breaks the running version/);
  });
  it('asks a human for a risky finding on migrations that otherwise pass', () => {
    const v = migrationsVerdict([...green, step('old-code', 'pass')], [risky, info]);
    assert.equal(v.verdict, 'needs-approval');
    assert.deepEqual(v.reasons, ['a.sql:1 renames']);
  });
  it('asks a human when a check could not be made: unknown is never safe', () => {
    const v = migrationsVerdict([...green, step('old-code', 'pass')], [], ['the added migrations were not linted']);
    assert.deepEqual(v, { verdict: 'needs-approval', reasons: ['the added migrations were not linted'] });
  });
});

describe('editedMigrations', () => {
  it('finds forward migrations of the base edited or removed, not undo files', () => {
    const base = ['1.up.sql', '1.down.sql', '2.up.sql', '3.up.sql'];
    const head = ['1.up.sql', '1.down.sql', '2.up.sql', '4.up.sql'];
    const same = (f: string) => f !== '2.up.sql' && f !== '1.down.sql';
    assert.deepEqual(editedMigrations(base, head, same), { edited: ['2.up.sql'], removed: ['3.up.sql'] });
  });
});

describe('applyOrder', () => {
  it("seeds the deployed schema before the change's migrations, and a new service's schema after its own", () => {
    assert.deepEqual(applyOrder(false), ['seed', 'apply-change']);
    assert.deepEqual(applyOrder(true), ['apply-change', 'seed']);
  });
});

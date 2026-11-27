/**
 * Database migrations, from a dependency of a declared environment (docs/deploy-safety.md):
 *
 *   environment:
 *     dependencies:
 *       db:
 *         kind: postgres
 *         seed: seed.sql
 *         migrate:
 *           dir: services/orders/db/migrations      # repository path (from vgate.yaml's directory)
 *           command: goose -dir /migrations postgres "$DATABASE_URL" up
 *           down: goose -dir /migrations postgres "$DATABASE_URL" down
 *           image: ghcr.io/kukymbr/goose-docker:3.26.0   # default: the dependency's own image
 *           smoke: 'GET /'                      # the base tests that may run against the migrated schema
 *
 * `command` and `down` run in a container on the environment's sealed network with the migrations at /migrations and
 * DATABASE_URL, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME pointing at the dependency. `down` undoes one
 * migration per run. Pure parts only (config, the files a change adds, the linter's findings), so the rules are
 * self-tested without Docker; cli/migrations.ts carries the checks out.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import type { EnvironmentDecl } from './declare.ts';

export interface MigrateConfig {
  /** The dependency's name in service.yaml (its host name inside the environment). */
  dependency: string;
  kind: string;
  /** Absolute path of the migrations directory. */
  dir: string;
  command: string;
  down?: string;
  image?: string;
  /** Playwright --grep of the base tests that run against the migrated schema (the deployed code's own checks). */
  smoke: string;
}

/** Default smoke subset: the read-only operations, by the convention that tests are grouped as `METHOD /path`. */
export const DEFAULT_SMOKE = 'GET /';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function text(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${at} must be a non-empty string`);
  return value;
}

/** Every `migrate:` of the declared dependencies; `dir` resolves against the project root. */
export function migrateConfigs(decl: EnvironmentDecl | undefined, projectRoot: string): MigrateConfig[] {
  if (!decl) return [];
  const out: MigrateConfig[] = [];
  for (const [name, dep] of Object.entries(decl.dependencies)) {
    const raw = dep.options.migrate;
    if (raw === undefined) continue;
    const at = `environment.dependencies.${name}.migrate`;
    if (!isRecord(raw)) throw new Error(`${at} must be a map: { dir, command, down?, image?, smoke? }`);
    const unknown = Object.keys(raw).filter((k) => !['dir', 'command', 'down', 'image', 'smoke'].includes(k));
    if (unknown.length > 0) throw new Error(`${at}: unknown key(s) ${unknown.join(', ')}`);
    const dir = text(raw.dir, `${at}.dir`);
    out.push({
      dependency: name,
      kind: dep.kind,
      dir: isAbsolute(dir) ? dir : resolve(projectRoot, dir),
      command: text(raw.command, `${at}.command`),
      down: raw.down === undefined ? undefined : text(raw.down, `${at}.down`),
      image: raw.image === undefined ? undefined : text(raw.image, `${at}.image`),
      smoke: raw.smoke === undefined ? DEFAULT_SMOKE : text(raw.smoke, `${at}.smoke`),
    });
  }
  return out;
}

/**
 * The migrations directories a service.yaml declares, relative to the repository's top (`prefix` is the project's
 * path below it, as `affected` reports it). Read from the raw file: decide needs only the paths, not a valid
 * environment, and must not fail on a variable that only CI sets.
 */
export function migrationDirsOf(serviceYaml: string | undefined, projectRoot: string, top: string): string[] {
  if (!serviceYaml) return [];
  let raw: unknown;
  try {
    raw = parse(serviceYaml);
  } catch {
    return [];
  }
  const deps = isRecord(raw) && isRecord(raw.environment) ? raw.environment.dependencies : undefined;
  if (!isRecord(deps)) return [];
  const dirs: string[] = [];
  for (const dep of Object.values(deps)) {
    const migrate = isRecord(dep) ? dep.migrate : undefined;
    if (!isRecord(migrate) || typeof migrate.dir !== 'string' || migrate.dir.trim() === '') continue;
    const abs = isAbsolute(migrate.dir) ? migrate.dir : resolve(projectRoot, migrate.dir);
    dirs.push(relative(top, abs).split('\\').join('/'));
  }
  return dirs;
}

/** Repository files (top-relative) inside one of `dirs`. */
export function touchedMigrations(files: string[], dirs: string[]): string[] {
  return files.filter((file) => dirs.some((dir) => dir !== '' && (file === dir || file.startsWith(`${dir}/`))));
}

/**
 * How the migration tool names its files: what decides which files of the migrations directory are migrations (a
 * README, a `.gitkeep` or goose's `embed.go` beside them is not one, and counting it would undo one migration too many
 * in the round trip).
 */
export type MigrationLayout = 'goose' | 'golang-migrate' | 'flyway' | 'generic';

/**
 * The layout of the tool `command` (or `image`) runs. goose is also recognised from its `-- +goose Up` annotations
 * (`gooseAnnotated`), for a project that runs goose through its own binary. Anything else is `generic`.
 */
export function migrationLayout(
  cfg: Pick<MigrateConfig, 'command' | 'image'>,
  gooseAnnotated = false,
): MigrationLayout {
  const tool = `${cfg.command}\n${cfg.image ?? ''}`;
  if (gooseAnnotated || /\bgoose\b/i.test(tool)) return 'goose';
  if (/\bflyway\b/i.test(tool)) return 'flyway';
  if (
    /(?:^|[\s;&|(/])migrate\s+-(?:path|source|database)\b/.test(cfg.command) ||
    /\bmigrate\/migrate\b/.test(cfg.image ?? '')
  )
    return 'golang-migrate';
  return 'generic';
}

/** A goose annotation line: `-- +goose Up`, `-- +goose Down`. Exported for the CLI's layout detection. */
export const GOOSE_ANNOTATION = /^\s*--\s*\+goose\s+(up|down)\b/i;

/**
 * Whether `file` (a name in the migrations directory) is a migration of `layout`, forward or undo:
 *
 * - goose: `<version>_<name>.sql` or `.go` (not a `_test.go`)
 * - golang-migrate: `<version>_<title>.up.<ext>` and `.down.<ext>`
 * - Flyway: `V<version>__<desc>.sql`, `U<version>__<desc>.sql`, `R__<desc>.sql`
 * - generic (a tool vgate does not know): every file but dotfiles and documentation, so an Alembic, knex or plain-SQL
 *   migration is never missed; a file that is no migration then shows up as one, never the other way round
 */
export function isMigrationFile(file: string, layout: MigrationLayout): boolean {
  const name = file.split('/').pop() ?? file;
  switch (layout) {
    case 'goose':
      return /^\d+_.*\.(?:sql|go)$/.test(name) && !name.endsWith('_test.go');
    case 'golang-migrate':
      return /^\d+_.*\.(?:up|down)\.[^.]+$/.test(name);
    case 'flyway':
      return /^(?:[VU]\d+(?:[._]\d+)*|R)__.+\.sql$/.test(name);
    case 'generic':
      return !name.startsWith('.') && !/\.(?:md|markdown|txt|rst|adoc)$/i.test(name);
  }
}

/**
 * The SQL that deploys: a goose file keeps its undo in the same file, after `-- +goose Down`, and that section only runs
 * on a rollback. The Down sections' lines are blanked, not removed, so a linter's line numbers stay the file's. Text
 * without a Down annotation comes back unchanged.
 */
export function upSection(sql: string): string {
  let down = false;
  return sql
    .split('\n')
    .map((line) => {
      const annotation = GOOSE_ANNOTATION.exec(line);
      if (annotation) down = annotation[1].toLowerCase() === 'down';
      return down ? '' : line;
    })
    .join('\n');
}

/**
 * A file that undoes a migration rather than being one: golang-migrate's and similar `*.down.sql`, Flyway's `U<n>__`.
 * Tools apply only the forward files; counting the undo files would undo too much in the round trip.
 */
export function isUndoFile(file: string): boolean {
  const name = file.split('/').pop() ?? file;
  return /\.down\.[a-z0-9]+$/i.test(name) || /^U\d+(?:[._]\d+)*__/.test(name);
}

/**
 * The forward migrations of the base that the change edits or removes. Production applied the base's version and a
 * migration tool never runs one again: the edit does nothing there while a fresh database gets the new text.
 */
export function editedMigrations(
  baseFiles: string[],
  headFiles: string[],
  same: (file: string) => boolean,
): { edited: string[]; removed: string[] } {
  const forward = baseFiles.filter((file) => !isUndoFile(file));
  return {
    edited: forward.filter((file) => headFiles.includes(file) && !same(file)),
    removed: forward.filter((file) => !headFiles.includes(file)),
  };
}

/** The forward migration files of `head` that `base` did not have, in name order (the order tools apply them in). */
export function addedMigrations(baseFiles: string[], headFiles: string[]): string[] {
  const before = new Set(baseFiles);
  return headFiles.filter((file) => !before.has(file) && !isUndoFile(file)).sort();
}

export type LintLevel = 'risky' | 'info';

export interface LintFinding {
  file: string;
  line: number;
  rule: string;
  level: LintLevel;
  /** In words a reviewer who does not know the rule understands. */
  message: string;
}

/**
 * The squawk rules that describe a real risk of deploying the migration while the current version runs: a lock
 * that stops traffic, or a schema the running code cannot use. Squawk's other rules (timeouts, `if not exists`,
 * bigint over int...) are hygiene: shown, never a reason to stop a merge.
 */
export const RISKY_RULES: Record<string, string> = {
  'adding-required-field':
    'adds a NOT NULL column without a default: inserts from the running code, which does not set it, fail',
  'adding-not-nullable-field': 'sets a column NOT NULL: the table is locked while every row is checked',
  'require-concurrent-index-creation': 'creates an index without CONCURRENTLY: writes to the table stop meanwhile',
  'require-concurrent-index-deletion': 'drops an index without CONCURRENTLY: the table is locked meanwhile',
  'renaming-column': 'renames a column: the running code still uses the old name',
  'renaming-table': 'renames a table: the running code still uses the old name',
  'changing-column-type': 'changes a column type: the table is rewritten and locked, and readers may break',
  'ban-drop-column': 'drops a column: the running code may still read or write it',
  'ban-drop-table': 'drops a table: the running code may still use it',
  'ban-drop-database': 'drops a database',
  'ban-drop-not-null': 'drops NOT NULL: readers that rely on a value may break',
  'adding-foreign-key-constraint': 'adds a foreign key without NOT VALID: both tables are locked while it is checked',
  'constraint-missing-not-valid': 'adds a constraint without NOT VALID: the table is locked while every row is checked',
  'disallowed-unique-constraint': 'adds a unique constraint directly: the table is locked while the index builds',
  'adding-serial-primary-key-field': 'adds a serial primary key: the table is rewritten and locked',
  'adding-field-with-default': 'adds a column with a volatile default: the table is rewritten and locked',
  'ban-alter-domain-with-add-constraint': 'adds a constraint to a domain: every column using it is checked',
  'ban-create-domain-with-constraint': 'creates a domain with a constraint: later changes to it lock tables',
  'ban-truncate-cascade': 'truncates with CASCADE: rows in other tables go too',
};

/** Squawk's `--reporter json` output (one entry per violation, 0-based lines) -> findings, risky first. */
export function parseSquawk(json: string, shownAs: (file: string) => string = (f) => f): LintFinding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const findings: LintFinding[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const rule = typeof item.rule_name === 'string' ? item.rule_name : 'unknown';
    const file = shownAs(typeof item.file === 'string' ? item.file : '?');
    const line = (typeof item.line === 'number' ? item.line : 0) + 1;
    const key = `${file}:${line}:${rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const risky = RISKY_RULES[rule];
    findings.push({
      file,
      line,
      rule,
      level: risky ? 'risky' : 'info',
      message: risky ?? (typeof item.message === 'string' ? item.message : rule),
    });
  }
  return findings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'risky' ? -1 : 1));
}

export type MigrationsVerdict = 'safe' | 'needs-approval' | 'blocked' | 'not-configured';

export interface MigrationStep {
  name: 'apply-base' | 'seed' | 'apply-change' | 'round-trip' | 'old-code';
  status: 'pass' | 'fail' | 'skipped';
  durationMs: number;
  detail: string;
}

/**
 * The verdict from the four checks, in order of weight: a migration that does not apply (or undo) blocks; the deployed
 * code failing on the migrated schema blocks (deploy order: the migration runs before the new code is live); a risky
 * lint finding, or a check that could not be made, needs a human (unknown is never safe); else safe.
 */
export function migrationsVerdict(
  steps: MigrationStep[],
  lint: LintFinding[],
  /** What could not be verified (squawk did not run, no smoke test matched, an applied migration edited): a human. */
  unverified: string[] = [],
): { verdict: MigrationsVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const failed = (name: MigrationStep['name']) => steps.find((s) => s.name === name && s.status === 'fail');
  for (const name of ['apply-base', 'seed', 'apply-change', 'round-trip'] as const) {
    const step = failed(name);
    if (step) reasons.push(`${PLAIN_STEP[name]} failed: ${step.detail}`);
  }
  const old = failed('old-code');
  if (old) reasons.push(`deploying this migration before the new code breaks the running version: ${old.detail}`);
  if (reasons.length > 0) return { verdict: 'blocked', reasons };
  const risky = lint.filter((f) => f.level === 'risky');
  for (const f of risky) reasons.push(`${f.file}:${f.line} ${f.message}`);
  reasons.push(...unverified);
  if (reasons.length > 0) return { verdict: 'needs-approval', reasons };
  return { verdict: 'safe', reasons: [] };
}

/**
 * The order of the seed and this change's migrations. The seed fills the tables the deployed schema has, so it runs
 * after the base's migrations and before the change's; a service new in the change has no deployed schema, and its
 * seed needs its own migrations first, as `vgate up` runs them.
 */
export function applyOrder(isNew: boolean): Array<'seed' | 'apply-change'> {
  return isNew ? ['apply-change', 'seed'] : ['seed', 'apply-change'];
}

export const PLAIN_STEP: Record<MigrationStep['name'], string> = {
  'apply-base': "applying the base's migrations",
  seed: 'loading the seed data',
  'apply-change': "applying this change's migrations",
  'round-trip': 'undoing and re-applying them',
  'old-code': 'the deployed code on the migrated schema',
};

/** The migration tool's environment: the dependency's internal endpoint, under the names tools expect. */
export function migrationEnvironment(dbExports: Record<string, string>): Record<string, string> {
  return {
    DATABASE_URL: dbExports.url ?? '',
    DB_HOST: dbExports.host ?? '',
    DB_PORT: dbExports.port ?? '',
    DB_USER: dbExports.user ?? '',
    DB_PASSWORD: dbExports.password ?? '',
    DB_NAME: dbExports.database ?? '',
    PGPASSWORD: dbExports.password ?? '',
    MIGRATIONS_DIR: '/migrations',
  };
}

/**
 * The compose service that runs a dependency's migration tool on the environment's sealed network: started with
 * `docker compose run --rm --no-deps -T -v <dir>:/migrations:ro migrate '<command>'`. In the `tools` profile, so
 * `up` never starts it on its own.
 */
export function migrateService(
  cfg: Pick<MigrateConfig, 'image'>,
  defaultImage: string,
  dbExports: Record<string, string>,
  dnsIp: string,
): Record<string, unknown> {
  return {
    image: cfg.image ?? defaultImage,
    entrypoint: ['sh', '-c'],
    environment: migrationEnvironment(dbExports),
    networks: ['sealed'],
    dns: [dnsIp],
    dns_search: ['.'], // as every container of the environment (generate.ts NO_SEARCH)
    profiles: ['tools'],
  };
}

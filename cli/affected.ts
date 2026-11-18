/**
 * `vgate affected`: which services a change can break, so a pull request gates exactly those. The change is every
 * path that differs between the merge base of `--base` and the working tree (commits on the branch, uncommitted
 * edits, untracked files), relative to the git top level.
 *
 * A service is affected by:
 *   - a change under its own directory (<servicesDir>/<svc>/), always;
 *   - a change to vgate.yaml or to shared files directly in <servicesDir>/, always;
 *   - a change matching its `paths:` globs (service.yaml); without `paths:`, any change outside the other services'
 *     directories (the safe default: a service that does not say what it depends on depends on everything).
 * A service that exists at the base but not any more is `deleted`: it cannot be gated, and its expectations are gone,
 * so `vgate decide` sends it to a human.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { parsePaths } from '../framework/config.ts';
import { PROJECT_FILE, type ProjectConfig } from '../framework/project.ts';
import { git } from './guard.ts';
import { CLI, EXIT, UsageError, type Result } from './output.ts';
import { listServices } from './project.ts';
import { matchesGlob } from './glob.ts';

export interface ChangeSet {
  base: string;
  mergeBase: string;
  /** The git top level. */
  top: string;
  /** The project root relative to the top level, with a trailing slash ('' when they are the same). */
  prefix: string;
  /** Changed paths relative to the top level, sorted, deduplicated. */
  files: string[];
}

/** The paths a change touches, or the Result that explains why they cannot be known (not a repo: exit 3). */
export function changeSet(project: ProjectConfig, base: string | undefined): ChangeSet | { result: Result } {
  if (!base) throw new UsageError(`Pass --base <git ref>, e.g. --base origin/main`);
  const root = realpathSync(project.root);
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0)
    return {
      result: {
        command: 'affected',
        ok: false,
        exitCode: EXIT.notReady,
        summary: `Not a git repository: ${root}. A change is measured against a base ref.`,
        next: [],
      },
    };
  const topDir = realpathSync(top.out.trim());
  if (git(topDir, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).code !== 0)
    throw new UsageError(`Unknown base ref "${base}" (fetch it first, e.g. git fetch origin <branch>)`);
  const mb = git(topDir, ['merge-base', base, 'HEAD']);
  // No common ancestor (unrelated histories): compare with the base itself rather than refusing.
  const mergeBase = mb.code === 0 ? mb.out.trim() : base;
  // NUL-separated, so no path comes back quoted. `--raw` shows each path's modes: a submodule (mode 160000) is listed
  // as `dir/`, so the globs that cover its directory (`libs/shared/**`) cover a bump of it too.
  const raw = git(topDir, ['diff', '--raw', '-z', '--no-renames', mergeBase]);
  const others = git(topDir, ['ls-files', '-z', '--others', '--exclude-standard']);
  // A diff that failed is not an empty change: "nothing changed" would let anything merge.
  const failed = [raw, others].find((run) => run.code !== 0);
  if (failed)
    return {
      result: {
        command: 'affected',
        ok: false,
        exitCode: EXIT.notReady,
        summary: `git could not list the changes since ${base}: ${failed.err.trim() || `exit ${failed.code}`}`,
        next: [],
      },
    };
  const diff = raw.out.split('\0');
  const changed: string[] = [];
  // Pairs of `:<old mode> <new mode> <old sha> <new sha> <status>` and the path.
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const [oldMode, newMode] = diff[i].slice(1).split(' ');
    changed.push(oldMode === '160000' || newMode === '160000' ? `${diff[i + 1]}/` : diff[i + 1]);
  }
  const files = [...new Set([...changed, ...others.out.split('\0')].filter(Boolean))].sort();
  const rel = relative(topDir, root).split('\\').join('/');
  return { base, mergeBase, top: topDir, prefix: rel === '' ? '' : `${rel}/`, files };
}

export interface AffectedService {
  name: string;
  reasons: string[];
}

export interface AffectedReport {
  base: string;
  mergeBase: string;
  changedFiles: string[];
  services: AffectedService[];
  deleted: string[];
}

function servicePaths(project: ProjectConfig, name: string): string[] | undefined {
  const file = join(project.servicesDir, name, 'service.yaml');
  if (!existsSync(file)) return undefined;
  const raw = (parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  try {
    return parsePaths(raw.paths, `${name} service.yaml`);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/** Services in <servicesDir> at a ref: directories holding a service.yaml. */
function servicesAt(change: ChangeSet, servicesDirName: string, ref: string): string[] {
  const dir = `${change.prefix}${servicesDirName}/`;
  const run = git(change.top, ['ls-tree', '-r', '--name-only', ref, '--', dir]);
  return run.out
    .split('\n')
    .filter((path) => path.startsWith(dir))
    .map((path) => path.slice(dir.length).split('/'))
    .filter((parts) => parts.length === 2 && parts[1] === 'service.yaml')
    .map((parts) => parts[0])
    .sort();
}

/** Which services `files` (top-level-relative) can break. Pure apart from reading each service's `paths:`. */
export function affectedServices(
  files: string[],
  services: string[],
  prefix: string,
  servicesDirName: string,
  pathsOf: (service: string) => string[] | undefined,
): AffectedService[] {
  const dir = `${prefix}${servicesDirName}/`;
  const ownerOf = (file: string): string | undefined => {
    if (!file.startsWith(dir)) return undefined;
    const rest = file.slice(dir.length);
    return rest.includes('/') ? rest.split('/')[0] : undefined;
  };
  const projectFile = `${prefix}${PROJECT_FILE}`;
  const shared = files.filter((file) => file === projectFile || (file.startsWith(dir) && !ownerOf(file)));
  const show = (list: string[]) => list.slice(0, 3).join(', ') + (list.length > 3 ? ` (+${list.length - 3})` : '');

  return services.flatMap((name) => {
    const reasons: string[] = [];
    const own = files.filter((file) => ownerOf(file) === name);
    if (own.length > 0) reasons.push(`its own files changed: ${show(own)}`);
    if (shared.length > 0) reasons.push(`project-wide files changed: ${show(shared)}`);
    // Outside every service directory: the code under test and everything else in the repository.
    const outside = files.filter((file) => !ownerOf(file) && !shared.includes(file));
    const globs = pathsOf(name);
    if (globs === undefined) {
      if (outside.length > 0) reasons.push(`no paths: in service.yaml, so any change counts: ${show(outside)}`);
    } else {
      for (const glob of globs) {
        const hits = outside.filter((file) => matchesGlob(file, glob));
        if (hits.length > 0) reasons.push(`${glob} matches ${show(hits)}`);
      }
    }
    return reasons.length > 0 ? [{ name, reasons }] : [];
  });
}

export function computeAffected(project: ProjectConfig, change: ChangeSet): AffectedReport {
  const head = listServices(project.root);
  const atBase = servicesAt(change, project.servicesDirName, change.mergeBase);
  return {
    base: change.base,
    mergeBase: change.mergeBase,
    changedFiles: change.files,
    services: affectedServices(change.files, head, change.prefix, project.servicesDirName, (name) =>
      servicePaths(project, name),
    ),
    deleted: atBase.filter((name) => !head.includes(name)),
  };
}

export function affected(project: ProjectConfig, base: string | undefined): Result {
  const change = changeSet(project, base);
  if ('result' in change) return change.result;
  const report = computeAffected(project, change);
  const names = report.services.map((s) => s.name);
  return {
    command: 'affected',
    ok: true,
    exitCode: EXIT.ok,
    summary:
      `${report.changedFiles.length} changed files vs ${report.base}: ` +
      (names.length > 0 ? `${names.length} affected (${names.join(', ')})` : 'no service affected') +
      (report.deleted.length > 0 ? `; deleted: ${report.deleted.join(', ')}` : ''),
    data: report,
    next: names.map((name) => `${CLI} gate --service ${name}`),
    text: [
      ...report.services.flatMap((s) => [s.name, ...s.reasons.map((r) => `  ${r}`)]),
      ...report.deleted.map((name) => `${name} (deleted)`),
    ],
  };
}

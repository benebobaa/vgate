/**
 * `skills`: the agent skills that teach an agent this framework's workflow. The binary carries them, so installing
 * them into a project needs no network and no checkout of this repository.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { CLI, EXIT, UsageError, type Result } from './output.ts';

/** skill name -> path inside the skill -> file content. */
export type Bundle = Record<string, Record<string, string>>;

/** Set by `cli/build.ts` when the binary is compiled: the bundle as JSON. Absent when run from source. */
declare const VGATE_SKILLS: string | undefined;

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name.startsWith('.')) return [];
    // evals/ grades the skill during its development; an agent using the skill has no use for it.
    if (entry.isDirectory()) return entry.name === 'evals' ? [] : walk(path, base);
    return [relative(base, path)];
  });
}

/** Reads every skill under `dir` (a `.claude/skills`-shaped directory). */
export function readSkills(dir: string): Bundle {
  if (!existsSync(dir)) return {};
  const bundle: Bundle = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const skillDir = join(dir, entry.name);
    if (!entry.isDirectory() || !existsSync(join(skillDir, 'SKILL.md'))) continue;
    bundle[entry.name] = Object.fromEntries(
      walk(skillDir)
        .sort()
        .map((file) => [file.split('\\').join('/'), readFileSync(join(skillDir, file), 'utf8')]),
    );
  }
  return bundle;
}

/** The skills this build carries: embedded in the binary, read from the source tree otherwise. */
export function bundledSkills(): Bundle {
  if (typeof VGATE_SKILLS !== 'undefined') return JSON.parse(VGATE_SKILLS) as Bundle;
  return readSkills(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'skills'));
}

export function describeSkill(skillMd: string): string {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skillMd)?.[1];
  if (!frontmatter) return '';
  const description = (parse(frontmatter) as { description?: unknown } | null)?.description;
  return typeof description === 'string' ? description.trim() : '';
}

export type SkillState = 'absent' | 'outdated' | 'current';

function stateOf(files: Record<string, string>, target: string): SkillState {
  if (!existsSync(target)) return 'absent';
  const same = Object.entries(files).every(
    ([file, content]) => existsSync(join(target, file)) && readFileSync(join(target, file), 'utf8') === content,
  );
  return same ? 'current' : 'outdated';
}

export interface SkillsOptions {
  action: string | undefined;
  /** Skills to act on; all of them when empty. */
  names: string[];
  /** Target skills directory; `<cwd>/.claude/skills` by default. */
  dir?: string;
  dryRun: boolean;
}

export function skills(options: SkillsOptions, bundle: Bundle = bundledSkills()): Result {
  const target = resolve(options.dir ?? join(process.cwd(), '.claude', 'skills'));
  const unknown = options.names.filter((name) => !(name in bundle));
  if (unknown.length > 0)
    throw new UsageError(`Unknown skill ${unknown.join(', ')}. Skills: ${Object.keys(bundle).join(', ')}`);
  const names = options.names.length > 0 ? options.names : Object.keys(bundle);

  if (options.action === 'list') {
    const rows = names.map((name) => ({
      skill: name,
      state: stateOf(bundle[name], join(target, name)),
      description: describeSkill(bundle[name]['SKILL.md'] ?? ''),
    }));
    const behind = rows.filter((row) => row.state !== 'current');
    return {
      command: 'skills list',
      ok: true,
      exitCode: EXIT.ok,
      summary: `${rows.length} skills, ${rows.length - behind.length} current in ${target}`,
      data: { target, skills: rows },
      next: behind.length > 0 ? [`${CLI} skills install`] : [],
      text: rows.map((row) => `${row.state.padEnd(8)}  ${row.skill}  ${row.description.slice(0, 90)}`),
    };
  }

  if (options.action === 'install') {
    const rows = names.map((name) => {
      const files = bundle[name];
      const before = stateOf(files, join(target, name));
      if (before !== 'current' && !options.dryRun) {
        for (const [file, content] of Object.entries(files)) {
          const path = join(target, name, file);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content);
        }
      }
      const result = before === 'absent' ? 'installed' : before === 'outdated' ? 'updated' : 'unchanged';
      return { skill: name, result, files: Object.keys(files).length, path: join(target, name) };
    });
    const changed = rows.filter((row) => row.result !== 'unchanged').length;
    return {
      command: 'skills install',
      ok: true,
      exitCode: EXIT.ok,
      summary: options.dryRun
        ? `Dry run: ${changed} of ${rows.length} skills would change in ${target}`
        : `${changed} of ${rows.length} skills written to ${target}`,
      data: { target, dryRun: options.dryRun, skills: rows },
      next: [],
      text: rows.map((row) => `${row.result.padEnd(9)}  ${row.skill}  (${row.files} files)`),
    };
  }

  throw new UsageError(`Usage: ${CLI} skills list|install [<skill>...] [--dir <skills dir>] [--dry-run]`);
}

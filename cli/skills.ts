/**
 * `skills`: the agent skills that teach an agent this framework's workflow. The binary carries them, so installing
 * them into a project needs no network and no checkout of this repository.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { projectSkills, resolveHarnesses } from '../packages/adapters/index.ts';
import {
  discoverServiceNames,
  filterBundleByPacks,
  generateVerifySkill,
  type PackName,
} from '../packages/playbooks/index.ts';
import { GUARDRAILS_FILE } from '../packages/guardrails/index.ts';
import { readProject } from '../framework/project.ts';
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
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return {
    ...readSkills(join(repoRoot, '.claude', 'skills')),
    ...readSkills(join(repoRoot, 'skills')),
  };
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
  /** Target vendor harnesses (`all` or comma-separated: `agy,claude,cursor,codex,opencode,pi,omp,grokbot`). */
  agents?: string;
  /** Filter canonical playbook skills by pack (`core,rigor,scale,full`). */
  packs?: string;
  /** Project root used to generate project-specific `vgate-verify` from `vgate.yaml` + `features/`. */
  root?: string;
  dryRun: boolean;
}

export function skills(options: SkillsOptions, bundle: Bundle = bundledSkills()): Result {
  const projectRoot = resolve(options.root ?? process.cwd());
  let effectiveBundle: Bundle = { ...bundle };
  if (options.packs) {
    const requestedPacks = options.packs
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean) as PackName[];
    effectiveBundle = filterBundleByPacks(effectiveBundle, requestedPacks);
  }
  // 1-source-of-truth: regenerate `vgate-verify` from vgate.yaml + features/ whenever a project exists.
  if ('vgate-verify' in effectiveBundle && existsSync(join(projectRoot, 'vgate.yaml'))) {
    const proj = readProject(projectRoot);
    const services = discoverServiceNames(proj.servicesDir);
    effectiveBundle['vgate-verify'] = {
      ...effectiveBundle['vgate-verify'],
      'SKILL.md': generateVerifySkill({
        projectRoot: proj.root,
        servicesDir: proj.servicesDir,
        services,
        guardrailsPresent: existsSync(join(proj.root, GUARDRAILS_FILE)),
      }),
    };
  }

  const target = resolve(options.dir ?? join(process.cwd(), '.claude', 'skills'));
  const unknown = options.names.filter((name) => !(name in effectiveBundle));
  if (unknown.length > 0)
    throw new UsageError(`Unknown skill ${unknown.join(', ')}. Skills: ${Object.keys(effectiveBundle).join(', ')}`);
  const names = options.names.length > 0 ? options.names : Object.keys(effectiveBundle);

  if (options.action === 'install' && options.agents) {
    const harnesses = resolveHarnesses(options.agents);
    const result = projectSkills({
      root: projectRoot,
      harnesses,
      bundle: effectiveBundle,
      names,
      dryRun: options.dryRun,
    });
    const changed = result.projected.filter((p) => p.result !== 'unchanged').length;
    return {
      command: 'skills install',
      ok: true,
      exitCode: EXIT.ok,
      summary: options.dryRun
        ? `Dry run: ${changed} of ${result.projected.length} skill projection(s) across ${harnesses.map((h) => h.id).join(', ')}`
        : `${changed} of ${result.projected.length} skill projection(s) written across ${harnesses.map((h) => h.id).join(', ')}`,
      data: { root: projectRoot, harnesses: harnesses.map((h) => h.id), dryRun: options.dryRun, ...result },
      next: [],
      text: [
        ...result.projected.map((p) => `${p.result.padEnd(9)}  ${p.targetDir}/${p.skill}  (${p.files} files)`),
        ...result.instructions.map((i) => `${i.result.padEnd(9)}  ${i.file}  (${i.harness})`),
      ],
    };
  }

  if (options.action === 'list') {
    const rows = names.map((name) => ({
      skill: name,
      state: stateOf(effectiveBundle[name], join(target, name)),
      description: describeSkill(effectiveBundle[name]['SKILL.md'] ?? ''),
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
      const files = effectiveBundle[name];
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

  throw new UsageError(
    `Usage: ${CLI} skills list|install [<skill>...] [--dir <skills dir>] [--agents all|claude,agy,...] [--packs core,rigor,scale|full] [--dry-run]`,
  );
}

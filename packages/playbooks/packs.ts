import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';

export const PACKS = ['core', 'rigor', 'scale', 'full'] as const;
export type PackName = (typeof PACKS)[number];
export type SkillPack = Exclude<PackName, 'full'>;

export interface SkillMeta {
  name: string;
  description: string;
  pack: SkillPack;
}

export type SkillBundle = Record<string, Record<string, string>>;

const SKILL_PACKS: readonly SkillPack[] = ['core', 'rigor', 'scale'];

function isSkillPack(value: unknown): value is SkillPack {
  return typeof value === 'string' && (SKILL_PACKS as readonly string[]).includes(value);
}

function isPackName(value: unknown): value is PackName {
  return typeof value === 'string' && (PACKS as readonly string[]).includes(value);
}

function walkSkillDir(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'evals') return [];
      return walkSkillDir(fullPath, base);
    }
    return [relative(base, fullPath).split('\\').join('/')];
  });
}

export function readCanonicalSkills(dir: string): SkillBundle {
  if (!existsSync(dir)) return {};
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const bundle: SkillBundle = {};
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillDir = join(dir, entry.name);
    if (!existsSync(join(skillDir, 'SKILL.md'))) continue;
    const files = walkSkillDir(skillDir).sort((a, b) => a.localeCompare(b));
    bundle[entry.name] = Object.fromEntries(files.map((file) => [file, readFileSync(join(skillDir, file), 'utf8')]));
  }
  return bundle;
}

export function parseSkillMeta(name: string, skillMd: string): SkillMeta {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillMd);
  if (!match) {
    throw new Error(`Skill "${name}" is missing YAML frontmatter.`);
  }
  const raw: unknown = parse(match[1]);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Skill "${name}" has invalid YAML frontmatter.`);
  }
  const record = raw as Record<string, unknown>;
  const parsedName = typeof record.name === 'string' ? record.name.trim() : '';
  if (!parsedName) {
    throw new Error(`Skill "${name}" is missing a valid frontmatter "name".`);
  }
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  if (!description) {
    throw new Error(`Skill "${name}" is missing a valid frontmatter "description".`);
  }
  if (!isSkillPack(record.pack)) {
    throw new Error(
      `Skill "${name}" has invalid frontmatter "pack": ${String(record.pack)}. Expected one of: ${SKILL_PACKS.join(', ')}.`,
    );
  }
  return { name: parsedName, description, pack: record.pack };
}

export function filterBundleByPacks(bundle: SkillBundle, packs: PackName[]): SkillBundle {
  for (const pack of packs) {
    if (!isPackName(pack)) {
      throw new Error(`Unknown pack "${String(pack)}". Expected one of: ${PACKS.join(', ')}.`);
    }
  }
  const includeAll = packs.includes('full');
  const selected = new Set<string>(packs);
  const filtered: SkillBundle = {};
  const names = Object.keys(bundle).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const files = bundle[name];
    const skillMd = files['SKILL.md'];
    if (typeof skillMd !== 'string') continue;
    const meta = parseSkillMeta(name, skillMd);
    if (includeAll || selected.has(meta.pack)) {
      filtered[name] = { ...files };
    }
  }
  return filtered;
}

export function listPackCatalog(bundle: SkillBundle): Record<SkillPack, SkillMeta[]> {
  const catalog: Record<SkillPack, SkillMeta[]> = {
    core: [],
    rigor: [],
    scale: [],
  };
  const names = Object.keys(bundle).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const skillMd = bundle[name]?.['SKILL.md'];
    if (typeof skillMd !== 'string') continue;
    const meta = parseSkillMeta(name, skillMd);
    catalog[meta.pack].push(meta);
  }
  for (const pack of SKILL_PACKS) {
    catalog[pack].sort((a, b) => a.name.localeCompare(b.name));
  }
  return catalog;
}

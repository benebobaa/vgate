/**
 * Skill and instruction projector across vendor harnesses.
 * Deduplicates shared skills directories (e.g. `.agents/skills`) and instruction files (e.g. `AGENTS.md`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { HarnessSpec } from './harnesses.ts';

/** skillName -> relative path inside skill -> file content. */
export type SkillBundle = Record<string, Record<string, string>>;

export interface ProjectSkillsOptions {
  root: string;
  harnesses: HarnessSpec[];
  bundle: SkillBundle;
  names?: string[];
  dryRun?: boolean;
  pointerSection?: string;
  pointerMarker?: string;
}

export interface ProjectedFile {
  harness: string;
  targetDir: string;
  skill: string;
  result: 'installed' | 'updated' | 'unchanged';
  files: number;
  path: string;
}

export interface ProjectedInstruction {
  harness: string;
  file: string;
  result: 'created' | 'appended' | 'unchanged';
}

export interface ProjectSkillsResult {
  projected: ProjectedFile[];
  instructions: ProjectedInstruction[];
}

export const DEFAULT_POINTER_MARKER = '<!-- vgate:instructions -->';

function buildDefaultPointerSection(skillNames: readonly string[]): string {
  const skillList = skillNames.length > 0 ? skillNames.map((name) => `- \`${name}\``).join('\n') : '- (none)';
  return [
    DEFAULT_POINTER_MARKER,
    '## vgate Verification Gate',
    '',
    'Run `vgate doctor`, `vgate lint`, `vgate gate`, and `vgate guard` before declaring changes complete.',
    'Installed vgate skills:',
    skillList,
    '',
  ].join('\n');
}

function buildCursorMdc(body: string): string {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('---\n') || trimmed.startsWith('---\r\n')) {
    return body.endsWith('\n') ? body : `${body}\n`;
  }
  const normalizedBody = body.endsWith('\n') ? body : `${body}\n`;
  return [
    '---',
    'description: vgate verification gate workflow and skills',
    'alwaysApply: true',
    '---',
    '',
    normalizedBody,
  ].join('\n');
}

function safeJoin(baseDir: string, relPath: string): string {
  const target = resolve(baseDir, relPath);
  const rel = relative(baseDir, target);
  if (rel.startsWith('..') || rel === '..' || target === baseDir) {
    throw new Error(`Unsafe skill file path "${relPath}" escapes target directory "${baseDir}"`);
  }
  return target;
}

function classifySkillState(
  files: Record<string, string>,
  skillTargetDir: string,
): 'installed' | 'updated' | 'unchanged' {
  if (!existsSync(skillTargetDir)) return 'installed';
  const allMatch = Object.entries(files).every(([relPath, content]) => {
    const filePath = safeJoin(skillTargetDir, relPath);
    return existsSync(filePath) && readFileSync(filePath, 'utf8') === content;
  });
  return allMatch ? 'unchanged' : 'updated';
}

export function projectSkills(options: ProjectSkillsOptions): ProjectSkillsResult {
  const root = resolve(options.root);
  const dryRun = options.dryRun ?? false;

  const available = Object.keys(options.bundle);
  const requested = options.names && options.names.length > 0 ? options.names : available;
  const unknown = requested.filter((name) => !Object.prototype.hasOwnProperty.call(options.bundle, name));
  if (unknown.length > 0) {
    throw new Error(`Unknown skill ${unknown.join(', ')}. Available skills: ${available.join(', ')}`);
  }

  const projected: ProjectedFile[] = [];
  const seenSkillDirs = new Set<string>();

  for (const harness of options.harnesses) {
    const absSkillsDir = resolve(root, harness.skillsDir);
    if (seenSkillDirs.has(absSkillsDir)) continue;
    seenSkillDirs.add(absSkillsDir);

    for (const skillName of requested) {
      const files = options.bundle[skillName];
      const skillPath = safeJoin(absSkillsDir, skillName);
      const result = classifySkillState(files, skillPath);

      if (result !== 'unchanged' && !dryRun) {
        for (const [relPath, content] of Object.entries(files)) {
          const dest = safeJoin(skillPath, relPath);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, content, 'utf8');
        }
      }

      projected.push({
        harness: harness.id,
        targetDir: harness.skillsDir,
        skill: skillName,
        result,
        files: Object.keys(files).length,
        path: skillPath,
      });
    }
  }

  const pointerSection = options.pointerSection ?? buildDefaultPointerSection(requested);
  const pointerMarker =
    options.pointerMarker ?? (options.pointerSection ? options.pointerSection.trim() : DEFAULT_POINTER_MARKER);

  const instructions: ProjectedInstruction[] = [];
  const seenInstructionFiles = new Set<string>();

  for (const harness of options.harnesses) {
    const absFile = resolve(root, harness.instructionsFile);
    if (seenInstructionFiles.has(absFile)) continue;
    seenInstructionFiles.add(absFile);

    const fileExists = existsSync(absFile);
    if (!fileExists) {
      const content =
        harness.format === 'cursor-mdc'
          ? buildCursorMdc(pointerSection)
          : pointerSection.endsWith('\n')
            ? pointerSection
            : `${pointerSection}\n`;
      if (!dryRun) {
        mkdirSync(dirname(absFile), { recursive: true });
        writeFileSync(absFile, content, 'utf8');
      }
      instructions.push({
        harness: harness.id,
        file: harness.instructionsFile,
        result: 'created',
      });
      continue;
    }

    const existing = readFileSync(absFile, 'utf8');
    if (pointerMarker.length > 0 && existing.includes(pointerMarker)) {
      instructions.push({
        harness: harness.id,
        file: harness.instructionsFile,
        result: 'unchanged',
      });
      continue;
    }

    const separator =
      existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    const addition = pointerSection.endsWith('\n') ? pointerSection : `${pointerSection}\n`;
    if (!dryRun) {
      writeFileSync(absFile, `${existing}${separator}${addition}`, 'utf8');
    }
    instructions.push({
      harness: harness.id,
      file: harness.instructionsFile,
      result: 'appended',
    });
  }

  return { projected, instructions };
}

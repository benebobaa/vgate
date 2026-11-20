import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

export const BANNED_EVAL_WORDS = [
  'eval',
  'test',
  'judge',
  'experiment',
  'rubric',
  'score',
  'compare',
  'benchmark',
  'candidate',
  'arena',
] as const;

export interface EvalVariant {
  id: string;
  label?: string;
  skillDir: string;
  harness: string;
  model?: string;
}

export interface EvalRubricItem {
  criterion: string;
  weight?: number;
  description: string;
}

export interface EvalSpec {
  id: string;
  taskPrompt: string;
  fixtureDir?: string;
  expectedOpenedFiles?: string[];
  rubric: EvalRubricItem[];
  variants: EvalVariant[];
  judge: { harness: string; model?: string };
}

export interface AgentExecutionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  openedFiles?: string[];
  durationMs: number;
}

export type AgentExecutor = (opts: {
  harness: string;
  model?: string;
  prompt: string;
  cwd: string;
}) => Promise<AgentExecutionResult>;

export interface AdherenceAudit {
  adhered: boolean;
  opened: string[];
  missing: string[];
}

export interface SanitizedRun {
  blindLabel: string;
  output: string;
  diff: string;
}

export interface JudgeOptionScore {
  scores: Record<string, number>;
  total: number;
  rationale: string;
}

export interface VariantEvalResult {
  id: string;
  label?: string;
  blindLabel: string;
  workspaceName: string;
  harness: string;
  model?: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  adherence: AdherenceAudit;
  scores: Record<string, number>;
  total: number;
  rationale: string;
}

export interface EvalReport {
  id: string;
  generatedAt: string;
  blindingLeaks: string[];
  rubric: EvalRubricItem[];
  judge: { harness: string; model?: string };
  blindMapping: Record<string, string>;
  variants: VariantEvalResult[];
  rankings: string[];
  winner: string | null;
  reportPaths: { json: string; markdown: string };
}

const WORKSPACE_ORGS = [
  'acme',
  'northstar',
  'harbor',
  'cobalt',
  'meadow',
  'ridge',
  'summit',
  'timber',
  'cedar',
  'aurora',
] as const;

const WORKSPACE_DOMAINS = [
  'checkout',
  'billing',
  'ledger',
  'catalog',
  'shipping',
  'profile',
  'inbox',
  'search',
  'webhook',
  'session',
] as const;

const WORKSPACE_ACTIONS = [
  'fix',
  'patch',
  'sync',
  'cleanup',
  'update',
  'refactor',
  'migration',
  'hotfix',
  'rollout',
  'triage',
] as const;

function findBannedWords(text: string): string[] {
  const found: string[] = [];
  for (const word of BANNED_EVAL_WORDS) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${word}(?:$|[^a-z0-9])`, 'i');
    if (pattern.test(text)) {
      found.push(word);
    }
  }
  return found;
}

export function checkBlindingLeaks(input: { workspaceName: string; prompt: string; fileNames: string[] }): string[] {
  const leaks: string[] = [];
  for (const word of findBannedWords(input.workspaceName)) {
    leaks.push(`workspaceName: "${word}"`);
  }
  for (const word of findBannedWords(input.prompt)) {
    leaks.push(`prompt: "${word}"`);
  }
  for (const fileName of input.fileNames) {
    for (const word of findBannedWords(fileName)) {
      leaks.push(`file "${fileName}": "${word}"`);
    }
  }
  return leaks;
}

export function organicWorkspaceName(seed?: string): string {
  const digest = seed !== undefined ? createHash('sha256').update(seed).digest() : randomBytes(16);
  const org = WORKSPACE_ORGS[digest[0] % WORKSPACE_ORGS.length];
  const domain = WORKSPACE_DOMAINS[digest[1] % WORKSPACE_DOMAINS.length];
  const action = WORKSPACE_ACTIONS[digest[2] % WORKSPACE_ACTIONS.length];
  const num = 1000 + (((digest[3] << 8) | digest[4]) % 9000);
  const name = `${org}-${domain}-${action}-${num}`;
  const leaks = checkBlindingLeaks({ workspaceName: name, prompt: '', fileNames: [] });
  if (leaks.length > 0) {
    throw new Error(`Generated organic workspace name leaked banned terms: ${leaks.join(', ')}`);
  }
  return name;
}

function normalizePath(pathValue: string): string {
  return pathValue
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/');
}

function extractTranscriptOpenedFiles(transcript: string): string[] {
  const found = new Set<string>();
  const lines = transcript.split(/\r?\n/);

  const jsonReadToolPattern = /\b(?:read_file|view_file|open_file|readFile|Read)\b/;
  const jsonPathPattern = /"(?:path|file_path|filePath|Path)"\s*:\s*"([^"]+)"/g;
  const callPattern =
    /\b(?:read_file|view_file|open_file|readFile|Read)\s*\(\s*(?:(?:path|file_path|filePath|Path)\s*[:=]\s*)?["']?([^\s"',)\]}]+)["']?/g;
  const tagPattern = /\[tool:(?:read_file|view_file|open_file|Read)\]\s+["']?([^\s"']+)["']?/g;
  const markerPattern = /^\s*(?:TOOL_READ|OPENED_FILE|READ_FILE)\s*[:=]\s*["']?([^\s"']+)["']?/i;
  const shellReadPattern = /^\s*(?:\$\s*)?(?:cat|head|tail|bat|less)\s+(?:-[a-zA-Z0-9]+\s+)*["']?([^\s"'|;&>]+)["']?/;

  for (const line of lines) {
    if (jsonReadToolPattern.test(line)) {
      for (const match of line.matchAll(jsonPathPattern)) {
        if (match[1]) found.add(normalizePath(match[1]));
      }
    }
    for (const match of line.matchAll(callPattern)) {
      if (match[1]) found.add(normalizePath(match[1]));
    }
    for (const match of line.matchAll(tagPattern)) {
      if (match[1]) found.add(normalizePath(match[1]));
    }
    const markerMatch = markerPattern.exec(line);
    if (markerMatch?.[1]) {
      found.add(normalizePath(markerMatch[1]));
    }
    const shellMatch = shellReadPattern.exec(line);
    if (shellMatch?.[1] && !shellMatch[1].startsWith('-')) {
      found.add(normalizePath(shellMatch[1]));
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}

function pathMatchesExpected(observed: string, expected: string): boolean {
  if (observed === expected) return true;
  return observed.endsWith(`/${expected}`);
}

export function auditTranscriptAdherence(
  transcript: string,
  expectedFiles: string[],
  openedFiles?: string[],
): AdherenceAudit {
  const verifiedSet = new Set<string>();
  for (const file of openedFiles ?? []) {
    const normalized = normalizePath(file);
    if (normalized) verifiedSet.add(normalized);
  }
  for (const file of extractTranscriptOpenedFiles(transcript)) {
    if (file) verifiedSet.add(file);
  }
  const verifiedList = [...verifiedSet].sort((a, b) => a.localeCompare(b));

  if (expectedFiles.length === 0) {
    return { adhered: true, opened: verifiedList, missing: [] };
  }

  const opened: string[] = [];
  const missing: string[] = [];
  const seenExpected = new Set<string>();

  for (const rawExpected of expectedFiles) {
    const expected = normalizePath(rawExpected);
    if (!expected || seenExpected.has(expected)) continue;
    seenExpected.add(expected);
    const matched = verifiedList.some((obs) => pathMatchesExpected(obs, expected));
    if (matched) {
      opened.push(expected);
    } else {
      missing.push(expected);
    }
  }

  return {
    adhered: missing.length === 0,
    opened,
    missing,
  };
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeTextForJudge(text: string, redactTokens: string[]): string {
  let sanitized = text;
  const uniqueTokens = [...new Set(redactTokens.filter((token) => token.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  for (const token of uniqueTokens) {
    const pattern = new RegExp(escapeRegExp(token), 'g');
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

export function buildBlindedJudgePrompt(spec: EvalSpec, sanitizedRuns: SanitizedRun[]): string {
  const redactTokens: string[] = [];
  for (const variant of spec.variants) {
    redactTokens.push(variant.id, variant.skillDir);
    if (variant.label) redactTokens.push(variant.label);
  }

  const rubricLines = spec.rubric.map((item, idx) => {
    const weight = item.weight !== undefined ? ` (weight: ${item.weight})` : '';
    return `${idx + 1}. **${item.criterion}**${weight}: ${item.description}`;
  });

  const optionBlocks = sanitizedRuns.map((run) => {
    const output = sanitizeTextForJudge(run.output, redactTokens);
    const diff = sanitizeTextForJudge(run.diff, redactTokens);
    return [
      `## ${run.blindLabel}`,
      '### Output',
      '```',
      output || '(empty)',
      '```',
      '### Diff',
      '```diff',
      diff || '(no file changes)',
      '```',
    ].join('\n');
  });

  const schemaExample: Record<string, JudgeOptionScore> = {};
  for (const run of sanitizedRuns) {
    const exampleScores: Record<string, number> = {};
    for (const item of spec.rubric) {
      exampleScores[item.criterion] = 0;
    }
    schemaExample[run.blindLabel] = {
      scores: exampleScores,
      total: 0,
      rationale: 'Concise justification citing observed output and diff.',
    };
  }

  return [
    'You are a blinded impartial reviewer.',
    'Evaluate each option strictly against the task and rubric below. Do not guess or infer which option came from which system.',
    '',
    '# Task',
    spec.taskPrompt,
    '',
    '# Rubric (score each criterion from 0 to 10)',
    ...rubricLines,
    '',
    '# Options',
    ...optionBlocks,
    '',
    '# Required Output Format',
    'Return ONLY a single valid JSON object matching this exact structure (keyed by the exact option labels):',
    '```json',
    JSON.stringify(schemaExample, null, 2),
    '```',
  ].join('\n');
}

function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/i.exec(text);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text.trim());
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to parse judge JSON response: ${detail}`);
}

export function parseJudgeResponse(text: string, blindLabels: string[]): Record<string, JudgeOptionScore> {
  const parsed = extractJsonObject(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Judge response must be a JSON object keyed by blind option labels.');
  }
  const record = parsed as Record<string, unknown>;
  const result: Record<string, JudgeOptionScore> = {};

  for (const label of blindLabels) {
    const entry = record[label];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Judge response is missing score object for "${label}".`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.scores !== 'object' || obj.scores === null || Array.isArray(obj.scores)) {
      throw new Error(`Judge response for "${label}" is missing a valid "scores" object.`);
    }
    const scores: Record<string, number> = {};
    for (const [criterion, value] of Object.entries(obj.scores as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Judge score for "${label}" -> "${criterion}" must be a finite number.`);
      }
      scores[criterion] = value;
    }
    const computedSum = Object.values(scores).reduce((sum, val) => sum + val, 0);
    const total = obj.total === undefined ? computedSum : obj.total;
    if (typeof total !== 'number' || !Number.isFinite(total)) {
      throw new Error(`Judge "total" for "${label}" must be a finite number.`);
    }
    if (typeof obj.rationale !== 'string') {
      throw new Error(`Judge response for "${label}" is missing a string "rationale".`);
    }
    result[label] = {
      scores,
      total,
      rationale: obj.rationale.trim(),
    };
  }

  return result;
}

function listFilesRecursive(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(full, base));
    } else if (entry.isFile()) {
      files.push(relative(base, full).split('\\').join('/'));
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function snapshotWorkspace(dir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const relPath of listFilesRecursive(dir)) {
    const fullPath = join(dir, relPath);
    const stat = statSync(fullPath);
    if (stat.size > 512 * 1024) {
      snapshot.set(relPath, `<binary-or-large:${stat.size}B>`);
      continue;
    }
    snapshot.set(relPath, readFileSync(fullPath, 'utf8'));
  }
  return snapshot;
}

function computeWorkspaceDiff(before: Map<string, string>, after: Map<string, string>): string {
  const allPaths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b));
  const chunks: string[] = [];

  for (const relPath of allPaths) {
    const prev = before.get(relPath);
    const next = after.get(relPath);
    if (prev === next) continue;
    if (prev === undefined && next !== undefined) {
      const added = next
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n');
      chunks.push(`--- /dev/null\n+++ b/${relPath}\n${added}`);
    } else if (prev !== undefined && next === undefined) {
      const removed = prev
        .split('\n')
        .map((line) => `-${line}`)
        .join('\n');
      chunks.push(`--- a/${relPath}\n+++ /dev/null\n${removed}`);
    } else if (prev !== undefined && next !== undefined) {
      const removed = prev
        .split('\n')
        .map((line) => `-${line}`)
        .join('\n');
      const added = next
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n');
      chunks.push(`--- a/${relPath}\n+++ b/${relPath}\n${removed}\n${added}`);
    }
  }

  return chunks.join('\n\n');
}

function blindOptionLabel(index: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (index < alphabet.length) {
    return `Option ${alphabet[index]}`;
  }
  return `Option ${index + 1}`;
}

function shuffledIndices(length: number): number[] {
  const indices = Array.from({ length }, (_, idx) => idx);
  const bytes = randomBytes(Math.max(length, 1));
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = bytes[i] % (i + 1);
    const tmp = indices[i];
    indices[i] = indices[j];
    indices[j] = tmp;
  }
  return indices;
}

function renderMarkdownReport(report: EvalReport): string {
  const lines: string[] = [
    `# Blinded Skill Report: ${report.id}`,
    '',
    `- Generated: ${report.generatedAt}`,
    `- Judge: \`${report.judge.harness}\`${report.judge.model ? ` (\`${report.judge.model}\`)` : ''}`,
    `- Winner: ${report.winner ? `**${report.winner}**` : 'Tie / None'}`,
    `- Blinding leaks: ${report.blindingLeaks.length}`,
    '',
    '## Rubric',
    '',
    '| Criterion | Weight | Description |',
    '| --- | --- | --- |',
    ...report.rubric.map((item) => `| ${item.criterion} | ${item.weight ?? 1} | ${item.description} |`),
    '',
    '## Results',
    '',
    '| Rank | Variant | Blind Label | Total | Adhered | Duration (ms) |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  const byId = new Map(report.variants.map((v) => [v.id, v]));
  report.rankings.forEach((id, idx) => {
    const v = byId.get(id);
    if (!v) return;
    lines.push(
      `| ${idx + 1} | ${v.id} | ${v.blindLabel} | ${v.total} | ${v.adherence.adhered ? 'yes' : 'no'} | ${v.durationMs} |`,
    );
  });

  lines.push('', '## Variant Details', '');
  for (const v of report.variants) {
    lines.push(`### ${v.id} (${v.blindLabel})`);
    lines.push(`- Workspace: \`${v.workspaceName}\``);
    lines.push(`- Harness: \`${v.harness}\`${v.model ? ` (\`${v.model}\`)` : ''}`);
    lines.push(`- Total: ${v.total}`);
    lines.push(
      `- Adherence: ${v.adherence.adhered ? 'pass' : 'fail'} (opened: ${v.adherence.opened.join(', ') || 'none'}; missing: ${v.adherence.missing.join(', ') || 'none'})`,
    );
    lines.push(`- Scores: ${JSON.stringify(v.scores)}`);
    lines.push(`- Rationale: ${v.rationale}`);
    lines.push('');
  }

  return lines.join('\n');
}

export async function runBlindedEval(
  spec: EvalSpec,
  executor: AgentExecutor,
  options?: { workRoot?: string; reportsDir?: string; enforceBlinding?: boolean },
): Promise<EvalReport> {
  if (spec.rubric.length < 3 || spec.rubric.length > 6) {
    throw new Error(`Rubric must have between 3 and 6 criteria; received ${spec.rubric.length}.`);
  }
  if (spec.variants.length === 0) {
    throw new Error('At least one variant is required.');
  }
  const seenIds = new Set<string>();
  for (const variant of spec.variants) {
    if (!variant.id.trim()) throw new Error('Variant id must be a non-empty string.');
    if (seenIds.has(variant.id)) throw new Error(`Duplicate variant id "${variant.id}".`);
    seenIds.add(variant.id);
  }

  const enforceBlinding = options?.enforceBlinding ?? true;
  const workRoot = options?.workRoot ? resolve(options.workRoot) : mkdtempSync(join(tmpdir(), 'vgate-work-'));
  mkdirSync(workRoot, { recursive: true });

  const fixtureFiles = spec.fixtureDir && existsSync(spec.fixtureDir) ? listFilesRecursive(spec.fixtureDir) : [];

  const prepared = spec.variants.map((variant, idx) => {
    const workspaceName = organicWorkspaceName(`${spec.id}:${variant.id}:${idx}`);
    const workspacePath = join(workRoot, workspaceName);
    const skillFiles: string[] = [];
    let stagedSkillTarget: string | undefined;

    if (variant.skillDir && existsSync(variant.skillDir)) {
      const rawSkillBase = basename(variant.skillDir);
      const safeSkillBase =
        checkBlindingLeaks({ workspaceName: rawSkillBase, prompt: '', fileNames: [] }).length === 0
          ? rawSkillBase
          : 'playbook';
      stagedSkillTarget = join('skills', safeSkillBase);
      for (const rel of listFilesRecursive(variant.skillDir)) {
        skillFiles.push(`${stagedSkillTarget}/${rel}`);
      }
    }

    const allFiles = [...fixtureFiles, ...skillFiles];
    const leaks = checkBlindingLeaks({
      workspaceName,
      prompt: spec.taskPrompt,
      fileNames: allFiles,
    });

    return {
      variant,
      workspaceName,
      workspacePath,
      stagedSkillTarget,
      leaks,
    };
  });

  const allLeaks = [...new Set(prepared.flatMap((item) => item.leaks))];
  if (enforceBlinding && allLeaks.length > 0) {
    throw new Error(`Blinding leak(s) detected: ${allLeaks.join('; ')}`);
  }

  interface ExecutedVariant {
    variant: EvalVariant;
    workspaceName: string;
    workspacePath: string;
    execution: AgentExecutionResult;
    diff: string;
    adherence: AdherenceAudit;
  }

  const executed: ExecutedVariant[] = [];

  for (const item of prepared) {
    mkdirSync(item.workspacePath, { recursive: true });
    if (spec.fixtureDir && existsSync(spec.fixtureDir)) {
      cpSync(spec.fixtureDir, item.workspacePath, { recursive: true });
    }
    if (item.stagedSkillTarget && existsSync(item.variant.skillDir)) {
      const dest = join(item.workspacePath, item.stagedSkillTarget);
      mkdirSync(dest, { recursive: true });
      cpSync(item.variant.skillDir, dest, { recursive: true });
    }

    const beforeSnapshot = snapshotWorkspace(item.workspacePath);
    const execution = await executor({
      harness: item.variant.harness,
      model: item.variant.model,
      prompt: spec.taskPrompt,
      cwd: item.workspacePath,
    });
    const afterSnapshot = snapshotWorkspace(item.workspacePath);
    const diff = computeWorkspaceDiff(beforeSnapshot, afterSnapshot);
    const combinedTranscript = `${execution.stdout}\n${execution.stderr}`;
    const adherence = auditTranscriptAdherence(
      combinedTranscript,
      spec.expectedOpenedFiles ?? [],
      execution.openedFiles,
    );

    executed.push({
      variant: item.variant,
      workspaceName: item.workspaceName,
      workspacePath: item.workspacePath,
      execution,
      diff,
      adherence,
    });
  }

  const order = shuffledIndices(executed.length);
  const blindMapping: Record<string, string> = {};
  const variantBlindLabel = new Map<string, string>();
  const sanitizedRuns: SanitizedRun[] = [];

  order.forEach((executedIdx, blindPos) => {
    const run = executed[executedIdx];
    const blindLabel = blindOptionLabel(blindPos);
    blindMapping[blindLabel] = run.variant.id;
    variantBlindLabel.set(run.variant.id, blindLabel);

    const extraRedact = [
      run.variant.id,
      run.variant.skillDir,
      run.workspacePath,
      run.workspaceName,
      ...(run.variant.label ? [run.variant.label] : []),
    ];
    sanitizedRuns.push({
      blindLabel,
      output: sanitizeTextForJudge(run.execution.stdout, extraRedact),
      diff: sanitizeTextForJudge(run.diff, extraRedact),
    });
  });

  const judgePrompt = buildBlindedJudgePrompt(spec, sanitizedRuns);
  const judgeCwd = join(workRoot, organicWorkspaceName(`${spec.id}:review`));
  mkdirSync(judgeCwd, { recursive: true });
  const judgeExecution = await executor({
    harness: spec.judge.harness,
    model: spec.judge.model,
    prompt: judgePrompt,
    cwd: judgeCwd,
  });

  const blindLabels = sanitizedRuns.map((run) => run.blindLabel);
  const parsedJudgeScores = parseJudgeResponse(judgeExecution.stdout, blindLabels);

  const variantResults: VariantEvalResult[] = executed.map((run) => {
    const blindLabel = variantBlindLabel.get(run.variant.id) ?? '';
    const judged = parsedJudgeScores[blindLabel];
    return {
      id: run.variant.id,
      ...(run.variant.label !== undefined ? { label: run.variant.label } : {}),
      blindLabel,
      workspaceName: run.workspaceName,
      harness: run.variant.harness,
      ...(run.variant.model !== undefined ? { model: run.variant.model } : {}),
      ok: run.execution.ok,
      exitCode: run.execution.exitCode,
      durationMs: run.execution.durationMs,
      adherence: run.adherence,
      scores: judged.scores,
      total: judged.total,
      rationale: judged.rationale,
    };
  });

  const sortedByScore = [...variantResults].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  const rankings = sortedByScore.map((item) => item.id);
  const winner =
    sortedByScore.length === 1
      ? sortedByScore[0].id
      : sortedByScore.length > 1 && sortedByScore[0].total > sortedByScore[1].total
        ? sortedByScore[0].id
        : null;

  const reportsDir = resolve(options?.reportsDir ?? 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const safeId = spec.id.replace(/[^a-zA-Z0-9._-]/g, '-');
  const jsonPath = join(reportsDir, `eval-${safeId}.json`);
  const mdPath = join(reportsDir, `eval-${safeId}.md`);

  const report: EvalReport = {
    id: spec.id,
    generatedAt: new Date().toISOString(),
    blindingLeaks: allLeaks,
    rubric: spec.rubric,
    judge: spec.judge,
    blindMapping,
    variants: variantResults,
    rankings,
    winner,
    reportPaths: { json: jsonPath, markdown: mdPath },
  };

  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, `${renderMarkdownReport(report)}\n`, 'utf8');

  return report;
}

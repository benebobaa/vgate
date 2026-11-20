import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { matchesGlob } from '../../cli/glob.ts';
import { DEFAULT_RULE_TABLE_FILE, loadGuardrails, type BannedPatternRule, type GuardrailsConfig } from './config.ts';
import { analyzeComments, extractImports, stripComments, type ExtractedImport } from './scanner.ts';

export interface GuardrailViolation {
  ruleId: string;
  kind: 'boundary' | 'banned-pattern' | 'comment-density' | 'native-linter' | 'rule-table';
  file: string;
  line?: number;
  message: string;
  replaceWith?: string;
  severity: 'error' | 'warn';
  ratcheted?: boolean;
}

export interface RatchetBaseline {
  schema: 'vgate.ratchet/1';
  updatedAt: string;
  counts: Record<string, Record<string, number>>;
}

export interface RatchetTightening {
  ruleId: string;
  file: string;
  baseline: number;
  actual: number;
}

export interface NativeLinterResult {
  id: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export interface RuleTableResult {
  checked: boolean;
  file?: string;
  unenforced: Array<{ rule: string; line: number }>;
}

export interface LintReport {
  schema: 'vgate.lint/1';
  ok: boolean;
  filesScanned: number;
  violations: GuardrailViolation[];
  baselined: number;
  tightenings: RatchetTightening[];
  nativeLinters: NativeLinterResult[];
  ruleTable: RuleTableResult;
}

export interface RunGuardrailsOptions {
  config?: GuardrailsConfig;
  ratchetPath?: string;
  files?: string[];
  updateRatchet?: boolean;
  skipNativeLinters?: boolean;
}

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.pyc',
  '.class',
  '.jar',
]);

function isIgnored(relPath: string, ignoreGlobs: string[]): boolean {
  return ignoreGlobs.some((glob) => matchesGlob(relPath, glob));
}

function isIgnoredDir(relDir: string, ignoreGlobs: string[]): boolean {
  return ignoreGlobs.some(
    (glob) => matchesGlob(relDir, glob) || matchesGlob(`${relDir}/`, glob) || matchesGlob(`${relDir}/_`, glob),
  );
}

function hasBinaryExtension(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot !== -1 && BINARY_EXTENSIONS.has(lower.slice(dot));
}

function isBinaryBuffer(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function walkFiles(root: string, ignoreGlobs: string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!isIgnoredDir(rel, ignoreGlobs)) visit(abs);
      } else if (entry.isFile()) {
        if (!isIgnored(rel, ignoreGlobs) && !hasBinaryExtension(rel)) {
          out.push(rel);
        }
      }
    }
  };
  visit(root);
  out.sort();
  return out;
}

function matchesAny(file: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return true;
  return globs.some((g) => matchesGlob(file, g));
}

function isExcluded(file: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  return globs.some((g) => matchesGlob(file, g));
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

const COMMENT_DIRECTIVE_PATTERN_RE =
  /(\/\/|\\\/\\\/|\/\*|\\\/\\\*|@ts-(?:ignore|expect-error|nocheck)|eslint-disable|nolint|noqa|type:\s*ignore)/i;

function patternTargetsComments(pattern: string): boolean {
  return COMMENT_DIRECTIVE_PATTERN_RE.test(pattern);
}

function compilePattern(rule: BannedPatternRule): RegExp {
  const baseFlags = rule.flags ?? '';
  const flags = baseFlags.includes('g') ? baseFlags : `${baseFlags}g`;
  return new RegExp(rule.pattern, flags);
}

export function readRatchetBaseline(filePath: string): RatchetBaseline | undefined {
  if (!existsSync(filePath)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${filePath}: ratchet baseline must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== 'vgate.ratchet/1') {
    throw new Error(`${filePath}: unsupported ratchet schema "${String(obj.schema)}"`);
  }
  if (typeof obj.counts !== 'object' || obj.counts === null || Array.isArray(obj.counts)) {
    throw new Error(`${filePath}: ratchet baseline must have a counts map`);
  }
  const counts: Record<string, Record<string, number>> = {};
  for (const [ruleId, fileMap] of Object.entries(obj.counts as Record<string, unknown>)) {
    if (typeof fileMap !== 'object' || fileMap === null || Array.isArray(fileMap)) continue;
    counts[ruleId] = {};
    for (const [file, count] of Object.entries(fileMap as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
        counts[ruleId][file] = count;
      }
    }
  }
  return {
    schema: 'vgate.ratchet/1',
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : '',
    counts,
  };
}

export function writeRatchetBaseline(filePath: string, baseline: RatchetBaseline): void {
  const sortedCounts: Record<string, Record<string, number>> = {};
  for (const ruleId of Object.keys(baseline.counts).sort()) {
    const fileMap = baseline.counts[ruleId];
    const sortedFiles: Record<string, number> = {};
    for (const file of Object.keys(fileMap).sort()) {
      if (fileMap[file] > 0) sortedFiles[file] = fileMap[file];
    }
    if (Object.keys(sortedFiles).length > 0) {
      sortedCounts[ruleId] = sortedFiles;
    }
  }
  const payload: RatchetBaseline = {
    schema: 'vgate.ratchet/1',
    updatedAt: baseline.updatedAt,
    counts: sortedCounts,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

const RULE_TABLE_HEADING_RE = /^(#{1,6})\s+(?:Rule Table|Guardrail Rules)\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+/;
const TABLE_SEPARATOR_CELL_RE = /^:?-{3,}:?$/;
const UNENFORCED_VALUES = new Set([
  '',
  '-',
  '--',
  '—',
  '–',
  'n/a',
  'none',
  'null',
  'tbd',
  'todo',
  'manual',
  'human',
  'prose',
  'unenforced',
  'missing',
  '?',
]);

function splitMarkdownRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return undefined;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length >= 2 && cells.every((cell) => TABLE_SEPARATOR_CELL_RE.test(cell));
}

function normalizeEnforcerCell(raw: string): string {
  return raw.replace(/`/g, '').replace(/\*\*/g, '').replace(/__/g, '').trim().toLowerCase();
}

function isConcreteEnforcer(raw: string): boolean {
  const normalized = normalizeEnforcerCell(raw);
  if (normalized === 'judgment' || normalized.startsWith('judgment:') || normalized.startsWith('judgment ')) {
    return true;
  }
  return !UNENFORCED_VALUES.has(normalized);
}

export function checkRuleTable(
  root: string,
  config: GuardrailsConfig,
): {
  result: RuleTableResult;
  violations: GuardrailViolation[];
} {
  const tableFile = config.ruleTable?.file ?? DEFAULT_RULE_TABLE_FILE;
  const requireEnforcer = config.ruleTable?.requireEnforcer ?? true;
  if (!requireEnforcer) {
    return { result: { checked: false, file: tableFile, unenforced: [] }, violations: [] };
  }

  const absPath = join(root, tableFile);
  if (!existsSync(absPath)) {
    return { result: { checked: false, file: tableFile, unenforced: [] }, violations: [] };
  }

  const lines = readFileSync(absPath, 'utf8').split(/\r?\n/);
  const unenforced: Array<{ rule: string; line: number }> = [];
  const violations: GuardrailViolation[] = [];

  let inSection = false;
  let sectionLevel = 0;
  let checked = false;
  let i = 0;

  while (i < lines.length) {
    const lineText = lines[i];
    const sectionMatch = RULE_TABLE_HEADING_RE.exec(lineText.trim());
    if (sectionMatch) {
      inSection = true;
      sectionLevel = sectionMatch[1].length;
      i++;
      continue;
    }

    if (inSection) {
      const headingMatch = ANY_HEADING_RE.exec(lineText.trim());
      if (headingMatch && headingMatch[1].length <= sectionLevel) {
        inSection = false;
        continue;
      }

      const headerCells = splitMarkdownRow(lineText);
      const nextCells = i + 1 < lines.length ? splitMarkdownRow(lines[i + 1]) : undefined;
      if (headerCells && nextCells && isSeparatorRow(nextCells)) {
        checked = true;
        const ruleColIdx = Math.max(
          0,
          headerCells.findIndex((h) => /rule|invariant|constraint|policy/i.test(h)),
        );
        let enforcerColIdx = headerCells.findIndex((h) => /enforcer|enforced|check|tool|gate|mechanism/i.test(h));
        if (enforcerColIdx === -1) enforcerColIdx = headerCells.length > 1 ? 1 : 0;

        i += 2;
        while (i < lines.length) {
          const rowCells = splitMarkdownRow(lines[i]);
          if (!rowCells || rowCells.length === 0) break;
          if (isSeparatorRow(rowCells)) {
            i++;
            continue;
          }
          const ruleText = (rowCells[ruleColIdx] ?? '').replace(/`/g, '').trim();
          const enforcerRaw = (rowCells[enforcerColIdx] ?? '').trim();
          if (ruleText.length > 0 && !isConcreteEnforcer(enforcerRaw)) {
            const lineNum = i + 1;
            unenforced.push({ rule: ruleText, line: lineNum });
            violations.push({
              ruleId: 'rule-table:unenforced',
              kind: 'rule-table',
              file: tableFile,
              line: lineNum,
              message: `Rule "${ruleText}" in ${tableFile} has no concrete enforcer (found "${enforcerRaw || 'empty'}")`,
              replaceWith:
                'Assign an automated enforcer (e.g. guardrails.yaml rule, linter, or test) or mark as judgment',
              severity: 'error',
            });
          }
          i++;
        }
        continue;
      }
    }
    i++;
  }

  return {
    result: { checked, file: tableFile, unenforced },
    violations,
  };
}

interface RatchetEntry {
  count: number;
  violations: GuardrailViolation[];
}

export function runGuardrails(root: string, options?: RunGuardrailsOptions): LintReport {
  const config = options?.config ?? loadGuardrails(root);
  if (!config) {
    return {
      schema: 'vgate.lint/1',
      ok: true,
      filesScanned: 0,
      violations: [],
      baselined: 0,
      tightenings: [],
      nativeLinters: [],
      ruleTable: { checked: false, unenforced: [] },
    };
  }

  const candidateFiles = options?.files
    ? options.files
        .map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''))
        .filter((rel) => {
          if (isIgnored(rel, config.ignore) || hasBinaryExtension(rel)) return false;
          const abs = join(root, rel);
          return existsSync(abs) && statSync(abs).isFile();
        })
        .sort()
    : walkFiles(root, config.ignore);

  const scannedFileSet = new Set<string>();
  const compiledPatterns = config.bannedPatterns.map((rule) => ({
    rule,
    regex: compilePattern(rule),
    scanRaw: patternTargetsComments(rule.pattern),
  }));

  const violations: GuardrailViolation[] = [];
  // ruleId -> file -> RatchetEntry
  const ratchetedResults = new Map<string, Map<string, RatchetEntry>>();
  const ratchetedRuleIds = new Set<string>();
  for (const rule of config.bannedPatterns) {
    if (rule.ratcheted) ratchetedRuleIds.add(rule.id);
  }
  if (config.comments?.ratcheted) {
    if (config.comments.maxRatio !== undefined) ratchetedRuleIds.add('comments:max-ratio');
    if (config.comments.maxInlinePerFile !== undefined) ratchetedRuleIds.add('comments:max-inline');
  }

  const recordRatcheted = (ruleId: string, file: string, count: number, ruleViolations: GuardrailViolation[]) => {
    let byFile = ratchetedResults.get(ruleId);
    if (!byFile) {
      byFile = new Map<string, RatchetEntry>();
      ratchetedResults.set(ruleId, byFile);
    }
    byFile.set(file, { count, violations: ruleViolations });
  };

  for (const file of candidateFiles) {
    const abs = join(root, file);
    const buf = readFileSync(abs);
    if (isBinaryBuffer(buf)) continue;

    scannedFileSet.add(file);
    const source = buf.toString('utf8');
    let cachedImports: ExtractedImport[] | undefined;
    let cachedStripped: string | undefined;

    // 1. Import boundaries
    for (const boundary of config.boundaries) {
      if (!matchesAny(file, boundary.from)) continue;
      if (cachedImports === undefined) {
        cachedImports = extractImports(source, file);
      }
      for (const imp of cachedImports) {
        const hit = boundary.disallowImports.some(
          (glob) =>
            matchesGlob(imp.specifier, glob) || (imp.resolvedHint !== undefined && matchesGlob(imp.resolvedHint, glob)),
        );
        if (hit) {
          const hint =
            imp.resolvedHint && imp.resolvedHint !== imp.specifier ? ` (resolves to ${imp.resolvedHint})` : '';
          violations.push({
            ruleId: boundary.id,
            kind: 'boundary',
            file,
            line: imp.line,
            message: `Disallowed import "${imp.specifier}"${hint}${boundary.reason ? `: ${boundary.reason}` : ''}`,
            replaceWith: boundary.replaceWith,
            severity: 'error',
          });
        }
      }
    }

    // 2. Banned patterns
    for (const { rule, regex, scanRaw } of compiledPatterns) {
      if (!matchesAny(file, rule.files) || isExcluded(file, rule.exclude)) continue;
      const haystack = scanRaw ? source : (cachedStripped ??= stripComments(source, file));
      regex.lastIndex = 0;
      const matched: GuardrailViolation[] = [];
      let match: RegExpExecArray | null;
      while ((match = regex.exec(haystack)) !== null) {
        const snippet = match[0].length > 60 ? `${match[0].slice(0, 57)}...` : match[0];
        matched.push({
          ruleId: rule.id,
          kind: 'banned-pattern',
          file,
          line: lineNumberAt(haystack, match.index),
          message: `Banned pattern "${rule.id}" matched "${snippet}"${rule.reason ? `: ${rule.reason}` : ''}`,
          replaceWith: rule.replaceWith,
          severity: rule.severity ?? 'error',
          ...(rule.ratcheted ? { ratcheted: true } : {}),
        });
        if (match[0].length === 0) {
          regex.lastIndex++;
        }
      }
      if (matched.length > 0) {
        if (rule.ratcheted) {
          recordRatcheted(rule.id, file, matched.length, matched);
        } else {
          violations.push(...matched);
        }
      }
    }

    // 3. Comment density
    const commentsCfg = config.comments;
    if (
      commentsCfg &&
      (commentsCfg.maxRatio !== undefined || commentsCfg.maxInlinePerFile !== undefined) &&
      matchesAny(file, commentsCfg.files) &&
      !isExcluded(file, commentsCfg.exclude)
    ) {
      const analysis = analyzeComments(source, file, {
        ignoreLicenseHeaders: commentsCfg.ignoreLicenseHeaders,
        ignoreDocComments: commentsCfg.ignoreDocComments,
      });

      if (commentsCfg.maxRatio !== undefined && analysis.commentLines > 0 && analysis.ratio > commentsCfg.maxRatio) {
        const pct = (analysis.ratio * 100).toFixed(1);
        const maxPct = (commentsCfg.maxRatio * 100).toFixed(1);
        const violation: GuardrailViolation = {
          ruleId: 'comments:max-ratio',
          kind: 'comment-density',
          file,
          message: `Comment ratio ${pct}% (${analysis.commentLines} comment / ${analysis.codeLines} code lines) exceeds maxRatio ${maxPct}%`,
          replaceWith: 'Remove redundant narration comments or extract self-documenting names',
          severity: 'error',
          ...(commentsCfg.ratcheted ? { ratcheted: true } : {}),
        };
        if (commentsCfg.ratcheted) {
          recordRatcheted('comments:max-ratio', file, analysis.commentLines, [violation]);
        } else {
          violations.push(violation);
        }
      }

      if (commentsCfg.maxInlinePerFile !== undefined && analysis.inlineComments > commentsCfg.maxInlinePerFile) {
        const violation: GuardrailViolation = {
          ruleId: 'comments:max-inline',
          kind: 'comment-density',
          file,
          message: `Inline comments (${analysis.inlineComments}) exceed maxInlinePerFile (${commentsCfg.maxInlinePerFile})`,
          replaceWith: 'Remove redundant inline comments',
          severity: 'error',
          ...(commentsCfg.ratcheted ? { ratcheted: true } : {}),
        };
        if (commentsCfg.ratcheted) {
          recordRatcheted('comments:max-inline', file, analysis.inlineComments, [violation]);
        } else {
          violations.push(violation);
        }
      }
    }
  }

  // 4. Brownfield ratchets
  const ratchetPath = options?.ratchetPath ?? join(root, config.ratchetFile);
  const existingBaseline = readRatchetBaseline(ratchetPath);
  const tightenings: RatchetTightening[] = [];
  let baselined = 0;
  const partialRun = options?.files !== undefined;

  if (options?.updateRatchet) {
    // Compute tightenings compared to previous baseline (if any) and write new baseline.
    const nextCounts: Record<string, Record<string, number>> = {};
    if (existingBaseline && partialRun) {
      for (const [ruleId, fileMap] of Object.entries(existingBaseline.counts)) {
        nextCounts[ruleId] = { ...fileMap };
      }
    }

    for (const ruleId of ratchetedRuleIds) {
      const byFile = ratchetedResults.get(ruleId) ?? new Map<string, RatchetEntry>();
      const prevFiles = existingBaseline?.counts[ruleId] ?? {};

      for (const [file, entry] of byFile) {
        if (!nextCounts[ruleId]) nextCounts[ruleId] = {};
        nextCounts[ruleId][file] = entry.count;
        baselined += entry.violations.length;
        const prev = prevFiles[file];
        if (prev !== undefined && entry.count < prev) {
          tightenings.push({ ruleId, file, baseline: prev, actual: entry.count });
        }
      }

      for (const [file, prevCount] of Object.entries(prevFiles)) {
        if (!byFile.has(file) && (!partialRun || scannedFileSet.has(file))) {
          if (nextCounts[ruleId]) delete nextCounts[ruleId][file];
          if (prevCount > 0) {
            tightenings.push({ ruleId, file, baseline: prevCount, actual: 0 });
          }
        }
      }
    }

    writeRatchetBaseline(ratchetPath, {
      schema: 'vgate.ratchet/1',
      updatedAt: new Date().toISOString(),
      counts: nextCounts,
    });
  } else {
    for (const ruleId of ratchetedRuleIds) {
      const byFile = ratchetedResults.get(ruleId) ?? new Map<string, RatchetEntry>();
      const prevFiles = existingBaseline?.counts[ruleId] ?? {};

      for (const [file, entry] of byFile) {
        const allowed = prevFiles[file] ?? 0;
        if (entry.count <= allowed) {
          baselined += entry.violations.length;
          if (entry.count < allowed) {
            tightenings.push({ ruleId, file, baseline: allowed, actual: entry.count });
          }
        } else {
          // Exceeded baseline (or brand new file with allowed === 0).
          if (entry.violations.length > 1) {
            baselined += allowed;
            const excess = entry.violations.slice(allowed);
            for (const v of excess) {
              violations.push({
                ...v,
                message: `${v.message} (ratchet exceeded: ${entry.count} > baseline ${allowed})`,
              });
            }
          } else {
            for (const v of entry.violations) {
              violations.push({
                ...v,
                message: `${v.message} (ratchet exceeded: ${entry.count} > baseline ${allowed})`,
              });
            }
          }
        }
      }

      for (const [file, prevCount] of Object.entries(prevFiles)) {
        if (prevCount > 0 && !byFile.has(file) && (!partialRun || scannedFileSet.has(file))) {
          tightenings.push({ ruleId, file, baseline: prevCount, actual: 0 });
        }
      }
    }
  }

  tightenings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.file.localeCompare(b.file));

  // 5. Native linters
  const nativeLinters: NativeLinterResult[] = [];
  if (!options?.skipNativeLinters) {
    for (const linter of config.nativeLinters) {
      const proc = spawnSync(linter.command, linter.args ?? [], {
        cwd: root,
        shell: false,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
      const exitCode = proc.status;
      const ok = proc.error === undefined && exitCode === 0;
      const parts = [proc.stdout, proc.stderr, proc.error ? proc.error.message : ''].filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0,
      );
      const output = parts.join('\n').trim();
      nativeLinters.push({ id: linter.id, ok, exitCode, output });
      if (!ok) {
        violations.push({
          ruleId: linter.id,
          kind: 'native-linter',
          file: linter.configFiles?.[0] ?? '',
          message: `Native linter "${linter.id}" (${linter.command}) failed (exit ${exitCode ?? 'error'})${linter.reason ? `: ${linter.reason}` : ''}`,
          severity: 'error',
        });
      }
    }
  }

  // 6. Rule-to-Enforcer Registry (AGENTS.md)
  const { result: ruleTable, violations: ruleTableViolations } = checkRuleTable(root, config);
  violations.push(...ruleTableViolations);

  const ok = !violations.some((v) => v.severity === 'error') && nativeLinters.every((l) => l.ok);

  return {
    schema: 'vgate.lint/1',
    ok,
    filesScanned: scannedFileSet.size,
    violations,
    baselined,
    tightenings,
    nativeLinters,
    ruleTable,
  };
}

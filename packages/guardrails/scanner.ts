import { posix } from 'node:path';

export type Language = 'js' | 'go' | 'python' | 'rust' | 'jvm' | 'csharp' | 'ruby' | 'hash' | 'clike' | 'generic';

export interface ExtractedImport {
  specifier: string;
  line: number;
  resolvedHint?: string;
}

export interface CommentAnalysis {
  totalLines: number;
  codeLines: number;
  commentLines: number;
  inlineComments: number;
  ratio: number;
}

export interface CommentAnalysisOptions {
  ignoreLicenseHeaders?: boolean;
  ignoreDocComments?: boolean;
}

export function detectLanguage(filePath: string): Language {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot + 1);
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'js';
    case 'go':
      return 'go';
    case 'py':
    case 'pyi':
      return 'python';
    case 'rs':
      return 'rust';
    case 'java':
    case 'kt':
    case 'kts':
      return 'jvm';
    case 'cs':
      return 'csharp';
    case 'rb':
      return 'ruby';
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'conf':
    case 'env':
      return 'hash';
    case 'c':
    case 'h':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'hpp':
    case 'hh':
    case 'swift':
    case 'dart':
    case 'php':
    case 'scala':
    case 'groovy':
    case 'css':
    case 'scss':
    case 'less':
      return 'clike';
    default:
      if (base === 'dockerfile' || base === 'makefile') return 'hash';
      return 'generic';
  }
}

interface LineLexInfo {
  hasCode: boolean;
  hasRegularComment: boolean;
  hasDocComment: boolean;
  commentText: string;
}

interface LexResult {
  stripped: string;
  lines: LineLexInfo[];
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'case',
  'throw',
  'in',
  'of',
  'typeof',
  'void',
  'delete',
  'new',
  'else',
  'do',
  'yield',
  'await',
]);

function isIdentChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '$';
}

function canStartJsRegex(prevToken: string): boolean {
  if (prevToken === '') return true;
  if (REGEX_PRECEDING_KEYWORDS.has(prevToken)) return true;
  const last = prevToken[prevToken.length - 1];
  return '([,{;=!&|?+-%~^<>:'.includes(last);
}

/**
 * Checks if `source[idx]` (which is `'`) starts a Rust character literal like `'a'`, `'\n'`, `'\u{1F600}'`
 * rather than a Rust lifetime like `'static` or `'a`.
 */
function rustCharLiteralEnd(source: string, idx: number): number {
  const n = source.length;
  if (idx + 2 >= n) return -1;
  if (source[idx + 1] === '\\') {
    let j = idx + 2;
    while (j < n && j <= idx + 12 && source[j] !== '\n' && source[j] !== '\r') {
      if (source[j] === "'") return j;
      j++;
    }
    return -1;
  }
  if (source[idx + 1] !== '\n' && source[idx + 1] !== '\r' && source[idx + 2] === "'") {
    return idx + 2;
  }
  return -1;
}

function usesHashComments(lang: Language): boolean {
  return lang === 'python' || lang === 'ruby' || lang === 'hash';
}

function usesCLikeComments(lang: Language): boolean {
  return !usesHashComments(lang);
}

function lexSource(source: string, lang: Language): LexResult {
  const n = source.length;
  const out: string[] = [];
  const lines: LineLexInfo[] = [];

  const ensureLine = (lineIdx: number): LineLexInfo => {
    while (lines.length <= lineIdx) {
      lines.push({ hasCode: false, hasRegularComment: false, hasDocComment: false, commentText: '' });
    }
    return lines[lineIdx];
  };

  let lineIdx = 0;
  let i = 0;
  let prevToken = '';
  let lineHasNonWsBefore = false;

  const isCLike = usesCLikeComments(lang);
  const isHash = usesHashComments(lang);
  const nestedBlockComments = lang === 'rust';
  const supportBacktickStrings = lang === 'js' || lang === 'go';
  const supportTripleQuotes = lang === 'python' || lang === 'jvm' || lang === 'csharp';
  const supportJsRegex = lang === 'js';

  // Handle shebang on line 1 (`#!/...`) as a non-code directive/comment line.
  if (source.startsWith('#!')) {
    const info = ensureLine(0);
    while (i < n && source[i] !== '\n') {
      info.commentText += source[i];
      out.push(' ');
      i++;
    }
    info.hasRegularComment = true;
  }

  // Track template literal interpolation depth for JS/TS (`${ ... }`).
  const templateBraceStack: number[] = [];

  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : '';

    if (ch === '\n') {
      out.push('\n');
      ensureLine(lineIdx);
      lineIdx++;
      lineHasNonWsBefore = false;
      i++;
      continue;
    }

    if (ch === '\r') {
      out.push('\r');
      i++;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v') {
      out.push(ch);
      i++;
      continue;
    }

    // Resume template literal after closing `}` of `${...}`.
    if (ch === '}' && templateBraceStack.length > 0) {
      const top = templateBraceStack[templateBraceStack.length - 1];
      if (top === 0) {
        templateBraceStack.pop();
        ensureLine(lineIdx).hasCode = true;
        lineHasNonWsBefore = true;
        out.push(ch);
        i++;
        // Continue scanning the rest of the template literal until `` ` `` or `${`.
        while (i < n) {
          const tc = source[i];
          if (tc === '\\' && i + 1 < n) {
            out.push(tc, source[i + 1]);
            if (source[i + 1] === '\n') {
              ensureLine(lineIdx).hasCode = true;
              lineIdx++;
              lineHasNonWsBefore = false;
            }
            i += 2;
            continue;
          }
          if (tc === '$' && source[i + 1] === '{') {
            ensureLine(lineIdx).hasCode = true;
            lineHasNonWsBefore = true;
            out.push('${');
            templateBraceStack.push(0);
            prevToken = '{';
            i += 2;
            break;
          }
          if (tc === '`') {
            ensureLine(lineIdx).hasCode = true;
            lineHasNonWsBefore = true;
            out.push('`');
            prevToken = 'string';
            i++;
            break;
          }
          if (tc === '\n') {
            out.push('\n');
            ensureLine(lineIdx);
            lineIdx++;
            lineHasNonWsBefore = false;
            i++;
            continue;
          }
          if (tc !== '\r' && tc !== ' ' && tc !== '\t') {
            ensureLine(lineIdx).hasCode = true;
            lineHasNonWsBefore = true;
          }
          out.push(tc);
          i++;
        }
        continue;
      } else {
        templateBraceStack[templateBraceStack.length - 1] = top - 1;
      }
    }

    if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1]++;
    }

    // C-like line comments (`//` and doc `///` / `//!`).
    if (isCLike && ch === '/' && next === '/') {
      const third = i + 2 < n ? source[i + 2] : '';
      const isDoc = (third === '/' && source[i + 3] !== '/') || (lang === 'rust' && third === '!');
      const info = ensureLine(lineIdx);
      if (isDoc) info.hasDocComment = true;
      else info.hasRegularComment = true;
      while (i < n && source[i] !== '\n') {
        if (source[i] === '\r') {
          out.push('\r');
        } else {
          info.commentText += source[i];
          out.push(' ');
        }
        i++;
      }
      continue;
    }

    // C-like block comments (`/* ... */` and doc `/** ... */`).
    if (isCLike && ch === '/' && next === '*') {
      const third = i + 2 < n ? source[i + 2] : '';
      const fourth = i + 3 < n ? source[i + 3] : '';
      const isDoc = third === '*' && fourth !== '/' && fourth !== '*';
      let depth = 1;
      let info = ensureLine(lineIdx);
      if (isDoc) info.hasDocComment = true;
      else info.hasRegularComment = true;
      info.commentText += '/*';
      out.push('  ');
      i += 2;
      while (i < n && depth > 0) {
        const bc = source[i];
        const bn = i + 1 < n ? source[i + 1] : '';
        if (bc === '\n') {
          out.push('\n');
          lineIdx++;
          lineHasNonWsBefore = false;
          info = ensureLine(lineIdx);
          if (isDoc) info.hasDocComment = true;
          else info.hasRegularComment = true;
          i++;
          continue;
        }
        if (bc === '\r') {
          out.push('\r');
          i++;
          continue;
        }
        if (nestedBlockComments && bc === '/' && bn === '*') {
          depth++;
          info.commentText += '/*';
          out.push('  ');
          i += 2;
          continue;
        }
        if (bc === '*' && bn === '/') {
          depth--;
          info.commentText += '*/';
          out.push('  ');
          i += 2;
          continue;
        }
        info.commentText += bc;
        out.push(' ');
        i++;
      }
      continue;
    }

    // Hash line comments (`# ...`) for Python, Ruby, Shell, YAML, TOML.
    if (isHash && ch === '#') {
      const info = ensureLine(lineIdx);
      info.hasRegularComment = true;
      while (i < n && source[i] !== '\n') {
        if (source[i] === '\r') {
          out.push('\r');
        } else {
          info.commentText += source[i];
          out.push(' ');
        }
        i++;
      }
      continue;
    }

    // Generic fallback: treat `#` at the start of a line as a comment.
    if (lang === 'generic' && ch === '#' && !lineHasNonWsBefore) {
      const info = ensureLine(lineIdx);
      info.hasRegularComment = true;
      while (i < n && source[i] !== '\n') {
        if (source[i] === '\r') {
          out.push('\r');
        } else {
          info.commentText += source[i];
          out.push(' ');
        }
        i++;
      }
      continue;
    }

    // Triple-quoted strings (`"""..."""` or `'''...'''`).
    if (supportTripleQuotes && (ch === '"' || ch === "'") && next === ch && source[i + 2] === ch) {
      const quote = ch;
      ensureLine(lineIdx).hasCode = true;
      lineHasNonWsBefore = true;
      out.push(quote, quote, quote);
      i += 3;
      while (i < n) {
        const sc = source[i];
        if (sc === '\\' && i + 1 < n) {
          out.push(sc, source[i + 1]);
          if (source[i + 1] === '\n') {
            lineIdx++;
            lineHasNonWsBefore = false;
          }
          i += 2;
          continue;
        }
        if (sc === quote && source[i + 1] === quote && source[i + 2] === quote) {
          ensureLine(lineIdx).hasCode = true;
          out.push(quote, quote, quote);
          i += 3;
          break;
        }
        if (sc === '\n') {
          out.push('\n');
          lineIdx++;
          lineHasNonWsBefore = false;
          i++;
          continue;
        }
        if (sc !== '\r' && sc !== ' ' && sc !== '\t') {
          ensureLine(lineIdx).hasCode = true;
        }
        out.push(sc);
        i++;
      }
      prevToken = 'string';
      continue;
    }

    // C# verbatim strings `@"..."` (doubled `""` escapes quote).
    if (lang === 'csharp' && ch === '@' && next === '"') {
      ensureLine(lineIdx).hasCode = true;
      lineHasNonWsBefore = true;
      out.push('@"');
      i += 2;
      while (i < n) {
        const sc = source[i];
        if (sc === '"' && source[i + 1] === '"') {
          out.push('""');
          i += 2;
          continue;
        }
        if (sc === '"') {
          out.push('"');
          i++;
          break;
        }
        if (sc === '\n') {
          out.push('\n');
          lineIdx++;
          lineHasNonWsBefore = false;
          i++;
          continue;
        }
        if (sc !== '\r' && sc !== ' ' && sc !== '\t') ensureLine(lineIdx).hasCode = true;
        out.push(sc);
        i++;
      }
      prevToken = 'string';
      continue;
    }

    // Backtick strings: JS template literals (with `${...}` and `\`) or Go raw strings (no `\`).
    if (supportBacktickStrings && ch === '`') {
      ensureLine(lineIdx).hasCode = true;
      lineHasNonWsBefore = true;
      out.push('`');
      i++;
      while (i < n) {
        const tc = source[i];
        if (lang === 'js' && tc === '\\' && i + 1 < n) {
          out.push(tc, source[i + 1]);
          if (source[i + 1] === '\n') {
            lineIdx++;
            lineHasNonWsBefore = false;
          }
          i += 2;
          continue;
        }
        if (lang === 'js' && tc === '$' && source[i + 1] === '{') {
          ensureLine(lineIdx).hasCode = true;
          lineHasNonWsBefore = true;
          out.push('${');
          templateBraceStack.push(0);
          prevToken = '{';
          i += 2;
          break;
        }
        if (tc === '`') {
          ensureLine(lineIdx).hasCode = true;
          out.push('`');
          prevToken = 'string';
          i++;
          break;
        }
        if (tc === '\n') {
          out.push('\n');
          lineIdx++;
          lineHasNonWsBefore = false;
          i++;
          continue;
        }
        if (tc !== '\r' && tc !== ' ' && tc !== '\t') ensureLine(lineIdx).hasCode = true;
        out.push(tc);
        i++;
      }
      continue;
    }

    // Rust single quote: distinguish char literal from lifetime `'a`.
    if (lang === 'rust' && ch === "'") {
      ensureLine(lineIdx).hasCode = true;
      lineHasNonWsBefore = true;
      const end = rustCharLiteralEnd(source, i);
      if (end !== -1) {
        out.push(source.slice(i, end + 1));
        i = end + 1;
        prevToken = 'char';
      } else {
        out.push("'");
        i++;
        prevToken = "'";
      }
      continue;
    }

    // Standard single-quoted and double-quoted string literals.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      ensureLine(lineIdx).hasCode = true;
      lineHasNonWsBefore = true;
      out.push(quote);
      i++;
      while (i < n) {
        const sc = source[i];
        if (sc === '\\' && i + 1 < n) {
          out.push(sc, source[i + 1]);
          if (source[i + 1] === '\n') {
            lineIdx++;
            lineHasNonWsBefore = false;
          }
          i += 2;
          continue;
        }
        if (sc === quote) {
          out.push(quote);
          i++;
          break;
        }
        if (sc === '\n') {
          out.push('\n');
          lineIdx++;
          lineHasNonWsBefore = false;
          i++;
          break;
        }
        out.push(sc);
        i++;
      }
      prevToken = 'string';
      continue;
    }

    // JS/TS regex literals (`/pattern/flags`), so `/https:\/\//` is never mistaken for `//`.
    if (supportJsRegex && ch === '/' && next !== '/' && next !== '*' && canStartJsRegex(prevToken)) {
      ensureLine(lineIdx).hasCode = true;
      lineHasNonWsBefore = true;
      out.push('/');
      i++;
      let inClass = false;
      while (i < n) {
        const rc = source[i];
        if (rc === '\\' && i + 1 < n && source[i + 1] !== '\n') {
          out.push(rc, source[i + 1]);
          i += 2;
          continue;
        }
        if (rc === '[') {
          inClass = true;
          out.push(rc);
          i++;
          continue;
        }
        if (rc === ']') {
          inClass = false;
          out.push(rc);
          i++;
          continue;
        }
        if (rc === '/' && !inClass) {
          out.push('/');
          i++;
          while (i < n && /[a-z]/i.test(source[i])) {
            out.push(source[i]);
            i++;
          }
          break;
        }
        if (rc === '\n') {
          out.push('\n');
          lineIdx++;
          lineHasNonWsBefore = false;
          i++;
          break;
        }
        out.push(rc);
        i++;
      }
      prevToken = 'regex';
      continue;
    }

    // Regular code token.
    ensureLine(lineIdx).hasCode = true;
    lineHasNonWsBefore = true;
    if (isIdentChar(ch)) {
      const start = i;
      while (i < n && isIdentChar(source[i])) {
        out.push(source[i]);
        i++;
      }
      prevToken = source.slice(start, i);
    } else {
      out.push(ch);
      prevToken = ch;
      i++;
    }
  }

  return { stripped: out.join(''), lines };
}

/**
 * Returns `source` with all comments replaced by spaces (preserving newlines and offsets),
 * while leaving strings, template literals, and regex literals intact.
 */
export function stripComments(source: string, filePath: string): string {
  return lexSource(source, detectLanguage(filePath)).stripped;
}

const LICENSE_RE =
  /\b(copyright|spdx-license-identifier|licensed under|all rights reserved|mit license|apache license|bsd license|gpl)\b/i;

export function analyzeComments(source: string, filePath: string, opts?: CommentAnalysisOptions): CommentAnalysis {
  if (source.length === 0) {
    return { totalLines: 0, codeLines: 0, commentLines: 0, inlineComments: 0, ratio: 0 };
  }

  const lang = detectLanguage(filePath);
  const trimmedTrailing = source.endsWith('\r\n')
    ? source.slice(0, -2)
    : source.endsWith('\n')
      ? source.slice(0, -1)
      : source;
  const totalLines = trimmedTrailing.length === 0 ? 0 : trimmedTrailing.split('\n').length;
  const { lines } = lexSource(trimmedTrailing, lang);

  // Identify optional leading license header block (the first contiguous comment block before any code).
  const licenseLines = new Set<number>();
  if (opts?.ignoreLicenseHeaders) {
    let idx = 0;
    // Skip optional shebang and leading blank lines.
    if (idx < lines.length && lines[idx].commentText.startsWith('#!')) idx++;
    while (idx < lines.length && !lines[idx].hasCode && !lines[idx].hasRegularComment && !lines[idx].hasDocComment) {
      idx++;
    }
    const blockStart = idx;
    while (idx < lines.length && !lines[idx].hasCode && (lines[idx].hasRegularComment || lines[idx].hasDocComment)) {
      idx++;
    }
    const blockEnd = idx;
    if (blockEnd > blockStart) {
      const headerText = lines
        .slice(blockStart, blockEnd)
        .map((l) => l.commentText)
        .join('\n');
      if (LICENSE_RE.test(headerText)) {
        for (let j = blockStart; j < blockEnd; j++) {
          licenseLines.add(j);
        }
      }
    }
  }

  let codeLines = 0;
  let commentLines = 0;
  let inlineComments = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const info = lines[idx];
    if (info.hasCode) codeLines++;

    if (licenseLines.has(idx)) continue;

    const hasCountedComment = opts?.ignoreDocComments
      ? info.hasRegularComment
      : info.hasRegularComment || info.hasDocComment;

    if (hasCountedComment) {
      commentLines++;
      if (info.hasCode) inlineComments++;
    }
  }

  const denom = codeLines + commentLines;
  const ratio = denom === 0 ? 0 : commentLines / denom;

  return { totalLines, codeLines, commentLines, inlineComments, ratio };
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function normalizePosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function resolveRelativePath(filePath: string, specifier: string): string {
  const dir = posix.dirname(normalizePosixPath(filePath));
  const joined = dir === '.' ? specifier : posix.join(dir, specifier);
  return posix.normalize(joined).replace(/^\.\//, '');
}

function extractJsImports(stripped: string, filePath: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];
  const seen = new Set<string>();

  const push = (specifier: string, index: number) => {
    const line = lineNumberAt(stripped, index);
    const key = `${line}:${specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    const isRel = specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';
    const resolvedHint = isRel ? resolveRelativePath(filePath, specifier) : undefined;
    results.push({ specifier, line, ...(resolvedHint !== undefined ? { resolvedHint } : {}) });
  };

  // Static `import ... from '...'` and `export ... from '...'` (single or multi-line).
  const fromRe =
    /(?:^|[;\n])\s*(?:import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s+from\s*['"]([^'"]+)['"]/g;
  for (const match of stripped.matchAll(fromRe)) {
    const keywordOffset = match[0].search(/\b(?:import|export)\b/);
    push(match[1], (match.index ?? 0) + Math.max(0, keywordOffset));
  }

  // Side-effect `import '...'`
  const sideEffectRe = /(?:^|[;\n])\s*import\s+['"]([^'"]+)['"]/g;
  for (const match of stripped.matchAll(sideEffectRe)) {
    const keywordOffset = match[0].indexOf('import');
    push(match[1], (match.index ?? 0) + Math.max(0, keywordOffset));
  }

  // Dynamic `import('...')`
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of stripped.matchAll(dynamicRe)) {
    push(match[1], match.index ?? 0);
  }

  // CommonJS `require('...')`
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of stripped.matchAll(requireRe)) {
    push(match[1], match.index ?? 0);
  }

  results.sort((a, b) => a.line - b.line);
  return results;
}

function extractGoImports(stripped: string, filePath: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];
  const lines = stripped.split('\n');
  let inGroup = false;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const lineNum = i + 1;

    if (!inGroup) {
      const groupStart = /^\s*import\s*\((.*)$/.exec(lineText);
      if (groupStart) {
        const rest = groupStart[1];
        const closeIdx = rest.indexOf(')');
        const segment = closeIdx === -1 ? rest : rest.slice(0, closeIdx);
        const inlineSpec = /"([^"]+)"/.exec(segment);
        if (inlineSpec) {
          const spec = inlineSpec[1];
          const resolvedHint =
            spec.startsWith('./') || spec.startsWith('../') ? resolveRelativePath(filePath, spec) : undefined;
          results.push({ specifier: spec, line: lineNum, ...(resolvedHint ? { resolvedHint } : {}) });
        }
        if (closeIdx === -1) inGroup = true;
        continue;
      }

      const single = /^\s*import\s+(?:[\w._]+\s+)?"([^"]+)"/.exec(lineText);
      if (single) {
        const spec = single[1];
        const resolvedHint =
          spec.startsWith('./') || spec.startsWith('../') ? resolveRelativePath(filePath, spec) : undefined;
        results.push({ specifier: spec, line: lineNum, ...(resolvedHint ? { resolvedHint } : {}) });
      }
    } else {
      const closeIdx = lineText.indexOf(')');
      const segment = closeIdx === -1 ? lineText : lineText.slice(0, closeIdx);
      const specMatch = /"([^"]+)"/.exec(segment);
      if (specMatch) {
        const spec = specMatch[1];
        const resolvedHint =
          spec.startsWith('./') || spec.startsWith('../') ? resolveRelativePath(filePath, spec) : undefined;
        results.push({ specifier: spec, line: lineNum, ...(resolvedHint ? { resolvedHint } : {}) });
      }
      if (closeIdx !== -1) inGroup = false;
    }
  }

  return results;
}

function resolvePythonImport(filePath: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    let dots = 0;
    while (dots < specifier.length && specifier[dots] === '.') dots++;
    const rest = specifier.slice(dots).replace(/\./g, '/');
    let baseDir = posix.dirname(normalizePosixPath(filePath));
    for (let up = 1; up < dots; up++) {
      baseDir = posix.dirname(baseDir);
    }
    const target = rest ? (baseDir === '.' ? rest : posix.join(baseDir, rest)) : baseDir;
    return posix.normalize(target).replace(/^\.\//, '');
  }
  if (specifier.includes('.')) {
    return specifier.replace(/\./g, '/');
  }
  return undefined;
}

function extractPythonImports(stripped: string, filePath: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];
  const lines = stripped.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const lineNum = i + 1;

    const fromMatch = /^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\b/.exec(lineText);
    if (fromMatch) {
      const specifier = fromMatch[1];
      const resolvedHint = resolvePythonImport(filePath, specifier);
      results.push({ specifier, line: lineNum, ...(resolvedHint !== undefined ? { resolvedHint } : {}) });
      continue;
    }

    const importMatch = /^\s*import\s+(.+)$/.exec(lineText);
    if (importMatch) {
      const parts = importMatch[1].split(',');
      for (const rawPart of parts) {
        const mod = rawPart
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (!mod || !/^[\w.]+$/.test(mod)) continue;
        const resolvedHint = resolvePythonImport(filePath, mod);
        results.push({ specifier: mod, line: lineNum, ...(resolvedHint !== undefined ? { resolvedHint } : {}) });
      }
    }
  }

  return results;
}

function expandRustUseTree(expr: string): string[] {
  const trimmed = expr
    .trim()
    .replace(/\s+as\s+\w+$/, '')
    .trim();
  const braceStart = trimmed.indexOf('{');
  if (braceStart === -1) return trimmed ? [trimmed] : [];
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceEnd === -1) return [trimmed];
  const prefix = trimmed.slice(0, braceStart).trim();
  const inner = trimmed.slice(braceStart + 1, braceEnd);
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '{') depth++;
    else if (inner[i] === '}') depth--;
    else if (inner[i] === ',' && depth === 0) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  items.push(inner.slice(start));

  const out: string[] = [];
  for (const item of items) {
    const clean = item.trim();
    if (!clean) continue;
    if (clean === 'self') {
      out.push(prefix.replace(/::$/, ''));
    } else {
      for (const sub of expandRustUseTree(clean)) {
        out.push(`${prefix}${sub}`);
      }
    }
  }
  return out;
}

function resolveRustHint(specifier: string, filePath: string): string | undefined {
  if (specifier.startsWith('crate::')) {
    return `src/${specifier.slice('crate::'.length).replace(/::/g, '/')}`;
  }
  if (specifier.startsWith('super::')) {
    const rest = specifier.slice('super::'.length).replace(/::/g, '/');
    return resolveRelativePath(filePath, `../${rest}`);
  }
  if (specifier.startsWith('self::')) {
    const rest = specifier.slice('self::'.length).replace(/::/g, '/');
    return resolveRelativePath(filePath, `./${rest}`);
  }
  if (specifier.includes('::')) {
    return specifier.replace(/::/g, '/');
  }
  return undefined;
}

function extractRustImports(stripped: string, filePath: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];

  const useRe = /(?:^|[;\n])\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+);/g;
  for (const match of stripped.matchAll(useRe)) {
    const keywordOffset = match[0].indexOf('use');
    const line = lineNumberAt(stripped, (match.index ?? 0) + Math.max(0, keywordOffset));
    for (const specifier of expandRustUseTree(match[1])) {
      const resolvedHint = resolveRustHint(specifier, filePath);
      results.push({ specifier, line, ...(resolvedHint !== undefined ? { resolvedHint } : {}) });
    }
  }

  const modRe = /(?:^|[;\n])\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g;
  for (const match of stripped.matchAll(modRe)) {
    const keywordOffset = match[0].indexOf('mod');
    const line = lineNumberAt(stripped, (match.index ?? 0) + Math.max(0, keywordOffset));
    const specifier = match[1];
    const resolvedHint = resolveRelativePath(filePath, `./${specifier}`);
    results.push({ specifier, line, resolvedHint });
  }

  results.sort((a, b) => a.line - b.line);
  return results;
}

function extractJvmImports(stripped: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];
  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;?/.exec(lines[i]);
    if (match) {
      const specifier = match[1];
      results.push({ specifier, line: i + 1, resolvedHint: specifier.replace(/\./g, '/') });
    }
  }
  return results;
}

function extractCSharpImports(stripped: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];
  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:[\w]+\s*=\s*)?([\w.]+)\s*;/.exec(lines[i]);
    if (match) {
      const specifier = match[1];
      results.push({ specifier, line: i + 1, resolvedHint: specifier.replace(/\./g, '/') });
    }
  }
  return results;
}

function extractRubyImports(stripped: string, filePath: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];
  const re = /\b(require_relative|require)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g;
  for (const match of stripped.matchAll(re)) {
    const kind = match[1];
    const specifier = match[2];
    const line = lineNumberAt(stripped, match.index ?? 0);
    const resolvedHint = kind === 'require_relative' ? resolveRelativePath(filePath, `./${specifier}`) : undefined;
    results.push({ specifier, line, ...(resolvedHint !== undefined ? { resolvedHint } : {}) });
  }
  return results;
}

export function extractImports(source: string, filePath: string): ExtractedImport[] {
  const lang = detectLanguage(filePath);
  const stripped = stripComments(source, filePath);
  switch (lang) {
    case 'js':
      return extractJsImports(stripped, filePath);
    case 'go':
      return extractGoImports(stripped, filePath);
    case 'python':
      return extractPythonImports(stripped, filePath);
    case 'rust':
      return extractRustImports(stripped, filePath);
    case 'jvm':
      return extractJvmImports(stripped);
    case 'csharp':
      return extractCSharpImports(stripped);
    case 'ruby':
      return extractRubyImports(stripped, filePath);
    default:
      return [];
  }
}

/**
 * Which parts of a source file are code, comments and string literals, so mutation operators only touch code (and,
 * for one operator, the text of a string a function returns). A small scanner per language family, not a parser:
 * enough to keep `x < y` in a comment, a SQL string or a regular expression from being mutated, for the languages a
 * backend is usually written in.
 */

export type Family = 'c' | 'python';

export interface Language {
  family: Family;
  /** JavaScript and TypeScript: template literals and regular-expression literals. */
  js: boolean;
  /** Java, Kotlin, Scala, C#, Swift, Dart: `"""` text blocks (and Dart's `'''`). */
  textBlocks: boolean;
  /** Go: backtick raw strings. */
  rawBackticks: boolean;
  /** Rust, Swift, Kotlin, Scala, Dart: a block comment may hold another (commented-out code with its comments). */
  nestedComments?: boolean;
  /** Rust: a `"` string may run over several lines. */
  multilineStrings?: boolean;
  /** C#: `@"..."` verbatim strings (several lines, no backslash escapes). */
  verbatimStrings?: boolean;
  /** C++: `R"delim(...)delim"` raw strings. */
  rawStrings?: boolean;
}

const C_LIKE: Record<string, Partial<Language>> = {
  ts: { js: true },
  tsx: { js: true },
  mts: { js: true },
  cts: { js: true },
  js: { js: true },
  jsx: { js: true },
  mjs: { js: true },
  cjs: { js: true },
  go: { rawBackticks: true },
  java: { textBlocks: true },
  kt: { textBlocks: true, nestedComments: true },
  kts: { textBlocks: true, nestedComments: true },
  scala: { textBlocks: true, nestedComments: true },
  cs: { textBlocks: true, verbatimStrings: true },
  swift: { textBlocks: true, nestedComments: true },
  rs: { nestedComments: true, multilineStrings: true },
  dart: { textBlocks: true, nestedComments: true },
  c: {},
  cc: { rawStrings: true },
  cpp: { rawStrings: true },
  h: {},
  hpp: { rawStrings: true },
};

/** The language of a file by its extension; undefined for files vgate does not mutate. */
export function languageOf(file: string): Language | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase();
  if (!ext) return undefined;
  if (ext === 'py') return { family: 'python', js: false, textBlocks: false, rawBackticks: false };
  const c = C_LIKE[ext];
  if (!c) return undefined;
  return { family: 'c', js: false, textBlocks: false, rawBackticks: false, ...c };
}

export type SegmentKind = 'code' | 'comment' | 'string' | 'regex';

export interface Segment {
  kind: SegmentKind;
  start: number;
  /** Exclusive. */
  end: number;
}

const IDENT = /[A-Za-z0-9_$]/;

/** Where a `/` can start a regular expression rather than divide: after an operator, a bracket or a keyword. */
function regexCanStart(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /[ \t]/.test(text[i])) i--;
  if (i < 0) return true;
  // Across lines too: JavaScript reads `a` then a line starting with `/ b` as a division.
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;
  const prev = text[i];
  // `</` closes a JSX element; `x++ / 2` divides.
  if (prev === '<' && i === at - 1) return false;
  if ((prev === '+' || prev === '-') && text[i - 1] === prev) return false;
  if ('([{,;:=!&|?+-*%<>~^'.includes(prev)) return true;
  if (IDENT.test(prev)) {
    let j = i;
    while (j >= 0 && IDENT.test(text[j])) j--;
    return ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'yield', 'await'].includes(
      text.slice(j + 1, i + 1),
    );
  }
  return false;
}

/** Splits `text` into code, comment, string and regular-expression segments. */
export function tokenize(text: string, lang: Language): Segment[] {
  const segments: Segment[] = [];
  let codeStart = 0;
  let i = 0;
  const push = (kind: SegmentKind, start: number, end: number) => {
    if (codeStart < start) segments.push({ kind: 'code', start: codeStart, end: start });
    segments.push({ kind, start, end });
    codeStart = end;
  };
  const n = text.length;

  // A quoted literal from `i` (at its opening quote, `q` long): to the matching quote, honouring escapes; single-line
  // quotes stop at a newline (an unterminated literal, or a quote that was not one, e.g. a Rust lifetime).
  const quoted = (start: number, q: string, multiline: boolean, escapes = true): number => {
    let j = start + q.length;
    while (j < n) {
      if (escapes && text[j] === '\\') {
        j += 2;
        continue;
      }
      if (text.startsWith(q, j)) return j + q.length;
      if (!multiline && text[j] === '\n') return j;
      j++;
    }
    return n;
  };

  // A JavaScript template literal: its `${...}` expressions count as part of it (nothing inside is mutated).
  const template = (start: number): number => {
    let j = start + 1;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') return j + 1;
      if (c === '$' && text[j + 1] === '{') {
        let depth = 1;
        j += 2;
        while (j < n && depth > 0) {
          const d = text[j];
          if (d === '{') depth++;
          else if (d === '}') depth--;
          else if (d === '`') j = template(j) - 1;
          else if (d === '"' || d === "'") j = quoted(j, d, false) - 1;
          j++;
        }
        continue;
      }
      j++;
    }
    return n;
  };

  // A block comment from `start` (at its `/*`) to its end; where comments nest, to the `*/` that closes this one.
  const blockComment = (start: number): number => {
    let depth = 0;
    let j = start;
    while (j < n) {
      if (text.startsWith('/*', j) && (depth === 0 || lang.nestedComments)) {
        depth++;
        j += 2;
      } else if (text.startsWith('*/', j)) {
        depth--;
        j += 2;
        if (depth === 0) return j;
      } else j++;
    }
    return n;
  };

  const regex = (start: number): number => {
    let j = start + 1;
    let inClass = false;
    while (j < n && text[j] !== '\n') {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        j++;
        while (j < n && /[a-z]/i.test(text[j])) j++;
        return j;
      }
      j++;
    }
    return j;
  };

  while (i < n) {
    const c = text[i];
    if (lang.family === 'python') {
      if (c === '#') {
        const end = text.indexOf('\n', i);
        push('comment', i, end < 0 ? n : end);
        i = end < 0 ? n : end;
        continue;
      }
      // String prefixes (r, b, f, u and pairs of them) belong to the literal.
      const prefix = /^[rRbBfFuU]{0,2}(?=['"])/.exec(text.slice(i, i + 3));
      if (prefix && (i === 0 || !IDENT.test(text[i - 1]))) {
        const q0 = i + prefix[0].length;
        const triple = text.startsWith('"""', q0) || text.startsWith("'''", q0);
        const q = triple ? text.slice(q0, q0 + 3) : text[q0];
        const raw = /r/i.test(prefix[0]);
        const end = quoted(q0, q, triple, !raw);
        push('string', i, end);
        i = end;
        continue;
      }
      i++;
      continue;
    }
    // The C family.
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      push('comment', i, end < 0 ? n : end);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = blockComment(i);
      push('comment', i, end);
      i = end;
      continue;
    }
    const triple = text.slice(i, i + 3);
    if (lang.textBlocks && (triple === '"""' || triple === "'''")) {
      const end = quoted(i, triple, true);
      push('string', i, end);
      i = end;
      continue;
    }
    const verbatim = lang.verbatimStrings ? /^(\$@|@\$?)"/.exec(text.slice(i, i + 3)) : null;
    if (verbatim) {
      const end = quoted(i + verbatim[0].length - 1, '"', true, false);
      push('string', i, end);
      i = end;
      continue;
    }
    const raw =
      lang.rawStrings && (i === 0 || !IDENT.test(text[i - 1]))
        ? /^R"([^()\\\s]{0,16})\(/.exec(text.slice(i, i + 20))
        : null;
    if (raw) {
      const close = text.indexOf(`)${raw[1]}"`, i + raw[0].length);
      const end = close < 0 ? n : close + raw[1].length + 2;
      push('string', i, end);
      i = end;
      continue;
    }
    const rustRaw =
      lang.multilineStrings && (i === 0 || !IDENT.test(text[i - 1])) ? /^b?r(#*)"/.exec(text.slice(i, i + 40)) : null;
    if (rustRaw) {
      const close = text.indexOf(`"${rustRaw[1]}`, i + rustRaw[0].length);
      const end = close < 0 ? n : close + rustRaw[1].length + 1;
      push('string', i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = quoted(i, c, c === '"' && lang.multilineStrings === true);
      push('string', i, end);
      i = end;
      continue;
    }
    if (c === '`' && (lang.js || lang.rawBackticks)) {
      const end = lang.js ? template(i) : quoted(i, '`', true, false);
      push('string', i, end);
      i = end;
      continue;
    }
    if (c === '/' && lang.js && regexCanStart(text, i)) {
      const end = regex(i);
      push('regex', i, end);
      i = end;
      continue;
    }
    i++;
  }
  if (codeStart < n) segments.push({ kind: 'code', start: codeStart, end: n });
  return segments;
}

/** `text` with every non-code character (comments, strings, regular expressions) blanked; newlines kept. */
export function codeOnly(text: string, segments: Segment[]): string {
  const chars = text.split('');
  for (const s of segments)
    if (s.kind !== 'code') for (let i = s.start; i < s.end; i++) if (chars[i] !== '\n') chars[i] = ' ';
  return chars.join('');
}

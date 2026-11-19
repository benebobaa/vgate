/**
 * Mutation operators: small, plausible bugs planted in the lines a change touched, one at a time. Each works on the
 * code of a line (comments, strings and regular expressions blanked by tokenize.ts), except `return-string`, which
 * empties the text a function returns. The operators are the classic ones that survive in weak test suites:
 *
 *   boundary       `<` <-> `<=`, `>` <-> `>=`          (needs spaces around it, so `List<T>` and `=>` stay out)
 *   equality       `==` <-> `!=`, `===` <-> `!==`
 *   logical        `&&` <-> `||` (Python: `and` <-> `or`)
 *   boolean        `true` <-> `false` (Python: `True` <-> `False`)
 *   arithmetic     binary `+` <-> `-`                   (with spaces around it)
 *   negation       drop a unary `!` (Python: drop `not `)
 *   number         a numeric literal n -> n + 1
 *   return-string  the string a `return` gives back -> empty
 */
import { createHash } from 'node:crypto';
import { codeOnly, languageOf, tokenize, type Language } from './tokenize.ts';

export const OPERATORS = [
  'boundary',
  'equality',
  'logical',
  'boolean',
  'arithmetic',
  'negation',
  'number',
  'return-string',
] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Candidate {
  /** Deterministic: the same file, place and change give the same id. */
  id: string;
  /** Path as given (top-relative in vgate). */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based column of the replaced text. */
  column: number;
  /** Offset of the replaced text in the file. */
  offset: number;
  operator: Operator;
  original: string;
  replacement: string;
  /** The line before and after, trimmed, for people. */
  before: string;
  after: string;
}

const SWAP: Record<string, string> = {
  '<': '<=',
  '<=': '<',
  '>': '>=',
  '>=': '>',
  '==': '!=',
  '!=': '==',
  '===': '!==',
  '!==': '===',
  '&&': '||',
  '||': '&&',
  and: 'or',
  or: 'and',
  true: 'false',
  false: 'true',
  True: 'False',
  False: 'True',
  '+': '-',
  '-': '+',
};

interface Hit {
  operator: Operator;
  /** Offset within the line. */
  at: number;
  original: string;
  replacement: string;
}

function* matches(re: RegExp, text: string): Generator<RegExpExecArray> {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (let m = global.exec(text); m; m = global.exec(text)) {
    yield m;
    if (m[0] === '') global.lastIndex++;
  }
}

function bumped(literal: string): string {
  if (/^\d+$/.test(literal)) return (BigInt(literal) + 1n).toString();
  const [whole, fraction] = literal.split('.');
  return `${(BigInt(whole) + 1n).toString()}.${fraction}`;
}

/** The hits on one line of code (`code`: the line with non-code blanked), in column order. */
function lineHits(code: string, raw: string, lang: Language, stringsOnLine: Array<[number, number]>): Hit[] {
  const hits: Hit[] = [];
  const add = (operator: Operator, at: number, original: string, replacement: string) =>
    hits.push({ operator, at, original, replacement });

  for (const m of matches(/(?<=\s)(<=|>=|<|>)(?=\s)/, code)) add('boundary', m.index, m[1], SWAP[m[1]]);
  for (const m of matches(/(?<![=!<>])(===|!==|==|!=)(?!=)/, code)) add('equality', m.index, m[1], SWAP[m[1]]);
  if (lang.family === 'python') {
    for (const m of matches(/\b(and|or)\b/, code)) add('logical', m.index, m[1], SWAP[m[1]]);
    for (const m of matches(/\b(True|False)\b/, code)) add('boolean', m.index, m[1], SWAP[m[1]]);
    for (const m of matches(/\bnot\s+/, code)) add('negation', m.index, m[0], '');
  } else {
    for (const m of matches(/(&&|\|\|)(?!=)/, code)) add('logical', m.index, m[1], SWAP[m[1]]);
    for (const m of matches(/\b(true|false)\b/, code)) add('boolean', m.index, m[1], SWAP[m[1]]);
    // A unary `!`: after an operator, a bracket or the start, before an operand; never `!=`, `x!` or Kotlin's `!!`.
    for (const m of matches(/(?<=^|[\s([{,=:?&|])!(?=[A-Za-z_$([!])/, code)) add('negation', m.index, '!', '');
  }
  for (const m of matches(/(?<=\s)([+-])(?=\s)/, code)) add('arithmetic', m.index, m[1], SWAP[m[1]]);
  for (const m of matches(/(?<![\w.$])(\d+(?:\.\d+)?)(?![\w.])/, code)) add('number', m.index, m[1], bumped(m[1]));
  const ret = /\breturn\b/.exec(code);
  if (ret)
    for (const [start, end] of stringsOnLine) {
      if (start < ret.index) continue;
      const literal = raw.slice(start, end);
      const open = /^[rRbBfFuU]{0,2}("""|'''|"|'|`)/.exec(literal);
      if (!open) continue;
      const quote = open[1];
      if (!literal.endsWith(quote) || literal.length < open[0].length + quote.length) continue;
      const inner = literal.slice(open[0].length, literal.length - quote.length);
      if (inner === '') continue;
      add('return-string', start, literal, `${open[0]}${quote}`);
    }
  return hits.sort((a, b) => a.at - b.at || OPERATORS.indexOf(a.operator) - OPERATORS.indexOf(b.operator));
}

export function mutantId(file: string, line: number, column: number, operator: Operator, original: string): string {
  return `M${createHash('sha256')
    .update(`${file}\0${line}\0${column}\0${operator}\0${original}`)
    .digest('hex')
    .slice(0, 10)}`;
}

/**
 * Every mutation candidate on `lines` (1-based) of a file; none for a language vgate does not mutate. Pure.
 */
export function candidates(file: string, text: string, lines: Set<number> | 'all'): Candidate[] {
  const lang = languageOf(file);
  if (!lang) return [];
  const segments = tokenize(text, lang);
  const masked = codeOnly(text, segments);
  const out: Candidate[] = [];
  let start = 0;
  const rawLines = text.split('\n');
  for (let index = 0; index < rawLines.length; index++) {
    const lineNo = index + 1;
    const raw = rawLines[index];
    const end = start + raw.length;
    if (lines === 'all' || lines.has(lineNo)) {
      const code = masked.slice(start, end);
      const strings: Array<[number, number]> = segments
        .filter((s) => s.kind === 'string' && s.start >= start && s.end <= end)
        .map((s) => [s.start - start, s.end - start]);
      for (const hit of lineHits(code, raw, lang, strings)) {
        const after = raw.slice(0, hit.at) + hit.replacement + raw.slice(hit.at + hit.original.length);
        out.push({
          id: mutantId(file, lineNo, hit.at + 1, hit.operator, hit.original),
          file,
          line: lineNo,
          column: hit.at + 1,
          offset: start + hit.at,
          operator: hit.operator,
          original: hit.original,
          replacement: hit.replacement,
          before: raw.trim(),
          after: after.trim(),
        });
      }
    }
    start = end + 1;
  }
  return out;
}

/** `text` with one candidate applied. Throws when the file no longer holds the original text there. */
export function apply(text: string, c: Pick<Candidate, 'offset' | 'original' | 'replacement'>): string {
  if (text.slice(c.offset, c.offset + c.original.length) !== c.original)
    throw new Error(`the file changed: no "${c.original}" at offset ${c.offset}`);
  return text.slice(0, c.offset) + c.replacement + text.slice(c.offset + c.original.length);
}

/**
 * Up to `budget` candidates, spread over the files and then over the lines of each: round-robin, in a fixed order,
 * so the same change always gets the same sample.
 */
export function sample(all: Candidate[], budget: number): Candidate[] {
  const byFile = new Map<string, Map<number, Candidate[]>>();
  for (const c of [...all].sort((a, b) => a.file.localeCompare(b.file) || a.offset - b.offset)) {
    const lines = byFile.get(c.file) ?? new Map<number, Candidate[]>();
    lines.set(c.line, [...(lines.get(c.line) ?? []), c]);
    byFile.set(c.file, lines);
  }
  // Per file, its lines in turn: the first candidate of every line, then the second of every line, and so on.
  const queues = [...byFile.values()].map((lines) => {
    const perLine = [...lines.values()];
    const queue: Candidate[] = [];
    for (let round = 0; perLine.some((l) => l.length > round); round++)
      for (const l of perLine) if (l.length > round) queue.push(l[round]);
    return queue;
  });
  const picked: Candidate[] = [];
  for (let round = 0; picked.length < budget && queues.some((q) => q.length > round); round++)
    for (const q of queues) if (q.length > round && picked.length < budget) picked.push(q[round]);
  return picked;
}

/** What a person should add when a mutant survives: in words, for the PR comment. */
export function hint(c: Pick<Candidate, 'operator' | 'original' | 'replacement' | 'file' | 'line'>): string {
  const where = `${c.file}:${c.line}`;
  const changed = `\`${c.original}\` became \`${c.replacement === '' ? '(nothing)' : c.replacement}\``;
  const advice: Record<Operator, string> = {
    boundary: 'add a scenario at the exact limit value',
    equality: 'add one scenario where the two sides are equal and one where they differ',
    logical: 'add a scenario where only one of the two conditions holds',
    boolean: 'add a scenario whose outcome depends on this flag',
    arithmetic: 'assert the computed value exactly',
    negation: 'add a scenario for the opposite case',
    number: `assert the exact value or limit ${c.original}`,
    'return-string': 'assert the text the response carries',
  };
  return `no test noticed when ${changed} in ${where}: ${advice[c.operator]}`;
}

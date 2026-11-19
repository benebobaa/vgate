/**
 * Which tests can catch a mutant: the tests of the operations its line serves. The line's enclosing function is
 * followed up through its callers in the same file until a function named like an operation of the plan
 * (`operationId`, e.g. `createOrder`, `create_order`, `handleCreateOrder`); the tests are those whose title carries a
 * scenario id of those operations. When that is not knowable (no enclosing function, a caller chain that reaches code
 * serving no single operation, a plan without ids) the answer is `undefined`, and the whole suite runs.
 *
 * A selection only orders the work: a mutant the selected tests do not catch is run against the whole suite before
 * it counts as a survivor, so a wrong guess costs time, never a wrong result. Pure; `vgate mutate` uses it.
 */
import { languageOf } from './tokenize.ts';

export interface PlanOperation {
  /** The contract's operationId (the plan's `id`). */
  id: string;
  /** `METHOD /path`. */
  operation?: string;
  scenarios: string[];
}

const DEFINITIONS: Record<string, RegExp[]> = {
  ts: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
    /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/,
  ],
  go: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/],
  java: [
    /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|override|suspend|internal|open|async|virtual|fun)\s+)*[\w<>[\],.?\s]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws\s+[\w.,\s]+)?\s*\{?\s*$/,
    /^\s*(?:(?:public|private|protected|internal|override|suspend|open)\s+)*fun\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)\s*\(/,
  ],
  py: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/],
  rust: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/],
};

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with']);

function patternsFor(file: string): RegExp[] {
  if (!languageOf(file)) return [];
  const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase() ?? '';
  if (ext === 'go') return DEFINITIONS.go;
  if (ext === 'py') return DEFINITIONS.py;
  if (ext === 'rs') return DEFINITIONS.rust;
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].includes(ext)) return DEFINITIONS.ts;
  return [...DEFINITIONS.java, ...DEFINITIONS.ts];
}

const indentOf = (line: string) => /^\s*/.exec(line)?.[0].replace(/\t/g, '    ').length ?? 0;

/** The definitions of a file: name, line (1-based) and indentation. */
export function definitions(file: string, text: string): Array<{ name: string; line: number; indent: number }> {
  const patterns = patternsFor(file);
  const out: Array<{ name: string; line: number; indent: number }> = [];
  text.split('\n').forEach((line, index) => {
    for (const pattern of patterns) {
      const name = pattern.exec(line)?.[1];
      if (name && !KEYWORDS.has(name)) {
        out.push({ name, line: index + 1, indent: indentOf(line) });
        return;
      }
    }
  });
  return out;
}

/** The function whose body holds `line`: the nearest definition above it with less indentation (or the line itself). */
export function enclosingFunction(file: string, text: string, line: number): string | undefined {
  const lines = text.split('\n');
  const target = lines[line - 1];
  if (target === undefined) return undefined;
  const defs = definitions(file, text);
  const own = defs.find((d) => d.line === line);
  if (own) return own.name;
  const indent = indentOf(target);
  for (let i = defs.length - 1; i >= 0; i--) {
    const d = defs[i];
    if (d.line < line && d.indent < indent) {
      // A definition whose body already closed above the line does not hold it: a line back at its indentation
      // (its closing brace, or the next statement in Python) ends it.
      const closed = lines.slice(d.line, line - 1).some((l) => l.trim() !== '' && indentOf(l) <= d.indent);
      if (!closed) return d.name;
    }
  }
  return undefined;
}

const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The operation a function is named after, if any: equal names, or a handler name that contains the operationId. */
export function operationNamed(name: string, operations: PlanOperation[]): PlanOperation | undefined {
  const n = normalise(name);
  return (
    operations.find((op) => normalise(op.id) === n) ??
    operations.find((op) => normalise(op.id).length >= 5 && n.includes(normalise(op.id)))
  );
}

/**
 * The operations a changed line serves, or `undefined` when that is not knowable: every caller chain of its function
 * (within the file, up to `depth` levels) must reach a function named after an operation.
 */
export function operationsFor(
  file: string,
  text: string,
  line: number,
  operations: PlanOperation[],
  depth = 4,
): PlanOperation[] | undefined {
  const start = enclosingFunction(file, text, line);
  if (!start || operations.length === 0) return undefined;
  const lines = text.split('\n');
  const found = new Map<string, PlanOperation>();
  const seen = new Set<string>();
  const visit = (name: string, level: number): boolean => {
    const op = operationNamed(name, operations);
    if (op) {
      found.set(op.id, op);
      return true;
    }
    if (level >= depth || seen.has(name)) return false;
    seen.add(name);
    const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`);
    const callers = new Set<string>();
    lines.forEach((l, index) => {
      if (!call.test(l)) return;
      const caller = enclosingFunction(file, text, index + 1);
      if (caller === undefined) callers.add('');
      else if (caller !== name) callers.add(caller);
    });
    // Called from nowhere in this file (exported, a route table, a framework hook), or from top-level code: the
    // operations it serves cannot be told from here.
    if (callers.size === 0 || callers.has('')) return false;
    return [...callers].every((caller) => visit(caller, level + 1));
  };
  return visit(start, 0) && found.size > 0 ? [...found.values()] : undefined;
}

/** The tests (file and title) that carry a scenario id of the operations. */
export function testsFor<T extends { title: string }>(operations: PlanOperation[], tests: T[]): T[] {
  const ids = new Set(operations.flatMap((op) => op.scenarios));
  return tests.filter((test) => [...test.title.matchAll(/\[([A-Z][A-Z0-9-]*)\]/g)].some(([, id]) => ids.has(id)));
}

/** The plan's operations with their scenario ids, from a parsed inventory.yaml. */
export function planOperations(inventory: unknown): PlanOperation[] {
  const operations = (inventory as { operations?: unknown } | undefined)?.operations;
  if (!Array.isArray(operations)) return [];
  return operations.flatMap((raw) => {
    const op = raw as { id?: unknown; operation?: unknown; scenarios?: unknown };
    if (typeof op.id !== 'string') return [];
    const scenarios = Array.isArray(op.scenarios)
      ? op.scenarios.flatMap((s) => (typeof (s as { id?: unknown }).id === 'string' ? [(s as { id: string }).id] : []))
      : [];
    return [{ id: op.id, operation: typeof op.operation === 'string' ? op.operation : undefined, scenarios }];
  });
}

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { matchesGlob } from '../../cli/glob.ts';

export type FormalEngine = 'tla+' | 'lean' | 'bombadil' | 'smt';

export interface FormalSpecConfig {
  id: string;
  engine: FormalEngine;
  specFile: string;
  configFile?: string;
  coveredFiles: string[];
  syncCommit?: string;
  invariant?: string;
  scratchMutation?: { file: string; find: string; replace: string };
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

export interface FormalCheckResult {
  id: string;
  engine: FormalEngine;
  ok: boolean;
  stale: boolean;
  staleFiles: string[];
  syncCommit?: string;
  headCommit?: string;
  mutationProven?: boolean;
  detail: string;
  durationMs: number;
}

export interface FormalReport {
  schema: 'vgate.formal/1';
  ok: boolean;
  results: FormalCheckResult[];
}

export interface FormalGuardFinding {
  rule: 'formal-weakened';
  file: string;
  detail: string;
}

export interface StateTransition {
  from: string;
  to: string;
  action: string;
  status?: 'ok' | 'breaks' | 'mayBreak';
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchesAnyCoveredFile(changedFile: string, coveredFiles: string[]): boolean {
  const normChanged = normalizeRelPath(changedFile);
  return coveredFiles.some((pattern) => {
    const normPattern = normalizeRelPath(pattern);
    return normChanged === normPattern || matchesGlob(normChanged, normPattern);
  });
}

function gitLines(repoRoot: string, args: string[]): { ok: boolean; lines: string[] } {
  const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false });
  if (res.error || res.status !== 0) {
    return { ok: false, lines: [] };
  }
  const lines = (res.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { ok: true, lines };
}

/**
 * Checks whether any file covered by `spec.coveredFiles` has changed since `spec.syncCommit`
 * or has uncommitted working-tree modifications.
 */
export function checkSyncDrift(
  repoRoot: string,
  spec: FormalSpecConfig,
): { stale: boolean; staleFiles: string[]; headCommit?: string } {
  const headRes = gitLines(repoRoot, ['rev-parse', 'HEAD']);
  const headCommit = headRes.ok && headRes.lines[0] ? headRes.lines[0] : undefined;

  if (!headCommit) {
    return { stale: false, staleFiles: [] };
  }

  const changed = new Set<string>();

  if (spec.syncCommit) {
    const diffRes = gitLines(repoRoot, ['diff', '--name-only', `${spec.syncCommit}..HEAD`]);
    if (!diffRes.ok) {
      // Unknown or unreachable syncCommit: conservatively flag all coveredFiles as stale.
      const staleFiles = [...spec.coveredFiles].map(normalizeRelPath).sort();
      return { stale: staleFiles.length > 0, staleFiles, headCommit };
    }
    for (const file of diffRes.lines) changed.add(normalizeRelPath(file));
  }

  // Uncommitted tracked changes (staged + unstaged)
  const trackedRes = gitLines(repoRoot, ['diff', '--name-only', 'HEAD']);
  if (trackedRes.ok) {
    for (const file of trackedRes.lines) changed.add(normalizeRelPath(file));
  }

  // Untracked files
  const untrackedRes = gitLines(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  if (untrackedRes.ok) {
    for (const file of untrackedRes.lines) changed.add(normalizeRelPath(file));
  }

  const staleFiles = [...changed].filter((file) => matchesAnyCoveredFile(file, spec.coveredFiles)).sort();
  return {
    stale: staleFiles.length > 0,
    staleFiles,
    headCommit,
  };
}

function defaultEngineCommand(spec: FormalSpecConfig): { cmd: string; args: string[] } {
  if (spec.command) {
    return { cmd: spec.command, args: spec.args ?? [] };
  }

  switch (spec.engine) {
    case 'tla+': {
      const tlcArgs = [...(spec.configFile ? ['-config', spec.configFile] : []), spec.specFile];
      if (process.env.TLA2TOOLS_JAR) {
        return { cmd: 'java', args: ['-cp', process.env.TLA2TOOLS_JAR, 'tlc2.TLC', ...tlcArgs] };
      }
      return { cmd: 'tlc', args: tlcArgs };
    }
    case 'lean':
      return { cmd: 'lake', args: spec.args ?? ['build'] };
    case 'bombadil':
      return { cmd: 'npx', args: spec.args ?? ['@antithesishq/bombadil', spec.specFile] };
    case 'smt':
      return { cmd: 'z3', args: spec.args ?? [spec.specFile] };
  }
}

function defaultExecutor(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
): { ok: boolean; output: string } {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: timeoutMs,
  });
  if (res.error) {
    return { ok: false, output: res.error.message };
  }
  const output = [(res.stdout ?? '').trim(), (res.stderr ?? '').trim()].filter(Boolean).join('\n');
  return { ok: res.status === 0, output };
}

/**
 * Runs formal verification specs, tracks sync-commit drift, and optionally proves
 * non-vacuity via scratch mutation (always restoring original file bytes in `finally`).
 */
export function runFormalChecks(
  repoRoot: string,
  specs: FormalSpecConfig[],
  options?: {
    verifyMutation?: boolean;
    executor?: (cmd: string, args: string[], cwd: string) => { ok: boolean; output: string };
  },
): FormalReport {
  const results: FormalCheckResult[] = [];

  for (const spec of specs) {
    const start = performance.now();
    const drift = checkSyncDrift(repoRoot, spec);
    const { cmd, args } = defaultEngineCommand(spec);
    const exec = options?.executor
      ? options.executor
      : (c: string, a: string[], d: string) => defaultExecutor(c, a, d, spec.timeoutMs);

    let baseRun: { ok: boolean; output: string };
    try {
      baseRun = exec(cmd, args, repoRoot);
    } catch (err) {
      baseRun = { ok: false, output: `executor error: ${err instanceof Error ? err.message : String(err)}` };
    }

    let mutationProven: boolean | undefined;
    const details: string[] = [];

    if (!baseRun.ok) {
      details.push(baseRun.output || `${spec.engine} check failed`);
    }

    if (drift.stale) {
      details.push(`stale spec (${drift.staleFiles.join(', ')})`);
    }

    if (options?.verifyMutation && spec.scratchMutation && baseRun.ok) {
      const targetPath = path.resolve(repoRoot, spec.scratchMutation.file);
      let originalBytes: Buffer;
      try {
        originalBytes = readFileSync(targetPath);
      } catch (err) {
        mutationProven = false;
        details.push(`scratch mutation file unreadable: ${err instanceof Error ? err.message : String(err)}`);
        originalBytes = Buffer.alloc(0);
      }

      if (mutationProven === undefined) {
        const originalText = originalBytes.toString('utf8');
        if (!originalText.includes(spec.scratchMutation.find)) {
          mutationProven = false;
          details.push(`scratch mutation pattern not found in ${spec.scratchMutation.file}`);
        } else {
          const mutatedText = originalText.replace(spec.scratchMutation.find, spec.scratchMutation.replace);
          try {
            writeFileSync(targetPath, mutatedText, 'utf8');
            const mutatedRun = exec(cmd, args, repoRoot);
            if (!mutatedRun.ok) {
              mutationProven = true;
              details.push('mutation proven (scratch defect caught)');
            } else {
              mutationProven = false;
              details.push('vacuous formal check: passed even with scratch mutation injected');
            }
          } catch (err) {
            mutationProven = false;
            details.push(`mutation verification error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            writeFileSync(targetPath, originalBytes);
          }
        }
      }
    }

    const ok = baseRun.ok && !drift.stale && mutationProven !== false;
    const detail = details.length > 0 ? details.join('; ') : baseRun.output || 'passed';
    const durationMs = Math.round(performance.now() - start);

    results.push({
      id: spec.id,
      engine: spec.engine,
      ok,
      stale: drift.stale,
      staleFiles: drift.staleFiles,
      ...(spec.syncCommit !== undefined ? { syncCommit: spec.syncCommit } : {}),
      ...(drift.headCommit !== undefined ? { headCommit: drift.headCommit } : {}),
      ...(mutationProven !== undefined ? { mutationProven } : {}),
      detail,
      durationMs,
    });
  }

  return {
    schema: 'vgate.formal/1',
    ok: results.every((r) => r.ok),
    results,
  };
}

/**
 * Guard rule that detects weakening of formal verification configuration between base and head:
 * removed formal specs, removed `coveredFiles`, or removed `invariant`.
 */
export function formalGuardRule(
  file: string,
  baseSpecs: FormalSpecConfig[],
  headSpecs: FormalSpecConfig[],
): { findings: FormalGuardFinding[]; info: FormalGuardFinding[] } {
  const findings: FormalGuardFinding[] = [];
  const info: FormalGuardFinding[] = [];

  const headById = new Map(headSpecs.map((s) => [s.id, s]));

  for (const base of baseSpecs) {
    const head = headById.get(base.id);
    if (!head) {
      findings.push({
        rule: 'formal-weakened',
        file,
        detail: `Formal spec "${base.id}" (${base.engine}) was removed`,
      });
      continue;
    }

    const headCovered = new Set(head.coveredFiles.map(normalizeRelPath));
    for (const covered of base.coveredFiles) {
      if (!headCovered.has(normalizeRelPath(covered))) {
        findings.push({
          rule: 'formal-weakened',
          file,
          detail: `Formal spec "${base.id}" removed coveredFile "${covered}"`,
        });
      }
    }

    const baseInv = base.invariant?.trim();
    const headInv = head.invariant?.trim();
    if (baseInv && !headInv) {
      findings.push({
        rule: 'formal-weakened',
        file,
        detail: `Formal spec "${base.id}" removed invariant "${baseInv}"`,
      });
    } else if (baseInv && headInv && baseInv !== headInv) {
      info.push({
        rule: 'formal-weakened',
        file,
        detail: `Formal spec "${base.id}" modified invariant from "${baseInv}" to "${headInv}"`,
      });
    }
  }

  return { findings, info };
}

function extractSetValues(expr: string): string[] {
  const quoted = [...expr.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
  if (quoted.length > 0) return quoted;
  return expr
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
}

function parseDotStates(source: string): { states: string[]; transitions: StateTransition[]; invariants: string[] } {
  const states: string[] = [];
  const stateSet = new Set<string>();
  const transitions: StateTransition[] = [];

  const addState = (s: string): void => {
    if (!stateSet.has(s)) {
      stateSet.add(s);
      states.push(s);
    }
  };

  const edgeRe =
    /(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*->\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))(?:\s*\[([^\]]*)\])?/g;
  for (const match of source.matchAll(edgeRe)) {
    const from = (match[1] ?? match[2] ?? '').trim();
    const to = (match[3] ?? match[4] ?? '').trim();
    const attrs = match[5] ?? '';
    if (!from || !to) continue;
    const labelMatch = /label\s*=\s*"([^"]*)"/.exec(attrs);
    const action = labelMatch?.[1]?.trim() || 'step';
    let status: StateTransition['status'] = 'ok';
    if (/\bbreaks\b/i.test(attrs)) status = 'breaks';
    else if (/\bmayBreak\b/i.test(attrs)) status = 'mayBreak';

    addState(from);
    addState(to);
    transitions.push({ from, to, action, status });
  }

  return { states, transitions, invariants: [] };
}

/**
 * Parses TLA+ specs (`Init`, `Next`, action definitions, invariants) or DOT/TLC state-graph input
 * into states, transitions, and invariant names.
 */
export function parseTlaStates(tlaSource: string): {
  states: string[];
  transitions: StateTransition[];
  invariants: string[];
} {
  if (/\bdigraph\b/.test(tlaSource) || /\s->\s/.test(tlaSource)) {
    return parseDotStates(tlaSource);
  }

  const states: string[] = [];
  const stateSet = new Set<string>();
  const transitions: StateTransition[] = [];
  const invariants: string[] = [];
  const invariantSet = new Set<string>();

  const addState = (s: string): void => {
    if (s && !stateSet.has(s)) {
      stateSet.add(s);
      states.push(s);
    }
  };

  const addInvariant = (name: string): void => {
    if (name && !invariantSet.has(name)) {
      invariantSet.add(name);
      invariants.push(name);
    }
  };

  // Explicit `INVARIANT Foo` declarations (e.g., from TLC cfg or comments)
  for (const match of tlaSource.matchAll(/^\s*INVARIANT\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    if (match[1]) addInvariant(match[1]);
  }

  // Split top-level `Name == body` definitions
  const lines = tlaSource.split(/\r?\n/);
  const defs = new Map<string, string>();
  let currentName: string | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentName !== null) {
      defs.set(currentName, currentLines.join('\n').trim());
    }
  };

  for (const line of lines) {
    if (/^====+/.test(line.trim())) {
      flush();
      currentName = null;
      currentLines = [];
      break;
    }
    const defMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))?\s*==(.*)$/.exec(line);
    if (defMatch && defMatch[1]) {
      flush();
      currentName = defMatch[1];
      currentLines = [defMatch[2] ?? ''];
    } else if (currentName !== null) {
      currentLines.push(line);
    }
  }
  flush();

  // Extract initial state(s) from Init
  const initBody = defs.get('Init');
  const initStates: string[] = [];
  if (initBody) {
    for (const m of initBody.matchAll(/\bstate\s*=\s*"([^"]+)"/g)) {
      if (m[1]) {
        initStates.push(m[1]);
        addState(m[1]);
      }
    }
    for (const m of initBody.matchAll(/\bstate\s*\\in\s*\{([^}]+)\}/g)) {
      if (m[1]) {
        for (const s of extractSetValues(m[1])) {
          initStates.push(s);
          addState(s);
        }
      }
    }
  }

  // Determine Next actions (if Next is defined)
  const nextBody = defs.get('Next');
  const nextActions = new Set<string>();
  if (nextBody) {
    const cleaned = nextBody.replace(/\\\*.*$/gm, '');
    for (const token of cleaned.split(/\\\//)) {
      const m = /([A-Za-z_][A-Za-z0-9_]*)/.exec(token.trim());
      if (m && m[1] && defs.has(m[1])) {
        nextActions.add(m[1]);
      }
    }
  }

  const structuralNames = new Set(['Init', 'Next', 'Spec', 'vars', 'Vars']);

  for (const [name, body] of defs.entries()) {
    if (structuralNames.has(name)) continue;

    const isAction = nextActions.size > 0 ? nextActions.has(name) : body.includes("'");
    if (isAction) {
      // Find from-states (`state = "X"` or `state \in {"X", "Y"}`)
      const fromStates: string[] = [];
      for (const m of body.matchAll(/(?<!')\bstate\s*=\s*"([^"]+)"/g)) {
        if (m[1]) fromStates.push(m[1]);
      }
      for (const m of body.matchAll(/(?<!')\bstate\s*\\in\s*\{([^}]+)\}/g)) {
        if (m[1]) fromStates.push(...extractSetValues(m[1]));
      }

      // Find to-states (`state' = "Y"` or `state' \in {"Y", "Z"}`)
      const toStates: string[] = [];
      for (const m of body.matchAll(/\bstate'\s*=\s*"([^"]+)"/g)) {
        if (m[1]) toStates.push(m[1]);
      }
      for (const m of body.matchAll(/\bstate'\s*\\in\s*\{([^}]+)\}/g)) {
        if (m[1]) toStates.push(...extractSetValues(m[1]));
      }

      let status: StateTransition['status'] = 'ok';
      if (/\\\*.*\bbreaks\b/i.test(body)) status = 'breaks';
      else if (/\\\*.*\bmayBreak\b/i.test(body)) status = 'mayBreak';

      const effectiveFrom = fromStates.length > 0 ? fromStates : initStates.length > 0 ? initStates : ['*'];
      for (const from of effectiveFrom) {
        for (const to of toStates) {
          addState(from);
          addState(to);
          transitions.push({ from, to, action: name, status });
        }
      }
    } else if (!body.includes("'")) {
      // Non-primed predicate definition (TypeOK, Safety*, *Inv*, etc.)
      if (/^(?:TypeOK|.*Inv.*|Safety.*|No[A-Z].*)$/.test(name) || /(\\in|=>|\/\\|\\\/|>=|<=|=|~)/.test(body)) {
        addInvariant(name);
      }
    }
  }

  return { states, transitions, invariants };
}

function sanitizeMermaidId(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(safe) ? safe : `S_${safe}`;
}

/**
 * Renders state transitions as a Mermaid `stateDiagram-v2`, capping states and arrows
 * and highlighting `breaks` / `mayBreak` states via `classDef`.
 */
export function renderStatechart(input: {
  title?: string;
  transitions: StateTransition[];
  maxStates?: number;
  maxArrows?: number;
}): { mermaid: string; stateCount: number; arrowCount: number; truncated: boolean } {
  const maxStates = input.maxStates ?? 500;
  const maxArrows = input.maxArrows ?? 20;

  const allStates = new Set<string>();
  for (const t of input.transitions) {
    allStates.add(t.from);
    allStates.add(t.to);
  }

  const keptStates = new Set<string>();
  const keptTransitions: StateTransition[] = [];

  for (const t of input.transitions) {
    if (keptTransitions.length >= maxArrows) break;
    const needed = (keptStates.has(t.from) ? 0 : 1) + (keptStates.has(t.to) || t.to === t.from ? 0 : 1);
    if (keptStates.size + needed > maxStates) continue;
    keptStates.add(t.from);
    keptStates.add(t.to);
    keptTransitions.push(t);
  }

  const truncated = keptTransitions.length < input.transitions.length || keptStates.size < allStates.size;

  const lines: string[] = ['stateDiagram-v2'];
  if (input.title) {
    lines.push(`  %% ${input.title}`);
  }

  // Emit aliases for state names that contain non-identifier characters
  const idMap = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const state of keptStates) {
    let id = sanitizeMermaidId(state);
    while (usedIds.has(id)) id = `${id}_`;
    usedIds.add(id);
    idMap.set(state, id);
    if (id !== state) {
      lines.push(`  state "${state.replace(/"/g, '\\"')}" as ${id}`);
    }
  }

  const breaksStates = new Set<string>();
  const mayBreakStates = new Set<string>();

  for (const t of keptTransitions) {
    const fromId = idMap.get(t.from) ?? sanitizeMermaidId(t.from);
    const toId = idMap.get(t.to) ?? sanitizeMermaidId(t.to);
    const suffix = t.status === 'breaks' ? ' [BREAKS]' : t.status === 'mayBreak' ? ' [MAY BREAK]' : '';
    lines.push(`  ${fromId} --> ${toId}: ${t.action}${suffix}`);

    if (t.status === 'breaks') {
      breaksStates.add(toId);
    } else if (t.status === 'mayBreak') {
      mayBreakStates.add(toId);
    }
  }

  if (breaksStates.size > 0) {
    lines.push('  classDef breaks fill:#fee2e2,stroke:#dc2626,color:#991b1b');
    for (const id of breaksStates) {
      lines.push(`  class ${id} breaks`);
    }
  }

  if (mayBreakStates.size > 0) {
    lines.push('  classDef mayBreak fill:#fef3c7,stroke:#d97706,color:#92400e');
    for (const id of mayBreakStates) {
      if (!breaksStates.has(id)) {
        lines.push(`  class ${id} mayBreak`);
      }
    }
  }

  if (truncated) {
    lines.push(
      `  %% Truncated: showing ${keptStates.size}/${allStates.size} states and ${keptTransitions.length}/${input.transitions.length} transitions`,
    );
  }

  return {
    mermaid: lines.join('\n'),
    stateCount: keptStates.size,
    arrowCount: keptTransitions.length,
    truncated,
  };
}

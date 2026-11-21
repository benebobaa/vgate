/**
 * Opt-in guardrail presets (including Dune-style presets and ast-grep bridge) plus Rule Fixture verification
 * (`vgate lint --test`, applying "able to fail" to every rule in `guardrails.yaml`).
 */
import type { BannedPatternRule, BoundaryRule, CommentsConfig, GuardrailsConfig, NativeLinterRule } from './config.ts';
import { extractImports, stripComments } from './scanner.ts';
import { matchesGlob } from '../../cli/glob.ts';

export const PRESET_NAMES = ['minimal-ts', 'dune-react', 'strict-go', 'strict-python', 'ast-grep'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface RuleFixture {
  code: string;
  file?: string;
  expectMatch?: string;
}

export interface RuleFixtures {
  bad: RuleFixture[];
  good: RuleFixture[];
}

export interface GuardrailPreset {
  name: PresetName;
  description: string;
  boundaries?: BoundaryRule[];
  bannedPatterns?: BannedPatternRule[];
  comments?: CommentsConfig;
  nativeLinters?: NativeLinterRule[];
}

export const GUARDRAIL_PRESETS: Record<PresetName, GuardrailPreset> = {
  'minimal-ts': {
    name: 'minimal-ts',
    description: 'Minimal TypeScript safety defaults: ban @ts-ignore and explicit any suppressions.',
    bannedPatterns: [
      {
        id: 'preset:minimal-ts:no-ts-ignore',
        pattern: '(?://|/\\*)\\s*@ts-ignore\\b',
        files: ['**/*.{ts,tsx}'],
        exclude: ['**/*.test.{ts,tsx}', 'packages/guardrails/presets.ts'],
        replaceWith: 'Fix the underlying type error or use @ts-expect-error with an issue link',
        reason: '@ts-ignore silently hides type regressions',
        severity: 'error',
        fixtures: {
          bad: [{ code: '// @ts-ignore\nconst x: number = "bad";', file: 'src/a.ts' }],
          good: [{ code: 'const x: number = 42;\nconst docs = "@ts-ignore";', file: 'src/a.ts' }],
        },
      },
    ],
  },
  'dune-react': {
    name: 'dune-react',
    description:
      'Opt-in Dune-inspired guardrails: ban useEffect in product code, ban zero-delay timer hacks, cap comments.',
    bannedPatterns: [
      {
        id: 'preset:dune-react:no-use-effect',
        pattern: '\\buseEffect\\s*\\(',
        files: ['src/**/*.{ts,tsx,js,jsx}'],
        exclude: ['src/framework/**', '**/*.test.{ts,tsx}'],
        replaceWith: 'Derive state during render or use an audited primitive from src/framework/',
        reason: 'Agents misapply useEffect; restrict effects to audited framework primitives',
        severity: 'error',
        ratcheted: true,
        fixtures: {
          bad: [{ code: 'useEffect(() => { fetchData(); }, []);', file: 'src/app/Page.tsx' }],
          good: [{ code: 'const total = items.reduce((a, b) => a + b, 0);', file: 'src/app/Page.tsx' }],
        },
      },
      {
        id: 'preset:dune-react:no-timer-workarounds',
        pattern: '\\b(?:setTimeout|requestAnimationFrame|requestIdleCallback)\\s*\\(',
        files: ['src/**/*.{ts,tsx,js,jsx}'],
        exclude: ['src/framework/**', '**/*.test.{ts,tsx}'],
        replaceWith: 'Model explicit state transitions or use src/framework/scheduler instead of imperative timers',
        reason: 'Imperative timer workarounds spread rapidly across agent PRs',
        severity: 'error',
        ratcheted: true,
        fixtures: {
          bad: [{ code: 'setTimeout(() => setOpen(true), 0);', file: 'src/ui/Modal.tsx' }],
          good: [{ code: 'setOpen(true);', file: 'src/ui/Modal.tsx' }],
        },
      },
    ],
    comments: {
      maxRatio: 0.15,
      ignoreLicenseHeaders: true,
      ignoreDocComments: true,
      ratcheted: true,
    },
  },
  'strict-go': {
    name: 'strict-go',
    description: 'Opt-in Go guardrails: ban unchecked panic() and time.Sleep() hacks in production packages.',
    bannedPatterns: [
      {
        id: 'preset:strict-go:no-time-sleep',
        pattern: '\\btime\\.Sleep\\s*\\(',
        files: ['**/*.go'],
        exclude: ['**/*_test.go'],
        replaceWith: 'Use context.WithTimeout / select on channel or explicit readiness probes',
        reason: 'Sleep hacks mask race conditions and slow services',
        severity: 'error',
        ratcheted: true,
        fixtures: {
          bad: [{ code: 'package app\nfunc f() { time.Sleep(100) }', file: 'pkg/app/run.go' }],
          good: [{ code: 'package app\nfunc f() { <-ctx.Done() }', file: 'pkg/app/run.go' }],
        },
      },
    ],
  },
  'strict-python': {
    name: 'strict-python',
    description: 'Opt-in Python guardrails: ban bare except clauses and unchecked type: ignore.',
    bannedPatterns: [
      {
        id: 'preset:strict-python:no-bare-except',
        pattern: '^\\s*except\\s*:',
        flags: 'm',
        files: ['**/*.py'],
        replaceWith: 'Catch a specific exception class (e.g. `except ValueError as err:`)',
        reason: 'Bare except swallows KeyboardInterrupt and masks root causes',
        severity: 'error',
        ratcheted: true,
        fixtures: {
          bad: [{ code: 'try:\n    run()\nexcept:\n    pass', file: 'app/main.py' }],
          good: [{ code: 'try:\n    run()\nexcept ValueError:\n    raise', file: 'app/main.py' }],
        },
      },
    ],
  },
  'ast-grep': {
    name: 'ast-grep',
    description: 'Delegates deep AST structural matching to ast-grep (`sg scan`) with guarded sgconfig.yml.',
    nativeLinters: [
      {
        id: 'preset:ast-grep',
        command: 'sg',
        args: ['scan', '--error'],
        configFiles: ['sgconfig.yml'],
        reason: 'AST-level structural guardrails via ast-grep',
      },
    ],
  },
};

export function expandPresets(config: GuardrailsConfig, presetNames: readonly string[]): GuardrailsConfig {
  if (presetNames.length === 0) return config;
  const boundaryIds = new Set(config.boundaries.map((b) => b.id));
  const patternIds = new Set(config.bannedPatterns.map((p) => p.id));
  const linterIds = new Set(config.nativeLinters.map((l) => l.id));

  const boundaries = [...config.boundaries];
  const bannedPatterns = [...config.bannedPatterns];
  const nativeLinters = [...config.nativeLinters];
  let comments = config.comments;

  for (const name of presetNames) {
    if (!(name in GUARDRAIL_PRESETS)) {
      throw new Error(`Unknown guardrail preset "${name}". Available: ${PRESET_NAMES.join(', ')}`);
    }
    const preset = GUARDRAIL_PRESETS[name as PresetName];
    for (const b of preset.boundaries ?? []) {
      if (!boundaryIds.has(b.id)) {
        boundaryIds.add(b.id);
        boundaries.push(b);
      }
    }
    for (const p of preset.bannedPatterns ?? []) {
      if (!patternIds.has(p.id)) {
        patternIds.add(p.id);
        bannedPatterns.push(p);
      }
    }
    for (const l of preset.nativeLinters ?? []) {
      if (!linterIds.has(l.id)) {
        linterIds.add(l.id);
        nativeLinters.push(l);
      }
    }
    if (!comments && preset.comments) {
      comments = { ...preset.comments };
    }
  }

  return {
    ...config,
    boundaries,
    bannedPatterns,
    nativeLinters,
    ...(comments ? { comments } : {}),
  };
}

export interface FixtureTestCaseResult {
  ruleId: string;
  kind: 'boundary' | 'banned-pattern';
  ok: boolean;
  badPassed: number;
  badTotal: number;
  goodPassed: number;
  goodTotal: number;
  failures: string[];
}

export interface FixtureTestReport {
  schema: 'vgate.lint-fixtures/1';
  ok: boolean;
  rulesTested: number;
  rulesWithoutFixtures: string[];
  results: FixtureTestCaseResult[];
}

const COMMENT_DIRECTIVE_RE =
  /(\/\/|\\\/\\\/|\/\*|\\\/\\\*|@ts-(?:ignore|expect-error|nocheck)|eslint-disable|nolint|noqa|type:\s*ignore)/i;

/**
 * Verifies every guardrail rule's known-bad and known-good fixtures ("able to fail"):
 * - Every `bad` fixture MUST trigger the rule (proving the rule is not silently broken).
 * - Every `good` fixture MUST NOT trigger the rule (proving no false positive on valid code).
 */
export function testGuardrailFixtures(config: GuardrailsConfig): FixtureTestReport {
  const results: FixtureTestCaseResult[] = [];
  const rulesWithoutFixtures: string[] = [];

  for (const rule of config.boundaries) {
    if (!rule.fixtures) {
      rulesWithoutFixtures.push(rule.id);
      continue;
    }
    const failures: string[] = [];
    let badPassed = 0;
    let goodPassed = 0;
    const defaultFile = rule.from[0]?.replace(/\*\*.*$/, 'sample.ts').replace(/\*/g, 'a') ?? 'src/sample.ts';

    for (let i = 0; i < rule.fixtures.bad.length; i++) {
      const fx = rule.fixtures.bad[i];
      const file = fx.file ?? defaultFile;
      const imports = extractImports(fx.code, file);
      const hit = imports.some((imp) =>
        rule.disallowImports.some(
          (g) => matchesGlob(imp.specifier, g) || (imp.resolvedHint !== undefined && matchesGlob(imp.resolvedHint, g)),
        ),
      );
      if (hit) badPassed++;
      else failures.push(`bad[${i}] (${file}) did not trigger boundary rule "${rule.id}"`);
    }

    for (let i = 0; i < rule.fixtures.good.length; i++) {
      const fx = rule.fixtures.good[i];
      const file = fx.file ?? defaultFile;
      const imports = extractImports(fx.code, file);
      const hit = imports.some((imp) =>
        rule.disallowImports.some(
          (g) => matchesGlob(imp.specifier, g) || (imp.resolvedHint !== undefined && matchesGlob(imp.resolvedHint, g)),
        ),
      );
      if (!hit) goodPassed++;
      else failures.push(`good[${i}] (${file}) falsely triggered boundary rule "${rule.id}"`);
    }

    results.push({
      ruleId: rule.id,
      kind: 'boundary',
      ok: failures.length === 0 && rule.fixtures.bad.length > 0,
      badPassed,
      badTotal: rule.fixtures.bad.length,
      goodPassed,
      goodTotal: rule.fixtures.good.length,
      failures: rule.fixtures.bad.length === 0 ? ['missing at least one bad fixture', ...failures] : failures,
    });
  }

  for (const rule of config.bannedPatterns) {
    if (!rule.fixtures) {
      rulesWithoutFixtures.push(rule.id);
      continue;
    }
    const failures: string[] = [];
    let badPassed = 0;
    let goodPassed = 0;
    const scanRaw = COMMENT_DIRECTIVE_RE.test(rule.pattern);
    const regex = new RegExp(rule.pattern, rule.flags ?? '');

    for (let i = 0; i < rule.fixtures.bad.length; i++) {
      const fx = rule.fixtures.bad[i];
      const file = fx.file ?? 'src/sample.ts';
      const haystack = scanRaw ? fx.code : stripComments(fx.code, file);
      const match = regex.exec(haystack);
      if (match && (!fx.expectMatch || match[0].includes(fx.expectMatch))) {
        badPassed++;
      } else {
        failures.push(`bad[${i}] (${file}) did not trigger bannedPattern "${rule.id}"`);
      }
    }

    for (let i = 0; i < rule.fixtures.good.length; i++) {
      const fx = rule.fixtures.good[i];
      const file = fx.file ?? 'src/sample.ts';
      const haystack = scanRaw ? fx.code : stripComments(fx.code, file);
      if (!regex.test(haystack)) {
        goodPassed++;
      } else {
        failures.push(`good[${i}] (${file}) falsely triggered bannedPattern "${rule.id}"`);
      }
    }

    results.push({
      ruleId: rule.id,
      kind: 'banned-pattern',
      ok: failures.length === 0 && rule.fixtures.bad.length > 0,
      badPassed,
      badTotal: rule.fixtures.bad.length,
      goodPassed,
      goodTotal: rule.fixtures.good.length,
      failures: rule.fixtures.bad.length === 0 ? ['missing at least one bad fixture', ...failures] : failures,
    });
  }

  return {
    schema: 'vgate.lint-fixtures/1',
    ok: results.every((r) => r.ok),
    rulesTested: results.length,
    rulesWithoutFixtures,
    results,
  };
}

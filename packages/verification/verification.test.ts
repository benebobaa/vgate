import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, it } from 'node:test';
import {
  DEFAULT_TOLERATED_NOISE,
  SURFACES,
  buildReviewBundle,
  canCarryVerdict,
  checkRebaseCeiling,
  checkSyncDrift,
  computeSemanticPatchId,
  computeStats,
  evaluateBenchmark,
  formalGuardRule,
  loadFeatureMap,
  maintainFeatureMap,
  parseTlaStates,
  planContiguousLanding,
  renderStatechart,
  runAlternatingBenchmark,
  runCliSurface,
  runFormalChecks,
  runLibrarySurface,
} from './index.ts';
import type { BenchmarkChecklist, FormalSpecConfig, StackedPr, StateTransition } from './index.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout ?? '').trim();
}

function initGitRepo(): string {
  const repo = makeTempDir('vgate-verif-git-');
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  return repo;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('surfaces', () => {
  it('exposes generalized surface kinds', () => {
    assert.deepEqual([...SURFACES], ['api', 'web', 'cli', 'library', 'desktop', 'mobile']);
  });

  it('runCliSurface verifies exit code, stdout/stderr regex, stdin, env, and partial JSON matching', () => {
    const cwd = makeTempDir('vgate-cli-surface-');
    const report = runCliSurface(
      [
        {
          id: 'cli-json',
          title: 'prints JSON payload with env and stdin',
          command: process.execPath,
          args: [
            '-e',
            'const fs=require("node:fs"); const inp=fs.readFileSync(0,"utf8").trim(); console.log(JSON.stringify({ ok: true, mode: process.env.VGATE_MODE, input: inp, meta: { version: 2, extra: "ignored" }, tags: ["a", "b"] })); console.error("warn: ready");',
          ],
          stdin: 'hello-world',
          env: { VGATE_MODE: 'strict' },
          expectExitCode: 0,
          expectStdout: '"ok":true',
          expectStderr: 'warn: ready',
          expectJson: {
            ok: true,
            mode: 'strict',
            input: 'hello-world',
            meta: { version: 2 },
            tags: ['a', 'b'],
          },
        },
        {
          id: 'cli-nonzero',
          title: 'accepts expected non-zero exit code',
          command: process.execPath,
          args: ['-e', 'console.error("bad flag"); process.exit(2);'],
          expectExitCode: 2,
          expectStderr: 'bad flag',
        },
      ],
      cwd,
    );

    assert.equal(report.schema, 'vgate.surface/1');
    assert.equal(report.surface, 'cli');
    assert.equal(report.ok, true);
    assert.equal(report.passed, 2);
    assert.equal(report.failed, 0);
  });

  it('runCliSurface reports exit code, regex, JSON mismatch, and spawn failures', () => {
    const cwd = makeTempDir('vgate-cli-fail-');
    const report = runCliSurface(
      [
        {
          id: 'bad-exit',
          title: 'wrong exit code',
          command: process.execPath,
          args: ['-e', 'process.exit(1)'],
          expectExitCode: 0,
        },
        {
          id: 'bad-json',
          title: 'partial JSON mismatch',
          command: process.execPath,
          args: ['-e', 'console.log(JSON.stringify({ status: "degraded" }))'],
          expectJson: { status: 'healthy' },
        },
        {
          id: 'missing-bin',
          title: 'nonexistent command',
          command: 'definitely-nonexistent-binary-vgate-xyz',
        },
      ],
      cwd,
    );

    assert.equal(report.ok, false);
    assert.equal(report.passed, 0);
    assert.equal(report.failed, 3);
    assert.match(report.checks[0]?.detail ?? '', /exit code 1/);
    assert.match(report.checks[1]?.detail ?? '', /expectJson mismatch/);
    assert.match(report.checks[2]?.detail ?? '', /spawn error/);
  });

  it('runLibrarySurface passes and fails based on library test command', () => {
    const cwd = makeTempDir('vgate-lib-surface-');
    const passReport = runLibrarySurface(
      { testCommand: process.execPath, args: ['-e', 'console.log("all 12 unit tests passed")'] },
      cwd,
    );
    assert.equal(passReport.surface, 'library');
    assert.equal(passReport.ok, true);
    assert.equal(passReport.passed, 1);

    const failReport = runLibrarySurface(
      { testCommand: process.execPath, args: ['-e', 'console.error("assertion failed"); process.exit(1)'] },
      cwd,
    );
    assert.equal(failReport.ok, false);
    assert.equal(failReport.failed, 1);
    assert.match(failReport.checks[0]?.detail ?? '', /assertion failed/);
  });
});

describe('feature-map', () => {
  function setupFeatureFixture(): { projectRoot: string; serviceDir: string; srcFile: string } {
    const projectRoot = makeTempDir('vgate-fmap-');
    const serviceDir = path.join(projectRoot, 'services', 'checkout');
    const featuresDir = path.join(serviceDir, 'features');
    const srcDir = path.join(projectRoot, 'src');
    mkdirSync(featuresDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(path.join(featuresDir, 'README.md'), '# Checkout Feature Map\n');
    const srcFile = path.join(srcDir, 'checkout.tsx');
    writeFileSync(
      srcFile,
      `
      export function Checkout() {
        fetch('/api/orders', { method: 'POST' });
        return <button data-testid="pay-btn" aria-label="Pay now">Pay</button>;
      }
      `,
    );
    writeFileSync(
      path.join(featuresDir, 'pay.yaml'),
      `
id: checkout-pay
name: Checkout payment submission
route: /checkout
selectors:
  - '[data-testid="pay-btn"]'
  - '[aria-label="Pay now"]'
endpoints:
  - 'POST /api/orders'
scenarios:
  - PAY-200
  - PAY-402
preconditions:
  - User has at least one item in cart
sourceFiles:
  - src/checkout.tsx
steps:
  - action: Click pay button
    expect: Order is created
`,
    );
    return { projectRoot, serviceDir, srcFile };
  }

  it('classifies clean when index, features, selectors, endpoints, and inventory align', () => {
    const { projectRoot, serviceDir } = setupFeatureFixture();
    const loaded = loadFeatureMap(serviceDir);
    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.features.length, 1);
    assert.ok(loaded.indexFile?.endsWith('README.md'));

    const report = maintainFeatureMap({
      projectRoot,
      serviceDir,
      serviceName: 'checkout',
      inventoryScenarios: ['PAY-200', 'PAY-402'],
    });
    assert.equal(report.schema, 'vgate.maintain/1');
    assert.equal(report.outcome, 'clean');
    assert.equal(report.featuresChecked, 1);
    assert.equal(report.drifted.length, 0);
    assert.deepEqual(report.unmappedScenarios, []);
    assert.deepEqual(report.orphanedScenarios, []);
    assert.equal(report.productCodeTouched, false);
  });

  it('classifies changed on selector/endpoint/source drift and unmapped/orphaned scenarios without touching code', () => {
    const { projectRoot, serviceDir, srcFile } = setupFeatureFixture();
    const updatedCode = 'export function Checkout() { return <button data-testid="submit-order">Pay</button>; }\n';
    writeFileSync(srcFile, updatedCode);

    const report = maintainFeatureMap({
      projectRoot,
      serviceDir,
      serviceName: 'checkout',
      inventoryScenarios: ['PAY-200', 'PAY-REFUND'],
    });

    assert.equal(report.outcome, 'changed');
    assert.equal(report.productCodeTouched, false);
    assert.ok(report.drifted.some((d) => d.reason.includes('pay-btn')));
    assert.ok(report.drifted.some((d) => d.reason.includes('/api/orders')));
    assert.deepEqual(report.unmappedScenarios, ['PAY-REFUND']);
    assert.deepEqual(report.orphanedScenarios, ['PAY-402']);
    // Strictly read-only: product source file must remain byte-for-byte identical
    assert.equal(readFileSync(srcFile, 'utf8'), updatedCode);
  });

  it('classifies blocked when README index is missing, YAML is invalid, or file precondition is broken', () => {
    const { projectRoot, serviceDir } = setupFeatureFixture();
    rmSync(path.join(serviceDir, 'features', 'README.md'));

    const missingIndex = maintainFeatureMap({
      projectRoot,
      serviceDir,
      serviceName: 'checkout',
      inventoryScenarios: ['PAY-200', 'PAY-402'],
    });
    assert.equal(missingIndex.outcome, 'blocked');

    // Restore index, introduce broken file precondition
    writeFileSync(path.join(serviceDir, 'features', 'README.md'), '# Restored\n');
    writeFileSync(
      path.join(serviceDir, 'features', 'pay.yaml'),
      `
id: checkout-pay
name: Checkout payment submission
scenarios: [PAY-200]
preconditions:
  - 'file:fixtures/missing-seed.sql'
sourceFiles: [src/checkout.tsx]
steps:
  - action: Submit
    expect: Succeeds
`,
    );
    const brokenPre = maintainFeatureMap({
      projectRoot,
      serviceDir,
      serviceName: 'checkout',
      inventoryScenarios: ['PAY-200'],
    });
    assert.equal(brokenPre.outcome, 'blocked');
    assert.ok(brokenPre.drifted.some((d) => d.reason.includes('Broken precondition')));

    // Invalid YAML syntax also classifies as blocked
    writeFileSync(path.join(serviceDir, 'features', 'pay.yaml'), 'id: [unclosed\n');
    const invalidYaml = maintainFeatureMap({
      projectRoot,
      serviceDir,
      serviceName: 'checkout',
      inventoryScenarios: ['PAY-200'],
    });
    assert.equal(invalidYaml.outcome, 'blocked');
  });
});

describe('formal verification & statechart', () => {
  it('tracks sync-commit drift across committed and uncommitted covered files', () => {
    const repo = initGitRepo();
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'ledger.ts'), 'export const balance = 100;\n');
    writeFileSync(path.join(repo, 'README.md'), '# Ledger\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial']);
    const syncCommit = git(repo, ['rev-parse', 'HEAD']);

    const spec: FormalSpecConfig = {
      id: 'ledger-tla',
      engine: 'tla+',
      specFile: 'specs/Ledger.tla',
      coveredFiles: ['src/ledger.ts'],
      syncCommit,
      invariant: 'NoNegativeBalance',
    };

    // Clean right at syncCommit
    const clean = checkSyncDrift(repo, spec);
    assert.equal(clean.stale, false);
    assert.deepEqual(clean.staleFiles, []);
    assert.equal(clean.headCommit, syncCommit);

    // Non-covered file change stays clean
    writeFileSync(path.join(repo, 'README.md'), '# Ledger updated\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'docs update']);
    assert.equal(checkSyncDrift(repo, spec).stale, false);

    // Uncommitted edit to covered file triggers stale
    writeFileSync(path.join(repo, 'src', 'ledger.ts'), 'export const balance = -5;\n');
    const uncommitted = checkSyncDrift(repo, spec);
    assert.equal(uncommitted.stale, true);
    assert.deepEqual(uncommitted.staleFiles, ['src/ledger.ts']);

    // Committed edit to covered file triggers stale against syncCommit
    git(repo, ['add', 'src/ledger.ts']);
    git(repo, ['commit', '-m', 'modify ledger']);
    const committed = checkSyncDrift(repo, spec);
    assert.equal(committed.stale, true);
    assert.deepEqual(committed.staleFiles, ['src/ledger.ts']);
  });

  it('proves scratch mutations, flags vacuous specs, and always restores file bytes even on error', () => {
    const dir = makeTempDir('vgate-formal-mut-');
    const specPath = path.join(dir, 'Ledger.tla');
    const originalSpec = 'Next == balance >= 0 /\\ state\' = "Settled"\n';
    writeFileSync(specPath, originalSpec);

    const spec: FormalSpecConfig = {
      id: 'ledger-spec',
      engine: 'tla+',
      specFile: 'Ledger.tla',
      coveredFiles: ['src/ledger.ts'],
      scratchMutation: {
        file: 'Ledger.tla',
        find: 'balance >= 0',
        replace: 'balance >= -100',
      },
    };

    // 1. Valid formal check: passes unmodified, fails on mutated file -> mutationProven: true
    const provenReport = runFormalChecks(dir, [spec], {
      verifyMutation: true,
      executor: () => {
        const content = readFileSync(specPath, 'utf8');
        return content.includes('balance >= -100')
          ? { ok: false, output: 'Invariant NoNegativeBalance violated' }
          : { ok: true, output: 'Model checking completed. No error.' };
      },
    });
    assert.equal(provenReport.ok, true);
    assert.equal(provenReport.results[0]?.mutationProven, true);
    assert.equal(readFileSync(specPath, 'utf8'), originalSpec);

    // 2. Vacuous check: passes even when mutated -> flagged as failure, file still restored
    const vacuousReport = runFormalChecks(dir, [spec], {
      verifyMutation: true,
      executor: () => ({ ok: true, output: 'always green' }),
    });
    assert.equal(vacuousReport.ok, false);
    assert.equal(vacuousReport.results[0]?.mutationProven, false);
    assert.match(vacuousReport.results[0]?.detail ?? '', /vacuous/i);
    assert.equal(readFileSync(specPath, 'utf8'), originalSpec);

    // 3. Throwing executor during mutation: file MUST still be restored in finally
    let calls = 0;
    const errorReport = runFormalChecks(dir, [spec], {
      verifyMutation: true,
      executor: () => {
        calls++;
        if (calls === 2) {
          assert.ok(readFileSync(specPath, 'utf8').includes('balance >= -100'));
          throw new Error('tlc crashed unexpectedly');
        }
        return { ok: true, output: 'ok' };
      },
    });
    assert.equal(errorReport.ok, false);
    assert.equal(errorReport.results[0]?.mutationProven, false);
    assert.equal(readFileSync(specPath, 'utf8'), originalSpec);
  });

  it('formalGuardRule flags removed specs, coveredFiles, and invariants', () => {
    const base: FormalSpecConfig[] = [
      {
        id: 'auth-fsm',
        engine: 'tla+',
        specFile: 'specs/Auth.tla',
        coveredFiles: ['src/auth.ts', 'src/session.ts'],
        invariant: 'NoExpiredSession',
      },
      {
        id: 'billing-lean',
        engine: 'lean',
        specFile: 'specs/Billing.lean',
        coveredFiles: ['src/billing.ts'],
      },
    ];
    const head: FormalSpecConfig[] = [
      {
        id: 'auth-fsm',
        engine: 'tla+',
        specFile: 'specs/Auth.tla',
        coveredFiles: ['src/auth.ts'],
      },
    ];

    const guard = formalGuardRule('vgate.yaml', base, head);
    assert.equal(guard.findings.length, 3);
    assert.ok(guard.findings.every((f) => f.rule === 'formal-weakened'));
    assert.ok(guard.findings.some((f) => f.detail.includes('billing-lean')));
    assert.ok(guard.findings.some((f) => f.detail.includes('src/session.ts')));
    assert.ok(guard.findings.some((f) => f.detail.includes('NoExpiredSession')));
  });

  it('parses TLA+ states/invariants and renders Mermaid statechart with truncation and classDef', () => {
    const tla = `
---- MODULE Order ----
Init == state = "Pending"

Approve ==
  /\\ state = "Pending"
  /\\ state' = "Approved"

Cancel ==
  /\\ state \\in {"Pending", "Approved"}
  /\\ state' = "Cancelled" \\* mayBreak

DoubleCharge ==
  /\\ state = "Approved"
  /\\ state' = "Corrupted" \\* breaks

Next == Approve \\/ Cancel \\/ DoubleCharge

TypeOK == state \\in {"Pending", "Approved", "Cancelled", "Corrupted"}
SafetyInvariant == state /= "Corrupted"
====
`;
    const parsed = parseTlaStates(tla);
    assert.deepEqual(parsed.states, ['Pending', 'Approved', 'Cancelled', 'Corrupted']);
    assert.equal(parsed.transitions.length, 4);
    assert.ok(parsed.invariants.includes('TypeOK'));
    assert.ok(parsed.invariants.includes('SafetyInvariant'));

    const chart = renderStatechart({ title: 'Order Lifecycle', transitions: parsed.transitions });
    assert.equal(chart.truncated, false);
    assert.equal(chart.stateCount, 4);
    assert.equal(chart.arrowCount, 4);
    assert.match(chart.mermaid, /^stateDiagram-v2/);
    assert.match(chart.mermaid, /classDef breaks/);
    assert.match(chart.mermaid, /class Corrupted breaks/);
    assert.match(chart.mermaid, /classDef mayBreak/);
    assert.match(chart.mermaid, /class Cancelled mayBreak/);

    // Truncation test (> maxArrows)
    const manyTransitions: StateTransition[] = Array.from({ length: 25 }, (_, i) => ({
      from: `S${i}`,
      to: `S${i + 1}`,
      action: `Step${i}`,
    }));
    const capped = renderStatechart({ transitions: manyTransitions, maxArrows: 20, maxStates: 500 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.arrowCount, 20);
    assert.match(capped.mermaid, /Truncated/);
  });
});

describe('benchmark measurement rigor', () => {
  const fullChecklist: BenchmarkChecklist = {
    limiter: 'CPU JSON serialization',
    productionTuned: true,
    withinPhysicalLimits: true,
    zeroErrors: true,
    alternatingReproducible: true,
    endToEndUserPath: true,
    insideTimedRegion: true,
  };

  it('computes accurate median, min, max, and p95', () => {
    const stats = computeStats([120, 100, 110, 130, 105], 0);
    assert.equal(stats.minMs, 100);
    assert.equal(stats.maxMs, 130);
    assert.equal(stats.medianMs, 110);
    assert.equal(stats.p95Ms, 130);

    const evenStats = computeStats([10, 20, 30, 40], 1);
    assert.equal(evenStats.medianMs, 25);
    assert.equal(evenStats.errors, 1);
  });

  it('defaults to inconclusive on blank limiter, missing checklist item, errors, or heavy range overlap', () => {
    const base = computeStats([100, 102, 104], 0);
    const cand = computeStats([70, 72, 74], 0);

    // Blank limiter
    const blankLimiter = evaluateBenchmark(base, cand, { ...fullChecklist, limiter: '   ' });
    assert.equal(blankLimiter.verdict, 'inconclusive');
    assert.deepEqual(blankLimiter.missingChecks, ['limiter']);

    // Missing any boolean check
    const missingEndToEnd = evaluateBenchmark(base, cand, { ...fullChecklist, endToEndUserPath: false });
    assert.equal(missingEndToEnd.verdict, 'inconclusive');
    assert.deepEqual(missingEndToEnd.missingChecks, ['endToEndUserPath']);

    // Non-zero errors
    const withErrors = evaluateBenchmark(base, computeStats([70, 72, 74], 1), fullChecklist);
    assert.equal(withErrors.verdict, 'inconclusive');

    // Heavy range overlap despite 25% median gap
    const noisyBase = computeStats([50, 100, 160], 0);
    const noisyCand = computeStats([55, 75, 155], 0);
    const overlapping = evaluateBenchmark(noisyBase, noisyCand, fullChecklist);
    assert.equal(overlapping.verdict, 'inconclusive');
  });

  it('classifies faster, slower, and no-difference when all 7 checklist items pass', () => {
    const base = computeStats([100, 102, 104], 0);
    const fast = computeStats([70, 72, 74], 0);
    const slow = computeStats([130, 132, 134], 0);
    const same = computeStats([101, 102, 103], 0);

    const fasterReport = evaluateBenchmark(base, fast, fullChecklist);
    assert.equal(fasterReport.verdict, 'faster');
    assert.ok((fasterReport.speedupPct ?? 0) > 25);

    const slowerReport = evaluateBenchmark(base, slow, fullChecklist);
    assert.equal(slowerReport.verdict, 'slower');
    assert.ok((slowerReport.speedupPct ?? 0) < -25);

    const sameReport = evaluateBenchmark(base, same, fullChecklist);
    assert.equal(sameReport.verdict, 'no-difference');
  });

  it('runAlternatingBenchmark runs alternating A-B trials', () => {
    const cwd = makeTempDir('vgate-bench-');
    const report = runAlternatingBenchmark({
      baselineCmd: [process.execPath, ['-e', '']],
      candidateCmd: [process.execPath, ['-e', '']],
      runs: 3,
      cwd,
      checklist: fullChecklist,
    });

    assert.equal(report.schema, 'vgate.benchmark/1');
    assert.equal(report.baseline.samplesMs.length, 3);
    assert.equal(report.candidate.samplesMs.length, 3);
    assert.equal(report.baseline.errors, 0);
    assert.equal(report.candidate.errors, 0);
  });
});

describe('patch-id & high-velocity merge mechanics', () => {
  it('produces identical semantic patchId across a real git rebase and filters tolerated noise', () => {
    assert.ok(DEFAULT_TOLERATED_NOISE.includes('docs/**/*.md'));
    assert.ok(DEFAULT_TOLERATED_NOISE.includes('README.md'));
    assert.equal((DEFAULT_TOLERATED_NOISE as readonly string[]).includes('**/*.md'), false);
    assert.equal((DEFAULT_TOLERATED_NOISE as readonly string[]).includes('.prettierrc*'), false);

    const repo = initGitRepo();
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
    writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const version = 1;\n');
    writeFileSync(path.join(repo, 'README.md'), '# Repo\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'base']);
    const baseMain = git(repo, ['rev-parse', 'HEAD']);

    // Feature branch modifies src/math.ts + docs/guide.md + docs/notes.txt (noise)
    git(repo, ['checkout', '-b', 'feat/mul']);
    writeFileSync(
      path.join(repo, 'src', 'math.ts'),
      'export const add = (a: number, b: number) => a + b;\nexport const mul = (a: number, b: number) => a * b;\n',
    );
    writeFileSync(path.join(repo, 'docs', 'guide.md'), '# Guide\n');
    writeFileSync(path.join(repo, 'docs', 'notes.txt'), 'release note\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'add mul']);

    const beforeRebase = computeSemanticPatchId(repo, baseMain, 'HEAD');
    assert.ok(beforeRebase.patchId !== null);
    assert.deepEqual(beforeRebase.codeFiles, ['src/math.ts']);
    assert.deepEqual(beforeRebase.ignoredNoiseFiles.sort(), ['docs/guide.md', 'docs/notes.txt']);

    // Advance main independently
    git(repo, ['checkout', 'main']);
    writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const version = 2;\n');
    git(repo, ['add', 'src/other.ts']);
    git(repo, ['commit', '-m', 'advance main']);
    const newMain = git(repo, ['rev-parse', 'HEAD']);

    // Rebase feature branch onto newMain
    git(repo, ['checkout', 'feat/mul']);
    git(repo, ['rebase', 'main']);

    const afterRebase = computeSemanticPatchId(repo, newMain, 'HEAD');
    assert.equal(afterRebase.patchId, beforeRebase.patchId);
    assert.deepEqual(afterRebase.codeFiles, ['src/math.ts']);

    // Adding another markdown noise commit keeps the exact same semantic patchId
    writeFileSync(path.join(repo, 'README.md'), '# Repo updated docs\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'docs tweak']);
    const withMoreNoise = computeSemanticPatchId(repo, newMain, 'HEAD');
    assert.equal(withMoreNoise.patchId, beforeRebase.patchId);
    assert.ok(withMoreNoise.ignoredNoiseFiles.includes('README.md'));

    // Changing actual code changes patchId
    writeFileSync(
      path.join(repo, 'src', 'math.ts'),
      'export const add = (a: number, b: number) => a + b;\nexport const mul = (a: number, b: number) => a * b * 1;\n',
    );
    git(repo, ['add', 'src/math.ts']);
    git(repo, ['commit', '-m', 'change code']);
    const afterCodeEdit = computeSemanticPatchId(repo, newMain, 'HEAD');
    assert.notEqual(afterCodeEdit.patchId, beforeRebase.patchId);
  });

  it('canCarryVerdict enforces matching patchId and build outputs', () => {
    const id = 'abc123def4567890';
    assert.equal(canCarryVerdict({ patchId: id, hasBuildOutputs: true }, { patchId: id }).carry, true);
    assert.equal(canCarryVerdict({ patchId: id }, { patchId: id }).carry, true);
    assert.equal(canCarryVerdict({ patchId: id, hasBuildOutputs: false }, { patchId: id }).carry, false);
    assert.equal(canCarryVerdict({ patchId: id, hasBuildOutputs: true }, { patchId: 'different' }).carry, false);
    assert.equal(canCarryVerdict({ patchId: null, hasBuildOutputs: true }, { patchId: id }).carry, false);
  });

  it('checkRebaseCeiling enforces default 3-rebase ceiling', () => {
    assert.equal(checkRebaseCeiling(0).action, 'proceed');
    assert.equal(checkRebaseCeiling(2).ok, true);
    const hit = checkRebaseCeiling(3);
    assert.equal(hit.ok, false);
    assert.equal(hit.action, 'halt-and-sequence');
    assert.equal(hit.ceiling, 3);
    assert.equal(checkRebaseCeiling(5, 5).action, 'halt-and-sequence');
  });

  it('planContiguousLanding walks bottom-up and stops at the first unverified or non-green ceiling PR', () => {
    const stack: StackedPr[] = [
      { number: 101, branch: 'stack/1', verified: true, ciGreen: true, merged: true },
      { number: 102, branch: 'stack/2', verified: true, ciGreen: true, merged: false },
      { number: 103, branch: 'stack/3', verified: true, ciGreen: true, merged: false },
      { number: 104, branch: 'stack/4', verified: false, ciGreen: true, merged: false },
      { number: 105, branch: 'stack/5', verified: true, ciGreen: true, merged: false },
    ];

    const plan = planContiguousLanding(stack);
    assert.deepEqual(
      plan.alreadyMerged.map((p) => p.number),
      [101],
    );
    assert.deepEqual(
      plan.landable.map((p) => p.number),
      [102, 103],
    );
    assert.equal(plan.ceilingPr?.number, 104);
    assert.match(plan.blockedReason ?? '', /#104/);
    assert.match(plan.blockedReason ?? '', /not verified/);

    // Stack where everything remaining is landable
    const allGreen = planContiguousLanding(stack.slice(0, 3));
    assert.equal(allGreen.ceilingPr, undefined);
    assert.deepEqual(
      allGreen.landable.map((p) => p.number),
      [102, 103],
    );
  });
});

describe('artifact-first review bundle', () => {
  it('discovers screenshots, videos, traces, statecharts, benchmarks, coverage, verdicts, and extras', () => {
    const reportsDir = makeTempDir('vgate-artifacts-');
    mkdirSync(path.join(reportsDir, 'playwright'), { recursive: true });
    mkdirSync(path.join(reportsDir, 'coverage'), { recursive: true });

    writeFileSync(path.join(reportsDir, 'playwright', 'checkout-desktop.png'), 'fake-png');
    writeFileSync(path.join(reportsDir, 'playwright', 'checkout.webm'), 'fake-webm');
    writeFileSync(path.join(reportsDir, 'playwright', 'trace.zip'), 'fake-zip');
    writeFileSync(path.join(reportsDir, 'order.mmd'), 'stateDiagram-v2\n  Pending --> Paid: Pay\n');
    writeFileSync(
      path.join(reportsDir, 'benchmark.json'),
      JSON.stringify({ verdict: 'faster', speedupPct: 24.5, summary: '[faster] Candidate is 24.5% faster' }),
    );
    writeFileSync(path.join(reportsDir, 'verdict.json'), JSON.stringify({ verdict: 'pass' }));
    writeFileSync(path.join(reportsDir, 'guard.json'), JSON.stringify({ findings: [] }));
    writeFileSync(path.join(reportsDir, 'verifier-receipt.json'), JSON.stringify({ ok: true }));
    writeFileSync(
      path.join(reportsDir, 'coverage', 'coverage-summary.json'),
      JSON.stringify({ total: { lines: { pct: 94.2 } } }),
    );

    const bundle = buildReviewBundle(reportsDir, [
      { kind: 'verdict', label: 'Extra summary', inlineMarkdown: 'All gates green.' },
    ]);

    assert.equal(bundle.schema, 'vgate.review-bundle/1');
    assert.equal(bundle.artifacts.length, 10);
    assert.match(bundle.markdown, /# Verification Review Bundle/);
    assert.match(bundle.markdown, /## Screenshots/);
    assert.match(bundle.markdown, /Screenshot: playwright\/checkout-desktop\.png/);
    assert.match(bundle.markdown, /```mermaid/);
    assert.match(bundle.markdown, /Candidate is 24\.5% faster/);
    assert.match(bundle.markdown, /94\.2%/);
    assert.match(bundle.markdown, /All gates green\./);

    // Nonexistent reportsDir degrades gracefully
    const emptyBundle = buildReviewBundle(path.join(reportsDir, 'does-not-exist'));
    assert.equal(emptyBundle.artifacts.length, 0);
    assert.match(emptyBundle.markdown, /No verification artifacts discovered/);
  });
});

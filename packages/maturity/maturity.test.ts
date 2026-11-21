import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readProject } from '../../framework/project.ts';
import { enforceMaturityGate, evaluateMaturity, inspectProjectMaturity, type MaturityInputs } from './index.ts';

function baseInputs(overrides: Partial<MaturityInputs> = {}): MaturityInputs {
  return {
    projectRoot: '/tmp/project',
    hasGuardrails: false,
    guardrailsRuleCount: 0,
    hasRuleTable: false,
    serviceCount: 0,
    hasFeatureMapOrVerifySkill: false,
    hasPassingVerdict: false,
    ratchetGrowing: false,
    hasMutationOrFormalProof: false,
    hasDistinctVerifierRole: false,
    hasEvalOrVerifierEvidence: false,
    revertRate: null,
    hasIrreversibleRiskRules: false,
    hasFactoryBudgetsAndStop: false,
    ...overrides,
  };
}

describe('5-Phase Maturity Engine', () => {
  it('progresses cleanly from Level 0 through Level 5', () => {
    const l0 = evaluateMaturity(baseInputs());
    assert.equal(l0.schema, 'vgate.maturity/1');
    assert.equal(l0.level, 0);
    assert.equal(l0.nextPhaseBlockers.length, 2);

    const l1 = evaluateMaturity(
      baseInputs({
        hasGuardrails: true,
        guardrailsRuleCount: 3,
        hasRuleTable: true,
      }),
    );
    assert.equal(l1.level, 1);
    assert.equal(l1.phases[0]?.met, true);
    assert.equal(l1.phases[1]?.met, false);
    assert.equal(l1.nextPhaseBlockers.length, 3);

    const l2 = evaluateMaturity(
      baseInputs({
        hasGuardrails: true,
        guardrailsRuleCount: 3,
        hasRuleTable: true,
        serviceCount: 2,
        hasFeatureMapOrVerifySkill: true,
        hasPassingVerdict: true,
      }),
    );
    assert.equal(l2.level, 2);

    const l3 = evaluateMaturity(
      baseInputs({
        hasGuardrails: true,
        guardrailsRuleCount: 3,
        hasRuleTable: true,
        serviceCount: 2,
        hasFeatureMapOrVerifySkill: true,
        hasPassingVerdict: true,
        ratchetGrowing: true,
        hasMutationOrFormalProof: true,
      }),
    );
    assert.equal(l3.level, 3);

    const l4 = evaluateMaturity(
      baseInputs({
        hasGuardrails: true,
        guardrailsRuleCount: 3,
        hasRuleTable: true,
        serviceCount: 2,
        hasFeatureMapOrVerifySkill: true,
        hasPassingVerdict: true,
        ratchetGrowing: true,
        hasMutationOrFormalProof: true,
        hasDistinctVerifierRole: true,
        hasEvalOrVerifierEvidence: true,
        revertRate: 0.02,
      }),
    );
    assert.equal(l4.level, 4);

    const l5 = evaluateMaturity(
      baseInputs({
        hasGuardrails: true,
        guardrailsRuleCount: 3,
        hasRuleTable: true,
        serviceCount: 2,
        hasFeatureMapOrVerifySkill: true,
        hasPassingVerdict: true,
        ratchetGrowing: true,
        hasMutationOrFormalProof: true,
        hasDistinctVerifierRole: true,
        hasEvalOrVerifierEvidence: true,
        revertRate: 0.0,
        hasIrreversibleRiskRules: true,
        hasFactoryBudgetsAndStop: true,
      }),
    );
    assert.equal(l5.level, 5);
    assert.deepEqual(l5.nextPhaseBlockers, []);
  });

  it('enforces contiguous level gating (Phase 3 met without Phase 2 stays at Level 1)', () => {
    const report = evaluateMaturity(
      baseInputs({
        hasGuardrails: true,
        guardrailsRuleCount: 2,
        hasRuleTable: true,
        // Phase 2 missing
        serviceCount: 0,
        hasFeatureMapOrVerifySkill: false,
        hasPassingVerdict: false,
        // Phase 3 met
        ratchetGrowing: true,
        hasMutationOrFormalProof: true,
      }),
    );

    assert.equal(report.phases[0]?.met, true);
    assert.equal(report.phases[1]?.met, false);
    assert.equal(report.phases[2]?.met, true);
    assert.equal(report.level, 1);
    assert.ok(report.nextPhaseBlockers.length > 0);
  });

  it('keeps Phases 1-3 advisory, blocks Phases 4-5 without out-of-band VGATE_ALLOW_AUTONOMY', () => {
    const blockedReport = evaluateMaturity(
      baseInputs({
        hasGuardrails: true,
        guardrailsRuleCount: 1,
        hasRuleTable: true,
      }),
    );

    const gatePass = enforceMaturityGate(blockedReport, 1);
    assert.equal(gatePass.allowed, true);
    assert.equal(gatePass.overridden, false);
    assert.deepEqual(gatePass.blockers, []);

    // Phases 1-3 are advisory readiness guides
    const gateAdvisory = enforceMaturityGate(blockedReport, 3);
    assert.equal(gateAdvisory.allowed, true);
    assert.equal(gateAdvisory.advisory, true);
    assert.ok(gateAdvisory.blockers.length >= 5);

    // Phase 4/5 autonomy enforces the seatbelt unless overridden out-of-band
    const gateBlocked = enforceMaturityGate(blockedReport, 4);
    assert.equal(gateBlocked.allowed, false);
    assert.equal(gateBlocked.overridden, false);
    assert.equal(gateBlocked.advisory, false);
    assert.ok(gateBlocked.blockers.length >= 5);

    const overrideReport = evaluateMaturity(
      baseInputs({
        hasGuardrails: true,
        guardrailsRuleCount: 1,
        hasRuleTable: true,
        allowSkipGates: true,
      }),
    );
    const gateOverridden = enforceMaturityGate(overrideReport, 4);
    assert.equal(gateOverridden.allowed, true);
    assert.equal(gateOverridden.overridden, true);
    assert.ok(gateOverridden.blockers.length > 0);
  });

  it('auto-discovers real project files on disk up to Level 5', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'vgate-maturity-'));
    try {
      // Empty project -> Level 0
      assert.equal(inspectProjectMaturity(tmp).level, 0);

      // Phase 1: guardrails.yaml + AGENTS.md with rule table
      writeFileSync(join(tmp, 'guardrails.yaml'), 'rules:\n  - id: no-raw-sql\n  - id: no-secrets\n', 'utf8');
      writeFileSync(
        join(tmp, 'AGENTS.md'),
        '# Rules\n\n| Rule | Enforcement |\n| --- | --- |\n| No raw SQL | guardrails.yaml |\n',
        'utf8',
      );
      assert.equal(inspectProjectMaturity(tmp).level, 1);

      // Phase 2: service + verify skill + strict passing verdict (fake/incomplete verdict rejected)
      mkdirSync(join(tmp, 'services', 'orders'), { recursive: true });
      mkdirSync(join(tmp, '.agents', 'skills', 'verify-orders'), { recursive: true });
      mkdirSync(join(tmp, 'reports', 'orders'), { recursive: true });
      writeFileSync(join(tmp, 'reports', 'orders', 'verdict.json'), JSON.stringify({ verdict: 'pass' }), 'utf8');
      assert.equal(inspectProjectMaturity(tmp).level, 1);
      writeFileSync(
        join(tmp, 'reports', 'orders', 'verdict.json'),
        JSON.stringify({
          schema: 'vgate.verdict/1',
          complete: true,
          verdict: 'pass',
          coverage: { covered: 12, demanded: 10 },
        }),
        'utf8',
      );
      assert.equal(inspectProjectMaturity(tmp).level, 2);

      // Phase 3: real non-empty ratchet ledger + strict passing mutation.json
      writeFileSync(
        join(tmp, '.vgate-ratchet.json'),
        JSON.stringify({ schema: 'vgate.ratchet/1', counts: { 'no-raw-sql': { 'src/a.ts': 1 } } }),
        'utf8',
      );
      writeFileSync(
        join(tmp, 'reports', 'mutation.json'),
        JSON.stringify({ schema: 'vgate.mutation/1', verdict: 'pass', score: 0.85 }),
        'utf8',
      );
      assert.equal(inspectProjectMaturity(tmp).level, 3);

      // Phase 4: distinct verifier role + strict verifier.json (non-empty lane) + healthy .vgate/metrics.jsonl
      writeFileSync(
        join(tmp, 'vgate.yaml'),
        [
          'version: 0.1.0',
          'servicesDir: services',
          'roles:',
          '  author:',
          '    harness: claude-code',
          '    model: claude-sonnet-4-6',
          '  verifier:',
          '    harness: codex',
          '    model: gpt-5',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        join(tmp, 'reports', 'verifier.json'),
        JSON.stringify({
          schema: 'vgate.verifier/1',
          verdict: 'PASS',
          mode: 'single',
          lanes: [{ lane: 'live-app-proof', harness: 'codex', family: 'openai', verdict: 'PASS' }],
        }),
        'utf8',
      );
      mkdirSync(join(tmp, '.vgate'), { recursive: true });
      const metricLines = Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({ timestamp: '2026-11-20T00:00:00Z', kind: 'pr-merged', pr: `#${i + 1}` }),
      );
      writeFileSync(join(tmp, '.vgate', 'metrics.jsonl'), `${metricLines.join('\n')}\n`, 'utf8');
      assert.equal(inspectProjectMaturity(tmp).level, 4);

      // Phase 5: high/irreversible risk rules + factory budgets (must ALSO parse under strict readProject!)
      writeFileSync(
        join(tmp, 'vgate.yaml'),
        [
          'version: 0.1.0',
          'servicesDir: services',
          'roles:',
          '  author:',
          '    harness: claude-code',
          '    model: claude-sonnet-4-6',
          '  verifier:',
          '    harness: codex',
          '    model: gpt-5',
          'risk:',
          '  high:',
          '    - path: "migrations/**"',
          '      reason: "irreversible schema migration"',
          'budgets:',
          '  maxUsdPerPr: 10',
          '  maxDailyUsd: 100',
          '  routineZeroFixPauseUsd: 5',
          'factory:',
          '  sandbox: docker',
          '  defaultDenyEgress: true',
        ].join('\n'),
        'utf8',
      );
      assert.equal(readProject(tmp).version, '0.1.0');
      const full = inspectProjectMaturity(tmp);
      assert.equal(full.level, 5);
      assert.deepEqual(full.nextPhaseBlockers, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

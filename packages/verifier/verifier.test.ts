import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  METRICS_FILE,
  ROLES,
  appendKpiEvent,
  auditRoutines,
  buildVerifierPrompt,
  canEscalate,
  checkBudget,
  inferFamily,
  judgeVerifierReport,
  parseRolesConfig,
  parseVerifierOutput,
  readKpiEvents,
  renderMetricsHtml,
  renderPrometheusMetrics,
  runVerifierSwarm,
  selectVerifierMode,
  summarizeKpis,
  validateSeparationOfPowers,
  type KpiEvent,
  type RoutineRunRecord,
  type SwarmAgentExecutor,
  type VerifierReport,
} from './index.ts';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('roles & separation of powers', () => {
  it('exports all canonical roles and infers model/harness vendor families', () => {
    assert.deepEqual([...ROLES], ['author', 'verifier', 'mechanical', 'coordinator', 'panel', 'escalation']);
    assert.equal(inferFamily('claude-code'), 'anthropic');
    assert.equal(inferFamily('opencode', 'claude-opus-4-6'), 'anthropic');
    assert.equal(inferFamily('agy', 'gemini-2.5-pro'), 'google');
    assert.equal(inferFamily('codex', 'gpt-5-codex'), 'openai');
    assert.equal(inferFamily('aider', 'o3-mini'), 'openai');
    assert.equal(inferFamily('cli', 'grok-3'), 'xai');
    assert.equal(inferFamily('cli', 'deepseek-r1'), 'deepseek');
    assert.equal(inferFamily('ollama', 'llama-3.3-70b'), 'meta');
    assert.equal(inferFamily('custom-harness'), 'custom-harness');
  });

  it('parses roles config with fail-closed defaults', () => {
    const empty = parseRolesConfig(undefined);
    assert.equal(empty.requireDistinctVerifierFamily, true);
    assert.equal(empty.escalationMinFailures, 2);

    const parsed = parseRolesConfig({
      author: { harness: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' },
      verifier: { harness: 'codex', model: 'gpt-5', effort: 'high' },
      panel: [
        { harness: 'codex', model: 'gpt-5' },
        { harness: 'gemini-cli', model: 'gemini-2.5-pro' },
      ],
      escalationMinFailures: 3,
    });
    assert.equal(parsed.assignments.author?.harness, 'claude-code');
    assert.equal(parsed.assignments.verifier?.harness, 'codex');
    assert.equal(parsed.panel?.length, 2);
    assert.equal(parsed.escalationMinFailures, 3);
    assert.equal(parsed.requireDistinctVerifierFamily, true);
  });

  it('enforces cross-vendor separation of powers and rejects same-family author+verifier', () => {
    const sameAnthropic = parseRolesConfig({
      author: { harness: 'claude-code', model: 'claude-sonnet-4-6' },
      verifier: { harness: 'agy', model: 'claude-opus-4-6' },
    });
    const res1 = validateSeparationOfPowers(sameAnthropic);
    assert.equal(res1.ok, false);
    assert.equal(res1.authorFamily, 'anthropic');
    assert.equal(res1.verifierFamily, 'anthropic');
    assert.match(res1.reason ?? '', /share vendor family "anthropic"/);

    const sameGoogle = parseRolesConfig({
      author: { harness: 'gemini-cli', model: 'gemini-2.5-pro' },
      verifier: { harness: 'opencode', model: 'gemini-2.5-flash' },
    });
    const res2 = validateSeparationOfPowers(sameGoogle);
    assert.equal(res2.ok, false);
    assert.equal(res2.authorFamily, 'google');
    assert.equal(res2.verifierFamily, 'google');

    // Cross-family succeeds.
    const distinct = parseRolesConfig({
      author: { harness: 'claude-code', model: 'claude-sonnet-4-6' },
      verifier: { harness: 'codex', model: 'gpt-5' },
      panel: [
        { harness: 'codex', model: 'gpt-5' },
        { harness: 'gemini-cli', model: 'gemini-2.5-pro' },
      ],
    });
    const res3 = validateSeparationOfPowers(distinct);
    assert.equal(res3.ok, true);
    assert.equal(res3.authorFamily, 'anthropic');
    assert.equal(res3.verifierFamily, 'openai');

    // Override author to openai should fail because verifier/panel uses openai.
    const res4 = validateSeparationOfPowers(distinct, { harness: 'codex', model: 'gpt-5' });
    assert.equal(res4.ok, false);
    assert.equal(res4.authorFamily, 'openai');

    // Opting out explicitly allows same family.
    const relaxed = parseRolesConfig({
      author: { harness: 'claude-code' },
      verifier: { harness: 'claude-code' },
      requireDistinctVerifierFamily: false,
    });
    assert.equal(validateSeparationOfPowers(relaxed).ok, true);
  });

  it('enforces the 2-failure escalation gate unless user explicitly requests escalation', () => {
    const cfg = parseRolesConfig({});
    assert.equal(canEscalate(cfg, 0).allowed, false);
    assert.equal(canEscalate(cfg, 1).allowed, false);
    assert.equal(canEscalate(cfg, 2).allowed, true);
    assert.equal(canEscalate(cfg, 5).allowed, true);
    assert.equal(canEscalate(cfg, 0, true).allowed, true);
    assert.match(canEscalate(cfg, 0, true).reason, /explicit user request/i);
  });
});

describe('budget circuit breakers & Dr. Eggbot routine ROI auditor', () => {
  it('checks hard budget caps across tokens, USD, daily spend, and retries', () => {
    const limits = {
      maxTokensPerPr: 500_000,
      maxUsdPerPr: 10,
      maxUsdPerRun: 3,
      maxDailyUsd: 50,
      maxRetriesPerPr: 3,
    };

    const ok = checkBudget(limits, {
      prTokens: 250_000,
      prUsd: 4.5,
      runUsd: 1.2,
      dailyUsd: 20,
      retries: 2,
    });
    assert.equal(ok.allowed, true);
    assert.deepEqual(ok.breached, []);

    const breached = checkBudget(limits, {
      prTokens: 600_000,
      prUsd: 12,
      runUsd: 3.5,
      dailyUsd: 50,
      retries: 4,
    });
    assert.equal(breached.allowed, false);
    assert.deepEqual(
      breached.breached.map((b) => b.limit),
      ['maxTokensPerPr', 'maxUsdPerPr', 'maxUsdPerRun', 'maxRetriesPerPr'],
    );
  });

  it('auto-pauses zero-fix spend routines and flags high cost-per-fix routines', () => {
    const records: RoutineRunRecord[] = [
      // Zero-fix routine exceeding $5 -> auto-pause
      {
        routineId: 'flake-hunter',
        timestamp: '2026-11-18T00:00:00Z',
        tokens: 120_000,
        usd: 2.8,
        acceptedFixes: 0,
        status: 'noop',
      },
      {
        routineId: 'flake-hunter',
        timestamp: '2026-11-19T00:00:00Z',
        tokens: 140_000,
        usd: 3.1,
        acceptedFixes: 0,
        status: 'noop',
      },
      // Zero-fix routine approaching threshold -> warn
      {
        routineId: 'doc-sweeper',
        timestamp: '2026-11-19T00:00:00Z',
        tokens: 90_000,
        usd: 3.0,
        acceptedFixes: 0,
        status: 'noop',
      },
      // Healthy routine -> keep
      {
        routineId: 'dep-patcher',
        timestamp: '2026-11-19T00:00:00Z',
        tokens: 80_000,
        usd: 2.0,
        acceptedFixes: 2,
        status: 'ok',
      },
      // Expensive per-fix routine -> warn
      {
        routineId: 'heavy-refactor',
        timestamp: '2026-11-19T00:00:00Z',
        tokens: 900_000,
        usd: 30.0,
        acceptedFixes: 1,
        status: 'ok',
      },
    ];

    const audits = auditRoutines(records, { zeroFixPauseUsd: 5, maxUsdPerFix: 20 });
    const byId = new Map(audits.map((a) => [a.routineId, a]));

    assert.equal(byId.get('flake-hunter')?.action, 'auto-pause');
    assert.equal(byId.get('flake-hunter')?.usdPerFix, null);
    assert.equal(byId.get('doc-sweeper')?.action, 'warn');
    assert.equal(byId.get('dep-patcher')?.action, 'keep');
    assert.equal(byId.get('dep-patcher')?.usdPerFix, 1);
    assert.equal(byId.get('heavy-refactor')?.action, 'warn');
    assert.equal(byId.get('heavy-refactor')?.usdPerFix, 30);

    // Respects minRuns gate.
    const gated = auditRoutines(records, { zeroFixPauseUsd: 5, minRuns: 5 });
    assert.equal(gated.find((a) => a.routineId === 'flake-hunter')?.action, 'keep');
  });
});

describe('independent AI verifier swarm', () => {
  it('selects tiered verifier mode: skip for wording-only, single for minor/rebase, full for code and agent skills', () => {
    assert.equal(selectVerifierMode({ changedFiles: ['README.md', 'docs/guide.md', 'docs/notes.txt'] }).mode, 'skip');
    assert.equal(selectVerifierMode({ changedFiles: [] }).mode, 'skip');
    assert.equal(selectVerifierMode({ changedFiles: ['AGENTS.md'] }).mode, 'full');
    assert.equal(selectVerifierMode({ changedFiles: ['.agents/skills/vgate-verify/SKILL.md'] }).mode, 'full');
    assert.equal(
      selectVerifierMode({ changedFiles: ['services/orders/app.ts'], isRebaseOrMinorFix: true }).mode,
      'single',
    );
    assert.equal(selectVerifierMode({ changedFiles: ['services/orders/app.ts', 'README.md'] }).mode, 'full');
  });

  it('builds anti-trust verifier prompt and parses verifier output fail-closed', () => {
    const prompt = buildVerifierPrompt({
      lane: 'security',
      headSha: 'abc1234',
      changedFiles: ['cli/decide.ts'],
      verifyCommands: ['pnpm test'],
      artifactPaths: ['reports/verdict.json'],
    });
    assert.match(prompt, /DISTRUST PR descriptions/i);
    assert.match(prompt, /security/);
    assert.match(prompt, /abc1234/);
    assert.match(prompt, /reports\/verdict\.json/);

    // Valid raw JSON
    const p1 = parseVerifierOutput(
      JSON.stringify({
        verdict: 'PASS',
        summary: 'All receipts verified.',
        findings: [],
        artifactsChecked: ['reports/verdict.json'],
      }),
    );
    assert.equal(p1.verdict, 'PASS');
    assert.deepEqual(p1.artifactsChecked, ['reports/verdict.json']);

    // Valid fenced JSON
    const p2 = parseVerifierOutput(
      'Checking...\n```json\n{"verdict":"PASS+NOTES","summary":"Minor nit","findings":["unused var"],"artifactsChecked":[]}\n```',
    );
    assert.equal(p2.verdict, 'PASS+NOTES');
    assert.deepEqual(p2.findings, ['unused var']);

    // Unparseable or missing verdict -> FAIL (fail-closed!)
    assert.equal(parseVerifierOutput('Looks good to me! PASS').verdict, 'FAIL');
    assert.equal(parseVerifierOutput('{"summary":"missing verdict"}').verdict, 'FAIL');
    assert.equal(parseVerifierOutput('{"verdict":"MAYBE"}').verdict, 'FAIL');
    assert.equal(parseVerifierOutput('').verdict, 'FAIL');
  });

  it('runs swarm across lanes, aggregates fail-closed, blocks same-family, and writes reports/verifier.json', async () => {
    const tmp = makeTempDir('vgate-swarm-');
    try {
      const reportsDir = join(tmp, 'reports');
      const roles = parseRolesConfig({
        author: { harness: 'claude-code', model: 'claude-sonnet-4-6' },
        verifier: { harness: 'codex', model: 'gpt-5' },
        panel: [
          { harness: 'codex', model: 'gpt-5' },
          { harness: 'gemini-cli', model: 'gemini-2.5-pro' },
        ],
      });

      // 1. All PASS -> PASS
      const passExec: SwarmAgentExecutor = ({ harness }) =>
        Promise.resolve({
          ok: true,
          stdout: JSON.stringify({
            verdict: 'PASS',
            summary: `${harness} verified`,
            findings: [],
            artifactsChecked: ['reports/verdict.json'],
          }),
          stderr: '',
          exitCode: 0,
          durationMs: 12,
        });

      const passReport = await runVerifierSwarm({
        cwd: tmp,
        reportsDir,
        headSha: 'sha-111',
        patchId: 'patch-111',
        changedFiles: ['cli/decide.ts'],
        roles,
        lanes: ['correctness', 'security'],
        executor: passExec,
      });

      assert.equal(passReport.schema, 'vgate.verifier/1');
      assert.equal(passReport.verdict, 'PASS');
      assert.equal(passReport.mode, 'full');
      assert.equal(passReport.lanes.length, 2);
      assert.equal(passReport.lanes[0]?.family, 'openai');
      assert.equal(passReport.lanes[1]?.family, 'google');
      assert.equal(existsSync(join(reportsDir, 'verifier.json')), true);
      const written = JSON.parse(readFileSync(join(reportsDir, 'verifier.json'), 'utf8')) as VerifierReport;
      assert.equal(written.headSha, 'sha-111');

      // 2. One PASS+NOTES + one PASS -> PASS+NOTES
      let callCount = 0;
      const notesReport = await runVerifierSwarm({
        cwd: tmp,
        reportsDir,
        headSha: 'sha-112',
        changedFiles: ['cli/decide.ts'],
        roles,
        lanes: ['correctness', 'security'],
        executor: () => {
          callCount++;
          return Promise.resolve({
            ok: true,
            stdout: JSON.stringify({
              verdict: callCount === 2 ? 'PASS+NOTES' : 'PASS',
              summary: callCount === 2 ? 'Note about retry backoff' : 'Clean',
              findings: callCount === 2 ? ['Consider jitter'] : [],
              artifactsChecked: [],
            }),
            stderr: '',
            exitCode: 0,
            durationMs: 10,
          });
        },
      });
      assert.equal(notesReport.verdict, 'PASS+NOTES');

      // 3. Any FAIL (including unparseable output) -> FAIL
      const failReport = await runVerifierSwarm({
        cwd: tmp,
        reportsDir,
        headSha: 'sha-113',
        changedFiles: ['cli/decide.ts'],
        roles,
        lanes: ['correctness', 'security'],
        executor: ({ prompt }) =>
          Promise.resolve({
            ok: true,
            stdout: prompt.includes('"security"')
              ? 'not json at all'
              : JSON.stringify({ verdict: 'PASS', summary: 'ok', findings: [], artifactsChecked: [] }),
            stderr: '',
            exitCode: 0,
            durationMs: 5,
          }),
      });
      assert.equal(failReport.verdict, 'FAIL');

      // 4. Separation of powers failure blocks swarm before executing any lane
      let invoked = false;
      const sameFamilyRoles = parseRolesConfig({
        author: { harness: 'claude-code', model: 'claude-sonnet-4-6' },
        verifier: { harness: 'agy', model: 'claude-opus-4-6' },
      });
      const blockedReport = await runVerifierSwarm({
        cwd: tmp,
        reportsDir,
        headSha: 'sha-114',
        changedFiles: ['cli/decide.ts'],
        roles: sameFamilyRoles,
        executor: () => {
          invoked = true;
          return Promise.resolve({
            ok: true,
            stdout: '{"verdict":"PASS","summary":"ok"}',
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          });
        },
      });
      assert.equal(invoked, false);
      assert.equal(blockedReport.verdict, 'FAIL');
      assert.match(blockedReport.reasons[0] ?? '', /Separation of powers/);

      // 5. Zero lanes in non-skip mode -> FAIL
      const zeroLaneReport = await runVerifierSwarm({
        cwd: tmp,
        reportsDir,
        headSha: 'sha-115',
        changedFiles: ['cli/decide.ts'],
        roles,
        mode: 'full',
        lanes: [],
        executor: passExec,
      });
      assert.equal(zeroLaneReport.verdict, 'FAIL');

      // 6. Skip mode -> PASS with zero lanes
      const skipReport = await runVerifierSwarm({
        cwd: tmp,
        reportsDir,
        headSha: 'sha-116',
        changedFiles: ['README.md'],
        roles: sameFamilyRoles,
        executor: passExec,
      });
      assert.equal(skipReport.mode, 'skip');
      assert.equal(skipReport.verdict, 'PASS');
      assert.equal(skipReport.lanes.length, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('judgeVerifierReport rejects missing required reports, stale headSha, and stale patchId fail-closed', () => {
    assert.equal(judgeVerifierReport(undefined, 'sha-1', 'patch-1', false).state, 'not-required');
    assert.equal(judgeVerifierReport(undefined, 'sha-1', 'patch-1', true).state, 'missing');

    const baseReport: VerifierReport = {
      schema: 'vgate.verifier/1',
      verdict: 'PASS',
      mode: 'single',
      headSha: 'sha-1',
      patchId: 'patch-1',
      lanes: [
        {
          lane: 'correctness',
          harness: 'codex',
          family: 'openai',
          verdict: 'PASS',
          summary: 'ok',
          findings: [],
          artifactsChecked: [],
          durationMs: 10,
        },
      ],
      startedAt: '2026-11-20T00:00:00Z',
      durationMs: 10,
      reasons: [],
    };

    assert.equal(judgeVerifierReport(baseReport, 'sha-1', 'patch-1', true).state, 'pass');

    // Stale headSha rejected
    const staleSha = judgeVerifierReport(baseReport, 'sha-2', 'patch-1', true);
    assert.equal(staleSha.state, 'fail');
    assert.match(staleSha.reasons[0] ?? '', /headSha/);

    // Stale patchId rejected
    const stalePatch = judgeVerifierReport(baseReport, 'sha-1', 'patch-2', true);
    assert.equal(stalePatch.state, 'fail');
    assert.match(stalePatch.reasons[0] ?? '', /patchId/);

    // PASS+NOTES preserved
    const notes = judgeVerifierReport(
      { ...baseReport, verdict: 'PASS+NOTES', reasons: ['nit'] },
      'sha-1',
      'patch-1',
      true,
    );
    assert.equal(notes.state, 'pass-notes');

    // Zero lanes for non-skip rejected fail-closed
    const zeroLanes = judgeVerifierReport({ ...baseReport, lanes: [] }, 'sha-1', 'patch-1', true);
    assert.equal(zeroLanes.state, 'fail');
  });
});

describe('local-first 5-KPI ledger & exporters', () => {
  it('appends, reads, summarizes KPIs, and exports escaped HTML & Prometheus metrics', () => {
    const tmp = makeTempDir('vgate-metrics-');
    try {
      const nowIso = new Date().toISOString();
      const oldIso = new Date(Date.now() - 60 * 86_400_000).toISOString();

      const events: KpiEvent[] = [
        { timestamp: oldIso, kind: 'pr-merged', pr: '#1', humanReviewMinutes: 30 },
        { timestamp: nowIso, kind: 'pr-merged', pr: '#10', service: 'orders', humanReviewMinutes: 10 },
        { timestamp: nowIso, kind: 'pr-merged', pr: '#11', service: 'orders', humanReviewMinutes: 20 },
        { timestamp: nowIso, kind: 'pr-merged', pr: '#12', service: 'billing', humanReviewMinutes: 6 },
        { timestamp: nowIso, kind: 'pr-merged', pr: '#13', service: 'billing', humanReviewMinutes: 4 },
        { timestamp: nowIso, kind: 'pr-reverted', pr: '#11', service: 'orders', note: '<script>alert(1)</script>' },
        { timestamp: nowIso, kind: 'incident-escaped', pr: '#11', service: 'orders' },
        { timestamp: nowIso, kind: 'rework', pr: '#12', service: 'billing' },
        { timestamp: nowIso, kind: 'agent-spend', pr: '#10', role: 'author', tokens: 60_000, usd: 1.5 },
        { timestamp: nowIso, kind: 'agent-spend', pr: '#10', role: 'verifier', tokens: 40_000, usd: 0.5 },
      ];

      let lastPath = '';
      for (const ev of events) {
        lastPath = appendKpiEvent(tmp, ev);
      }
      assert.equal(lastPath, join(tmp, METRICS_FILE));

      const allEvents = readKpiEvents(tmp);
      assert.equal(allEvents.length, 10);

      const recentEvents = readKpiEvents(tmp, 30);
      assert.equal(recentEvents.length, 9);

      const summary = summarizeKpis(recentEvents, 30);
      assert.equal(summary.schema, 'vgate.metrics/1');
      assert.equal(summary.acceptedFixes, 4);
      assert.equal(summary.revertedPrs, 1);
      assert.equal(summary.escapedDefects, 1);
      assert.equal(summary.revertRate, 0.25);
      assert.equal(summary.escapedDefectRate, 0.25);
      assert.equal(summary.postReviewReworkRate, 0.25);
      assert.equal(summary.avgHumanReviewMinutes, 10);
      assert.equal(summary.totalTokens, 100_000);
      assert.equal(summary.totalUsd, 2);
      assert.equal(summary.usdPerAcceptedChange, 0.5);
      assert.equal(summary.tokensPerAcceptedChange, 25_000);
      assert.equal(summary.verificationTokenShare, 0.4);

      const html = renderMetricsHtml(summary, recentEvents);
      assert.match(html, /<!doctype html>/i);
      assert.doesNotMatch(html, /https?:\/\/cdn/i);
      assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

      const prom = renderPrometheusMetrics(summary);
      assert.match(prom, /# TYPE vgate_kpi_revert_rate gauge/);
      assert.match(prom, /vgate_kpi_revert_rate 0\.25/);
      assert.match(prom, /vgate_kpi_verification_token_share 0\.4/);
      assert.match(prom, /vgate_kpi_usd_per_accepted_change 0\.5/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import {
  appendTrailRow,
  assertWritesAllowed,
  auditWorkers,
  CiRunnerSandbox,
  clearStopOrder,
  COORDINATOR_SECRET_PATTERNS,
  createFactoryServer,
  CustomSandbox,
  diffPostReleaseFuzz,
  issueStopOrder,
  latestWorkerStates,
  LocalWorktreeSandbox,
  normalizeSignal,
  readStopOrder,
  sanitizeWorkerEnv,
  STOP_FILE,
  TRAIL_FILE,
  validateHandoffContract,
  verifyWebhookSignature,
  type FuzzFinding,
  type HandoffContract,
  type WorkerTrailRow,
  type WorkSignal,
} from './index.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initTempGitRepo(): string {
  const dir = makeTempDir('vgate-factory-git-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'factory-test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Factory Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('contract: 4-part handoff validation & zero-writes stop order', () => {
  const validContract: HandoffContract = {
    goal: 'Fix intermittent timeout in checkout webhook handler',
    finishCondition: 'All unit tests and vgate gate pass with PR opened',
    permissions: {
      allowPushBranches: true,
      allowOpenPr: true,
      allowAutoMerge: false,
      allowExternalMessages: false,
      allowedPaths: ['packages/factory/'],
    },
    escapeHatch: 'Stop and escalate to on-call if schema migration is required',
    maxDurationMs: 60 * 60 * 1000,
    maxUsd: 15,
  };

  it('accepts a valid 4-part handoff contract', () => {
    const result = validateHandoffContract(validContract);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it('rejects missing mandatory 4-part fields', () => {
    const result = validateHandoffContract({});
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('goal')));
    assert.ok(result.errors.some((e) => e.includes('finishCondition')));
    assert.ok(result.errors.some((e) => e.includes('permissions')));
    assert.ok(result.errors.some((e) => e.includes('escapeHatch')));
  });

  it('explicitly rejects pure duration-only finish conditions', () => {
    const durationConditions = [
      'run for 8 hours',
      'sleep 2h',
      'until morning',
      '4h',
      'work until 9am',
      'run overnight',
      'keep going for 30 minutes',
      'till tomorrow morning',
    ];

    for (const finishCondition of durationConditions) {
      const result = validateHandoffContract({ ...validContract, finishCondition });
      assert.equal(result.ok, false, `Expected "${finishCondition}" to be rejected`);
      assert.ok(
        result.errors.some((e) => e.toLowerCase().includes('duration')),
        `Expected duration error for "${finishCondition}", got: ${result.errors.join('; ')}`,
      );
    }
  });

  it('allows deterministic observable finish conditions even when paired with a time cap', () => {
    const result = validateHandoffContract({
      ...validContract,
      finishCondition: 'Queue empty and all PRs merged (cap 4h)',
    });
    assert.equal(result.ok, true);
  });

  it('rejects allowExternalMessages unless explicitly acknowledged', () => {
    const unacked = validateHandoffContract({
      ...validContract,
      permissions: { ...validContract.permissions, allowExternalMessages: true },
    });
    assert.equal(unacked.ok, false);
    assert.ok(unacked.errors.some((e) => e.includes('allowExternalMessages')));

    const ackedByOption = validateHandoffContract(
      {
        ...validContract,
        permissions: { ...validContract.permissions, allowExternalMessages: true },
      },
      { externalMessagesAcknowledged: true },
    );
    assert.equal(ackedByOption.ok, true);

    const ackedInPermissions = validateHandoffContract({
      ...validContract,
      permissions: {
        ...validContract.permissions,
        allowExternalMessages: true,
        externalMessagesAcknowledged: true,
      },
    });
    assert.equal(ackedInPermissions.ok, true);
  });

  it('rejects allowAutoMerge on non-reversible work', () => {
    const rejected = validateHandoffContract(
      {
        ...validContract,
        permissions: { ...validContract.permissions, allowAutoMerge: true },
      },
      { reversible: false },
    );
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some((e) => e.includes('allowAutoMerge')));

    const rejectedByField = validateHandoffContract({
      ...validContract,
      reversible: false,
      permissions: { ...validContract.permissions, allowAutoMerge: true },
    });
    assert.equal(rejectedByField.ok, false);

    const allowedReversible = validateHandoffContract({
      ...validContract,
      reversible: true,
      permissions: { ...validContract.permissions, allowAutoMerge: true },
    });
    assert.equal(allowedReversible.ok, true);
  });

  it('enforces zero-writes stop order lifecycle via .vgate/STOP', () => {
    const dir = makeTempDir('vgate-factory-stop-');
    try {
      assert.deepEqual(readStopOrder(dir), { stopped: false });
      assert.doesNotThrow(() => assertWritesAllowed(dir));

      const issued = issueStopOrder(dir, 'Production incident #402', 'bene');
      assert.equal(issued.stopped, true);
      assert.equal(issued.reason, 'Production incident #402');
      assert.equal(issued.by, 'bene');
      assert.ok(issued.at);
      assert.equal(fs.existsSync(path.join(dir, STOP_FILE)), true);

      const reread = readStopOrder(dir);
      assert.equal(reread.stopped, true);
      assert.equal(reread.reason, 'Production incident #402');

      assert.throws(() => assertWritesAllowed(dir), /Production incident #402/);

      const cleared = clearStopOrder(dir);
      assert.deepEqual(cleared, { stopped: false });
      assert.equal(fs.existsSync(path.join(dir, STOP_FILE)), false);
      assert.doesNotThrow(() => assertWritesAllowed(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sandbox: credential isolation & pluggable backends', () => {
  it('strips all coordinator/chat/ticket/cloud-admin secrets from worker env', () => {
    assert.ok(COORDINATOR_SECRET_PATTERNS.length >= 16);

    const sourceEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/worker',
      USER: 'worker',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      TMPDIR: '/tmp',
      NODE_ENV: 'test',
      CI: 'true',
      VGATE_BASE_URL: 'http://127.0.0.1:4000',
      VGATE_WEBHOOK_SECRET: 'whsec_top_secret',
      SLACK_BOT_TOKEN: 'xoxb-secret',
      LINEAR_API_KEY: 'lin_api_secret',
      JIRA_API_TOKEN: 'jira-secret',
      SENTRY_AUTH_TOKEN: 'sentry-secret',
      X_API_KEY: 'x-secret',
      TWITTER_BEARER_TOKEN: 'tw-secret',
      ZENDESK_API_TOKEN: 'zd-secret',
      INTERCOM_ACCESS_TOKEN: 'ic-secret',
      STRIPE_SECRET_KEY: 'sk_live_secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GCP_PROJECT_KEY: 'gcp-secret',
      GOOGLE_APPLICATION_CREDENTIALS: '/secrets/gcp.json',
      GITHUB_WEBHOOK_SECRET: 'gh-wh-secret',
      INTERNAL_ADMIN_TOKEN: 'admin-secret',
      DISCORD_BOT_TOKEN: 'bot-secret',
      RANDOM_UNLISTED_VAR: 'should-not-leak',
    };

    const sanitized = sanitizeWorkerEnv(sourceEnv, {
      WORKER_TASK_ID: 'task-99',
      SLACK_BOT_TOKEN: 'must-still-be-stripped',
    });

    assert.equal(sanitized.PATH, '/usr/bin:/bin');
    assert.equal('HOME' in sanitized, false);
    assert.equal(sanitized.NODE_ENV, 'test');
    assert.equal(sanitized.CI, 'true');
    assert.equal(sanitized.VGATE_BASE_URL, 'http://127.0.0.1:4000');
    assert.equal(sanitized.WORKER_TASK_ID, 'task-99');

    const forbidden = [
      'VGATE_WEBHOOK_SECRET',
      'SLACK_BOT_TOKEN',
      'LINEAR_API_KEY',
      'JIRA_API_TOKEN',
      'SENTRY_AUTH_TOKEN',
      'X_API_KEY',
      'TWITTER_BEARER_TOKEN',
      'ZENDESK_API_TOKEN',
      'INTERCOM_ACCESS_TOKEN',
      'STRIPE_SECRET_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'GCP_PROJECT_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GITHUB_WEBHOOK_SECRET',
      'INTERNAL_ADMIN_TOKEN',
      'DISCORD_BOT_TOKEN',
      'RANDOM_UNLISTED_VAR',
    ];
    for (const key of forbidden) {
      assert.equal(key in sanitized, false, `Expected ${key} to be stripped from worker env`);
    }
  });

  it('LocalWorktreeSandbox creates, executes in isolation, and destroys a real git worktree', async () => {
    const repoDir = initTempGitRepo();
    const sandbox = new LocalWorktreeSandbox();
    const prevSlack = process.env.SLACK_BOT_TOKEN;
    const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.SLACK_BOT_TOKEN = 'xoxb-never-leak';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-never-leak';

    try {
      const handle = await sandbox.prepare({
        projectRoot: repoDir,
        runId: 'run-wt-1',
        branch: 'factory/run-wt-1',
      });

      assert.equal(handle.backend, 'local-worktree');
      assert.equal(handle.workDir.startsWith(repoDir), false);
      assert.equal(handle.egressPolicy?.defaultDenyEgress, false);
      assert.equal(fs.existsSync(path.join(handle.workDir, 'README.md')), true);

      await assert.rejects(
        () =>
          new LocalWorktreeSandbox({ enforceKernelEgress: true }).prepare({
            projectRoot: repoDir,
            runId: 'run-wt-egress',
            branch: 'factory/run-wt-egress',
          }),
        /cannot enforce kernel-level default-deny egress/i,
      );

      const branchRes = await sandbox.exec(handle, 'git', ['branch', '--show-current']);
      assert.equal(branchRes.ok, true);
      assert.equal(branchRes.stdout.trim(), 'factory/run-wt-1');

      const envCheck = await sandbox.exec(
        handle,
        process.execPath,
        [
          '-e',
          'console.log(JSON.stringify({ slack: process.env.SLACK_BOT_TOKEN ?? null, aws: process.env.AWS_SECRET_ACCESS_KEY ?? null, custom: process.env.WORKER_RUN ?? null, isolatedHome: process.env.HOME !== process.argv[1] }))',
          process.env.HOME ?? '',
        ],
        { env: { WORKER_RUN: 'ok' } },
      );
      assert.equal(envCheck.ok, true);
      const observed = JSON.parse(envCheck.stdout.trim()) as {
        slack: string | null;
        aws: string | null;
        custom: string | null;
        isolatedHome: boolean;
      };
      assert.deepEqual(observed, { slack: null, aws: null, custom: 'ok', isolatedHome: true });

      issueStopOrder(repoDir, 'Emergency freeze');
      await assert.rejects(
        () => sandbox.exec(handle, process.execPath, ['-e', 'console.log("hi")']),
        /zero-writes stop order/i,
      );
      clearStopOrder(repoDir);

      await sandbox.destroy(handle);
      assert.equal(fs.existsSync(handle.workDir), false);
    } finally {
      if (prevSlack === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = prevSlack;
      }
      if (prevAws === undefined) {
        delete process.env.AWS_SECRET_ACCESS_KEY;
      } else {
        process.env.AWS_SECRET_ACCESS_KEY = prevAws;
      }
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('CiRunnerSandbox writes deterministic dispatch.json without running code locally', async () => {
    const dir = makeTempDir('vgate-factory-ci-');
    try {
      const sandbox = new CiRunnerSandbox({
        provider: 'github-actions',
        workflow: 'factory-worker.yml',
        repository: 'benebobaa/vgate',
      });
      const handle = await sandbox.prepare({
        projectRoot: dir,
        runId: 'ci-run-1',
        branch: 'factory/ci-1',
      });

      const dispatchPath = path.join(handle.workDir, 'dispatch.json');
      assert.equal(fs.existsSync(dispatchPath), true);

      const res = await sandbox.exec(handle, 'nonexistent-binary-never-executed', ['--check'], {
        env: { WORKER_STEP: 'gate', LINEAR_API_KEY: 'strip-me' },
      });
      assert.equal(res.ok, true);

      const payload = JSON.parse(fs.readFileSync(dispatchPath, 'utf8')) as {
        provider: string;
        workflow: string;
        commands: Array<{ command: string; args: string[]; env: Record<string, string> }>;
      };
      assert.equal(payload.provider, 'github-actions');
      assert.equal(payload.workflow, 'factory-worker.yml');
      assert.equal(payload.commands.length, 1);
      assert.equal(payload.commands[0]?.command, 'nonexistent-binary-never-executed');
      assert.deepEqual(payload.commands[0]?.args, ['--check']);
      assert.deepEqual(payload.commands[0]?.env, { WORKER_STEP: 'gate' });

      await sandbox.destroy(handle);
      assert.equal(fs.existsSync(handle.workDir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CustomSandbox loads YAML driver and runs commands with shell: false', async () => {
    const dir = makeTempDir('vgate-factory-custom-');
    try {
      const yamlConfig = `
prepareCmd:
  - ${process.execPath}
  - -e
  - "require('node:fs').writeFileSync(process.argv[1] + '/ready.txt', process.argv[2])"
  - "{{workDir}}"
  - "{{branch}}"
execCmd:
  - "{{command}}"
  - "{{args}}"
destroyCmd:
  - ${process.execPath}
  - -e
  - "process.exit(0)"
`;
      const sandbox = new CustomSandbox(yamlConfig);
      const handle = await sandbox.prepare({
        projectRoot: dir,
        runId: 'custom-1',
        branch: 'factory/custom-1',
      });

      assert.equal(fs.readFileSync(path.join(handle.workDir, 'ready.txt'), 'utf8'), 'factory/custom-1');

      const execRes = await sandbox.exec(handle, process.execPath, [
        '-e',
        'console.log(process.argv[1])',
        '$(echo injected); rm -rf /',
      ]);
      assert.equal(execRes.ok, true);
      assert.equal(execRes.stdout.trim(), '$(echo injected); rm -rf /');

      await sandbox.destroy(handle);
      assert.equal(fs.existsSync(handle.workDir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('connectors: HMAC verification, signal normalization & post-release fuzz diffing', () => {
  it('verifies HMAC-SHA256 webhook signatures in constant time (sha256= and raw hex)', () => {
    const secret = 'super-secret-webhook-key';
    const payload = JSON.stringify({ action: 'opened', issue: { number: 42 } });
    const digest = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

    assert.equal(verifyWebhookSignature(payload, `sha256=${digest}`, secret), true);
    assert.equal(verifyWebhookSignature(payload, digest, secret), true);
    assert.equal(verifyWebhookSignature(`${payload} `, `sha256=${digest}`, secret), false);
    assert.equal(verifyWebhookSignature(payload, `sha256=${digest}`, 'wrong-secret'), false);
    assert.equal(verifyWebhookSignature(payload, undefined, secret), false);
    assert.equal(verifyWebhookSignature(payload, 'sha256=not-valid-hex', secret), false);
  });

  it('normalizes signals across GitHub, GitLab, Linear, Jira, Slack, Sentry, and post-release-fuzz', () => {
    const ghBug = normalizeSignal('github', {
      action: 'opened',
      repository: { full_name: 'benebobaa/vgate' },
      issue: {
        number: 101,
        title: 'Crash when parsing empty spec',
        body: 'Stack trace attached',
        html_url: 'https://github.com/benebobaa/vgate/issues/101',
        labels: [{ name: 'bug' }, { name: 'p1' }],
      },
    });
    assert.equal(ghBug.source, 'github');
    assert.equal(ghBug.coordinator, 'benny');
    assert.equal(ghBug.severity, 'high');
    assert.equal(ghBug.dedupeKey, 'github:benebobaa/vgate:issue:101');
    assert.equal(ghBug.url, 'https://github.com/benebobaa/vgate/issues/101');

    const ghFeature = normalizeSignal('github', {
      repository: { full_name: 'benebobaa/vgate' },
      issue: {
        number: 102,
        title: 'Add JSON output flag',
        body: 'Support --json',
        labels: [{ name: 'enhancement' }],
      },
    });
    assert.equal(ghFeature.coordinator, 'matcha');
    assert.equal(ghFeature.severity, 'medium');

    const glMr = normalizeSignal('gitlab', {
      object_kind: 'merge_request',
      project: { path_with_namespace: 'org/service' },
      object_attributes: {
        iid: 7,
        title: 'Implement health endpoint',
        description: 'Adds /healthz',
        url: 'https://gitlab.example.com/org/service/-/merge_requests/7',
      },
    });
    assert.equal(glMr.coordinator, 'matcha');
    assert.equal(glMr.dedupeKey, 'gitlab:org/service:merge_request:7');

    const linear = normalizeSignal('linear', {
      data: {
        identifier: 'ENG-55',
        title: 'Regression in retry backoff',
        description: 'Retries fire immediately',
        priority: 1,
        url: 'https://linear.app/eng/issue/ENG-55',
        labels: [{ name: 'bug' }],
      },
    });
    assert.equal(linear.coordinator, 'benny');
    assert.equal(linear.severity, 'critical');
    assert.equal(linear.dedupeKey, 'linear:ENG-55');

    const jira = normalizeSignal('jira', {
      issue: {
        key: 'PLAT-9',
        fields: {
          summary: 'Customer feedback on onboarding',
          description: 'Needs triage',
          priority: { name: 'Low' },
          issuetype: { name: 'Support' },
        },
      },
    });
    assert.equal(jira.coordinator, 'sandy');
    assert.equal(jira.severity, 'low');
    assert.equal(jira.dedupeKey, 'jira:PLAT-9');

    const slack = normalizeSignal('slack', {
      event: {
        channel: 'C12345',
        ts: '1700000000.000100',
        thread_ts: '1700000000.000050',
        user: 'U999',
        text: 'Users asking for dark mode toggle\nMore details in thread',
      },
    });
    assert.equal(slack.coordinator, 'sandy');
    assert.equal(slack.title, 'Users asking for dark mode toggle');
    assert.equal(slack.dedupeKey, 'slack:C12345:1700000000.000050');

    const sentry = normalizeSignal('sentry', {
      data: {
        issue: {
          shortId: 'VGATE-77',
          title: 'TypeError: Cannot read properties of undefined',
          culprit: 'cli/main.ts',
          level: 'fatal',
          permalink: 'https://sentry.io/issues/77/',
        },
      },
    });
    assert.equal(sentry.coordinator, 'benny');
    assert.equal(sentry.severity, 'critical');
    assert.equal(sentry.dedupeKey, 'sentry:VGATE-77');

    const fuzz = normalizeSignal('post-release-fuzz', {
      fingerprint: 'fp-overflow-1',
      title: 'Unhandled 500 on malformed UTF-8 header',
      severity: 'high',
      surface: 'POST /orders',
      reproSteps: 'curl -H "X-Name: \\xff" ...',
    });
    assert.equal(fuzz.coordinator, 'benny');
    assert.equal(fuzz.severity, 'high');
    assert.equal(fuzz.dedupeKey, 'post-release-fuzz:fp-overflow-1');
  });

  it('diffs post-release fuzz findings and sorts net-new findings by severity', () => {
    const previous: FuzzFinding[] = [
      {
        fingerprint: 'fp-old-1',
        title: 'Known 400 on null id',
        severity: 'high',
        surface: 'GET /items',
        reproSteps: 'GET /items?id=null',
      },
    ];
    const current: FuzzFinding[] = [
      ...previous,
      {
        fingerprint: 'fp-new-low',
        title: 'Slow regex on query',
        severity: 'low',
        surface: 'GET /search',
        reproSteps: 'GET /search?q=aaaa',
      },
      {
        fingerprint: 'fp-new-crit',
        title: 'Auth bypass on empty bearer',
        severity: 'critical',
        surface: 'POST /admin',
        reproSteps: 'Authorization: Bearer ',
      },
      {
        fingerprint: 'fp-new-med',
        title: 'Missing Content-Type validation',
        severity: 'medium',
        surface: 'POST /upload',
        reproSteps: 'POST /upload',
      },
      {
        fingerprint: 'fp-new-high',
        title: 'Unhandled promise rejection on NaN qty',
        severity: 'high',
        surface: 'POST /cart',
        reproSteps: '{"qty":"NaN"}',
      },
    ];

    const diff = diffPostReleaseFuzz(previous, current);
    assert.deepEqual(
      diff.map((f) => f.fingerprint),
      ['fp-new-crit', 'fp-new-high', 'fp-new-med', 'fp-new-low'],
    );
  });
});

describe('auditor: hourly side-effect auditor & decision-trail store', () => {
  const baseTime = Date.parse('2026-11-20T12:00:00.000Z');

  function makeRow(overrides: Partial<WorkerTrailRow>): WorkerTrailRow {
    return {
      workerId: 'worker-1',
      signalId: 'github-1',
      branch: 'factory/worker-1',
      sandboxId: 'sandbox-1',
      coordinator: 'matcha',
      startedAt: new Date(baseTime).toISOString(),
      stuckAfterMs: 60 * 60 * 1000,
      lastCommitSha: 'aaa111',
      lastArtifactCount: 1,
      lastSideEffectAt: new Date(baseTime).toISOString(),
      state: 'running',
      note: 'Still working hard, almost finished!',
      ...overrides,
    };
  }

  it('detects healthy, stalled, dead, and completed workers strictly by observable side effects', () => {
    const dir = makeTempDir('vgate-factory-audit-');
    try {
      appendTrailRow(dir, makeRow({ workerId: 'w-healthy' }));
      appendTrailRow(dir, makeRow({ workerId: 'w-stalled', note: 'Making great progress (prose only)' }));
      appendTrailRow(dir, makeRow({ workerId: 'w-dead' }));
      appendTrailRow(dir, makeRow({ workerId: 'w-done', state: 'completed' }));

      const twoHoursLater = baseTime + 2 * 60 * 60 * 1000;
      const report = auditWorkers(
        dir,
        (row) => {
          if (row.workerId === 'w-healthy') {
            return { commitSha: 'bbb222', artifactCount: 1, processAlive: true };
          }
          if (row.workerId === 'w-stalled') {
            return { commitSha: 'aaa111', artifactCount: 1, processAlive: true };
          }
          if (row.workerId === 'w-dead') {
            return { commitSha: 'aaa111', artifactCount: 1, processAlive: false };
          }
          return { commitSha: 'aaa111', artifactCount: 1, processAlive: false };
        },
        twoHoursLater,
      );

      assert.equal(report.stopped, false);
      assert.equal(report.checked, 3);

      const byId = new Map(report.actions.map((a) => [a.workerId, a]));
      assert.equal(byId.get('w-healthy')?.decision, 'healthy');
      assert.equal(byId.get('w-healthy')?.observedCommit, 'bbb222');
      assert.equal(byId.get('w-stalled')?.decision, 'replace-stalled');
      assert.equal(byId.get('w-dead')?.decision, 'replace-errored');
      assert.equal(byId.has('w-done'), false);

      const latest = latestWorkerStates(dir);
      assert.equal(latest.get('w-healthy')?.lastCommitSha, 'bbb222');
      assert.equal(latest.get('w-healthy')?.lastSideEffectAt, new Date(twoHoursLater).toISOString());
      assert.equal(latest.get('w-stalled')?.state, 'stalled');
      assert.equal(latest.get('w-dead')?.state, 'failed');
      assert.equal(latest.get('w-done')?.state, 'completed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds all active workers with zero trail writes when .vgate/STOP is active', () => {
    const dir = makeTempDir('vgate-factory-audit-stop-');
    try {
      appendTrailRow(dir, makeRow({ workerId: 'w-1' }));
      appendTrailRow(dir, makeRow({ workerId: 'w-2' }));

      const trailPath = path.join(dir, TRAIL_FILE);
      const beforeSize = fs.statSync(trailPath).size;

      issueStopOrder(dir, 'Incident freeze', 'oncall');
      let probeCalled = false;
      const report = auditWorkers(
        dir,
        () => {
          probeCalled = true;
          return { commitSha: null, artifactCount: 0, processAlive: false };
        },
        baseTime + 10 * 60 * 60 * 1000,
      );

      assert.equal(report.stopped, true);
      assert.equal(report.checked, 2);
      assert.equal(probeCalled, false);
      assert.ok(report.actions.every((action) => action.decision === 'hold-stopped'));
      assert.equal(fs.statSync(trailPath).size, beforeSize);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('server: self-hosted Layer 1 control plane', () => {
  it('handles /health, /status, HMAC-verified /webhooks/:source, /stop, /resume, and /audit', async () => {
    const dir = makeTempDir('vgate-factory-server-');
    const webhookSecret = 'gh-secret-123';
    const controlToken = 'ctrl-secret-456';
    const authHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${controlToken}`,
    };
    const receivedSignals: WorkSignal[] = [];
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    appendTrailRow(dir, {
      workerId: 'srv-worker-1',
      signalId: 'github-1',
      branch: 'factory/srv-worker-1',
      sandboxId: 'sb-1',
      coordinator: 'benny',
      startedAt: twoHoursAgo,
      stuckAfterMs: 30 * 60 * 1000,
      lastCommitSha: 'abc123',
      lastArtifactCount: 0,
      lastSideEffectAt: twoHoursAgo,
      state: 'running',
    });

    const controlPlane = createFactoryServer({
      projectRoot: dir,
      port: 0,
      controlToken,
      webhookSecrets: { github: webhookSecret },
      onSignal: (signal) => {
        receivedSignals.push(signal);
        return { dispatched: true, workerId: `worker-${receivedSignals.length}` };
      },
      auditProbe: () => ({
        commitSha: 'abc123',
        artifactCount: 0,
        processAlive: true,
      }),
    });

    const { url } = await controlPlane.start();
    try {
      const healthRes = await fetch(`${url}/health`);
      assert.equal(healthRes.status, 200);
      const healthBody = (await healthRes.json()) as { ok: boolean; stopped: boolean; activeWorkers: number };
      assert.deepEqual(healthBody, { ok: true, stopped: false, activeWorkers: 1 });

      const statusRes = await fetch(`${url}/status`);
      assert.equal(statusRes.status, 200);
      const statusBody = (await statusRes.json()) as {
        stopped: boolean;
        stopOrder: { stopped: boolean };
        workers: WorkerTrailRow[];
        signalsQueued: number;
      };
      assert.equal(statusBody.stopped, false);
      assert.equal(statusBody.workers.length, 1);
      assert.equal(statusBody.signalsQueued, 0);

      // Fail-closed: webhook source with no configured secret is rejected with 401
      const unconfiguredWebhookRes = await fetch(`${url}/webhooks/slack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      assert.equal(unconfiguredWebhookRes.status, 401);

      // Fail-closed: unauthenticated mutation endpoints are rejected with 401
      const unauthStopRes = await fetch(`${url}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Unauthorized' }),
      });
      assert.equal(unauthStopRes.status, 401);

      const ghPayload = JSON.stringify({
        repository: { full_name: 'benebobaa/vgate' },
        issue: {
          number: 500,
          title: 'Bug in parser',
          body: 'Fails on empty input',
          labels: [{ name: 'bug' }],
        },
      });

      const badSigRes = await fetch(`${url}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        },
        body: ghPayload,
      });
      assert.equal(badSigRes.status, 401);
      assert.equal(receivedSignals.length, 0);

      const goodSig = `sha256=${createHmac('sha256', webhookSecret).update(ghPayload, 'utf8').digest('hex')}`;
      const okWebhookRes = await fetch(`${url}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': goodSig,
        },
        body: ghPayload,
      });
      assert.equal(okWebhookRes.status, 202);
      const webhookBody = (await okWebhookRes.json()) as {
        accepted: boolean;
        signal: WorkSignal;
        dispatch: { dispatched: boolean; workerId?: string };
      };
      assert.equal(webhookBody.accepted, true);
      assert.equal(webhookBody.signal.coordinator, 'benny');
      assert.equal(webhookBody.dispatch.dispatched, true);
      assert.equal(receivedSignals.length, 1);

      const stopRes = await fetch(`${url}/stop`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ reason: 'Maintenance window', by: 'ops' }),
      });
      assert.equal(stopRes.status, 200);

      const heldWebhookRes = await fetch(`${url}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': goodSig,
        },
        body: ghPayload,
      });
      assert.equal(heldWebhookRes.status, 503);
      const heldBody = (await heldWebhookRes.json()) as { accepted: boolean; held: boolean };
      assert.equal(heldBody.accepted, false);
      assert.equal(heldBody.held, true);
      assert.equal(receivedSignals.length, 1);

      const stoppedAuditRes = await fetch(`${url}/audit`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      assert.equal(stoppedAuditRes.status, 200);
      const stoppedAudit = (await stoppedAuditRes.json()) as {
        stopped: boolean;
        actions: Array<{ decision: string }>;
      };
      assert.equal(stoppedAudit.stopped, true);
      assert.equal(stoppedAudit.actions[0]?.decision, 'hold-stopped');

      const resumeRes = await fetch(`${url}/resume`, {
        method: 'POST',
        headers: { authorization: `Bearer ${controlToken}` },
      });
      assert.equal(resumeRes.status, 200);

      const liveAuditRes = await fetch(`${url}/audit`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      assert.equal(liveAuditRes.status, 200);
      const liveAudit = (await liveAuditRes.json()) as {
        stopped: boolean;
        actions: Array<{ decision: string }>;
      };
      assert.equal(liveAudit.stopped, false);
      assert.equal(liveAudit.actions[0]?.decision, 'replace-stalled');

      const resumedWebhookRes = await fetch(`${url}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': goodSig,
        },
        body: ghPayload,
      });
      assert.equal(resumedWebhookRes.status, 202);
      assert.equal(receivedSignals.length, 2);
    } finally {
      await controlPlane.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

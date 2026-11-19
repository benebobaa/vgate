import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parse } from 'yaml';

// The CI templates live in vgate's repository; a project's unpacked runtime does not carry them as files (the binary
// embeds them for `vgate init`), so there these tests have nothing to read and skip.
const ci = join(import.meta.dirname, '..', 'ci');
const templates = existsSync(join(ci, 'github', 'deploy-verify.yml'));
const skip = templates ? false : 'the CI templates are not part of a project runtime';
const read = (path: string) => (templates ? readFileSync(join(ci, path), 'utf8') : '');

// The after-deploy workflow's own logic (ci/github/deploy-verify.yml), run as GitHub runs it, with a stand-in vgate.
const workflow = (parse(read('github/deploy-verify.yml')) ?? { jobs: { verify: { if: '', steps: [] } } }) as {
  jobs: {
    verify: {
      if: string;
      steps: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>;
    };
  };
};
const steps = workflow.jobs.verify.steps;
const script = steps.find((step) => step.name === 'Smoke, canary, rollback')?.run ?? '';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const FAKE = `#!/usr/bin/env bash
case "$1" in
  services) [ -n "$FAKE_SERVICES" ] || exit 3; echo "{\\"data\\":{\\"services\\":$FAKE_SERVICES}}" ;;
  smoke) echo '{"summary":"smoke"}'; exit "\${FAKE_SMOKE:-0}" ;;
  canary) printf '{"summary":"%s"}\\n' "$FAKE_CANARY_SUMMARY"; exit "\${FAKE_CANARY:-0}" ;;
  *) exit 0 ;;
esac
`;

function verify(fake: Record<string, string>): { code: number | null; rolledBack: number } {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-after-deploy-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'vgate'), FAKE);
  chmodSync(join(dir, 'bin', 'vgate'), 0o755);
  const marker = join(dir, 'rolled-back');
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: dir,
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
      VGATE_ENVIRONMENT: 'production',
      VGATE_EVENT: 'deployment_status',
      VGATE_CANARY_FOR: '10m',
      VGATE_CANARY_EVERY: '30s',
      VGATE_ROLLBACK_COMMAND: `echo once >> '${marker}'`,
      FAKE_SERVICES: '["api"]',
      ...fake,
    },
  });
  return { code: run.status, rolledBack: existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').length - 1 : 0 };
}

describe('after-deploy workflow', { skip }, () => {
  it('rolls back once on a failed smoke, never on metrics it could not read', () => {
    assert.deepEqual(verify({ FAKE_SMOKE: '1' }), { code: 1, rolledBack: 1 });
    assert.deepEqual(verify({ FAKE_CANARY: '3', FAKE_CANARY_SUMMARY: 'CANARY UNKNOWN' }), { code: 1, rolledBack: 0 });
    assert.deepEqual(verify({ FAKE_CANARY: '0', FAKE_CANARY_SUMMARY: 'CANARY HEALTHY' }), { code: 0, rolledBack: 0 });
  });

  it('skips only a service with no canary configured; any other wrong call fails the run', () => {
    const none = 'api service.yaml has no environments.production.canary: name a metrics source';
    assert.deepEqual(verify({ FAKE_CANARY: '2', FAKE_CANARY_SUMMARY: none }), { code: 0, rolledBack: 0 });
    const bad = '--for: a duration such as 30s, 10m or 1h (got \\"ten\\")';
    assert.equal(verify({ FAKE_CANARY: '2', FAKE_CANARY_SUMMARY: bad }).code, 1);
  });

  it('fails when no service could be listed: nothing verified is never a pass', () => {
    assert.equal(verify({ FAKE_SERVICES: '' }).code, 1);
    assert.equal(verify({ FAKE_SERVICES: '[]' }).code, 1);
  });

  it('verifies only the listed environments of a deployment, and keeps no repository token for the tests', () => {
    assert.match(workflow.jobs.verify.if, /vars\.VGATE_DEPLOY_ENVIRONMENTS/);
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.['persist-credentials'], false);
  });
});

// The gate job's mutation step: it runs `vgate mutate` when vgate.yaml sets policy.mutationScore, in any YAML style.
const gate = (parse(read('github/vgate.yml')) ?? { jobs: {} }) as {
  jobs: { gate: { steps: Array<{ name?: string; run?: string }> } };
};
const mutationStep = gate.jobs.gate.steps.find((step) => step.name === 'Mutation score')?.run ?? '';
const gitlab = read('gitlab/regression-gate.yml');

function mutates(vgateYaml: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-mutation-step-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'vgate'), `#!/usr/bin/env bash\ntouch '${join(dir, 'ran')}'\n`);
  chmodSync(join(dir, 'bin', 'vgate'), 0o755);
  writeFileSync(join(dir, 'vgate.yaml'), vgateYaml);
  spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', mutationStep], {
    cwd: dir,
    env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, SERVICE: 'api', BASE: 'main' },
  });
  return existsSync(join(dir, 'ran'));
}

describe('gate workflows: the mutation step', { skip }, () => {
  it('runs whenever vgate.yaml sets policy.mutationScore, whatever the YAML style', () => {
    assert.ok(mutates('version: 0.3.0\npolicy:\n  mutationScore: 0.7\n'));
    assert.ok(mutates('version: 0.3.0\npolicy: { autoMerge: low, mutationScore: 0.7 }\n'));
    assert.ok(mutates('version: 0.3.0\npolicy:\n  "mutationScore": 0.7\n'));
    assert.ok(!mutates('version: 0.3.0\npolicy:\n  autoMerge: low\n  # mutationScore: 0.7\n'));
  });

  it('GitLab reads the policy the same way', () => {
    const pattern = /grep -Eq '[^\n]*mutationScore[^\n]*?' /.exec(mutationStep)?.[0] ?? 'none';
    assert.ok(gitlab.includes(pattern), pattern);
  });
});

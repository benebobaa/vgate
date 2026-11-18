/**
 * The gate's step scripts, run as the Taskfile runs them, against a throwaway project: a step must never pass having
 * verified nothing, nor count evidence that is not a test.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { stringify } from 'yaml';

const repo = resolve(import.meta.dirname, '..', '..');
const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const CONTRACT = stringify({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: { '/a': { get: { responses: { '200': { description: 'ok' } } } } },
});

/** A project with one service `svc`; `files` are written relative to the project root. */
function project(service: object, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'vgate-steps-'));
  temps.push(root);
  const all: Record<string, string> = {
    'vgate.yaml': 'servicesDir: services\n',
    'services/svc/service.yaml': stringify(service),
    'services/svc/openapi.yaml': CONTRACT,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function step(root: string, script: string, args: string[] = []) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', join(repo, 'framework', 'cli', script), ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, VGATE_PROJECT: root, SERVICE: 'svc', TEST_ENV: 'local' },
  });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

const LOCAL = { local: { baseUrl: 'http://127.0.0.1:9', users: { reader: { token: 't' } } } };

describe('schemathesis step', () => {
  it('fails when it has no identity to run as, instead of passing on zero runs', () => {
    const root = project({
      name: 'svc',
      spec: 'openapi.yaml',
      schemathesis: { readOnlyMethods: ['GET'], users: [] },
      environments: LOCAL,
    });
    const run = step(root, 'schemathesis.ts');
    assert.equal(run.code, 2, run.out);
    assert.match(run.out, /no user to run Schemathesis as/);
  });
});

describe('coverage step', () => {
  it('counts a scenario as tested only through a test title of the run, not a comment in the sources', () => {
    const root = project(
      { name: 'svc', spec: 'openapi.yaml', environments: LOCAL },
      {
        'services/svc/inventory.yaml': stringify({
          operations: [{ operation: 'GET /a', scenarios: [{ id: 'A-200' }, { id: 'A-200-EMPTY' }] }],
        }),
        'services/svc/tests/a.spec.ts': `// TODO [A-200-EMPTY]: not written yet\ntest('[A-200] reads', () => {});\n`,
        'reports/observed/1-w0.jsonl': `${JSON.stringify({ method: 'GET', path: '/a', status: 200, code: null, test: 'a' })}\n`,
        'reports/junit/playwright-api.xml': '<testsuites><testcase name="GET /a › [A-200] reads" /></testsuites>\n',
      },
    );
    const run = step(root, 'coverage-report.ts', ['--strict']);
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /UNTESTED {3}A-200-EMPTY\n/);
    assert.doesNotMatch(run.out, /UNTESTED {3}A-200\n/);
  });

  it('refuses to trace scenarios without a test run', () => {
    const root = project(
      { name: 'svc', spec: 'openapi.yaml', environments: LOCAL },
      { 'reports/observed/1-w0.jsonl': '' },
    );
    const run = step(root, 'coverage-report.ts', ['--strict']);
    assert.equal(run.code, 2, run.out);
    assert.match(run.out, /No JUnit reports/);
  });
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readProject } from '../framework/project.ts';
import { compat, compatFor, serviceSources, type CompatResult } from './compat.ts';
import { configCheck, configFor, dotenvKeys, formatOf, k8sKeys, listKeys, type ConfigResult } from './config-check.ts';
import {
  decide,
  decideFrom,
  renderMarkdown,
  type Decision,
  type DeploySafety,
  type ServiceDecision,
} from './decide.ts';
import { treeState } from './commit.ts';
import { EXIT } from './output.ts';
import { assessRisk } from './risk.ts';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A notes contract; `fields` are the properties of the GET /notes/{id} 200 body. */
function contract(fields: string[], extra = ''): string {
  return [
    'openapi: 3.1.0',
    'info: { title: notes, version: "1" }',
    'paths:',
    '  /notes/{id}:',
    '    get:',
    '      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]',
    '      responses:',
    "        '200':",
    '          description: the note',
    '          content:',
    '            application/json:',
    '              schema:',
    '                type: object',
    '                properties:',
    ...fields.map((f) => `                  ${f}: { type: string }`),
    "        '404': { description: no such note }",
    extra,
  ].join('\n');
}

const DEPLOY = `deploy:
  environments:
    production:
      contract: { ref: 'tag:v*' }
      config: { file: deploy/production.env.example }
`;

/**
 * v1.0.0 (deployed) serves id, title, body. main then drops `body` (merged, never deployed); the feature branch only
 * touches code. Against main nothing breaks; against production, `body` is gone for its clients.
 */
function project(vgate = `version: 0.2.0\nservicesDir: regression\npolicy: { autoMerge: low }\n${DEPLOY}`): string {
  const root = mkdtempSync(join(tmpdir(), 'vgate-deploy-'));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.invalid');
  git(root, 'config', 'user.name', 't');
  write(root, 'vgate.yaml', vgate);
  write(
    root,
    'regression/notes/service.yaml',
    "spec: openapi.yaml\npaths: ['apps/notes/**']\nconfig:\n  required: [DATABASE_URL]\n",
  );
  write(root, 'regression/notes/openapi.yaml', contract(['id', 'title', 'body']));
  write(root, 'apps/notes/main.go', 'package main\n');
  write(root, 'deploy/production.env.example', '# production provides\nDATABASE_URL=\nexport LOG_LEVEL=info\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'v1');
  git(root, 'tag', 'v1.0.0');
  write(root, 'regression/notes/openapi.yaml', contract(['id', 'title']));
  git(root, 'commit', '-qam', 'drop body (not deployed yet)');
  git(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'apps/notes/main.go', 'package main // feature\n');
  git(root, 'commit', '-qam', 'feature');
  return root;
}

const production = (root: string) => readProject(root).deploy!.environments[0];

describe('vgate.yaml deploy block', () => {
  const parse = (deploy: string) => () => {
    const root = mkdtempSync(join(tmpdir(), 'vgate-deploy-cfg-'));
    dirs.push(root);
    write(root, 'vgate.yaml', `version: 0.2.0\n${deploy}`);
    return readProject(root);
  };
  it('reads environments, sources and the breaking policy, with needs-approval by default', () => {
    const p = parse(DEPLOY)();
    assert.deepEqual(p.deploy, {
      environments: [
        {
          name: 'production',
          contract: { ref: 'tag:v*' },
          config: [{ file: 'deploy/production.env.example', format: undefined }],
        },
      ],
      policy: { breaking: 'needs-approval' },
    });
    assert.equal(parse('')().deploy, undefined);
  });
  it('refuses ambiguous or unsafe sources', () => {
    assert.throws(
      parse('deploy:\n  environments:\n    prod: { contract: { ref: v1, url: "https://x" } }\n'),
      /exactly one/,
    );
    assert.throws(parse('deploy:\n  environments:\n    prod: { contract: { url: "file:///etc/passwd" } }\n'), /http/);
    assert.throws(parse('deploy:\n  environments:\n    prod: { config: { file: ../secrets.env } }\n'), /inside/);
    assert.throws(parse('deploy:\n  environments:\n    prod: { config: { file: a.env, format: xml } }\n'), /format/);
    assert.throws(parse('deploy:\n  environments:\n    prod: {}\n'), /contract source, a config source/);
    assert.throws(parse('deploy:\n  environments: {}\n'), /at least one/);
    assert.throws(parse(`${DEPLOY}  policy: { breaking: ignore }\n`), /needs-approval or block/);
  });
});

describe('compat: against the deployed version, not main', () => {
  it('finds what breaks for production clients even when main already had the change', async () => {
    const root = project();
    const sources = serviceSources(readProject(root), 'notes');
    assert.ok(!('error' in sources));
    const result = await compatFor(sources, production(root));
    assert.equal(result.state, 'breaking');
    assert.match(result.source ?? '', /tag v1\.0\.0/);
    assert.ok(
      result.breaking.some((b) => /body removed/.test(b)),
      result.breaking.join('; '),
    );
    const cli = await compat(readProject(root), { service: 'notes', environment: undefined });
    assert.equal(cli.exitCode, EXIT.failed);
  });
  it('is compatible when only additions were made since the deployed version', async () => {
    const root = project();
    write(root, 'regression/notes/openapi.yaml', contract(['id', 'title', 'body', 'tags']));
    const result = await compatFor(serviceSources(readProject(root), 'notes') as never, production(root));
    assert.equal(result.state, 'compatible', result.breaking.join('; '));
    assert.ok(result.additive.some((a) => /tags added/.test(a)));
  });
  it('picks the newest tag by version order', async () => {
    const root = project();
    git(root, 'tag', 'v1.10.0', 'main'); // main: body already gone, so v1.10.0 is what production runs
    git(root, 'tag', 'v1.9.0', 'main~1');
    const result = await compatFor(serviceSources(readProject(root), 'notes') as never, production(root));
    assert.equal(result.state, 'compatible', result.breaking.join('; '));
    assert.match(result.source ?? '', /v1\.10\.0/);
  });
  it('says unknown, never compatible, when the deployed version cannot be found', async () => {
    const root = project(`version: 0.2.0\nservicesDir: regression\n${DEPLOY.replace('tag:v*', 'tag:release-*')}`);
    const result = await compatFor(serviceSources(readProject(root), 'notes') as never, production(root));
    assert.equal(result.state, 'unknown');
    assert.match(result.note ?? '', /no git tag matches release-\*/);
    assert.equal(
      (await compat(readProject(root), { service: 'notes', environment: undefined })).exitCode,
      EXIT.notReady,
    );
  });
  it('treats a service the deployed version does not have as not deployed there yet', async () => {
    const root = project();
    git(root, 'tag', 'v2.0.0', 'v1.0.0'); // newest tag; then move the service so the tag lacks its path
    git(root, 'mv', 'regression/notes', 'regression/notes2');
    write(root, 'vgate.yaml', `version: 0.2.0\nservicesDir: regression\n${DEPLOY}`);
    const result = await compatFor(serviceSources(readProject(root), 'notes2') as never, production(root));
    assert.equal(result.state, 'compatible');
    assert.match(result.note ?? '', /not deployed to production yet/);
  });
  it('reports "not configured" without a deploy block, and an unknown environment as a usage error', async () => {
    const root = project('version: 0.2.0\nservicesDir: regression\n');
    const result = await compat(readProject(root), { service: 'notes', environment: undefined });
    assert.equal(result.exitCode, EXIT.ok);
    assert.match(result.summary, /Not configured/);
    await assert.rejects(() => compat(readProject(project()), { service: 'notes', environment: 'staging' }), /staging/);
  });

  describe('from the live contract URL', () => {
    let server: Server;
    let base = '';
    before(async () => {
      server = createServer((req, res) => {
        if (req.url === '/openapi.json') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              openapi: '3.1.0',
              info: { title: 'n', version: '1' },
              paths: { '/gone': { get: { responses: { 200: { description: 'ok' } } } } },
            }),
          );
        } else if (req.url === '/html') res.end('<html>login</html>');
        else {
          res.statusCode = 503;
          res.end();
        }
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    });
    after(() => server.close());
    const urlEnv = (url: string) => ({ name: 'production', contract: { url }, config: [] });

    it('compares with the contract the environment serves', async () => {
      const root = project();
      const result = await compatFor(
        serviceSources(readProject(root), 'notes') as never,
        urlEnv(`${base}/openapi.json`),
      );
      assert.equal(result.state, 'breaking');
      assert.ok(
        result.breaking.some((b) => /GET \/gone removed/.test(b)),
        result.breaking.join('; '),
      );
    });
    it('is unknown when the URL fails, answers an error, or is not a contract', async () => {
      const root = project();
      const sources = serviceSources(readProject(root), 'notes') as never;
      for (const url of [`${base}/down`, `${base}/html`, 'http://127.0.0.1:9/openapi.json']) {
        const result = await compatFor(sources, urlEnv(url));
        assert.equal(result.state, 'unknown', url);
        assert.ok(result.note, url);
      }
    });
  });
});

describe('config-check: keys an environment provides', () => {
  it('reads dotenv keys (export, comments, quoted multi-line values) and never values', () => {
    const keys = dotenvKeys(
      '# c\nA=1\nexport B="x"\nC="line one\nNOT_A_KEY=inside the value\n"\n  D = 2\nnot a line\n',
    );
    assert.deepEqual([...keys].sort(), ['A', 'B', 'C', 'D']);
  });
  it('reads Kubernetes ConfigMap and Secret data and container env names, and notes envFrom', () => {
    const { keys, notes } = k8sKeys(
      [
        'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: a }\ndata: { LOG_LEVEL: info }',
        'apiVersion: v1\nkind: Secret\nmetadata: { name: b }\nstringData: { DATABASE_URL: postgres://x }',
        'apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: c }\nspec:\n  template:\n    spec:\n      containers:\n        - name: app\n          env: [{ name: PAYMENTS_URL, value: x }]\n          envFrom: [{ configMapRef: { name: a } }]',
      ].join('\n---\n'),
    );
    assert.deepEqual([...keys].sort(), ['DATABASE_URL', 'LOG_LEVEL', 'PAYMENTS_URL']);
    assert.equal(notes.length, 1);
  });
  it('reads plain key lists and guesses the format', () => {
    assert.deepEqual([...listKeys('[A, B]')], ['A', 'B']);
    assert.deepEqual([...listKeys('A: 1\nB: 2\n')], ['A', 'B']);
    assert.equal(formatOf({ file: 'deploy/production.env.example' }, ''), 'dotenv');
    assert.equal(formatOf({ file: '.env' }, ''), 'dotenv');
    assert.equal(formatOf({ file: 'k8s/prod.yaml' }, 'apiVersion: v1\nkind: ConfigMap\n'), 'k8s');
    assert.equal(formatOf({ file: 'keys.yaml' }, '[A]'), 'keys');
    assert.equal(formatOf({ file: 'environment.yaml' }, '[A]'), 'keys');
  });
  it('passes when every required key is there, and names the key a change newly requires', () => {
    const root = project();
    assert.equal(configFor(readProject(root), 'notes', production(root), 'main').state, 'complete');
    write(
      root,
      'regression/notes/service.yaml',
      "spec: openapi.yaml\npaths: ['apps/notes/**']\nconfig:\n  required: [DATABASE_URL, PAYMENTS_URL]\n",
    );
    const result = configFor(readProject(root), 'notes', production(root), 'main');
    assert.equal(result.state, 'missing');
    assert.deepEqual(result.missing, ['PAYMENTS_URL']);
    assert.deepEqual(result.newlyRequired, ['PAYMENTS_URL']);
    const cli = configCheck(readProject(root), { service: 'notes', environment: 'production', base: 'main' });
    assert.equal(cli.exitCode, EXIT.failed);
    assert.match(cli.summary, /newly requires PAYMENTS_URL.*fail at start-up/);
    assert.ok(!JSON.stringify(cli).includes('info'), 'values are never reported');
  });
  it('is unknown when the source is gone, and not configured without config.required', () => {
    const root = project();
    rmSync(join(root, 'deploy/production.env.example'));
    assert.equal(configFor(readProject(root), 'notes', production(root)).state, 'unknown');
    write(root, 'regression/notes/service.yaml', 'spec: openapi.yaml\n');
    assert.equal(configFor(readProject(root), 'notes', production(root)).state, 'not-configured');
  });
});

const green = (name = 'notes'): ServiceDecision => ({
  name,
  change: 'affected',
  gate: 'pass',
  guard: 'auto',
  failures: [],
  guardFindings: [],
  knownFailures: [],
});
const compatOf = (state: CompatResult['state']): CompatResult => ({
  environment: 'production',
  state,
  source: 'tag v1.0.0 (tag:v*)',
  breaking: state === 'breaking' ? ['GET /notes/{id} -> 200: response property body removed'] : [],
  additive: [],
  note: state === 'unknown' ? 'no git tag matches v*' : undefined,
});
const configOf = (state: ConfigResult['state']): ConfigResult => ({
  environment: 'production',
  state,
  required: ['DATABASE_URL', 'PAYMENTS_URL'],
  missing: state === 'missing' ? ['PAYMENTS_URL'] : [],
  newlyRequired: state === 'missing' ? ['PAYMENTS_URL'] : [],
  sources: ['deploy/production.env.example (dotenv)'],
  notes: state === 'unknown' ? ['deploy/production.env.example does not exist'] : [],
});

describe('decide with deploy safety', () => {
  const lowRisk = assessRisk(['apps/notes/main.go'], undefined);
  const decideWith = (
    compatState: CompatResult['state'],
    configState: ConfigResult['state'],
    breakingPolicy: 'needs-approval' | 'block' = 'needs-approval',
  ) =>
    decideFrom({
      affected: ['notes'],
      risk: lowRisk,
      policy: { autoMerge: 'low' },
      services: [green()],
      deploy: {
        configured: true,
        breakingPolicy,
        checks: [{ service: 'notes', compat: compatOf(compatState), config: configOf(configState) }],
      },
    });

  it('merges when compatible and complete', () => {
    assert.equal(decideWith('compatible', 'complete').decision, 'merge');
    assert.equal(decideWith('not-configured', 'not-configured').decision, 'merge');
  });
  it('blocks on missing configuration: deploying would fail', () => {
    const d = decideWith('compatible', 'missing');
    assert.equal(d.decision, 'blocked');
    assert.match(d.reasons[0], /newly requires PAYMENTS_URL/);
  });
  it('asks a human for a change that breaks production clients, or blocks it when the policy says so', () => {
    const d = decideWith('breaking', 'complete');
    assert.equal(d.decision, 'needs-approval');
    assert.match(d.reasons[0], /clients of the deployed version/);
    assert.equal(decideWith('breaking', 'complete', 'block').decision, 'blocked');
  });
  it('never treats an unreadable deployed contract or config source as safe', () => {
    assert.equal(decideWith('unknown', 'complete').decision, 'needs-approval');
    assert.equal(decideWith('compatible', 'unknown').decision, 'needs-approval');
  });
  it('says plainly in the comment what was checked, and when nothing was', () => {
    const base = {
      schema: 'vgate.decision/1',
      decision: 'blocked',
      reasons: ['x'],
      base: 'main',
      mergeBase: 'abc',
      head: 'def',
      policy: { autoMerge: 'low' },
      risk: lowRisk,
      services: [green()],
      knownFailures: [],
      changedFiles: 1,
      evidence: { read: [], ignored: [] },
    } as unknown as Decision;
    const deploy: DeploySafety = {
      configured: true,
      breakingPolicy: 'needs-approval',
      checks: [{ service: 'notes', compat: compatOf('breaking'), config: configOf('missing') }],
    };
    const md = renderMarkdown({ ...base, deploy });
    assert.match(md, /\*\*Safe to deploy\*\*/);
    assert.match(md, /breaks clients of the deployed version/);
    assert.match(md, /missing settings: `PAYMENTS_URL`/);
    assert.match(md, /newly required by this change/);
    assert.match(
      renderMarkdown({ ...base, deploy: { configured: false, checks: [] } }),
      /Safe to deploy:\*\* not checked/,
    );
  });

  it('runs both checks itself in a real decide, against the tag production runs', async () => {
    const root = project();
    const head = treeState(readProject(root));
    const sha = (path: string) =>
      createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex');
    write(
      root,
      'evidence/notes/verdict.json',
      JSON.stringify({
        schema: 'vgate.verdict/1',
        service: 'notes',
        verdict: 'pass',
        complete: true,
        startedAt: '2026-11-18T00:00:00.000Z',
        expectations: { 'regression/notes/openapi.yaml': sha('regression/notes/openapi.yaml') },
        commit: head,
        steps: [{ name: 'test', status: 'pass', exitCode: 0, durationMs: 1, log: 'x' }],
        tests: { total: 3, failed: 0, skipped: 0, failures: [], knownFailures: [] },
      }),
    );
    write(
      root,
      'evidence/notes/guard.json',
      JSON.stringify({
        schema: 'vgate.guard/1',
        service: 'notes',
        base: 'main',
        decision: 'auto',
        findings: [],
        info: [],
        head,
      }),
    );
    const result = await decide(readProject(root), { base: 'main', evidence: join(root, 'evidence') });
    const d = result.data as Decision;
    assert.equal(d.decision, 'needs-approval', d.reasons.join('; '));
    assert.ok(
      d.reasons.some((r) => /production: breaks .*body removed/.test(r)),
      d.reasons.join('; '),
    );
    assert.equal(d.deploy.checks[0].config.state, 'complete');
    assert.match(readFileSync(join(root, 'reports/decision.md'), 'utf8'), /Safe to deploy/);
  });
});

// The fixtures are free-form OpenAPI and YAML documents that each test edits in place: typing them would only repeat
// the documents' shape, so the unsafe-any rules are off in this file.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { stringify } from 'yaml';
import {
  configRule,
  contractRule,
  countExpects,
  flattenSchema,
  guard,
  knownFailuresRule,
  machineryRule,
  planRule,
  testsRule,
  type GuardReport,
  type RuleOutcome,
} from './guard.ts';
import { EXIT, UsageError } from './output.ts';

const details = (o: RuleOutcome) => o.findings.map((f) => f.detail);
const infos = (o: RuleOutcome) => o.info.map((f) => f.detail);

// A small contract: GET /notes/{id} answers 200 with a Note or 404; POST /notes takes a NewNote.
function contract(change: (spec: Record<string, any>) => void = () => {}): string {
  const spec: Record<string, any> = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/notes/{id}': {
        get: {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } },
            },
            '404': { description: 'not found' },
          },
        },
      },
      '/notes': {
        post: {
          parameters: [{ name: 'dryRun', in: 'query', required: false, schema: { type: 'boolean' } }],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewNote' } } } },
          responses: {
            '201': {
              description: 'created',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Note: {
          type: 'object',
          required: ['id', 'title'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            author: { $ref: '#/components/schemas/Author' },
          },
        },
        Author: {
          type: 'object',
          properties: { name: { type: 'string' }, parent: { $ref: '#/components/schemas/Author' } },
        },
        NewNote: {
          type: 'object',
          required: ['title'],
          properties: { title: { type: 'string' }, body: { type: 'string' } },
        },
      },
    },
  };
  change(spec);
  return stringify(spec);
}

describe('contractRule', () => {
  const rule = (head: string, base = contract()) => contractRule('openapi.yaml', base, head);

  it('passes additive changes as info: a new operation, response, optional field', () => {
    const result = rule(
      contract((s) => {
        s.paths['/health'] = { get: { responses: { '200': { description: 'up' } } } };
        s.paths['/notes/{id}'].get.responses['410'] = { description: 'gone' };
        s.components.schemas.Note.properties.color = { type: 'string' };
        s.components.schemas.NewNote.properties.color = { type: 'string' };
      }),
    );
    assert.deepEqual(result.findings, []);
    assert.ok(infos(result).includes('operation GET /health added'));
    assert.ok(infos(result).includes('documented response GET /notes/{id} -> 410 added'));
    assert.ok(infos(result).some((d) => d.includes('response property color added')));
  });

  it('flags a removed operation', () => {
    assert.deepEqual(details(rule(contract((s) => delete s.paths['/notes']))), ['operation POST /notes removed']);
  });

  it('flags a removed documented response', () => {
    const result = rule(contract((s) => delete s.paths['/notes/{id}'].get.responses['404']));
    assert.deepEqual(details(result), ['documented response GET /notes/{id} -> 404 removed']);
  });

  it('flags a removed documented code under the envelope pattern', () => {
    const service = stringify({ rules: { envelope: { codePattern: 'E\\d{3}', successCode: 'E000' } } });
    const base = contract((s) => (s.paths['/notes/{id}'].get.responses['404'].description = 'E404 or E405'));
    const head = contract((s) => (s.paths['/notes/{id}'].get.responses['404'].description = 'E404'));
    assert.deepEqual(details(contractRule('c', base, head, service, service)), [
      'documented response GET /notes/{id} -> 404 E405 removed',
    ]);
  });

  it('flags a removed or retyped response property, through $refs and arrays', () => {
    const removed = rule(contract((s) => delete s.components.schemas.Author.properties.name));
    assert.ok(details(removed).includes('GET /notes/{id} -> 200: response property author.name removed'));
    const retyped = rule(contract((s) => (s.components.schemas.Note.properties.tags.items = { type: 'integer' })));
    assert.ok(
      details(retyped).includes('GET /notes/{id} -> 200: response property tags[] changed type string -> integer'),
    );
  });

  it('flags a newly required request property, a new required one, and a newly required parameter', () => {
    const result = rule(
      contract((s) => {
        s.components.schemas.NewNote.required = ['title', 'body'];
        s.components.schemas.NewNote.properties.owner = { type: 'string' };
        s.components.schemas.NewNote.required.push('owner');
        s.paths['/notes'].post.parameters[0].required = true;
      }),
    );
    assert.deepEqual(details(result).sort(), [
      'POST /notes: new required request property owner',
      'POST /notes: parameter query:dryRun newly required',
      'POST /notes: request property body newly required',
    ]);
  });

  it('treats a new contract as info and a deleted one as a finding', () => {
    assert.deepEqual(contractRule('c', undefined, contract()).findings, []);
    assert.deepEqual(details(contractRule('c', contract(), undefined)), ['the contract was deleted']);
  });

  it('stops at a recursive schema', () => {
    const spec = {
      components: { schemas: { A: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } } } },
    };
    const fields = flattenSchema(spec, { $ref: '#/components/schemas/A' });
    assert.deepEqual([...fields.keys()], ['', 'a']);
    assert.equal(fields.get('a')?.type, 'recursive');
  });
});

describe('planRule', () => {
  const plan = (ids: string[], excluded: object[] = []) =>
    stringify({
      auth: { scenarios: [{ id: 'AUTH-401' }] },
      operations: [{ operation: 'GET /x', excluded, scenarios: ids.map((id) => ({ id })) }],
    });

  it('passes an added scenario as info', () => {
    const result = planRule('p', plan(['X-200']), plan(['X-200', 'X-404']));
    assert.deepEqual(result.findings, []);
    assert.deepEqual(infos(result), ['scenario X-404 added']);
  });

  it('flags a removed scenario, also in a cross-cutting section', () => {
    assert.deepEqual(details(planRule('p', plan(['X-200', 'X-404']), plan(['X-200']))), ['scenario X-404 removed']);
    const noAuth = stringify({ operations: [{ operation: 'GET /x', scenarios: [{ id: 'X-200' }] }] });
    assert.deepEqual(details(planRule('p', plan(['X-200']), noAuth)), ['scenario AUTH-401 removed']);
  });

  it('flags a new exclusion with its operation', () => {
    const result = planRule('p', plan(['X-200']), plan(['X-200'], [{ status: 500, reason: 'cannot provoke' }]));
    assert.deepEqual(details(result), ['new exclusion GET /x 500']);
  });
});

describe('configRule', () => {
  const base = {
    rules: {
      strictResponseProperties: true,
      datetimeOffset: '+01:00',
      headers: { always: { 'X-Request-Id': '/^.+$/' }, onStatus: { '401': { 'WWW-Authenticate': 'Bearer' } } },
      streaming: { terminal: [{ data: '[DONE]' }] },
    },
    coverage: { exclude: [{ status: '500', reason: 'x' }] },
    schemathesis: {
      maxExamples: 50,
      excludeChecks: [{ check: 'a', reason: 'r' }],
      users: ['reader', 'writer'],
      readOnlyMethods: ['GET'],
    },
  };
  const rule = (change: (c: any) => void) => {
    const head = structuredClone(base) as any;
    change(head);
    return details(configRule('s', stringify(base), stringify(head)));
  };

  it('passes an unchanged or tightened config', () => {
    assert.deepEqual(
      rule(() => {}),
      [],
    );
    assert.deepEqual(
      rule((c) => (c.schemathesis.maxExamples = 100)),
      [],
    );
    assert.deepEqual(
      rule((c) => (c.rules.headers.always['X-Trace'] = 'x')),
      [],
    );
  });

  it('flags every loosening', () => {
    assert.deepEqual(
      rule((c) => c.coverage.exclude.push({ status: '503', reason: 'y' })),
      ['coverage.exclude added: {reason:"y",status:"503"}'],
    );
    assert.deepEqual(
      rule((c) => delete c.rules.strictResponseProperties),
      ['rules.strictResponseProperties turned off (undefined)'],
    );
    assert.deepEqual(
      rule((c) => (c.rules.optionalPropertiesNullable = true)),
      ['rules.optionalPropertiesNullable turned on'],
    );
    assert.deepEqual(
      rule((c) => delete c.rules.datetimeOffset),
      ['rules.datetimeOffset removed (was +01:00)'],
    );
    assert.deepEqual(
      rule((c) => delete c.rules.headers.onStatus['401']),
      ['header rule onStatus.401 www-authenticate removed (was Bearer)'],
    );
    assert.deepEqual(
      rule((c) => (c.rules.headers.always['X-Request-Id'] = '/.*/')),
      ['header rule always x-request-id changed /^.+$/ -> /.*/'],
    );
    assert.deepEqual(
      rule((c) => c.schemathesis.excludeChecks.push({ check: 'b', reason: 'r' })),
      ['schemathesis.excludeChecks added: b'],
    );
    assert.deepEqual(
      rule((c) => (c.schemathesis.maxExamples = 10)),
      ['schemathesis.maxExamples lowered 50 -> 10'],
    );
  });

  it('flags a contract step that checks less: fewer identities, other operations, fewer examples by default', () => {
    assert.deepEqual(
      rule((c) => (c.schemathesis.users = [])),
      ['schemathesis.users lost reader', 'schemathesis.users lost writer'],
    );
    assert.deepEqual(
      rule((c) => delete c.schemathesis.maxExamples),
      ['schemathesis.maxExamples lowered 50 -> 25'],
    );
    assert.deepEqual(
      rule((c) => (c.schemathesis.readOnlyMethods = ['HEAD'])),
      ['schemathesis.readOnlyMethods changed ["GET"] -> ["HEAD"]'],
    );
    assert.deepEqual(
      rule((c) => (c.schemathesis.readOnlyPaths = '^/never$')),
      ['schemathesis.readOnlyPaths changed unset -> "^/never$"'],
    );
    assert.deepEqual(
      rule((c) => delete c.schemathesis.users),
      [],
    );
    const narrowed = configRule('s', stringify({ schemathesis: {} }), stringify({ schemathesis: { users: ['a'] } }));
    assert.deepEqual(details(narrowed), ['schemathesis.users narrowed from every user to ["a"]']);
  });

  it('flags paths: that stop covering a change (vgate affected would skip the gate), not ones that widen', () => {
    const paths = (before: unknown, after: unknown) =>
      details(configRule('s', stringify({ paths: before }), stringify({ paths: after })));
    assert.deepEqual(paths(['apps/a/**', 'libs/**'], ['apps/a/**']), ['paths lost libs/**']);
    assert.deepEqual(paths(null, ['apps/a/**']), ['paths narrowed from every change to ["apps/a/**"]']);
    assert.deepEqual(paths(['apps/a/**'], ['apps/a/**', 'libs/**']), []);
    assert.deepEqual(paths(['apps/a/**'], null), [], 'no paths: means every change');
  });

  it('flags a streaming rule that changed or went away', () => {
    assert.deepEqual(
      rule((c) => delete c.rules.streaming),
      ['rules.streaming changed {terminal:[{data:"[DONE]"}]} -> unset'],
    );
  });
});

describe('knownFailuresRule', () => {
  const file = (...failures: object[]) => stringify({ failures });
  const entry = { id: 'X-200', ticket: 'T-1', owner: 'qa', expires: '2026-12-31', reason: 'r' };

  it('flags an added entry and a later expiry; a removed or earlier one is fine', () => {
    assert.deepEqual(details(knownFailuresRule('k', undefined, file(entry))), [
      'known failure X-200 added, expires 2026-12-31',
    ]);
    assert.deepEqual(details(knownFailuresRule('k', file(entry), file({ ...entry, expires: '2027-06-30' }))), [
      'known failure X-200 expiry moved 2026-12-31 -> 2027-06-30',
    ]);
    assert.deepEqual(knownFailuresRule('k', file(entry), file({ ...entry, expires: '2026-12-01' })).findings, []);
    const removed = knownFailuresRule('k', file(entry), file());
    assert.deepEqual(removed.findings, []);
    assert.deepEqual(infos(removed), ['known failure X-200 removed']);
  });

  it('reads an unquoted YAML date', () => {
    const base = 'failures:\n  - { id: X-200, expires: 2026-12-31 }\n';
    const head = 'failures:\n  - { id: X-200, expires: 2027-01-31 }\n';
    assert.deepEqual(details(knownFailuresRule('k', base, head)), [
      'known failure X-200 expiry moved 2026-12-31 -> 2027-01-31',
    ]);
  });
});

describe('testsRule', () => {
  const spec = `test('[X-200] reads', async () => {\n  expect(a).toBe(1);\n  expect.soft(b).toBe(2);\n  await expectRows(db);\n});\n`;

  it('counts assertion calls but not commented ones', () => {
    assert.equal(countExpects(spec), 3);
    assert.equal(countExpects(`// expect(a)\n/* expect(b) */\nconst url = 'http://x'; expect(c);`), 1);
  });

  it('passes an added test as info', () => {
    const result = testsRule(
      new Map([['t.spec.ts', spec]]),
      new Map([['t.spec.ts', `${spec}test('[X-404] gone', () => { expect(1); });`]]),
    );
    assert.deepEqual(result.findings, []);
  });

  it('flags a deleted file, fewer assertions, a vanished scenario id and new fail/fixme/skip', () => {
    const base = new Map([
      ['a.spec.ts', spec],
      ['b.spec.ts', `test('[Y-200] y', () => { expect(1); });`],
    ]);
    const head = new Map([
      ['a.spec.ts', spec.replace('  expect(a).toBe(1);\n', '').replace("test('[X-200]", "test.fail('[X-200]")],
    ]);
    assert.deepEqual(details(testsRule(base, head)).sort(), [
      '.fail( 0 -> 1',
      'assertions 3 -> 2',
      'scenario Y-200 no longer in any test source',
      'test source deleted (1 assertions)',
    ]);
    const skipped = testsRule(
      new Map([['a.spec.ts', spec]]),
      new Map([['a.spec.ts', `${spec}test.skip(true, 'later');\ntest.fixme('x', () => {});`]]),
    );
    assert.deepEqual(details(skipped).sort(), ['.fixme( 0 -> 1', '.skip( 0 -> 1']);
  });
});

describe('machineryRule', () => {
  it('flags the judge and ignores the service', () => {
    const result = machineryRule([
      'framework/http/client.ts',
      'Taskfile.yml',
      'services/x/tests/a.spec.ts',
      '.claude/skills/s/SKILL.md',
      'README.md',
      'cli/gate.ts',
      '.gitlab-ci.yml',
      '.github/CODEOWNERS',
    ]);
    assert.deepEqual(
      result.findings.map((f) => f.file),
      [
        '.claude/skills/s/SKILL.md',
        '.github/CODEOWNERS',
        '.gitlab-ci.yml',
        'Taskfile.yml',
        'cli/gate.ts',
        'framework/http/client.ts',
      ],
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// guard() on real git repositories

const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

const SERVICE = stringify({ name: 'svc', spec: 'openapi.yaml', rules: { strictResponseProperties: true } });
const PLAN = stringify({
  operations: [{ operation: 'GET /notes/{id}', scenarios: [{ id: 'GET-200' }, { id: 'GET-404' }] }],
});
const TESTS = `test('[GET-200] reads', async () => { expect(a).toBe(1); expect(b).toBe(2); });\ntest('[GET-404] missing', async () => { expect(c).toBe(404); });\n`;

/** A git repo (project root optionally below the top level) with the base committed; returns the project root. */
function project(sub = ''): {
  root: string;
  write: (path: string, text: string) => void;
  remove: (path: string) => void;
} {
  const top = mkdtempSync(join(tmpdir(), 'vgate-guard-'));
  temps.push(top);
  const root = join(top, sub);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('services/svc/service.yaml', SERVICE);
  write('services/svc/openapi.yaml', contract());
  write('services/svc/inventory.yaml', PLAN);
  write('services/svc/tests/notes.spec.ts', TESTS);
  write('framework/config.ts', '// judge\n');
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'base');
  return { root, write, remove: (path) => rmSync(join(root, path)) };
}

function run(root: string, base = 'main') {
  const result = guard(root, { service: 'svc', base });
  const report = JSON.parse(readFileSync(join(root, 'reports', 'guard.json'), 'utf8')) as GuardReport;
  return { result, report, rules: [...new Set(report.findings.map((f) => f.rule))].sort() };
}

describe('guard', () => {
  it('decides auto on additive changes and writes the report', () => {
    const p = project();
    p.write(
      'services/svc/openapi.yaml',
      contract((s) => (s.paths['/health'] = { get: { responses: { '200': { description: 'up' } } } })),
    );
    p.write('services/svc/inventory.yaml', PLAN.replace('- id: GET-404', '- id: GET-404\n      - id: HLT-200'));
    p.write('services/svc/tests/health.spec.ts', `test('[HLT-200] up', () => { expect(1).toBe(1); });\n`);
    const { result, report } = run(p.root);
    assert.equal(result.exitCode, EXIT.ok);
    assert.equal(report.schema, 'vgate.guard/1');
    assert.equal(report.decision, 'auto');
    assert.deepEqual(report.findings, []);
    assert.ok(report.info.length >= 3);
  });

  it('decides needs-human for each rule, with the project below the git top level', () => {
    const cases: Array<[string, (p: ReturnType<typeof project>) => void]> = [
      [
        'contract-breaking',
        (p) =>
          p.write(
            'services/svc/openapi.yaml',
            contract((s) => delete s.paths['/notes']),
          ),
      ],
      ['plan-weakened', (p) => p.write('services/svc/inventory.yaml', PLAN.replace(/\n.*GET-404.*/, ''))],
      [
        'config-loosened',
        (p) =>
          p.write(
            'services/svc/service.yaml',
            SERVICE.replace('strictResponseProperties: true', 'strictResponseProperties: false'),
          ),
      ],
      [
        'known-failure-added',
        (p) =>
          p.write(
            'services/svc/known-failures.yaml',
            stringify({ failures: [{ id: 'GET-404', ticket: 'T', owner: 'o', expires: '2027-01-01', reason: 'r' }] }),
          ),
      ],
      ['tests-weakened', (p) => p.write('services/svc/tests/notes.spec.ts', TESTS.replace(' expect(b).toBe(2);', ''))],
      ['machinery-changed', (p) => p.write('framework/config.ts', '// judge, edited\n')],
    ];
    for (const [rule, change] of cases) {
      const p = project('sub/project');
      change(p);
      const { result, report, rules } = run(p.root);
      assert.equal(report.decision, 'needs-human', rule);
      assert.deepEqual(rules, [rule], `${rule}: ${JSON.stringify(report.findings)}`);
      assert.equal(result.exitCode, EXIT.failed);
      assert.ok(
        result.next.some((n) => n.includes(rule)),
        rule,
      );
    }
  });

  it('sees a deleted test file and an untracked machinery file', () => {
    const p = project();
    p.remove('services/svc/tests/notes.spec.ts');
    p.write('framework/new-helper.ts', 'export {};\n');
    const { report } = run(p.root);
    assert.ok(report.findings.some((f) => f.rule === 'tests-weakened' && f.detail.startsWith('test source deleted')));
    assert.ok(report.findings.some((f) => f.rule === 'machinery-changed' && f.file === 'framework/new-helper.ts'));
  });

  it('sees files whose names git would quote (non-ASCII)', () => {
    const p = project();
    p.write('services/svc/tests/über.spec.ts', TESTS);
    git(p.root, 'add', '-A');
    git(p.root, 'commit', '-q', '-m', 'umlaut');
    p.remove('services/svc/tests/über.spec.ts');
    p.write('framework/día.ts', 'export {};\n');
    const { report } = run(p.root);
    assert.ok(report.findings.some((f) => f.rule === 'tests-weakened' && f.file.endsWith('über.spec.ts')));
    assert.ok(report.findings.some((f) => f.rule === 'machinery-changed' && f.file === 'framework/día.ts'));
  });

  it('leaves no earlier guard.json behind when it stops before judging', () => {
    const p = project();
    p.write('reports/guard.json', '{"schema":"vgate.guard/1","service":"svc","base":"main","decision":"auto"}');
    assert.throws(() => guard(p.root, { service: 'svc', base: 'no-such-ref' }), UsageError);
    assert.ok(!existsSync(join(p.root, 'reports/guard.json')));
  });

  it('still guards a service the change deletes, and refuses one that exists nowhere', () => {
    const p = project();
    rmSync(join(p.root, 'services', 'svc'), { recursive: true });
    const { result, rules } = run(p.root);
    assert.equal(result.exitCode, EXIT.failed);
    assert.deepEqual(rules, ['config-loosened', 'contract-breaking', 'plan-weakened', 'tests-weakened']);
    assert.throws(() => guard(p.root, { service: 'nope', base: 'main' }), UsageError);
    // The command line too: a service gone from the working tree is not an unknown service there.
    const cli = (service: string) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          join(import.meta.dirname, 'main.ts'),
          'guard',
          '--root',
          p.root,
          '--service',
          service,
          '--base',
          'main',
        ],
        { cwd: import.meta.dirname, encoding: 'utf8' },
      ).status;
    assert.equal(cli('svc'), EXIT.failed);
    assert.equal(cli('nope'), EXIT.usage);
  });

  it('rejects an unknown base ref and answers not-ready outside git', () => {
    const p = project();
    assert.throws(() => guard(p.root, { service: 'svc', base: 'no-such-ref' }), UsageError);
    assert.throws(() => guard(p.root, { service: 'svc', base: undefined }), UsageError);
    const bare = mkdtempSync(join(tmpdir(), 'vgate-nogit-'));
    temps.push(bare);
    assert.equal(guard(bare, { service: 'svc', base: 'main' }).exitCode, EXIT.notReady);
  });
});

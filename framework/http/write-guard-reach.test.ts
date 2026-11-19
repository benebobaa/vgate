/**
 * The write guard beyond the client: dependency helpers, a test's own fetch and node:http(s) requests, k6 and
 * Schemathesis's fuzz mode, each against a live stand-in that counts what reaches it. Self-contained: temp dirs and
 * local servers only (the self-tests also run inside users' projects).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ClientRequest, type Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { request as playwrightRequest } from '@playwright/test';
import { ESLint, type Linter } from 'eslint';
import { parseAllowWrites } from '../config.ts';
import { AmqpBroker } from '../deps/amqp.ts';
import { Inbox } from '../deps/email.ts';
import { MySqlDb, singleStatements } from '../deps/mysql.ts';
import { S3Store } from '../deps/s3.ts';
import { SqsQueues } from '../deps/sqs.ts';
import {
  asFramework,
  frameworkFetch,
  guardDependency,
  installRawGuard,
  isAllowedDependencyWrite,
  isReadOnlySql,
  WriteRefused,
} from './write-guard.ts';

const staging = (allowWrites?: string[]) => ({ name: 'staging', disposable: false, allowWrites });
const local = { name: 'local', disposable: true };

/** A server that answers 200 to everything and counts requests per method. */
async function counting(): Promise<{ url: string; seen: string[]; server: Server }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      // A redirect that keeps the method: the next hop must be judged too.
      if (req.url === '/api/login-then-notes') return res.writeHead(307, { location: '/api/notes' }).end();
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end('<R><QueueUrl>http://x/000/q</QueueUrl><MessageId>m1</MessageId></R>');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

const writes = (seen: string[]) => seen.filter((line) => !/^(GET|HEAD|OPTIONS) /.test(line));

describe('dependency guards', () => {
  it('refuse every writing operation on a shared environment unless the exact dependency:operation is listed', () => {
    assert.doesNotThrow(() => guardDependency(local, 'files')('put'));
    assert.throws(() => guardDependency(staging(), 'files')('put'), WriteRefused);
    assert.throws(() => guardDependency(staging(), 'files')('put'), /files:put/);
    assert.doesNotThrow(() => guardDependency(staging(['files:put']), 'files')('put'));
    assert.throws(() => guardDependency(staging(['files:put']), 'files')('create-bucket'), WriteRefused);
    assert.throws(() => guardDependency(staging(['files:put']), 'other')('put'), WriteRefused);
    assert.equal(isAllowedDependencyWrite('files', 'put', ['files:*']), false, 'no wildcards');
  });

  it('accept dependency:operation entries in allowWrites, alongside METHOD /template', () => {
    assert.deepEqual(parseAllowWrites(['POST /login', 'events:publish', '/x'], 'w'), [
      'POST /login',
      'events:publish',
      '/x',
    ]);
    assert.throws(() => parseAllowWrites(['events publish'], 'w'), /dependency:operation/);
    assert.throws(() => parseAllowWrites(['events:'], 'w'), /dependency:operation/);
  });

  it('tell plain reads from SQL that writes', () => {
    for (const sql of [
      'SELECT * FROM t WHERE id = ?',
      '  select 1',
      'SHOW TABLES',
      'EXPLAIN SELECT 1',
      'WITH a AS (SELECT 1) SELECT * FROM a',
      '(SELECT 1)',
      "SELECT * FROM t WHERE note = 'delete; update' -- a comment; DELETE",
      'SELECT `update`, `delete` FROM t',
    ])
      assert.ok(isReadOnlySql(sql), sql);
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'update t set a = 1',
      'DELETE FROM t',
      'DROP TABLE t',
      'SELECT 1; DELETE FROM t',
      'SELECT * FROM t FOR UPDATE',
      "SELECT * INTO OUTFILE '/tmp/x' FROM t",
      'WITH a AS (DELETE FROM t RETURNING *) SELECT * FROM a',
      '/* SELECT */ DELETE FROM t',
      'CALL p()',
      '',
      // Seen against a live MySQL: a string or comment that hid a second statement, or a file the server wrote.
      "SELECT '#'; SET SESSION TRANSACTION READ WRITE; DELETE FROM t",
      "SELECT '/*'; SET SESSION TRANSACTION READ WRITE; DELETE FROM t; SELECT '*/'",
      "SELECT * FROM t /*! INTO OUTFILE '/tmp/x' */",
      "WITH a AS (SELECT * FROM t) SELECT * FROM a INTO OUTFILE '/tmp/x'",
      'EXPLAIN ANALYZE DELETE FROM t',
      "SELECT 'unterminated",
    ])
      assert.ok(!isReadOnlySql(sql), sql);
  });

  describe('against a counting stand-in', () => {
    let stand: Awaited<ReturnType<typeof counting>>;
    before(async () => {
      stand = await counting();
    });
    after(() => stand.server.close());

    it('S3: put and create-bucket are refused before they are sent; reads go through; an allowed put is sent', async () => {
      stand.seen.length = 0;
      const store = new S3Store({ endpoint: stand.url }, guardDependency(staging(), 'files'));
      await assert.rejects(store.put('b', 'k', 'x'), WriteRefused);
      await assert.rejects(store.createBucket('b'), WriteRefused);
      assert.deepEqual(writes(stand.seen), []);
      await store.exists('b', 'k');
      assert.equal(stand.seen.length, 1, 'a read reaches the store');
      await new S3Store({ endpoint: stand.url }, guardDependency(staging(['files:put']), 'files')).put('b', 'k', 'x');
      assert.deepEqual(writes(stand.seen), ['PUT /b/k']);
    });

    it('SQS: send, create and receive (which deletes) are refused; an allowed send is sent', async () => {
      stand.seen.length = 0;
      const queues = new SqsQueues({ endpoint: stand.url }, guardDependency(staging(), 'aws'));
      await assert.rejects(queues.send('q', { a: 1 }), WriteRefused);
      await assert.rejects(queues.create('q'), WriteRefused);
      await assert.rejects(queues.receive('q'), WriteRefused);
      assert.deepEqual(stand.seen, []);
      await new SqsQueues({ endpoint: stand.url }, guardDependency(staging(['aws:send']), 'aws')).send('q', 'x');
      assert.ok(stand.seen.length > 0, 'the allowed send reached the queue');
    });

    it('mail: clearing the inbox is refused; reading it is not', async () => {
      stand.seen.length = 0;
      const inbox = new Inbox(stand.url, guardDependency(staging(), 'mail'));
      await assert.rejects(inbox.clear(), WriteRefused);
      assert.deepEqual(stand.seen, []);
    });
  });

  it('RabbitMQ: publish, take and spy are refused before the channel sees them', async () => {
    const calls: string[] = [];
    const channel = new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          calls.push(String(prop));
          return Promise.resolve({ queue: 'q', consumerTag: 'c' });
        },
      },
    );
    const Ctor = AmqpBroker as unknown as new (connection: unknown, channel: unknown, guard: unknown) => AmqpBroker;
    const broker = new Ctor({}, channel, guardDependency(staging(), 'broker'));
    assert.throws(() => broker.publish('x', 'k', { a: 1 }), WriteRefused);
    await assert.rejects(broker.take('q'), WriteRefused);
    await assert.rejects(broker.spy('x'), WriteRefused);
    assert.deepEqual(calls, []);
    new Ctor({}, channel, guardDependency(staging(['broker:publish']), 'broker')).publish('x', 'k', 'y');
    assert.deepEqual(calls, ['publish']);
  });

  it('MySQL: a writing statement is refused before the pool sees it; a read-only session is requested', async () => {
    const queries: string[] = [];
    const pool = { query: (sql: string) => (queries.push(sql), Promise.resolve([[]])), end: () => Promise.resolve() };
    const Ctor = MySqlDb as unknown as new (pool: unknown, guard: unknown) => MySqlDb;
    const db = new Ctor(pool, guardDependency(staging(), 'orders'));
    await assert.rejects(db.rows('DELETE FROM orders'), WriteRefused);
    await db.rows('SELECT 1');
    assert.deepEqual(queries, ['SELECT 1']);
    // connect() with readOnly registers the session switch on every new connection (no server needed to see it).
    // A read-only session runs one statement per query, whatever the URL asks for.
    assert.equal(
      singleStatements('mysql://u:p%40ss@h:3306/db?multipleStatements=true&flags=%2BMULTI_STATEMENTS&ssl=x'),
      'mysql://u:p%40ss@h:3306/db?ssl=x',
    );
    assert.equal(singleStatements('mysql://u:p@h/db'), 'mysql://u:p@h/db');
    const ro = MySqlDb.connect('mysql://u:p@127.0.0.1:1/db?multipleStatements=true', { readOnly: true });
    assert.equal(
      (ro as unknown as { pool: { pool: { config: { connectionConfig: { multipleStatements: boolean } } } } }).pool.pool
        .config.connectionConfig.multipleStatements,
      false,
    );
    const core = (ro as unknown as { pool: { pool: { listenerCount(e: string): number } } }).pool.pool;
    assert.equal(core.listenerCount('connection'), 1);
    await ro.close();
  });
});

describe('raw guard: a test opening its own connection', () => {
  let env: Awaited<ReturnType<typeof counting>>;
  let other: Awaited<ReturnType<typeof counting>>;
  before(async () => {
    [env, other] = await Promise.all([counting(), counting()]);
  });
  after(() => [env, other].forEach((s) => s.server.close()));

  /** A node request to the end: its status, or the error it ended with. */
  const node = (make: () => ClientRequest) =>
    new Promise<number>((done, fail) => {
      const req = make();
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => done(res.statusCode ?? 0));
      });
      req.on('error', fail);
      req.end();
    });

  it('judges every write by where it really goes, however the test makes it, and lets the framework through', async () => {
    // A spec file's module scope runs before the worker fixture installs the guard.
    const earlyFetch = globalThis.fetch;
    const earlyRequest = http.request;
    const restore = installRawGuard(
      staging(['POST /login', 'POST /login-then-notes', 'POST /orders/{id}/cancel']),
      { baseUrl: `${env.url}/api` },
      { readOnlyPaths: '/search$' },
    );
    const port = new URL(env.url).port;
    const ctx = await playwrightRequest.newContext();
    try {
      await assert.rejects(fetch(`${env.url}/api/notes`, { method: 'POST', body: '{}' }), WriteRefused);
      await assert.rejects(earlyFetch(`${env.url}/api/notes`, { method: 'POST' }), /fetch failed/);
      await assert.rejects(fetch(new Request(`${env.url}/api/notes/1`, { method: 'DELETE' })), WriteRefused);
      await assert.rejects(
        fetch(`${env.url}/api/notes`, { headers: [['X-HTTP-Method-Override', 'DELETE']] }),
        WriteRefused,
      );
      await assert.rejects(
        fetch(new Request(`${env.url}/api/notes`, { headers: { 'X-HTTP-Method-Override': 'DELETE' } })),
        WriteRefused,
      );
      await assert.rejects(fetch(`${env.url}/api/search/../notes`, { method: 'POST' }), WriteRefused);
      await assert.rejects(fetch(`${env.url}/api/login-then-notes`, { method: 'POST', body: 'x' }), WriteRefused);
      // The environment under another name, or any other host: a write there is refused.
      await assert.rejects(fetch(`http://localhost:${port}/api/notes`, { method: 'POST' }), WriteRefused);
      await assert.rejects(fetch(`http://[::ffff:127.0.0.1]:${port}/api/notes`, { method: 'POST' }), WriteRefused);
      await assert.rejects(fetch(`${other.url}/anything`, { method: 'POST' }), WriteRefused);

      await assert.rejects(
        node(() => http.request(`${env.url}/api/notes`, { method: 'PUT' })),
        WriteRefused,
      );
      await assert.rejects(
        node(() => earlyRequest(`${env.url}/api/notes`, { method: 'POST' })),
        WriteRefused,
      );
      await assert.rejects(
        node(() =>
          http.request('http://elsewhere.invalid/', {
            hostname: '127.0.0.1',
            port,
            path: '/api/notes',
            method: 'POST',
          }),
        ),
        WriteRefused,
      );
      await assert.rejects(
        new Promise((done, fail) => http.get(`${env.url}/api/notes`, { method: 'DELETE' }, done).on('error', fail)),
        WriteRefused,
      );
      await assert.rejects(
        node(() => new http.ClientRequest({ host: '127.0.0.1', port, path: '/api/notes', method: 'POST' })),
        WriteRefused,
      );
      await assert.rejects(
        node(() => {
          const req = http.request(`${env.url}/api/notes`);
          req.setHeader('X-HTTP-Method-Override', 'DELETE');
          return req;
        }),
        WriteRefused,
      );
      await assert.rejects(ctx.post(`${env.url}/api/orders/7/cancel`), /write refused/);
      assert.deepEqual(env.seen, ['POST /api/login-then-notes'], 'the allowed first hop only');
      assert.deepEqual(other.seen, []);

      await fetch(`${env.url}/api/notes`);
      await fetch(`${env.url}/api/search`, { method: 'POST' });
      await fetch(`${env.url}/api/login`, { method: 'POST' });
      assert.equal(await node(() => http.request(`${env.url}/api/notes`)), 200);
      await fetch(`${other.url}/anything`);
      // The framework's own calls are judged by their own rule (the client's by the operation's template).
      await asFramework(() => ctx.post(`${env.url}/api/orders/7/cancel`));
      await frameworkFetch(`${env.url}/api/stubbed`, { method: 'PUT' });
      assert.deepEqual(env.seen, [
        'POST /api/login-then-notes',
        'GET /api/notes',
        'POST /api/search',
        'POST /api/login',
        'GET /api/notes',
        'POST /api/orders/7/cancel',
        'PUT /api/stubbed',
      ]);
      assert.deepEqual(other.seen, ['GET /anything'], 'reading another host is untouched');
    } finally {
      await ctx.dispose();
      restore();
    }
    await fetch(`${env.url}/api/notes`, { method: 'POST' });
    assert.equal(env.seen.at(-1), 'POST /api/notes', 'removed afterwards');
  });

  it('is a no-op in a disposable environment', () => {
    const before = globalThis.fetch;
    const restore = installRawGuard(local, { baseUrl: env.url });
    assert.equal(globalThis.fetch, before);
    restore();
  });
});

describe('load and fuzzing on a shared environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-load-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const framework = join(import.meta.dirname, '..');

  /** A project with one service whose environments are `local` (disposable) and `staging` (not). */
  function project(allowLoad?: boolean): string {
    const root = mkdtempSync(join(dir, 'p-'));
    const svc = join(root, 'services', 'svc');
    mkdirSync(join(svc, 'perf'), { recursive: true });
    writeFileSync(join(root, 'vgate.yaml'), 'version: 0.0.0\nservicesDir: services\n');
    writeFileSync(join(svc, 'openapi.yaml'), 'openapi: 3.1.0\ninfo: { title: t, version: "1" }\npaths: {}\n');
    writeFileSync(join(svc, 'perf', 'smoke.ts'), 'export default function () {}\n');
    writeFileSync(
      join(svc, 'service.yaml'),
      [
        'name: svc',
        'spec: openapi.yaml',
        'schemathesis: { readOnlyMethods: [GET], users: [reader] }',
        'environments:',
        '  local: { disposable: true, baseUrl: "http://127.0.0.1:1", users: { reader: { token: t } } }',
        `  staging: { disposable: false, baseUrl: "http://127.0.0.1:1", users: { reader: { token: t } }${allowLoad === undefined ? '' : `, allowLoad: ${allowLoad}`} }`,
      ].join('\n'),
    );
    return root;
  }

  /** Fake k6 and uvx on PATH: each leaves a marker when it is started. */
  function fakeTools(): { bin: string; ran: (tool: string) => boolean } {
    const bin = mkdtempSync(join(dir, 'bin-'));
    for (const tool of ['k6', 'uvx']) {
      writeFileSync(join(bin, tool), `#!/bin/sh\ntouch "${bin}/${tool}.ran"\nexit 0\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    return { bin, ran: (tool) => existsSync(join(bin, `${tool}.ran`)) };
  }

  const run = (script: string, root: string, envName: string, bin: string, args: string[] = []) =>
    spawnSync(process.execPath, ['--import', 'tsx', join(framework, 'cli', script), '--service', 'svc', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        VGATE_PROJECT: root,
        TEST_ENV: envName,
        SERVICE: 'svc',
        PATH: `${bin}:${process.env.PATH}`,
      },
    });

  it('refuses k6 on a shared environment unless allowLoad: true; a disposable one runs it', () => {
    let tools = fakeTools();
    const refused = run('perf.ts', project(), 'staging', tools.bin);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /allowLoad: true/);
    assert.equal(tools.ran('k6'), false, 'k6 never started');

    tools = fakeTools();
    assert.equal(run('perf.ts', project(true), 'staging', tools.bin).status, 0);
    assert.equal(tools.ran('k6'), true);

    tools = fakeTools();
    assert.equal(run('perf.ts', project(), 'local', tools.bin).status, 0);
    assert.equal(tools.ran('k6'), true);
  });

  it('refuses Schemathesis fuzzing (every operation) on a shared environment before uvx starts', () => {
    const tools = fakeTools();
    const refused = run('schemathesis.ts', project(), 'staging', tools.bin, ['--mode', 'full']);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /not disposable/);
    assert.equal(tools.ran('uvx'), false);
  });
});

describe("the framework's own door", () => {
  it('is closed to test code: the lint step refuses importing it in a service', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const config = (await import(pathToFileURL(join(root, 'eslint.config.js')).href)) as { default: Linter.Config[] };
    const blocks = config.default.filter((block) => block.rules?.['no-restricted-imports'] !== undefined);
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: blocks });
    const services = process.env.VGATE_SERVICES_DIR ?? 'services';
    const lint = async (code: string, file: string) =>
      (await eslint.lintText(code, { filePath: join(root, services, 'svc', file) }))[0].messages.map((m) => m.ruleId);
    for (const name of ['frameworkFetch', 'asFramework', 'unguarded'])
      for (const from of ['@vgate/framework/http/write-guard.ts', '../../../framework/http/write-guard'])
        assert.deepEqual(
          await lint(`import { ${name} } from '${from}';\n`, 'tests/a.spec.ts'),
          ['no-restricted-imports'],
          `${name} from ${from}`,
        );
    assert.deepEqual(
      await lint("import { WriteRefused } from '@vgate/framework/http/write-guard.ts';\n", 'support/x.ts'),
      [],
    );
  });
});

describe('the raw guard in a real Playwright run', () => {
  it('holds from the spec module scope on, lets the client make a write its template allows, refuses the rest', async () => {
    const runtime = join(import.meta.dirname, '..', '..');
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(req.method === 'GET' ? '[]' : '{}'),
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), 'vgate-raw-guard-'));
    try {
      const svc = join(dir, 'services', 'shop');
      mkdirSync(join(svc, 'tests'), { recursive: true });
      writeFileSync(join(dir, 'vgate.yaml'), 'version: 0.0.0\nservicesDir: services\n');
      writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
      const ok = "{ '200': { description: ok, content: { application/json: { schema: {} } } } }";
      writeFileSync(
        join(svc, 'openapi.yaml'),
        [
          'openapi: 3.1.0',
          'info: { title: shop, version: "1" }',
          'paths:',
          `  /orders: { get: { operationId: listOrders, responses: ${ok} } }`,
          '  /orders/{id}/cancel:',
          `    post: { operationId: cancelOrder, parameters: [{ name: id, in: path, required: true, schema: { type: string } }], responses: ${ok} }`,
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(svc, 'service.yaml'),
        [
          'name: shop',
          'spec: openapi.yaml',
          'environments:',
          '  staging:',
          '    disposable: false',
          `    baseUrl: ${base}`,
          '    healthPath: /orders',
          '    users: { reader: { token: t } }',
          "    allowWrites: ['POST /orders/{id}/cancel']",
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(svc, 'tests', 'a.spec.ts'),
        [
          `import { createTest, expect } from ${JSON.stringify(join(runtime, 'framework', 'fixtures.ts'))};`,
          'const test = createTest();',
          '// Module scope: runs in the runner (listing the tests) and in the worker, before any fixture.',
          `await fetch('${base}/orders', { method: 'POST' }).catch(() => undefined);`,
          "test('client', async ({ api }) => {",
          "  const res = await api.as('reader').send('POST', '/orders/{id}/cancel', { params: { id: '7' }, validate: false });",
          '  expect(res.status).toBe(200);',
          '});',
          "test('own', async ({ request }) => {",
          `  await expect(fetch('${base}/orders/8/cancel', { method: 'POST' })).rejects.toThrow(/write refused/);`,
          `  await expect(request.post('${base}/orders/9/cancel')).rejects.toThrow(/write refused/);`,
          '});',
          '',
        ].join('\n'),
      );
      const run = await new Promise<{ code: number | null; out: string }>((done) => {
        const child = spawn(
          join(runtime, 'node_modules', '.bin', 'playwright'),
          ['test', '--config', join(runtime, 'playwright.config.ts'), '--project', 'api', '--reporter', 'line'],
          {
            cwd: runtime,
            env: {
              ...process.env,
              VGATE_PROJECT: dir,
              VGATE_SERVICES_DIR: 'services',
              VGATE_REPORTS: join(dir, 'reports'),
              SERVICE: 'shop',
              TEST_ENV: 'staging',
              WORKERS: '1',
              RUN_ID: 'raw',
            },
          },
        );
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.on('close', (code) => done({ code, out }));
      });
      assert.equal(run.code, 0, run.out.slice(-3000));
      assert.deepEqual(writes(seen), ['POST /orders/7/cancel'], 'only the write the client was allowed');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

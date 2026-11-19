import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { request } from '@playwright/test';
import { Auth } from '../auth/auth.ts';
import type { EnvelopeRules, EnvironmentConfig, ServiceConfig } from '../config.ts';
import { ApiClient, ApiResult, CallRecorder, queryString, type SuccessData } from './client.ts';
import { OpenApiContract } from './openapi.ts';
import { installRawGuard } from './write-guard.ts';

// A REST service that knows nothing of any real backend: GET with query parameters, DELETE, an API key in X-Api-Key, no
// envelope. `GET /items?bad=...` misbehaves on demand so the checks can be seen to fail.
const spec = {
  openapi: '3.1.0',
  paths: {
    '/items': {
      get: {
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'tag', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Item' } } },
            },
          },
          '401': { description: 'No API key' },
        },
      },
    },
    '/items/{id}': { delete: { responses: { '204': { description: 'Deleted' } } } },
    // Answers errors the way many APIs do, as `{ error: { code, message } }`: the code is not a top-level field.
    '/orders/{id}': { get: { responses: { '404': { description: 'ORD404 when there is no such order' } } } },
  },
  components: {
    schemas: {
      Item: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, at: { type: 'string' } } },
    },
  },
};

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

const seen: Seen[] = [];
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
  const url = new URL(req.url ?? '/', 'http://x');
  res.setHeader('X-Request-Id', '3f1c2b9e-0000-4000-8000-000000000000');
  if (req.headers['x-api-key'] !== 'k-reader') {
    res.writeHead(401).end();
    return;
  }
  if (url.pathname.startsWith('/orders/')) {
    res
      .writeHead(404, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: { code: 'ORD404', message: 'no such order' } }));
    return;
  }
  if (req.method === 'DELETE') {
    res.writeHead(204).end();
    return;
  }
  const bad = url.searchParams.get('bad');
  if (bad === 'status') {
    res.writeHead(500).end();
    return;
  }
  const item =
    bad === 'field'
      ? { id: '1', extra: true }
      : bad === 'offset'
        ? { id: '1', at: '2026-11-13T03:00:00' }
        : { id: '1', at: '2026-11-13T03:00:00Z' };
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([item]));
});

let env: EnvironmentConfig;
let svc: ServiceConfig;
const contract = new OpenApiContract(structuredClone(spec), { strictResponseProperties: true });

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  env = {
    name: 'selftest',
    baseUrl: `http://127.0.0.1:${port}`,
    auth: { header: 'X-Api-Key', scheme: '' },
    users: { reader: { token: 'k-reader' }, nobody: {} },
    disposable: true,
  };
  svc = {
    name: 'selftest',
    dir: '.',
    specPath: '',
    rules: {
      headers: { always: { 'X-Request-Id': '/^[0-9a-f-]{36}$/' } },
      datetimeOffset: 'Z',
      strictResponseProperties: true,
    },
    coverage: { exclude: [] },
    schemathesis: {},
    env,
  };
});

after(() => {
  server.close();
});

async function client() {
  const ctx = await request.newContext();
  const recorder = new CallRecorder(undefined, 'selftest');
  return { ctx, recorder, api: new ApiClient(ctx, svc, contract, new Auth(env), recorder) };
}

/** Runs `fn` and returns the assertion message it failed with (the client fails the call through expect). */
async function failure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail('expected the call to fail its checks');
}

describe('queryString', () => {
  it('repeats array keys, drops undefined, encodes values', () => {
    assert.equal(
      queryString({ limit: 5, tag: ['a', 'b c'], skip: undefined, ok: true }),
      '?limit=5&tag=a&tag=b+c&ok=true',
    );
    assert.equal(queryString({}), '');
    assert.equal(queryString(undefined), '');
  });
});

describe('ApiClient', () => {
  it('sends a static API key under the configured header, the query, and records the call', async () => {
    const { ctx, api, recorder } = await client();
    const res = await api.as('reader').send('GET', '/items', { query: { limit: 2, tag: ['x', 'y'] } });
    assert.equal(res.status, 200);
    const last = seen.at(-1);
    assert.equal(last?.headers['x-api-key'], 'k-reader');
    assert.equal(last?.headers.authorization, undefined);
    assert.equal(last?.url, '/items?limit=2&tag=x&tag=y');
    assert.deepEqual(
      recorder.calls.map((c) => [c.method, c.path, c.status, c.validated]),
      [['GET', '/items', 200, true]],
    );
    await ctx.dispose();
  });

  it('expands path parameters and accepts a documented 204', async () => {
    const { ctx, api } = await client();
    const res = await api.as('reader').send('DELETE', '/items/{id}', { params: { id: 'a/b' } });
    assert.equal(res.status, 204);
    assert.equal(seen.at(-1)?.url, '/items/a%2Fb');
    await ctx.dispose();
  });

  it('in a shared environment, makes a write its allowWrites template allows, with the raw guard on', async () => {
    // The raw guard judges a test's own requests by their concrete path: the client's call, judged by its template,
    // must not be refused a second time (`/items/7` is not the template `/items/{id}`).
    const shared = { ...env, disposable: false, allowWrites: ['DELETE /items/{id}'] };
    const restore = installRawGuard(shared, { baseUrl: env.baseUrl });
    const ctx = await request.newContext();
    try {
      const api = new ApiClient(
        ctx,
        { ...svc, env: shared },
        contract,
        new Auth(shared),
        new CallRecorder(undefined, 'selftest'),
      );
      const res = await api.as('reader').send('DELETE', '/items/{id}', { params: { id: '7' } });
      assert.equal(res.status, 204);
      assert.equal(seen.at(-1)?.url, '/items/7');
      await assert.rejects(ctx.delete(`${env.baseUrl}/items/7`), /write refused/, 'the same request from a test');
    } finally {
      await ctx.dispose();
      restore();
    }
  });

  it('calls anonymously for a user without credentials', async () => {
    const { ctx, api } = await client();
    const res = await api.as('nobody').send('GET', '/items');
    assert.equal(res.status, 401);
    assert.equal(seen.at(-1)?.headers['x-api-key'], undefined);
    await ctx.dispose();
  });

  it('fails a call whose response breaks the contract, the header rules or the datetime rule', async () => {
    const { ctx, api } = await client();
    const reader = api.as('reader');
    assert.match(
      await failure(() => reader.send('GET', '/items', { query: { bad: 'field' } })),
      /unevaluated properties .*extra/,
    );
    assert.match(
      await failure(() => reader.send('GET', '/items', { query: { bad: 'status' } })),
      /status 500 is not documented/,
    );
    assert.match(await failure(() => reader.send('GET', '/items', { query: { bad: 'offset' } })), /lacks offset Z/);
    await ctx.dispose();
  });

  it('skips every check for a call made outside the contract on purpose', async () => {
    const { ctx, api, recorder } = await client();
    const res = await api.as('reader').send('GET', '/items', { query: { bad: 'status' }, validate: false });
    assert.equal(res.status, 500);
    assert.equal(recorder.calls[0]?.validated, false);
    await ctx.dispose();
  });

  it('names an unknown seeded user and the ones that exist', () => {
    assert.throws(
      () => new Auth(env).forUser('ghost'),
      /User "ghost" is not in service.yaml .* \(have: reader, nobody\)/,
    );
  });

  it('refuses a password user in an environment without Keycloak', async () => {
    const auth = new Auth({ ...env, users: { pw: { password: 'x' } } });
    await assert.rejects(auth.forUser('pw')(), /has no keycloak/);
  });
});

/** A response as the client builds it, without a server: the envelope rules are all that decide `code` and the data. */
function result(status: number, body: unknown, envelope: EnvelopeRules) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return new ApiResult('GET', '/x', status, {}, text, body, envelope);
}

describe('ApiResult envelope fields', () => {
  const nested = { codeField: 'status.code', dataField: 'result.data', successCode: 'OK', codePattern: 'E\\d{3}' };

  it('reads a dotted codeField from the nested object, and expectError checks it', () => {
    const res = result(404, { status: { code: 'E404' } }, nested);
    assert.equal(res.code, 'E404');
    assert.deepEqual(res.expectError(404, 'E404'), { status: { code: 'E404' } });
    assert.throws(() => res.expectError(404, 'E500'), /E500/);
  });

  it('gives no code, and never throws, when a step of the path is missing or not an object', () => {
    for (const body of [{}, { status: null }, { status: 'E404' }, { status: { other: 1 } }, 'not json', undefined]) {
      const res = result(404, body, nested);
      assert.equal(res.code, undefined, JSON.stringify(body));
      assert.doesNotThrow(() => res.expectError(404));
      assert.throws(() => res.expectError(404, 'E404'));
    }
  });

  it('returns the dotted dataField from expectSuccess, after checking the nested success code', () => {
    const body = { status: { code: 'OK' }, result: { data: { id: '1' } } };
    assert.deepEqual(result(200, body, nested).expectSuccess(), { id: '1' });
    assert.throws(() => result(200, { ...body, status: { code: 'E500' } }, nested).expectSuccess(), /OK/);
  });

  it('reads a top-level field name exactly as before', () => {
    const flat = { codeField: 'code', dataField: 'data', successCode: 'OK', codePattern: 'E\\d{3}' };
    const res = result(200, { code: 'OK', data: { id: '1' } }, flat);
    assert.equal(res.code, 'OK');
    assert.deepEqual(res.expectSuccess(), { id: '1' });
    assert.equal(result(400, { code: 7 }, flat).code, undefined, 'a code that is not a string is no code');
    assert.equal(result(400, ['E400'], flat).code, undefined);
  });

  it('with only a codeField, holds a success to its status and returns the whole body', () => {
    // An API whose errors carry `{ error: { code } }` and whose successes are the resource itself.
    const errorsOnly = { codeField: 'error.code', codePattern: 'ORD\\d{3}' };
    assert.deepEqual(result(200, { id: '1' }, errorsOnly).expectSuccess(), { id: '1' });
    assert.equal(result(404, { error: { code: 'ORD404' } }, errorsOnly).code, 'ORD404');
  });

  it('with only a codeField, refuses a 2xx that carries an error code', () => {
    // An error body sent with 200 is not a success, though no successCode is declared to compare it with.
    const errorsOnly = { codeField: 'error.code', codePattern: 'ORD\\d{3}' };
    assert.throws(() => result(200, { error: { code: 'ORD500' } }, errorsOnly).expectSuccess(), /ORD500/);
  });
});

describe('ApiClient with a dotted codeField', () => {
  it('records the nested code in the observed-coverage feed, which attributes the response to its code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vgate-client-'));
    const observed = join(dir, 'observed.jsonl');
    const ctx = await request.newContext();
    try {
      const withEnvelope = {
        ...svc,
        rules: { ...svc.rules, envelope: { codeField: 'error.code', codePattern: 'ORD\\d{3}' } },
      };
      const recorder = new CallRecorder(observed, 'orders');
      const api = new ApiClient(ctx, withEnvelope, contract, new Auth(env), recorder);
      (await api.as('reader').send('GET', '/orders/{id}', { params: { id: '9' } })).expectError(404, 'ORD404');
      assert.deepEqual(JSON.parse(readFileSync(observed, 'utf8')), {
        method: 'GET',
        path: '/orders/{id}',
        status: 404,
        code: 'ORD404',
        validated: true,
        test: 'orders',
      });
    } finally {
      await ctx.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Type-level checks, enforced by tsc (the selftest's type-check), not at run time: what expectSuccess is typed to return.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
interface Op {
  responses: {
    200: { content: { 'application/json': { data: number; result: { data: { id: string } } } } };
    404: { content: { 'application/json': { error: { code: string } } } };
  };
}
type Body = Op['responses'][200]['content']['application/json'];
export const successDataTypes: [
  // Undeclared: the body's `data` when the contract types one (the type before the envelope could be declared).
  Equal<SuccessData<Op>, number>,
  // No envelope: the whole body, whatever fields it has.
  Equal<SuccessData<Op, null>, Body>,
  // The envelope's dataField, a dotted path into the body.
  Equal<SuccessData<Op, 'data'>, number>,
  Equal<SuccessData<Op, 'result.data'>, { id: string }>,
  // A path the contract does not type: nothing is promised.
  Equal<SuccessData<Op, 'result.missing'>, unknown>,
] = [true, true, true, true, true];

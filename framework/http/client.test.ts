import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { request } from '@playwright/test';
import { Auth } from '../auth/auth.ts';
import type { EnvironmentConfig, ServiceConfig } from '../config.ts';
import { ApiClient, CallRecorder, queryString } from './client.ts';
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

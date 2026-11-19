import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { request } from '@playwright/test';
import { Auth } from '../auth/auth.ts';
import { keycloakOf } from '../auth/keycloak.ts';
import type { EnvironmentConfig, ServiceConfig } from '../config.ts';
import { Db } from '../db/postgres.ts';
import { ApiClient, CallRecorder } from './client.ts';
import { OpenApiContract } from './openapi.ts';
import { guardRequest, guardWrite, isAllowedWrite, isPlainPath, isReadOnly, WriteRefused } from './write-guard.ts';

describe('write guard: what counts as read-only', () => {
  it('reads GET, HEAD and OPTIONS as read-only, and no other method', () => {
    for (const method of ['GET', 'head', 'OPTIONS']) assert.ok(isReadOnly(method, '/items'), method);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.ok(!isReadOnly(method, '/items'), method);
  });

  it("takes the service's readOnlyPaths / readOnlyMethods: an API that reads through POST", () => {
    assert.ok(isReadOnly('POST', '/items/search', { readOnlyPaths: '/search$' }));
    assert.ok(!isReadOnly('POST', '/items', { readOnlyPaths: '/search$' }));
    // Both given: an operation must match both.
    assert.ok(!isReadOnly('DELETE', '/items/search', { readOnlyPaths: '/search$', readOnlyMethods: ['POST'] }));
    assert.ok(isReadOnly('POST', '/items/search', { readOnlyPaths: '/search$', readOnlyMethods: ['post'] }));
  });

  it('allows a listed write, by METHOD and template or by template alone', () => {
    const allow = ['POST /auth/login', '/feedback'];
    assert.ok(isAllowedWrite('post', '/auth/login', allow));
    assert.ok(!isAllowedWrite('DELETE', '/auth/login', allow));
    assert.ok(isAllowedWrite('PUT', '/feedback', allow));
    assert.ok(!isAllowedWrite('POST', '/auth/login/extra', allow));
  });

  it('never guards a disposable environment, always guards a shared one', () => {
    assert.doesNotThrow(() => guardWrite({ name: 'local', disposable: true }, 'DELETE', '/items/{id}'));
    assert.throws(
      () => guardWrite({ name: 'staging', disposable: false }, 'DELETE', '/items/{id}'),
      (error: unknown) =>
        error instanceof WriteRefused &&
        /write refused in environment staging: DELETE \/items\/\{id\}/.test(error.message),
    );
    assert.doesNotThrow(() =>
      guardWrite({ name: 'staging', disposable: false, allowWrites: ['POST /auth/login'] }, 'POST', '/auth/login'),
    );
  });

  it('judges the path that goes out: no `..`, query or encoded slash past a read-only or allowed operation', () => {
    for (const path of ['/items/search/../../items', '/items/search/%2E%2e/x', '/x?y=/search', '/a\\..\\b', '/a%2fb'])
      assert.ok(!isPlainPath(path), path);
    assert.ok(isPlainPath('/items/{id}/search'));
    const staging = { name: 'staging', disposable: false, allowWrites: ['POST /auth/{tenant}/login'] };
    const readOnly = { readOnlyPaths: '^/items/search' };
    assert.throws(() => guardWrite(staging, 'POST', '/items/search/../../items', readOnly), WriteRefused);
    assert.doesNotThrow(() => guardWrite(staging, 'POST', '/items/search', readOnly));
    // A parameter that walks out of the allowed operation.
    assert.throws(
      () => guardWrite(staging, 'POST', '/auth/{tenant}/login', {}, { path: '/auth/../login' }),
      WriteRefused,
    );
    assert.doesNotThrow(() => guardWrite(staging, 'POST', '/auth/{tenant}/login', {}, { path: '/auth/acme/login' }));
    // A read is a read wherever it goes.
    assert.doesNotThrow(() => guardWrite(staging, 'GET', '/items/search/../x'));
  });

  it('judges a method-override header as the method it names', () => {
    const staging = { name: 'staging', disposable: false };
    for (const name of ['X-HTTP-Method-Override', 'x-http-method', 'X-Method-Override'])
      assert.throws(() => guardWrite(staging, 'GET', '/items', {}, { headers: { [name]: 'DELETE' } }), WriteRefused);
    assert.doesNotThrow(() =>
      guardWrite(staging, 'GET', '/items', {}, { headers: { 'X-HTTP-Method-Override': 'GET' } }),
    );
  });
});

// The guard in its place: a client against a shared environment sends a read, and refuses a write before it is sent.
const seen: string[] = [];
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  seen.push(`${req.method} ${req.url}`);
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(req.method === 'GET' ? 200 : 201).end(JSON.stringify(req.method === 'GET' ? [] : { id: '1' }));
});
const spec = {
  openapi: '3.1.0',
  paths: {
    '/items': {
      get: {
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array' } } } },
        },
      },
      post: {
        responses: {
          '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    },
  },
};
let env: EnvironmentConfig;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  env = { name: 'staging', baseUrl: `http://127.0.0.1:${port}`, users: { anon: {} }, disposable: false };
});
after(() => server.close());

function clientFor(environment: EnvironmentConfig, schemathesis: ServiceConfig['schemathesis'] = {}) {
  const svc: ServiceConfig = {
    name: 'guarded',
    dir: '.',
    specPath: '',
    rules: {},
    coverage: { exclude: [] },
    schemathesis,
    env: environment,
  };
  return request.newContext().then((ctx) => ({
    ctx,
    api: new ApiClient(
      ctx,
      svc,
      new OpenApiContract(structuredClone(spec)),
      new Auth(environment),
      new CallRecorder(undefined, 't'),
    ),
  }));
}

describe('write guard: in the client', () => {
  it('sends a read to a shared environment, and refuses a write before anything leaves the machine', async () => {
    seen.length = 0;
    const { ctx, api } = await clientFor(env);
    await api.anonymous().send('GET', '/items');
    await assert.rejects(
      api.anonymous().send('POST', '/items', { body: { name: 'x' } }),
      /write refused in environment staging: POST \/items/,
    );
    await assert.rejects(api.anonymous().send('DELETE', '/items', { validate: false }), WriteRefused);
    await ctx.dispose();
    assert.deepEqual(seen, ['GET /items'], 'only the read reached the server');
  });

  it('refuses a write spelled as a read-only path, a spoofed method, or through the raw request context', async () => {
    seen.length = 0;
    const { ctx, api } = await clientFor(env, { readOnlyPaths: '^/items/search' });
    await assert.rejects(api.anonymous().send('POST', '/items/search/../../items', { validate: false }), WriteRefused);
    await assert.rejects(
      api.anonymous().send('POST', '/items/search/{a}/{b}/items', { validate: false, params: { a: '..', b: '..' } }),
      WriteRefused,
    );
    await assert.rejects(
      api.anonymous().send('GET', '/items', { headers: { 'X-HTTP-Method-Override': 'DELETE' } }),
      WriteRefused,
    );
    // Playwright's request fixture, as a test that skips the client would use it.
    const raw = guardRequest(ctx, env);
    await assert.rejects(raw.post(`${env.baseUrl}/items`, { data: {} }), WriteRefused);
    await assert.rejects(raw.fetch(`${env.baseUrl}/items`, { method: 'delete' }), WriteRefused);
    await assert.rejects(raw.post('http://localhost:1/items', { data: {} }), WriteRefused);
    await raw.get(`${env.baseUrl}/items`);
    await guardRequest(ctx, { ...env, allowWrites: ['POST /items'] }).post(`${env.baseUrl}/items`, { data: {} });
    await ctx.dispose();
    assert.deepEqual(seen, ['GET /items', 'POST /items'], 'only the read and the allowed write reached the server');
  });

  it('lets the same write through in a disposable environment, or when allowWrites lists it', async () => {
    for (const environment of [
      { ...env, disposable: true },
      { ...env, allowWrites: ['POST /items'] },
    ]) {
      seen.length = 0;
      const { ctx, api } = await clientFor(environment);
      await api.anonymous().send('POST', '/items', { body: { name: 'x' } });
      await ctx.dispose();
      assert.deepEqual(seen, ['POST /items']);
    }
  });
});

describe("write guard: a shared environment's other doors", () => {
  it('opens its database read-only', async () => {
    const options = (db: Db) => (db as unknown as { pool: { options: { options?: string } } }).pool.options.options;
    const shared = new Db({ url: 'postgres://u@127.0.0.1:1/db', schema: 'app' }, { readOnly: true });
    assert.equal(options(shared), '-c search_path=app -c default_transaction_read_only=on');
    const local = new Db({ url: 'postgres://u@127.0.0.1:1/db' });
    assert.equal(options(local), undefined);
    await Promise.all([shared.close(), local.close()]);
  });

  it('provisions no Keycloak users', () => {
    const keycloak = {
      url: 'http://kc',
      realm: 'r',
      clientId: 'c',
      admin: { username: 'admin', password: 'admin' },
    };
    assert.equal(keycloakOf({ disposable: false, keycloak }).canProvision, false);
    assert.equal(keycloakOf({ disposable: true, keycloak }).canProvision, true);
  });
});

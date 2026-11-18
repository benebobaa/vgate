/**
 * The client's streaming, session and webhook features against a local server that misbehaves on demand, so each
 * check is seen to fail when it should.
 */
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { request } from '@playwright/test';
import { Auth } from '../auth/auth.ts';
import type { EnvironmentConfig, ServiceConfig } from '../config.ts';
import { ApiClient, CallRecorder } from './client.ts';
import { OpenApiContract } from './openapi.ts';

const chunk = { $ref: '#/components/schemas/Chunk' };
const error = {
  description: 'Bad request',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};
const spec = {
  openapi: '3.1.0',
  paths: {
    // 3.1 contract: the events' data by event name (x-vgate-events), the JSON answer beside the stream.
    '/chat': {
      post: {
        responses: {
          '200': {
            description: 'A completion, streamed when asked',
            content: {
              'application/json': { schema: chunk },
              'text/event-stream': { schema: { type: 'string' }, 'x-vgate-events': { message: chunk } },
            },
          },
          '400': error,
        },
      },
    },
    // 3.2 contract: itemSchema, a oneOf of event objects whose data carries a contentSchema.
    '/feed': {
      get: {
        responses: {
          '200': {
            description: 'A feed',
            content: { 'text/event-stream': { itemSchema: { $ref: '#/components/schemas/FeedEvent' } } },
          },
        },
      },
    },
    '/login': { post: { responses: { '200': { description: 'Logged in' }, '401': { description: 'No' } } } },
    '/me': { get: { responses: { '200': { description: 'Me' }, '401': { description: 'No' } } } },
    '/hook': { post: { responses: { '204': { description: 'Accepted' }, '401': { description: 'Refused' } } } },
  },
  components: {
    schemas: {
      Chunk: {
        type: 'object',
        required: ['delta'],
        properties: { delta: { type: 'string' }, at: { type: 'string' } },
      },
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
      FeedEvent: {
        oneOf: [
          { $ref: '#/components/schemas/Added' },
          {
            type: 'object',
            required: ['event', 'data'],
            properties: {
              event: { const: 'removed' },
              data: {
                type: 'string',
                contentMediaType: 'application/json',
                contentSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
              },
            },
          },
        ],
      },
      Added: {
        type: 'object',
        required: ['event', 'data'],
        properties: {
          event: { const: 'added' },
          data: {
            type: 'string',
            contentMediaType: 'application/json',
            contentSchema: {
              type: 'object',
              required: ['id', 'name'],
              properties: { id: { type: 'integer' }, name: { type: 'string' } },
            },
          },
          id: { type: 'string' },
        },
      },
    },
  },
};

const SECRET = 'whsec_selftest';
let logins = 0;
const open = new Set<ServerResponse>();

function sse(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': 'r' });
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const part of req) chunks.push(part as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function verify(header: string | undefined, raw: string): boolean {
  const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.split('=', 2) as [string, string]));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = createHmac('sha256', SECRET).update(`${parts.t}.${raw}`).digest('hex');
  return expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://x');
    const mode = url.searchParams.get('mode') ?? 'ok';
    if (url.pathname === '/login') {
      const input = JSON.parse(await body(req)) as { email: string; secret: string };
      if (input.email !== 'alice@example.com' || input.secret !== 'pw') return res.writeHead(401).end();
      logins++;
      const cookies = [`sid=s${logins}; Path=/; HttpOnly`, `csrf=c${logins}; Path=/`];
      if (mode === 'nocookie' || req.headers['x-mode'] === 'nocookie') cookies.shift();
      return res.writeHead(200, { 'Set-Cookie': cookies }).end();
    }
    if (url.pathname === '/me') {
      const cookie = req.headers.cookie ?? '';
      const ok = /sid=s\d+/.test(cookie) && req.headers['x-csrf'] === /csrf=(c\d+)/.exec(cookie)?.[1];
      return res.writeHead(ok ? 200 : 401).end();
    }
    if (url.pathname === '/hook') {
      const raw = await body(req);
      return res.writeHead(verify(req.headers['paybridge-signature'] as string | undefined, raw) ? 204 : 401).end();
    }
    if (url.pathname === '/feed') {
      sse(res);
      const name = mode === 'bad' ? 'Ann' : 'Bo';
      res.write(`event: added\nid: 1\ndata: {"id":1,"name":"${name}"}\n\n`);
      res.write(mode === 'bad' ? 'event: removed\ndata: {"id":"x"}\n\n' : 'event: removed\ndata: {"id":1}\n\n');
      return res.end();
    }
    // /chat
    const raw = await body(req);
    if (raw.includes('"invalid"')) {
      return res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid"}');
    }
    sse(res);
    res.write(': keep-alive\n\n');
    res.write('data: {"delta":"Hel"}\n\n');
    if (mode === 'badevent') res.write('data: {"delta":7}\n\n');
    if (mode === 'undocumented') res.write('event: usage\ndata: {"tokens":3}\n\n');
    if (mode === 'offset') res.write('data: {"delta":"x","at":"2026-11-18T01:00:00"}\n\n');
    if (mode === 'cut') {
      res.write('data: {"delta":"lo"}\n\n');
      return setTimeout(() => res.socket?.destroy(), 20);
    }
    if (mode === 'stall') {
      open.add(res);
      return;
    }
    res.write('data: {"delta":"lo"}\n\n');
    if (mode !== 'close') res.write('data: [DONE]\n\n');
    res.end();
  })();
});

let svc: ServiceConfig;
const contract = new OpenApiContract(structuredClone(spec), { strictResponseProperties: true });

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const env: EnvironmentConfig = {
    name: 'selftest',
    baseUrl: `http://127.0.0.1:${port}`,
    auth: {
      session: {
        login: { path: '/login', body: { email: '{username}', secret: '{password}' } },
        cookie: 'sid',
        csrf: { cookie: 'csrf', header: 'X-Csrf' },
      },
    },
    users: { alice: { username: 'alice@example.com', password: 'pw' }, mallory: { password: 'nope' } },
    webhooks: {
      pay: {
        path: '/hook',
        secret: SECRET,
        header: 'PayBridge-Signature',
        payload: '{timestamp}.{body}',
        format: 't={timestamp},v1={signature}',
      },
    },
    disposable: true,
  };
  svc = {
    name: 'selftest',
    dir: '.',
    specPath: '',
    rules: {
      strictResponseProperties: true,
      datetimeOffset: 'Z',
      streaming: {
        terminal: [{ data: '[DONE]' }],
        eventTimeoutMs: 2000,
        // A feed of another style: it ends when the server closes it.
        operations: { 'GET /feed': { terminal: [] } },
      },
    },
    coverage: { exclude: [] },
    schemathesis: {},
    env,
  };
});

after(() => {
  for (const res of open) res.destroy();
  server.closeAllConnections();
  server.close();
});

async function client() {
  const ctx = await request.newContext();
  return { ctx, api: new ApiClient(ctx, svc, contract, new Auth(svc.env), new CallRecorder(undefined, 'selftest')) };
}

async function failure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return assert.fail('expected the call to fail its checks');
}

describe('streams', () => {
  it('reads events as they arrive, validates each, and sees the terminal marker', async () => {
    const { ctx, api } = await client();
    const res = await api.anonymous().sendStream('POST', '/chat', { body: {} });
    assert.equal(res.complete, true);
    assert.equal(res.ending, 'terminal');
    assert.deepEqual(res.eventData, [{ delta: 'Hel' }, { delta: 'lo' }]);
    assert.equal(res.events.at(-1)?.data, '[DONE]');
    assert.equal(res.eventAt.length, 3);
    await ctx.dispose();
  });

  it("fails an event that breaks the contract's event schema, an undocumented event, a datetime offset", async () => {
    const { ctx, api } = await client();
    const chat = (mode: string) => () => api.anonymous().sendStream('POST', '/chat', { query: { mode }, body: {} });
    assert.match(await failure(chat('badevent')), /event 1 \(message\): data\/delta must be string/);
    assert.match(await failure(chat('undocumented')), /event \\?"usage\\?" is not documented \(documented: message\)/);
    assert.match(await failure(chat('offset')), /lacks offset Z/);
    await ctx.dispose();
  });

  it('fails a stream that closes, breaks or stalls before its terminal marker; allowIncomplete reports it', async () => {
    const { ctx, api } = await client();
    const chat = (mode: string, extra = {}) =>
      api.anonymous().sendStream('POST', '/chat', { query: { mode }, body: {}, ...extra });
    assert.match(await failure(() => chat('close')), /stream closed before its terminal marker \(data: \[DONE\]\)/);
    assert.match(await failure(() => chat('cut')), /connection broke before its terminal marker/);
    assert.match(await failure(() => chat('stall', { eventTimeoutMs: 300 })), /no event arrived within 300ms/);
    const cut = await chat('cut', { allowIncomplete: true });
    assert.equal(cut.ending, 'cut-off');
    assert.equal(cut.complete, false);
    assert.deepEqual(cut.eventData, [{ delta: 'Hel' }, { delta: 'lo' }]);
    const stalled = await chat('stall', { allowIncomplete: true, eventTimeoutMs: 300 });
    assert.equal(stalled.ending, 'stalled');
    await ctx.dispose();
  });

  it('checks an answer that is not a stream like any other call', async () => {
    const { ctx, api } = await client();
    const res = await api.anonymous().sendStream('POST', '/chat', { body: { invalid: true } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'invalid' });
    assert.equal(res.events.length, 0);
    await ctx.dispose();
  });

  it('parses and validates a stream read whole by a plain call', async () => {
    const { ctx, api } = await client();
    const res = await api.anonymous().send('POST', '/chat', { body: {} });
    assert.equal(res.events.length, 3);
    assert.match(
      await failure(() => api.anonymous().send('POST', '/chat', { query: { mode: 'badevent' }, body: {} })),
      /event 1 \(message\): data\/delta must be string/,
    );
    assert.match(
      await failure(() => api.anonymous().send('POST', '/chat', { query: { mode: 'close' }, body: {} })),
      /stream closed before its terminal marker/,
    );
    await ctx.dispose();
  });

  it("validates OpenAPI 3.2 itemSchema events, data through each variant's contentSchema", async () => {
    const { ctx, api } = await client();
    const res = await api.anonymous().sendStream('GET', '/feed');
    assert.deepEqual(
      res.events.map((e) => e.event),
      ['added', 'removed'],
    );
    assert.match(
      await failure(() => api.anonymous().sendStream('GET', '/feed', { query: { mode: 'bad' } })),
      /event 1 \(removed\): .*must be integer/,
    );
    await ctx.dispose();
  });
});

describe('session logins', () => {
  it('logs a seeded user in once, then sends the session cookie and the CSRF header', async () => {
    const { ctx, api } = await client();
    const before = logins;
    assert.equal((await api.as('alice').send('GET', '/me')).status, 200);
    assert.equal((await api.as('alice').send('GET', '/me')).status, 200);
    assert.equal(logins - before, 1);
    await ctx.dispose();
  });

  it('gives a caller its own session on request', async () => {
    const { ctx, api } = await client();
    const own = api.as('alice', { newSession: true });
    const before = logins;
    await own.send('GET', '/me');
    await own.send('GET', '/me');
    assert.equal(logins - before, 1);
    await ctx.dispose();
  });

  it('fails a refused login loudly, naming the user', async () => {
    const { ctx, api } = await client();
    await assert.rejects(
      api.as('mallory').send('GET', '/me'),
      /Session login of user "mallory" \(POST \/login\) failed: 401/,
    );
    await ctx.dispose();
  });

  it('names the missing session cookie', async () => {
    const auth = new Auth({
      ...svc.env,
      auth: {
        session: {
          login: {
            path: '/login',
            body: { email: '{username}', secret: '{password}' },
            headers: { 'X-Mode': 'nocookie' },
          },
          cookie: 'sid',
        },
      },
    });
    await assert.rejects(auth.forUser('alice')(), /set no sid cookie \(set: csrf\)/);
  });

  it('gives Schemathesis every header the user needs', async () => {
    const lines = await new Auth(svc.env).headerLines('alice');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Cookie: sid=s\d+; csrf=c\d+$/);
    assert.match(lines[1], /^X-Csrf: c\d+$/);
  });
});

describe('signed webhooks', () => {
  it('delivers a webhook the receiver verifies, and the deliveries it must refuse', async () => {
    const { ctx, api } = await client();
    const payload = { order: 'o-1', amount: 5000 };
    assert.equal((await api.webhook('pay', payload)).status, 204);
    const refused = async (options: Parameters<typeof api.webhook>[2]) =>
      (await api.webhook('pay', payload, options)).status;
    assert.equal(await refused({ timestamp: Math.floor(Date.now() / 1000) - 3600 }), 401);
    assert.equal(await refused({ secret: 'forged' }), 401);
    assert.equal(await refused({ unsigned: true }), 401);
    assert.equal(await refused({ bodyAfterSigning: JSON.stringify({ ...payload, amount: 1 }) }), 401);
    await ctx.dispose();
  });

  it('names an unknown webhook and the ones configured', async () => {
    const { ctx, api } = await client();
    await assert.rejects(api.webhook('ghost', {}), /No webhook "ghost" .* \(have: pay\)/);
    await ctx.dispose();
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { OpenApiContract } from '../http/openapi.ts';
import { ofKind, parseDependencies } from './config.ts';
import { providerCoverage } from './coverage.ts';
import { eventViolations, topicValidators } from './kafka.ts';
import { bodyMatches, bodyPatterns, jsonPathValue, splitOperation, stubViolations, urlMatcher } from './stubs.ts';
import { proxyOf } from './toxiproxy.ts';

const DIR = '/svc';

describe('parseDependencies', () => {
  const full = {
    payments: { kind: 'http-stub', adminUrl: 'http://wm:8080/', contract: 'deps/p.yaml', proxy: 'payments' },
    events: { kind: 'kafka', brokers: ['k:9092'], topics: { 'orders.created': { schema: 'deps/e.json' } } },
    cache: { kind: 'redis', url: 'redis://r:6379' },
    proxies: { kind: 'toxiproxy', url: 'http://tp:8474/' },
  };

  it('reads every kind, resolves paths against the service directory and trims trailing slashes', () => {
    const deps = parseDependencies(full, DIR, true);
    assert.deepEqual(deps.payments, {
      kind: 'http-stub',
      adminUrl: 'http://wm:8080',
      contract: '/svc/deps/p.yaml',
      proxy: 'payments',
    });
    assert.deepEqual(deps.events, {
      kind: 'kafka',
      brokers: ['k:9092'],
      topics: { 'orders.created': { schema: '/svc/deps/e.json' } },
    });
    assert.deepEqual(deps.proxies, { kind: 'toxiproxy', url: 'http://tp:8474' });
    assert.deepEqual(Object.keys(ofKind(deps, 'redis')), ['cache']);
  });

  it('is empty when the block is absent', () => {
    assert.deepEqual(parseDependencies(undefined, DIR, false), {});
  });

  it('refuses stubs and toxiproxy on a shared environment', () => {
    assert.throws(
      () => parseDependencies({ payments: full.payments, proxies: full.proxies }, DIR, false),
      /disposable/,
    );
    assert.throws(() => parseDependencies({ proxies: full.proxies }, DIR, false), /disposable/);
    // Kafka and Redis are read, never replaced: allowed anywhere.
    assert.doesNotThrow(() => parseDependencies({ events: full.events, cache: full.cache }, DIR, false));
  });

  it('refuses an unknown kind, a topic without a schema, and a proxy without toxiproxy', () => {
    assert.throws(() => parseDependencies({ x: { kind: 'mongo' } }, DIR, true), /kind must be one of/);
    assert.throws(
      () => parseDependencies({ e: { kind: 'kafka', brokers: ['k:1'], topics: { t: {} } } }, DIR, true),
      /topics\.t\.schema is required/,
    );
    assert.throws(
      () => parseDependencies({ e: { kind: 'kafka', brokers: [], topics: { t: {} } } }, DIR, true),
      /brokers/,
    );
    assert.throws(() => parseDependencies({ payments: full.payments }, DIR, true), /exactly one toxiproxy/);
  });

  it('names the dependency and field that is missing', () => {
    assert.throws(
      () => parseDependencies({ payments: { kind: 'http-stub', contract: 'x' } }, DIR, true, 'svc.deps'),
      /svc\.deps\.payments\.adminUrl is required/,
    );
  });
});

describe('proxyOf', () => {
  it('returns the proxy of a stubbed dependency and explains what is missing otherwise', () => {
    const deps = parseDependencies(
      {
        payments: { kind: 'http-stub', adminUrl: 'http://a', contract: 'c', proxy: 'pay' },
        cache: { kind: 'redis', url: 'redis://r' },
        tp: { kind: 'toxiproxy', url: 'http://t' },
      },
      DIR,
      true,
    );
    assert.equal(proxyOf(deps, 'payments'), 'pay');
    assert.throws(() => proxyOf(deps, 'cache'), /no toxiproxy proxy/);
    assert.throws(() => proxyOf(deps, 'nope'), /No dependency "nope"/);
  });
});

const provider = new OpenApiContract(
  {
    openapi: '3.1.0',
    paths: {
      '/charges': {
        post: {
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ChargeRequest' } } } },
          responses: {
            '201': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Charge' } } },
            },
            '402': {
              description: 'declined',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Decline' } } },
            },
            '5XX': {
              description: 'outage',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Decline' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        ChargeRequest: {
          type: 'object',
          required: ['amount', 'customer'],
          properties: { amount: { type: 'integer' }, customer: { type: 'string' } },
        },
        Charge: {
          type: 'object',
          required: ['id', 'status'],
          properties: { id: { type: 'string' }, status: { const: 'succeeded' } },
        },
        Decline: {
          type: 'object',
          required: ['code'],
          properties: { code: { enum: ['card_declined', 'insufficient_funds'] } },
        },
      },
    },
  },
  { strictResponseProperties: true },
);

describe('stubViolations: a stub may not lie about the provider', () => {
  const match = { '$.customer': 'cus-1' };

  it('accepts a documented status with a conforming body, including a documented status range', () => {
    assert.deepEqual(
      stubViolations(provider, {
        operation: 'POST /charges',
        match,
        status: 201,
        body: { id: 'ch_1', status: 'succeeded' },
      }),
      [],
    );
    assert.deepEqual(
      stubViolations(provider, { operation: 'POST /charges', match, status: 503, body: { code: 'card_declined' } }),
      [],
    );
  });

  it('refuses an undocumented status', () => {
    const [violation] = stubViolations(provider, { operation: 'POST /charges', match, status: 418, body: {} });
    assert.match(violation, /status 418 is not documented for POST \/charges \(documented: 201, 402, 5XX\)/);
  });

  it('refuses a body that breaks the schema, or carries a field the provider does not send', () => {
    const wrong = stubViolations(provider, {
      operation: 'POST /charges',
      match,
      status: 402,
      body: { code: 'stolen_card' },
    });
    assert.ok(
      wrong.some((v) => v.includes('/code')),
      wrong.join(),
    );
    const extra = stubViolations(provider, {
      operation: 'POST /charges',
      match,
      status: 201,
      body: { id: 'x', status: 'succeeded', loyaltyPoints: 3 },
    });
    assert.ok(
      extra.some((v) => v.includes('loyaltyPoints')),
      extra.join(),
    );
  });

  it('refuses an unknown operation and a stub without a match (it would answer other tests)', () => {
    assert.match(stubViolations(provider, { operation: 'POST /refunds', match, status: 201 })[0], /not an operation/);
    assert.match(stubViolations(provider, { operation: 'POST /charges', match: {}, status: 201 })[0], /match is empty/);
    assert.match(
      stubViolations(provider, { operation: 'POST /charges', match: { '$..customer': 'x' }, status: 201 })[0],
      /simple JSONPaths/,
    );
  });
});

describe('validateRequest: what the service sends is held to the provider contract', () => {
  it('accepts a conforming body and reports a missing field and an undeclared one', () => {
    assert.deepEqual(provider.validateRequest('POST', '/charges', { amount: 1, customer: 'c' }), []);
    assert.ok(provider.validateRequest('POST', '/charges', { amount: 1 }).some((v) => v.includes('customer')));
    assert.ok(
      provider
        .validateRequest('POST', '/charges', { amount: 1, customer: 'c', cvv: '1' })
        .some((v) => v.includes('cvv')),
    );
  });
});

describe('bodyMatches: the journal filter evaluated by the framework, not WireMock', () => {
  it('reads simple JSONPaths and compares as strings', () => {
    const body = { customer: 'cus.r.3n', amount: 5, items: [{ sku: 'a' }] };
    assert.equal(jsonPathValue(body, '$.items[0].sku'), 'a');
    assert.equal(jsonPathValue(body, '$.missing.deeper'), undefined);
    assert.equal(bodyMatches(body, { '$.customer': 'cus.r.3n', '$.amount': 5 }), true);
    assert.equal(bodyMatches(body, { '$.amount': '5' }), true);
    assert.throws(() => jsonPathValue(body, '$..customer'), /simple JSONPath/);
  });

  it('tells apart bodies whose Java String hashCodes collide (WireMock journal search does not)', () => {
    // "3n" and "50" hash alike in Java (51*31+110 = 53*31+48): run-unique ids produce such pairs routinely.
    assert.equal(bodyMatches({ customer: 'cus.r.50' }, { '$.customer': 'cus.r.3n' }), false);
    assert.equal(bodyMatches({ customer: 'cus.r.3n' }, { '$.customer': 'cus.r.3n' }), true);
  });

  it('does not match an object or a missing field', () => {
    assert.equal(bodyMatches({ customer: { id: 'x' } }, { '$.customer': '[object Object]' }), false);
    assert.equal(bodyMatches({}, { '$.customer': 'undefined' }), false);
  });
});

describe('WireMock matchers', () => {
  it('matches a plain path exactly and a templated path by pattern', () => {
    assert.deepEqual(urlMatcher('/charges'), { urlPath: '/charges' });
    assert.deepEqual(urlMatcher('/charges/{id}/capture'), { urlPathPattern: '^/charges/[^/]+/capture$' });
  });

  it('turns each matched field into a JSONPath equalTo pattern', () => {
    assert.deepEqual(bodyPatterns({ '$.customer': 'c-1', '$.amount': 5 }), [
      { matchesJsonPath: { expression: '$.customer', equalTo: 'c-1' } },
      { matchesJsonPath: { expression: '$.amount', equalTo: '5' } },
    ]);
  });

  it('splits an operation and refuses one without a method', () => {
    assert.deepEqual(splitOperation('POST /charges'), { method: 'POST', path: '/charges' });
    assert.throws(() => splitOperation('/charges'), /not an operation/);
  });
});

describe('event schemas', () => {
  it('validates an event against its topic schema and refuses an unconfigured topic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vgate-deps-'));
    const schema = join(dir, 'e.json');
    writeFileSync(
      schema,
      JSON.stringify({
        type: 'object',
        required: ['orderId'],
        properties: { orderId: { type: 'string', format: 'uuid' } },
        additionalProperties: false,
      }),
    );
    const validators = topicValidators({ 'orders.created': { schema } });
    const validate = validators.get('orders.created');
    assert.deepEqual(
      eventViolations(validate, 'orders.created', { orderId: '6f1c1f0e-0d6c-4b0a-9a51-1d1c2f0b7a10' }),
      [],
    );
    assert.ok(eventViolations(validate, 'orders.created', { orderId: 'nope' }).some((v) => v.includes('/orderId')));
    assert.ok(
      eventViolations(validate, 'orders.created', { orderId: '6f1c1f0e-0d6c-4b0a-9a51-1d1c2f0b7a10', x: 1 }).length > 0,
    );
    assert.match(eventViolations(undefined, 'other', {})[0], /not configured/);
  });
});

describe('providerCoverage', () => {
  it('marks each documented provider answer stubbed or not; a range is covered by any status in it', () => {
    const rows = providerCoverage({ payments: provider }, [
      { dependency: 'payments', operation: 'POST /charges', status: 201 },
      { dependency: 'payments', operation: 'POST /charges', status: 503 },
      { dependency: 'other', operation: 'POST /charges', status: 402 },
    ]);
    assert.deepEqual(
      rows.map((r) => `${r.status}:${r.stubbed}`),
      ['201:true', '402:false', '5XX:true'],
    );
  });
});

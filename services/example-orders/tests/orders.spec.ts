import { StubViolation, type HttpStub } from '@vgate/framework/deps/stubs.ts';
import type { ApiClient } from '@vgate/framework/http/client.ts';
import type { paths } from '../generated/openapi.ts';
import {
  chargeSucceeds,
  expect,
  newOrder,
  storedOrders,
  test,
  type Order,
  type OrderCreated,
} from '../support/fixtures.ts';

// Sources: services/example-orders/README.md (rules 1-8), openapi.yaml, the provider's contract
// (deps/payments.openapi.yaml) and the event schema (deps/events/orders.created.schema.json). Every response is held
// to the contract by the client; every stub to the provider's contract; every event to its schema.

// Parallel on purpose: stubs, rows, events and cache keys are all this test's own (support/fixtures.ts newOrder), so
// the suite proves its isolation on every run instead of passing because it happens to run alone.
test.describe.configure({ mode: 'parallel' });

const TOPIC = 'orders.created';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISSING = '00000000-0000-4000-8000-000000000000';

test.describe('GET /health', () => {
  test('[HLT-200] answers UP without a key', async ({ api }) => {
    expect((await api.anonymous().get('/health')).expectSuccess()).toEqual({ status: 'UP' });
  });
});

test.describe('POST /orders', () => {
  test('[ORD-201] pays, then stores, publishes once and remembers the order (rules 3, 4, 6)', async ({
    api,
    stubs,
    events,
    cache,
    db,
    unique,
  }) => {
    const { input, key } = newOrder(unique);
    const chargeId = `ch_${unique('c')}`;
    const charge = await chargeSucceeds(stubs.payments, input, chargeId);

    const order = (
      await api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } })
    ).expectSuccess(201);
    expect(order).toMatchObject({ ...input, status: 'paid', chargeId });
    expect(order.id).toMatch(UUID);

    // Rule 4: exactly one charge, carrying what the rule names (and, by calls(), what the provider's contract allows).
    const sent = await charge.calls();
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({
      amount: input.amount,
      currency: input.currency,
      customer: input.customerId,
      reference: key,
    });

    // Rule 6: the row and the event.
    const row = await db.one('SELECT * FROM orders WHERE customer_id = $1', [input.customerId]);
    expect(row).toMatchObject({
      id: order.id,
      amount: String(input.amount),
      currency: 'IDR',
      status: 'paid',
      charge_id: order.chargeId,
    });
    const event = await events.expect<OrderCreated>(TOPIC, (e) => e.customerId === input.customerId);
    expect(event.key).toBe(order.id);
    expect(event.value).toEqual({
      orderId: order.id,
      customerId: input.customerId,
      amount: input.amount,
      currency: input.currency,
      chargeId: order.chargeId,
      createdAt: order.createdAt,
    });
    expect(await events.published(TOPIC, (e: OrderCreated) => e.customerId === input.customerId)).toHaveLength(1);

    // Rule 3: remembered for 24 hours.
    const remembered = await cache.get(`idempotency:${key}`);
    expect(remembered?.value).toMatchObject({ order });
    expect(remembered?.ttlSeconds).toBeGreaterThan(86_400 - 60);
    expect(remembered?.ttlSeconds).toBeLessThanOrEqual(86_400);
  });

  test('[ORD-201-REPEAT] a repeat with the same key and body answers the first order and charges once (rule 3)', async ({
    api,
    stubs,
    events,
    db,
    unique,
  }) => {
    const { input, key } = newOrder(unique);
    const charge = await chargeSucceeds(stubs.payments, input, `ch_${unique('c')}`);
    const call = () => api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } });

    const first = (await call()).expectSuccess(201);
    const repeat = (await call()).expectSuccess(201);
    expect(repeat).toEqual(first);
    expect(await charge.calls()).toHaveLength(1);
    expect(await storedOrders(db, input.customerId)).toBe(1);
    expect(await events.published(TOPIC, (e: OrderCreated) => e.customerId === input.customerId)).toHaveLength(1);
  });

  test('[ORD-409] the same key with a different body is a conflict and charges nothing more (rule 3)', async ({
    api,
    stubs,
    db,
    unique,
  }) => {
    const { input, key } = newOrder(unique);
    const charge = await chargeSucceeds(stubs.payments, input, `ch_${unique('c')}`);
    (await api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } })).expectSuccess(201);

    const res = await api
      .as('clerk')
      .post('/orders', { body: { ...input, amount: input.amount + 1 }, headers: { 'Idempotency-Key': key } });
    expect(res.expectError(409)).toMatchObject({ error: 'idempotency_conflict' });
    expect(await charge.calls()).toHaveLength(1);
    expect(await storedOrders(db, input.customerId)).toBe(1);
  });

  test('[ORD-402] a declined charge answers 402 with the reason, and nothing is kept (rules 4, 5)', async ({
    api,
    stubs,
    events,
    cache,
    db,
    unique,
  }) => {
    const { input, key } = newOrder(unique);
    await stubs.payments.stub({
      operation: 'POST /charges',
      match: { '$.customer': input.customerId },
      status: 402,
      body: { code: 'insufficient_funds', message: 'not enough' },
    });
    const res = await api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } });
    expect(res.expectError(402)).toMatchObject({ error: 'payment_declined', reason: 'insufficient_funds' });
    expect(await storedOrders(db, input.customerId)).toBe(0);
    expect(await cache.exists(`idempotency:${key}`)).toBe(false);
    await events.expectNone(TOPIC, (e: OrderCreated) => e.customerId === input.customerId);
  });

  test('[ORD-402-RETRY] after a decline the same key can be retried and succeed (rule 3)', async ({
    api,
    stubs,
    unique,
  }) => {
    const { input, key } = newOrder(unique);
    const decline = await stubs.payments.stub({
      operation: 'POST /charges',
      match: { '$.customer': input.customerId },
      status: 402,
      body: { code: 'card_declined', message: 'declined' },
    });
    const call = () => api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } });
    (await call()).expectError(402);

    await decline.remove();
    await chargeSucceeds(stubs.payments, input, `ch_${unique('c')}`);
    expect((await call()).expectSuccess(201)).toMatchObject({ customerId: input.customerId, status: 'paid' });
  });

  const failures: Array<[number, 'invalid_request' | 'internal_error' | 'unavailable']> = [
    [500, 'internal_error'],
    [503, 'unavailable'],
    [400, 'invalid_request'],
  ];
  for (const [status, code] of failures) {
    test(`[ORD-503] the provider's ${status} answers 503, and nothing is kept (rules 4, 5)`, async ({
      api,
      stubs,
      events,
      cache,
      db,
      unique,
    }) => {
      const { input, key } = newOrder(unique);
      await stubs.payments.stub({
        operation: 'POST /charges',
        match: { '$.customer': input.customerId },
        status,
        body: { code, message: 'provider trouble' },
      });
      const res = await api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } });
      expect(res.expectError(503)).toMatchObject({ error: 'payment_unavailable' });
      expect(await storedOrders(db, input.customerId)).toBe(0);
      expect(await cache.exists(`idempotency:${key}`)).toBe(false);
      await events.expectNone(TOPIC, (e: OrderCreated) => e.customerId === input.customerId);
    });
  }

  const invalid: Array<[string, (customerId: string) => Record<string, unknown>]> = [
    ['customerId missing', () => ({ amount: 1, currency: 'IDR' })],
    ['customerId with upper case', () => ({ customerId: 'Upper', amount: 1, currency: 'IDR' })],
    ['amount 0', (c) => ({ customerId: c, amount: 0, currency: 'IDR' })],
    ['amount 100000001', (c) => ({ customerId: c, amount: 100_000_001, currency: 'IDR' })],
    ['a fractional amount', (c) => ({ customerId: c, amount: 1.5, currency: 'IDR' })],
    ['an unknown currency', (c) => ({ customerId: c, amount: 1, currency: 'EUR' })],
    ['an unknown field', (c) => ({ customerId: c, amount: 1, currency: 'IDR', coupon: 'x' })],
  ];
  for (const [what, body] of invalid) {
    test(`[ORD-400] refuses ${what} and charges nothing (rule 2)`, async ({ api, stubs, unique }) => {
      const { input, key } = newOrder(unique);
      const charge = await chargeSucceeds(stubs.payments, input, `ch_${unique('c')}`);
      const res = await api
        .as('clerk')
        .post('/orders', { invalidBody: body(input.customerId), headers: { 'Idempotency-Key': key } });
      expect(res.expectError(400)).toMatchObject({ error: 'bad_request' });
      expect(await charge.calls()).toHaveLength(0);
    });
  }

  for (const [what, headers] of [
    ['without an Idempotency-Key', {}],
    ['with an Idempotency-Key of 7 characters', { 'Idempotency-Key': 'abcdefg' }],
  ] as const) {
    test(`[ORD-400-KEY] refuses a call ${what}, before the body (rule 2)`, async ({ api, stubs, unique }) => {
      const { input } = newOrder(unique);
      const charge = await chargeSucceeds(stubs.payments, input, `ch_${unique('c')}`);
      // The client checks the contract's required header on the request side too; this call breaks it on purpose.
      const res = await api.as('clerk').post('/orders', { body: input, headers: { ...headers } });
      const error = res.expectError(400);
      expect(error).toMatchObject({ error: 'bad_request' });
      expect(error.message).toContain('Idempotency-Key');
      expect(await charge.calls()).toHaveLength(0);
    });
  }

  test('[ORD-400-CONTENT-TYPE] refuses a JSON body not sent as application/json (rule 2)', async ({ api, unique }) => {
    const { input, key } = newOrder(unique);
    const res = await api.as('clerk').post('/orders', {
      rawBody: JSON.stringify(input),
      headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': key },
    });
    expect(res.expectError(400)).toMatchObject({ error: 'bad_request' });
  });

  test('[ORD-401] refuses a call without a key or with an unknown one, before the body (rule 1)', async ({ api }) => {
    for (const caller of [api.anonymous(), api.asToken('not-a-key')]) {
      const res = await caller.post('/orders', { invalidBody: {} });
      expect(res.expectError(401)).toMatchObject({ error: 'unauthorized' });
    }
  });

  test("[PAY-CONTRACT] a stub the provider's contract does not document is refused", async ({ stubs, unique }) => {
    const match = { '$.customer': unique('cus') };
    await expect(stubs.payments.stub({ operation: 'POST /charges', match, status: 418, body: {} })).rejects.toThrow(
      StubViolation,
    );
    await expect(
      stubs.payments.stub({
        operation: 'POST /charges',
        match,
        status: 402,
        body: { code: 'stolen_card', message: 'x' },
      }),
    ).rejects.toThrow(/\/code/);
  });
});

test.describe('GET /orders/{orderId}', () => {
  async function created(
    api: ApiClient<paths>,
    stubs: Record<string, HttpStub>,
    unique: (prefix: string) => string,
  ): Promise<Order> {
    const { input, key } = newOrder(unique);
    await chargeSucceeds(stubs.payments, input, `ch_${unique('c')}`);
    return (await api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } })).expectSuccess(
      201,
    );
  }

  test('[GET-200] answers the order and caches it for 300 seconds (rule 7)', async ({ api, stubs, cache, unique }) => {
    const order = await created(api, stubs, unique);
    expect(await cache.exists(`order:${order.id}`)).toBe(false);
    const read = (await api.as('clerk').get('/orders/{orderId}', { params: { orderId: order.id } })).expectSuccess();
    expect(read).toEqual(order);
    const cached = await cache.get(`order:${order.id}`);
    expect(cached?.value).toEqual(order);
    expect(cached?.ttlSeconds).toBeGreaterThan(240);
    expect(cached?.ttlSeconds).toBeLessThanOrEqual(300);
  });

  test('[GET-200-CACHED] a second read is served from the cache, not the database (rule 7)', async ({
    api,
    stubs,
    db,
    unique,
  }) => {
    const order = await created(api, stubs, unique);
    const read = () => api.as('clerk').get('/orders/{orderId}', { params: { orderId: order.id } });
    (await read()).expectSuccess();
    // Changing the row behind the cache's back shows which one the second read came from (disposable environment).
    await db.query('UPDATE orders SET amount = amount + 1 WHERE id = $1', [order.id]);
    expect((await read()).expectSuccess().amount).toBe(order.amount);
  });

  test('[GET-404] answers 404 for an unknown id and for one that is not a UUID (rule 7)', async ({ api }) => {
    for (const orderId of [MISSING, 'not-a-uuid']) {
      const res = await api.as('clerk').get('/orders/{orderId}', { params: { orderId } });
      expect(res.expectError(404)).toMatchObject({ error: 'not_found' });
    }
  });

  test('[GET-401] refuses a call without a key (rule 1)', async ({ api }) => {
    const res = await api.anonymous().get('/orders/{orderId}', { params: { orderId: MISSING } });
    expect(res.expectError(401)).toMatchObject({ error: 'unauthorized' });
  });
});

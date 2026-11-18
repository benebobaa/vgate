import { chargeSucceeds, expect, newOrder, storedOrders, test, type OrderCreated } from '../../support/fixtures.ts';

// Network faults between the app and the payment provider (toxiproxy). They affect every caller of the provider,
// so these tests run in the serial `faults` project, alone. Sources: README.md rules 4 and 5.

const TOPIC = 'orders.created';

test.describe('POST /orders while the payment provider misbehaves', () => {
  test('[ORD-504] a provider slower than 2 seconds answers 504, and nothing is kept (rules 4, 5)', async ({
    api,
    stubs,
    faults,
    events,
    cache,
    db,
    unique,
  }) => {
    const { input, key } = newOrder(unique);
    await chargeSucceeds(stubs.payments, input, `ch_${unique('c')}`);
    await faults.latency('payments', 3_000);

    const started = Date.now();
    const res = await api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } });
    expect(res.expectError(504)).toMatchObject({ error: 'payment_timeout' });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await storedOrders(db, input.customerId)).toBe(0);
    expect(await cache.exists(`idempotency:${key}`)).toBe(false);
    await events.expectNone(TOPIC, (e: OrderCreated) => e.customerId === input.customerId);
  });

  test('[ORD-503-DOWN] an unreachable provider answers 503, and nothing is kept (rules 4, 5)', async ({
    api,
    stubs,
    faults,
    db,
    unique,
  }) => {
    const { input, key } = newOrder(unique);
    const charge = await chargeSucceeds(stubs.payments, input, `ch_${unique('c')}`);
    await faults.down('payments');

    const res = await api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } });
    expect(res.expectError(503)).toMatchObject({ error: 'payment_unavailable' });
    expect(await charge.calls()).toHaveLength(0);
    expect(await storedOrders(db, input.customerId)).toBe(0);
  });
});

import { chargeSucceeds, expect, newOrder, test } from '../support/fixtures.ts';

// Sources: services/example-orders/README.md rule 9 (with rules 3, 5, 6). The mails are read from the environment's
// own mail server (kind mailpit) through the inbox fixture; each test's customer is its own, so its address is too.
test.describe.configure({ mode: 'parallel' });

test.describe('POST /orders: the confirmation mail', () => {
  test('[ORD-201-MAIL] a created order sends one confirmation to the customer (rule 9)', async ({
    api,
    stubs,
    inbox,
    unique,
  }) => {
    const { input, key } = newOrder(unique);
    await chargeSucceeds(stubs.payments, input, `ch_${unique('c')}`);
    const order = (
      await api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } })
    ).expectSuccess(201);

    const to = `${input.customerId}@customers.example`;
    const mail = await inbox.expectMessage({ to, subject: `Order ${order.id} confirmed` });
    expect(mail.from).toBe('orders@shop.example');
    expect(mail.text).toContain(order.chargeId);

    // A repeat answers the first order and sends nothing more (rule 3).
    (await api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } })).expectSuccess(201);
    await new Promise((done) => setTimeout(done, 1_500));
    expect((await inbox.messages()).filter((m) => m.to.includes(to))).toHaveLength(1);
  });

  test('[ORD-402-MAIL] an order whose payment is declined sends no mail (rules 5, 9)', async ({
    api,
    stubs,
    inbox,
    unique,
  }) => {
    const { input, key } = newOrder(unique);
    await stubs.payments.stub({
      operation: 'POST /charges',
      match: { '$.customer': input.customerId },
      status: 402,
      body: { code: 'insufficient_funds', message: 'not enough' },
    });
    (await api.as('clerk').post('/orders', { body: input, headers: { 'Idempotency-Key': key } })).expectError(402);
    await inbox.expectNone({ to: `${input.customerId}@customers.example` });
  });
});

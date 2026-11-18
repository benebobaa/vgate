import type { HttpStub, StubHandle } from '@vgate/framework/deps/stubs.ts';
import { createDepsTest, expect } from '@vgate/framework/deps/fixtures.ts';
import type { Db } from '@vgate/framework/db/postgres.ts';
import type { components, paths } from '../generated/openapi.ts';

export type Order = components['schemas']['Order'];
export type OrderInput = components['schemas']['OrderInput'];

/** The framework's test with the dependency fixtures (stubs, events, cache, faults), typed by the contract. */
export const test = createDepsTest<paths>();

/** The event of README rule 6, as deps/events/orders.created.schema.json describes it. */
export interface OrderCreated {
  orderId: string;
  customerId: string;
  amount: number;
  currency: 'IDR' | 'USD';
  chargeId: string;
  createdAt: string;
}

/**
 * This test's own data: a run-unique customer, which every stub matches on (`$.customer`, README rule 4) and every
 * row and event carries, so tests running in parallel never see each other's charges, rows or events.
 */
export function newOrder(unique: (prefix: string) => string, amount = 125_000): { input: OrderInput; key: string } {
  return {
    input: { customerId: unique('cus'), amount, currency: 'IDR' },
    key: unique('idem'),
  };
}

/** A succeeding charge for this customer (the provider's 201). */
export function chargeSucceeds(payments: HttpStub, input: OrderInput, chargeId: string): Promise<StubHandle> {
  return payments.stub({
    operation: 'POST /charges',
    match: { '$.customer': input.customerId },
    status: 201,
    body: { id: chargeId, status: 'succeeded', amount: input.amount, currency: input.currency },
  });
}

/** How many orders the database holds for this customer (README rules 5 and 6). */
export function storedOrders(db: Db, customerId: string): Promise<number> {
  return db.count('SELECT count(*) FROM orders WHERE customer_id = $1', [customerId]);
}

export { expect };

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { loadService } from './config.ts';
import { inventorySkeleton } from './inventory.ts';
import { loadContract } from './http/openapi.ts';

describe('inventorySkeleton', () => {
  it('lists every operation of the contract with its documented responses, and judges nothing', () => {
    const svc = loadService('example', 'local');
    const text = inventorySkeleton(svc);
    const plan = parse(text) as {
      service: string;
      operations: Array<{ operation: string; responses: Record<string, unknown>; scenarios: unknown[] }>;
    };
    const contract = loadContract(svc);
    assert.equal(plan.service, 'example');
    assert.deepEqual(
      plan.operations.map((op) => op.operation),
      contract.operations.map((op) => op.key),
    );
    for (const op of contract.operations) {
      const planned = plan.operations.find((p) => p.operation === op.key);
      assert.deepEqual(Object.keys(planned?.responses ?? {}).sort(), [...op.responses.keys()].sort(), op.key);
      assert.deepEqual(planned?.scenarios, [], `${op.key}: a skeleton holds no expectations`);
    }
    assert.match(text, /^# Skeleton from openapi\.yaml/);
  });
});

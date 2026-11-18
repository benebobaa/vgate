import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import type { ServiceConfig } from './config.ts';
import { inventorySkeleton } from './inventory.ts';

// Self-contained: the self-tests also run inside users' projects, where no reference service exists.
function service(): ServiceConfig {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-inventory-'));
  const specPath = join(dir, 'openapi.yaml');
  writeFileSync(
    specPath,
    [
      'openapi: 3.1.0',
      'info: { title: t, version: "1" }',
      'paths:',
      '  /notes:',
      '    get:',
      '      operationId: listNotes',
      '      responses:',
      "        '200': { description: ok }",
      "        '401': { description: no key }",
      '    post:',
      '      operationId: createNote',
      '      responses:',
      "        '201': { description: created }",
      "        '400': { description: invalid }",
      "        '401': { description: no key }",
    ].join('\n'),
  );
  const svc: ServiceConfig = {
    name: 'notes',
    dir,
    specPath,
    rules: {},
    coverage: { exclude: [] },
    schemathesis: {},
    env: { name: 'local', baseUrl: 'http://localhost', users: {}, disposable: true },
  };
  return svc;
}

describe('inventorySkeleton', () => {
  it('lists every operation of the contract with its documented responses, and judges nothing', () => {
    const text = inventorySkeleton(service());
    const plan = parse(text) as {
      service: string;
      operations: Array<{ id: string; operation: string; responses: Record<string, unknown>; scenarios: unknown[] }>;
    };
    assert.equal(plan.service, 'notes');
    assert.deepEqual(
      plan.operations.map((op) => [op.id, op.operation, Object.keys(op.responses).sort()]),
      [
        ['listNotes', 'GET /notes', ['200', '401']],
        ['createNote', 'POST /notes', ['201', '400', '401']],
      ],
    );
    for (const op of plan.operations)
      assert.deepEqual(op.scenarios, [], `${op.operation}: a skeleton holds no expectations`);
    assert.match(text, /^# Skeleton from openapi\.yaml/);
  });
});

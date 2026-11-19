import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  enclosingFunction,
  operationNamed,
  operationsFor,
  planOperations,
  testsFor,
  type PlanOperation,
} from './select.ts';

const ops: PlanOperation[] = [
  { id: 'createOrder', operation: 'POST /orders', scenarios: ['ORD-201', 'ORD-400'] },
  { id: 'getOrder', operation: 'GET /orders/{id}', scenarios: ['GET-200', 'GET-404'] },
];

const ts = [
  'function send(res, status) {', //  1
  '  res.end(status);', //            2
  '}', //                             3
  '', //                              4
  'function validate(input) {', //    5
  '  return input.amount > 0;', //    6
  '}', //                             7
  '', //                              8
  'async function createOrder(req) {', // 9
  '  if (!validate(req)) return 400;', // 10
  '  return 201;', //                 11
  '}', //                             12
  '', //                              13
  'const getOrder = async (id) => {', // 14
  '  return id === "x" ? 404 : 200;', // 15
  '};', //                            16
  '', //                              17
  'function handle(req, res) {', //   18
  '  send(res, req.method === "POST" ? createOrder(req) : getOrder(req.id));', // 19
  '}', //                             20
].join('\n');

describe('mutation test selection', () => {
  it('finds the function that holds a line, and not one whose body closed above it', () => {
    assert.equal(enclosingFunction('a.ts', ts, 6), 'validate');
    assert.equal(enclosingFunction('a.ts', ts, 10), 'createOrder');
    assert.equal(enclosingFunction('a.ts', ts, 15), 'getOrder');
    assert.equal(enclosingFunction('a.ts', ts, 4), undefined);
  });

  it('follows a helper up to the operation that calls it', () => {
    assert.deepEqual(
      operationsFor('a.ts', ts, 6, ops)?.map((o) => o.id),
      ['createOrder'],
    );
    assert.deepEqual(
      operationsFor('a.ts', ts, 15, ops)?.map((o) => o.id),
      ['getOrder'],
    );
  });

  it('knows nothing when one caller chain of a helper reaches code serving no single operation', () => {
    const mixed = [
      'function audit(x) {', //          1
      '  return x > 1;', //              2
      '}', //                            3
      'function createOrder(req) {', //  4
      '  return audit(req);', //         5
      '}', //                            6
      'function handle(req) {', //       7
      '  audit(req);', //                8
      '}', //                            9
    ].join('\n');
    assert.equal(operationsFor('a.ts', mixed, 2, ops), undefined);
  });

  it('does not put a block after a closed function inside it', () => {
    const block = ['function a() {', '  return 1;', '}', 'if (ready) {', '  limit = 2 > 1;', '}'].join('\n');
    assert.equal(enclosingFunction('a.ts', block, 5), undefined);
  });

  it('knows nothing for shared code that reaches a function serving no single operation', () => {
    assert.equal(operationsFor('a.ts', ts, 2, ops), undefined); // send <- handle (no operation)
    assert.equal(operationsFor('a.ts', ts, 19, ops), undefined);
    assert.equal(operationsFor('a.ts', ts, 6, []), undefined);
  });

  it('reads Go and Python definitions', () => {
    const go = ['func (s *Server) CreateOrder(w http.ResponseWriter) {', '\tif amount > 0 {', '\t}', '}'].join('\n');
    assert.deepEqual(
      operationsFor('h.go', go, 2, ops)?.map((o) => o.id),
      ['createOrder'],
    );
    const py = ['def get_order(order_id):', '    return order_id == 1', ''].join('\n');
    assert.deepEqual(
      operationsFor('h.py', py, 2, ops)?.map((o) => o.id),
      ['getOrder'],
    );
  });

  it('matches a handler named after an operation, never a short accidental substring', () => {
    assert.equal(operationNamed('handleCreateOrder', ops)?.id, 'createOrder');
    assert.equal(operationNamed('create_order', ops)?.id, 'createOrder');
    assert.equal(operationNamed('order', ops), undefined);
  });

  it('selects the tests that carry a scenario id of the operations, by whole id', () => {
    const tests = [
      { file: 'o.spec.ts', title: 'POST /orders › [ORD-201] creates' },
      { file: 'o.spec.ts', title: 'POST /orders › [ORD-201-REPEAT] repeats' },
      { file: 'g.spec.ts', title: 'GET › [GET-404] missing' },
    ];
    assert.deepEqual(
      testsFor([ops[0]], tests).map((t) => t.title),
      ['POST /orders › [ORD-201] creates'],
    );
  });

  it('reads the operations and scenario ids of a plan', () => {
    const plan = planOperations({
      operations: [
        { id: 'createOrder', operation: 'POST /orders', scenarios: [{ id: 'ORD-201' }, { title: 'x' }] },
        {},
      ],
    });
    assert.deepEqual(plan, [{ id: 'createOrder', operation: 'POST /orders', scenarios: ['ORD-201'] }]);
  });
});

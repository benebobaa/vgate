import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { grepForScenarios, judgeSmoke, readOnlyScenarios } from './smoke.ts';

const summary = (total: number, failed = 0, skipped = 0) => ({
  total,
  failed,
  skipped,
  failures: [],
  knownFailures: [],
});

describe('smoke: never a pass on nothing', () => {
  it('fails when no test ran: no report, an empty run, or skipped only', () => {
    assert.equal(judgeSmoke(undefined).pass, false);
    assert.match(judgeSmoke(summary(0)).reason ?? '', /no smoke test ran/);
    assert.match(judgeSmoke(summary(3, 0, 3)).reason ?? '', /no smoke test ran/);
  });
  it('fails on a failed test, passes when tests ran and none failed', () => {
    assert.equal(judgeSmoke(summary(3, 1)).pass, false);
    assert.deepEqual(judgeSmoke(summary(3, 0, 1)), { pass: true });
  });
});

describe('smoke: the subset', () => {
  it("takes the plan's scenarios of read-only operations only", () => {
    const inventory = {
      operations: [
        { operation: 'GET /notes', scenarios: [{ id: 'LST-200' }, { id: 'LST-401' }] },
        { operation: 'POST /notes', scenarios: [{ id: 'CRT-201' }] },
        { operation: 'POST /notes/search', scenarios: [{ id: 'SRC-200' }] },
        { operation: 'DELETE /notes/{id}', scenarios: [{ id: 'DEL-204' }] },
      ],
    };
    assert.deepEqual(readOnlyScenarios(inventory, {}), ['LST-200', 'LST-401']);
    assert.deepEqual(readOnlyScenarios(inventory, { readOnlyPaths: '/search$' }), ['LST-200', 'LST-401', 'SRC-200']);
    assert.deepEqual(readOnlyScenarios(undefined, {}), []);
  });
  it('greps exactly the ids, as titles carry them', () => {
    const grep = grepForScenarios(['HLT-200', 'LST-200', 'HLT-200']) ?? '';
    const re = new RegExp(grep);
    assert.ok(re.test('GET /health > [HLT-200] answers UP'));
    assert.ok(!re.test('[HLT-200-EXTRA] something'), 'an id never matches a longer id');
    assert.ok(!re.test('[CRT-201] creates'));
    assert.equal(grepForScenarios([]), undefined);
  });
});

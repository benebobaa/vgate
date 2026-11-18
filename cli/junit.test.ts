import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeSummaries, parseJunit, testcaseNames } from './junit.ts';

// The shape Playwright's junit reporter writes (reports/junit/playwright-api.xml).
const XML = `<testsuites id="" name="" tests="6" failures="2" skipped="1" errors="1" time="1.5">
<testsuite name="orders/create.spec.ts" timestamp="2026-11-13T07:35:09.383Z" hostname="api" tests="4" failures="1" skipped="1" time="1.2" errors="0">
<testcase name="POST /orders › [ORD-401] a caller without a key is refused" classname="orders/create.spec.ts" time="0.1">
</testcase>
<testcase name="POST /orders › [ORD-201-REPEAT] a repeated key returns the first order" classname="orders/create.spec.ts" time="0.1"/>
<testcase name="POST /orders › [ORD-503] answers 503 while the provider is down" classname="orders/create.spec.ts" time="0">
<skipped>
</skipped>
</testcase>
<testcase name="POST /orders › [ORD-201] a paid order is stored and published once" classname="orders/create.spec.ts" time="17.941">
<system-out>
<![CDATA[
[[ATTACHMENT|../test-results/orders-create-POST-a41c2-api/trace.zip]]
]]>
</system-out>
<failure message="Contract violations: POST /orders -&gt; 201 [X-Request-Id 0c9e7a21] &quot;amount&quot; &amp; more&#10;second line of the message" type="expect.toEqual">
<![CDATA[  [api] › orders/create.spec.ts:19:3 › POST /orders › [ORD-201] a paid order is stored and published once

    Error: Contract violations: POST /orders -> 201 [X-Request-Id 0c9e7a21]

       at ../../../framework/http/client.ts:323
        at ApiClient.call (/repo/framework/http/client.ts:323:9)
        at /repo/regression/orders/tests/orders/create.spec.ts:24:5
]]>
</failure>
</testcase>
</testsuite>
<testsuite name="notes/notes.spec.ts" timestamp="2026-11-13T07:35:09.383Z" hostname="api" tests="2" failures="1" skipped="0" time="0.3" errors="1">
<testcase name="lists notes without a scenario id" classname="notes/notes.spec.ts" time="0.1">
<failure message="expect(received).toBe(expected)" type="expect.toBe">
<![CDATA[  [api] › notes/notes.spec.ts:7:1 › lists notes without a scenario id
]]>
</failure>
</testcase>
<testcase name="GET /notes › [NOTE-200] lists the caller&apos;s notes" classname="notes/notes.spec.ts" time="0.2">
<error message="connect ECONNREFUSED 127.0.0.1:8090" type="Error">
<![CDATA[  [api] › notes/notes.spec.ts:12:3 › GET /notes › [NOTE-200] lists the caller's notes
]]>
</error>
</testcase>
</testsuite>
</testsuites>`;

describe('parseJunit', () => {
  const summary = parseJunit(XML);

  it('counts every testcase: passed, self-closing, skipped, failed and errored', () => {
    assert.equal(summary.total, 6);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.failed, 3);
    assert.equal(summary.failures.length, 3);
  });

  it('gives a failure its scenario id, title, file and line', () => {
    const [failure] = summary.failures;
    assert.equal(failure.id, 'ORD-201');
    assert.equal(failure.title, 'POST /orders › [ORD-201] a paid order is stored and published once');
    assert.equal(failure.file, 'orders/create.spec.ts');
    // The first location of the test's own file: where the test is declared, not the frame deeper in the stack.
    assert.equal(failure.line, 19);
  });

  it('decodes the message and keeps its first line only', () => {
    assert.equal(
      summary.failures[0].message,
      'Contract violations: POST /orders -> 201 [X-Request-Id 0c9e7a21] "amount" & more',
    );
  });

  it('leaves the id out when the title has none', () => {
    const failure = summary.failures[1];
    assert.equal(failure.id, undefined);
    assert.equal(failure.title, 'lists notes without a scenario id');
    assert.equal(failure.line, 7);
  });

  it('reports an <error> like a failure, with entities in the title decoded', () => {
    const failure = summary.failures[2];
    assert.equal(failure.id, 'NOTE-200');
    assert.equal(failure.title, "GET /notes › [NOTE-200] lists the caller's notes");
    assert.equal(failure.file, 'notes/notes.spec.ts');
    assert.equal(failure.line, 12);
    assert.equal(failure.message, 'connect ECONNREFUSED 127.0.0.1:8090');
  });

  it('caps a very long message', () => {
    const long = parseJunit(
      `<testcase name="t" classname="a.spec.ts"><failure message="${'x'.repeat(900)}"></failure></testcase>`,
    );
    assert.equal(long.failures[0].message.length, 400);
    assert.equal(long.failures[0].line, undefined);
  });

  it('reads nothing from a report without testcases', () => {
    assert.deepEqual(parseJunit('<testsuites tests="0"></testsuites>'), {
      total: 0,
      failed: 0,
      skipped: 0,
      failures: [],
      knownFailures: [],
    });
  });
});

// What Playwright writes for registered tests: the `fail` annotation of testInfo.fail() and the registry's own.
const KNOWN = `<testsuites>
<testsuite name="notes.spec.ts" tests="3">
<testcase name="POST /notes › [CRT-201] creates a note" classname="notes.spec.ts" time="0.1">
<properties>
<property name="known-failure" value="CRT-201 BUG-9 (owner team, expires 2026-12-31): F-003">
</property>
<property name="fail" value="known failure BUG-9: F-003">
</property>
</properties>
</testcase>
<testcase name="POST /notes › [CRT-400] refuses {}" classname="notes.spec.ts" time="0.1">
<properties>
<property name="known-failure" value="CRT-400 BUG-10 (owner team, expires 2026-12-31): F-004">
</property>
</properties>
<failure message="notes.spec.ts:50:5 [CRT-400] refuses {}" type="FAILURE">
<![CDATA[  [api] › notes.spec.ts:50:5 › POST /notes › [CRT-400] refuses {}
    Expected to fail, but passed.
]]>
</failure>
</testcase>
<testcase name="GET /notes › [LST-200] lists notes" classname="notes.spec.ts" time="0.1">
<properties>
<property name="issue" value="https://example.test/1">
</property>
</properties>
</testcase>
</testsuite>
</testsuites>`;

describe('known failures in the report', () => {
  const summary = parseJunit(KNOWN);

  it('counts a registered test that failed as tolerated, not failed', () => {
    assert.equal(summary.total, 3);
    assert.equal(summary.failed, 1);
    assert.deepEqual(summary.knownFailures, [
      { id: 'CRT-201', ticket: 'BUG-9', title: 'POST /notes › [CRT-201] creates a note', file: 'notes.spec.ts' },
    ]);
  });

  it('fails a registered test that passed, saying the entry must go', () => {
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].id, 'CRT-400');
    assert.equal(summary.failures[0].line, 50);
    assert.match(summary.failures[0].message, /^Expected to fail \(known failure CRT-400, BUG-10\) but passed/);
  });

  it('ignores other annotations', () => {
    assert.equal(summary.knownFailures.filter((hit) => hit.id === 'LST-200').length, 0);
  });

  it('lists every testcase title', () => {
    assert.deepEqual(testcaseNames(KNOWN), [
      'POST /notes › [CRT-201] creates a note',
      'POST /notes › [CRT-400] refuses {}',
      'GET /notes › [LST-200] lists notes',
    ]);
  });
});

describe('mergeSummaries', () => {
  it('adds the counts and keeps the failures in order', () => {
    const api = parseJunit(XML);
    const faults = parseJunit(
      '<testcase name="[ORD-504] x" classname="faults/kc.spec.ts"><failure message="boom"></failure></testcase>',
    );
    const merged = mergeSummaries([api, faults]);
    assert.equal(merged.total, 7);
    assert.equal(merged.failed, 4);
    assert.equal(merged.skipped, 1);
    assert.deepEqual(
      merged.failures.map((failure) => failure.id),
      ['ORD-201', undefined, 'NOTE-200', 'ORD-504'],
    );
  });

  it('keeps the known failures of every report', () => {
    const merged = mergeSummaries([parseJunit(KNOWN), parseJunit(KNOWN)]);
    assert.equal(merged.knownFailures.length, 2);
  });

  it('is empty for no reports', () => {
    assert.deepEqual(mergeSummaries([]), { total: 0, failed: 0, skipped: 0, failures: [], knownFailures: [] });
  });
});

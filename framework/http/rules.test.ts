import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDatetimeOffsets, checkHeaders, matchesExpected } from './rules.ts';

describe('matchesExpected', () => {
  it('compares exact values, /regex/ patterns and {name} templates', () => {
    assert.ok(matchesExpected('nosniff', 'nosniff', {}));
    assert.ok(!matchesExpected('nosniff', 'sniff', {}));
    assert.ok(matchesExpected('/^Bearer/', 'Bearer realm="x"', {}));
    assert.ok(!matchesExpected('/^Bearer/', 'Basic', {}));
    assert.ok(matchesExpected('{origin}', 'http://fe', { origin: 'http://fe' }));
    assert.ok(!matchesExpected('x', undefined, {}));
  });
});

describe('checkHeaders', () => {
  const rules = {
    always: { 'X-Request-Id': '/^[0-9a-f-]{36}$/' },
    withBody: { 'Content-Type': 'application/json' },
    cors: { 'Access-Control-Allow-Origin': '{origin}' },
    onStatus: { '401': { 'WWW-Authenticate': '/^Bearer/' } },
  };
  const id = '3f1c2b9e-0000-4000-8000-000000000000';

  it('passes a response that follows every applicable rule (header names are case-insensitive)', () => {
    const headers = { 'x-request-id': id, 'content-type': 'application/json' };
    assert.deepEqual(checkHeaders(rules, { status: 200, headers, hasBody: true }), []);
  });

  it('applies withBody only with a body, cors only with an Origin, onStatus only on that status', () => {
    const headers = { 'x-request-id': id };
    assert.deepEqual(checkHeaders(rules, { status: 204, headers, hasBody: false }), []);
    assert.deepEqual(checkHeaders(rules, { status: 204, headers, hasBody: false, origin: 'http://fe' }), [
      'header Access-Control-Allow-Origin (cors): expected {origin}, got <absent>',
    ]);
    assert.deepEqual(checkHeaders(rules, { status: 401, headers, hasBody: false }), [
      'header WWW-Authenticate (onStatus 401): expected /^Bearer/, got <absent>',
    ]);
  });

  it('reports a wrong value with what was received', () => {
    assert.deepEqual(checkHeaders(rules, { status: 200, headers: { 'x-request-id': 'nope' }, hasBody: false }), [
      'header X-Request-Id (always): expected /^[0-9a-f-]{36}$/, got nope',
    ]);
  });

  it('checks nothing without rules', () => {
    assert.deepEqual(checkHeaders(undefined, { status: 500, headers: {}, hasBody: true }), []);
  });
});

describe('checkDatetimeOffsets', () => {
  it('requires the offset on every datetime, wherever it is in the body', () => {
    const body = {
      ok: '2026-11-13T10:00:00+01:00',
      utc: '2026-11-13T03:00:00Z',
      list: [{ at: '2026-11-13T10:00:00.123' }],
      date: '2026-11-13',
      text: 'not a date',
    };
    assert.deepEqual(checkDatetimeOffsets(body, '+01:00'), [
      '/utc: datetime 2026-11-13T03:00:00Z lacks offset +01:00',
      '/list/0/at: datetime 2026-11-13T10:00:00.123 lacks offset +01:00',
    ]);
  });

  it('checks nothing without a configured offset', () => {
    assert.deepEqual(checkDatetimeOffsets({ at: '2026-11-13T03:00:00Z' }, undefined), []);
  });
});

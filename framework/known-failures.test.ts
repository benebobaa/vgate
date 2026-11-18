import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  annotationFor,
  checkRegistry,
  lookup,
  parseAnnotation,
  parseRegistry,
  RegistryError,
  titleIds,
  today,
  type KnownFailure,
} from './known-failures.ts';

const VALID = `
failures:
  - id: CRT-201
    ticket: BUG-123
    owner: team-api
    expires: 2026-12-31
    reason: F-001 updatedAt is null
  - id: CRT-400
    match: 'refuses {}'
    ticket: BUG-124
    owner: team-api
    expires: 2026-11-30
    reason: F-002
`;

const entry = (overrides: Partial<KnownFailure> = {}): KnownFailure => ({
  id: 'CRT-201',
  ticket: 'BUG-123',
  owner: 'team-api',
  expires: '2026-12-31',
  reason: 'F-001',
  ...overrides,
});

describe('parseRegistry', () => {
  it('reads valid entries and keeps dates as written', () => {
    const entries = parseRegistry(VALID, 'kf.yaml');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].expires, '2026-12-31');
    assert.equal(entries[1].match, 'refuses {}');
  });

  it('treats an empty file or an empty list as no entries', () => {
    assert.deepEqual(parseRegistry('', 'kf.yaml'), []);
    assert.deepEqual(parseRegistry('failures: []\n', 'kf.yaml'), []);
    assert.deepEqual(parseRegistry('failures:\n', 'kf.yaml'), []);
  });

  it('names the file and every bad entry at once', () => {
    const text = `
failures:
  - id: areq-200
    ticket: BUG 1
    owner: x
    expires: 2026-02-30
    reason: r
  - id: CRT-400
    ticket: BUG-2
    expires: 2026-01-01
    reason: r
    severity: high
`;
    assert.throws(
      () => parseRegistry(text, 'services/x/known-failures.yaml'),
      (error: Error) => {
        assert.ok(error instanceof RegistryError);
        for (const part of [
          'services/x/known-failures.yaml: failures[0] (areq-200): id must look like a scenario id',
          'failures[0] (areq-200): ticket must be one word',
          'failures[0] (areq-200): expires must be a date',
          'failures[1] (CRT-400): unknown field "severity"',
          'failures[1] (CRT-400): "owner" is required',
        ])
          assert.ok(error.message.includes(part), `missing: ${part}\n${error.message}`);
        return true;
      },
    );
  });

  it('refuses a duplicate id and match, but not the same id with another match', () => {
    const base = '  - { id: A-1, ticket: T-1, owner: o, expires: 2026-01-01, reason: r';
    assert.throws(() => parseRegistry(`failures:\n${base} }\n${base} }\n`, 'kf.yaml'), /duplicate/);
    assert.equal(parseRegistry(`failures:\n${base} }\n${base}, match: x }\n`, 'kf.yaml').length, 2);
  });

  it('refuses a document that is not a mapping of failures', () => {
    assert.throws(() => parseRegistry('- id: A\n', 'kf.yaml'), /single key "failures"/);
    assert.throws(() => parseRegistry('known: []\n', 'kf.yaml'), /single key "failures"/);
    assert.throws(() => parseRegistry('failures: {}\n', 'kf.yaml'), /must be a list/);
  });
});

describe('lookup', () => {
  const title = 'POST /notes › [CRT-201] creates a note';

  it('finds the entry for the scenario id in the title while it has not expired', () => {
    assert.equal(lookup([entry()], title, '2026-12-31').active?.ticket, 'BUG-123');
    assert.deepEqual(lookup([entry()], title, '2026-12-31').expired, []);
  });

  it('stops applying the day after it expires, and reports it as expired', () => {
    const found = lookup([entry()], title, '2027-01-01');
    assert.equal(found.active, undefined);
    assert.equal(found.expired.length, 1);
  });

  it('matches the whole id, not a prefix of a longer one', () => {
    assert.equal(lookup([entry()], 'x › [CRT-201-TWICE] again', '2026-01-01').active, undefined);
  });

  it('narrows by match text when given', () => {
    const narrowed = entry({ match: 'rejects {}' });
    assert.ok(lookup([narrowed], '[CRT-201] rejects {}', '2026-01-01').active);
    assert.equal(lookup([narrowed], '[CRT-201] rejects []', '2026-01-01').active, undefined);
  });

  it('ignores a title without a scenario id', () => {
    assert.equal(lookup([entry()], 'creates a note', '2026-01-01').active, undefined);
  });
});

describe('checkRegistry', () => {
  it('reports expired entries and entries no test title matches', () => {
    const live = entry();
    const old = entry({ id: 'OLD-1', expires: '2026-01-01' });
    const gone = entry({ id: 'GONE-1' });
    const result = checkRegistry([live, old, gone], '2026-06-01', ['a › [CRT-201] x', 'b › [OLD-1] y']);
    assert.deepEqual(
      result.expired.map((e) => e.id),
      ['OLD-1'],
    );
    assert.deepEqual(
      result.stale.map((e) => e.id),
      ['GONE-1'],
    );
  });

  it('skips the stale check without the titles of a complete run', () => {
    assert.deepEqual(checkRegistry([entry({ id: 'GONE-1' })], '2026-06-01').stale, []);
  });
});

describe('annotations and helpers', () => {
  it('round-trips id and ticket through the annotation', () => {
    const annotation = annotationFor(entry());
    assert.equal(annotation.type, 'known-failure');
    assert.deepEqual(parseAnnotation(annotation.description), { id: 'CRT-201', ticket: 'BUG-123' });
  });

  it('reads every scenario id of a title', () => {
    assert.deepEqual(titleIds('AUTH › [AUTH-401-MISSING] POST /x [CRT-1]'), ['AUTH-401-MISSING', 'CRT-1']);
  });

  it('formats today as YYYY-MM-DD in local time', () => {
    assert.equal(today(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  });
});

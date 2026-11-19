import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { impactFails, impactLoosening, originAllowed, parseUi } from './config.ts';
import type { Incident } from '../incidents.ts';
import { scenarioIds, uiCoverage, untestedScenarios } from './plan.ts';

describe('the sealed browser: which origins a page may reach', () => {
  const app = 'http://localhost:8094';

  it("lets the page reach its own origin under 'self', and nothing else by default", () => {
    assert.ok(originAllowed('http://localhost:8094/api/notes?limit=20', app, ['self']));
    assert.ok(!originAllowed('https://example.com/beacon', app, ['self']));
    // Same host, another port or scheme, is another origin.
    assert.ok(!originAllowed('http://localhost:8093/notes', app, ['self']));
    assert.ok(!originAllowed('https://localhost:8094/', app, ['self']));
  });

  it('allows exactly the listed origins, and never by prefix or subdomain', () => {
    const allowed = ['self', 'https://cdn.example.com'];
    assert.ok(originAllowed('https://cdn.example.com/lib.js', app, allowed));
    assert.ok(!originAllowed('https://cdn.example.com.evil.net/lib.js', app, allowed));
    assert.ok(!originAllowed('https://evil.cdn.example.com/lib.js', app, allowed));
    // Without 'self' the app's own origin is not implied.
    assert.ok(!originAllowed('http://localhost:8094/', app, ['https://cdn.example.com']));
  });

  it('keeps in-page content in the browser, and refuses other schemes and garbage', () => {
    assert.ok(originAllowed('data:image/png;base64,AAAA', app, ['self']));
    assert.ok(originAllowed('blob:http://localhost:8094/1234', app, ['self']));
    assert.ok(!originAllowed('ftp://example.com/x', app, ['self']));
    assert.ok(!originAllowed('not a url', app, ['self']));
  });

  it("counts a websocket to the app's own host as its origin", () => {
    assert.ok(originAllowed('ws://localhost:8094/live', app, ['self']));
    assert.ok(!originAllowed('wss://push.example.com/', app, ['self']));
    assert.ok(originAllowed('wss://push.example.com/', app, ['https://push.example.com']));
  });
});

describe('accessibility: which axe findings fail', () => {
  it('fails at and above the configured impact', () => {
    assert.ok(impactFails('serious', 'serious'));
    assert.ok(impactFails('critical', 'serious'));
    assert.ok(!impactFails('moderate', 'serious'));
    assert.ok(!impactFails('minor', 'moderate'));
    assert.ok(impactFails('minor', 'minor'));
  });

  it('treats a finding without an impact as serious, never as harmless', () => {
    assert.ok(impactFails(undefined, 'serious'));
    assert.ok(impactFails(null, 'serious'));
    assert.ok(impactFails('unheard-of', 'serious'));
    assert.ok(!impactFails(undefined, 'critical'));
  });

  it('ranks a lower bar as a loosening', () => {
    assert.ok(impactLoosening('serious', 'critical') > 0);
    assert.ok(impactLoosening('serious', 'moderate') < 0);
    assert.equal(impactLoosening('serious', 'serious'), 0);
  });
});

describe('parseUi', () => {
  it('fills the defaults: self only, desktop and mobile, a fixed clock, serious and above', () => {
    const ui = parseUi({});
    assert.deepEqual(ui?.allowedOrigins, ['self']);
    assert.deepEqual(Object.keys(ui?.viewports ?? {}), ['desktop', 'mobile']);
    assert.equal(ui?.a11y.minImpact, 'serious');
    assert.match(ui?.clock ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(parseUi(undefined), undefined);
  });

  it('normalises origins and refuses anything it would have to guess', () => {
    assert.deepEqual(parseUi({ allowedOrigins: ['self', 'https://cdn.example.com/'] })?.allowedOrigins, [
      'self',
      'https://cdn.example.com',
    ]);
    assert.throws(() => parseUi({ allowedOrigins: ['https://cdn.example.com/path'] }), /not an origin/);
    assert.throws(() => parseUi({ allowedOrigins: ['*'] }), /not an origin/);
    assert.throws(() => parseUi({ a11y: { minImpact: 'none' } }), /minImpact/);
    assert.throws(() => parseUi({ viewports: { tiny: { width: 0, height: 10 } } }), /width and height/);
    assert.throws(() => parseUi({ clock: 'yesterday' }), /ISO 8601/);
    assert.throws(() => parseUi({ budgets: { lcpMs: -1 } }), /non-negative/);
  });
});

describe('the plan of a UI service', () => {
  const plan = {
    pages: [{ scenarios: [{ id: 'UI-A' }, { id: 'UI-A-B' }] }],
    conventions: { scenarios: [{ id: 'UI-C' }] },
  };

  it('collects every scenario id, wherever it is planned', () => {
    assert.deepEqual(scenarioIds(plan).sort(), ['UI-A', 'UI-A-B', 'UI-C']);
  });

  it('counts a scenario as tested only by its whole id in a collected title', () => {
    const titles = ['notes › [UI-A-B] a longer id', 'conventions › [UI-C] checked'];
    assert.deepEqual(untestedScenarios(scenarioIds(plan), titles), ['UI-A']);
    assert.deepEqual(untestedScenarios(['UI-A'], ['x › [UI-A] y']), []);
  });
});

describe('UI coverage: incidents are guarded as for an API service', () => {
  // Built in memory: self-tests also run inside users' projects, where no reference service exists.
  const incident = (id: string, extra: Partial<Incident> = {}): Incident => ({
    id,
    title: `escaped bug ${id}`,
    date: '2026-11-19',
    scenario: id,
    status: 'open',
    file: `incidents/${id}.yaml`,
    ...extra,
  });
  const ids = ['UI-A', 'INC-1', 'INC-2'];

  it('fails an incident without a collected [INC-n] test, and one missing from the plan', () => {
    const titles = ['notes › [UI-A] lists notes', 'notes › [INC-2] keeps the draft after a failed save'];
    const result = uiCoverage(ids, titles, [incident('INC-1'), incident('INC-2'), incident('INC-3')]);
    assert.deepEqual(
      result.unguarded.map((i) => [i.id, i.state]),
      [
        ['INC-1', 'no-test'],
        ['INC-3', 'no-scenario'],
      ],
    );
    assert.equal(result.incidents.find((i) => i.id === 'INC-2')?.state, 'guarded');
    // INC-1 is also a planned scenario without a test: both views name it.
    assert.deepEqual(result.untested, ['INC-1']);
  });

  it('matches the whole id, and exempts only a not-testable incident', () => {
    const titles = ['notes › [INC-12] something else'];
    const result = uiCoverage(['INC-1', 'INC-4'], titles, [
      incident('INC-1'),
      incident('INC-4', { missedBy: 'not-testable', reason: 'a browser bug' }),
    ]);
    assert.deepEqual(
      result.unguarded.map((i) => i.id),
      ['INC-1'],
    );
    assert.equal(result.incidents.find((i) => i.id === 'INC-4')?.state, 'exempt');
  });

  it('has nothing to guard without incidents', () => {
    assert.deepEqual(uiCoverage(['UI-A'], ['[UI-A] x'], []).unguarded, []);
  });
});

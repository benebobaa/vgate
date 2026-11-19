import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBaseline, uiConfigRule, visualRule } from './guard.ts';
import { uiFacts } from './gate.ts';

const shot = 'regression/web/tests/__screenshots__/linux/visual.spec.ts/signin-desktop.png';

describe('visualRule: committed screenshots are expectations', () => {
  it('sends a changed or deleted baseline to a human, and takes a new one as additive', () => {
    const other = 'regression/web/tests/__screenshots__/linux/visual.spec.ts/signin-mobile.png';
    const added = 'regression/web/tests/__screenshots__/linux/visual.spec.ts/notes-desktop.png';
    const result = visualRule(
      new Map([
        [shot, 'aaa'],
        [other, 'bbb'],
      ]),
      new Map([
        [shot, 'ccc'],
        [added, 'ddd'],
      ]),
    );
    assert.deepEqual(
      result.findings.map((f) => [f.file, f.detail]),
      [
        [shot, 'a visual baseline changed: check the image diff'],
        [other, 'a visual baseline was deleted'],
      ],
    );
    assert.deepEqual(
      result.info.map((f) => f.file),
      [added],
    );
  });

  it('says nothing when the images are the same', () => {
    const same = new Map([[shot, 'aaa']]);
    const result = visualRule(same, new Map(same));
    assert.deepEqual([result.findings, result.info], [[], []]);
  });

  it('recognises baselines by their place, not by any png', () => {
    assert.ok(isBaseline(shot));
    assert.ok(!isBaseline('regression/web/tests/fixtures/logo.png'));
    assert.ok(!isBaseline('regression/web/tests/__screenshots__/linux/notes.txt'));
  });
});

describe('uiConfigRule: the browser rules may only get stricter without a human', () => {
  const yaml = (ui: string) => `name: web\nui:\n${ui}`;
  const base = yaml(
    [
      '  allowedOrigins: [self]',
      '  viewports: { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } }',
      '  a11y: { minImpact: serious }',
      '  budgets: { lcpMs: 2500, cls: 0.1 }',
    ].join('\n'),
  );
  const details = (head: string | undefined) => uiConfigRule('service.yaml', base, head).findings.map((f) => f.detail);

  it('flags every loosening, naming it', () => {
    const head = yaml(
      [
        "  allowedOrigins: [self, 'https://tracker.example.com']",
        '  viewports: { desktop: { width: 1280, height: 800 } }',
        '  a11y: { minImpact: critical, disable: [color-contrast] }',
        '  budgets: { lcpMs: 4000 }',
      ].join('\n'),
    );
    assert.deepEqual(details(head), [
      'ui.a11y.minImpact lowered the bar: serious -> critical',
      'ui.a11y.disable now skips the axe rule color-contrast',
      'ui.allowedOrigins now lets the page reach https://tracker.example.com',
      'ui.viewports: mobile is no longer checked',
      'ui.budgets.lcpMs raised: 2500 -> 4000',
      'ui.budgets.cls removed (was 0.1)',
    ]);
  });

  it('flags removing ui: altogether, and accepts a stricter setting silently', () => {
    assert.deepEqual(details('name: web\n'), [
      'ui: removed: the browser rules (sealed page, accessibility, budgets) no longer apply',
    ]);
    const stricter = yaml(
      [
        '  allowedOrigins: [self]',
        '  viewports: { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } }',
        '  a11y: { minImpact: moderate }',
        '  budgets: { lcpMs: 2000, cls: 0.05 }',
      ].join('\n'),
    );
    assert.deepEqual(details(stricter), []);
    // A service that never had ui: has nothing to loosen.
    assert.deepEqual(uiConfigRule('service.yaml', 'name: api\n', stricter).findings, []);
  });
});

describe('the verdict sums the browser findings', () => {
  it('counts pages once, and names hosts and accessibility rules', () => {
    const finding = (over: object) => ({
      test: 't',
      pages: ['http://localhost:8094/', 'http://localhost:8094/?x=1'],
      outbound: [],
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
      a11y: [],
      budgetBreaches: [],
      ...over,
    });
    const facts = uiFacts([
      finding({}),
      finding({
        outbound: [{ method: 'GET', url: 'https://example.com/beacon' }],
        a11y: [{ id: 'label', impact: 'critical', help: 'h', url: 'u', targets: ['#key'] }],
        consoleErrors: ['boom'],
      }),
    ]);
    assert.deepEqual(facts, {
      tests: 2,
      pages: 1,
      outbound: ['example.com'],
      consoleErrors: 1,
      a11y: ['label (critical)'],
      budgetBreaches: [],
    });
  });
});

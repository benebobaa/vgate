import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isBaseline, testsRule, uiConfigRule, visualRule } from './guard.ts';
import { baselineHashes, baselinesChanged, summarise, uiFacts, type Verdict } from './gate.ts';

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

describe('gate: a run that writes visual baselines', () => {
  it('names every baseline the run added or changed, and never passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vgate-baselines-'));
    try {
      const shots = join(dir, 'tests', '__screenshots__', 'linux', 'visual.spec.ts');
      mkdirSync(shots, { recursive: true });
      writeFileSync(join(shots, 'signin-desktop.png'), 'old');
      writeFileSync(join(shots, 'signin-mobile.png'), 'same');
      const before = baselineHashes(dir);
      // What Playwright does with VGATE_UPDATE_SNAPSHOTS=1: rewrites a differing baseline, writes a missing one.
      writeFileSync(join(shots, 'signin-desktop.png'), 'new');
      writeFileSync(join(shots, 'notes-desktop.png'), 'added');
      assert.deepEqual(baselinesChanged(before, baselineHashes(dir)), [
        'tests/__screenshots__/linux/visual.spec.ts/notes-desktop.png',
        'tests/__screenshots__/linux/visual.spec.ts/signin-desktop.png',
      ]);
      assert.deepEqual(baselinesChanged(before, before), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says so in the summary', () => {
    const verdict = {
      service: 'web',
      environment: 'local',
      verdict: 'fail',
      complete: true,
      durationMs: 1000,
      steps: [{ name: 'test', status: 'pass', durationMs: 1, log: 'l' }],
      sandbox: { kind: 'script', sealed: false, outbound: [] },
      ui: { ...uiFacts([]), baselinesWritten: ['regression/web/tests/__screenshots__/linux/a.png'] },
    } as unknown as Verdict;
    assert.match(summarise(verdict), /the run wrote 1 visual baseline instead of comparing them/);
  });
});

describe('testsRule: a screenshot comparison that accepts more', () => {
  const spec = 'regression/web/tests/visual.spec.ts';
  const base = `await expect(page).toHaveScreenshot('signin.png', { fullPage: true });\n`;
  const details = (head: string) =>
    testsRule(new Map([[spec, base]]), new Map([[spec, head]])).findings.map((f) => f.detail);

  it('sends a new tolerance, mask, clip or style to a human, with the same number of assertions', () => {
    assert.deepEqual(
      details(`await expect(page).toHaveScreenshot('signin.png', { fullPage: true, maxDiffPixelRatio: 1 });\n`),
      ['a screenshot comparison now accepts more: maxDiffPixelRatio: 1'],
    );
    assert.deepEqual(
      details(
        `await expect(page).toHaveScreenshot('signin.png', {\n  fullPage: true,\n  mask: [page.locator('main')],\n});\n`,
      ),
      ["a screenshot comparison now accepts more: mask: [page.locator('main')]"],
    );
    assert.deepEqual(details(`await expect(page).toHaveScreenshot('signin.png');\n`), [
      'a screenshot comparison no longer covers the full page (fullPage: true removed)',
    ]);
  });

  it('notices a loosened value, and ignores options in comments or unchanged ones', () => {
    const tolerant = `await expect(page).toHaveScreenshot('a.png', { fullPage: true, maxDiffPixels: 10 });\n`;
    const looser = tolerant.replace('maxDiffPixels: 10', 'maxDiffPixels: 5000');
    assert.deepEqual(
      testsRule(new Map([[spec, tolerant]]), new Map([[spec, looser]])).findings.map((f) => f.detail),
      ['a screenshot comparison now accepts more: maxDiffPixels: 5000'],
    );
    assert.deepEqual(details(`${base}// mask: [page.locator('main')]\n`), []);
    assert.deepEqual(details(base), []);
  });
});

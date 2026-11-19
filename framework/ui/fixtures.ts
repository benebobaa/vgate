/**
 * Browser fixtures for a UI service (`ui:` in service.yaml): every test drives a real page, and the page is held to
 * the same rules a backend is, automatically, with no line in the test:
 *
 *   - sealed browser: a request (or websocket) to an origin outside `ui.allowedOrigins` is blocked and recorded; a
 *     redirect to such an origin, which Playwright cannot route, is recorded;
 *   - console errors (and failed `console.assert`s) and page errors, and failed requests to the app's own origin, in
 *     the page and in every popup it opens, fail the test unless it expects them;
 *   - accessibility: axe-core runs after every `page.goto`, on every popup the page opens once it has loaded, and at
 *     the end of the test; findings at or above `ui.a11y.minImpact` fail it, and so does a page of the app reached
 *     otherwise (a click, a form, client-side routing) or a dialog shown on the same URL that the test never
 *     checked with `ui.checkA11y()` while it was there;
 *   - visual baselines: the screenshots each test compares are recorded, so the coverage step can tell a committed
 *     baseline no test compares any more;
 *   - web vitals: LCP and CLS against `ui.budgets`, when set;
 *   - determinism for screenshots: fixed clock, locale, time zone, colour scheme, reduced motion, scale 1.
 *
 * Findings go to <reports>/ui/<run>-w<worker>.jsonl (the gate summarises them in the verdict) and, when the test
 * fails, to its `ui-findings.json` attachment. Docs: docs/frontend.md.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page, Request, Response } from '@playwright/test';
import { reportsDir, type ServiceConfig } from '../config.ts';
import { createTest } from '../fixtures.ts';
import type { DataPath } from '../http/client.ts';
import { impactFails, originAllowed, type UiConfig } from './config.ts';

export interface A11yFinding {
  id: string;
  impact: string;
  help: string;
  url: string;
  targets: string[];
}

export interface UiFindings {
  test: string;
  pages: string[];
  /** `via`: the URL that redirected there (a redirect cannot be blocked, only recorded). */
  outbound: Array<{ method: string; url: string; via?: string }>;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: Array<{ method: string; url: string; status: number }>;
  a11y: A11yFinding[];
  vitals?: { lcpMs?: number; cls?: number };
  budgetBreaches: string[];
  /** The visual baselines (absolute paths) the test's `toHaveScreenshot` calls compared against. */
  screenshots?: string[];
  /** Pages of the app (origin + path) reached without `page.goto` and never checked for accessibility. */
  uncheckedPages?: string[];
  /** Dialogs shown (a view change on the same URL) and never checked for accessibility while open. */
  uncheckedDialogs?: string[];
}

/** A dialog the page showed: one record each time one becomes visible (`id` is unique in the context). */
interface DialogShown {
  id: string;
  label: string;
  url: string;
}

interface ExpectedRequest {
  method?: string;
  path: RegExp;
  status?: number;
}

/** What a test can tell the page watch, and a few conveniences. */
export class Ui {
  private readonly expectedConsole: RegExp[] = [];
  private readonly expectedRequests: ExpectedRequest[] = [];
  /** Pages of the app the main frame showed, and those axe checked: origin + path. */
  private readonly visited = new Set<string>();
  private readonly checked = new Set<string>();
  /** Dialogs shown, and the ids of those axe ran while they were open. */
  private readonly dialogs: DialogShown[] = [];
  private readonly checkedDialogs = new Set<string>();

  constructor(
    private readonly page: Page,
    readonly config: UiConfig,
    readonly appOrigin: string,
    readonly findings: UiFindings,
  ) {}

  /** The app's URL for a path. */
  url(path = '/'): string {
    return new URL(path, `${this.appOrigin}/`).toString();
  }

  /** Switches to a declared viewport (`ui.viewports`). */
  async viewport(name: string): Promise<void> {
    const size = this.config.viewports[name];
    if (!size)
      throw new Error(`No viewport "${name}" in ui.viewports (have: ${Object.keys(this.config.viewports).join(', ')})`);
    await this.page.setViewportSize(size);
  }

  /** A console error the test causes on purpose (e.g. a rejected form); unexpected ones still fail the test. */
  expectConsoleError(pattern: RegExp): void {
    this.expectedConsole.push(pattern);
  }

  /** A failing response the test causes on purpose, e.g. `{ method: 'POST', path: /\/api\/notes$/, status: 400 }`. */
  expectFailedRequest(expected: ExpectedRequest): void {
    this.expectedRequests.push(expected);
  }

  /** A page of the app, as accessibility is tracked: origin + path (a query or a fragment is the same page). */
  private pageOf(url: string): string | undefined {
    try {
      const target = new URL(url);
      return target.origin === this.appOrigin ? `${target.origin}${target.pathname}` : undefined;
    } catch {
      return undefined;
    }
  }

  /** @internal The main frame now shows `url`. */
  navigated(url: string): void {
    const page = this.pageOf(url);
    if (page) this.visited.add(page);
  }

  /**
   * Runs axe on the page as it is now. It runs by itself after every goto and at the end of the test; a page reached
   * any other way (a click, a form, client-side routing) must be checked by the test once it has rendered.
   */
  async checkA11y(target: Page = this.page): Promise<void> {
    const url = target.url();
    if (!url.startsWith('http')) return;
    // The dialogs open right now are checked by this run: a dialog is a view of its own on the same URL.
    const open = await target
      .evaluate(() => (globalThis as unknown as { __vgateDialogs?: { open(): string[] } }).__vgateDialogs?.open() ?? [])
      .catch(() => [] as string[]);
    const results = await new AxeBuilder({ page: target }).disableRules(this.config.a11y.disable).analyze();
    for (const id of open) this.checkedDialogs.add(id);
    const page = this.pageOf(url);
    if (page) this.checked.add(page);
    for (const violation of results.violations) {
      if (!impactFails(violation.impact, this.config.a11y.minImpact)) continue;
      const targets = violation.nodes.map((node) => node.target.join(' '));
      const known = this.findings.a11y.find((f) => f.id === violation.id && f.url === url);
      if (known) known.targets = [...new Set([...known.targets, ...targets])];
      else
        this.findings.a11y.push({
          id: violation.id,
          impact: violation.impact ?? 'serious',
          help: violation.help,
          url,
          targets,
        });
    }
  }

  /** @internal Pages of the app the test reached and never checked for accessibility. */
  uncheckedPages(): string[] {
    return [...this.visited].filter((page) => !this.checked.has(page));
  }

  /** @internal The page showed a dialog. */
  dialogShown(dialog: DialogShown): void {
    this.dialogs.push(dialog);
  }

  /** @internal Dialogs shown and never checked for accessibility while they were open. */
  uncheckedDialogs(): string[] {
    return this.dialogs
      .filter((d) => !this.checkedDialogs.has(d.id))
      .map((d) => `"${d.label}" [${d.url}]`)
      .filter((d, i, all) => all.indexOf(d) === i);
  }

  /** @internal Problems the test did not declare, as lines; empty when the page behaved. */
  problems(): string[] {
    const f = this.findings;
    const unexpectedConsole = f.consoleErrors.filter((text) => !this.expectedConsole.some((p) => p.test(text)));
    const unexpectedRequests = f.failedRequests.filter(
      (r) =>
        !this.expectedRequests.some(
          (e) =>
            (e.method === undefined || e.method.toUpperCase() === r.method) &&
            e.path.test(new URL(r.url).pathname) &&
            (e.status === undefined || e.status === r.status),
        ),
    );
    return [
      ...f.outbound.map((o) =>
        o.via
          ? `the page was redirected from ${o.via} to ${o.method} ${o.url}, outside ui.allowedOrigins (a redirect cannot be blocked)`
          : `the page tried to reach ${o.method} ${o.url}, outside ui.allowedOrigins (blocked)`,
      ),
      ...f.pageErrors.map((e) => `uncaught error in the page: ${e}`),
      ...unexpectedConsole.map((e) => `console error: ${e}`),
      ...unexpectedRequests.map((r) => `request failed: ${r.method} ${r.url} -> ${r.status}`),
      ...f.a11y.map(
        (a) => `accessibility (${a.impact}) ${a.id}: ${a.help} at ${a.targets.slice(0, 3).join(', ')} [${a.url}]`,
      ),
      ...(f.uncheckedPages ?? []).map(
        (p) =>
          `accessibility not checked on ${p}: the test reached it without page.goto; call await ui.checkA11y() once it has rendered`,
      ),
      ...(f.uncheckedDialogs ?? []).map(
        (d) =>
          `accessibility not checked on the dialog ${d}: it was shown and closed without a check; call await ui.checkA11y() while it is open`,
      ),
      ...f.budgetBreaches,
    ];
  }
}

// Runs in the page before any of its scripts: the web-vitals entries the budget is judged on.
const VITALS_SCRIPT = `(() => {
  const v = (window.__vgateVitals = { lcp: undefined, cls: 0 });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) v.lcp = e.renderTime || e.loadTime || e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) v.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
})();`;

// Runs in every page and popup before its scripts: reports each time a dialog becomes visible (role=dialog or
// alertdialog, with or without aria-modal, or an open <dialog>) and answers which are open now. Ids are unique in
// the context, so a check in one page never stands for a dialog of another.
const DIALOG_SCRIPT = `(() => {
  if (window.__vgateDialogs) return;
  const doc = document;
  const prefix = Math.random().toString(36).slice(2, 10);
  let seq = 0;
  const open = new Map();
  // Modal or not: a dialog that forgets aria-modal is still a view of its own (and the commoner bug).
  const isDialog = (el) => el.matches('[role="dialog"], [role="alertdialog"]') || (el.tagName === 'DIALOG' && el.open);
  const visible = (el) => {
    if (!el.isConnected || el.closest('[hidden]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const labelOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    const named = by && doc.getElementById(by);
    const heading = el.querySelector('h1, h2, h3, h4');
    return (el.getAttribute('aria-label') || (named && named.textContent) || (heading && heading.textContent) || 'dialog').trim().slice(0, 80);
  };
  const scan = () => {
    const now = new Set();
    for (const el of doc.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog')) {
      if (!isDialog(el) || !visible(el)) continue;
      now.add(el);
      if (!open.has(el)) {
        const id = prefix + '-' + ++seq;
        open.set(el, id);
        try { window.__vgateDialogShown({ id, label: labelOf(el), url: location.href }); } catch {}
      }
    }
    for (const el of [...open.keys()]) if (!now.has(el)) open.delete(el);
  };
  window.__vgateDialogs = { open: () => { scan(); return [...open.values()]; }, scan };
  new MutationObserver(scan).observe(doc, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'role', 'aria-modal'],
  });
  doc.addEventListener('DOMContentLoaded', scan);
})();`;

const RESOURCE_ERROR =
  /^Failed to load resource: (?:the server responded with a status of \d+|net::ERR_BLOCKED_BY_CLIENT)/;

function uiOf(svc: ServiceConfig): { config: UiConfig; base: string } {
  if (!svc.ui) throw new Error(`${svc.name} declares no ui: in service.yaml; browser fixtures are for UI services`);
  return { config: svc.ui, base: (svc.ui.baseUrl ?? svc.env.baseUrl).replace(/\/$/, '') };
}

/**
 * The framework's test for a UI service: everything `createTest` gives (api, svc, unique, known failures) plus a
 * watched `page` and the `ui` helper. A service's support/fixtures.ts calls it like createTest.
 */
export function createUiTest<P = unknown, D extends DataPath = undefined>() {
  return createTest<P, D>().extend<{ ui: Ui; uiWatch: Ui }>({
    // Deterministic rendering: the same page draws the same pixels on every run of one machine.
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    // A missing element fails the step in seconds, naming it, instead of the whole test timing out.
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    baseURL: async ({ svc }, use) => {
      await use(uiOf(svc).base);
    },
    viewport: async ({ svc }, use) => {
      const { config } = uiOf(svc);
      await use(config.viewports.desktop ?? Object.values(config.viewports)[0]);
    },
    uiWatch: [
      async ({ page, svc }, use, testInfo) => {
        const { config, base } = uiOf(svc);
        const appOrigin = new URL(base).origin;
        const findings: UiFindings = {
          test: testInfo.titlePath.slice(1).join(' › '),
          pages: [],
          outbound: [],
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          a11y: [],
          budgetBreaches: [],
        };
        const ui = new Ui(page, config, appOrigin, findings);
        const context = page.context();

        // The baselines this test compares (the coverage step names a committed one no test compares any more).
        // Playwright resolves every snapshot path through this method of the test's info; it is internal, so a
        // Playwright without it stops the run rather than leaving the baselines unaccounted for.
        const info = testInfo as unknown as {
          _resolveSnapshotPaths?: (kind: string, ...rest: unknown[]) => { absoluteSnapshotPath: string };
        };
        const resolveSnapshot = info._resolveSnapshotPaths;
        if (typeof resolveSnapshot !== 'function')
          throw new Error(
            'This Playwright has no testInfo._resolveSnapshotPaths: vgate cannot record the visual baselines a test compares (framework/ui/fixtures.ts)',
          );
        findings.screenshots = [];
        info._resolveSnapshotPaths = function (this: unknown, kind: string, ...rest: unknown[]) {
          const paths = resolveSnapshot.call(this, kind, ...rest);
          if (kind === 'screenshot') findings.screenshots?.push(paths.absoluteSnapshotPath);
          return paths;
        };

        // Sealed browser: nothing leaves for an origin the service did not declare.
        await context.route('**/*', async (route) => {
          const request = route.request();
          if (originAllowed(request.url(), appOrigin, config.allowedOrigins)) return route.fallback();
          findings.outbound.push({ method: request.method(), url: request.url() });
          return route.abort('blockedbyclient');
        });
        // Playwright routes only the first request of a redirect chain: an allowed URL that redirects elsewhere
        // reaches the other origin unrouted. It cannot be blocked here, but it is recorded, and fails the test.
        context.on('request', (request) => {
          const from = request.redirectedFrom();
          if (!from || originAllowed(request.url(), appOrigin, config.allowedOrigins)) return;
          if (findings.outbound.some((o) => o.url === request.url() && o.method === request.method())) return;
          findings.outbound.push({ method: request.method(), url: request.url(), via: from.url() });
        });
        await context.routeWebSocket(/.*/, (ws) => {
          if (originAllowed(ws.url(), appOrigin, config.allowedOrigins)) ws.connectToServer();
          else {
            findings.outbound.push({ method: 'WEBSOCKET', url: ws.url() });
            void ws.close();
          }
        });

        // The whole context, so a popup the page opens is held to the same rules as the page.
        context.on('console', (message) => {
          if (message.type() !== 'error' && message.type() !== 'assert') return;
          // Failed responses are judged once, by their request (method, path, status), not again as console text.
          if (RESOURCE_ERROR.test(message.text())) return;
          findings.consoleErrors.push(message.text());
        });
        context.on('weberror', (error) => findings.pageErrors.push(error.error().message));
        const own = (request: Request) => {
          try {
            return new URL(request.url()).origin === appOrigin;
          } catch {
            return false;
          }
        };
        context.on('response', (response: Response) => {
          const request = response.request();
          if (response.status() >= 400 && own(request))
            findings.failedRequests.push({ method: request.method(), url: request.url(), status: response.status() });
        });
        context.on('requestfailed', (request) => {
          // A blocked outbound request is already recorded as such.
          if (own(request) && request.failure()?.errorText !== 'net::ERR_BLOCKED_BY_CLIENT')
            findings.failedRequests.push({ method: request.method(), url: request.url(), status: 0 });
        });
        page.on('framenavigated', (frame) => {
          if (frame !== page.mainFrame() || !frame.url().startsWith('http')) return;
          findings.pages.push(frame.url());
          ui.navigated(frame.url());
        });

        await page.clock.setFixedTime(new Date(config.clock));
        if (config.budgets) await page.addInitScript(VITALS_SCRIPT);
        // Dialogs (a view change on the same URL) in the page and its popups: each one shown must be checked.
        await context.exposeBinding('__vgateDialogShown', (_source, dialog: DialogShown) => ui.dialogShown(dialog));
        await context.addInitScript(DIALOG_SCRIPT);
        // A popup the page opens is checked for accessibility once it has loaded (and again at the end if still open).
        const popups: Page[] = [];
        const popupChecks: Array<Promise<void>> = [];
        context.on('page', (popup) => {
          if (popup === page) return;
          popups.push(popup);
          popupChecks.push(
            popup
              .waitForLoadState('load')
              .then(() => {
                // A popup that loaded is a page the test reached: unchecked (closed before the check ran) it fails.
                ui.navigated(popup.url());
                return ui.checkA11y(popup);
              })
              .catch(() => undefined),
          );
        });

        // Every navigation the test makes is checked for accessibility once the page has loaded.
        const goto = page.goto.bind(page);
        page.goto = async (...args: Parameters<Page['goto']>) => {
          const response = await goto(...args);
          await ui.checkA11y();
          return response;
        };

        await use(ui);

        await Promise.all(popupChecks);
        for (const popup of popups) if (!popup.isClosed()) await ui.checkA11y(popup).catch(() => undefined);
        if (!page.isClosed()) {
          await ui.checkA11y().catch(() => undefined);
          if (config.budgets) {
            const vitals = (await page
              .evaluate(
                () => (globalThis as unknown as { __vgateVitals?: { lcp?: number; cls: number } }).__vgateVitals,
              )
              .catch(() => undefined)) ?? { cls: 0 };
            findings.vitals = { lcpMs: vitals.lcp === undefined ? undefined : Math.round(vitals.lcp), cls: vitals.cls };
            if (config.budgets.lcpMs !== undefined && vitals.lcp !== undefined && vitals.lcp > config.budgets.lcpMs)
              findings.budgetBreaches.push(
                `LCP ${Math.round(vitals.lcp)} ms above the budget ${config.budgets.lcpMs} ms`,
              );
            if (config.budgets.cls !== undefined && vitals.cls > config.budgets.cls)
              findings.budgetBreaches.push(`CLS ${vitals.cls.toFixed(3)} above the budget ${config.budgets.cls}`);
          }
        }

        findings.uncheckedPages = ui.uncheckedPages();
        findings.uncheckedDialogs = ui.uncheckedDialogs();
        const file = resolve(reportsDir, 'ui', `${process.env.RUN_ID ?? 'run'}-w${testInfo.workerIndex}.jsonl`);
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify(findings)}\n`);

        const problems = ui.problems();
        if (problems.length > 0) {
          await testInfo.attach('ui-findings.json', {
            body: JSON.stringify(findings, null, 2),
            contentType: 'application/json',
          });
          throw new Error(`The page broke the UI rules (docs/frontend.md):\n  ${problems.join('\n  ')}`);
        }
      },
      { auto: true },
    ],
    ui: async ({ uiWatch }, use) => {
      await use(uiWatch);
    },
  });
}

export { expect } from '@playwright/test';

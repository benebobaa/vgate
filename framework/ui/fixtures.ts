/**
 * Browser fixtures for a UI service (`ui:` in service.yaml): every test drives a real page, and the page is held to
 * the same rules a backend is, automatically, with no line in the test:
 *
 *   - sealed browser: a request (or websocket) to an origin outside `ui.allowedOrigins` is blocked and recorded;
 *   - console and page errors, and failed requests to the app's own origin, fail the test unless it expects them;
 *   - accessibility: axe-core runs after every `page.goto` and at the end of the test; findings at or above
 *     `ui.a11y.minImpact` fail it;
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
  outbound: Array<{ method: string; url: string }>;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: Array<{ method: string; url: string; status: number }>;
  a11y: A11yFinding[];
  vitals?: { lcpMs?: number; cls?: number };
  budgetBreaches: string[];
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

  /** Runs axe on the page as it is now (it also runs after every goto and at the end of the test). */
  async checkA11y(): Promise<void> {
    const url = this.page.url();
    if (!url.startsWith('http')) return;
    const results = await new AxeBuilder({ page: this.page }).disableRules(this.config.a11y.disable).analyze();
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
      ...f.outbound.map((o) => `the page tried to reach ${o.method} ${o.url}, outside ui.allowedOrigins (blocked)`),
      ...f.pageErrors.map((e) => `uncaught error in the page: ${e}`),
      ...unexpectedConsole.map((e) => `console error: ${e}`),
      ...unexpectedRequests.map((r) => `request failed: ${r.method} ${r.url} -> ${r.status}`),
      ...f.a11y.map(
        (a) => `accessibility (${a.impact}) ${a.id}: ${a.help} at ${a.targets.slice(0, 3).join(', ')} [${a.url}]`,
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
export function createUiTest<P = unknown>() {
  return createTest<P>().extend<{ ui: Ui; uiWatch: Ui }>({
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

        // Sealed browser: nothing leaves for an origin the service did not declare.
        await context.route('**/*', async (route) => {
          const request = route.request();
          if (originAllowed(request.url(), appOrigin, config.allowedOrigins)) return route.fallback();
          findings.outbound.push({ method: request.method(), url: request.url() });
          return route.abort('blockedbyclient');
        });
        await context.routeWebSocket(/.*/, (ws) => {
          if (originAllowed(ws.url(), appOrigin, config.allowedOrigins)) ws.connectToServer();
          else {
            findings.outbound.push({ method: 'WEBSOCKET', url: ws.url() });
            void ws.close();
          }
        });

        page.on('console', (message) => {
          if (message.type() !== 'error') return;
          // Failed responses are judged once, by their request (method, path, status), not again as console text.
          if (RESOURCE_ERROR.test(message.text())) return;
          findings.consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => findings.pageErrors.push(error.message));
        const own = (request: Request) => {
          try {
            return new URL(request.url()).origin === appOrigin;
          } catch {
            return false;
          }
        };
        page.on('response', (response: Response) => {
          const request = response.request();
          if (response.status() >= 400 && own(request))
            findings.failedRequests.push({ method: request.method(), url: request.url(), status: response.status() });
        });
        page.on('requestfailed', (request) => {
          // A blocked outbound request is already recorded as such.
          if (own(request) && request.failure()?.errorText !== 'net::ERR_BLOCKED_BY_CLIENT')
            findings.failedRequests.push({ method: request.method(), url: request.url(), status: 0 });
        });
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame() && frame.url().startsWith('http')) findings.pages.push(frame.url());
        });

        await page.clock.setFixedTime(new Date(config.clock));
        if (config.budgets) await page.addInitScript(VITALS_SCRIPT);

        // Every navigation the test makes is checked for accessibility once the page has loaded.
        const goto = page.goto.bind(page);
        page.goto = async (...args: Parameters<Page['goto']>) => {
          const response = await goto(...args);
          await ui.checkA11y();
          return response;
        };

        await use(ui);

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

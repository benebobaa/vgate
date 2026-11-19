/**
 * The browser fixtures (fixtures.ts) against a live page: what a test's page does must be recorded and fail the test.
 * Runs the runtime's own Playwright on a throwaway project in a temp directory, with an app server and an "outside"
 * server on free ports. Needs Chromium; without it (a fresh project before `vgate doctor --fix`) it is skipped.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium } from '@playwright/test';

const runtime = resolve(import.meta.dirname, '..', '..');
const browser = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><main><h1>Fixture</h1>${body}</main></body></html>`;

function listen(server: Server): Promise<number> {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)));
}

interface Outcome {
  status: string;
  message: string;
}

describe('the browser fixtures on a live page', { skip: browser ? false : 'Chromium is not installed' }, () => {
  let dir = '';
  let app: Server;
  let outside: Server;
  const reached: string[] = [];
  const results = new Map<string, Outcome>();
  let findings: Array<{ test: string; screenshots?: string[] }> = [];

  before(async () => {
    outside = createServer((req, res) => {
      reached.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('outside');
    });
    const outsidePort = await listen(outside);
    const ext = `http://localhost:${outsidePort}`;
    app = createServer((req, res) => {
      const html = (body: string) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(page(body));
      };
      if (req.url === '/redirect' || req.url === '/redirect-img') {
        res.writeHead(302, { location: `${ext}${req.url}-target` });
        res.end();
      } else if (req.url === '/img-redirect') html('<img alt="x" src="/redirect-img">');
      else if (req.url === '/throws') html('<script>throw new Error("popup threw")</script>');
      else if (req.url === '/spa')
        html(`<button id="go">Go</button><script>
          document.getElementById('go').onclick = () => { history.pushState({}, '', '/spa/next'); };
        </script>`);
      else html('<p>hello</p>');
    });
    const appPort = await listen(app);

    dir = mkdtempSync(join(tmpdir(), 'vgate-ui-fixtures-'));
    const svc = join(dir, 'services', 'web');
    mkdirSync(join(svc, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'vgate.yaml'), 'version: 0.0.0\nservicesDir: services\n');
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(
      join(svc, 'service.yaml'),
      [
        'name: web',
        'ui: { allowedOrigins: [self], a11y: { minImpact: serious } }',
        'environments:',
        '  local:',
        '    disposable: true',
        `    baseUrl: http://localhost:${appPort}`,
        '    healthPath: /',
        '',
      ].join('\n'),
    );
    const fixtures = JSON.stringify(join(runtime, 'framework', 'ui', 'fixtures.ts'));
    writeFileSync(
      join(svc, 'tests', 'page.spec.ts'),
      `import { createUiTest, expect } from ${fixtures};
const test = createUiTest();
const settle = (page: import('@playwright/test').Page) => page.waitForTimeout(500);
test('redirect-navigation', async ({ page, ui }) => { await page.goto(ui.url('/redirect')).catch(() => undefined); await settle(page); });
test('redirect-subresource', async ({ page, ui }) => { await page.goto(ui.url('/img-redirect')); await settle(page); });
test('popup-console-error', async ({ page, ui }) => {
  await page.goto(ui.url('/'));
  await page.evaluate(() => { const w = window.open('/'); (w as unknown as { eval(s: string): void }).eval('console.error("popup said no")'); });
  await settle(page);
});
test('popup-page-error', async ({ page, ui }) => {
  await page.goto(ui.url('/'));
  await page.evaluate(() => { window.open('/throws'); });
  await settle(page);
});
test('console-assert', async ({ page, ui }) => { await page.goto(ui.url('/')); await page.evaluate(() => console.assert(false, 'assertion in page')); await settle(page); });
test('client-side-page-unchecked', async ({ page, ui }) => {
  await page.goto(ui.url('/spa'));
  await page.getByRole('button', { name: 'Go' }).click();
  await page.waitForURL('**/spa/next');
  await page.evaluate(() => history.pushState({}, '', '/spa'));
});
test('client-side-page-checked', async ({ page, ui }) => {
  await page.goto(ui.url('/spa'));
  await page.getByRole('button', { name: 'Go' }).click();
  await page.waitForURL('**/spa/next');
  await ui.checkA11y();
});
test('screenshot-recorded', async ({ page, ui }) => {
  await page.goto(ui.url('/'));
  await expect(page).toHaveScreenshot('home.png');
});
`,
    );
    const reports = join(dir, 'reports');
    // Asynchronous: the servers above answer from this process while Playwright runs.
    const run = await new Promise<{ stdout: string; stderr: string }>((done, failed) => {
      const child = spawn(
        join(runtime, 'node_modules', '.bin', 'playwright'),
        ['test', '--config', join(runtime, 'playwright.config.ts'), '--project', 'api', '--reporter', 'json'],
        {
          cwd: runtime,
          env: {
            ...process.env,
            VGATE_PROJECT: dir,
            VGATE_SERVICES_DIR: 'services',
            VGATE_REPORTS: reports,
            SERVICE: 'web',
            TEST_ENV: 'local',
            WORKERS: '2',
            VGATE_UPDATE_SNAPSHOTS: '',
            RUN_ID: 'fx',
          },
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', failed);
      child.on('close', () => done({ stdout, stderr }));
    });
    if (!run.stdout.trim().startsWith('{')) throw new Error(`playwright did not report:\n${run.stdout}\n${run.stderr}`);
    const report = JSON.parse(run.stdout) as {
      suites: Array<{
        specs: Array<{
          title: string;
          tests: Array<{ results: Array<{ status: string; error?: { message?: string } }> }>;
        }>;
      }>;
    };
    for (const spec of report.suites.flatMap((s) => s.specs)) {
      const result = spec.tests[0].results[0];
      results.set(spec.title, { status: result.status, message: result.error?.message ?? '' });
    }
    if (results.size === 0)
      throw new Error(
        `no test ran:\n${JSON.stringify((JSON.parse(run.stdout) as { errors?: unknown }).errors).slice(0, 3000)}\n${run.stderr}`,
      );
    const ui = join(reports, 'ui');
    findings = readdirSync(ui).flatMap((file) =>
      readFileSync(join(ui, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { test: string; screenshots?: string[] }),
    );
  });

  after(() => {
    app?.close();
    outside?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const failsWith = (title: string, pattern: RegExp) => {
    const outcome = results.get(title);
    assert.ok(outcome, `${title} ran`);
    assert.equal(outcome.status, 'failed', `${title} must fail: ${outcome.message}`);
    assert.match(outcome.message, pattern);
  };

  it('records a redirect to an origin outside allowedOrigins, which Playwright does not route', () => {
    failsWith(
      'redirect-navigation',
      /redirected from http:\/\/localhost:\d+\/redirect to GET http:\/\/localhost:\d+\/redirect-target/,
    );
    failsWith('redirect-subresource', /redirected from .*\/redirect-img to GET .*\/redirect-img-target/);
  });

  it('holds a popup the page opens to the console and page-error rules', () => {
    failsWith('popup-console-error', /console error: popup said no/);
    failsWith('popup-page-error', /uncaught error in the page: popup threw/);
  });

  it('counts a failed console.assert as a console error', () => {
    failsWith('console-assert', /console error: assertion in page/);
  });

  it('fails a page reached by client-side routing that the test never checked for accessibility', () => {
    failsWith('client-side-page-unchecked', /accessibility not checked on http:\/\/localhost:\d+\/spa\/next/);
    assert.equal(
      results.get('client-side-page-checked')?.status,
      'passed',
      results.get('client-side-page-checked')?.message ?? 'did not run',
    );
  });

  it('records the visual baseline a screenshot assertion compares, even when it is missing', () => {
    failsWith('screenshot-recorded', /home\.png/);
    const shots = findings.find((f) => f.test.endsWith('screenshot-recorded'))?.screenshots ?? [];
    assert.equal(shots.length, 1);
    assert.match(shots[0], /__screenshots__\/[a-z0-9]+\/page\.spec\.ts\/home\.png$/);
  });
});

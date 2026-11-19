import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { loadService, reportsDir } from './framework/config.ts';

// The runtime's config, for any project: the tests are the project's (VGATE_PROJECT), the evidence goes to the
// project's reports directory, and everything else (global setup, retries, reporters) is the judge's.
const svc = loadService();
// `task test` runs the api and faults suites as separate invocations; each keeps its own HTML and JUnit report.
const suite = process.env.PW_SUITE ?? 'all';

export default defineConfig({
  testDir: `${svc.dir}/tests`,
  outputDir: join(reportsDir, 'test-results'),
  globalSetup: './framework/global-setup.ts',
  // A gate that retries hides flakiness; a focused test hides everything else.
  retries: 0,
  forbidOnly: true,
  workers: Number(process.env.WORKERS ?? 4),
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    // Visual baselines (UI services, docs/frontend.md): pixel-exact on one platform (no pixel may differ, by any shade),
    // no animation or caret.
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0, threshold: 0 },
  },
  // Baselines live next to the tests, one set per platform: fonts render differently on macOS and Linux.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{testFilePath}/{arg}{ext}',
  // A missing or different baseline fails; only an explicit `VGATE_UPDATE_SNAPSHOTS=1` run writes new ones, and the
  // guard sends a changed baseline to a human.
  updateSnapshots: process.env.VGATE_UPDATE_SNAPSHOTS === '1' ? 'all' : 'none',
  reporter: [
    ['list'],
    ['html', { outputFolder: join(reportsDir, 'html', suite), open: 'never' }],
    ['junit', { outputFile: join(reportsDir, 'junit', `playwright-${suite}.xml`) }],
    [
      'allure-playwright',
      {
        resultsDir: join(reportsDir, 'allure-results'),
        environmentInfo: { service: svc.name, environment: svc.env.name, baseUrl: svc.env.baseUrl },
      },
    ],
  ],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'api', testIgnore: '**/faults/**' },
    // Dependency faults pause shared containers, so they must never run beside other tests. A plain
    // `playwright test` orders them after `api` (and skips them when `api` fails); `task test` runs them as a
    // separate invocation with --no-deps, so a failing api suite never hides a fault result.
    { name: 'faults', testMatch: '**/faults/**/*.spec.ts', dependencies: ['api'], fullyParallel: false },
  ],
});

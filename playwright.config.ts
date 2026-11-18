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
  expect: { timeout: 10_000 },
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

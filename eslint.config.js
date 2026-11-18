import process from 'node:process';
import js from '@eslint/js';
import playwright from 'eslint-plugin-playwright';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// The runtime's rules, for any project. vgate lints a separate project from its root (VGATE_PROJECT) with this file,
// so the patterns below are relative to that root and name its services directory; in this checkout, both default
// to this directory and services/.
const services = process.env.VGATE_SERVICES_DIR ?? 'services';
const projectRoot = process.env.VGATE_PROJECT ?? import.meta.dirname;

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      '.claude/**',
      'reports/**',
      'dist/**',
      `${services}/node_modules/**`,
      `${services}/*/generated/**`,
      `${services}/*/perf/**`,
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: projectRoot },
    },
    rules: {
      // Playwright fixtures must destructure their first argument, even when they use none.
      'no-empty-pattern': 'off',
      // A forgotten await on an API call or an expect is the most common false-green in API tests.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: [`${services}/*/tests/**/*.ts`],
    ...playwright.configs['flat/recommended'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      // The gate must never pass because a test was focused or skipped by accident.
      'playwright/no-focused-test': 'error',
      // A conditional skip selects environments (e.g. faults need a disposable one); an unconditional one hides a test.
      'playwright/no-skipped-test': ['error', { allowConditional: true }],
      'playwright/expect-expect': ['error', { assertFunctionPatterns: ['^expect'] }],
      // Scenario tables build tests in loops; titles stay unique through the scenario id.
      'playwright/valid-title': 'off',
    },
  },
  {
    // A failing test leaves the gate green only through services/<svc>/known-failures.yaml: one protected file a
    // human reviews, with a ticket and an expiry. Marks inside the tests (or their helpers) would bypass both.
    files: [`${services}/*/tests/**/*.ts`, `${services}/*/support/**/*.ts`],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          'MemberExpression[property.name=/^(fail|fixme)$/][object.name=/^(test|testInfo|it)$/]',
          "MemberExpression[property.name=/^(fail|fixme)$/][object.property.name='describe']",
          "MemberExpression[property.name=/^(fail|fixme)$/][object.callee.property.name='info']",
        ].map((selector) => ({
          selector,
          message:
            'Tests never mark themselves as failing: a human adds an entry to the known-failures registry (docs/known-failures.md).',
        })),
      ],
    },
  },
  {
    // The framework's and the CLI's own tests (node:test): describe/it return promises the runner awaits itself.
    files: ['framework/**/*.test.ts', 'cli/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'it'] }] },
      ],
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);

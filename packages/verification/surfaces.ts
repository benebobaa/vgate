import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

export const SURFACES = ['api', 'web', 'cli', 'library', 'desktop', 'mobile'] as const;
export type SurfaceKind = (typeof SURFACES)[number];

export interface CliCheckSpec {
  id: string;
  title: string;
  command: string;
  args?: string[];
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
  expectExitCode?: number;
  expectStdout?: string;
  expectStderr?: string;
  expectJson?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface LibrarySurfaceConfig {
  testCommand: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SurfaceCheckResult {
  id: string;
  title: string;
  ok: boolean;
  exitCode: number | null;
  detail?: string;
  durationMs: number;
}

export interface SurfaceRunReport {
  schema: 'vgate.surface/1';
  surface: SurfaceKind;
  ok: boolean;
  durationMs: number;
  passed: number;
  failed: number;
  checks: SurfaceCheckResult[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verifies that `actual` partially matches `expected`: every key in an expected plain object
 * must exist in `actual` and recursively match. Arrays require matching length and elements.
 * Returns null on match, or a human-readable mismatch description.
 */
function matchPartialJson(actual: unknown, expected: unknown, path = '$'): string | null {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return `${path}: expected object, got ${actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual}`;
    }
    for (const [key, expVal] of Object.entries(expected)) {
      if (!(key in actual)) {
        return `${path}.${key}: missing expected key`;
      }
      const mismatch = matchPartialJson(actual[key], expVal, `${path}.${key}`);
      if (mismatch !== null) return mismatch;
    }
    return null;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return `${path}: expected array, got ${actual === null ? 'null' : typeof actual}`;
    }
    if (actual.length !== expected.length) {
      return `${path}: expected array length ${expected.length}, got ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const mismatch = matchPartialJson(actual[i], expected[i], `${path}[${i}]`);
      if (mismatch !== null) return mismatch;
    }
    return null;
  }

  if (!Object.is(actual, expected)) {
    return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }

  return null;
}

function truncateDetail(text: string, maxLen = 400): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}…`;
}

/**
 * Executes a sequence of CLI checks with `shell: false`, validating exit codes,
 * stdout/stderr regexes, and optional partial JSON output assertions.
 */
export function runCliSurface(checks: CliCheckSpec[], cwd: string): SurfaceRunReport {
  const totalStart = performance.now();
  const results: SurfaceCheckResult[] = [];

  for (const check of checks) {
    const start = performance.now();
    const res = spawnSync(check.command, check.args ?? [], {
      cwd: check.cwd ?? cwd,
      input: check.stdin,
      env: check.env ? { ...process.env, ...check.env } : process.env,
      encoding: 'utf8',
      shell: false,
      timeout: check.timeoutMs,
    });
    const durationMs = Math.round(performance.now() - start);
    const stdout = res.stdout ?? '';
    const stderr = res.stderr ?? '';
    const failures: string[] = [];

    if (res.error) {
      failures.push(`spawn error: ${res.error.message}`);
    } else {
      const expectedExit = check.expectExitCode ?? 0;
      if (res.status !== expectedExit) {
        failures.push(`exit code ${res.status ?? 'null'} !== expected ${expectedExit}`);
      }

      if (check.expectStdout !== undefined) {
        try {
          const re = new RegExp(check.expectStdout);
          if (!re.test(stdout)) {
            failures.push(`stdout did not match /${check.expectStdout}/ (got: ${truncateDetail(stdout, 160)})`);
          }
        } catch (err) {
          failures.push(`invalid expectStdout regex: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (check.expectStderr !== undefined) {
        try {
          const re = new RegExp(check.expectStderr);
          if (!re.test(stderr)) {
            failures.push(`stderr did not match /${check.expectStderr}/ (got: ${truncateDetail(stderr, 160)})`);
          }
        } catch (err) {
          failures.push(`invalid expectStderr regex: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (check.expectJson !== undefined) {
        try {
          const parsed: unknown = JSON.parse(stdout.trim());
          const mismatch = matchPartialJson(parsed, check.expectJson);
          if (mismatch !== null) {
            failures.push(`expectJson mismatch at ${mismatch}`);
          }
        } catch (err) {
          failures.push(`stdout is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const ok = failures.length === 0;
    results.push({
      id: check.id,
      title: check.title,
      ok,
      exitCode: res.status,
      ...(failures.length > 0 ? { detail: failures.join('; ') } : {}),
      durationMs,
    });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  return {
    schema: 'vgate.surface/1',
    surface: 'cli',
    ok: failed === 0,
    durationMs: Math.round(performance.now() - totalStart),
    passed,
    failed,
    checks: results,
  };
}

/**
 * Executes a library surface's native test command with `shell: false`.
 */
export function runLibrarySurface(config: LibrarySurfaceConfig, cwd: string): SurfaceRunReport {
  const start = performance.now();
  const res = spawnSync(config.testCommand, config.args ?? [], {
    cwd: config.cwd ?? cwd,
    env: config.env ? { ...process.env, ...config.env } : process.env,
    encoding: 'utf8',
    shell: false,
    timeout: config.timeoutMs,
  });
  const durationMs = Math.round(performance.now() - start);
  const ok = !res.error && res.status === 0;

  let detail: string | undefined;
  if (!ok) {
    if (res.error) {
      detail = `spawn error: ${res.error.message}`;
    } else {
      const output = (res.stderr ?? '').trim() || (res.stdout ?? '').trim();
      detail = output
        ? `exit code ${res.status ?? 'null'}: ${truncateDetail(output)}`
        : `exit code ${res.status ?? 'null'}`;
    }
  }

  const title = [config.testCommand, ...(config.args ?? [])].join(' ');
  const check: SurfaceCheckResult = {
    id: 'library-tests',
    title,
    ok,
    exitCode: res.status,
    ...(detail !== undefined ? { detail } : {}),
    durationMs,
  };

  return {
    schema: 'vgate.surface/1',
    surface: 'library',
    ok,
    durationMs,
    passed: ok ? 1 : 0,
    failed: ok ? 0 : 1,
    checks: [check],
  };
}

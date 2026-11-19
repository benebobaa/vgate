/**
 * Visual baselines no test compares any more. A committed baseline is an expectation only while a test compares the
 * page with it: a test that stops taking one of its screenshots (a viewport dropped from its loop, a screenshot
 * renamed) leaves the old image in the tree, unchanged, so the guard sees nothing; the coverage step names it instead.
 * The fixtures (fixtures.ts) record the baselines each test compared in <reports>/ui/<run>-w<n>.jsonl.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** The committed baselines of one platform: `<tests>/__screenshots__/<platform>/**\/*.png` (playwright.config.ts). */
export function committedBaselines(serviceDir: string, platform: string = process.platform): string[] {
  const root = join(serviceDir, 'tests', '__screenshots__', platform);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.png')) out.push(path);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** The baselines the last test run compared (its global setup removes the findings of earlier runs). */
export function comparedBaselines(reportsDir: string): string[] {
  const dir = join(reportsDir, 'ui');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => (JSON.parse(line) as { screenshots?: string[] }).screenshots ?? []),
    );
}

/** The committed baselines no compared path names (paths are compared after resolving links: /var vs /private/var). */
export function uncomparedBaselines(committed: readonly string[], compared: readonly string[]): string[] {
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
  const seen = new Set(compared.map(real));
  return committed.filter((path) => !seen.has(real(path)));
}

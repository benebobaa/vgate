/**
 * The registry check that follows the tests (part of `task test`, so of the gate). Exits 1 when an entry has expired,
 * or when an entry matches no test of the run: a renamed or removed test leaves an entry that protects nothing and
 * would silently tolerate a future test that reuses the id.
 *
 *   tsx framework/cli/known-failures.ts [--partial]
 *
 * --partial: the run was filtered (`task test -- --grep ...`), so a test missing from it proves nothing; only expiry
 * is checked. Which registered tests passed is Playwright's verdict (expected to fail, but passed), not this script's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { testcaseNames } from '../../cli/junit.ts';
import { loadService, reportsDir } from '../config.ts';
import { checkRegistry, describeEntry, loadRegistry, registryPath, today } from '../known-failures.ts';
import { parseArgs } from './args.ts';

const JUNIT = ['playwright-api.xml', 'playwright-faults.xml'].map((file) => resolve(reportsDir, 'junit', file));

const args = parseArgs(process.argv.slice(2), ['partial']);
const svc = loadService();
const entries = loadRegistry(svc.dir);
if (entries.length === 0) process.exit(0);

const files = JUNIT.filter((file) => existsSync(file));
const partial = args.partial === true || files.length === 0;
const titles = partial ? undefined : files.flatMap((file) => testcaseNames(readFileSync(file, 'utf8')));
const { expired, stale } = checkRegistry(entries, today(), titles);

const file = relative(process.cwd(), registryPath(svc.dir));
const lines = [
  `Known failures (${file}): ${entries.length} entries, ${expired.length} expired, ` +
    (partial ? 'stale not checked (partial run)' : `${stale.length} stale`),
  ...expired.map((entry) => `  EXPIRED  ${describeEntry(entry)}: fix the backend, or a human renews the entry`),
  ...stale.map((entry) => `  STALE    ${describeEntry(entry)}: no test of this run matches it; remove the entry`),
];
process.stdout.write(`${lines.join('\n')}\n`);
if (expired.length > 0 || stale.length > 0) process.exit(1);

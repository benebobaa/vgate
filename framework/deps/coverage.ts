/**
 * Provider coverage: which documented (operation, status) of each stubbed provider at least one test stubbed in the
 * last run. A provider answer no test ever simulates is behaviour of the service nobody verified (a decline path, an
 * outage path).
 *
 *   tsx framework/deps/coverage.ts --service example-orders [--strict]
 *
 * Reads the stub records the `stubs` fixture writes (reports/observed/*.stubs.ndjson), writes
 * reports/coverage/providers.json, and with --strict exits 1 on a documented provider answer no test stubbed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail, parseArgs, str } from '../cli/args.ts';
import { loadService, reportsDir } from '../config.ts';
import { OpenApiContract } from '../http/openapi.ts';
import { ofKind } from './config.ts';
import type { StubRecord } from './stubs.ts';

export interface ProviderRow {
  dependency: string;
  operation: string;
  status: string;
  stubbed: boolean;
}

/** Documented provider answers x stubbed ones. A documented range (`5XX`) is covered by any status in it. */
export function providerCoverage(contracts: Record<string, OpenApiContract>, records: StubRecord[]): ProviderRow[] {
  return Object.entries(contracts).flatMap(([dependency, contract]) =>
    contract.operations.flatMap((op) =>
      [...op.responses.keys()].map((status) => ({
        dependency,
        operation: op.key,
        status,
        stubbed: records.some(
          (r) =>
            r.dependency === dependency &&
            r.operation === op.key &&
            (String(r.status) === status || (/^\dXX$/.test(status) && String(r.status)[0] === status[0])),
        ),
      })),
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'coverage.ts')) {
  const args = parseArgs(process.argv.slice(2), ['strict']);
  const svc = loadService(str(args.service));
  const stubs = ofKind(svc.env.dependencies ?? {}, 'http-stub');
  const contracts = Object.fromEntries(
    Object.entries(stubs).map(([name, dep]) => [name, OpenApiContract.load(dep.contract)]),
  );
  const observed = resolve(reportsDir, 'observed');
  // No stubbed provider: nothing to cover, whatever the tests observed (a UI service observes no API calls at all).
  if (!existsSync(observed) && Object.keys(stubs).length > 0)
    fail('No observed calls in reports/observed: run the tests first.');
  const records = (existsSync(observed) ? readdirSync(observed) : [])
    .filter((file) => file.endsWith('.stubs.ndjson'))
    .flatMap((file) =>
      readFileSync(join(observed, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as StubRecord),
    );
  const rows = providerCoverage(contracts, records);
  const gaps = rows.filter((row) => !row.stubbed);
  mkdirSync(resolve(reportsDir, 'coverage'), { recursive: true });
  writeFileSync(
    resolve(reportsDir, 'coverage', 'providers.json'),
    JSON.stringify({ service: svc.name, rows }, null, 2),
  );
  process.stdout.write(
    `Provider coverage ${svc.name}: ${rows.length - gaps.length}/${rows.length} documented provider answers stubbed\n` +
      gaps.map((g) => `  UNSTUBBED  ${g.dependency} ${g.operation} ${g.status}\n`).join(''),
  );
  if (args.strict === true && gaps.length > 0) process.exit(1);
}

/**
 * The coverage step of a UI service without a contract (`task coverage` runs it instead of coverage-report.ts): every
 * scenario of the plan has a collected test, and every incident (framework/incidents.ts) is guarded by its scenario and
 * a collected test, as for an API service. Writes <reports>/coverage/coverage.{md,json} like the contract report.
 *
 *   tsx framework/ui/coverage.ts [--strict]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { testcaseNames } from '../../cli/junit.ts';
import { fail, parseArgs } from '../cli/args.ts';
import { loadService, reportsDir } from '../config.ts';
import { readIncidents } from '../incidents.ts';
import { scenarioIds, uiCoverage } from './plan.ts';

const args = parseArgs(process.argv.slice(2), ['strict']);
const svc = loadService();
const planFile = resolve(svc.dir, 'inventory.yaml');
if (!existsSync(planFile))
  fail(`${svc.name}: no inventory.yaml; a UI service's plan is its coverage (docs/frontend.md)`);
const ids = scenarioIds(parse(readFileSync(planFile, 'utf8')));
if (ids.length === 0) fail(`${svc.name}: inventory.yaml plans no scenario; nothing is verified`);

const junit = ['playwright-api.xml', 'playwright-faults.xml']
  .map((file) => resolve(reportsDir, 'junit', file))
  .filter((file) => existsSync(file));
if (junit.length === 0) fail('No JUnit reports in reports/junit: run the tests first (task test).');
const titles = junit.flatMap((file) => testcaseNames(readFileSync(file, 'utf8')));
// An unreadable incident file stops the report: an incident must never vanish from coverage.
const { untested, incidents, unguarded } = uiCoverage(ids, titles, readIncidents(svc.dir));
const covered = ids.length - untested.length;
const percent = Math.round((covered / ids.length) * 1000) / 10;

const outDir = resolve(reportsDir, 'coverage');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, 'coverage.json'),
  JSON.stringify(
    {
      service: svc.name,
      kind: 'ui',
      covered,
      demanded: ids.length,
      excluded: 0,
      percent,
      rows: [],
      untested,
      incidents,
    },
    null,
    2,
  ),
);
writeFileSync(
  resolve(outDir, 'coverage.md'),
  [
    `# Coverage: ${svc.name} (UI)`,
    '',
    `Planned scenarios with a collected test: **${covered}/${ids.length}** (${percent}%).`,
    '',
    ...(untested.length > 0 ? ['## Scenarios without a test', '', ...untested.map((id) => `- \`${id}\``), ''] : []),
    ...(incidents.length > 0
      ? [
          '## Incidents',
          '',
          `Without a regression test: **${unguarded.length}** of ${incidents.length}`,
          '',
          '| Incident | Missed by | State |',
          '| --- | --- | --- |',
          ...incidents.map((i) => `| \`${i.id}\` ${i.title} | ${i.missedBy ?? '-'} | ${i.detail} |`),
          '',
        ]
      : []),
  ].join('\n'),
);
process.stdout.write(
  `Coverage ${svc.name} (UI): ${covered}/${ids.length} planned scenarios tested` +
    (incidents.length > 0 ? `, ${unguarded.length}/${incidents.length} incidents unguarded` : '') +
    '\n' +
    untested.map((id) => `  UNTESTED   ${id}\n`).join('') +
    unguarded.map((i) => `  INCIDENT   ${i.detail}\n`).join('') +
    `Report: ${relative(process.cwd(), resolve(outDir, 'coverage.md'))}\n`,
);
if (args.strict === true && (untested.length > 0 || unguarded.length > 0)) process.exit(1);

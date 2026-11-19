/**
 * The coverage gate. Compares what the contract documents (operation x status x code) with what the last test run
 * observed, and the inventory's scenario ids with the titles of the tests that run collected (its JUnit reports).
 *
 *   tsx framework/cli/coverage-report.ts --service example [--strict]
 *
 * Writes reports/coverage/coverage.{md,json}. With --strict it exits 1 on a gap, on a response code the contract
 * does not document, on an inventory scenario without a test, or on an incident (framework/incidents.ts) that no
 * scenario of the plan and no collected test guards.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { testcaseNames } from '../../cli/junit.ts';
import { loadService, reportsDir, type CoverageExclusion } from '../config.ts';
import { loadContract, type DocumentedPair } from '../http/openapi.ts';
import { incidentCoverage, readIncidents } from '../incidents.ts';
import { fail, parseArgs, str } from './args.ts';

interface Observed {
  method: string;
  path: string;
  status: number;
  code: string | null;
  validated?: boolean;
  test: string;
}

type State = 'covered' | 'excluded' | 'gap';

/** What `task test` writes, one report per suite (Taskfile.yml). */
const JUNIT_FILES = ['playwright-api.xml', 'playwright-faults.xml'];

const args = parseArgs(process.argv.slice(2));
const svc = loadService(str(args.service));
const contract = loadContract(svc);

const observedDir = resolve(reportsDir, 'observed');
if (!existsSync(observedDir)) fail('No observed calls in reports/observed: run the tests first (task test).');
const observed: Observed[] = readdirSync(observedDir)
  .filter((file) => file.endsWith('.jsonl'))
  .flatMap((file) =>
    readFileSync(join(observedDir, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Observed),
  )
  // Calls made outside the contract on purpose (validate: false) neither cover nor violate it.
  .filter((o) => o.validated !== false);

const opKey = (o: Observed) => `${o.method} ${o.path}`;
const matchesExclusion = (pair: DocumentedPair, ex: CoverageExclusion) =>
  (ex.operation === undefined || ex.operation === '*' || ex.operation === pair.operation) &&
  (ex.status === undefined || String(ex.status) === pair.status) &&
  (ex.code === undefined || ex.code === pair.code);

// The plan: its per-operation exclusions count like service.yaml's (both need a reason); its scenario ids are traced.
const inventoryFile = resolve(svc.dir, 'inventory.yaml');
const inventory = existsSync(inventoryFile) ? (parse(readFileSync(inventoryFile, 'utf8')) as unknown) : undefined;
type PlanOperation = { operation?: string; excluded?: Array<Omit<CoverageExclusion, 'operation'>> };
const planExclusions: CoverageExclusion[] = (
  (inventory as { operations?: PlanOperation[] } | undefined)?.operations ?? []
).flatMap((op) =>
  (op.excluded ?? []).map((ex) => ({
    ...ex,
    operation: op.operation,
    status: ex.status === undefined ? undefined : String(ex.status),
  })),
);
const exclusions = [...svc.coverage.exclude, ...planExclusions].filter((ex) => Boolean(ex.reason));

const rows = contract.documentedPairs().map((pair) => {
  const hits = observed.filter(
    (o) =>
      opKey(o) === pair.operation && String(o.status) === pair.status && (pair.code === null || o.code === pair.code),
  );
  const exclusion = exclusions.find((ex) => matchesExclusion(pair, ex));
  const state: State = hits.length > 0 ? 'covered' : exclusion ? 'excluded' : 'gap';
  return { ...pair, state, reason: exclusion?.reason, tests: [...new Set(hits.map((h) => h.test))] };
});

const documentedKeys = new Set(rows.map((r) => `${r.operation} ${r.status} ${r.code ?? '*'}`));
const undocumented = [
  ...new Map(
    observed
      .filter((o) => {
        const op = contract.operation(o.method, o.path);
        if (!op) return true;
        const response = op.responses.get(String(o.status));
        if (!response) return true;
        return response.codes.length > 0 && o.code !== null && !documentedKeys.has(`${opKey(o)} ${o.status} ${o.code}`);
      })
      .map((o) => [`${opKey(o)} ${o.status} ${o.code}`, o] as const),
  ).values(),
];

// Inventory traceability: every planned scenario id is in the title of a test the last run collected. Searching the
// test sources instead would count an id that only sits in a comment or an unused string.
const junitFiles = JUNIT_FILES.map((file) => resolve(reportsDir, 'junit', file)).filter((file) => existsSync(file));
if (junitFiles.length === 0) fail('No JUnit reports in reports/junit: run the tests first (task test).');
const testTitles = junitFiles.flatMap((file) => testcaseNames(readFileSync(file, 'utf8'))).join('\n');
// Every `scenarios: [{ id }]` list anywhere in the plan (per operation, and cross-cutting sections such as auth).
const collectIds = (node: unknown): string[] => {
  if (Array.isArray(node)) return node.flatMap(collectIds);
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'scenarios' && Array.isArray(value)
      ? value.flatMap((s: unknown) =>
          s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string'
            ? [(s as { id: string }).id, ...collectIds(s)]
            : [],
        )
      : collectIds(value),
  );
};
const scenarioIds: string[] = [...new Set(collectIds(inventory))];
// Whole-id match: `CRT-400` must not count as tested because `CRT-400-TITLE` is.
const escape = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const untested = scenarioIds.filter(
  (id) => !new RegExp(`(?<![A-Za-z0-9-])${escape(id)}(?![A-Za-z0-9-])`).test(testTitles),
);

// Incidents: every bug that escaped to production must be guarded by its own scenario and a collected test, unless it
// is recorded as not testable with a reason. An unreadable incident file stops the report: it must never vanish.
const incidents = incidentCoverage(readIncidents(svc.dir), new Set(scenarioIds), testTitles);
const unguarded = incidents.filter((i) => i.state === 'no-scenario' || i.state === 'no-test');

const count = (state: State) => rows.filter((r) => r.state === state).length;
const covered = count('covered');
const excluded = count('excluded');
const gaps = rows.filter((r) => r.state === 'gap');
const demanded = rows.length - excluded;
const percent = demanded === 0 ? 100 : Math.round((covered / demanded) * 1000) / 10;

const icon: Record<State, string> = { covered: 'covered', excluded: 'excluded', gap: '**GAP**' };
const md: string[] = [
  `# Coverage: ${svc.name} (${svc.env.name})`,
  '',
  `Generated ${new Date().toISOString()} from \`${relative(svc.dir, svc.specPath)}\` and ${observed.length} observed calls.`,
  '',
  `- Documented responses covered: **${covered}/${demanded} (${percent}%)**, ${excluded} excluded`,
  `- Gaps: **${gaps.length}**`,
  `- Responses outside the contract: **${undocumented.length}**`,
  `- Inventory scenarios without a test: **${untested.length}** of ${scenarioIds.length}`,
  `- Incidents without a regression test: **${unguarded.length}** of ${incidents.length}`,
  '',
];
if (gaps.length > 0) {
  md.push('## Gaps', '', '| Operation | Status | Code |', '|---|---|---|');
  gaps.forEach((g) => md.push(`| \`${g.operation}\` | ${g.status} | ${g.code ?? '-'} |`));
  md.push('');
}
if (undocumented.length > 0) {
  md.push('## Responses outside the contract', '', '| Operation | Status | Code | Seen in |', '|---|---|---|---|');
  undocumented.forEach((u) => md.push(`| \`${opKey(u)}\` | ${u.status} | ${u.code ?? '-'} | ${u.test} |`));
  md.push('');
}
if (untested.length > 0) {
  md.push('## Inventory scenarios without a test', '', ...untested.map((id) => `- \`${id}\``), '');
}
if (incidents.length > 0) {
  md.push('## Incidents', '', '| Incident | Missed by | State |', '|---|---|---|');
  incidents.forEach((i) => md.push(`| \`${i.id}\` ${i.title} | ${i.missedBy ?? '-'} | ${i.detail} |`));
  md.push('');
}
md.push('## Matrix', '');
for (const op of contract.operations) {
  md.push(`### \`${op.key}\``, '', '| Status | Code | State | Tests / reason |', '|---|---|---|---|');
  rows
    .filter((r) => r.operation === op.key)
    .forEach((r) =>
      md.push(
        `| ${r.status} | ${r.code ?? '-'} | ${icon[r.state]} | ${r.state === 'excluded' ? (r.reason ?? '') : r.tests.slice(0, 3).join('<br>')}${r.tests.length > 3 ? ` (+${r.tests.length - 3})` : ''} |`,
      ),
    );
  md.push('');
}

const outDir = resolve(reportsDir, 'coverage');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'coverage.md'), md.join('\n'));
writeFileSync(
  resolve(outDir, 'coverage.json'),
  JSON.stringify(
    {
      service: svc.name,
      environment: svc.env.name,
      covered,
      demanded,
      excluded,
      percent,
      rows,
      undocumented,
      untested,
      incidents,
    },
    null,
    2,
  ),
);

process.stdout.write(
  `Coverage ${svc.name}: ${covered}/${demanded} documented responses (${percent}%), ${excluded} excluded, ` +
    `${gaps.length} gaps, ${undocumented.length} outside the contract, ${untested.length}/${scenarioIds.length} scenarios untested` +
    (incidents.length > 0 ? `, ${unguarded.length}/${incidents.length} incidents unguarded` : '') +
    '\n' +
    gaps.map((g) => `  GAP        ${g.operation} ${g.status} ${g.code ?? '-'}\n`).join('') +
    undocumented.map((u) => `  UNDOCUMENTED ${opKey(u)} ${u.status} ${u.code ?? '-'} (${u.test})\n`).join('') +
    untested.map((id) => `  UNTESTED   ${id}\n`).join('') +
    unguarded.map((i) => `  INCIDENT   ${i.detail}\n`).join('') +
    `Report: ${relative(process.cwd(), resolve(outDir, 'coverage.md'))}\n`,
);
if (args.strict === true && (gaps.length > 0 || undocumented.length > 0 || untested.length > 0 || unguarded.length > 0))
  process.exit(1);

/**
 * `incident`: the learning loop. Every bug that escaped to production is recorded once (`incident add`), becomes a
 * scenario of the plan and a regression test, and from then on the coverage gate fails while it is not guarded
 * (framework/incidents.ts). `incident report` shows whether the verification layer is learning: why escapes got
 * through, and the share of them the gate would catch today.
 *
 *   vgate incident add --service orders --title "Refunds above the order total were accepted" --ticket OPS-412 \
 *     --evidence "X-Request-Id 3f2a…" --missed-by missing-scenario
 *   vgate incident report [--service orders]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isMap, isSeq, parse, parseDocument, stringify, YAMLMap, YAMLSeq } from 'yaml';
import {
  INCIDENTS_DIR,
  incidentCoverage,
  MISSED_BY,
  nextIncidentId,
  readIncidents,
  summarize,
  type IncidentReport,
  type IncidentState,
} from '../framework/incidents.ts';
import type { ProjectConfig } from '../framework/project.ts';
import { testcaseNames } from './junit.ts';
import { CLI, EXIT, UsageError, type Result } from './output.ts';
import { listServices } from './project.ts';

/** Every `scenarios: [{ id }]` id anywhere in a plan (as the coverage gate reads it). */
export function planScenarioIds(node: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'scenarios' && Array.isArray(item))
        for (const s of item) {
          if (s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string')
            out.add((s as { id: string }).id);
          walk(s);
        }
      else walk(item);
    }
  };
  walk(node);
  return out;
}

/**
 * Appends the incident's scenario to the plan, under a top-level `incidents.scenarios` list, keeping the file's
 * comments and layout. Its expectation is left for the agent or person who writes the test: it comes from the spec or
 * the ticket, never from what the fixed code returns.
 */
export function withIncidentScenario(plan: string, scenario: Record<string, unknown>): string {
  const doc = parseDocument(plan === '' ? '{}' : plan);
  if (doc.errors.length > 0) throw new Error(`inventory.yaml does not parse: ${doc.errors[0].message}`);
  if (!isMap(doc.contents)) throw new Error('inventory.yaml must be a mapping');
  let section = doc.get('incidents');
  if (section === undefined || section === null) {
    section = new YAMLMap();
    doc.set('incidents', section);
  }
  if (!isMap(section)) throw new Error('inventory.yaml: incidents must be a mapping with a scenarios list');
  let list = section.get('scenarios');
  if (list === undefined || list === null) {
    list = new YAMLSeq();
    section.set('scenarios', list);
  }
  if (!isSeq(list)) throw new Error('inventory.yaml: incidents.scenarios must be a list');
  list.add(doc.createNode(scenario));
  return doc.toString({ lineWidth: 120 });
}

export interface IncidentAddOptions {
  service: string;
  title: string | undefined;
  ticket?: string;
  evidence?: string;
  missedBy?: string;
  reason?: string;
  /** For tests: the date to record; default today. */
  date?: string;
}

export function incidentAdd(project: ProjectConfig, options: IncidentAddOptions): Result {
  if (!options.title) throw new UsageError(`Pass --title "<what went wrong>", e.g. ${CLI} incident add --title "…"`);
  if (options.missedBy !== undefined && !(MISSED_BY as readonly string[]).includes(options.missedBy))
    throw new UsageError(`--missed-by must be one of ${MISSED_BY.join(', ')}`);
  if (options.missedBy === 'not-testable' && !options.reason)
    throw new UsageError('--missed-by not-testable needs --reason "<why no black-box test can catch it>"');
  const dir = join(project.servicesDir, options.service);
  const incidents = readIncidents(dir);
  const id = nextIncidentId(incidents);
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const record: Record<string, unknown> = {
    title: options.title,
    date,
    ...(options.ticket ? { ticket: options.ticket } : {}),
    ...(options.evidence ? { evidence: options.evidence } : {}),
    ...(options.missedBy ? { missedBy: options.missedBy } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    scenario: id,
    status: 'open',
  };
  const file = join(dir, INCIDENTS_DIR, `${id}.yaml`);
  mkdirSync(join(dir, INCIDENTS_DIR), { recursive: true });
  writeFileSync(
    file,
    `# An escaped bug (vgate incident add). The coverage gate fails until a test titled [${id}] guards it.\n` +
      stringify(record, { lineWidth: 120 }),
  );

  const planFile = join(dir, 'inventory.yaml');
  const sources = [`${INCIDENTS_DIR}/${id}.yaml`, ...(options.ticket ? [options.ticket] : [])];
  const scenario = {
    id,
    title: options.title,
    kind: 'regression',
    expect: 'TODO: the correct behaviour, from the spec or the ticket (never from what the fixed code returns)',
    sources,
  };
  const testable = options.missedBy !== 'not-testable';
  if (testable)
    writeFileSync(planFile, withIncidentScenario(existsSync(planFile) ? readFileSync(planFile, 'utf8') : '', scenario));

  const rel = (path: string) => relative(project.root, path);
  return {
    command: 'incident add',
    ok: true,
    exitCode: EXIT.ok,
    summary: testable
      ? `Recorded ${id} for ${options.service}: ${rel(file)}; scenario ${id} added to ${rel(planFile)}. The coverage gate fails until a test titled [${id}] guards it.`
      : `Recorded ${id} for ${options.service} as not testable: ${rel(file)}`,
    data: { service: options.service, id, file: rel(file), plan: testable ? rel(planFile) : null, record },
    next: testable
      ? [
          `write the expectation of ${id} in ${rel(planFile)} from the spec or ticket, and a test titled "[${id}] …"`,
          `${CLI} gate --service ${options.service}`,
        ]
      : [],
  };
}

const JUNIT = ['playwright-api.xml', 'playwright-faults.xml'];

/** The titles of the tests the last run collected; undefined when no run has reported yet. */
function collectedTitles(project: ProjectConfig): string | undefined {
  const dir = join(project.reportsDir, 'junit');
  const files = JUNIT.map((name) => join(dir, name)).filter((file) => existsSync(file));
  if (files.length === 0) return undefined;
  return files.flatMap((file) => testcaseNames(readFileSync(file, 'utf8'))).join('\n');
}

/** Without a run: the titles in the test sources, so the report still says something (and says it read the sources). */
function sourceTitles(serviceDir: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|js|mts|mjs)$/.test(entry.name)) out.push(readFileSync(path, 'utf8'));
    }
  };
  walk(join(serviceDir, 'tests'));
  return out.join('\n');
}

export interface ServiceIncidents {
  service: string;
  incidents: IncidentState[];
  report: IncidentReport;
  /** Where "has a regression test" was read: the last run's JUnit reports, or the test sources. */
  testsFrom: 'last run' | 'test sources';
}

export function incidentReport(project: ProjectConfig, service: string | undefined): Result {
  const services = service ? [service] : listServices(project.root);
  const run = collectedTitles(project);
  const per: ServiceIncidents[] = services.map((name) => {
    const dir = join(project.servicesDir, name);
    const planFile = join(dir, 'inventory.yaml');
    const plan = existsSync(planFile) ? (parse(readFileSync(planFile, 'utf8')) as unknown) : undefined;
    const incidents = incidentCoverage(readIncidents(dir), planScenarioIds(plan), run ?? sourceTitles(dir));
    return { service: name, incidents, report: summarize(incidents), testsFrom: run ? 'last run' : 'test sources' };
  });
  const all = summarize(per.flatMap((p) => p.incidents));
  const rate = all.catchRate === null ? 'n/a' : `${Math.round(all.catchRate * 100)}%`;
  return {
    command: 'incident report',
    ok: true,
    exitCode: EXIT.ok,
    summary:
      all.total === 0
        ? 'No incidents recorded yet'
        : `${all.total} incident${all.total === 1 ? '' : 's'}: ${all.guarded} guarded by a regression test, ` +
          `${all.unguarded} not yet, ${all.exempt} not testable; the gate would catch ${rate} of the testable escapes today`,
    data: { total: all, services: per },
    next:
      all.unguarded > 0 ? [`${CLI} gate --service <service> (the coverage step names the unguarded incidents)`] : [],
    text: per.flatMap((p) => [
      ...(p.incidents.length > 0
        ? [
            `${p.service} (tests from the ${p.testsFrom}):`,
            ...p.incidents.map((i) => `  ${i.id.padEnd(7)} ${i.state.padEnd(11)} ${i.missedBy ?? '-'}  ${i.title}`),
          ]
        : []),
    ]),
  };
}

/**
 * Incidents: bugs that escaped to production, recorded per service as `<service dir>/incidents/INC-<n>.yaml`. Each one
 * names the scenario that now guards against it (`scenario: INC-<n>`); the coverage gate fails while a testable
 * incident has no scenario in the plan or no collected test carrying `[INC-<n>]` in its title, so every escape makes
 * the gate permanently stronger. Pure: parsing, validation and the coverage judgement, self-tested without a run.
 *
 *   title: Refunds above the order total were accepted
 *   date: 2026-11-19
 *   ticket: OPS-412               # optional
 *   evidence: X-Request-Id 3f2a… # optional: a request id, a curl, a path to an http-calls.json
 *   missedBy: missing-scenario    # why the gate did not catch it (see MISSED_BY)
 *   reason: …                     # required with missedBy: not-testable
 *   scenario: INC-3
 *   status: open                  # open | guarded (a regression test exists) | closed
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/** Why the gate let the bug through: what the learning loop counts. */
export const MISSED_BY = ['spec-gap', 'missing-scenario', 'stub-drift', 'environment', 'not-testable'] as const;
export type MissedBy = (typeof MISSED_BY)[number];

export const INCIDENT_STATUS = ['open', 'guarded', 'closed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUS)[number];

export const INCIDENTS_DIR = 'incidents';
const ID = /^INC-[1-9]\d*$/;

export interface Incident {
  id: string;
  title: string;
  date: string;
  ticket?: string;
  evidence?: string;
  missedBy?: MissedBy;
  /** Why no black-box test can catch it; required with missedBy: not-testable. */
  reason?: string;
  scenario: string;
  status: IncidentStatus;
  /** The file, relative to the service directory. */
  file: string;
}

function text(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** One incident file; throws with the file and field named when it is not a valid incident. */
export function parseIncident(source: string, file: string): Incident {
  const raw: unknown = parse(source);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file}: expected a mapping`);
  const r = raw as Record<string, unknown>;
  const id = file.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
  if (!ID.test(id)) throw new Error(`${file}: an incident file is named INC-<n>.yaml`);
  const title = text(r.title);
  if (!title) throw new Error(`${file}: title is required`);
  const date = text(r.date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${file}: date is required, as YYYY-MM-DD`);
  const scenario = text(r.scenario);
  if (scenario !== id)
    throw new Error(`${file}: scenario must be ${id}, the incident's own id (got ${scenario ?? 'none'})`);
  const missedBy = text(r.missedBy);
  if (missedBy !== undefined && !(MISSED_BY as readonly string[]).includes(missedBy))
    throw new Error(`${file}: missedBy must be one of ${MISSED_BY.join(', ')} (got ${missedBy})`);
  const reason = text(r.reason);
  if (missedBy === 'not-testable' && !reason)
    throw new Error(`${file}: missedBy: not-testable needs a reason (why no black-box test can catch it)`);
  const status = text(r.status) ?? 'open';
  if (!(INCIDENT_STATUS as readonly string[]).includes(status))
    throw new Error(`${file}: status must be one of ${INCIDENT_STATUS.join(', ')} (got ${status})`);
  return {
    id,
    title,
    date,
    ticket: text(r.ticket),
    evidence: text(r.evidence),
    missedBy: missedBy as MissedBy | undefined,
    reason,
    scenario,
    status: status as IncidentStatus,
    file,
  };
}

/** Every incident of a service directory, by number. A malformed file throws: an unreadable incident never vanishes. */
export function readIncidents(serviceDir: string): Incident[] {
  const dir = join(serviceDir, INCIDENTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => parseIncident(readFileSync(join(dir, name), 'utf8'), `${INCIDENTS_DIR}/${name}`))
    .sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
}

/** The next free id: one above the highest, so a deleted number is never reused for another bug. */
export function nextIncidentId(incidents: Incident[]): string {
  return `INC-${incidents.reduce((max, i) => Math.max(max, Number(i.id.slice(4))), 0) + 1}`;
}

/** Whole-id match: `INC-1` is not guarded by a test titled `[INC-12]`. */
export function titled(id: string, titles: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`).test(titles);
}

export interface IncidentState {
  id: string;
  title: string;
  missedBy?: MissedBy;
  /** guarded: in the plan and a collected test carries it; exempt: not-testable with a reason. */
  state: 'guarded' | 'exempt' | 'no-scenario' | 'no-test';
  detail: string;
}

/**
 * The coverage judgement. `planIds`: every scenario id of the plan; `titles`: the titles of the tests the last run
 * collected. An incident without its scenario in the plan, or without a collected test, is not guarded.
 */
export function incidentCoverage(incidents: Incident[], planIds: Set<string>, titles: string): IncidentState[] {
  return incidents.map((incident) => {
    const base = { id: incident.id, title: incident.title, missedBy: incident.missedBy };
    if (incident.missedBy === 'not-testable')
      return { ...base, state: 'exempt', detail: `not testable: ${incident.reason ?? ''}` };
    if (!planIds.has(incident.scenario))
      return { ...base, state: 'no-scenario', detail: `incident ${incident.id} has no scenario in the plan` };
    if (!titled(incident.scenario, titles))
      return { ...base, state: 'no-test', detail: `incident ${incident.id} has no regression test` };
    return { ...base, state: 'guarded', detail: `guarded by [${incident.scenario}]` };
  });
}

export interface IncidentReport {
  total: number;
  byMissedBy: Record<string, number>;
  guarded: number;
  exempt: number;
  unguarded: number;
  /** guarded / (total - exempt): the share of testable escapes the gate would catch today. */
  catchRate: number | null;
}

export function summarize(states: IncidentState[]): IncidentReport {
  const byMissedBy: Record<string, number> = {};
  for (const s of states)
    byMissedBy[s.missedBy ?? 'unclassified'] = (byMissedBy[s.missedBy ?? 'unclassified'] ?? 0) + 1;
  const guarded = states.filter((s) => s.state === 'guarded').length;
  const exempt = states.filter((s) => s.state === 'exempt').length;
  const testable = states.length - exempt;
  return {
    total: states.length,
    byMissedBy,
    guarded,
    exempt,
    unguarded: testable - guarded,
    catchRate: testable === 0 ? null : Math.round((guarded / testable) * 1000) / 1000,
  };
}

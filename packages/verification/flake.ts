/**
 * Flake policy & expiring quarantine ledger for live-app verification lanes (Playwright, PTY/CLI, real UIs).
 *
 * A live-app test that fails once and passes on retry within the retry budget is never silently treated as a clean
 * pass nor left to permanently jam the gate: it is classified as `flaky-passed` or `inconclusive` (per policy), while
 * known flaky tests can only be quarantined in a guarded, expiring `.vgate-quarantine.yaml` ledger (any addition or
 * expiry extension is flagged by `vgate guard`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const QUARANTINE_FILE = '.vgate-quarantine.yaml';

export interface FlakePolicy {
  /** Maximum retries allowed for a single live-app test before declaring fail. Default 2. */
  maxRetries: number;
  /** When true, a test that only passes after retrying yields `inconclusive` instead of clean `pass`. */
  inconclusiveOnFlake: boolean;
  /** Project-relative path to the expiring quarantine ledger. */
  quarantineFile: string;
}

export const DEFAULT_FLAKE_POLICY: FlakePolicy = {
  maxRetries: 2,
  inconclusiveOnFlake: true,
  quarantineFile: QUARANTINE_FILE,
};

export interface QuarantineEntry {
  id: string;
  service: string;
  ticket: string;
  owner: string;
  /** ISO date YYYY-MM-DD; once passed, the quarantine entry fails the gate immediately. */
  expires: string;
  reason: string;
}

export interface FlakeTrial {
  id: string;
  service: string;
  /** Ordered results of each attempt (e.g. `[false, true]` = failed once, passed on retry 1). */
  attempts: boolean[];
}

export type FlakeOutcomeKind = 'pass' | 'flaky-passed' | 'inconclusive' | 'quarantined' | 'fail';

export interface FlakeEvaluation {
  schema: 'vgate.flake/1';
  outcome: FlakeOutcomeKind;
  ok: boolean;
  flakyTests: Array<{ id: string; service: string; attempts: number; quarantined: boolean }>;
  failedTests: Array<{ id: string; service: string; attempts: number; reason: string }>;
  expiredQuarantines: QuarantineEntry[];
  staleQuarantines: QuarantineEntry[];
  reasons: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return '';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseQuarantine(yamlText: string, file: string = QUARANTINE_FILE): QuarantineEntry[] {
  const doc = parse(yamlText) as unknown;
  if (doc === undefined || doc === null) return [];
  if (!isObject(doc)) throw new Error(`${file}: expected a YAML mapping with a quarantine list`);
  const raw = doc.quarantine ?? doc.entries ?? [];
  if (!Array.isArray(raw)) throw new Error(`${file}: quarantine must be a list`);
  const out: QuarantineEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    if (!isObject(item)) throw new Error(`${file}: quarantine[${i}] must be a mapping`);
    const id = scalar(item.id);
    const service = scalar(item.service);
    const ticket = scalar(item.ticket);
    const owner = scalar(item.owner);
    const expires = scalar(item.expires);
    const reason = scalar(item.reason);
    if (!id || !service || !ticket || !owner || !reason)
      throw new Error(`${file}: quarantine[${i}] requires id, service, ticket, owner, expires, and reason`);
    if (!ISO_DATE.test(expires))
      throw new Error(`${file}: quarantine[${i}].expires must be YYYY-MM-DD (got "${expires}")`);
    out.push({ id, service, ticket, owner, expires, reason });
  }
  return out;
}

export function loadQuarantine(projectRoot: string, file: string = QUARANTINE_FILE): QuarantineEntry[] {
  const full = join(projectRoot, file);
  if (!existsSync(full)) return [];
  return parseQuarantine(readFileSync(full, 'utf8'), file);
}

export function evaluateFlakePolicy(
  trials: FlakeTrial[],
  quarantine: QuarantineEntry[],
  policy: Partial<FlakePolicy> = {},
  todayIso: string = new Date().toISOString().slice(0, 10),
): FlakeEvaluation {
  const effective: FlakePolicy = { ...DEFAULT_FLAKE_POLICY, ...policy };
  const expiredQuarantines = quarantine.filter((q) => q.expires < todayIso);
  const activeByKey = new Map<string, QuarantineEntry>();
  for (const entry of quarantine) {
    if (entry.expires >= todayIso) activeByKey.set(`${entry.service}|${entry.id}`, entry);
  }

  const seenKeys = new Set<string>();
  const flakyTests: FlakeEvaluation['flakyTests'] = [];
  const failedTests: FlakeEvaluation['failedTests'] = [];
  const reasons: string[] = [];

  for (const trial of trials) {
    const key = `${trial.service}|${trial.id}`;
    seenKeys.add(key);
    const q = activeByKey.get(key);
    const bounded = trial.attempts.slice(0, effective.maxRetries + 1);
    const passedAt = bounded.findIndex((ok) => ok === true);

    if (passedAt === 0) continue;

    if (passedAt > 0) {
      flakyTests.push({ id: trial.id, service: trial.service, attempts: passedAt + 1, quarantined: q !== undefined });
      if (!q) {
        reasons.push(
          `${trial.service}:${trial.id} flaked (passed on attempt ${passedAt + 1} of ${bounded.length}) without quarantine`,
        );
      }
      continue;
    }

    if (q) {
      flakyTests.push({ id: trial.id, service: trial.service, attempts: bounded.length, quarantined: true });
      continue;
    }

    failedTests.push({
      id: trial.id,
      service: trial.service,
      attempts: bounded.length,
      reason: `failed all ${bounded.length} attempt${bounded.length === 1 ? '' : 's'} (maxRetries=${effective.maxRetries})`,
    });
    reasons.push(`${trial.service}:${trial.id} failed after ${bounded.length} attempts`);
  }

  for (const expired of expiredQuarantines) {
    reasons.push(`quarantine entry ${expired.service}:${expired.id} (${expired.ticket}) expired on ${expired.expires}`);
  }

  const staleQuarantines = quarantine.filter(
    (q) => q.expires >= todayIso && trials.length > 0 && !seenKeys.has(`${q.service}|${q.id}`),
  );

  if (failedTests.length > 0 || expiredQuarantines.length > 0) {
    return {
      schema: 'vgate.flake/1',
      outcome: 'fail',
      ok: false,
      flakyTests,
      failedTests,
      expiredQuarantines,
      staleQuarantines,
      reasons,
    };
  }

  const unquarantinedFlakes = flakyTests.filter((f) => !f.quarantined);
  if (unquarantinedFlakes.length > 0) {
    const outcome: FlakeOutcomeKind = effective.inconclusiveOnFlake ? 'inconclusive' : 'flaky-passed';
    return {
      schema: 'vgate.flake/1',
      outcome,
      ok: !effective.inconclusiveOnFlake,
      flakyTests,
      failedTests,
      expiredQuarantines,
      staleQuarantines,
      reasons,
    };
  }

  if (flakyTests.length > 0) {
    return {
      schema: 'vgate.flake/1',
      outcome: 'quarantined',
      ok: true,
      flakyTests,
      failedTests,
      expiredQuarantines,
      staleQuarantines,
      reasons,
    };
  }

  return {
    schema: 'vgate.flake/1',
    outcome: 'pass',
    ok: true,
    flakyTests,
    failedTests,
    expiredQuarantines,
    staleQuarantines,
    reasons,
  };
}

export interface QuarantineGuardFinding {
  rule: 'quarantine-added';
  file: string;
  detail: string;
}

/**
 * Pure `vgate guard` rule for `.vgate-quarantine.yaml`: any newly quarantined test or extended expiry requires human
 * review so an author agent cannot silence a flaky or broken check silently. Removing an entry is additive info.
 */
export function quarantineGuardRule(
  file: string,
  base: string | undefined,
  head: string | undefined,
): { findings: QuarantineGuardFinding[]; info: QuarantineGuardFinding[] } {
  const findings: QuarantineGuardFinding[] = [];
  const info: QuarantineGuardFinding[] = [];
  const before = base === undefined ? [] : parseQuarantine(base, file);
  const after = head === undefined ? [] : parseQuarantine(head, file);
  const beforeMap = new Map(before.map((e) => [`${e.service}|${e.id}`, e]));
  const afterMap = new Map(after.map((e) => [`${e.service}|${e.id}`, e]));

  for (const [key, entry] of afterMap) {
    const prev = beforeMap.get(key);
    if (!prev) {
      findings.push({
        rule: 'quarantine-added',
        file,
        detail: `quarantine entry ${entry.service}:${entry.id} (${entry.ticket}) added, expires ${entry.expires}`,
      });
    } else if (entry.expires > prev.expires) {
      findings.push({
        rule: 'quarantine-added',
        file,
        detail: `quarantine entry ${entry.service}:${entry.id} expiry extended ${prev.expires} -> ${entry.expires}`,
      });
    }
  }
  for (const [key, entry] of beforeMap) {
    if (!afterMap.has(key)) {
      info.push({
        rule: 'quarantine-added',
        file,
        detail: `quarantine entry ${entry.service}:${entry.id} removed`,
      });
    }
  }
  return { findings, info };
}

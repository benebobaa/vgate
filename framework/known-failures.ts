/**
 * The known-failures registry: services/<svc>/known-failures.yaml. It is the only way a failing test may leave the
 * gate green, so it is a small, protected, reviewable file rather than `test.fail()` scattered through the tests.
 * Policy: docs/known-failures.md.
 *
 *   failures:
 *     - id: CRT-201          # the scenario id in the test title: [CRT-201]
 *       match: 'rejects {}'   # optional: only tests whose title also contains this text
 *       ticket: BUG-123
 *       owner: team-or-person
 *       expires: 2026-12-31   # YYYY-MM-DD; the entry no longer applies after this day
 *       reason: one line naming the finding
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const REGISTRY_FILE = 'known-failures.yaml';
/** The annotation a registered test carries; its description starts with `<id> <ticket>`. */
export const ANNOTATION = 'known-failure';

export interface KnownFailure {
  id: string;
  match?: string;
  ticket: string;
  owner: string;
  /** YYYY-MM-DD, inclusive: the entry applies through this day. */
  expires: string;
  reason: string;
}

const ID = /^[A-Z][A-Z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = new Set(['id', 'match', 'ticket', 'owner', 'expires', 'reason']);

export class RegistryError extends Error {}

function validDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

/** Parses and validates a registry; every problem is reported at once, each naming its entry. */
export function parseRegistry(text: string, file: string): KnownFailure[] {
  // A bare date in YAML becomes a Date object; keep every scalar as written.
  const doc = parse(text, { schema: 'core' }) as unknown;
  if (doc === null || doc === undefined) return [];
  const root = doc as { failures?: unknown };
  if (typeof doc !== 'object' || Array.isArray(doc) || !Object.keys(doc).every((key) => key === 'failures'))
    throw new RegistryError(`${file}: expected a mapping with a single key "failures"`);
  if (root.failures === null || root.failures === undefined) return [];
  if (!Array.isArray(root.failures)) throw new RegistryError(`${file}: "failures" must be a list`);

  const problems: string[] = [];
  const entries: KnownFailure[] = [];
  const seen = new Set<string>();
  root.failures.forEach((raw: unknown, index) => {
    const where = `${file}: failures[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${where} must be a mapping`);
      return;
    }
    const entry = raw as Record<string, unknown>;
    const label = typeof entry.id === 'string' ? `${where} (${entry.id})` : where;
    const before = problems.length;
    for (const key of Object.keys(entry)) if (!FIELDS.has(key)) problems.push(`${label}: unknown field "${key}"`);
    for (const key of ['id', 'ticket', 'owner', 'expires', 'reason']) {
      const value = entry[key];
      if (typeof value !== 'string' || value.trim() === '')
        problems.push(`${label}: "${key}" is required and must be text`);
    }
    if (entry.match !== undefined && (typeof entry.match !== 'string' || entry.match === ''))
      problems.push(`${label}: "match" must be non-empty text when given`);
    if (typeof entry.id === 'string' && !ID.test(entry.id))
      problems.push(`${label}: id must look like a scenario id (CRT-201), as in the test title [CRT-201]`);
    if (typeof entry.ticket === 'string' && /\s/.test(entry.ticket))
      problems.push(`${label}: ticket must be one word (e.g. BUG-123)`);
    if (typeof entry.expires === 'string' && !validDate(entry.expires))
      problems.push(`${label}: expires must be a date YYYY-MM-DD`);
    if (problems.length > before) return;

    const failure = entry as unknown as KnownFailure;
    const key = `${failure.id}\u0000${failure.match ?? ''}`;
    if (seen.has(key)) {
      problems.push(`${label}: duplicate of an earlier entry with the same id and match`);
      return;
    }
    seen.add(key);
    entries.push(failure);
  });
  if (problems.length > 0) throw new RegistryError(`Invalid known-failures registry:\n  ${problems.join('\n  ')}`);
  return entries;
}

export function registryPath(serviceDir: string): string {
  return join(serviceDir, REGISTRY_FILE);
}

/** The service's registry; empty when it has none. */
export function loadRegistry(serviceDir: string): KnownFailure[] {
  const file = registryPath(serviceDir);
  return existsSync(file) ? parseRegistry(readFileSync(file, 'utf8'), file) : [];
}

/** Today in the machine's time zone, as YYYY-MM-DD. */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isExpired(entry: KnownFailure, day: string): boolean {
  return day > entry.expires;
}

/** The scenario ids a test title carries: `[CRT-201]`. */
export function titleIds(title: string): string[] {
  return [...title.matchAll(/\[([A-Z][A-Z0-9-]*)\]/g)].map((match) => match[1]);
}

export function matches(entry: KnownFailure, title: string): boolean {
  return titleIds(title).includes(entry.id) && (entry.match === undefined || title.includes(entry.match));
}

export interface Lookup {
  /** The entry that applies to this test today. */
  active?: KnownFailure;
  /** Entries that would apply but have expired: the test runs as a normal test again. */
  expired: KnownFailure[];
}

export function lookup(entries: KnownFailure[], title: string, day: string): Lookup {
  const hits = entries.filter((entry) => matches(entry, title));
  return {
    active: hits.find((entry) => !isExpired(entry, day)),
    expired: hits.filter((entry) => isExpired(entry, day)),
  };
}

export function annotationFor(entry: KnownFailure): { type: string; description: string } {
  return {
    type: ANNOTATION,
    description: `${entry.id} ${entry.ticket} (owner ${entry.owner}, expires ${entry.expires}): ${entry.reason}`,
  };
}

/** Reads `<id> <ticket>` back from a known-failure annotation's description. */
export function parseAnnotation(description: string): { id: string; ticket: string } | undefined {
  const match = /^(\S+) (\S+)/.exec(description);
  return match ? { id: match[1], ticket: match[2] } : undefined;
}

export interface RegistryCheck {
  expired: KnownFailure[];
  /** Entries no test title of the run matches: the test was renamed or removed, so the entry protects nothing. */
  stale: KnownFailure[];
}

/** `titles` are the titles of every test of a complete run; leave them out for a partial run (no stale check). */
export function checkRegistry(entries: KnownFailure[], day: string, titles?: string[]): RegistryCheck {
  return {
    expired: entries.filter((entry) => isExpired(entry, day)),
    stale: titles ? entries.filter((entry) => !titles.some((title) => matches(entry, title))) : [],
  };
}

export function describeEntry(entry: KnownFailure): string {
  return `${entry.id}${entry.match ? ` (match "${entry.match}")` : ''} ${entry.ticket}, owner ${entry.owner}, expires ${entry.expires}`;
}

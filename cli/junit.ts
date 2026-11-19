/** Reads the JUnit XML Playwright writes, down to what a caller needs to act on a failure. */
import { ANNOTATION, parseAnnotation } from '../framework/known-failures.ts';

export interface TestFailure {
  /** The scenario id in the title, e.g. `CRT-201`; ties the failure to the inventory. */
  id?: string;
  title: string;
  file: string;
  line?: number;
  /** First line of the failure, e.g. `Contract violations: POST /x -> 200 [X-Request-Id ...]`. */
  message: string;
}

/** A test the known-failures registry names, which failed as expected and so left the gate green. */
export interface KnownFailureHit {
  id: string;
  ticket: string;
  title: string;
  file: string;
}

export interface TestSummary {
  total: number;
  /** Tests that turn the gate red, including registered tests that passed (their entry must go). */
  failed: number;
  skipped: number;
  failures: TestFailure[];
  /** Failures the registry tolerated. Not counted in `failed`. */
  knownFailures: KnownFailureHit[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? match;
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[name] = decode(value);
  return out;
}

const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;

/** Every testcase title of a report, as the registry check matches them. */
/** Every test case of a report: its file (relative to the test directory) and full title. */
export function testcases(xml: string): Array<{ file: string; title: string }> {
  return [...xml.matchAll(TESTCASE)].map(([, head]) => {
    const test = attributes(head);
    return { file: test.classname ?? '', title: test.name ?? '' };
  });
}

export function testcaseNames(xml: string): string[] {
  return [...xml.matchAll(TESTCASE)].map(([, head]) => attributes(head).name ?? '');
}

export function parseJunit(xml: string): TestSummary {
  const summary: TestSummary = { total: 0, failed: 0, skipped: 0, failures: [], knownFailures: [] };
  for (const [, head, body = ''] of xml.matchAll(TESTCASE)) {
    summary.total++;
    const test = attributes(head);
    const file = test.classname ?? '';
    const title = test.name ?? '';
    const id = /\[([A-Z][A-Z0-9-]*)\]/.exec(title)?.[1];
    // Playwright embeds each annotation as a <property>; the registry's carries `<id> <ticket> ...`.
    const known = [...body.matchAll(/<property\b([^>]*?)\/?>/g)]
      .map(([, tag]) => attributes(tag))
      .filter((property) => property.name === ANNOTATION)
      .map((property) => parseAnnotation(property.value ?? ''))
      .find((hit) => hit !== undefined);

    if (/<skipped\b/.test(body)) {
      summary.skipped++;
      continue;
    }
    const problem = /<(?:failure|error)\b([^>]*)>/.exec(body);
    if (!problem) {
      if (known) summary.knownFailures.push({ ...known, title, file });
      continue;
    }
    summary.failed++;
    // Playwright's failure text starts with `[project] › file:line:col › title`.
    const line = file ? new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):\\d+`).exec(body) : null;
    summary.failures.push({
      id,
      title,
      file,
      line: line ? Number(line[1]) : undefined,
      // A registered test only fails the run by passing: Playwright's own message for that names no cause.
      message: known
        ? `Expected to fail (known failure ${known.id}, ${known.ticket}) but passed: the fix landed, remove the entry from known-failures.yaml`
        : (attributes(problem[1]).message ?? '').split('\n')[0].slice(0, 400),
    });
  }
  return summary;
}

export function mergeSummaries(parts: TestSummary[]): TestSummary {
  return {
    total: parts.reduce((sum, part) => sum + part.total, 0),
    failed: parts.reduce((sum, part) => sum + part.failed, 0),
    skipped: parts.reduce((sum, part) => sum + part.skipped, 0),
    failures: parts.flatMap((part) => part.failures),
    knownFailures: parts.flatMap((part) => part.knownFailures),
  };
}

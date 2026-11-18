/**
 * Run-unique, lower-case identifiers (`reg.k3x9a.1a`): `<prefix>.<runId>.<worker><counter>`. Unique data lets tests
 * run in parallel and, later, against shared environments that are never reset. Safe for usernames
 * (`[a-z0-9._-]`), capped at `max` characters.
 */
export function uniqueFactory(
  runId: string,
  workerIndex: number,
  max = 50,
  /**
   * The Playwright project. One run id spans several invocations (the api suite, then the faults suite), whose worker
   * 0 would otherwise make the same ids: a fault test would reuse an api test's customer or idempotency key and get
   * that test's remembered answer instead of the fault it sets up. Projects other than `api` add a short tag.
   */
  project = 'api',
): (prefix: string) => string {
  let counter = 0;
  const tag = project === 'api' ? '' : projectTag(project);
  return (prefix: string) => {
    const clean = prefix.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    const suffix = `.${runId}${tag}.${workerIndex.toString(36)}${(counter++).toString(36)}`;
    return `${clean.slice(0, Math.max(1, max - suffix.length))}${suffix}`;
  };
}

/** A short run id: base36 seconds, so ids sort by run and stay short. */
export function newRunId(): string {
  return Math.floor(Date.now() / 1000)
    .toString(36)
    .slice(-6);
}

/** Two base-36 characters from the project name: distinct for distinct projects in practice, short for usernames. */
function projectTag(project: string): string {
  let hash = 0;
  for (const char of project) hash = (hash * 31 + char.charCodeAt(0)) % 1296;
  return hash.toString(36).padStart(2, '0');
}

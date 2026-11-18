/**
 * Run-unique, lower-case identifiers (`reg.k3x9a.1a`): `<prefix>.<runId>.<worker><counter>`. Unique data lets tests
 * run in parallel and, later, against shared environments that are never reset. Safe for usernames
 * (`[a-z0-9._-]`), capped at `max` characters.
 */
export function uniqueFactory(runId: string, workerIndex: number, max = 50): (prefix: string) => string {
  let counter = 0;
  return (prefix: string) => {
    const clean = prefix.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    const suffix = `.${runId}.${workerIndex.toString(36)}${(counter++).toString(36)}`;
    return `${clean.slice(0, Math.max(1, max - suffix.length))}${suffix}`;
  };
}

/** A short run id: base36 seconds, so ids sort by run and stay short. */
export function newRunId(): string {
  return Math.floor(Date.now() / 1000)
    .toString(36)
    .slice(-6);
}

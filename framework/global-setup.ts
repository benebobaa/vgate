import { existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadService, reportsDir } from './config.ts';
import { newRunId } from './data/unique.ts';
import { Db } from './db/postgres.ts';
import { checkRegistry, describeEntry, loadRegistry, registryPath, today } from './known-failures.ts';

async function probe(what: string, check: () => Promise<void>, hint: string): Promise<void> {
  try {
    await check();
  } catch (error) {
    throw new Error(`${what} is not reachable: ${error instanceof Error ? error.message : String(error)}\n${hint}`, {
      cause: error,
    });
  }
}

async function expectOk(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
}

/**
 * Runs once before any worker: fixes the run id (workers inherit it), clears the observed-coverage feed of earlier
 * runs, and fails fast with a hint when the stack is down instead of letting every test time out. Invocations that
 * share a RUN_ID (the api and faults suites of one `task test`) keep each other's feed. A malformed known-failures
 * registry stops the run here, before any test, rather than silently tolerating nothing (or the wrong thing).
 */
export default async function globalSetup(): Promise<void> {
  const svc = loadService();
  const registry = loadRegistry(svc.dir);
  if (registry.length > 0) {
    const { expired } = checkRegistry(registry, today());
    process.stdout.write(
      `Known failures: ${registry.length - expired.length} active in ${registryPath(svc.dir)}` +
        expired.map((entry) => `\n  EXPIRED ${describeEntry(entry)} (its test runs as a normal test)`).join('') +
        '\n',
    );
  }
  const runId = (process.env.RUN_ID ??= newRunId());
  // The observed-call feed and the browser findings (framework/ui) of earlier runs never count for this one.
  for (const feed of ['observed', 'ui']) {
    const dir = resolve(reportsDir, feed);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => !name.startsWith(`${runId}-`))) {
      rmSync(resolve(dir, file), { force: true });
    }
  }

  const hint = `Start it with: vgate up --service ${svc.name} --env ${svc.env.name}`;
  await probe(
    `${svc.name} at ${svc.env.baseUrl}`,
    () => expectOk(`${svc.env.baseUrl}${svc.env.healthPath ?? ''}`),
    hint,
  );
  const keycloak = svc.env.keycloak;
  if (keycloak) {
    await probe(
      `Keycloak realm ${keycloak.realm}`,
      () => expectOk(`${keycloak.url}/realms/${keycloak.realm}/.well-known/openid-configuration`),
      hint,
    );
  }
  if (svc.env.db) {
    const db = new Db(svc.env.db);
    await probe('Database', async () => void (await db.query('select 1')), hint).finally(() => db.close());
  }
}

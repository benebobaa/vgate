import { resolve } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { Auth } from './auth/auth.ts';
import { Keycloak } from './auth/keycloak.ts';
import { loadService, reportsDir, type ServiceConfig } from './config.ts';
import { newRunId, uniqueFactory } from './data/unique.ts';
import { Db } from './db/postgres.ts';
import { ComposeFaults } from './faults/compose.ts';
import { ApiClient, CallRecorder } from './http/client.ts';
import { loadContract, type OpenApiContract } from './http/openapi.ts';
import { annotationFor, loadRegistry, lookup, today, type KnownFailure } from './known-failures.ts';

export interface FrameworkTestFixtures<P> {
  /** The service under test; every response is held to the contract. */
  api: ApiClient<P>;
  /**
   * Automatic: a test the service's known-failures registry names is expected to fail, so it fails the run when it
   * passes (the fix landed: remove the entry). Tests never mark themselves; see docs/known-failures.md.
   */
  knownFailure: void;
}

export interface FrameworkWorkerFixtures {
  svc: ServiceConfig;
  contract: OpenApiContract;
  /** The request headers of each identity (Keycloak password users, static tokens or API keys, anonymous). */
  auth: Auth;
  /**
   * Keycloak: tokens and, in disposable environments, throwaway users (deleted when the worker ends). Only for
   * environments with `keycloak`; a test that uses it elsewhere fails with that reason.
   */
  kc: Keycloak;
  /** The service's database, for asserting rows written or not written. */
  db: Db;
  /** Dependency failures (pause/unpause a compose service). */
  faults: ComposeFaults;
  /** Run-unique identifiers for test data. */
  unique: (prefix: string) => string;
  /** The service's known-failures registry (services/<svc>/known-failures.yaml), validated by global setup. */
  knownFailures: KnownFailure[];
}

/**
 * The framework's Playwright `test`, typed by a service's generated `paths`. A service extends it with its own
 * fixtures (personas, data builders) in services/<name>/support/fixtures.ts.
 */
export function createTest<P>() {
  return base.extend<FrameworkTestFixtures<P>, FrameworkWorkerFixtures>({
    svc: [
      async ({}, use) => {
        await use(loadService());
      },
      { scope: 'worker' },
    ],
    contract: [
      async ({ svc }, use) => {
        await use(loadContract(svc));
      },
      { scope: 'worker' },
    ],
    auth: [
      async ({ svc }, use) => {
        await use(new Auth(svc.env));
      },
      { scope: 'worker' },
    ],
    kc: [
      async ({ svc }, use) => {
        if (!svc.env.keycloak) throw new Error(`Environment ${svc.env.name} of ${svc.name} has no keycloak configured`);
        const kc = new Keycloak(svc.env.keycloak);
        await use(kc);
        await kc.cleanup();
      },
      { scope: 'worker' },
    ],
    db: [
      async ({ svc }, use) => {
        if (!svc.env.db) throw new Error(`Environment ${svc.env.name} of ${svc.name} has no db configured`);
        const db = new Db(svc.env.db);
        await use(db);
        await db.close();
      },
      { scope: 'worker' },
    ],
    faults: [
      async ({ svc }, use) => {
        await use(new ComposeFaults(svc.env.compose));
      },
      { scope: 'worker' },
    ],
    unique: [
      async ({}, use, workerInfo) => {
        await use(uniqueFactory(process.env.RUN_ID ?? newRunId(), workerInfo.workerIndex, 50, workerInfo.project.name));
      },
      { scope: 'worker' },
    ],
    knownFailures: [
      async ({ svc }, use) => {
        await use(loadRegistry(svc.dir));
      },
      { scope: 'worker' },
    ],
    knownFailure: [
      async ({ knownFailures }, use, testInfo) => {
        // The title as the JUnit report and the registry check see it: describe blocks and test, without the file.
        const { active } = lookup(knownFailures, testInfo.titlePath.slice(1).join(' › '), today());
        if (active) {
          testInfo.annotations.push(annotationFor(active));
          testInfo.fail(true, `known failure ${active.ticket}: ${active.reason}`);
        }
        await use();
      },
      { auto: true },
    ],
    api: async ({ request, svc, contract, auth }, use, testInfo) => {
      const observed = resolve(reportsDir, 'observed', `${process.env.RUN_ID ?? 'run'}-w${testInfo.workerIndex}.jsonl`);
      const recorder = new CallRecorder(observed, testInfo.titlePath.slice(1).join(' > '));
      await use(new ApiClient<P>(request, svc, contract, auth, recorder));
      if (testInfo.status !== testInfo.expectedStatus && recorder.calls.length > 0) {
        await testInfo.attach('http-calls.json', {
          body: JSON.stringify(recorder.calls, null, 2),
          contentType: 'application/json',
        });
      }
    },
  });
}

export { expect };

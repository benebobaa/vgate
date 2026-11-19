/**
 * Playwright fixtures for a service's dependencies (environments.<env>.dependencies in service.yaml). A service
 * that has dependencies builds its `test` from `createDepsTest<paths>()` instead of `createTest<paths>()`:
 *
 *   stubs.<name>   stubbed providers (test-scoped; stubs removed when the test ends)
 *   events         Kafka events, schema-checked (one consumer per worker)
 *   cache          the service's Redis
 *   faults         ComposeFaults plus latency(dep, ms) and down(dep) through toxiproxy, undone after each test
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { reportsDir, type ServiceConfig } from '../config.ts';
import { ComposeFaults } from '../faults/compose.ts';
import { createTest } from '../fixtures.ts';
import type { DataPath } from '../http/client.ts';
import { OpenApiContract } from '../http/openapi.ts';
import { ofKind } from './config.ts';
import { KafkaEvents } from './kafka.ts';
import { RedisCache } from './redis.ts';
import { HttpStub, type StubRecord } from './stubs.ts';
import { proxyOf, Toxiproxy } from './toxiproxy.ts';

/** ComposeFaults plus network faults on a dependency's toxiproxy proxy. */
export class DependencyFaults extends ComposeFaults {
  private readonly toxiproxy: Toxiproxy | undefined;

  constructor(private readonly svc: ServiceConfig) {
    super(svc.env.compose);
    const proxies = Object.values(ofKind(svc.env.dependencies ?? {}, 'toxiproxy'));
    this.toxiproxy = proxies[0] ? new Toxiproxy(proxies[0]) : undefined;
  }

  private proxy(dependency: string): { toxiproxy: Toxiproxy; proxy: string } {
    if (!this.toxiproxy) throw new Error(`Environment ${this.svc.env.name} has no toxiproxy dependency`);
    return { toxiproxy: this.toxiproxy, proxy: proxyOf(this.svc.env.dependencies ?? {}, dependency) };
  }

  /** Every answer of `dependency` arrives `ms` later. Undone when the test ends. */
  latency(dependency: string, ms: number): Promise<void> {
    const { toxiproxy, proxy } = this.proxy(dependency);
    return toxiproxy.latency(proxy, ms);
  }

  /** `dependency` refuses connections. Undone when the test ends. */
  down(dependency: string): Promise<void> {
    const { toxiproxy, proxy } = this.proxy(dependency);
    return toxiproxy.down(proxy);
  }

  async restore(): Promise<void> {
    await this.toxiproxy?.restore();
  }
}

export interface DepsTestFixtures {
  /** Stubbed providers by dependency name; each stub is checked against the provider's contract. */
  stubs: Record<string, HttpStub>;
  /** Undoes the faults of the test (automatic). */
  restoreFaults: void;
}

export interface DepsWorkerFixtures {
  events: KafkaEvents;
  cache: RedisCache;
  faults: DependencyFaults;
  /** The provider contracts, loaded once per worker. */
  providerContracts: Record<string, OpenApiContract>;
}

/** Appends the stub records of this worker to the run's observed feed, for the provider-coverage report. */
function stubRecorder(workerIndex: number): (record: StubRecord) => void {
  const dir = resolve(reportsDir, 'observed');
  // `.ndjson`, not `.jsonl`: the response-coverage gate reads every .jsonl in this folder as a response.
  const file = resolve(dir, `${process.env.RUN_ID ?? 'run'}-w${workerIndex}.stubs.ndjson`);
  return (record) => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  };
}

/** `D` is createTest's: where the envelope's success data sits, for the type of `expectSuccess`. */
export function createDepsTest<P, D extends DataPath = undefined>() {
  return createTest<P, D>().extend<DepsTestFixtures, DepsWorkerFixtures>({
    providerContracts: [
      async ({ svc }, use) => {
        const stubs = ofKind(svc.env.dependencies ?? {}, 'http-stub');
        await use(
          Object.fromEntries(
            Object.entries(stubs).map(([name, dep]) => [
              name,
              OpenApiContract.load(dep.contract, { strictResponseProperties: true }),
            ]),
          ),
        );
      },
      { scope: 'worker' },
    ],
    stubs: async ({ svc, providerContracts }, use, testInfo) => {
      const record = stubRecorder(testInfo.workerIndex);
      const stubs = Object.fromEntries(
        Object.entries(ofKind(svc.env.dependencies ?? {}, 'http-stub')).map(([name, dep]) => [
          name,
          new HttpStub(name, dep, providerContracts[name], record),
        ]),
      );
      // A typo'd name fails with the names there are, not with "cannot read properties of undefined".
      const guarded = new Proxy(stubs, {
        get(target, name) {
          if (typeof name === 'string' && !(name in target) && name !== 'then')
            throw new Error(`No http-stub dependency "${name}" (have: ${Object.keys(target).join(', ') || 'none'})`);
          return target[name as string];
        },
      });
      await use(guarded);
      await Promise.all(Object.values(stubs).map((stub) => stub.cleanup()));
    },
    events: [
      async ({ svc }, use, workerInfo) => {
        const deps = ofKind(svc.env.dependencies ?? {}, 'kafka');
        if (Object.keys(deps).length === 0) throw new Error(`Environment ${svc.env.name} has no kafka dependency`);
        const run = process.env.RUN_ID ?? 'run';
        const events = await KafkaEvents.start(
          deps,
          `vgate.${svc.name}.${run}.w${workerInfo.workerIndex}.${Date.now()}`,
        );
        await use(events);
        await events.close();
      },
      { scope: 'worker' },
    ],
    cache: [
      async ({ svc }, use) => {
        const deps = Object.values(ofKind(svc.env.dependencies ?? {}, 'redis'));
        if (deps.length !== 1)
          throw new Error(
            `The cache fixture needs exactly one redis dependency in ${svc.env.name} (found ${deps.length})`,
          );
        const cache = await RedisCache.connect(deps[0].url);
        await use(cache);
        await cache.close();
      },
      { scope: 'worker' },
    ],
    faults: [
      async ({ svc }, use) => {
        await use(new DependencyFaults(svc));
      },
      { scope: 'worker' },
    ],
    restoreFaults: [
      async ({ faults }, use) => {
        await use();
        await faults.restore();
      },
      { auto: true },
    ],
  });
}

export { expect } from '../fixtures.ts';

/**
 * The catalog of dependency kinds a sealed environment can start. A kind is one file in this directory; add it to the
 * list below. Kinds are found by `kind:` in service.yaml's `environment.dependencies`.
 */
import { CATALOG_EXTRA } from './extra.ts';
import { kafka } from './kafka.ts';
import { postgres } from './postgres.ts';
import { redis } from './redis.ts';
import type { DependencyKind } from './types.ts';
import { toxiproxy } from './toxiproxy.ts';
import { wiremock } from './wiremock.ts';

export type { DependencyKind, Endpoint, HealthCheck, KindContext } from './types.ts';

const CORE: DependencyKind[] = [postgres, redis, kafka, wiremock, toxiproxy];

const registry = new Map<string, DependencyKind>();
for (const kind of [...CORE, ...CATALOG_EXTRA]) {
  if (registry.has(kind.kind)) throw new Error(`catalog: kind ${kind.kind} is registered twice`);
  registry.set(kind.kind, kind);
}

export function kindOf(kind: string): DependencyKind | undefined {
  return registry.get(kind);
}

export function catalogKinds(): string[] {
  return [...registry.keys()].sort();
}

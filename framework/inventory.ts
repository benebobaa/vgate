/**
 * The inventory skeleton of a service: one entry per operation of its vendored contract with the documented responses,
 * every judgement left as TODO. The generate-api-tests skill enriches it from the backend's code and docs; nothing in
 * it is an expectation until a source is cited.
 */
import { relative } from 'node:path';
import { stringify } from 'yaml';
import type { ServiceConfig } from './config.ts';
import { loadContract } from './http/openapi.ts';

export function inventorySkeleton(svc: ServiceConfig): string {
  const contract = loadContract(svc);
  const skeleton = {
    service: svc.name,
    contract: relative(svc.dir, svc.specPath),
    backend: {
      repo: svc.backend ? relative(svc.dir, svc.backend.repo) : 'TODO',
      commit: svc.backend?.syncedCommit ?? 'TODO',
    },
    sources: [],
    personas: {},
    operations: contract.operations.map((op) => ({
      id: op.operationId ?? op.key,
      operation: op.key,
      summary: 'TODO',
      permission: 'TODO',
      gate: 'TODO',
      request: op.requestSchema ?? null,
      responses: Object.fromEntries([...op.responses.values()].map((r) => [r.status, r.codes])),
      dbEffects: { success: 'TODO', failure: 'TODO' },
      downstream: [],
      scenarios: [],
      excluded: [],
    })),
  };
  return (
    `# Skeleton from ${relative(svc.dir, svc.specPath)}: enrich every TODO from the backend's sources.\n` +
    stringify(skeleton, { lineWidth: 120 })
  );
}

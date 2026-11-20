import fs from 'node:fs';
import path from 'node:path';
import type { CoordinatorRole } from './connectors.ts';
import { readStopOrder } from './contract.ts';

export const TRAIL_FILE = '.vgate/factory-trail.jsonl';

export type WorkerState = 'prepared' | 'running' | 'completed' | 'stalled' | 'failed' | 'replaced' | 'stopped';

export interface WorkerTrailRow {
  workerId: string;
  signalId: string;
  branch: string;
  sandboxId: string;
  coordinator: CoordinatorRole;
  startedAt: string;
  stuckAfterMs: number;
  lastCommitSha: string | null;
  lastArtifactCount: number;
  lastSideEffectAt: string;
  state: WorkerState;
  note?: string;
}

export interface SideEffectProbe {
  commitSha: string | null;
  artifactCount: number;
  processAlive: boolean;
}

export interface AuditAction {
  workerId: string;
  decision: 'healthy' | 'replace-stalled' | 'replace-errored' | 'hold-stopped';
  reason: string;
  observedCommit: string | null;
  observedArtifacts: number;
}

export interface AuditReport {
  stopped: boolean;
  checked: number;
  actions: AuditAction[];
}

function trailFilePath(projectRoot: string): string {
  return path.join(projectRoot, TRAIL_FILE);
}

export function appendTrailRow(projectRoot: string, row: WorkerTrailRow): void {
  const filePath = trailFilePath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

export function latestWorkerStates(projectRoot: string): Map<string, WorkerTrailRow> {
  const states = new Map<string, WorkerTrailRow>();
  const filePath = trailFilePath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return states;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const row = JSON.parse(trimmed) as WorkerTrailRow;
    states.set(row.workerId, row);
  }
  return states;
}

export function auditWorkers(
  projectRoot: string,
  probe: (row: WorkerTrailRow) => SideEffectProbe,
  nowMs?: number,
): AuditReport {
  const now = nowMs ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const stopOrder = readStopOrder(projectRoot);
  const states = latestWorkerStates(projectRoot);
  const actions: AuditAction[] = [];

  if (stopOrder.stopped) {
    for (const row of states.values()) {
      if (row.state === 'completed' || row.state === 'replaced') {
        continue;
      }
      actions.push({
        workerId: row.workerId,
        decision: 'hold-stopped',
        reason: `Zero-writes stop order active${stopOrder.reason ? `: ${stopOrder.reason}` : ''}`,
        observedCommit: row.lastCommitSha,
        observedArtifacts: row.lastArtifactCount,
      });
    }
    return { stopped: true, checked: actions.length, actions };
  }

  for (const row of states.values()) {
    if (row.state === 'completed' || row.state === 'replaced') {
      continue;
    }

    const observed = probe(row);
    const commitAdvanced = observed.commitSha !== null && observed.commitSha !== row.lastCommitSha;
    const artifactsIncreased = observed.artifactCount > row.lastArtifactCount;
    const hadSideEffect = commitAdvanced || artifactsIncreased;
    const effectiveLastSideEffectAt = hadSideEffect ? nowIso : row.lastSideEffectAt;

    if (!observed.processAlive) {
      const reason = 'Worker process is not alive and never reached completed state';
      appendTrailRow(projectRoot, {
        ...row,
        lastCommitSha: observed.commitSha,
        lastArtifactCount: observed.artifactCount,
        lastSideEffectAt: effectiveLastSideEffectAt,
        state: 'failed',
        note: reason,
      });
      actions.push({
        workerId: row.workerId,
        decision: 'replace-errored',
        reason,
        observedCommit: observed.commitSha,
        observedArtifacts: observed.artifactCount,
      });
      continue;
    }

    const lastSideEffectMs = Date.parse(effectiveLastSideEffectAt);
    const elapsedMs = Number.isFinite(lastSideEffectMs) ? now - lastSideEffectMs : Number.POSITIVE_INFINITY;

    if (elapsedMs > row.stuckAfterMs) {
      const reason = `No observable side effects (commits or artifacts) for ${elapsedMs}ms (limit ${row.stuckAfterMs}ms)`;
      appendTrailRow(projectRoot, {
        ...row,
        lastCommitSha: observed.commitSha,
        lastArtifactCount: observed.artifactCount,
        lastSideEffectAt: effectiveLastSideEffectAt,
        state: 'stalled',
        note: reason,
      });
      actions.push({
        workerId: row.workerId,
        decision: 'replace-stalled',
        reason,
        observedCommit: observed.commitSha,
        observedArtifacts: observed.artifactCount,
      });
      continue;
    }

    const reason = hadSideEffect
      ? 'Observed new side effects (commit or artifact progress)'
      : 'Worker alive within side-effect window';

    if (hadSideEffect || row.state !== 'running') {
      appendTrailRow(projectRoot, {
        ...row,
        lastCommitSha: observed.commitSha,
        lastArtifactCount: observed.artifactCount,
        lastSideEffectAt: effectiveLastSideEffectAt,
        state: 'running',
        note: reason,
      });
    }

    actions.push({
      workerId: row.workerId,
      decision: 'healthy',
      reason,
      observedCommit: observed.commitSha,
      observedArtifacts: observed.artifactCount,
    });
  }

  return { stopped: false, checked: actions.length, actions };
}

import fs from 'node:fs';
import path from 'node:path';

export interface HandoffPermissions {
  allowPushBranches: boolean;
  allowOpenPr: boolean;
  allowAutoMerge: boolean;
  allowExternalMessages: boolean;
  allowedPaths?: string[];
  externalMessagesAcknowledged?: boolean;
}

export interface HandoffContract {
  goal: string;
  finishCondition: string;
  permissions: HandoffPermissions;
  escapeHatch: string;
  maxDurationMs?: number;
  maxUsd?: number;
  reversible?: boolean;
}

export interface ValidateHandoffOptions {
  externalMessagesAcknowledged?: boolean;
  reversible?: boolean;
}

export interface HandoffValidationResult {
  ok: boolean;
  errors: string[];
}

export const STOP_FILE = '.vgate/STOP';

export interface StopOrder {
  stopped: boolean;
  reason?: string;
  by?: string;
  at?: string;
}

const DURATION_ONLY_PATTERNS: readonly RegExp[] = [
  /\b\d+(?:\.\d+)?\s*(?:ms|msec|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i,
  /\b(?:until|till)\s+(?:morning|tomorrow(?:\s+morning)?|tonight|midnight|noon|dawn|sunrise|eod|end\s+of\s+(?:the\s+)?day|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i,
  /\b(?:overnight|all\s+night|for\s+the\s+night)\b/i,
  /^\s*(?:sleep|wait)\b/i,
];

const DETERMINISTIC_OUTCOME_PATTERNS: readonly RegExp[] = [
  /\b(?:pass|passes|passing|passed|green|succeed|succeeds|succeeded|success)\b/i,
  /\b(?:merge|merged|open|opened|close|closed|resolve|resolved|fix|fixed|verify|verified)\b/i,
  /\b(?:empty|drained|zero|clean|complete|completed|done|finished)\b/i,
  /\b(?:test|tests|gate|ci|check|checks|pr|prs|mr|mrs|queue|backlog|build|lint|typecheck|coverage|deploy|deployed|commit|committed|pushed|artifact|report|finding|findings|issue|issues|ticket|tickets|diff)\b/i,
  /\bexit\s+0\b/i,
];

function isPureDurationCondition(condition: string): boolean {
  const trimmed = condition.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const hasDurationPhrase = DURATION_ONLY_PATTERNS.some((pattern) => pattern.test(trimmed));
  if (!hasDurationPhrase) {
    return false;
  }
  const hasDeterministicOutcome = DETERMINISTIC_OUTCOME_PATTERNS.some((pattern) => pattern.test(trimmed));
  return !hasDeterministicOutcome;
}

export function validateHandoffContract(
  contract: Partial<HandoffContract>,
  options?: ValidateHandoffOptions,
): HandoffValidationResult {
  const errors: string[] = [];

  if (typeof contract.goal !== 'string' || contract.goal.trim().length === 0) {
    errors.push('goal must be a non-empty string');
  }

  if (typeof contract.finishCondition !== 'string' || contract.finishCondition.trim().length === 0) {
    errors.push('finishCondition must be a non-empty string');
  } else if (isPureDurationCondition(contract.finishCondition)) {
    errors.push(
      'finishCondition cannot be a pure duration or time-of-day target; specify a deterministic observable condition (e.g., tests/gate pass, PRs opened/merged, queue empty)',
    );
  }

  if (typeof contract.escapeHatch !== 'string' || contract.escapeHatch.trim().length === 0) {
    errors.push('escapeHatch must be a non-empty string');
  }

  const perms = contract.permissions;
  if (!perms || typeof perms !== 'object') {
    errors.push('permissions must be provided');
  } else {
    if (typeof perms.allowPushBranches !== 'boolean') {
      errors.push('permissions.allowPushBranches must be a boolean');
    }
    if (typeof perms.allowOpenPr !== 'boolean') {
      errors.push('permissions.allowOpenPr must be a boolean');
    }
    if (typeof perms.allowAutoMerge !== 'boolean') {
      errors.push('permissions.allowAutoMerge must be a boolean');
    }
    if (typeof perms.allowExternalMessages !== 'boolean') {
      errors.push('permissions.allowExternalMessages must be a boolean');
    }
    if (perms.allowedPaths !== undefined) {
      if (
        !Array.isArray(perms.allowedPaths) ||
        perms.allowedPaths.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
      ) {
        errors.push('permissions.allowedPaths must be an array of non-empty strings');
      }
    }

    const externalAck = Boolean(perms.externalMessagesAcknowledged || options?.externalMessagesAcknowledged);
    if (perms.allowExternalMessages === true && !externalAck) {
      errors.push('permissions.allowExternalMessages requires explicit acknowledgement');
    }

    const reversible = options?.reversible ?? contract.reversible ?? true;
    if (perms.allowAutoMerge === true && reversible === false) {
      errors.push('permissions.allowAutoMerge is not allowed on non-reversible work');
    }
  }

  if (contract.maxDurationMs !== undefined) {
    if (
      typeof contract.maxDurationMs !== 'number' ||
      !Number.isFinite(contract.maxDurationMs) ||
      contract.maxDurationMs <= 0
    ) {
      errors.push('maxDurationMs must be a positive finite number');
    }
  }

  if (contract.maxUsd !== undefined) {
    if (typeof contract.maxUsd !== 'number' || !Number.isFinite(contract.maxUsd) || contract.maxUsd <= 0) {
      errors.push('maxUsd must be a positive finite number');
    }
  }

  return { ok: errors.length === 0, errors };
}

function stopFilePath(projectRoot: string): string {
  return path.join(projectRoot, STOP_FILE);
}

export function readStopOrder(projectRoot: string): StopOrder {
  const filePath = stopFilePath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return { stopped: false };
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (raw.length === 0) {
    return { stopped: true, reason: 'Stop order file present' };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      return {
        stopped: true,
        reason: typeof record.reason === 'string' && record.reason.length > 0 ? record.reason : 'Stop order active',
        by: typeof record.by === 'string' ? record.by : undefined,
        at: typeof record.at === 'string' ? record.at : undefined,
      };
    }
  } catch {
    // Plain-text .vgate/STOP files are valid manual stop markers.
  }

  return { stopped: true, reason: raw };
}

export function issueStopOrder(projectRoot: string, reason: string, by?: string): StopOrder {
  const filePath = stopFilePath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const order: StopOrder = {
    stopped: true,
    reason: reason.trim().length > 0 ? reason.trim() : 'Manual stop order issued',
    by: by?.trim() || 'operator',
    at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(order, null, 2)}\n`, 'utf8');
  return order;
}

export function clearStopOrder(projectRoot: string): StopOrder {
  const filePath = stopFilePath(projectRoot);
  fs.rmSync(filePath, { force: true });
  return { stopped: false };
}

export function assertWritesAllowed(projectRoot: string): void {
  const order = readStopOrder(projectRoot);
  if (!order.stopped) {
    return;
  }
  const details = [
    order.reason ? `reason="${order.reason}"` : undefined,
    order.by ? `by=${order.by}` : undefined,
    order.at ? `at=${order.at}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ');
  throw new Error(
    `Factory writes blocked by zero-writes stop order (${STOP_FILE}${details ? `: ${details}` : ''}). Run \`vgate resume\` to clear.`,
  );
}

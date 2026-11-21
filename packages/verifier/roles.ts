export const ROLES = ['author', 'verifier', 'mechanical', 'coordinator', 'panel', 'escalation'] as const;
export type RoleName = (typeof ROLES)[number];

export interface RoleAssignment {
  harness: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  family?: string;
}

export interface RolesConfig {
  assignments: Partial<Record<RoleName, RoleAssignment>>;
  panel?: RoleAssignment[];
  requireDistinctVerifierFamily: boolean;
  escalationMinFailures: number;
}

const VALID_EFFORTS = new Set<RoleAssignment['effort']>(['low', 'medium', 'high']);

function matchVendorFamily(text: string): string | undefined {
  const lower = text.trim().toLowerCase();
  if (!lower) return undefined;

  if (/(^|[^a-z0-9])(claude|anthropic|sonnet|opus|haiku)([^a-z0-9]|$)/.test(lower) || lower.includes('claude')) {
    return 'anthropic';
  }
  if (/(^|[^a-z0-9])(gemini|google|vertex|gemma|agy)([^a-z0-9]|$)/.test(lower) || lower.includes('gemini')) {
    return 'google';
  }
  if (
    /(^|[^a-z0-9])(openai|chatgpt|codex)([^a-z0-9]|$)/.test(lower) ||
    /(^|[^a-z0-9])(gpt|o1|o3|o4)([-_./0-9]|$)/.test(lower)
  ) {
    return 'openai';
  }
  if (/(^|[^a-z0-9])(grok|xai|x-ai)([^a-z0-9]|$)/.test(lower) || lower.includes('grok')) {
    return 'xai';
  }
  if (lower.includes('deepseek')) {
    return 'deepseek';
  }
  if (/(^|[^a-z0-9])(llama|meta)([^a-z0-9]|$)/.test(lower) || lower.includes('llama')) {
    return 'meta';
  }

  return undefined;
}

/**
 * Infers the model vendor family from `model` first (for multi-model harnesses) and falls back to `harness`.
 */
export function inferFamily(harness: string, model?: string): string {
  if (model) {
    const fromModel = matchVendorFamily(model);
    if (fromModel) return fromModel;
  }

  const fromHarness = matchVendorFamily(harness);
  if (fromHarness) return fromHarness;

  const normalizedHarness = harness.trim().toLowerCase();
  return normalizedHarness || 'unknown';
}

export function resolveAssignmentFamily(assignment: { harness: string; model?: string; family?: string }): string {
  if (typeof assignment.family === 'string' && assignment.family.trim().length > 0) {
    return assignment.family.trim().toLowerCase();
  }
  return inferFamily(assignment.harness, assignment.model);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAssignment(raw: unknown): RoleAssignment | undefined {
  if (!isRecord(raw)) return undefined;
  const harness = typeof raw['harness'] === 'string' ? raw['harness'].trim() : '';
  if (!harness) return undefined;

  const assignment: RoleAssignment = { harness };
  if (typeof raw['model'] === 'string' && raw['model'].trim().length > 0) {
    assignment.model = raw['model'].trim();
  }
  if (typeof raw['effort'] === 'string' && VALID_EFFORTS.has(raw['effort'] as RoleAssignment['effort'])) {
    assignment.effort = raw['effort'] as RoleAssignment['effort'];
  }
  if (typeof raw['family'] === 'string' && raw['family'].trim().length > 0) {
    assignment.family = raw['family'].trim().toLowerCase();
  }
  return assignment;
}

export function parseRolesConfig(raw: unknown): RolesConfig {
  const config: RolesConfig = {
    assignments: {},
    requireDistinctVerifierFamily: true,
    escalationMinFailures: 2,
  };

  if (!isRecord(raw)) return config;

  if (typeof raw['requireDistinctVerifierFamily'] === 'boolean') {
    config.requireDistinctVerifierFamily = raw['requireDistinctVerifierFamily'];
  }

  if (
    typeof raw['escalationMinFailures'] === 'number' &&
    Number.isFinite(raw['escalationMinFailures']) &&
    raw['escalationMinFailures'] >= 0
  ) {
    config.escalationMinFailures = Math.floor(raw['escalationMinFailures']);
  }

  // Support direct top-level role entries as well as nested `assignments`.
  for (const role of ROLES) {
    if (role === 'panel' && Array.isArray(raw['panel'])) continue;
    const parsed = parseAssignment(raw[role]);
    if (parsed) {
      config.assignments[role] = parsed;
    }
  }

  if (isRecord(raw['assignments'])) {
    for (const role of ROLES) {
      const parsed = parseAssignment(raw['assignments'][role]);
      if (parsed) {
        config.assignments[role] = parsed;
      }
    }
  }

  if (Array.isArray(raw['panel'])) {
    const parsedPanel = raw['panel'].map(parseAssignment).filter((item): item is RoleAssignment => item !== undefined);
    if (parsedPanel.length > 0) {
      config.panel = parsedPanel;
    }
  }

  return config;
}

export function validateSeparationOfPowers(
  config: RolesConfig,
  authorOverride?: { harness: string; model?: string },
): { ok: boolean; authorFamily: string; verifierFamily: string; reason?: string } {
  const author = authorOverride ?? config.assignments.author;
  const primaryVerifier = config.assignments.verifier ?? config.panel?.[0];

  const authorFamily = author ? resolveAssignmentFamily(author) : 'unknown';
  const verifierFamily = primaryVerifier ? resolveAssignmentFamily(primaryVerifier) : 'unknown';

  if (!primaryVerifier) {
    return {
      ok: false,
      authorFamily,
      verifierFamily,
      reason: 'No verifier role or panel configured.',
    };
  }

  if (!config.requireDistinctVerifierFamily) {
    return { ok: true, authorFamily, verifierFamily };
  }

  if (!author || authorFamily === 'unknown') {
    return {
      ok: false,
      authorFamily,
      verifierFamily,
      reason: 'Author role/family is unknown; cannot verify cross-vendor independence.',
    };
  }

  if (verifierFamily === 'unknown') {
    return {
      ok: false,
      authorFamily,
      verifierFamily,
      reason: 'Verifier vendor family is unknown; cannot verify cross-vendor independence.',
    };
  }

  if (authorFamily === verifierFamily) {
    return {
      ok: false,
      authorFamily,
      verifierFamily,
      reason: `Separation of powers violated: author and verifier share vendor family "${authorFamily}".`,
    };
  }

  if (config.panel && config.panel.length > 0) {
    for (const member of config.panel) {
      const memberFamily = resolveAssignmentFamily(member);
      if (memberFamily === 'unknown' || memberFamily === authorFamily) {
        return {
          ok: false,
          authorFamily,
          verifierFamily: memberFamily,
          reason: `Separation of powers violated: panel verifier "${member.harness}" resolves to family "${memberFamily}" (author family: "${authorFamily}").`,
        };
      }
    }
  }

  return { ok: true, authorFamily, verifierFamily };
}

export function canEscalate(
  config: RolesConfig,
  consecutivePrimaryFailures: number,
  explicitUserRequest?: boolean,
): { allowed: boolean; reason: string } {
  if (explicitUserRequest === true) {
    return {
      allowed: true,
      reason: 'Escalation allowed by explicit user request.',
    };
  }

  const failures =
    Number.isFinite(consecutivePrimaryFailures) && consecutivePrimaryFailures > 0
      ? Math.floor(consecutivePrimaryFailures)
      : 0;

  if (failures >= config.escalationMinFailures) {
    return {
      allowed: true,
      reason: `Escalation allowed after ${failures} consecutive primary failure(s) (gate: ${config.escalationMinFailures}).`,
    };
  }

  return {
    allowed: false,
    reason: `Escalation blocked: ${failures} consecutive primary failure(s) is below the minimum gate of ${config.escalationMinFailures}.`,
  };
}

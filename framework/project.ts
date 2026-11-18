/**
 * Where a project's services and reports are. A project is any directory with a `vgate.yaml`; the framework that
 * judges it (the runtime) lives elsewhere: in the vgate binary's cache, or in this repository when run from source.
 *
 *   # vgate.yaml
 *   version: 0.2.0          # the vgate version the project is pinned to
 *   servicesDir: regression # where services/<name>/service.yaml live (default: regression)
 *   reportsDir: reports     # where the gate writes its evidence (default: reports)
 *   policy:
 *     autoMerge: low        # the highest risk tier a PR may merge at without a human (default: none)
 *   risk:                   # path globs -> tier; first match wins per file (default: cli/risk.ts DEFAULT_RISK)
 *     high: [{ path: 'db/migrations/**', reason: schema change }]
 *
 * The runtime reads the project from VGATE_PROJECT (set by vgate for every step it runs); without it, the project
 * is the runtime's own directory, which is how this repository runs its own services.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const PROJECT_FILE = 'vgate.yaml';

/** How risky a change is: the highest tier among its files (cli/risk.ts). */
export const RISK_TIERS = ['low', 'medium', 'high'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** One `risk:` rule: a glob over repository paths (relative to the git top level) and the tier it gives a file. */
export interface RiskRule {
  tier: RiskTier;
  path: string;
  reason?: string;
}

/** What a pull request may do without a human (cli/decide.ts). */
export interface Policy {
  /** The highest risk tier that may merge without a human; `none`: every change needs one. */
  autoMerge: 'none' | RiskTier;
}

/** The directory that holds the framework, its configs and its node_modules. */
export const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface ProjectConfig {
  /** Absolute path of the project (the directory of vgate.yaml). */
  root: string;
  /** The vgate version the project is pinned to; absent without a vgate.yaml. */
  version?: string;
  /** Absolute path of the directory that holds services/<name>/. */
  servicesDir: string;
  /** Absolute path of the reports directory. */
  reportsDir: string;
  /** servicesDir relative to the root, as written in vgate.yaml. */
  servicesDirName: string;
  /** False for a directory without vgate.yaml (the old layout: services/ and reports/ next to the framework). */
  declared: boolean;
  /** `policy:` with its defaults: nothing merges without a human unless the project says so. */
  policy: Policy;
  /** `risk:` in the order written (first match wins per file); absent: the built-in defaults of cli/risk.ts. */
  risk?: RiskRule[];
}

const DEFAULT_POLICY: Policy = { autoMerge: 'none' };

function parsePolicy(value: unknown, file: string): Policy {
  if (value === undefined || value === null) return DEFAULT_POLICY;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file}: policy must be a mapping`);
  const autoMerge = (value as Record<string, unknown>).autoMerge ?? DEFAULT_POLICY.autoMerge;
  if (autoMerge !== 'none' && !RISK_TIERS.includes(autoMerge as RiskTier))
    throw new Error(`${file}: policy.autoMerge must be one of none, ${RISK_TIERS.join(', ')}`);
  return { autoMerge: autoMerge as Policy['autoMerge'] };
}

/** `risk: { high: [{ path, reason }], medium: [...], low: [...] }`; a bare string is a path without a reason. */
function parseRisk(value: unknown, file: string): RiskRule[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${file}: risk must be a mapping of tiers (${RISK_TIERS.join(', ')}) to lists of rules`);
  const rules: RiskRule[] = [];
  for (const [tier, list] of Object.entries(value as Record<string, unknown>)) {
    if (!RISK_TIERS.includes(tier as RiskTier))
      throw new Error(`${file}: risk.${tier} is not a tier (${RISK_TIERS.join(', ')})`);
    if (!Array.isArray(list)) throw new Error(`${file}: risk.${tier} must be a list of { path, reason } rules`);
    for (const [index, entry] of list.entries()) {
      const rule = typeof entry === 'string' ? { path: entry } : (entry as Record<string, unknown> | null);
      if (!rule || typeof rule.path !== 'string' || rule.path === '')
        throw new Error(`${file}: risk.${tier}[${index}] needs a path glob, e.g. { path: 'db/migrations/**' }`);
      if (rule.reason !== undefined && typeof rule.reason !== 'string')
        throw new Error(`${file}: risk.${tier}[${index}].reason must be text`);
      rules.push({ tier: tier as RiskTier, path: rule.path, reason: rule.reason });
    }
  }
  return rules;
}

function relativeDir(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.split(/[\\/]/).includes('..'))
    throw new Error(`${PROJECT_FILE}: ${field} must be a directory inside the project, e.g. ${fallback}`);
  return value.replace(/\/+$/, '');
}

/** Reads `<root>/vgate.yaml`. Without one, the old layout: `services/` and `reports/` in the root. */
export function readProject(root: string): ProjectConfig {
  const dir = resolve(root);
  const file = join(dir, PROJECT_FILE);
  if (!existsSync(file)) {
    return {
      root: dir,
      servicesDir: join(dir, 'services'),
      reportsDir: join(dir, 'reports'),
      servicesDirName: 'services',
      declared: false,
      policy: DEFAULT_POLICY,
    };
  }
  const raw = (parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file}: expected a mapping`);
  // A YAML version such as 1.2 reads as a number: either way it is the text the user wrote.
  if (raw.version !== undefined && typeof raw.version !== 'string' && typeof raw.version !== 'number')
    throw new Error(`${file}: version must be a version such as 1.2.3`);
  const version = raw.version === undefined ? undefined : String(raw.version);
  const services = relativeDir(raw.servicesDir, 'servicesDir', 'regression');
  const reports = relativeDir(raw.reportsDir, 'reportsDir', 'reports');
  return {
    root: dir,
    version,
    servicesDir: join(dir, services),
    reportsDir: join(dir, reports),
    servicesDirName: services,
    declared: true,
    policy: parsePolicy(raw.policy, file),
    risk: parseRisk(raw.risk, file),
  };
}

/** The project the runtime works on: VGATE_PROJECT, else the runtime's own directory. */
export const project: ProjectConfig = readProject(process.env.VGATE_PROJECT ?? runtimeRoot);

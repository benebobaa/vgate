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
 *     mutationScore: 0.7    # the share of planted bugs the tests must catch in changed code (default: not enforced)
 *   mutation:               # `vgate mutate` (docs/mutation.md)
 *     budget: 20            # the most mutants per run
 *     timeout: 10m          # the most time per run
 *   risk:                   # path globs -> tier; first match wins per file (default: cli/risk.ts DEFAULT_RISK)
 *     high: [{ path: 'db/migrations/**', reason: schema change }]
 *   deploy:                 # safe to put next to what runs there? (cli/compat.ts, cli/config-check.ts)
 *     environments:
 *       production:
 *         contract: { ref: 'tag:v*' }                     # or { url: https://api.example.com/openapi.json }
 *         config: { file: deploy/production.env.example } # the keys production provides
 *     policy: { breaking: needs-approval }               # or block
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
  /**
   * The share (0 to 1) of planted bugs the tests must catch in the code a change touches (`vgate mutate`); below it a
   * person looks. Absent: test strength is reported when measured, never required.
   */
  mutationScore?: number;
}

/** `mutation:` in vgate.yaml: how much `vgate mutate` may do per run (its flags override). */
export interface MutationSettings {
  budget: number;
  /** Milliseconds. */
  timeoutMs: number;
}

export const DEFAULT_MUTATION: MutationSettings = { budget: 20, timeoutMs: 10 * 60_000 };

/**
 * Where the version running in an environment publishes its contract: a git ref of the deployed version
 * (`tag:<glob>` = the newest tag matching, by version order; or any branch, tag or sha), or the live contract's URL.
 */
export type ContractSource = { ref: string } | { url: string };

/** How a config source lists its keys; absent: guessed from the file (cli/config-check.ts). */
export const CONFIG_FORMATS = ['dotenv', 'k8s', 'keys'] as const;
export type ConfigFormat = (typeof CONFIG_FORMATS)[number];

/** A file in the project that lists the configuration keys an environment provides (never their values). */
export interface ConfigSource {
  /** Project-relative path. */
  file: string;
  format?: ConfigFormat;
}

/** One deployment target: what runs there (its contract) and what configuration it provides. */
export interface DeployEnvironment {
  name: string;
  contract?: ContractSource;
  config: ConfigSource[];
}

/** `deploy:` in vgate.yaml: is a change safe to put next to what is running (docs/deploy-safety.md)? */
export interface DeployConfig {
  environments: DeployEnvironment[];
  policy: {
    /** What a change that breaks the deployed contract gets: a human's approval, or no merge at all. */
    breaking: 'needs-approval' | 'block';
  };
}

const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseContractSource(value: unknown, where: string): ContractSource | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${where}: contract must be { ref: 'tag:v*' } or { url: https://... }`);
  const { ref, url } = value as Record<string, unknown>;
  if ((ref === undefined) === (url === undefined))
    throw new Error(
      `${where}: contract needs exactly one of ref (the deployed version in git) or url (the live contract)`,
    );
  if (ref !== undefined) {
    if (typeof ref !== 'string' || ref.trim() === '' || ref.startsWith('-'))
      throw new Error(`${where}: contract.ref must be a git ref, or tag:<glob> for the newest matching tag`);
    return { ref: ref.trim() };
  }
  if (typeof url !== 'string' || !/^https?:\/\/\S+$/.test(url))
    throw new Error(`${where}: contract.url must be an http(s) URL`);
  return { url };
}

function parseConfigSources(value: unknown, where: string): ConfigSource[] {
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry, index) => {
    const at = Array.isArray(value) ? `${where}.config[${index}]` : `${where}.config`;
    const raw = typeof entry === 'string' ? { file: entry } : (entry as Record<string, unknown> | null);
    if (!raw || typeof raw !== 'object') throw new Error(`${at}: expected { file, format }`);
    const file = raw.file;
    if (typeof file !== 'string' || file === '' || file.startsWith('/') || file.split(/[\\/]/).includes('..'))
      throw new Error(`${at}.file must be a file inside the project, e.g. deploy/production.env.example`);
    if (raw.format !== undefined && !CONFIG_FORMATS.includes(raw.format as ConfigFormat))
      throw new Error(`${at}.format must be one of ${CONFIG_FORMATS.join(', ')}`);
    return { file, format: raw.format as ConfigFormat | undefined };
  });
}

function parseDeploy(value: unknown, file: string): DeployConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file}: deploy must be a mapping`);
  const raw = value as Record<string, unknown>;
  const envs = raw.environments;
  if (!envs || typeof envs !== 'object' || Array.isArray(envs) || Object.keys(envs).length === 0)
    throw new Error(`${file}: deploy.environments must name at least one environment, e.g. production`);
  const environments = Object.entries(envs as Record<string, unknown>).map(([name, env]) => {
    const where = `${file}: deploy.environments.${name}`;
    if (!ENVIRONMENT_NAME.test(name)) throw new Error(`${where}: not a usable environment name`);
    if (!env || typeof env !== 'object' || Array.isArray(env))
      throw new Error(`${where}: expected { contract, config }`);
    const e = env as Record<string, unknown>;
    const parsed = {
      name,
      contract: parseContractSource(e.contract, where),
      config: parseConfigSources(e.config, where),
    };
    if (!parsed.contract && parsed.config.length === 0)
      throw new Error(`${where}: give a contract source, a config source or both`);
    return parsed;
  });
  const policy = (raw.policy ?? {}) as Record<string, unknown>;
  if (typeof policy !== 'object' || Array.isArray(policy)) throw new Error(`${file}: deploy.policy must be a mapping`);
  const breaking = policy.breaking ?? 'needs-approval';
  if (breaking !== 'needs-approval' && breaking !== 'block')
    throw new Error(`${file}: deploy.policy.breaking must be needs-approval or block`);
  return { environments, policy: { breaking } };
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
  /** `deploy:`: the environments a change must stay safe for; absent: deploy safety is not checked. */
  deploy?: DeployConfig;
  /** `mutation:` with its defaults (absent in hand-built configs: use DEFAULT_MUTATION). */
  mutation?: MutationSettings;
}

const DEFAULT_POLICY: Policy = { autoMerge: 'none' };

function parsePolicy(value: unknown, file: string): Policy {
  if (value === undefined || value === null) return DEFAULT_POLICY;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file}: policy must be a mapping`);
  const raw = value as Record<string, unknown>;
  const autoMerge = raw.autoMerge ?? DEFAULT_POLICY.autoMerge;
  if (autoMerge !== 'none' && !RISK_TIERS.includes(autoMerge as RiskTier))
    throw new Error(`${file}: policy.autoMerge must be one of none, ${RISK_TIERS.join(', ')}`);
  const score = raw.mutationScore;
  if (score !== undefined && score !== null && (typeof score !== 'number' || !(score >= 0 && score <= 1)))
    throw new Error(`${file}: policy.mutationScore must be a share between 0 and 1, e.g. 0.7`);
  return {
    autoMerge: autoMerge as Policy['autoMerge'],
    ...(typeof score === 'number' ? { mutationScore: score } : {}),
  };
}

function parseMutation(value: unknown, file: string): MutationSettings {
  if (value === undefined || value === null) return DEFAULT_MUTATION;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file}: mutation must be a mapping`);
  const raw = value as Record<string, unknown>;
  const budget = raw.budget ?? DEFAULT_MUTATION.budget;
  if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1 || budget > 1000)
    throw new Error(`${file}: mutation.budget must be a whole number of mutants between 1 and 1000`);
  let timeoutMs = DEFAULT_MUTATION.timeoutMs;
  if (raw.timeout !== undefined) timeoutMs = durationMs(raw.timeout, `${file}: mutation.timeout`);
  return { budget, timeoutMs };
}

/** `10m`, `90s`, `1h`, or a number of seconds, in milliseconds. */
export function durationMs(value: unknown, where: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(value).trim());
  if ((typeof value !== 'string' && typeof value !== 'number') || !m)
    throw new Error(`${where}: expected a duration such as 10m, 90s or 1h`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const ms = unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000;
  if (!(ms > 0)) throw new Error(`${where}: the duration must be positive`);
  return ms;
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
      mutation: DEFAULT_MUTATION,
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
    deploy: parseDeploy(raw.deploy, file),
    mutation: parseMutation(raw.mutation, file),
  };
}

/** The project the runtime works on: VGATE_PROJECT, else the runtime's own directory. */
export const project: ProjectConfig = readProject(process.env.VGATE_PROJECT ?? runtimeRoot);

/**
 * `vgate risk`: how risky a change is, from the paths it touches. Each changed file gets the tier of the first rule
 * that matches it (low when none does); the change gets the highest tier of its files. `vgate decide` compares that
 * tier with `policy.autoMerge` to decide whether a pull request may merge without a human.
 *
 * Paths are relative to the git top level, so a rule reads like the repository it guards (`db/migrations/**`).
 */
import type { ProjectConfig, RiskRule, RiskTier } from '../framework/project.ts';
import { changeSet } from './affected.ts';
import { matchesGlob } from './glob.ts';
import { EXIT, type Result } from './output.ts';

/**
 * Always on, before the project's rules and not overridable: the files that decide how a change is judged. A pull
 * request that edits the judge cannot be cleared by it.
 */
export const JUDGE_RISK: RiskRule[] = [
  { tier: 'high', path: '**/vgate.yaml', reason: 'the vgate pin, policy and risk rules' },
  { tier: 'high', path: '**/guardrails.yaml', reason: 'codebase guardrails and architectural boundaries' },
  { tier: 'high', path: '**/.vgate-ratchet.json', reason: 'brownfield guardrail ratchet baseline' },
  { tier: 'high', path: '**/.vgate-quarantine.yaml', reason: 'expiring flaky-test quarantine ledger' },
  { tier: 'high', path: '**/known-failures.yaml', reason: 'failures the gate tolerates' },
  { tier: 'high', path: '.github/workflows/**', reason: 'CI: a pull request runs its own copy' },
  { tier: 'high', path: '.gitlab-ci.yml', reason: 'CI: a merge request runs its own copy' },
  { tier: 'high', path: '{.github/,.gitlab/,docs/,}CODEOWNERS', reason: 'who must approve what' },
  {
    tier: 'high',
    path: '{.agents,.claude,.cursor}/skills/**',
    reason: 'agent skills that guide verification and delivery',
  },
  { tier: 'high', path: '.cursor/rules/**', reason: 'agent instruction rules' },
  { tier: 'high', path: 'skills/**', reason: 'canonical agent skills' },
  { tier: 'high', path: '**/{AGENTS,CLAUDE}.md', reason: 'agent instruction and rule table file' },
];

/**
 * Taste vs. Mechanical boundary: user-facing UI/UX files always require human taste & dogfooding review even when
 * deterministic checks pass, preventing autonomous changes from drifting into a fragmented UX.
 */
export const DEFAULT_UX_PATHS: readonly string[] = [
  '**/{components,pages,views,screens,layouts,design-system}/**',
  '**/*.{tsx,jsx,vue,svelte,css,scss,less}',
];

/**
 * The built-in rules, used when vgate.yaml has no `risk:` block. Directory names are matched anywhere in the tree,
 * so they fit monorepos and most stacks (Go, Java, Node, Python, Ruby, .NET) without configuration. Documentation
 * comes first: a README inside a payments package is still documentation.
 */
export const DEFAULT_RISK: RiskRule[] = [
  { tier: 'low', path: '**/*.{md,mdx,txt,rst,adoc}', reason: 'documentation' },
  { tier: 'low', path: '{docs,doc}/**', reason: 'documentation' },
  {
    tier: 'high',
    path: '**/{migrations,migration,migrate,db/changelog,flyway,liquibase,alembic}/**',
    reason: 'database schema change',
  },
  { tier: 'high', path: '**/{schema.prisma,schema.rb,structure.sql}', reason: 'database schema change' },
  {
    tier: 'high',
    path: '**/{auth,authn,authz,authentication,authorization,security,session,sessions,oauth,oidc,sso,login,rbac,acl,permissions,iam,crypto}/**',
    reason: 'authentication, authorization or cryptography',
  },
  {
    tier: 'high',
    path: '**/{payment,payments,billing,wallet,wallets,ledger,checkout,invoice,invoices,refund,refunds,payout,payouts,money,pricing}/**',
    reason: 'money: payments, billing or balances',
  },
  {
    tier: 'high',
    path: '**/{.env,.env.*,*.pem,*.key,*.p12,*.pfx,id_rsa*,credentials*,secrets.*}',
    reason: 'secrets or environment configuration',
  },
  { tier: 'high', path: '**/{secrets,secret}/**', reason: 'secrets or environment configuration' },
  {
    tier: 'high',
    path: '{.circleci/**,.buildkite/**,Jenkinsfile,azure-pipelines.yml,bitbucket-pipelines.yml,.gitlab/**}',
    reason: 'CI configuration',
  },
  {
    tier: 'high',
    path: '**/{infra,infrastructure,deploy,deployment,deployments,k8s,kubernetes,helm,charts,terraform,pulumi,ansible,argocd}/**',
    reason: 'infrastructure or deployment',
  },
  { tier: 'high', path: '**/*.{tf,tfvars}', reason: 'infrastructure or deployment' },
  {
    tier: 'medium',
    path: '**/{Dockerfile,Dockerfile.*,*.Dockerfile,docker-compose*.yml,docker-compose*.yaml,compose.yml,compose.yaml}',
    reason: 'container build or local stack',
  },
  {
    tier: 'medium',
    path: '**/{package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb,go.sum,go.mod,Cargo.lock,Cargo.toml,poetry.lock,uv.lock,Pipfile.lock,requirements*.txt,Gemfile.lock,composer.lock,pom.xml,build.gradle,build.gradle.kts,gradle.lockfile,packages.lock.json,mix.lock}',
    reason: 'dependencies',
  },
  { tier: 'medium', path: '**/{openapi,swagger}*.{yaml,yml,json}', reason: 'API contract' },
  { tier: 'medium', path: '**/*.{proto,graphql,graphqls,avsc}', reason: 'API or event contract' },
];

export interface RiskMatch {
  file: string;
  tier: RiskTier;
  rule: string;
  reason?: string;
  /** Matched a JUDGE_RISK rule: the change edits what judges it, which no policy lets merge alone. */
  judge?: true;
  /** Matched a user-facing UX/UI surface path: requires human taste & dogfooding review. */
  ux?: true;
}

export interface RiskReport {
  tier: RiskTier;
  /** Every changed file above low, with the rule that placed it there. */
  matches: RiskMatch[];
  /** How many changed files are low. */
  low: number;
  /** `vgate.yaml` (the project's rules) or `built-in` (DEFAULT_RISK). */
  rules: 'vgate.yaml' | 'built-in';
}

const RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };

export function tierAbove(tier: RiskTier, limit: 'none' | RiskTier): boolean {
  return limit === 'none' || RANK[tier] > RANK[limit];
}

/** The tier of each file (judge rules first, then the project's or the built-in rules) and of the whole change. */
export function assessRisk(files: string[], rules: RiskRule[] | undefined, uxPaths?: readonly string[]): RiskReport {
  const ordered = [...JUDGE_RISK, ...(rules ?? DEFAULT_RISK)];
  const uxGlobs = uxPaths ?? DEFAULT_UX_PATHS;
  let tier: RiskTier = 'low';
  const matches: RiskMatch[] = [];
  let low = 0;
  for (const file of files) {
    const rule = ordered.find((candidate) => matchesGlob(file, candidate.path));
    const isUx = uxGlobs.some((glob) => matchesGlob(file, glob));
    const fileTier: RiskTier = rule?.tier ?? (isUx ? 'medium' : 'low');
    if (fileTier === 'low' && !isUx) {
      low++;
      continue;
    }
    matches.push({
      file,
      tier: fileTier,
      rule: rule?.path ?? uxGlobs.find((glob) => matchesGlob(file, glob)) ?? 'ux-surface',
      reason: rule?.reason ?? (isUx ? 'user-facing UX/UI surface (requires human taste review)' : undefined),
      ...(rule && JUDGE_RISK.includes(rule) ? { judge: true as const } : {}),
      ...(isUx ? { ux: true as const } : {}),
    });
    if (RANK[fileTier] > RANK[tier]) tier = fileTier;
  }
  matches.sort((a, b) => RANK[b.tier] - RANK[a.tier] || a.file.localeCompare(b.file));
  return { tier, matches, low, rules: rules ? 'vgate.yaml' : 'built-in' };
}

export function risk(project: ProjectConfig, base: string | undefined): Result {
  const change = changeSet(project, base);
  if ('result' in change) return { ...change.result, command: 'risk' };
  const report = assessRisk(change.files, project.risk, project.uxPaths);
  const counts = (['high', 'medium'] as const).map((t) => `${report.matches.filter((m) => m.tier === t).length} ${t}`);
  return {
    command: 'risk',
    ok: true,
    exitCode: EXIT.ok,
    summary: `Risk ${report.tier.toUpperCase()} vs ${change.base}: ${change.files.length} changed files (${counts.join(', ')}, ${report.low} low; ${report.rules} rules)`,
    data: { base: change.base, mergeBase: change.mergeBase, ...report },
    next: [],
    text: report.matches.map((m) => `${m.tier.padEnd(6)}  ${m.file}  (${m.reason ?? m.rule})`),
  };
}

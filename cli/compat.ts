/**
 * `vgate compat`: does the contract of this change still serve the clients of the version DEPLOYED in an environment?
 * The guard compares a change with its base branch; but main may already hold a breaking change that never reached
 * production, and the clients that matter (mobile apps, partners, other services) talk to production. So the
 * reference here is what runs there: a git ref of the deployed version (`tag:v*`: the newest matching tag) or the
 * live contract's URL, from `deploy.environments.<env>.contract` in vgate.yaml.
 *
 * The rules are the guard's contract rules (cli/guard.ts contractRule): an operation or a documented response removed,
 * a response property removed or retyped, a request property or parameter newly required. Additions are fine.
 *
 * A deployed contract that cannot be read (no matching tag, an unreachable URL) is `unknown`, never `compatible`.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { parse } from 'yaml';
import type { ContractSource, DeployEnvironment, ProjectConfig } from '../framework/project.ts';
import { contractRule, git } from './guard.ts';
import { CLI, EXIT, UsageError, type Result } from './output.ts';
import { resolveService } from './project.ts';

export type CompatState = 'compatible' | 'breaking' | 'unknown' | 'not-configured';

export interface CompatResult {
  environment: string;
  state: CompatState;
  /** Where the deployed contract came from, e.g. `tag v1.4.0 (tag:v*)` or the URL. */
  source?: string;
  /** What breaks for the clients of the deployed version. */
  breaking: string[];
  /** Additive changes: harmless for existing clients. */
  additive: string[];
  /** Why the state is `unknown` or `not-configured`, or a remark such as "not deployed there yet". */
  note?: string;
}

/** The files of a service, relative to the git top level, and their text in the working tree. */
export interface ServiceSources {
  name: string;
  top: string;
  specPath: string;
  serviceYamlPath: string;
  spec?: string;
  serviceYaml?: string;
}

function gitTop(root: string): string | undefined {
  const run = git(realpathSync(root), ['rev-parse', '--show-toplevel']);
  return run.code === 0 ? realpathSync(run.out.trim()) : undefined;
}

/** The contract file a service.yaml names (`spec:`), openapi.yaml by default. */
function specNameOf(serviceYaml: string | undefined): string {
  if (serviceYaml === undefined) return 'openapi.yaml';
  try {
    const raw = parse(serviceYaml) as Record<string, unknown> | null;
    if (raw && typeof raw.spec === 'string' && raw.spec !== '') return raw.spec;
  } catch {
    // An unparseable service.yaml names nothing: the default stays.
  }
  return 'openapi.yaml';
}

/** Reads service.yaml as text (no environment interpolation: nothing here depends on secrets). */
export function serviceSources(project: ProjectConfig, name: string): ServiceSources | { error: string } {
  const top = gitTop(project.root);
  if (!top) return { error: `not a git repository: ${project.root}` };
  const dir = join(realpathSync(project.servicesDir), name);
  const serviceYamlFile = join(dir, 'service.yaml');
  const serviceYaml = existsSync(serviceYamlFile) ? readFileSync(serviceYamlFile, 'utf8') : undefined;
  const specFile = join(dir, specNameOf(serviceYaml));
  const rel = (path: string) => relative(top, path).split('\\').join('/');
  return {
    name,
    top,
    specPath: rel(specFile),
    serviceYamlPath: rel(serviceYamlFile),
    spec: existsSync(specFile) ? readFileSync(specFile, 'utf8') : undefined,
    serviceYaml,
  };
}

/** `tag:<glob>` -> the newest tag matching by version order; anything else -> that ref, if it is a commit. */
export function resolveDeployedRef(top: string, ref: string): { sha: string; label: string } | { error: string } {
  if (ref.startsWith('tag:')) {
    const glob = ref.slice('tag:'.length);
    // A pre-release sorts before its release (v2.0.0-rc.1 < v2.0.0), not after it as git's plain version order has it.
    const tags = git(top, ['-c', 'versionsort.suffix=-', 'tag', '--list', glob, '--sort=-v:refname']);
    const newest = tags.out.split('\n').find(Boolean);
    if (tags.code !== 0 || !newest)
      return {
        error: `no git tag matches ${glob}: the deployed version is unknown (in CI, fetch tags: actions/checkout with fetch-depth: 0)`,
      };
    const sha = git(top, ['rev-parse', '--verify', '--quiet', `${newest}^{commit}`]).out.trim();
    return { sha, label: `tag ${newest} (${ref})` };
  }
  const run = git(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (run.code !== 0) return { error: `unknown git ref ${ref} (fetch it first)` };
  return { sha: run.out.trim(), label: `ref ${ref} (${run.out.trim().slice(0, 7)})` };
}

type Deployed = { text: string; serviceYaml?: string; label: string } | { absent: string } | { error: string };

/** The contract the environment runs. */
export async function deployedContract(
  sources: ServiceSources,
  source: ContractSource,
  timeoutMs = 10_000,
): Promise<Deployed> {
  if ('ref' in source) {
    const ref = resolveDeployedRef(sources.top, source.ref);
    if ('error' in ref) return ref;
    // The deployed version's own contract file: a change that renames it (`spec:`) is still compared with it.
    const serviceYaml = git(sources.top, ['show', `${ref.sha}:${sources.serviceYamlPath}`]);
    const deployedYaml = serviceYaml.code === 0 ? serviceYaml.out : undefined;
    const specPath =
      deployedYaml === undefined
        ? sources.specPath
        : posix.join(posix.dirname(sources.serviceYamlPath), specNameOf(deployedYaml));
    const spec = git(sources.top, ['show', `${ref.sha}:${specPath}`]);
    if (spec.code !== 0) {
      // A valid commit without the service: it was not part of that release.
      const tree = git(sources.top, ['cat-file', '-e', `${ref.sha}:${specPath}`]);
      if (tree.code !== 0 && deployedYaml === undefined) return { absent: `${ref.label} has no ${specPath}` };
      if (tree.code !== 0)
        return { error: `${ref.label} has ${sources.serviceYamlPath} but no contract at ${specPath}` };
      return { error: `git show ${ref.label}:${specPath} failed: ${spec.err.trim()}` };
    }
    return { text: spec.out, serviceYaml: deployedYaml, label: ref.label };
  }
  let response: Response;
  try {
    response = await fetch(source.url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json, application/yaml, text/yaml, */*' },
    });
  } catch (error) {
    return { error: `${source.url} did not answer: ${(error as Error).message}` };
  }
  if (!response.ok) return { error: `${source.url} answered ${response.status}` };
  const text = await response.text();
  try {
    const spec = parse(text) as unknown;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !('paths' in spec))
      return { error: `${source.url} did not return an OpenAPI document` };
  } catch (error) {
    return { error: `${source.url} returned something that is neither JSON nor YAML: ${(error as Error).message}` };
  }
  // The live contract carries no service.yaml: the envelope rules of the working tree apply.
  return { text, label: source.url };
}

/** Compatibility of the working tree's contract with the version deployed in one environment. */
export async function compatFor(sources: ServiceSources, env: DeployEnvironment): Promise<CompatResult> {
  const result: CompatResult = { environment: env.name, state: 'unknown', breaking: [], additive: [] };
  if (!env.contract)
    return { ...result, state: 'not-configured', note: `deploy.environments.${env.name} names no contract source` };
  const deployed = await deployedContract(sources, env.contract);
  if ('error' in deployed) return { ...result, note: deployed.error };
  if ('absent' in deployed)
    return {
      ...result,
      state: 'compatible',
      source: deployed.absent,
      note: `not deployed to ${env.name} yet (${deployed.absent}): no client depends on it there`,
    };
  if (sources.spec === undefined)
    return {
      ...result,
      state: 'breaking',
      source: deployed.label,
      breaking: [`the contract ${sources.specPath} is gone, but ${env.name} serves it`],
    };
  const outcome = contractRule(
    sources.specPath,
    deployed.text,
    sources.spec,
    deployed.serviceYaml,
    sources.serviceYaml,
  );
  return {
    ...result,
    state: outcome.findings.length > 0 ? 'breaking' : 'compatible',
    source: deployed.label,
    breaking: outcome.findings.map((f) => f.detail),
    additive: outcome.info.map((f) => f.detail),
  };
}

/** The environments to check: all of `deploy.environments`, or the one named. */
export function selectEnvironments(project: ProjectConfig, name: string | undefined): DeployEnvironment[] {
  const all = project.deploy?.environments ?? [];
  if (name === undefined) return all;
  const env = all.find((e) => e.name === name);
  if (!env)
    throw new UsageError(
      `No environment "${name}" in deploy.environments of vgate.yaml (have: ${all.map((e) => e.name).join(', ') || 'none'})`,
    );
  return [env];
}

export async function compat(
  project: ProjectConfig,
  options: { service: string | undefined; environment: string | undefined },
): Promise<Result> {
  const service = resolveService(project.root, options.service);
  if (!project.deploy)
    return {
      command: 'compat',
      ok: true,
      exitCode: EXIT.ok,
      summary: `Not configured: vgate.yaml has no deploy block, so compatibility with deployed versions is not checked`,
      data: { service, configured: false, environments: [] },
      next: [],
    };
  const environments = selectEnvironments(project, options.environment);
  const sources = serviceSources(project, service);
  if ('error' in sources)
    return { command: 'compat', ok: false, exitCode: EXIT.notReady, summary: sources.error, next: [] };
  const results = await Promise.all(environments.map((env) => compatFor(sources, env)));
  const breaking = results.filter((r) => r.state === 'breaking');
  const unknown = results.filter((r) => r.state === 'unknown');
  const exitCode = breaking.length > 0 ? EXIT.failed : unknown.length > 0 ? EXIT.notReady : EXIT.ok;
  const summary =
    breaking.length > 0
      ? `BREAKING for ${breaking.map((r) => r.environment).join(', ')}: ${breaking[0].breaking[0]}${breaking.reduce((n, r) => n + r.breaking.length, 0) > 1 ? ' (+ more)' : ''}`
      : unknown.length > 0
        ? `Not checked for ${unknown.map((r) => r.environment).join(', ')}: ${unknown[0].note}`
        : `Compatible with ${results.map((r) => `${r.environment}${r.source ? ` (${r.source})` : ''}`).join(', ')}`;
  return {
    command: 'compat',
    ok: exitCode === EXIT.ok,
    exitCode,
    summary,
    data: { service, configured: true, environments: results },
    next: unknown.length > 0 ? [`${CLI} compat --service ${service} --environment ${unknown[0].environment}`] : [],
    text: results.flatMap((r) => [
      `${r.state.padEnd(14)} ${r.environment}${r.source ? `  vs ${r.source}` : ''}${r.note ? `  (${r.note})` : ''}`,
      ...r.breaking.map((b) => `  BREAKS  ${b}`),
    ]),
  };
}

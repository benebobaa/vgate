/**
 * `drift`: the blind spot of contract-checked stubs. The tests' stubs may only answer what a provider's vendored
 * contract documents; if the real provider changes while that contract stays old, the stubs and the tests keep
 * agreeing with each other and nobody notices. `drift` asks the provider's own sandbox and holds every answer to the
 * vendored contract, strictly (an undocumented field, a missing required one, an undocumented status all count).
 *
 *   environments:
 *     local:
 *       dependencies:
 *         payments:
 *           kind: http-stub
 *           contract: deps/payments.openapi.yaml
 *           sandbox:                                   # read only by `vgate drift --env local`
 *             url: https://sandbox.payments.example
 *             headers: { Authorization: 'Bearer ${PAYMENTS_SANDBOX_KEY}' }
 *             requests:                                # optional; default: every GET without path parameters
 *               - { operation: 'POST /charges', body: { amount: 100, currency: IDR, customer: c1, reference: drift-1 } }
 *               - { operation: 'GET /charges/{id}', path: /charges/ch_test_1 }
 *
 * `${VAR}`s of `sandbox` are read only here, so a missing sandbox secret never breaks the gate. Exit 0: the sandbox
 * answers as the contract says; 1: drift (a sure finding wins over an unreachable call); 3: nothing could be checked.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { OpenApiContract } from '../framework/http/openapi.ts';
import type { ProjectConfig } from '../framework/project.ts';
import { CLI, EXIT, UsageError, type Result } from './output.ts';
import { listServices } from './project.ts';

export const DRIFT_FILE = 'drift.json';

export interface SandboxRequest {
  /** `METHOD /template` as in the vendored contract. */
  operation: string;
  /** The concrete path; default: the template, which must then have no parameters. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Sandbox {
  service: string;
  dependency: string;
  contract: string;
  url: string;
  headers: Record<string, string>;
  requests: SandboxRequest[];
}

export interface DriftCheck {
  service: string;
  dependency: string;
  operation: string;
  path: string;
  status: number | null;
  state: 'ok' | 'drift' | 'unreachable';
  problems: string[];
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);
const VAR = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

/** `${VAR}` and `${VAR:-default}` in every string; a missing variable is named, never left in. */
export function interpolate(value: unknown, where: string, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string')
    return value.replace(VAR, (_m, name: string, fallback: string | undefined) => {
      const found = env[name] ?? fallback;
      if (found === undefined) throw new Error(`${where}: environment variable ${name} is required`);
      return found;
    });
  if (Array.isArray(value)) return value.map((item) => interpolate(item, where, env));
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, where, env)]));
  return value;
}

const strings = (value: unknown, where: string): Record<string, string> => {
  if (value === undefined) return {};
  if (!isRecord(value) || !Object.values(value).every((v) => typeof v === 'string' || typeof v === 'number'))
    throw new Error(`${where} must be a map of name -> text`);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
};

/**
 * The sandboxes of a service.yaml environment. Pure over the parsed file: `dir` resolves the contract, `env` supplies
 * the `${VAR}`s. Requests default to the contract's GET operations without path parameters.
 */
export function sandboxesOf(
  serviceYaml: unknown,
  service: string,
  envName: string,
  dir: string,
  only?: string,
  env: NodeJS.ProcessEnv = process.env,
): Sandbox[] {
  const environments = isRecord(serviceYaml) ? serviceYaml.environments : undefined;
  const environment = isRecord(environments) ? environments[envName] : undefined;
  if (!isRecord(environment)) throw new UsageError(`${service}: service.yaml has no environment "${envName}"`);
  const deps = isRecord(environment.dependencies) ? environment.dependencies : {};
  if (only !== undefined && !isRecord(deps[only]))
    throw new UsageError(`${service}: environments.${envName}.dependencies has no "${only}"`);
  const out: Sandbox[] = [];
  for (const [name, raw] of Object.entries(deps)) {
    if (only !== undefined && name !== only) continue;
    if (!isRecord(raw) || raw.sandbox === undefined) continue;
    const at = `${service} environments.${envName}.dependencies.${name}`;
    if (typeof raw.contract !== 'string' || raw.contract === '')
      throw new UsageError(`${at}: a sandbox needs the provider's vendored contract (contract: <path>)`);
    const sandbox = interpolate(raw.sandbox, `${at}.sandbox`, env);
    if (!isRecord(sandbox) || typeof sandbox.url !== 'string' || !/^https?:\/\//.test(sandbox.url))
      throw new UsageError(`${at}.sandbox.url must be the provider sandbox's http(s) URL`);
    const contract = resolve(dir, raw.contract);
    if (!existsSync(contract)) throw new UsageError(`${at}.contract: ${contract} does not exist`);
    const spec = OpenApiContract.load(contract);
    let requests: SandboxRequest[];
    if (sandbox.requests === undefined) {
      requests = spec.operations
        .filter((op) => op.method === 'GET' && !op.path.includes('{'))
        .map((op) => ({ operation: op.key, path: op.path }));
    } else {
      if (!Array.isArray(sandbox.requests)) throw new UsageError(`${at}.sandbox.requests must be a list`);
      requests = sandbox.requests.map((item: unknown, i: number) => {
        const where = `${at}.sandbox.requests[${i}]`;
        if (!isRecord(item) || typeof item.operation !== 'string')
          throw new UsageError(`${where} needs operation: 'METHOD /path' from the contract`);
        const [method = '', template = ''] = item.operation.trim().split(/\s+/);
        const op = spec.operation(method, template);
        if (!op) throw new UsageError(`${where}: ${item.operation} is not in ${raw.contract as string}`);
        const path = typeof item.path === 'string' ? item.path : template;
        if (path.includes('{')) throw new UsageError(`${where}: give the concrete path (path: /...) for ${op.key}`);
        if (item.body !== undefined) {
          const wrong = spec.validateRequest(op.method, op.path, item.body);
          if (wrong.length > 0)
            throw new UsageError(`${where}: the body breaks the provider's request schema: ${wrong.join('; ')}`);
        }
        return {
          operation: op.key,
          path,
          query: strings(item.query, `${where}.query`),
          body: item.body,
          headers: strings(item.headers, `${where}.headers`),
        };
      });
    }
    if (requests.length === 0)
      throw new UsageError(
        `${at}.sandbox: nothing to ask (the contract has no GET without parameters; list requests:)`,
      );
    out.push({
      service,
      dependency: name,
      contract,
      url: sandbox.url.replace(/\/$/, ''),
      headers: strings(sandbox.headers, `${at}.sandbox.headers`),
      requests,
    });
  }
  return out;
}

/** What changed, in words: the validator's findings plus the renamed-field reading of a missing + an unknown property. */
export function describe(problems: string[]): string[] {
  const missing = problems.flatMap((p) => /must have required property '([^']+)'/.exec(p)?.[1] ?? []);
  const unknown = problems.flatMap(
    (p) => /must NOT have (?:additional|unevaluated) properties "([^"]+)"/.exec(p)?.[1] ?? [],
  );
  const hint =
    missing.length > 0 && unknown.length > 0
      ? [
          `looks renamed: ${missing.map((m) => `"${m}"`).join(', ')} missing, ${unknown.map((u) => `"${u}"`).join(', ')} new`,
        ]
      : [];
  return [...problems, ...hint];
}

export async function checkSandbox(sandbox: Sandbox, timeoutMs = 15_000): Promise<DriftCheck[]> {
  const contract = OpenApiContract.load(sandbox.contract, { strictResponseProperties: true });
  const out: DriftCheck[] = [];
  for (const request of sandbox.requests) {
    const [method, template] = request.operation.split(' ') as [string, string];
    const url = new URL(sandbox.url + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
    const base = {
      service: sandbox.service,
      dependency: sandbox.dependency,
      operation: request.operation,
      path: request.path,
    };
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...sandbox.headers,
          ...request.headers,
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
    } catch (error) {
      out.push({ ...base, status: null, state: 'unreachable', problems: [(error as Error).message] });
      continue;
    }
    const type = response.headers.get('content-type') ?? undefined;
    const text = await response.text();
    let body: unknown = text;
    if (text !== '' && (type ?? '').includes('json')) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        out.push({
          ...base,
          status: response.status,
          state: 'drift',
          problems: ['the answer is not valid JSON though it says so'],
        });
        continue;
      }
    }
    const problems = contract.validateResponse(method, template, response.status, body, type);
    out.push({
      ...base,
      status: response.status,
      state: problems.length === 0 ? 'ok' : 'drift',
      problems: describe(problems),
    });
  }
  return out;
}

export interface DriftOptions {
  service?: string;
  env: string;
  dependency?: string;
  timeoutMs?: number;
}

export async function drift(project: ProjectConfig, options: DriftOptions): Promise<Result> {
  const out = join(project.reportsDir, DRIFT_FILE);
  rmSync(out, { force: true });
  const services = options.service ? [options.service] : listServices(project.root);
  const sandboxes: Sandbox[] = [];
  try {
    for (const service of services) {
      const dir = join(project.servicesDir, service);
      const file = join(dir, 'service.yaml');
      if (!existsSync(file)) throw new UsageError(`Unknown service "${service}": no ${file}`);
      const yaml: unknown = parse(readFileSync(file, 'utf8'));
      // Across all services, one without this environment simply has nothing to compare; a named one must have it.
      const environments = isRecord(yaml) ? yaml.environments : undefined;
      if (!options.service && !(isRecord(environments) && isRecord(environments[options.env]))) continue;
      sandboxes.push(...sandboxesOf(yaml, service, options.env, dir, options.dependency));
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    // A sandbox secret that is not set: nothing can be asked, which is never a pass.
    return { command: 'drift', ok: false, exitCode: EXIT.notReady, summary: (error as Error).message, next: [] };
  }
  if (sandboxes.length === 0)
    throw new UsageError(
      `No dependency of environment "${options.env}" declares a sandbox (dependencies.<name>.sandbox: { url, requests }), so nothing can be compared`,
    );

  const checks = (await Promise.all(sandboxes.map((s) => checkSandbox(s, options.timeoutMs)))).flat();
  const drifted = checks.filter((c) => c.state === 'drift');
  const unreachable = checks.filter((c) => c.state === 'unreachable');
  const exitCode = drifted.length > 0 ? EXIT.failed : unreachable.length > 0 ? EXIT.notReady : EXIT.ok;
  const report = {
    schema: 'vgate.drift/1',
    environment: options.env,
    checkedAt: new Date().toISOString(),
    result: drifted.length > 0 ? 'drift' : unreachable.length > 0 ? 'unreachable' : 'ok',
    checks,
  };
  mkdirSync(project.reportsDir, { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const label = (c: DriftCheck) =>
    `${c.service}/${c.dependency} ${c.operation} (${c.path})${c.status === null ? '' : ` -> ${c.status}`}`;
  return {
    command: 'drift',
    ok: exitCode === EXIT.ok,
    exitCode,
    summary:
      drifted.length > 0
        ? `DRIFT: ${drifted.length} of ${checks.length} sandbox answers no longer match the vendored contract (${drifted.map((c) => `${c.dependency} ${c.operation}`).join(', ')})`
        : unreachable.length > 0
          ? `NOT CHECKED: ${unreachable.length} of ${checks.length} sandbox calls failed (${unreachable.map((c) => `${c.dependency} ${c.operation}`).join(', ')}); nothing drifted among the rest`
          : `No drift: ${checks.length} sandbox answer${checks.length === 1 ? '' : 's'} match the vendored contracts`,
    data: report,
    next:
      drifted.length > 0
        ? [
            `update the vendored contract from the provider's (then ${CLI} gate: stubs and tests follow it), or ask the provider why it changed`,
          ]
        : unreachable.length > 0
          ? ['check the sandbox URL and credentials (service.yaml sandbox, the ${VAR}s it names)']
          : [],
    text: [
      ...checks.flatMap((c) => [`${c.state.padEnd(11)} ${label(c)}`, ...c.problems.map((p) => `            ${p}`)]),
      `Report: ${join(project.reportsDir, DRIFT_FILE)}`,
    ],
  };
}

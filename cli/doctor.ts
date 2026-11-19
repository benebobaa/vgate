/**
 * `doctor`: is this machine and this project ready to run the gate? Every check that is not ok names the command
 * that repairs it, so the caller can fix the environment without knowing the toolchain.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadService, type ServiceConfig } from '../framework/config.ts';
import { PROJECT_FILE, type ProjectConfig } from '../framework/project.ts';
import { CLI, EXIT, type Result } from './output.ts';
import { capture, listServices } from './project.ts';
import { ensureRuntime, linkProject, runtimeState, stepEnv, toolEnv, type Runtime } from './runtime.ts';
import { checkPin, VERSION } from './version.ts';

export type Status = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  status: Status;
  detail: string;
  /** The command (or, where no single command exists, the instruction) that repairs it. */
  fix?: string;
  /** `doctor --fix` runs the fix itself: it only touches this project. */
  autofix?: boolean;
}

/** The first version in a tool's output. A digit inside a word (`k6`, `go1.24`) is a name, not a version. */
export function parseVersion(text: string): number[] | undefined {
  const match = /(?<![A-Za-z0-9.])v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : undefined;
}

export function atLeast(found: number[], min: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    const have = found[i] ?? 0;
    const need = min[i] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

export interface ToolSpec {
  id: string;
  command: string;
  args: string[];
  /** Lowest version that works. */
  min?: string;
  /** Why the gate works without it; makes a missing tool a warning. */
  optional?: string;
  fix: string;
}

export function checkTool(spec: ToolSpec): Check {
  // Asked from a neutral directory: a version check run inside the project would read the project's package manager
  // (corepack refuses pnpm in a bun or yarn project), which says nothing about the tool vgate will use.
  const run = capture(spec.command, spec.args, tmpdir(), 15_000, toolEnv());
  if (run.missing || run.code === null) {
    return {
      id: spec.id,
      status: spec.optional ? 'warn' : 'fail',
      detail: spec.optional ? `not installed (${spec.optional})` : 'not installed',
      fix: spec.fix,
    };
  }
  const line = run.out.split('\n')[0] ?? '';
  if (spec.min) {
    const found = parseVersion(line);
    const min = parseVersion(spec.min);
    if (!found || (min && !atLeast(found, min)))
      return { id: spec.id, status: 'fail', detail: `found ${line || 'unknown'}, need >= ${spec.min}`, fix: spec.fix };
  }
  return { id: spec.id, status: 'ok', detail: line };
}

/** A runtime file: from the binary's embedded copy (before it is extracted) or from disk. */
function runtimeFile(runtime: Runtime, path: string): string | undefined {
  if (runtime.files) return runtime.files[path];
  const file = join(runtime.root, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

/** The Node and pnpm versions the runtime needs (its .nvmrc and packageManager). */
function runtimeVersions(runtime: Runtime): { node: string; pnpm: string } {
  const node = runtimeFile(runtime, '.nvmrc')?.trim().replace(/^v/, '') || '22';
  const manifest = JSON.parse(runtimeFile(runtime, 'package.json') ?? '{}') as { packageManager?: string };
  const pnpm = /^pnpm@(\d+)/.exec(manifest.packageManager ?? '')?.[1] ?? '10';
  return { node, pnpm };
}

const mac = process.platform === 'darwin';

function toolChecks(runtime: Runtime, dockerNeededBy: string[]): Check[] {
  const need = runtimeVersions(runtime);
  const specs: ToolSpec[] = [
    {
      id: 'node',
      command: 'node',
      args: ['--version'],
      min: need.node,
      fix: `fnm install ${need.node} && fnm use ${need.node}   # or: nvm install ${need.node}`,
    },
    {
      id: 'pnpm',
      command: 'pnpm',
      args: ['--version'],
      min: need.pnpm,
      fix: 'corepack enable pnpm',
    },
    { id: 'git', command: 'git', args: ['--version'], fix: mac ? 'brew install git' : 'apt-get install -y git' },
    { id: 'bash', command: 'bash', args: ['--version'], fix: 'Install bash: every stack.sh needs it' },
    { id: 'curl', command: 'curl', args: ['--version'], fix: mac ? 'brew install curl' : 'apt-get install -y curl' },
    {
      id: 'uv',
      command: 'uvx',
      args: ['--version'],
      fix: mac ? 'brew install uv' : 'curl -LsSf https://astral.sh/uv/install.sh | sh',
    },
    {
      id: 'java',
      command: 'java',
      args: ['-version'],
      optional: 'only the Allure report needs it; the verdict does not',
      fix: mac ? 'brew install temurin' : 'apt-get install -y default-jre-headless',
    },
    {
      id: 'k6',
      command: 'k6',
      args: ['version'],
      optional: 'only `perf` needs it, which is outside the gate',
      fix: mac ? 'brew install k6' : 'See https://grafana.com/docs/k6/latest/set-up/install-k6/',
    },
  ];
  const checks = specs.map(checkTool);

  if (dockerNeededBy.length > 0) {
    const docker = capture('docker', ['info', '--format', '{{.ServerVersion}}'], undefined, 15_000);
    const who = `needed by the compose stack of ${dockerNeededBy.join(', ')}`;
    if (docker.missing) {
      checks.push({
        id: 'docker',
        status: 'fail',
        detail: `not installed (${who})`,
        fix: mac ? 'brew install --cask docker' : 'See https://docs.docker.com/engine/install/',
      });
    } else if (docker.code !== 0) {
      checks.push({
        id: 'docker',
        status: 'fail',
        detail: `installed, but the daemon does not answer (${who})`,
        fix: mac ? 'open -a Docker' : 'sudo systemctl start docker',
      });
    } else {
      checks.push({ id: 'docker', status: 'ok', detail: `server ${docker.out.split('\n')[0]}` });
    }
  }
  return checks;
}

/** The project: a vgate.yaml, and the vgate version it is pinned to. */
function projectCheck(project: ProjectConfig): Check {
  if (!project.declared)
    return {
      id: 'project',
      status: 'warn',
      detail: `no ${PROJECT_FILE}: the old layout (services/ next to the framework)`,
      fix: `${CLI} init`,
    };
  const pin = checkPin(project);
  const where = `${PROJECT_FILE}, services in ${relative(project.root, project.servicesDir) || '.'}/`;
  if (pin.state === 'ok') return { id: 'project', status: 'ok', detail: `${where}, ${pin.message}` };
  if (pin.state === 'mismatch') return { id: 'project', status: 'fail', detail: pin.message, fix: pin.fix };
  return { id: 'project', status: 'warn', detail: `${where}; ${pin.message}` };
}

function runtimeCheck(runtime: Runtime): Check {
  const state = runtimeState(runtime);
  const where = runtime.mode === 'source' ? `source checkout ${runtime.root}` : runtime.root;
  if (state.installed) return { id: 'runtime', status: 'ok', detail: `${where} (installed)` };
  return {
    id: 'runtime',
    status: 'fail',
    detail: state.extracted
      ? `${where}: dependencies not installed`
      : `${where}: not extracted yet (the binary carries it; it is unpacked once per version)`,
    fix: `${CLI} doctor --fix`,
    autofix: true,
  };
}

/** A separate project reaches the runtime through <servicesDir>/node_modules and a generated tsconfig.json. */
function linksCheck(project: ProjectConfig, runtime: Runtime): Check | undefined {
  if (project.root === runtime.root) return undefined;
  const link = join(project.servicesDir, 'node_modules');
  const tsconfig = join(project.servicesDir, 'tsconfig.json');
  const linked =
    existsSync(join(link, '@vgate', 'framework', 'config.ts')) &&
    existsSync(tsconfig) &&
    existsSync(join(project.servicesDir, 'package.json'));
  return linked
    ? { id: 'links', status: 'ok', detail: `${relative(project.root, link)} -> the runtime` }
    : {
        id: 'links',
        status: 'fail',
        detail: `${relative(project.root, link)} and ${relative(project.root, tsconfig)} do not lead to the runtime yet`,
        fix: `${CLI} doctor --fix`,
        autofix: true,
      };
}

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** The health URL of a service's stack; undefined when service.yaml names no health path. */
export function healthUrl(svc: ServiceConfig): string | undefined {
  return svc.env.healthPath ? `${svc.env.baseUrl}${svc.env.healthPath}` : undefined;
}

export async function stackUp(svc: ServiceConfig): Promise<boolean | undefined> {
  const url = healthUrl(svc);
  return url ? healthy(url) : undefined;
}

async function serviceChecks(
  project: ProjectConfig,
  name: string,
  envName: string,
): Promise<{ checks: Check[]; svc?: ServiceConfig }> {
  const id = (what: string) => `service:${name}:${what}`;
  const dir = relative(project.root, join(project.servicesDir, name));
  let svc: ServiceConfig;
  try {
    svc = loadService(name, envName, project.root);
  } catch (error) {
    return {
      checks: [
        {
          id: id('config'),
          status: 'fail',
          detail: (error as Error).message,
          fix: `Correct ${dir}/service.yaml, or export the variable it names`,
        },
      ],
    };
  }
  const checks: Check[] = [{ id: id('config'), status: 'ok', detail: `environment ${envName}, ${svc.env.baseUrl}` }];

  if (svc.ui && !existsSync(svc.specPath)) {
    // A UI service may have no contract of its own: the browser verifies it (docs/frontend.md).
    checks.push({ id: id('contract'), status: 'ok', detail: 'UI service without a contract: verified in the browser' });
  } else if (!existsSync(svc.specPath)) {
    checks.push({
      id: id('contract'),
      status: 'fail',
      detail: `${svc.specPath} does not exist`,
      fix: `Vendor the backend's OpenAPI contract to ${dir}/ (skill: generate-api-tests)`,
    });
    return { checks, svc };
  } else {
    checks.push({ id: id('contract'), status: 'ok', detail: 'vendored contract present' });
    const types = join(svc.dir, 'generated', 'openapi.ts');
    const stale = !existsSync(types) || statSync(types).mtimeMs < statSync(svc.specPath).mtimeMs;
    checks.push(
      stale
        ? {
            id: id('types'),
            status: 'fail',
            detail: existsSync(types) ? 'contract types are older than the contract' : 'contract types not generated',
            fix: `${CLI} doctor --fix`,
            autofix: true,
          }
        : { id: id('types'), status: 'ok', detail: 'contract types are current' },
    );
  }

  const up = await stackUp(svc);
  if (up === undefined) {
    checks.push({ id: id('stack'), status: 'ok', detail: 'no healthPath in service.yaml; not probed' });
  } else if (up) {
    checks.push({ id: id('stack'), status: 'ok', detail: `UP at ${healthUrl(svc)}` });
  } else {
    checks.push({
      id: id('stack'),
      status: 'warn',
      detail: `DOWN at ${healthUrl(svc)} (the gate needs it running)`,
      fix: `${CLI} up --service ${name}`,
    });
  }
  return { checks, svc };
}

/** The repairs `--fix` runs, by check kind; each touches only the runtime cache or the project's generated files. */
const AUTOFIX: Record<string, (project: ProjectConfig, runtime: Runtime) => boolean> = {
  runtime: (_project, runtime) => ensureRuntime(runtime, (line) => process.stderr.write(`${line}\n`)).ok,
  links: (project, runtime) => linkProject(project, runtime).ok,
  // Chromium only (no other browser), through the runtime's own Playwright; on Linux CI the system libraries come
  // from `playwright install-deps chromium` (ci/github/vgate.yml).
  browser: (_project, runtime) =>
    capture(
      join(runtime.root, 'node_modules', '.bin', 'playwright'),
      ['install', 'chromium'],
      runtime.root,
      900_000,
      toolEnv(),
    ).code === 0,
  types: (project, runtime) =>
    capture(
      join(runtime.root, 'node_modules', '.bin', 'task'),
      ['--taskfile', join(runtime.root, 'Taskfile.yml'), 'spec:types'],
      runtime.root,
      600_000,
      { ...process.env, ...stepEnv(project, runtime) },
    ).code === 0,
};
/** Repairs depend on each other: the runtime first, then what leads to it, then what it generates. */
const FIX_ORDER = ['runtime', 'links', 'types', 'browser'];

/** The Chromium the runtime's Playwright drives, as it reports it; undefined when the runtime cannot say. */
function chromiumPath(runtime: Runtime): string | undefined {
  const run = capture(
    process.execPath,
    ['-e', "process.stdout.write(require('@playwright/test').chromium.executablePath())"],
    runtime.root,
    30_000,
    toolEnv(),
  );
  return run.code === 0 && run.out.trim() !== '' ? run.out.trim() : undefined;
}

/** UI services drive a real browser: Chromium must be installed for the runtime's Playwright (docs/frontend.md). */
export function browserCheck(runtime: Runtime, uiServices: string[], find = chromiumPath): Check | undefined {
  if (uiServices.length === 0) return undefined;
  const who = `needed by the UI service${uiServices.length === 1 ? '' : 's'} ${uiServices.join(', ')}`;
  if (!existsSync(join(runtime.root, 'node_modules', '@playwright', 'test')))
    return {
      id: 'browser',
      status: 'fail',
      detail: `the runtime is not installed yet (${who})`,
      fix: `${CLI} doctor --fix`,
      autofix: true,
    };
  const path = find(runtime);
  if (path && existsSync(path)) return { id: 'browser', status: 'ok', detail: `Chromium at ${path}` };
  return {
    id: 'browser',
    status: 'fail',
    detail: `Chromium is not installed for the runtime's Playwright (${who})`,
    fix: `${CLI} doctor --fix`,
    autofix: true,
  };
}

async function collect(
  project: ProjectConfig,
  runtime: Runtime,
  services: string[],
  envName: string,
): Promise<Check[]> {
  const perService = await Promise.all(services.map((name) => serviceChecks(project, name, envName)));
  const dockerNeededBy = perService.flatMap(({ svc }) => (svc?.env.compose ? [svc.name] : []));
  const links = linksCheck(project, runtime);
  const browser = browserCheck(
    runtime,
    perService.flatMap(({ svc }) => (svc?.ui ? [svc.name] : [])),
  );
  return [
    ...toolChecks(runtime, dockerNeededBy),
    projectCheck(project),
    runtimeCheck(runtime),
    ...(links ? [links] : []),
    ...(browser ? [browser] : []),
    ...perService.flatMap(({ checks }) => checks),
  ];
}

export interface DoctorOptions {
  /** One service; all of them when absent. */
  service?: string;
  env: string;
  fix: boolean;
}

export async function doctor(project: ProjectConfig, runtime: Runtime, options: DoctorOptions): Promise<Result> {
  const services = options.service ? [options.service] : listServices(project.root);
  let checks = await collect(project, runtime, services, options.env);

  const fixed: string[] = [];
  if (options.fix) {
    const kindOf = (check: Check) => check.id.split(':').at(-1) ?? check.id;
    const failing = new Set(checks.filter((c) => c.autofix && c.status === 'fail').map(kindOf));
    let repaired = false;
    for (const kind of FIX_ORDER.filter((k) => failing.has(k))) {
      repaired = true;
      if (AUTOFIX[kind](project, runtime)) fixed.push(kind);
      else break; // a later repair needs this one
    }
    if (repaired) checks = await collect(project, runtime, services, options.env);
  }

  const failed = checks.filter((check) => check.status === 'fail');
  const warned = checks.filter((check) => check.status === 'warn');
  const next = [
    ...(failed.some((check) => check.autofix) && !options.fix ? [`${CLI} doctor --fix`] : []),
    ...failed.filter((check) => !check.autofix || options.fix).map((check) => check.fix ?? ''),
    ...warned.filter((check) => check.id.endsWith(':stack')).map((check) => check.fix ?? ''),
  ].filter((command, index, all) => command !== '' && all.indexOf(command) === index);

  const width = Math.max(...checks.map((check) => check.id.length));
  return {
    command: 'doctor',
    ok: failed.length === 0,
    exitCode: failed.length === 0 ? EXIT.ok : EXIT.notReady,
    summary:
      failed.length === 0
        ? `Ready: ${checks.length} checks, ${warned.length} warning${warned.length === 1 ? '' : 's'}`
        : `Not ready: ${failed.length} of ${checks.length} checks failed (${failed.map((c) => c.id).join(', ')})`,
    data: {
      root: project.root,
      version: VERSION,
      runtime: { mode: runtime.mode, root: runtime.root },
      services,
      environment: options.env,
      checks,
      fixed,
    },
    next,
    text: checks.map((check) => `${check.status.padEnd(4)}  ${check.id.padEnd(width)}  ${check.detail}`),
  };
}

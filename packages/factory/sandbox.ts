import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import { assertWritesAllowed } from './contract.ts';

export const COORDINATOR_SECRET_PATTERNS: RegExp[] = [
  /^SLACK_/i,
  /^LINEAR_/i,
  /^JIRA_/i,
  /^SENTRY_/i,
  /^X_/i,
  /^TWITTER_/i,
  /^ZENDESK_/i,
  /^INTERCOM_/i,
  /^STRIPE_/i,
  /^AWS_/i,
  /^GCP_/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^GITLAB_TOKEN$/i,
  /^CI_JOB_TOKEN$/i,
  /^VGATE_WEBHOOK_SECRET$/i,
  /^VGATE_SIGNING_/i,
  /^VGATE_OIDC_/i,
  /^VGATE_ALLOW_AUTONOMY$/i,
  /_WEBHOOK_SECRET$/i,
  /_ADMIN_TOKEN$/i,
  /_BOT_TOKEN$/i,
];

// Never pass host HOME: ~/.config/gh, ~/.aws, and ~/.git-credentials live there.
const SAFE_BASELINE_VARS = new Set<string>(['PATH', 'USER', 'LANG', 'TERM', 'TMPDIR', 'NODE_ENV', 'CI']);

const VGATE_SECRET_KEY_PATTERN = /(?:_SECRET|_TOKEN|_KEY|_PASSWORD|_CREDENTIAL)$/i;

export function isCoordinatorSecretKey(key: string): boolean {
  return COORDINATOR_SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

export function sanitizeWorkerEnv(
  sourceEnv: NodeJS.ProcessEnv,
  allowEnv?: Record<string, string>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) {
      continue;
    }
    if (isCoordinatorSecretKey(key)) {
      continue;
    }
    if (SAFE_BASELINE_VARS.has(key)) {
      sanitized[key] = value;
      continue;
    }
    if (key.startsWith('VGATE_') && !VGATE_SECRET_KEY_PATTERN.test(key)) {
      sanitized[key] = value;
    }
  }

  if (allowEnv) {
    for (const [key, value] of Object.entries(allowEnv)) {
      if (isCoordinatorSecretKey(key)) {
        continue;
      }
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export interface EgressPolicy {
  /** Default-deny outbound network egress from worker sandboxes unless explicitly allowlisted. */
  defaultDenyEgress: boolean;
  egressAllowlist: string[];
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  defaultDenyEgress: true,
  egressAllowlist: [],
};

export interface SandboxHandle {
  id: string;
  backend: 'docker' | 'local-worktree' | 'ci-runner' | 'custom';
  workDir: string;
  branch?: string;
  egressPolicy?: EgressPolicy;
  createdAt: string;
}

export interface SandboxExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SandboxBackend {
  kind: SandboxHandle['backend'];
  prepare(opts: { projectRoot: string; runId: string; branch: string; baseRef?: string }): Promise<SandboxHandle>;
  exec(
    handle: SandboxHandle,
    command: string,
    args: string[],
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<SandboxExecResult>;
  destroy(handle: SandboxHandle): Promise<void>;
}

const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID_PATTERN.test(runId) || runId.includes('..')) {
    throw new Error(`Invalid sandbox runId "${runId}": must match ${SAFE_RUN_ID_PATTERN.source}`);
  }
}

function sandboxRootDir(projectRoot: string): string {
  return path.join(projectRoot, '.vgate', 'sandboxes');
}

function inferProjectRoot(workDir: string): string {
  return path.resolve(workDir, '..', '..', '..');
}

function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<SandboxExecResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, extraStderr?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8') + (extraStderr ?? '');
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (error: Error) => {
      finish(null, error.message);
    });

    child.on('close', (code: number | null) => {
      finish(code, timedOut ? '\nCommand timed out' : undefined);
    });

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
          }
        }, 500).unref();
      }, opts.timeoutMs);
      timer.unref();
    }
  });
}

export class LocalWorktreeSandbox implements SandboxBackend {
  readonly kind = 'local-worktree' as const;
  private readonly projectRoots = new Map<string, string>();
  private readonly isolatedHomes = new Map<string, string>();
  private readonly strictEgress: boolean;

  constructor(options?: { enforceKernelEgress?: boolean }) {
    this.strictEgress = options?.enforceKernelEgress === true;
  }

  async prepare(opts: {
    projectRoot: string;
    runId: string;
    branch: string;
    baseRef?: string;
  }): Promise<SandboxHandle> {
    assertWritesAllowed(opts.projectRoot);
    assertSafeRunId(opts.runId);
    if (this.strictEgress) {
      throw new Error(
        'LocalWorktreeSandbox cannot enforce kernel-level default-deny egress; use a Docker/container or CustomSandbox backend.',
      );
    }

    // Security invariant: isolate clone OUTSIDE projectRoot with its own .git and temporary HOME so a worker cannot
    // tamper with the main repo's .git/hooks, core.fsmonitor, .vgate/STOP, reports/, or host ~/.aws / ~/.config/gh.
    const sandboxBase = fs.mkdtempSync(path.join(os.tmpdir(), `vgate-sandbox-${opts.runId}-`));
    const workDir = path.join(sandboxBase, 'repo');
    const isolatedHome = path.join(sandboxBase, 'home');
    fs.mkdirSync(isolatedHome, { recursive: true });
    const baseRef = opts.baseRef ?? 'HEAD';

    const safeGitArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor='];
    const cloneResult = await runCommand(
      'git',
      [...safeGitArgs, 'clone', '--no-hardlinks', opts.projectRoot, workDir],
      {
        cwd: sandboxBase,
        env: sanitizeWorkerEnv(process.env, { HOME: isolatedHome }),
      },
    );
    if (!cloneResult.ok) {
      fs.rmSync(sandboxBase, { recursive: true, force: true });
      throw new Error(
        `Failed to clone isolated sandbox at ${workDir}: ${cloneResult.stderr.trim() || cloneResult.stdout.trim()}`,
      );
    }

    const checkoutResult = await runCommand('git', [...safeGitArgs, 'checkout', '-b', opts.branch, baseRef], {
      cwd: workDir,
      env: sanitizeWorkerEnv(process.env, { HOME: isolatedHome }),
    });
    if (!checkoutResult.ok) {
      fs.rmSync(sandboxBase, { recursive: true, force: true });
      throw new Error(
        `Failed to checkout branch ${opts.branch} from ${baseRef}: ${checkoutResult.stderr.trim() || checkoutResult.stdout.trim()}`,
      );
    }

    this.projectRoots.set(opts.runId, opts.projectRoot);
    this.isolatedHomes.set(opts.runId, isolatedHome);
    return {
      id: opts.runId,
      backend: 'local-worktree',
      workDir,
      branch: opts.branch,
      egressPolicy: { defaultDenyEgress: false, egressAllowlist: [] },
      createdAt: new Date().toISOString(),
    };
  }

  async exec(
    handle: SandboxHandle,
    command: string,
    args: string[],
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<SandboxExecResult> {
    const projectRoot = this.projectRoots.get(handle.id) ?? inferProjectRoot(handle.workDir);
    assertWritesAllowed(projectRoot);
    const isolatedHome = this.isolatedHomes.get(handle.id) ?? path.join(path.dirname(handle.workDir), 'home');
    const env = sanitizeWorkerEnv(process.env, {
      HOME: isolatedHome,
      VGATE_EGRESS_POLICY: (handle.egressPolicy?.defaultDenyEgress ?? false) ? 'deny-default' : 'best-effort-local',
      ...(handle.egressPolicy?.egressAllowlist.length
        ? { VGATE_EGRESS_ALLOWLIST: handle.egressPolicy.egressAllowlist.join(',') }
        : {}),
      ...opts?.env,
    });
    return runCommand(command, args, {
      cwd: handle.workDir,
      env,
      timeoutMs: opts?.timeoutMs,
    });
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    this.projectRoots.delete(handle.id);
    this.isolatedHomes.delete(handle.id);
    const sandboxBase = path.dirname(handle.workDir);
    if (path.basename(sandboxBase).startsWith('vgate-sandbox-')) {
      fs.rmSync(sandboxBase, { recursive: true, force: true });
    } else {
      fs.rmSync(handle.workDir, { recursive: true, force: true });
    }
    return Promise.resolve();
  }
}

export interface CiDispatchCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface CiDispatchPayload {
  provider: 'github-actions' | 'gitlab-ci';
  workflow: string;
  repository?: string;
  runId: string;
  branch: string;
  baseRef: string;
  createdAt: string;
  commands: CiDispatchCommand[];
}

export interface CiRunnerSandboxOptions {
  provider?: 'github-actions' | 'gitlab-ci';
  workflow?: string;
  repository?: string;
}

export class CiRunnerSandbox implements SandboxBackend {
  readonly kind = 'ci-runner' as const;
  private readonly provider: 'github-actions' | 'gitlab-ci';
  private readonly workflow: string;
  private readonly repository?: string;
  private readonly projectRoots = new Map<string, string>();

  constructor(options?: CiRunnerSandboxOptions) {
    this.provider = options?.provider ?? 'github-actions';
    this.workflow = options?.workflow ?? 'vgate-factory-worker.yml';
    this.repository = options?.repository;
  }

  async prepare(opts: {
    projectRoot: string;
    runId: string;
    branch: string;
    baseRef?: string;
  }): Promise<SandboxHandle> {
    assertWritesAllowed(opts.projectRoot);
    assertSafeRunId(opts.runId);

    const workDir = path.join(sandboxRootDir(opts.projectRoot), opts.runId);
    fs.mkdirSync(workDir, { recursive: true });

    const createdAt = new Date().toISOString();
    const payload: CiDispatchPayload = {
      provider: this.provider,
      workflow: this.workflow,
      ...(this.repository ? { repository: this.repository } : {}),
      runId: opts.runId,
      branch: opts.branch,
      baseRef: opts.baseRef ?? 'HEAD',
      createdAt,
      commands: [],
    };
    fs.writeFileSync(path.join(workDir, 'dispatch.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    this.projectRoots.set(opts.runId, opts.projectRoot);
    return Promise.resolve({
      id: opts.runId,
      backend: 'ci-runner',
      workDir,
      branch: opts.branch,
      createdAt,
    });
  }

  async exec(
    handle: SandboxHandle,
    command: string,
    args: string[],
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<SandboxExecResult> {
    const startedAt = Date.now();
    const projectRoot = this.projectRoots.get(handle.id) ?? inferProjectRoot(handle.workDir);
    assertWritesAllowed(projectRoot);

    const dispatchPath = path.join(handle.workDir, 'dispatch.json');
    const raw = fs.readFileSync(dispatchPath, 'utf8');
    const payload = JSON.parse(raw) as CiDispatchPayload;

    const entry: CiDispatchCommand = {
      command,
      args: [...args],
      env: sanitizeWorkerEnv({}, opts?.env),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    };
    payload.commands.push(entry);

    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    fs.writeFileSync(dispatchPath, serialized, 'utf8');

    return Promise.resolve({
      ok: true,
      exitCode: 0,
      stdout: serialized,
      stderr: '',
      durationMs: Date.now() - startedAt,
    });
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    this.projectRoots.delete(handle.id);
    fs.rmSync(handle.workDir, { recursive: true, force: true });
    return Promise.resolve();
  }
}

export interface CustomSandboxConfig {
  prepareCmd: string[];
  execCmd: string[];
  destroyCmd: string[];
}

function assertCommandArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is string => typeof item === 'string' && item.length > 0)
  ) {
    throw new Error(`CustomSandbox config "${field}" must be a non-empty array of strings`);
  }
  return [...value];
}

export function parseCustomSandboxConfig(yamlText: string): CustomSandboxConfig {
  const parsed: unknown = parseYaml(yamlText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('CustomSandbox YAML must parse to an object with prepareCmd, execCmd, and destroyCmd');
  }
  const record = parsed as Record<string, unknown>;
  return {
    prepareCmd: assertCommandArray(record.prepareCmd, 'prepareCmd'),
    execCmd: assertCommandArray(record.execCmd, 'execCmd'),
    destroyCmd: assertCommandArray(record.destroyCmd, 'destroyCmd'),
  };
}

function interpolateArgv(
  template: readonly string[],
  vars: Record<string, string>,
  extraArgs?: readonly string[],
): string[] {
  const out: string[] = [];
  for (const token of template) {
    if (token === '{{args}}') {
      if (extraArgs) {
        out.push(...extraArgs);
      }
      continue;
    }
    let replaced = token;
    for (const [key, value] of Object.entries(vars)) {
      replaced = replaced.replaceAll(`{{${key}}}`, value);
    }
    out.push(replaced);
  }
  return out;
}

export class CustomSandbox implements SandboxBackend {
  readonly kind = 'custom' as const;
  private readonly config: CustomSandboxConfig;
  private readonly projectRoots = new Map<string, string>();

  constructor(config: CustomSandboxConfig | string) {
    if (typeof config === 'string') {
      this.config = parseCustomSandboxConfig(config);
    } else {
      this.config = {
        prepareCmd: assertCommandArray(config.prepareCmd, 'prepareCmd'),
        execCmd: assertCommandArray(config.execCmd, 'execCmd'),
        destroyCmd: assertCommandArray(config.destroyCmd, 'destroyCmd'),
      };
    }
  }

  async prepare(opts: {
    projectRoot: string;
    runId: string;
    branch: string;
    baseRef?: string;
  }): Promise<SandboxHandle> {
    assertWritesAllowed(opts.projectRoot);
    assertSafeRunId(opts.runId);

    const workDir = path.join(sandboxRootDir(opts.projectRoot), opts.runId);
    fs.mkdirSync(workDir, { recursive: true });

    const argv = interpolateArgv(this.config.prepareCmd, {
      projectRoot: opts.projectRoot,
      runId: opts.runId,
      branch: opts.branch,
      baseRef: opts.baseRef ?? 'HEAD',
      workDir,
    });

    const [cmd, ...args] = argv;
    const result = await runCommand(cmd, args, {
      cwd: opts.projectRoot,
      env: sanitizeWorkerEnv(process.env),
    });

    if (!result.ok) {
      throw new Error(`CustomSandbox prepare failed (${cmd}): ${result.stderr.trim() || result.stdout.trim()}`);
    }

    this.projectRoots.set(opts.runId, opts.projectRoot);
    return {
      id: opts.runId,
      backend: 'custom',
      workDir,
      branch: opts.branch,
      createdAt: new Date().toISOString(),
    };
  }

  async exec(
    handle: SandboxHandle,
    command: string,
    args: string[],
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<SandboxExecResult> {
    const projectRoot = this.projectRoots.get(handle.id) ?? inferProjectRoot(handle.workDir);
    assertWritesAllowed(projectRoot);

    const argv = interpolateArgv(
      this.config.execCmd,
      {
        projectRoot,
        runId: handle.id,
        branch: handle.branch ?? '',
        workDir: handle.workDir,
        command,
      },
      args,
    );

    const [cmd, ...cmdArgs] = argv;
    return runCommand(cmd, cmdArgs, {
      cwd: handle.workDir,
      env: sanitizeWorkerEnv(process.env, opts?.env),
      timeoutMs: opts?.timeoutMs,
    });
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const projectRoot = this.projectRoots.get(handle.id) ?? inferProjectRoot(handle.workDir);
    this.projectRoots.delete(handle.id);

    const argv = interpolateArgv(this.config.destroyCmd, {
      projectRoot,
      runId: handle.id,
      branch: handle.branch ?? '',
      workDir: handle.workDir,
    });

    const [cmd, ...cmdArgs] = argv;
    await runCommand(cmd, cmdArgs, {
      cwd: projectRoot,
      env: sanitizeWorkerEnv(process.env),
    });
    fs.rmSync(handle.workDir, { recursive: true, force: true });
  }
}

export interface DockerSandboxOptions {
  /** Container image used to run worker commands (default: `node:22-alpine`). */
  image?: string;
  /** Container network mode; defaults to `'none'` for kernel-enforced default-deny egress. */
  network?: string;
  /** Memory cap passed to Docker (default: `2g`). */
  memory?: string;
  /** PID limit passed to Docker (default: `256`). */
  pidsLimit?: number;
}

/** Builds deterministic, fail-closed `docker run` arguments enforcing kernel default-deny egress (`--network none`). */
export function buildDockerRunArgs(opts: {
  workDir: string;
  image: string;
  network: string;
  memory: string;
  pidsLimit: number;
  env: Record<string, string>;
  command: string;
  args: readonly string[];
}): string[] {
  const argv: string[] = [
    'run',
    '--rm',
    '--init',
    '--network',
    opts.network,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    String(opts.pidsLimit),
    '--memory',
    opts.memory,
    '-v',
    `${opts.workDir}:/workspace`,
    '-w',
    '/workspace',
    '-e',
    'HOME=/tmp',
  ];
  for (const [key, value] of Object.entries(opts.env)) {
    if (key === 'HOME' || key === 'PATH') continue;
    argv.push('-e', `${key}=${value}`);
  }
  argv.push(opts.image, opts.command, ...opts.args);
  return argv;
}

/**
 * Container-isolated worker sandbox backed by Docker with real kernel-enforced default-deny egress (`--network none`),
 * dropped Linux capabilities (`--cap-drop ALL`), `no-new-privileges`, isolated out-of-repo git clone, and stripped env.
 */
export class DockerSandbox implements SandboxBackend {
  readonly kind = 'docker' as const;
  private readonly image: string;
  private readonly network: string;
  private readonly memory: string;
  private readonly pidsLimit: number;
  private readonly projectRoots = new Map<string, string>();
  private readonly sandboxBases = new Map<string, string>();

  constructor(options?: DockerSandboxOptions) {
    this.image = options?.image ?? 'node:22-alpine';
    this.network = options?.network ?? 'none';
    this.memory = options?.memory ?? '2g';
    this.pidsLimit = options?.pidsLimit ?? 256;
  }

  async prepare(opts: {
    projectRoot: string;
    runId: string;
    branch: string;
    baseRef?: string;
  }): Promise<SandboxHandle> {
    assertWritesAllowed(opts.projectRoot);
    assertSafeRunId(opts.runId);

    const probe = await runCommand('docker', ['version', '--format', '{{.Server.Version}}'], {
      cwd: opts.projectRoot,
      env: sanitizeWorkerEnv(process.env),
      timeoutMs: 10_000,
    });
    if (!probe.ok) {
      throw new Error(
        `DockerSandbox requires a running Docker daemon: ${probe.stderr.trim() || probe.stdout.trim() || 'docker unavailable'}`,
      );
    }

    const sandboxBase = fs.mkdtempSync(path.join(os.tmpdir(), `vgate-docker-${opts.runId}-`));
    const workDir = path.join(sandboxBase, 'repo');
    const cleanEnv = { ...sanitizeWorkerEnv(process.env), HOME: sandboxBase };
    const clone = await runCommand(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-hardlinks', opts.projectRoot, workDir],
      { cwd: sandboxBase, env: cleanEnv },
    );
    if (!clone.ok) {
      fs.rmSync(sandboxBase, { recursive: true, force: true });
      throw new Error(`DockerSandbox clone failed: ${clone.stderr.trim() || clone.stdout.trim()}`);
    }
    const checkout = await runCommand(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'checkout', '-b', opts.branch, opts.baseRef ?? 'HEAD'],
      { cwd: workDir, env: cleanEnv },
    );
    if (!checkout.ok) {
      fs.rmSync(sandboxBase, { recursive: true, force: true });
      throw new Error(`DockerSandbox branch checkout failed: ${checkout.stderr.trim() || checkout.stdout.trim()}`);
    }

    this.projectRoots.set(opts.runId, opts.projectRoot);
    this.sandboxBases.set(opts.runId, sandboxBase);
    return {
      id: opts.runId,
      backend: 'docker',
      workDir,
      branch: opts.branch,
      createdAt: new Date().toISOString(),
      egressPolicy: {
        defaultDenyEgress: this.network === 'none',
        egressAllowlist: [],
      },
    };
  }

  async exec(
    handle: SandboxHandle,
    command: string,
    args: string[],
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<SandboxExecResult> {
    const projectRoot = this.projectRoots.get(handle.id) ?? inferProjectRoot(handle.workDir);
    assertWritesAllowed(projectRoot);
    const workerEnv = sanitizeWorkerEnv(process.env, opts?.env);
    const dockerArgs = buildDockerRunArgs({
      workDir: handle.workDir,
      image: this.image,
      network: this.network,
      memory: this.memory,
      pidsLimit: this.pidsLimit,
      env: workerEnv,
      command,
      args,
    });
    return runCommand('docker', dockerArgs, {
      cwd: handle.workDir,
      env: sanitizeWorkerEnv(process.env),
      timeoutMs: opts?.timeoutMs,
    });
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const sandboxBase = this.sandboxBases.get(handle.id) ?? path.dirname(handle.workDir);
    this.projectRoots.delete(handle.id);
    this.sandboxBases.delete(handle.id);
    if (fs.existsSync(sandboxBase)) {
      fs.rmSync(sandboxBase, { recursive: true, force: true });
    }
    return Promise.resolve();
  }
}

/** `up`, `down`, `status`, `reset`: the service's local stack, through its own `stack.sh`. */
import { spawn } from 'node:child_process';
import { existsSync, type WriteStream } from 'node:fs';
import { join, relative } from 'node:path';
import { loadService } from '../framework/config.ts';
import type { ProjectConfig } from '../framework/project.ts';
import { stackUp } from './doctor.ts';
import { CLI, EXIT, UsageError, tail, type Result } from './output.ts';
import { prepare, stepEnv, type Runtime } from './runtime.ts';

export interface Streamed {
  /** Exit code; null when the program could not be started or was killed. */
  code: number | null;
  /** stdout and stderr, in the order they arrived. */
  output: string;
  durationMs: number;
}

export interface StreamOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Copy the output to stderr as it arrives. stdout stays reserved for the command's result. */
  live: boolean;
  /** Also write the output here. */
  log?: WriteStream;
}

/** Runs a program to the end without blocking, keeping what it printed. */
export function runStreamed(command: string, args: string[], options: StreamOptions): Promise<Streamed> {
  const started = Date.now();
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const take = (chunk: Buffer) => {
      chunks.push(chunk);
      options.log?.write(chunk);
      if (options.live) process.stderr.write(chunk);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const finish = (code: number | null, note = '') =>
      done({ code, output: Buffer.concat(chunks).toString('utf8') + note, durationMs: Date.now() - started });
    child.on('error', (error) => finish(null, `\n${command}: ${error.message}\n`));
    child.on('close', (code) => finish(code));
  });
}

export const STACK_ACTIONS = ['up', 'down', 'status', 'reset'] as const;
export type StackAction = (typeof STACK_ACTIONS)[number];

export interface StackOptions {
  service: string;
  env: string;
  action: StackAction;
  /** Consent to `reset`, which wipes the service's local test data. */
  yes: boolean;
  live: boolean;
}

export async function stack(project: ProjectConfig, runtime: Runtime, options: StackOptions): Promise<Result> {
  const { service, action } = options;
  const root = project.root;
  // The CLI never prompts (its caller may be an agent with no terminal): the flag is the consent.
  if (action === 'reset' && !options.yes)
    throw new UsageError(`reset wipes the local test data of ${service}: pass --yes to confirm`);

  const script = relative(root, join(project.servicesDir, service, 'stack.sh'));
  if (!existsSync(join(root, script))) {
    return {
      command: action,
      ok: false,
      exitCode: EXIT.notReady,
      summary: `${service} has no ${script}: nothing knows how to start it`,
      data: { service, action },
      next: [`${CLI} doctor --service ${service}`],
    };
  }

  // A stack script runs the service's code with the runtime's tools (tsx), reached through the project's links.
  const ready = prepare(project, runtime, options.live);
  if (!ready.ok) {
    return {
      command: action,
      ok: false,
      exitCode: EXIT.notReady,
      summary: ready.error ?? 'the vgate runtime is not ready',
      data: { service, action, runtime: runtime.root },
      next: [`${CLI} doctor --fix`],
    };
  }

  const run = await runStreamed('bash', [script, action], {
    cwd: root,
    env: { ...process.env, ...stepEnv(project, runtime), SERVICE: service, TEST_ENV: options.env },
    live: options.live,
  });
  const ok = run.code === 0;
  const data: Record<string, unknown> = {
    service,
    action,
    exitCode: run.code,
    durationMs: run.durationMs,
    output: tail(run.output, 30),
  };
  if (action === 'status') {
    try {
      data.up = (await stackUp(loadService(service, options.env, root))) ?? null;
    } catch {
      data.up = null;
    }
  }

  const next: string[] = [];
  if (!ok) next.push(`${CLI} doctor --service ${service}`);
  else if (action === 'up' || action === 'reset') next.push(`${CLI} gate --service ${service}`);
  else if (action === 'status' && data.up === false) next.push(`${CLI} up --service ${service}`);

  return {
    command: action,
    ok,
    exitCode: ok ? EXIT.ok : EXIT.notReady,
    summary: ok
      ? action === 'status'
        ? `${service}: ${data.up === null ? 'status printed (no healthPath to probe)' : data.up ? 'UP' : 'DOWN'}`
        : `${service}: ${action} done in ${(run.durationMs / 1000).toFixed(1)}s`
      : `${service}: ${action} failed (exit ${run.code ?? 'none'})`,
    data,
    next,
    // Live runs already showed the output on stderr.
    text: options.live ? [] : tail(run.output, 30),
  };
}

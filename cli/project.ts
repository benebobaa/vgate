/**
 * Where the project is and which services it holds. The CLI is a standalone binary, so it finds both from the cwd:
 * a project is the nearest directory with a vgate.yaml (framework/project.ts). The old layout, framework/config.ts
 * next to services/ without a vgate.yaml, still counts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_FILE, readProject, type ProjectConfig } from '../framework/project.ts';
import { CLI, UsageError } from './output.ts';

/** The nearest directory at or above `start` that is a project. */
export function findRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, PROJECT_FILE))) return dir;
    if (existsSync(join(dir, 'framework', 'config.ts')) && existsSync(join(dir, 'services'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function requireRoot(flag: string | undefined): string {
  const root = findRoot(flag ?? process.cwd());
  if (!root)
    throw new UsageError(
      `No project here: ${resolve(flag ?? process.cwd())} and its parents hold no ${PROJECT_FILE}. ` +
        `Run inside the project, pass --root <dir>, or create one with \`${CLI} init\`.`,
    );
  return root;
}

export function requireProject(flag: string | undefined): ProjectConfig {
  const root = requireRoot(flag);
  try {
    return readProject(root);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export function listServices(root: string): string[] {
  const dir = readProject(root).servicesDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'service.yaml')))
    .map((entry) => entry.name)
    .sort();
}

/** `--service`, then `SERVICE`, then the only service there is. Never a silent default among several. */
export function resolveService(root: string, flag: string | undefined): string {
  const services = listServices(root);
  const name = flag ?? process.env.SERVICE ?? (services.length === 1 ? services[0] : undefined);
  if (!name) throw new UsageError(`Pass --service <name>. Services: ${services.join(', ') || '(none)'}`);
  if (!services.includes(name))
    throw new UsageError(`Unknown service "${name}". Services: ${services.join(', ') || '(none)'}`);
  return name;
}

export interface Captured {
  /** Exit code; null when the program could not be started or was killed. */
  code: number | null;
  out: string;
  /** The program is not on PATH. */
  missing: boolean;
}

/** Runs a program to the end and returns what it printed (stdout and stderr together). */
export function capture(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 120_000,
  env?: NodeJS.ProcessEnv,
): Captured {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: env ?? process.env });
  // spawnSync reports a program it cannot find as an error with code ENOENT, not as an exit code.
  const missing = result.error !== undefined && 'code' in result.error && result.error.code === 'ENOENT';
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(), missing };
}

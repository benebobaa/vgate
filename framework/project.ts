/**
 * Where a project's services and reports are. A project is any directory with a `vgate.yaml`; the framework that
 * judges it (the runtime) lives elsewhere: in the vgate binary's cache, or in this repository when run from source.
 *
 *   # vgate.yaml
 *   version: 0.2.0          # the vgate version the project is pinned to
 *   servicesDir: regression # where services/<name>/service.yaml live (default: regression)
 *   reportsDir: reports     # where the gate writes its evidence (default: reports)
 *
 * The runtime reads the project from VGATE_PROJECT (set by vgate for every step it runs); without it, the project
 * is the runtime's own directory, which is how this repository runs its own services.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const PROJECT_FILE = 'vgate.yaml';

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
  };
}

/** The project the runtime works on: VGATE_PROJECT, else the runtime's own directory. */
export const project: ProjectConfig = readProject(process.env.VGATE_PROJECT ?? runtimeRoot);

/**
 * The runtime: the framework that judges a project, with its configs, its framework scripts and its node_modules.
 * It never lives in the project's repository, so a merge request cannot edit the judge.
 *
 * - From source (`pnpm vgate`), the runtime is this checkout.
 * - The compiled binary carries the runtime's files (embedded by `bundleRuntime()` at build time) and extracts them
 *   once per version to `$VGATE_HOME/<version>-<hash>/runtime` (default `~/.cache/vgate`), where `pnpm install`
 *   runs once.
 *
 * A project's tests import the framework as `@vgate/framework/<module>.ts` and their tools (`@playwright/test`, `pg`)
 * by name. Both resolve through one gitignored symlink, `<servicesDir>/node_modules`, to the runtime's node_modules,
 * where `@vgate/framework` is linked to the runtime's framework/ (package.json: `link:framework`). Node, tsx,
 * Playwright, tsc and ESLint all follow it, and all of them see one copy of each package.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../framework/project.ts';
import { capture } from './project.ts';

/** Set by `cli/build.ts`: the runtime's files as JSON (`{ path: content }`). Absent when run from source. */
declare const VGATE_RUNTIME: string | undefined;

/** What the runtime is made of, relative to the source root. Directories are taken whole (see `skip`). */
export const RUNTIME_PATHS = [
  'framework',
  'cli',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'eslint.config.js',
  'playwright.config.ts',
  'Taskfile.yml',
  '.prettierrc.json',
  '.nvmrc',
] as const;

const SKIP = new Set(['node_modules', '.DS_Store', '.task', 'dist']);

function walk(dir: string, base: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, base);
    return entry.isFile() ? [relative(base, path).split('\\').join('/')] : [];
  });
}

/** The runtime's files as `{ path: content }`, read from a source checkout. `cli/build.ts` embeds this. */
export function bundleRuntime(sourceRoot: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of RUNTIME_PATHS) {
    const path = join(sourceRoot, entry);
    if (!existsSync(path)) throw new Error(`runtime: ${entry} is missing in ${sourceRoot}`);
    const paths = lstatSync(path).isDirectory() ? walk(path, sourceRoot) : [entry];
    for (const file of paths.sort()) files[file] = readFileSync(join(sourceRoot, file), 'utf8');
  }
  return files;
}

export function hashFiles(files: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).sort()) hash.update(path).update('\0').update(files[path]).update('\0');
  return hash.digest('hex');
}

export interface Runtime {
  /** `source`: this checkout. `embedded`: the binary's copy, extracted to the cache. */
  mode: 'source' | 'embedded';
  /** Absolute path of the runtime: framework/, Taskfile.yml, node_modules/. */
  root: string;
  /** The vgate version the runtime belongs to (package.json's version from source). */
  packageVersion: string;
  /** Embedded only: the files to extract, and their hash. */
  files?: Record<string, string>;
  hash?: string;
}

const MARKER = '.vgate-runtime.json';
const INSTALLED = '.vgate-installed';

function sourceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function vgateHome(): string {
  return resolve(process.env.VGATE_HOME ?? join(homedir(), '.cache', 'vgate'));
}

/** The runtime this process uses. */
export function currentRuntime(): Runtime {
  if (typeof VGATE_RUNTIME !== 'undefined') {
    const files = JSON.parse(VGATE_RUNTIME) as Record<string, string>;
    const hash = hashFiles(files);
    const { version } = JSON.parse(files['package.json'] ?? '{}') as { version?: string };
    const packageVersion = version ?? '0.0.0';
    return {
      mode: 'embedded',
      root: join(vgateHome(), `${packageVersion}-${hash.slice(0, 12)}`, 'runtime'),
      packageVersion,
      files,
      hash,
    };
  }
  const root = sourceRoot();
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
  return { mode: 'source', root, packageVersion: version ?? '0.0.0' };
}

export interface RuntimeState {
  /** The files are in place (always true from source). */
  extracted: boolean;
  /** node_modules is installed and `@vgate/framework` is linked. */
  installed: boolean;
}

export function runtimeState(runtime: Runtime): RuntimeState {
  const extracted =
    runtime.mode === 'source' ||
    (existsSync(join(runtime.root, MARKER)) &&
      (JSON.parse(readFileSync(join(runtime.root, MARKER), 'utf8')) as { hash?: string }).hash === runtime.hash);
  const linked = existsSync(join(runtime.root, 'node_modules', '@vgate', 'framework', 'config.ts'));
  const tools = ['playwright', 'tsx', 'task', 'tsc', 'eslint'].every((bin) =>
    existsSync(join(runtime.root, 'node_modules', '.bin', bin)),
  );
  const installed =
    extracted && linked && tools && (runtime.mode === 'source' || existsSync(join(runtime.root, INSTALLED)));
  return { extracted, installed };
}

/** Writes the embedded files to the cache. A no-op from source and when the cache already holds this build. */
export function extractRuntime(runtime: Runtime): void {
  if (runtime.mode === 'source' || !runtime.files) return;
  if (runtimeState(runtime).extracted) return;
  for (const [path, content] of Object.entries(runtime.files)) {
    const target = join(runtime.root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  writeFileSync(join(runtime.root, MARKER), `${JSON.stringify({ hash: runtime.hash }, null, 2)}\n`);
}

export interface Prepared {
  ok: boolean;
  /** What was done, for the caller's log. */
  actions: string[];
  /** Why it failed, with the install output's end. */
  error?: string;
}

/** Extracts and installs the runtime when needed. Installing runs `pnpm install --frozen-lockfile` once. */
export function ensureRuntime(runtime: Runtime, log: (line: string) => void = () => {}): Prepared {
  const actions: string[] = [];
  if (runtime.mode === 'embedded' && !runtimeState(runtime).extracted) {
    log(`Extracting the vgate runtime to ${runtime.root}`);
    extractRuntime(runtime);
    actions.push(`extracted ${runtime.root}`);
  }
  if (!runtimeState(runtime).installed) {
    log(`Installing the runtime's dependencies (pnpm install) in ${runtime.root}`);
    const run = capture('pnpm', ['install', '--frozen-lockfile'], runtime.root, 900_000, toolEnv());
    if (run.code !== 0) {
      return {
        ok: false,
        actions,
        error: run.missing
          ? 'pnpm is not installed (vgate doctor names the fix)'
          : `pnpm install failed in ${runtime.root}:\n${run.out.split('\n').slice(-15).join('\n')}`,
      };
    }
    if (runtime.mode === 'embedded') writeFileSync(join(runtime.root, INSTALLED), new Date().toISOString());
    actions.push(`installed ${join(runtime.root, 'node_modules')}`);
  }
  return { ok: true, actions };
}

const GENERATED = 'Generated by vgate on every run, from the vgate runtime; not part of the project (gitignored).';

/** The tsconfig a project's tests are checked with: the runtime's settings, over the project's services. */
export function projectTsconfig(runtime: Runtime): string {
  return `${JSON.stringify(
    {
      '//': GENERATED,
      extends: join(runtime.root, 'tsconfig.json'),
      compilerOptions: { types: ['node'] },
      include: ['*/*.ts', '*/support', '*/tests'],
      exclude: ['node_modules', '*/perf'],
    },
    null,
    2,
  )}\n`;
}

/**
 * `<servicesDir>/package.json`: makes the project's test files ES modules, as the framework's are. Without it, Node
 * and Playwright would load them as CommonJS, which cannot import the framework.
 */
export function projectPackageJson(): string {
  return `${JSON.stringify({ '//': GENERATED, private: true, type: 'module' }, null, 2)}\n`;
}

function isGenerated(file: string): boolean {
  return existsSync(file) && readFileSync(file, 'utf8').includes(GENERATED);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Wires a project to a runtime: `<servicesDir>/node_modules` -> the runtime's node_modules, and the generated
 * `<servicesDir>/tsconfig.json`. When the project is the runtime itself (this checkout), its own node_modules and
 * tsconfig.json apply: anything generated by an earlier binary run is removed so it cannot shadow them.
 */
export function linkProject(project: ProjectConfig, runtime: Runtime): Prepared {
  const actions: string[] = [];
  const link = join(project.servicesDir, 'node_modules');
  const target = join(runtime.root, 'node_modules');
  const generated: Array<[string, string]> = [
    [join(project.servicesDir, 'tsconfig.json'), projectTsconfig(runtime)],
    [join(project.servicesDir, 'package.json'), projectPackageJson()],
  ];

  if (resolve(project.root) === resolve(runtime.root)) {
    if (isSymlink(link)) {
      rmSync(link);
      actions.push(`removed ${link}`);
    }
    for (const [file] of generated) {
      if (isGenerated(file)) {
        rmSync(file);
        actions.push(`removed ${file}`);
      }
    }
    return { ok: true, actions };
  }

  mkdirSync(project.servicesDir, { recursive: true });
  if (existsSync(link) && !isSymlink(link))
    return {
      ok: false,
      actions,
      error: `${link} is a real directory: vgate links it to its runtime. Remove it (the project needs no node_modules).`,
    };
  if (!isSymlink(link) || readlinkSync(link) !== target) {
    if (isSymlink(link)) rmSync(link);
    symlinkSync(target, link, 'dir');
    actions.push(`linked ${link} -> ${target}`);
  }
  for (const [file, content] of generated) {
    if (existsSync(file) && !isGenerated(file))
      return {
        ok: false,
        actions,
        error: `${file} exists and was not generated by vgate: the tests run with the runtime's settings. Remove it.`,
      };
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) {
      writeFileSync(file, content);
      actions.push(`wrote ${file}`);
    }
  }
  return { ok: true, actions };
}

/**
 * The project may declare another package manager (`"packageManager": "bun@..."`, yarn, npm). vgate's own tools are
 * the runtime's, run with pnpm, so neither corepack nor pnpm may refuse them because of the project's choice: without
 * this, `pnpm` run anywhere under such a project answers "This project is configured to use bun" and the user would
 * have to add an .npmrc to their repository just for vgate.
 */
export const PACKAGE_MANAGER_ENV: Record<string, string> = {
  COREPACK_ENABLE_STRICT: '0',
  npm_config_package_manager_strict: 'false',
};

/** process.env with PACKAGE_MANAGER_ENV, for every program vgate starts. */
export function toolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...PACKAGE_MANAGER_ENV };
}

/** The environment every step and stack script gets: where the project, its services and its reports are. */
export function stepEnv(project: ProjectConfig, runtime: Runtime): Record<string, string> {
  return {
    ...PACKAGE_MANAGER_ENV,
    VGATE_PROJECT: project.root,
    VGATE_RUNTIME: runtime.root,
    VGATE_SERVICES_DIR: project.servicesDirName,
    VGATE_REPORTS: project.reportsDir,
    VGATE_STACK_LIB: join(runtime.root, 'framework', 'stack', 'lib.sh'),
  };
}

/**
 * The CI templates `vgate init --ci <kind>` copies into a project: source file under ci/<kind>/ -> path in the
 * project. A kind may also hold an init/ directory, copied at the same relative paths.
 */
export const CI_TARGETS: Record<string, Record<string, string>> = {
  github: {
    'vgate.yml': '.github/workflows/vgate.yml',
    // An example to merge into .github/CODEOWNERS by hand: init never edits a repository's ownership rules.
    'CODEOWNERS.example': '.github/CODEOWNERS.vgate.example',
  },
};

export function bundleCiTemplates(sourceRoot: string): Record<string, Record<string, string>> {
  const ci = join(sourceRoot, 'ci');
  const out: Record<string, Record<string, string>> = {};
  if (!existsSync(ci)) return out;
  for (const entry of readdirSync(ci, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files: Record<string, string> = {};
    for (const [source, target] of Object.entries(CI_TARGETS[entry.name] ?? {})) {
      const file = join(ci, entry.name, source);
      if (existsSync(file)) files[target] = readFileSync(file, 'utf8');
    }
    const dir = join(ci, entry.name, 'init');
    if (existsSync(dir)) for (const file of walk(dir, dir)) files[file] = readFileSync(join(dir, file), 'utf8');
    if (Object.keys(files).length > 0) out[entry.name] = files;
  }
  return out;
}

/** Set by `cli/build.ts`: `bundleCiTemplates()` as JSON. Absent when run from source. */
declare const VGATE_CI_TEMPLATES: string | undefined;

export function ciTemplates(): Record<string, Record<string, string>> {
  if (typeof VGATE_CI_TEMPLATES !== 'undefined')
    return JSON.parse(VGATE_CI_TEMPLATES) as Record<string, Record<string, string>>;
  return bundleCiTemplates(sourceRoot());
}

/** cli/build.ts's hook: the constants the binary embeds besides the skills and the version. */
export function buildDefines(root: string): Record<string, string> {
  return {
    VGATE_RUNTIME: JSON.stringify(bundleRuntime(root)),
    VGATE_CI_TEMPLATES: JSON.stringify(bundleCiTemplates(root)),
  };
}

/** Everything a command needs before it runs a step: the runtime installed, and the project linked to it. */
export function prepare(project: ProjectConfig, runtime: Runtime, live: boolean): Prepared {
  const log = live ? (line: string) => process.stderr.write(`${line}\n`) : () => {};
  const installed = ensureRuntime(runtime, log);
  if (!installed.ok) return installed;
  const linked = linkProject(project, runtime);
  for (const action of linked.actions) log(action);
  return { ok: linked.ok, actions: [...installed.actions, ...linked.actions], error: linked.error };
}

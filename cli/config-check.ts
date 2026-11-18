/**
 * `vgate config-check`: does every target environment provide the configuration the new code requires? The classic
 * failed deploy is a change that needs a new setting (`PAYMENTS_URL`) that nobody added to production: the code
 * passed every test, then crashed at start-up. A service declares the keys it needs in service.yaml
 * (`config.required`); vgate.yaml's `deploy.environments.<env>.config` names the files that list what each
 * environment provides: a dotenv file, Kubernetes ConfigMaps, Secrets and container `env`, or a plain key list.
 *
 * Only key names are read and reported; values are never printed or kept.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';
import type { ConfigFormat, ConfigSource, DeployEnvironment, ProjectConfig } from '../framework/project.ts';
import { selectEnvironments, serviceSources } from './compat.ts';
import { git } from './guard.ts';
import { CLI, EXIT, type Result } from './output.ts';
import { resolveService } from './project.ts';

export type ConfigState = 'complete' | 'missing' | 'unknown' | 'not-configured';

export interface ConfigResult {
  environment: string;
  state: ConfigState;
  required: string[];
  /** Required keys no source of the environment provides. */
  missing: string[];
  /** Of `missing`: keys this change newly requires (absent from the base's service.yaml). */
  newlyRequired: string[];
  /** Project-relative files read. */
  sources: string[];
  notes: string[];
}

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** `config.required` of a service.yaml: the keys the service cannot start without. */
export function requiredKeys(serviceYaml: string | undefined): string[] | { error: string } {
  if (serviceYaml === undefined) return [];
  const raw = parse(serviceYaml) as Record<string, unknown> | null;
  const config = raw?.config;
  if (config === undefined || config === null) return [];
  if (typeof config !== 'object' || Array.isArray(config))
    return { error: 'service.yaml: config must be { required: [KEY, ...] }' };
  const required = (config as Record<string, unknown>).required ?? [];
  if (!Array.isArray(required)) return { error: 'service.yaml: config.required must be a list of keys' };
  const bad = required.filter((key) => typeof key !== 'string' || !KEY.test(key));
  if (bad.length > 0) return { error: `service.yaml: config.required has keys that are not names: ${bad.join(', ')}` };
  return [...new Set(required as string[])];
}

/** dotenv: `KEY=value`, `export KEY=value`, comments; a quoted value may span lines. */
export function dotenvKeys(text: string): Set<string> {
  const keys = new Set<string>();
  let open: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (open) {
      if (line.includes(open)) open = undefined;
      continue;
    }
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    keys.add(match[1]);
    const value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.slice(1).indexOf(quote) === -1) open = quote;
  }
  return keys;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Kubernetes: keys of ConfigMap/Secret data, and the names of containers' `env` entries in any workload. */
export function k8sKeys(text: string): { keys: Set<string>; notes: string[] } {
  const keys = new Set<string>();
  const notes = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isObject(node)) return;
    for (const [field, value] of Object.entries(node)) {
      if (field === 'env' && Array.isArray(value)) {
        for (const entry of value) if (isObject(entry) && typeof entry.name === 'string') keys.add(entry.name);
      } else if (field === 'envFrom' && Array.isArray(value) && value.length > 0) {
        notes.add('envFrom references are not followed: list those keys in a ConfigMap or Secret file as well');
      }
      walk(value);
    }
  };
  for (const doc of parseAllDocuments(text)) {
    const value = doc.toJS() as unknown;
    if (!isObject(value)) continue;
    if (value.kind === 'ConfigMap' || value.kind === 'Secret') {
      for (const field of ['data', 'stringData', 'binaryData'])
        if (isObject(value[field])) for (const key of Object.keys(value[field])) keys.add(key);
    }
    walk(value.spec);
  }
  return { keys, notes: [...notes] };
}

/** A plain key list: a YAML/JSON list of names, or a mapping whose keys are the names. */
export function listKeys(text: string): Set<string> {
  const value = parse(text) as unknown;
  if (Array.isArray(value)) return new Set(value.filter((v): v is string => typeof v === 'string'));
  if (isObject(value)) return new Set(Object.keys(value));
  return new Set();
}

/** The format of a source: given, or guessed (`.env` names are dotenv; YAML with `kind:` is Kubernetes). */
export function formatOf(source: ConfigSource, text: string): ConfigFormat {
  if (source.format) return source.format;
  if (/(^|\.)env($|\.)/.test(basename(source.file))) return 'dotenv';
  try {
    const kinds = parseAllDocuments(text).map((doc) => doc.toJS() as unknown);
    if (kinds.some((doc) => isObject(doc) && typeof doc.kind === 'string' && typeof doc.apiVersion === 'string'))
      return 'k8s';
  } catch {
    // Not YAML: a key list will say so below.
  }
  return 'keys';
}

/** Every key the sources of one environment provide. */
export function providedKeys(
  project: ProjectConfig,
  sources: ConfigSource[],
): { keys: Set<string>; read: string[]; notes: string[]; unreadable: string[] } {
  const keys = new Set<string>();
  const read: string[] = [];
  const notes: string[] = [];
  const unreadable: string[] = [];
  for (const source of sources) {
    const file = join(project.root, source.file);
    if (!existsSync(file)) {
      unreadable.push(`${source.file} does not exist`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    try {
      const format = formatOf(source, text);
      const found =
        format === 'dotenv' ? dotenvKeys(text) : format === 'k8s' ? k8sKeys(text) : { keys: listKeys(text), notes: [] };
      const set = found instanceof Set ? found : found.keys;
      if (!(found instanceof Set)) notes.push(...found.notes.map((n) => `${source.file}: ${n}`));
      for (const key of set) keys.add(key);
      read.push(`${source.file} (${format})`);
    } catch (error) {
      unreadable.push(`${source.file} does not parse: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  return { keys, read, notes, unreadable };
}

/** Required keys at a git ref (the base of the change), to tell what this change newly requires. */
function requiredAt(top: string, ref: string, serviceYamlPath: string): string[] {
  const run = git(top, ['show', `${ref}:${serviceYamlPath}`]);
  if (run.code !== 0) return [];
  const keys = requiredKeys(run.out);
  return Array.isArray(keys) ? keys : [];
}

export function configFor(
  project: ProjectConfig,
  service: string,
  env: DeployEnvironment,
  base?: string,
): ConfigResult {
  const result: ConfigResult = {
    environment: env.name,
    state: 'unknown',
    required: [],
    missing: [],
    newlyRequired: [],
    sources: [],
    notes: [],
  };
  const sources = serviceSources(project, service);
  if ('error' in sources) return { ...result, notes: [sources.error] };
  const required = requiredKeys(sources.serviceYaml);
  if (!Array.isArray(required)) return { ...result, notes: [required.error] };
  if (required.length === 0)
    return {
      ...result,
      state: 'not-configured',
      notes: [`${service}'s service.yaml declares no config.required: nothing to check`],
    };
  if (env.config.length === 0)
    return {
      ...result,
      state: 'not-configured',
      required,
      notes: [`deploy.environments.${env.name} names no config source`],
    };
  const provided = providedKeys(project, env.config);
  if (provided.unreadable.length > 0)
    return {
      ...result,
      required,
      sources: provided.read,
      notes: [...provided.unreadable, ...provided.notes],
    };
  const missing = required.filter((key) => !provided.keys.has(key));
  const before = base ? new Set(requiredAt(sources.top, base, sources.serviceYamlPath)) : undefined;
  return {
    ...result,
    state: missing.length > 0 ? 'missing' : 'complete',
    required,
    missing,
    newlyRequired: before ? missing.filter((key) => !before.has(key)) : [],
    sources: provided.read,
    notes: provided.notes,
  };
}

/** One line a non-engineer understands: which keys, whether this change introduced the need, and the consequence. */
export function describeMissing(service: string, r: ConfigResult): string {
  const newly = r.missing.filter((k) => r.newlyRequired.includes(k));
  const older = r.missing.filter((k) => !r.newlyRequired.includes(k));
  const where = r.sources.map((s) => s.replace(/ \(.*\)$/, '')).join(', ');
  const parts: string[] = [];
  if (newly.length > 0)
    parts.push(
      `this change newly requires ${newly.join(', ')}, which ${r.environment}'s config (${where}) does not have`,
    );
  if (older.length > 0)
    parts.push(`${older.join(', ')} ${older.length === 1 ? 'is' : 'are'} required but missing from ${where}`);
  return `${service} → ${r.environment}: ${parts.join('; ')}. Deploying would fail at start-up; add the key${r.missing.length === 1 ? '' : 's'} to the environment (and its config file) first`;
}

export function configCheck(
  project: ProjectConfig,
  options: { service: string | undefined; environment: string | undefined; base: string | undefined },
): Result {
  const service = resolveService(project.root, options.service);
  if (!project.deploy)
    return {
      command: 'config-check',
      ok: true,
      exitCode: EXIT.ok,
      summary: 'Not configured: vgate.yaml has no deploy block, so environment configuration is not checked',
      data: { service, configured: false, environments: [] },
      next: [],
    };
  const results = selectEnvironments(project, options.environment).map((env) =>
    configFor(project, service, env, options.base),
  );
  const missing = results.filter((r) => r.state === 'missing');
  const unknown = results.filter((r) => r.state === 'unknown');
  const exitCode = missing.length > 0 ? EXIT.failed : unknown.length > 0 ? EXIT.notReady : EXIT.ok;
  return {
    command: 'config-check',
    ok: exitCode === EXIT.ok,
    exitCode,
    summary:
      missing.length > 0
        ? `MISSING CONFIG: ${describeMissing(service, missing[0])}`
        : unknown.length > 0
          ? `Not checked for ${unknown.map((r) => r.environment).join(', ')}: ${unknown[0].notes[0]}`
          : `Config complete for ${results.map((r) => `${r.environment} (${r.state})`).join(', ')}`,
    data: { service, configured: true, environments: results },
    next:
      unknown.length > 0 ? [`${CLI} config-check --service ${service} --environment ${unknown[0].environment}`] : [],
    text: results.flatMap((r) => [
      `${r.state.padEnd(14)} ${r.environment}  ${r.required.length} required, ${r.missing.length} missing`,
      ...r.missing.map((k) => `  MISSING ${k}${r.newlyRequired.includes(k) ? ' (newly required by this change)' : ''}`),
      ...r.notes.map((n) => `  note: ${n}`),
    ]),
  };
}

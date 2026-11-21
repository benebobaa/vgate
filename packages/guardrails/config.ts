import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { expandPresets, type RuleFixtures } from './presets.ts';

export const GUARDRAILS_FILE = 'guardrails.yaml';
export const RATCHET_FILE = '.vgate-ratchet.json';
export const DEFAULT_RULE_TABLE_FILE = 'AGENTS.md';
export const DEFAULT_IGNORE: readonly string[] = ['node_modules/**', 'dist/**', '.git/**', 'reports/**', 'coverage/**'];

export interface BoundaryRule {
  id: string;
  from: string[];
  disallowImports: string[];
  replaceWith: string;
  reason?: string;
  fixtures?: RuleFixtures;
}

export interface BannedPatternRule {
  id: string;
  pattern: string;
  flags?: string;
  files?: string[];
  exclude?: string[];
  replaceWith: string;
  reason?: string;
  severity?: 'error' | 'warn';
  ratcheted?: boolean;
  fixtures?: RuleFixtures;
}

export interface CommentsConfig {
  maxRatio?: number;
  maxInlinePerFile?: number;
  files?: string[];
  exclude?: string[];
  ignoreLicenseHeaders?: boolean;
  ignoreDocComments?: boolean;
  ratcheted?: boolean;
}

export interface NativeLinterRule {
  id: string;
  command: string;
  args?: string[];
  configFiles?: string[];
  reason?: string;
}

export interface RuleTableConfig {
  file?: string;
  requireEnforcer?: boolean;
}

export interface GuardrailsConfig {
  presets?: string[];
  boundaries: BoundaryRule[];
  bannedPatterns: BannedPatternRule[];
  comments?: CommentsConfig;
  nativeLinters: NativeLinterRule[];
  ruleTable?: RuleTableConfig;
  ratchetFile: string;
  ignore: string[];
}

type RawObject = Record<string, unknown>;

function isObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

function requireNonEmptyString(value: unknown, label: string, file: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(file, `${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string, file: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    fail(file, `${label} must be a string`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string, file: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    fail(file, `${label} must be a boolean`);
  }
  return value;
}

function stringList(value: unknown, label: string, file: string, required = false): string[] | undefined {
  if (value === undefined || value === null) {
    if (required) fail(file, `${label} must be a non-empty array of strings`);
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(file, `${label} must be an array of strings`);
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry: unknown = value[i];
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      fail(file, `${label}[${i}] must be a non-empty string`);
    }
    out.push(entry);
  }
  if (required && out.length === 0) {
    fail(file, `${label} must contain at least one entry`);
  }
  return out;
}

function parseFixtures(raw: unknown, prefix: string, file: string): RuleFixtures | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) fail(file, `${prefix}.fixtures must be an object with bad/good arrays`);
  const parseList = (listRaw: unknown, kind: 'bad' | 'good') => {
    if (listRaw === undefined || listRaw === null) return [];
    if (!Array.isArray(listRaw)) fail(file, `${prefix}.fixtures.${kind} must be an array`);
    return listRaw.map((entry, idx) => {
      if (typeof entry === 'string') return { code: entry };
      if (!isObject(entry)) fail(file, `${prefix}.fixtures.${kind}[${idx}] must be an object or string`);
      const code = requireNonEmptyString(entry.code, `${prefix}.fixtures.${kind}[${idx}].code`, file);
      const fxFile = optionalString(entry.file, `${prefix}.fixtures.${kind}[${idx}].file`, file);
      const expectMatch = optionalString(entry.expectMatch, `${prefix}.fixtures.${kind}[${idx}].expectMatch`, file);
      return {
        code,
        ...(fxFile !== undefined ? { file: fxFile } : {}),
        ...(expectMatch !== undefined ? { expectMatch } : {}),
      };
    });
  };
  return { bad: parseList(raw.bad, 'bad'), good: parseList(raw.good, 'good') };
}

function parseBoundaries(raw: unknown, file: string): BoundaryRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(file, 'boundaries must be an array');
  const seen = new Set<string>();
  const out: BoundaryRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    const prefix = `boundaries[${i}]`;
    if (!isObject(item)) fail(file, `${prefix} must be an object`);
    const id = requireNonEmptyString(item.id, `${prefix}.id`, file);
    if (seen.has(id)) fail(file, `duplicate boundary rule id "${id}"`);
    seen.add(id);
    const from = stringList(item.from, `${prefix}.from`, file, true)!;
    const disallowImports = stringList(item.disallowImports, `${prefix}.disallowImports`, file, true)!;
    const replaceWith = requireNonEmptyString(item.replaceWith, `${prefix}.replaceWith`, file);
    const reason = optionalString(item.reason, `${prefix}.reason`, file);
    const fixtures = parseFixtures(item.fixtures, prefix, file);
    out.push({
      id,
      from,
      disallowImports,
      replaceWith,
      ...(reason !== undefined ? { reason } : {}),
      ...(fixtures !== undefined ? { fixtures } : {}),
    });
  }
  return out;
}

function parseBannedPatterns(raw: unknown, file: string): BannedPatternRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(file, 'bannedPatterns must be an array');
  const seen = new Set<string>();
  const out: BannedPatternRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    const prefix = `bannedPatterns[${i}]`;
    if (!isObject(item)) fail(file, `${prefix} must be an object`);
    const id = requireNonEmptyString(item.id, `${prefix}.id`, file);
    if (seen.has(id)) fail(file, `duplicate bannedPattern rule id "${id}"`);
    seen.add(id);
    const pattern = requireNonEmptyString(item.pattern, `${prefix}.pattern`, file);
    const flags = optionalString(item.flags, `${prefix}.flags`, file);
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(file, `${prefix}.pattern is not a valid RegExp: ${detail}`);
    }
    const files = stringList(item.files, `${prefix}.files`, file);
    const exclude = stringList(item.exclude, `${prefix}.exclude`, file);
    const replaceWith = requireNonEmptyString(item.replaceWith, `${prefix}.replaceWith`, file);
    const reason = optionalString(item.reason, `${prefix}.reason`, file);
    let severity: 'error' | 'warn' | undefined;
    if (item.severity !== undefined && item.severity !== null) {
      if (item.severity !== 'error' && item.severity !== 'warn') {
        fail(file, `${prefix}.severity must be "error" or "warn"`);
      }
      severity = item.severity;
    }
    const ratcheted = optionalBoolean(item.ratcheted, `${prefix}.ratcheted`, file);
    const fixtures = parseFixtures(item.fixtures, prefix, file);
    out.push({
      id,
      pattern,
      ...(flags !== undefined ? { flags } : {}),
      ...(files !== undefined ? { files } : {}),
      ...(exclude !== undefined ? { exclude } : {}),
      replaceWith,
      ...(reason !== undefined ? { reason } : {}),
      ...(severity !== undefined ? { severity } : {}),
      ...(ratcheted !== undefined ? { ratcheted } : {}),
      ...(fixtures !== undefined ? { fixtures } : {}),
    });
  }
  return out;
}

function parseComments(raw: unknown, file: string): CommentsConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) fail(file, 'comments must be an object');
  let maxRatio: number | undefined;
  if (raw.maxRatio !== undefined && raw.maxRatio !== null) {
    if (typeof raw.maxRatio !== 'number' || !Number.isFinite(raw.maxRatio) || raw.maxRatio < 0 || raw.maxRatio > 1) {
      fail(file, 'comments.maxRatio must be a number between 0 and 1');
    }
    maxRatio = raw.maxRatio;
  }
  let maxInlinePerFile: number | undefined;
  if (raw.maxInlinePerFile !== undefined && raw.maxInlinePerFile !== null) {
    if (
      typeof raw.maxInlinePerFile !== 'number' ||
      !Number.isInteger(raw.maxInlinePerFile) ||
      raw.maxInlinePerFile < 0
    ) {
      fail(file, 'comments.maxInlinePerFile must be a non-negative integer');
    }
    maxInlinePerFile = raw.maxInlinePerFile;
  }
  const files = stringList(raw.files, 'comments.files', file);
  const exclude = stringList(raw.exclude, 'comments.exclude', file);
  const ignoreLicenseHeaders = optionalBoolean(raw.ignoreLicenseHeaders, 'comments.ignoreLicenseHeaders', file);
  const ignoreDocComments = optionalBoolean(raw.ignoreDocComments, 'comments.ignoreDocComments', file);
  const ratcheted = optionalBoolean(raw.ratcheted, 'comments.ratcheted', file);
  return {
    ...(maxRatio !== undefined ? { maxRatio } : {}),
    ...(maxInlinePerFile !== undefined ? { maxInlinePerFile } : {}),
    ...(files !== undefined ? { files } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
    ...(ignoreLicenseHeaders !== undefined ? { ignoreLicenseHeaders } : {}),
    ...(ignoreDocComments !== undefined ? { ignoreDocComments } : {}),
    ...(ratcheted !== undefined ? { ratcheted } : {}),
  };
}

function parseNativeLinters(raw: unknown, file: string): NativeLinterRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(file, 'nativeLinters must be an array');
  const seen = new Set<string>();
  const out: NativeLinterRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    const prefix = `nativeLinters[${i}]`;
    if (!isObject(item)) fail(file, `${prefix} must be an object`);
    const id = requireNonEmptyString(item.id, `${prefix}.id`, file);
    if (seen.has(id)) fail(file, `duplicate nativeLinter id "${id}"`);
    seen.add(id);
    const command = requireNonEmptyString(item.command, `${prefix}.command`, file);
    let args: string[] | undefined;
    if (item.args !== undefined && item.args !== null) {
      if (!Array.isArray(item.args) || !item.args.every((entry) => typeof entry === 'string')) {
        fail(file, `${prefix}.args must be an array of strings`);
      }
      args = [...item.args];
    }
    const configFiles = stringList(item.configFiles, `${prefix}.configFiles`, file);
    const reason = optionalString(item.reason, `${prefix}.reason`, file);
    out.push({
      id,
      command,
      ...(args !== undefined ? { args } : {}),
      ...(configFiles !== undefined ? { configFiles } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return out;
}

function parseRuleTable(raw: unknown, file: string): RuleTableConfig {
  if (raw === undefined || raw === null) {
    return { file: DEFAULT_RULE_TABLE_FILE };
  }
  if (!isObject(raw)) fail(file, 'ruleTable must be an object');
  const tableFile = optionalString(raw.file, 'ruleTable.file', file) ?? DEFAULT_RULE_TABLE_FILE;
  if (tableFile.trim().length === 0) fail(file, 'ruleTable.file must be a non-empty string');
  const requireEnforcer = optionalBoolean(raw.requireEnforcer, 'ruleTable.requireEnforcer', file);
  return {
    file: tableFile,
    ...(requireEnforcer !== undefined ? { requireEnforcer } : {}),
  };
}

export function parseGuardrails(yamlText: string, file: string = GUARDRAILS_FILE): GuardrailsConfig {
  let doc: unknown;
  try {
    doc = parse(yamlText) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(file, `invalid YAML: ${detail}`);
  }
  if (doc === undefined || doc === null) {
    return {
      boundaries: [],
      bannedPatterns: [],
      nativeLinters: [],
      ruleTable: { file: DEFAULT_RULE_TABLE_FILE },
      ratchetFile: RATCHET_FILE,
      ignore: [...DEFAULT_IGNORE],
    };
  }
  if (!isObject(doc)) {
    fail(file, 'guardrails config must be a YAML mapping');
  }

  const presets = stringList(doc.presets, 'presets', file) ?? [];
  const boundaries = parseBoundaries(doc.boundaries, file);
  const bannedPatterns = parseBannedPatterns(doc.bannedPatterns, file);
  const comments = parseComments(doc.comments, file);
  const nativeLinters = parseNativeLinters(doc.nativeLinters, file);
  const ruleTable = parseRuleTable(doc.ruleTable, file);
  const ratchetFile = optionalString(doc.ratchetFile, 'ratchetFile', file) ?? RATCHET_FILE;
  if (ratchetFile.trim().length === 0) fail(file, 'ratchetFile must be a non-empty string');
  const ignore = stringList(doc.ignore, 'ignore', file) ?? [...DEFAULT_IGNORE];

  const base: GuardrailsConfig = {
    ...(presets.length > 0 ? { presets } : {}),
    boundaries,
    bannedPatterns,
    ...(comments !== undefined ? { comments } : {}),
    nativeLinters,
    ruleTable,
    ratchetFile,
    ignore,
  };
  return presets.length > 0 ? expandPresets(base, presets) : base;
}

export function loadGuardrails(root: string): GuardrailsConfig | undefined {
  const path = join(root, GUARDRAILS_FILE);
  if (!existsSync(path)) return undefined;
  return parseGuardrails(readFileSync(path, 'utf8'), GUARDRAILS_FILE);
}

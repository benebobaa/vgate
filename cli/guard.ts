/**
 * `guard`: the gate checks the code against the expectations; the guard checks the expectations themselves. It
 * compares a base git ref with the working tree and decides whether a merge request may merge on a green gate alone
 * (`auto`) or changes what the gate verifies in a way that needs a human (`needs-human`): a breaking contract, a
 * removed scenario or assertion, a loosened rule, a new known failure, or an edit to the machinery that judges.
 *
 * Each rule is a pure function over base and head text, so it is tested without git; `guard` only gathers the files.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { OpenApiContract, type DocumentedPair } from '../framework/http/openapi.ts';
import { readProject } from '../framework/project.ts';
import { CLI, EXIT, UsageError, type Result } from './output.ts';

export const GUARD_FILE = 'reports/guard.json';

export type Rule =
  | 'contract-breaking'
  | 'plan-weakened'
  | 'config-loosened'
  | 'known-failure-added'
  | 'tests-weakened'
  | 'machinery-changed';

export interface Finding {
  rule: Rule;
  /** Project-relative path. */
  file: string;
  detail: string;
}

/** What a rule returns: weakenings need a human; `info` lists the changes it judged harmless (additive). */
export interface RuleOutcome {
  findings: Finding[];
  info: Finding[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A YAML or JSON value as text: strings as they are, a YAML date as YYYY-MM-DD, anything else as JSON. */
function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function yaml(text: string | undefined): unknown {
  return text === undefined ? undefined : (parse(text) as unknown);
}

function outcome(): RuleOutcome {
  return { findings: [], info: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// 1. contract-breaking

/** Code pattern and success code of a service.yaml's envelope: they decide which (status, code) pairs exist. */
function envelopeOf(serviceYaml: string | undefined): { codePattern?: string; successCode?: string } {
  const envelope = at(yaml(serviceYaml), 'rules', 'envelope');
  if (!isObject(envelope)) return {};
  return {
    codePattern: typeof envelope.codePattern === 'string' ? envelope.codePattern : undefined,
    successCode: typeof envelope.successCode === 'string' ? envelope.successCode : undefined,
  };
}

/** A schema node's type, as compared between base and head. */
function typeOf(node: Json): string {
  if (Array.isArray(node.type)) return list(node.type).map(scalar).sort().join('|');
  if (typeof node.type === 'string') return node.format ? `${node.type}(${scalar(node.format)})` : node.type;
  if (isObject(node.properties)) return 'object';
  if (node.items !== undefined) return 'array';
  return 'any';
}

interface Field {
  type: string;
  /** Listed in its parent object's `required` (always true for the root). */
  required: boolean;
}

function resolveRef(spec: Json, node: unknown, seen: Set<string>): { node: unknown; cycle: boolean } {
  let current = node;
  for (let hops = 0; isObject(current) && typeof current.$ref === 'string' && hops < 20; hops++) {
    const ref = current.$ref;
    if (seen.has(ref)) return { node: current, cycle: true };
    seen.add(ref);
    if (!ref.startsWith('#/')) return { node: {}, cycle: false };
    current = ref
      .slice(2)
      .split('/')
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<unknown>((at, part) => (isObject(at) ? at[part] : undefined), spec);
  }
  return { node: current, cycle: false };
}

/**
 * Every property of a schema, flattened to a path (`data.items[].name`), with `$ref`s, `allOf` and the branches of
 * `oneOf`/`anyOf` merged. A recursive schema stops at its first repetition.
 */
export function flattenSchema(spec: Json, schema: unknown): Map<string, Field> {
  const out = new Map<string, Field>();
  const walk = (raw: unknown, path: string, required: boolean, seen: Set<string>, depth: number) => {
    if (depth > 12) return;
    const { node, cycle } = resolveRef(spec, raw, new Set(seen));
    if (!isObject(node)) return;
    const refs = new Set(seen);
    if (isObject(raw) && typeof raw.$ref === 'string') refs.add(raw.$ref);
    if (cycle) {
      out.set(path, { type: 'recursive', required });
      return;
    }
    const branches = [node.allOf, node.oneOf, node.anyOf].flatMap(list);
    const own = typeOf(node);
    if (!out.has(path) || own !== 'any') out.set(path, { type: own, required });
    for (const branch of branches) walk(branch, path, required, refs, depth + 1);
    const requiredNames = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
    if (isObject(node.properties)) {
      for (const [name, property] of Object.entries(node.properties)) {
        walk(property, path === '' ? name : `${path}.${name}`, requiredNames.has(name), refs, depth + 1);
      }
    }
    if (node.items !== undefined) walk(node.items, `${path}[]`, true, refs, depth + 1);
  };
  walk(schema, '', true, new Set(), 0);
  return out;
}

function mediaSchema(spec: Json, content: unknown): unknown {
  const { node } = resolveRef(spec, content, new Set());
  if (!isObject(node)) return undefined;
  const media = node['application/json'] ?? node['*/*'] ?? Object.values(node)[0];
  return isObject(media) ? media.schema : undefined;
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

interface RawOperation {
  key: string;
  op: Json;
  pathItem: Json;
}

function rawOperations(spec: Json): Map<string, RawOperation> {
  const out = new Map<string, RawOperation>();
  for (const [path, item] of Object.entries(isObject(spec.paths) ? spec.paths : {})) {
    if (!isObject(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (isObject(op))
        out.set(`${method.toUpperCase()} ${path}`, { key: `${method.toUpperCase()} ${path}`, op, pathItem: item });
    }
  }
  return out;
}

function responseSchema(spec: Json, op: Json, status: string): unknown {
  const responses = isObject(op.responses) ? op.responses : {};
  const { node } = resolveRef(spec, responses[status], new Set());
  return isObject(node) ? mediaSchema(spec, node.content) : undefined;
}

/** `in:name` -> required, for an operation's parameters and its path item's. */
function parameters(spec: Json, raw: RawOperation): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const all = [raw.pathItem.parameters, raw.op.parameters].flatMap(list);
  for (const entry of all) {
    const { node } = resolveRef(spec, entry, new Set());
    if (isObject(node) && typeof node.name === 'string')
      out.set(`${scalar(node.in)}:${node.name}`, node.required === true || node.in === 'path');
  }
  return out;
}

function attempt<T>(run: () => T): T | string {
  try {
    return run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function pairKey(pair: { status: string; code: string | null }): string {
  return pair.code === null ? pair.status : `${pair.status} ${pair.code}`;
}

/**
 * Breaking contract changes: an operation or a documented (status, code) removed, a response property removed or
 * retyped, a request property or parameter newly required. Additions are info.
 */
export function contractRule(
  file: string,
  base: string | undefined,
  head: string | undefined,
  baseServiceYaml?: string,
  headServiceYaml?: string,
): RuleOutcome {
  const result = outcome();
  const find = (detail: string) => result.findings.push({ rule: 'contract-breaking', file, detail });
  const note = (detail: string) => result.info.push({ rule: 'contract-breaking', file, detail });
  if (base === undefined && head === undefined) return result;
  if (base === undefined) {
    note('new contract (no base version)');
    return result;
  }
  if (head === undefined) {
    find('the contract was deleted');
    return result;
  }
  const baseSpec = yaml(base);
  const headSpec = yaml(head);
  if (!isObject(baseSpec) || !isObject(headSpec)) {
    find('the contract does not parse as an object');
    return result;
  }
  const baseOps = rawOperations(baseSpec);
  const headOps = rawOperations(headSpec);

  for (const key of baseOps.keys()) if (!headOps.has(key)) find(`operation ${key} removed`);
  for (const key of headOps.keys()) if (!baseOps.has(key)) note(`operation ${key} added`);

  // The same (operation, status, code) pairs the coverage gate demands, from the same loader.
  const pairs = (spec: Json, serviceYaml: string | undefined): DocumentedPair[] | string =>
    attempt(() => new OpenApiContract(spec, envelopeOf(serviceYaml)).documentedPairs());
  const basePairList = pairs(baseSpec, baseServiceYaml);
  const headPairList = pairs(headSpec, headServiceYaml);
  if (typeof headPairList === 'string') find(`the contract does not load: ${headPairList}`);
  if (typeof basePairList === 'string') note(`the base contract did not load: ${basePairList}`);
  if (typeof basePairList !== 'string' && typeof headPairList !== 'string') {
    const label = (p: DocumentedPair) => `${p.operation} ${pairKey(p)}`;
    const headPairs = new Set(headPairList.map(label));
    const basePairs = new Set(basePairList.map(label));
    for (const pair of basePairList) {
      if (headOps.has(pair.operation) && !headPairs.has(label(pair)))
        find(`documented response ${pair.operation} -> ${pairKey(pair)} removed`);
    }
    for (const pair of headPairList) {
      if (baseOps.has(pair.operation) && !basePairs.has(label(pair)))
        note(`documented response ${pair.operation} -> ${pairKey(pair)} added`);
    }
  }

  for (const [key, baseOp] of baseOps) {
    const headOp = headOps.get(key);
    if (!headOp) continue;

    const baseResponses = isObject(baseOp.op.responses) ? Object.keys(baseOp.op.responses) : [];
    const headResponses = isObject(headOp.op.responses) ? headOp.op.responses : {};
    for (const status of baseResponses) {
      // A removed status is already a removed documented response.
      if (!(status in headResponses)) continue;
      const before = flattenSchema(baseSpec, responseSchema(baseSpec, baseOp.op, status));
      const after = flattenSchema(headSpec, responseSchema(headSpec, headOp.op, status));
      if (before.size > 0 && after.size === 0) {
        find(`${key} -> ${status}: response schema removed`);
        continue;
      }
      for (const [path, field] of before) {
        const now = after.get(path);
        const where = path === '' ? 'the body' : `property ${path}`;
        if (!now) find(`${key} -> ${status}: response ${where} removed`);
        else if (now.type !== field.type && field.type !== 'any')
          find(`${key} -> ${status}: response ${where} changed type ${field.type} -> ${now.type}`);
      }
      for (const path of after.keys()) {
        if (!before.has(path)) note(`${key} -> ${status}: response property ${path} added`);
      }
    }

    const baseBody = resolveRef(baseSpec, baseOp.op.requestBody, new Set()).node;
    const headBody = resolveRef(headSpec, headOp.op.requestBody, new Set()).node;
    const bodyRequired = (body: unknown) => isObject(body) && body.required === true;
    if (bodyRequired(headBody) && !bodyRequired(baseBody)) find(`${key}: request body newly required`);
    const beforeReq = flattenSchema(baseSpec, isObject(baseBody) ? mediaSchema(baseSpec, baseBody.content) : undefined);
    const afterReq = flattenSchema(headSpec, isObject(headBody) ? mediaSchema(headSpec, headBody.content) : undefined);
    for (const [path, field] of afterReq) {
      if (path === '' || !field.required) continue;
      const was = beforeReq.get(path);
      if (!was) find(`${key}: new required request property ${path}`);
      else if (!was.required) find(`${key}: request property ${path} newly required`);
    }

    const beforeParams = parameters(baseSpec, baseOp);
    for (const [name, required] of parameters(headSpec, headOp)) {
      if (!required) continue;
      const was = beforeParams.get(name);
      if (was === undefined) find(`${key}: new required parameter ${name}`);
      else if (!was) find(`${key}: parameter ${name} newly required`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// 2. plan-weakened

/** Every scenario id anywhere in the plan (per operation and cross-cutting sections such as `auth`). */
function scenarioIds(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => scenarioIds(item, out));
  else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'scenarios' && Array.isArray(value)) {
        for (const scenario of value) if (isObject(scenario) && typeof scenario.id === 'string') out.add(scenario.id);
      }
      scenarioIds(value, out);
    }
  }
  return out;
}

/** Every `excluded` entry, keyed with the operation it sits under. */
function exclusions(node: unknown, operation = '*', out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(node)) node.forEach((item) => exclusions(item, operation, out));
  else if (isObject(node)) {
    const here = typeof node.operation === 'string' ? node.operation : operation;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'excluded' && Array.isArray(value)) {
        for (const entry of value) {
          const status = isObject(entry) && entry.status !== undefined ? scalar(entry.status) : '*';
          const code = isObject(entry) && entry.code !== undefined ? scalar(entry.code) : '';
          out.set(`${here}|${status}|${code}`, `${here} ${status} ${code}`.trim());
        }
      } else exclusions(value, here, out);
    }
  }
  return out;
}

/** A scenario removed from the plan, or a documented response newly excluded from it. */
export function planRule(file: string, base: string | undefined, head: string | undefined): RuleOutcome {
  const result = outcome();
  if (base === undefined) {
    if (head !== undefined) result.info.push({ rule: 'plan-weakened', file, detail: 'new plan (no base version)' });
    return result;
  }
  if (head === undefined) {
    result.findings.push({ rule: 'plan-weakened', file, detail: 'the plan was deleted' });
    return result;
  }
  const before = scenarioIds(yaml(base));
  const after = scenarioIds(yaml(head));
  for (const id of before)
    if (!after.has(id)) result.findings.push({ rule: 'plan-weakened', file, detail: `scenario ${id} removed` });
  for (const id of after)
    if (!before.has(id)) result.info.push({ rule: 'plan-weakened', file, detail: `scenario ${id} added` });
  const baseExcluded = exclusions(yaml(base));
  for (const [key, label] of exclusions(yaml(head))) {
    if (!baseExcluded.has(key)) result.findings.push({ rule: 'plan-weakened', file, detail: `new exclusion ${label}` });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. config-loosened

function at(node: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((current, key) => (isObject(current) ? current[key] : undefined), node);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${key}:${stable(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** `group header` -> expected value, header names lower-cased (they are case-insensitive). */
function headerRules(headers: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const add = (group: string, rules: unknown) => {
    if (!isObject(rules)) return;
    for (const [name, value] of Object.entries(rules)) out.set(`${group} ${name.toLowerCase()}`, scalar(value));
  };
  add('always', at(headers, 'always'));
  add('withBody', at(headers, 'withBody'));
  add('cors', at(headers, 'cors'));
  const onStatus = at(headers, 'onStatus');
  if (isObject(onStatus)) for (const [status, rules] of Object.entries(onStatus)) add(`onStatus.${status}`, rules);
  return out;
}

/** service.yaml rules and exclusions that let the gate accept more than before. */
export function configRule(file: string, base: string | undefined, head: string | undefined): RuleOutcome {
  const result = outcome();
  const find = (detail: string) => result.findings.push({ rule: 'config-loosened', file, detail });
  if (base === undefined) {
    if (head !== undefined)
      result.info.push({ rule: 'config-loosened', file, detail: 'new service.yaml (no base version)' });
    return result;
  }
  if (head === undefined) {
    find('service.yaml was deleted');
    return result;
  }
  const before = yaml(base);
  const after = yaml(head);

  const baseExcludes = new Set(list(at(before, 'coverage', 'exclude')).map(stable));
  for (const entry of list(at(after, 'coverage', 'exclude'))) {
    if (!baseExcludes.has(stable(entry))) find(`coverage.exclude added: ${stable(entry)}`);
  }
  if (
    at(before, 'rules', 'strictResponseProperties') === true &&
    at(after, 'rules', 'strictResponseProperties') !== true
  )
    find(`rules.strictResponseProperties turned off (${scalar(at(after, 'rules', 'strictResponseProperties'))})`);
  if (
    at(before, 'rules', 'optionalPropertiesNullable') !== true &&
    at(after, 'rules', 'optionalPropertiesNullable') === true
  )
    find('rules.optionalPropertiesNullable turned on');
  const offsetBefore = at(before, 'rules', 'datetimeOffset');
  const offsetAfter = at(after, 'rules', 'datetimeOffset');
  if (offsetBefore !== undefined && offsetAfter === undefined)
    find(`rules.datetimeOffset removed (was ${scalar(offsetBefore)})`);
  else if (offsetBefore !== undefined && offsetAfter !== offsetBefore)
    result.info.push({
      rule: 'config-loosened',
      file,
      detail: `rules.datetimeOffset ${scalar(offsetBefore)} -> ${scalar(offsetAfter)}`,
    });
  if (at(before, 'rules', 'envelope') !== undefined && at(after, 'rules', 'envelope') === undefined)
    find('rules.envelope removed');

  const baseHeaders = headerRules(at(before, 'rules', 'headers'));
  const headHeaders = headerRules(at(after, 'rules', 'headers'));
  for (const [key, value] of baseHeaders) {
    const now = headHeaders.get(key);
    // The guard cannot tell whether a changed expectation (a regex, a template) is looser: a human decides.
    if (now === undefined) find(`header rule ${key} removed (was ${value})`);
    else if (now !== value) find(`header rule ${key} changed ${value} -> ${now}`);
  }

  const baseChecks = new Set(list(at(before, 'schemathesis', 'excludeChecks')).map((c) => scalar(at(c, 'check'))));
  for (const check of list(at(after, 'schemathesis', 'excludeChecks'))) {
    const name = scalar(at(check, 'check'));
    if (!baseChecks.has(name)) find(`schemathesis.excludeChecks added: ${name}`);
  }
  // Left out, maxExamples is framework/cli/schemathesis.ts's default: removing a higher value lowers it too.
  const examples = (doc: unknown) => {
    const value = at(doc, 'schemathesis', 'maxExamples');
    return typeof value === 'number' ? value : 25;
  };
  if (examples(after) < examples(before))
    find(`schemathesis.maxExamples lowered ${examples(before)} -> ${examples(after)}`);

  // The contract step runs once per listed identity over the read-only operations: a lost identity, or a filter that
  // may select fewer operations, checks less. Like a header rule, a changed filter goes to a human.
  const usersBefore = at(before, 'schemathesis', 'users');
  const usersAfter = at(after, 'schemathesis', 'users');
  if (Array.isArray(usersAfter)) {
    const now = new Set(usersAfter.map(scalar));
    if (!Array.isArray(usersBefore)) find(`schemathesis.users narrowed from every user to ${stable(usersAfter)}`);
    for (const user of list(usersBefore).map(scalar)) if (!now.has(user)) find(`schemathesis.users lost ${user}`);
  }
  const shown = (value: unknown) => (value === undefined ? 'unset' : stable(value));
  for (const key of ['readOnlyPaths', 'readOnlyMethods']) {
    const was = at(before, 'schemathesis', key);
    const now = at(after, 'schemathesis', key);
    if (shown(now) !== shown(was)) find(`schemathesis.${key} changed ${shown(was)} -> ${shown(now)}`);
  }
  // A terminal marker removed lets a cut-off stream pass as complete; the guard cannot rank other changes either.
  const streamingBefore = at(before, 'rules', 'streaming');
  const streamingAfter = at(after, 'rules', 'streaming');
  if (streamingBefore !== undefined && shown(streamingAfter) !== shown(streamingBefore))
    find(`rules.streaming changed ${shown(streamingBefore)} -> ${shown(streamingAfter)}`);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// 4. known-failure-added

interface KnownFailure {
  id: string;
  match?: string;
  expires?: string;
}

function knownFailures(text: string | undefined): Map<string, KnownFailure> {
  const failures = at(yaml(text), 'failures');
  const out = new Map<string, KnownFailure>();
  for (const entry of list(failures)) {
    if (!isObject(entry) || entry.id === undefined) continue;
    const failure: KnownFailure = {
      id: scalar(entry.id),
      match: entry.match === undefined ? undefined : scalar(entry.match),
      // YAML reads an unquoted date as a Date; scalar() writes it back as YYYY-MM-DD.
      expires: entry.expires === undefined ? undefined : scalar(entry.expires),
    };
    out.set(`${failure.id}|${failure.match ?? ''}`, failure);
  }
  return out;
}

/** A failure accepted as known, or one whose acceptance now lasts longer. Removing an entry is info. */
export function knownFailuresRule(file: string, base: string | undefined, head: string | undefined): RuleOutcome {
  const result = outcome();
  const before = knownFailures(base);
  const after = knownFailures(head);
  const label = (f: KnownFailure) => (f.match ? `${f.id} (match ${f.match})` : f.id);
  for (const [key, failure] of after) {
    const was = before.get(key);
    if (!was)
      result.findings.push({
        rule: 'known-failure-added',
        file,
        detail: `known failure ${label(failure)} added, expires ${failure.expires ?? 'never'}`,
      });
    else if ((failure.expires ?? '9999') > (was.expires ?? '9999'))
      result.findings.push({
        rule: 'known-failure-added',
        file,
        detail: `known failure ${label(failure)} expiry moved ${was.expires ?? 'never'} -> ${failure.expires ?? 'never'}`,
      });
  }
  for (const [key, failure] of before) {
    if (!after.has(key))
      result.info.push({ rule: 'known-failure-added', file, detail: `known failure ${label(failure)} removed` });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// 5. tests-weakened

/** Source without comments, so a commented-out assertion does not count as one. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** `expect(...)`, `expect.soft(...)`, `expectRows(...)`: every assertion call. */
export function countExpects(source: string): number {
  return (code(source).match(/\bexpect\w*(?:\.\w+)*\s*\(/g) ?? []).length;
}

function markers(source: string): Record<'fail' | 'fixme' | 'skip', number> {
  const counts = { fail: 0, fixme: 0, skip: 0 };
  for (const [, kind] of code(source).matchAll(/\.(fail|fixme|skip)\s*\(/g)) counts[kind as keyof typeof counts]++;
  return counts;
}

const SCENARIO_ID = /\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\]/g;

function ids(sources: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, source] of sources)
    for (const [, id] of code(source).matchAll(SCENARIO_ID)) if (!out.has(id)) out.set(id, file);
  return out;
}

/**
 * Test sources (path -> text) of base and head: a file deleted, fewer assertions in a file, a scenario id no longer
 * in any source, or a new `.fail(`, `.fixme(` or `.skip(`.
 */
export function testsRule(base: Map<string, string>, head: Map<string, string>): RuleOutcome {
  const result = outcome();
  const find = (file: string, detail: string) => result.findings.push({ rule: 'tests-weakened', file, detail });
  for (const [file, before] of base) {
    const after = head.get(file);
    if (after === undefined) {
      find(file, `test source deleted (${countExpects(before)} assertions)`);
      continue;
    }
    const was = countExpects(before);
    const now = countExpects(after);
    if (now < was) find(file, `assertions ${was} -> ${now}`);
  }
  for (const [file, after] of head) {
    const was = markers(base.get(file) ?? '');
    const now = markers(after);
    for (const kind of ['fail', 'fixme', 'skip'] as const) {
      if (now[kind] > was[kind]) find(file, `.${kind}( ${was[kind]} -> ${now[kind]}`);
    }
    if (!base.has(file))
      result.info.push({
        rule: 'tests-weakened',
        file,
        detail: `test source added (${countExpects(after)} assertions)`,
      });
  }
  const after = ids(head);
  for (const [id, file] of ids(base)) if (!after.has(id)) find(file, `scenario ${id} no longer in any test source`);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// 6. machinery-changed

/** The judge: what decides the verdict. An MR that edits it cannot be judged by it. */
export const MACHINERY = [
  // The project's pin to a judge: moving it to another vgate version changes what verifies the MR.
  'vgate.yaml',
  // The workflow `vgate init --ci github` installs: a pull request runs its own copy of it.
  '.github/workflows/vgate.yml',
  // A GitLab merge request runs its own pipeline definition too, and either CODEOWNERS file names who approves the
  // judge: an edit to any of them can drop or re-route the very jobs that judge it.
  '.gitlab-ci.yml',
  '.gitlab/CODEOWNERS',
  '.github/CODEOWNERS',
  '.prettierignore',
  'framework/',
  'cli/',
  '.claude/skills/',
  'Taskfile.yml',
  'playwright.config.ts',
  'eslint.config.js',
  'tsconfig.json',
  'package.json',
  'pnpm-lock.yaml',
  '.prettierrc.json',
];

/**
 * `servicesDir`: the project's services directory (vgate.yaml). A file directly inside it (not in a service) is
 * configuration shared by every service's tests, so it counts as machinery too.
 */
export function isMachinery(path: string, servicesDir?: string): boolean {
  if (MACHINERY.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))) return true;
  if (!servicesDir) return false;
  const prefix = `${servicesDir}/`;
  return path.startsWith(prefix) && !path.slice(prefix.length).includes('/');
}

export function machineryRule(changed: string[], servicesDir?: string): RuleOutcome {
  const result = outcome();
  for (const file of [...new Set(changed)].filter((path) => isMachinery(path, servicesDir)).sort())
    result.findings.push({ rule: 'machinery-changed', file, detail: 'the gate machinery changed' });
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Gathering the files

function git(cwd: string, args: string[]): { code: number | null; out: string; err: string } {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: run.status, out: run.stdout ?? '', err: run.stderr ?? '' };
}

class Repo {
  /** Project root relative to the git top level, with a trailing slash ('' when they are the same). */
  readonly prefix: string;

  constructor(
    readonly top: string,
    readonly root: string,
    readonly base: string,
  ) {
    const rel = relative(top, root).split('\\').join('/');
    this.prefix = rel === '' ? '' : `${rel}/`;
  }

  baseFile(path: string): string | undefined {
    const run = git(this.top, ['show', `${this.base}:${this.prefix}${path}`]);
    return run.code === 0 ? run.out : undefined;
  }

  headFile(path: string): string | undefined {
    const file = join(this.root, path);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  }

  /** Project-relative files under `dir` at the base ref. */
  baseFiles(dir: string): string[] {
    const run = git(this.top, ['ls-tree', '-r', '--name-only', this.base, '--', `${this.prefix}${dir}`]);
    return run.out
      .split('\n')
      .filter(Boolean)
      .map((path) => path.slice(this.prefix.length));
  }

  headFiles(dir: string): string[] {
    const walk = (rel: string): string[] => {
      const abs = join(this.root, rel);
      if (!existsSync(abs)) return [];
      return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
        const path = `${rel}/${entry.name}`;
        if (entry.isDirectory()) return walk(path);
        return entry.isFile() ? [path] : [];
      });
    };
    return walk(dir);
  }

  /** Project-relative paths that differ between the base ref and the working tree, untracked files included. */
  changed(): string[] {
    const scope = this.prefix === '' ? '.' : this.prefix;
    const diff = git(this.top, ['diff', '--name-only', this.base, '--', scope]);
    const untracked = git(this.top, ['ls-files', '--others', '--exclude-standard', '--', scope]);
    return [...diff.out.split('\n'), ...untracked.out.split('\n')]
      .filter((path) => path !== '' && path.startsWith(this.prefix))
      .map((path) => path.slice(this.prefix.length));
  }
}

/** Test sources and their support code: an assertion moved into a helper still counts. */
const TEST_DIRS = (svc: string) => [`${svc}/tests`, `${svc}/support`];
const SOURCE = /\.(ts|js|mts|mjs)$/;

export interface GuardReport {
  schema: 'vgate.guard/1';
  service: string;
  base: string;
  decision: 'auto' | 'needs-human';
  findings: Finding[];
  info: Finding[];
}

export function guard(root: string, options: { service: string; base: string | undefined }): Result {
  if (!options.base)
    throw new UsageError(`Pass --base <git ref>, e.g. ${CLI} guard --service ${options.service} --base origin/main`);
  const realRoot = realpathSync(root);
  const top = git(realRoot, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    return {
      command: 'guard',
      ok: false,
      exitCode: EXIT.notReady,
      summary: `Not a git repository: ${realRoot}. The guard compares a base ref with the working tree.`,
      next: [],
    };
  }
  const topDir = realpathSync(top.out.trim());
  if (git(topDir, ['rev-parse', '--verify', '--quiet', `${options.base}^{commit}`]).code !== 0)
    throw new UsageError(`Unknown base ref "${options.base}" (fetch it first, e.g. git fetch origin <branch>)`);

  const repo = new Repo(topDir, realRoot, options.base);
  const project = readProject(realRoot);
  const servicesDir = project.servicesDirName;
  const svc = `${servicesDir}/${options.service}`;
  const both = (path: string) => [repo.baseFile(path), repo.headFile(path)] as const;
  const [baseService, headService] = both(`${svc}/service.yaml`);
  // A service the change deletes is judged against its base (every expectation of it removed). One that exists in
  // neither is a wrong call: guarding nothing must never read as `auto`.
  if (baseService === undefined && headService === undefined)
    throw new UsageError(`Unknown service "${options.service}": no ${svc}/service.yaml at ${options.base} or here`);
  const contractPath = (text: string | undefined) => {
    const spec = at(yaml(text), 'spec');
    return `${svc}/${typeof spec === 'string' ? spec : 'openapi.yaml'}`;
  };
  const baseContractPath = contractPath(baseService);
  const headContractPath = contractPath(headService);

  const sources = (files: string[], read: (path: string) => string | undefined) =>
    new Map(
      files
        .filter((path) => SOURCE.test(path))
        .flatMap((path) => {
          const text = read(path);
          return text === undefined ? [] : [[path, text] as const];
        }),
    );
  const baseTests = sources(
    TEST_DIRS(svc).flatMap((dir) => repo.baseFiles(dir)),
    (path) => repo.baseFile(path),
  );
  const headTests = sources(
    TEST_DIRS(svc).flatMap((dir) => repo.headFiles(dir)),
    (path) => repo.headFile(path),
  );

  const outcomes = [
    contractRule(
      headContractPath,
      repo.baseFile(baseContractPath),
      repo.headFile(headContractPath),
      baseService,
      headService,
    ),
    planRule(`${svc}/inventory.yaml`, ...both(`${svc}/inventory.yaml`)),
    configRule(`${svc}/service.yaml`, baseService, headService),
    knownFailuresRule(`${svc}/known-failures.yaml`, ...both(`${svc}/known-failures.yaml`)),
    testsRule(baseTests, headTests),
    machineryRule(repo.changed(), servicesDir),
  ];
  const findings = outcomes.flatMap((o) => o.findings);
  const info = outcomes.flatMap((o) => o.info);
  const decision = findings.length === 0 ? 'auto' : 'needs-human';
  const report: GuardReport = {
    schema: 'vgate.guard/1',
    service: options.service,
    base: options.base,
    decision,
    findings,
    info,
  };

  const out = join(project.reportsDir, 'guard.json');
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  const rules = [...new Set(findings.map((f) => f.rule))];
  const files = [...new Set(findings.map((f) => f.file))];
  return {
    command: 'guard',
    ok: decision === 'auto',
    exitCode: decision === 'auto' ? EXIT.ok : EXIT.failed,
    summary:
      decision === 'auto'
        ? `GUARD auto ${options.service} vs ${options.base}: no expectation weakened (${info.length} additive change${info.length === 1 ? '' : 's'}); a green gate may merge`
        : `GUARD needs-human ${options.service} vs ${options.base}: ${findings.length} finding${findings.length === 1 ? '' : 's'} (${rules.join(', ')})`,
    data: report,
    next:
      decision === 'auto'
        ? []
        : files.map(
            (file) =>
              `human review of ${file}: ${findings
                .filter((f) => f.file === file)
                .map((f) => f.rule)
                .filter((r, i, all) => all.indexOf(r) === i)
                .join(', ')}`,
          ),
    text: [
      ...findings.map((f) => `NEEDS-HUMAN  ${f.rule.padEnd(19)}  ${f.file}  ${f.detail}`),
      ...info.map((f) => `info         ${f.rule.padEnd(19)}  ${f.file}  ${f.detail}`),
      `Report: ${GUARD_FILE}`,
    ],
  };
}

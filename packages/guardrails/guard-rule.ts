import {
  DEFAULT_RULE_TABLE_FILE,
  parseGuardrails,
  type BannedPatternRule,
  type BoundaryRule,
  type GuardrailsConfig,
  type NativeLinterRule,
} from './config.ts';

export interface GuardFinding {
  rule: 'guardrails-loosened';
  file: string;
  detail: string;
}

export interface GuardRuleOutcome {
  findings: GuardFinding[];
  info: GuardFinding[];
}

function outcome(): GuardRuleOutcome {
  return { findings: [], info: [] };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${k}:${stable(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function tryParseConfig(text: string, file: string): GuardrailsConfig | string {
  try {
    return parseGuardrails(text, file);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) out.set(item.id, item);
  return out;
}

function checkFileScopeNarrowed(
  label: string,
  baseFiles: string[] | undefined,
  headFiles: string[] | undefined,
  find: (detail: string) => void,
): void {
  const before = baseFiles ?? [];
  const after = headFiles ?? [];
  if (before.length === 0 && after.length > 0) {
    find(`${label} narrowed files from all files to ${stable(after)}`);
    return;
  }
  if (before.length > 0 && after.length > 0) {
    const afterSet = new Set(after);
    for (const glob of before) {
      if (!afterSet.has(glob)) {
        find(`${label} narrowed files (lost ${glob})`);
      }
    }
  }
}

function checkExcludesAdded(
  label: string,
  baseExclude: string[] | undefined,
  headExclude: string[] | undefined,
  find: (detail: string) => void,
  note: (detail: string) => void,
): void {
  const before = new Set(baseExclude ?? []);
  const after = new Set(headExclude ?? []);
  for (const glob of after) {
    if (!before.has(glob)) find(`${label} added exclude: ${glob}`);
  }
  for (const glob of before) {
    if (!after.has(glob)) note(`${label} removed exclude: ${glob}`);
  }
}

/**
 * Pure anti-weakening rule for `guardrails.yaml`: flags deletions, removed or narrowed rules,
 * newly added excludes/ignores, lowered severities, newly enabled ratcheting, raised comment caps,
 * removed native linters or protected config files, and disabled rule-table enforcement.
 */
export function guardrailsConfigRule(
  file: string,
  base: string | undefined,
  head: string | undefined,
): GuardRuleOutcome {
  const result = outcome();
  const find = (detail: string) => result.findings.push({ rule: 'guardrails-loosened', file, detail });
  const note = (detail: string) => result.info.push({ rule: 'guardrails-loosened', file, detail });

  if (base === undefined && head === undefined) return result;
  if (base === undefined) {
    note('new guardrails config (no base version)');
    return result;
  }
  if (head === undefined) {
    find('guardrails config was deleted');
    return result;
  }

  const before = tryParseConfig(base, file);
  const after = tryParseConfig(head, file);
  if (typeof after === 'string') {
    find(`guardrails config does not parse: ${after}`);
    return result;
  }
  if (typeof before === 'string') {
    note(`base guardrails config did not parse: ${before}`);
    return result;
  }

  // 1. Boundaries
  const baseBoundaries = byId<BoundaryRule>(before.boundaries);
  const headBoundaries = byId<BoundaryRule>(after.boundaries);
  for (const [id, bRule] of baseBoundaries) {
    const hRule = headBoundaries.get(id);
    if (!hRule) {
      find(`boundary rule "${id}" removed`);
      continue;
    }
    const headFrom = new Set(hRule.from);
    for (const glob of bRule.from) {
      if (!headFrom.has(glob)) find(`boundary rule "${id}" narrowed from (lost ${glob})`);
    }
    const headDisallow = new Set(hRule.disallowImports);
    for (const glob of bRule.disallowImports) {
      if (!headDisallow.has(glob)) find(`boundary rule "${id}" narrowed disallowImports (lost ${glob})`);
    }
    const baseFrom = new Set(bRule.from);
    for (const glob of hRule.from) {
      if (!baseFrom.has(glob)) note(`boundary rule "${id}" expanded from (+${glob})`);
    }
    const baseDisallow = new Set(bRule.disallowImports);
    for (const glob of hRule.disallowImports) {
      if (!baseDisallow.has(glob)) note(`boundary rule "${id}" expanded disallowImports (+${glob})`);
    }
  }
  for (const id of headBoundaries.keys()) {
    if (!baseBoundaries.has(id)) note(`boundary rule "${id}" added`);
  }

  // 2. Banned patterns
  const basePatterns = byId<BannedPatternRule>(before.bannedPatterns);
  const headPatterns = byId<BannedPatternRule>(after.bannedPatterns);
  for (const [id, bRule] of basePatterns) {
    const hRule = headPatterns.get(id);
    if (!hRule) {
      find(`banned pattern "${id}" removed`);
      continue;
    }
    if (bRule.pattern !== hRule.pattern || (bRule.flags ?? '') !== (hRule.flags ?? '')) {
      find(
        `banned pattern "${id}" regex changed /${bRule.pattern}/${bRule.flags ?? ''} -> /${hRule.pattern}/${hRule.flags ?? ''}`,
      );
    }
    checkFileScopeNarrowed(`banned pattern "${id}"`, bRule.files, hRule.files, find);
    checkExcludesAdded(`banned pattern "${id}"`, bRule.exclude, hRule.exclude, find, note);

    if (bRule.ratcheted !== true && hRule.ratcheted === true) {
      find(`banned pattern "${id}" turned ratcheted on`);
    } else if (bRule.ratcheted === true && hRule.ratcheted !== true) {
      note(`banned pattern "${id}" turned ratcheted off`);
    }

    const baseSeverity = bRule.severity ?? 'error';
    const headSeverity = hRule.severity ?? 'error';
    if (baseSeverity === 'error' && headSeverity === 'warn') {
      find(`banned pattern "${id}" lowered severity error -> warn`);
    } else if (baseSeverity === 'warn' && headSeverity === 'error') {
      note(`banned pattern "${id}" raised severity warn -> error`);
    }
  }
  for (const id of headPatterns.keys()) {
    if (!basePatterns.has(id)) note(`banned pattern "${id}" added`);
  }

  // 3. Comments
  if (before.comments !== undefined && after.comments === undefined) {
    find('comments guardrail removed');
  } else if (before.comments === undefined && after.comments !== undefined) {
    note('comments guardrail added');
  } else if (before.comments !== undefined && after.comments !== undefined) {
    const bc = before.comments;
    const hc = after.comments;

    if (bc.maxRatio !== undefined && hc.maxRatio === undefined) {
      find(`comments.maxRatio removed (was ${bc.maxRatio})`);
    } else if (bc.maxRatio !== undefined && hc.maxRatio !== undefined) {
      if (hc.maxRatio > bc.maxRatio) find(`comments.maxRatio raised ${bc.maxRatio} -> ${hc.maxRatio}`);
      else if (hc.maxRatio < bc.maxRatio) note(`comments.maxRatio tightened ${bc.maxRatio} -> ${hc.maxRatio}`);
    } else if (bc.maxRatio === undefined && hc.maxRatio !== undefined) {
      note(`comments.maxRatio added (${hc.maxRatio})`);
    }

    if (bc.maxInlinePerFile !== undefined && hc.maxInlinePerFile === undefined) {
      find(`comments.maxInlinePerFile removed (was ${bc.maxInlinePerFile})`);
    } else if (bc.maxInlinePerFile !== undefined && hc.maxInlinePerFile !== undefined) {
      if (hc.maxInlinePerFile > bc.maxInlinePerFile) {
        find(`comments.maxInlinePerFile raised ${bc.maxInlinePerFile} -> ${hc.maxInlinePerFile}`);
      } else if (hc.maxInlinePerFile < bc.maxInlinePerFile) {
        note(`comments.maxInlinePerFile tightened ${bc.maxInlinePerFile} -> ${hc.maxInlinePerFile}`);
      }
    } else if (bc.maxInlinePerFile === undefined && hc.maxInlinePerFile !== undefined) {
      note(`comments.maxInlinePerFile added (${hc.maxInlinePerFile})`);
    }

    checkFileScopeNarrowed('comments', bc.files, hc.files, find);
    checkExcludesAdded('comments', bc.exclude, hc.exclude, find, note);

    if (bc.ignoreLicenseHeaders !== true && hc.ignoreLicenseHeaders === true) {
      find('comments.ignoreLicenseHeaders turned on');
    }
    if (bc.ignoreDocComments !== true && hc.ignoreDocComments === true) {
      find('comments.ignoreDocComments turned on');
    }
    if (bc.ratcheted !== true && hc.ratcheted === true) {
      find('comments.ratcheted turned on');
    } else if (bc.ratcheted === true && hc.ratcheted !== true) {
      note('comments.ratcheted turned off');
    }
  }

  // 4. Native linters
  const baseLinters = byId<NativeLinterRule>(before.nativeLinters);
  const headLinters = byId<NativeLinterRule>(after.nativeLinters);
  for (const [id, bLinter] of baseLinters) {
    const hLinter = headLinters.get(id);
    if (!hLinter) {
      find(`native linter "${id}" removed`);
      continue;
    }
    if (bLinter.command !== hLinter.command || stable(bLinter.args ?? []) !== stable(hLinter.args ?? [])) {
      find(
        `native linter "${id}" command/args changed: ${bLinter.command} ${stable(bLinter.args ?? [])} -> ${hLinter.command} ${stable(hLinter.args ?? [])}`,
      );
    }
    const headCfgs = new Set(hLinter.configFiles ?? []);
    for (const cfg of bLinter.configFiles ?? []) {
      if (!headCfgs.has(cfg)) {
        find(`native linter "${id}" removed protected configFile: ${cfg}`);
      }
    }
    const baseCfgs = new Set(bLinter.configFiles ?? []);
    for (const cfg of hLinter.configFiles ?? []) {
      if (!baseCfgs.has(cfg)) {
        note(`native linter "${id}" added protected configFile: ${cfg}`);
      }
    }
  }
  for (const id of headLinters.keys()) {
    if (!baseLinters.has(id)) note(`native linter "${id}" added`);
  }

  // 5. Rule table
  const baseRequire = before.ruleTable?.requireEnforcer ?? true;
  const headRequire = after.ruleTable?.requireEnforcer ?? true;
  if (baseRequire && !headRequire) {
    find('ruleTable.requireEnforcer turned off');
  } else if (!baseRequire && headRequire) {
    note('ruleTable.requireEnforcer turned on');
  }
  const baseTableFile = before.ruleTable?.file ?? DEFAULT_RULE_TABLE_FILE;
  const headTableFile = after.ruleTable?.file ?? DEFAULT_RULE_TABLE_FILE;
  if (baseTableFile !== headTableFile) {
    find(`ruleTable.file changed ${baseTableFile} -> ${headTableFile}`);
  }

  // 6. Global ignore & ratchetFile
  const baseIgnore = new Set(before.ignore);
  const headIgnore = new Set(after.ignore);
  for (const glob of headIgnore) {
    if (!baseIgnore.has(glob)) find(`ignore added: ${glob}`);
  }
  for (const glob of baseIgnore) {
    if (!headIgnore.has(glob)) note(`ignore removed: ${glob}`);
  }
  if (before.ratchetFile !== after.ratchetFile) {
    find(`ratchetFile changed ${before.ratchetFile} -> ${after.ratchetFile}`);
  }

  return result;
}

type RatchetCounts = Record<string, Record<string, number>>;

function parseRatchetCounts(text: string): RatchetCounts | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'must be a JSON object';
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== 'vgate.ratchet/1') {
    return `unsupported schema "${String(obj.schema)}"`;
  }
  if (typeof obj.counts !== 'object' || obj.counts === null || Array.isArray(obj.counts)) {
    return 'missing counts object';
  }
  const out: RatchetCounts = {};
  for (const [ruleId, files] of Object.entries(obj.counts as Record<string, unknown>)) {
    if (typeof files !== 'object' || files === null || Array.isArray(files)) {
      return `counts["${ruleId}"] must be an object`;
    }
    out[ruleId] = {};
    for (const [filePath, count] of Object.entries(files as Record<string, unknown>)) {
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
        return `counts["${ruleId}"]["${filePath}"] must be a non-negative number`;
      }
      out[ruleId][filePath] = count;
    }
  }
  return out;
}

/**
 * Pure anti-weakening rule for `.vgate-ratchet.json`: flags deleted baselines, any increased count,
 * and any newly added file with count > 0. Decreases and removals are `info` (tightenings).
 */
export function ratchetBaselineRule(
  file: string,
  base: string | undefined,
  head: string | undefined,
): GuardRuleOutcome {
  const result = outcome();
  const find = (detail: string) => result.findings.push({ rule: 'guardrails-loosened', file, detail });
  const note = (detail: string) => result.info.push({ rule: 'guardrails-loosened', file, detail });

  if (base === undefined && head === undefined) return result;
  if (head === undefined) {
    find('ratchet baseline was deleted');
    return result;
  }

  const headCounts = parseRatchetCounts(head);
  if (typeof headCounts === 'string') {
    find(`ratchet baseline does not parse: ${headCounts}`);
    return result;
  }

  let baseCounts: RatchetCounts = {};
  if (base !== undefined) {
    const parsed = parseRatchetCounts(base);
    if (typeof parsed === 'string') {
      note(`base ratchet baseline did not parse: ${parsed}`);
    } else {
      baseCounts = parsed;
    }
  }

  let hadNewEntries = false;
  for (const [ruleId, headFiles] of Object.entries(headCounts)) {
    const baseFiles = baseCounts[ruleId] ?? {};
    for (const [targetFile, headCount] of Object.entries(headFiles)) {
      const baseCount = baseFiles[targetFile];
      if (baseCount === undefined) {
        if (headCount > 0) {
          hadNewEntries = true;
          find(`ratchet baseline added ${ruleId} for ${targetFile} (count ${headCount})`);
        }
      } else if (headCount > baseCount) {
        find(`ratchet baseline raised ${ruleId} for ${targetFile}: ${baseCount} -> ${headCount}`);
      } else if (headCount < baseCount) {
        note(`ratchet baseline tightened ${ruleId} for ${targetFile}: ${baseCount} -> ${headCount}`);
      }
    }
  }

  for (const [ruleId, baseFiles] of Object.entries(baseCounts)) {
    const headFiles = headCounts[ruleId] ?? {};
    for (const [targetFile, baseCount] of Object.entries(baseFiles)) {
      if (headFiles[targetFile] === undefined) {
        note(`ratchet baseline removed ${ruleId} for ${targetFile} (was ${baseCount})`);
      }
    }
  }

  if (base === undefined && !hadNewEntries) {
    note('new empty ratchet baseline');
  }

  return result;
}

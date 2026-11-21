import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface FeatureEntry {
  id: string;
  name: string;
  route?: string;
  selectors?: string[];
  endpoints?: string[];
  scenarios: string[];
  preconditions?: string[];
  sourceFiles: string[];
  steps: Array<{ action: string; expect: string }>;
}

export interface FeatureMapLoadResult {
  indexFile?: string;
  features: FeatureEntry[];
  errors: string[];
}

export interface FeatureDrift {
  featureId: string;
  reason: string;
  file?: string;
}

export interface MaintainReport {
  schema: 'vgate.maintain/1';
  outcome: 'clean' | 'changed' | 'blocked';
  service: string;
  featuresChecked: number;
  drifted: FeatureDrift[];
  unmappedScenarios: string[];
  orphanedScenarios: string[];
  productCodeTouched: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, field: string, ctx: string, errors: string[], required: boolean): string[] {
  if (value === undefined) {
    if (required) errors.push(`${ctx}: missing required field "${field}"`);
    return [];
  }
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    errors.push(`${ctx}: "${field}" must be an array of strings`);
    return [];
  }
  return value;
}

function validateFeatureEntry(raw: unknown, ctx: string, errors: string[]): FeatureEntry | null {
  if (!isRecord(raw)) {
    errors.push(`${ctx}: expected a YAML mapping`);
    return null;
  }

  const startErrors = errors.length;
  const id = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : '';
  if (!id) errors.push(`${ctx}: missing or empty string field "id"`);

  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : '';
  if (!name) errors.push(`${ctx}: missing or empty string field "name"`);

  if (raw.route !== undefined && typeof raw.route !== 'string') {
    errors.push(`${ctx}: "route" must be a string`);
  }

  const scenarios = asStringArray(raw.scenarios, 'scenarios', ctx, errors, true);
  const sourceFiles = asStringArray(raw.sourceFiles, 'sourceFiles', ctx, errors, true);
  const selectors =
    raw.selectors !== undefined ? asStringArray(raw.selectors, 'selectors', ctx, errors, false) : undefined;
  const endpoints =
    raw.endpoints !== undefined ? asStringArray(raw.endpoints, 'endpoints', ctx, errors, false) : undefined;
  const preconditions =
    raw.preconditions !== undefined ? asStringArray(raw.preconditions, 'preconditions', ctx, errors, false) : undefined;

  const steps: Array<{ action: string; expect: string }> = [];
  if (!Array.isArray(raw.steps)) {
    errors.push(`${ctx}: missing required array field "steps"`);
  } else {
    for (let i = 0; i < raw.steps.length; i++) {
      const step: unknown = raw.steps[i];
      if (
        !isRecord(step) ||
        typeof step.action !== 'string' ||
        step.action.trim().length === 0 ||
        typeof step.expect !== 'string' ||
        step.expect.trim().length === 0
      ) {
        errors.push(`${ctx}: steps[${i}] must have non-empty string "action" and "expect"`);
      } else {
        steps.push({ action: step.action, expect: step.expect });
      }
    }
  }

  if (errors.length > startErrors) return null;

  return {
    id,
    name,
    ...(typeof raw.route === 'string' ? { route: raw.route } : {}),
    ...(selectors !== undefined ? { selectors } : {}),
    ...(endpoints !== undefined ? { endpoints } : {}),
    scenarios,
    ...(preconditions !== undefined ? { preconditions } : {}),
    sourceFiles,
    steps,
  };
}

/**
 * Loads `features/README.md` and `features/*.yaml` (and `*.yml`) from a service directory.
 */
export function loadFeatureMap(serviceDir: string): FeatureMapLoadResult {
  const featuresDir = path.join(serviceDir, 'features');
  const errors: string[] = [];
  const features: FeatureEntry[] = [];

  if (!existsSync(featuresDir)) {
    return { features: [], errors: [`Missing features directory: ${featuresDir}`] };
  }

  const readmePath = path.join(featuresDir, 'README.md');
  const indexFile = existsSync(readmePath) ? readmePath : undefined;
  if (!indexFile) {
    errors.push(`Missing feature map index: ${readmePath}`);
  }

  const yamlFiles = readdirSync(featuresDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const seenIds = new Set<string>();

  for (const fileName of yamlFiles) {
    const filePath = path.join(featuresDir, fileName);
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(filePath, 'utf8'));
    } catch (err) {
      errors.push(`${fileName}: YAML parse error: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const rawEntries: unknown[] = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.features)
        ? parsed.features
        : [parsed];

    for (let i = 0; i < rawEntries.length; i++) {
      const ctx = rawEntries.length > 1 ? `${fileName}[${i}]` : fileName;
      const entry = validateFeatureEntry(rawEntries[i], ctx, errors);
      if (entry) {
        if (seenIds.has(entry.id)) {
          errors.push(`${ctx}: duplicate feature id "${entry.id}"`);
        } else {
          seenIds.add(entry.id);
          features.push(entry);
        }
      }
    }
  }

  return {
    ...(indexFile !== undefined ? { indexFile } : {}),
    features,
    errors,
  };
}

function extractScenariosFromInventory(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) extractScenariosFromInventory(item, out);
    return;
  }
  if (!isRecord(value)) return;

  if (Array.isArray(value.scenarios)) {
    for (const sc of value.scenarios) {
      if (typeof sc === 'string' && sc.trim().length > 0) {
        out.add(sc.trim());
      } else if (isRecord(sc) && typeof sc.id === 'string' && sc.id.trim().length > 0) {
        out.add(sc.id.trim());
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key !== 'scenarios') {
      extractScenariosFromInventory(child, out);
    }
  }
}

function loadInventoryScenarios(serviceDir: string): string[] | undefined {
  const inventoryPath = path.join(serviceDir, 'inventory.yaml');
  if (!existsSync(inventoryPath)) return undefined;
  try {
    const parsed: unknown = parseYaml(readFileSync(inventoryPath, 'utf8'));
    const ids = new Set<string>();
    extractScenariosFromInventory(parsed, ids);
    return [...ids].sort();
  } catch {
    return undefined;
  }
}

function resolveExistingFile(projectRoot: string, serviceDir: string, relPath: string): string | null {
  const fromRoot = path.resolve(projectRoot, relPath);
  if (existsSync(fromRoot)) return fromRoot;
  const fromService = path.resolve(serviceDir, relPath);
  if (existsSync(fromService)) return fromService;
  return null;
}

function selectorMatchesContent(selector: string, combinedSource: string): boolean {
  if (combinedSource.includes(selector)) return true;

  // CSS attribute selector, e.g. `[data-testid="submit-btn"]` or `[aria-label='Close']`
  const attrMatch = /^\[([a-zA-Z0-9_-]+)\s*=\s*(['"]?)([^'"\]]+)\2\]$/.exec(selector.trim());
  if (attrMatch) {
    const [, attr, , val] = attrMatch;
    if (
      combinedSource.includes(`${attr}="${val}"`) ||
      combinedSource.includes(`${attr}='${val}'`) ||
      combinedSource.includes(`${attr}: "${val}"`) ||
      combinedSource.includes(`${attr}: '${val}'`)
    ) {
      return true;
    }
  }

  // ID selector, e.g. `#login-form`
  if (selector.startsWith('#') && selector.length > 1) {
    const idVal = selector.slice(1);
    if (combinedSource.includes(`id="${idVal}"`) || combinedSource.includes(`id='${idVal}'`)) {
      return true;
    }
  }

  // Class selector, e.g. `.submit-btn`
  if (selector.startsWith('.') && selector.length > 1) {
    const cls = selector.slice(1);
    if (combinedSource.includes(cls)) return true;
  }

  return false;
}

function endpointMatchesContent(endpoint: string, combinedSource: string): boolean {
  if (combinedSource.includes(endpoint)) return true;
  const methodPath = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/i.exec(endpoint.trim());
  if (methodPath && methodPath[1]) {
    return combinedSource.includes(methodPath[1]);
  }
  return false;
}

/**
 * Strictly read-only drift checker for a service's Unified Feature Map.
 * Never edits product code; classifies the map as `clean`, `changed`, or `blocked`.
 */
export function maintainFeatureMap(options: {
  projectRoot: string;
  serviceDir: string;
  serviceName: string;
  inventoryScenarios?: string[];
}): MaintainReport {
  const loaded = loadFeatureMap(options.serviceDir);
  const drifted: FeatureDrift[] = [];
  let hasBrokenPrecondition = false;

  for (const feature of loaded.features) {
    // Check preconditions for structural validity or explicit `file:<path>` dependencies
    for (const pre of feature.preconditions ?? []) {
      if (pre.trim().length === 0) {
        hasBrokenPrecondition = true;
        drifted.push({ featureId: feature.id, reason: 'Broken precondition: empty precondition entry' });
        continue;
      }
      if (pre.startsWith('file:')) {
        const target = pre.slice('file:'.length).trim();
        if (!target || resolveExistingFile(options.projectRoot, options.serviceDir, target) === null) {
          hasBrokenPrecondition = true;
          drifted.push({
            featureId: feature.id,
            reason: `Broken precondition: required file not found (${target || '<empty>'})`,
            ...(target ? { file: target } : {}),
          });
        }
      }
    }

    const sourceContents: string[] = [];
    for (const sourceFile of feature.sourceFiles) {
      const resolved = resolveExistingFile(options.projectRoot, options.serviceDir, sourceFile);
      if (resolved === null) {
        drifted.push({
          featureId: feature.id,
          reason: `Declared source file not found: ${sourceFile}`,
          file: sourceFile,
        });
      } else {
        sourceContents.push(readFileSync(resolved, 'utf8'));
      }
    }

    const combinedSource = sourceContents.join('\n');

    for (const selector of feature.selectors ?? []) {
      if (!selectorMatchesContent(selector, combinedSource)) {
        drifted.push({
          featureId: feature.id,
          reason: `Selector not found in declared sourceFiles: ${selector}`,
          ...(feature.sourceFiles[0] ? { file: feature.sourceFiles[0] } : {}),
        });
      }
    }

    for (const endpoint of feature.endpoints ?? []) {
      if (!endpointMatchesContent(endpoint, combinedSource)) {
        drifted.push({
          featureId: feature.id,
          reason: `Endpoint not found in declared sourceFiles: ${endpoint}`,
          ...(feature.sourceFiles[0] ? { file: feature.sourceFiles[0] } : {}),
        });
      }
    }
  }

  const inventoryScenarios = options.inventoryScenarios ?? loadInventoryScenarios(options.serviceDir);
  const mappedScenarios = new Set<string>();
  for (const feature of loaded.features) {
    for (const sc of feature.scenarios) {
      mappedScenarios.add(sc);
    }
  }

  const unmappedScenarios: string[] = [];
  const orphanedScenarios: string[] = [];

  if (inventoryScenarios !== undefined) {
    const inventorySet = new Set(inventoryScenarios);
    for (const sc of inventorySet) {
      if (!mappedScenarios.has(sc)) unmappedScenarios.push(sc);
    }
    for (const sc of mappedScenarios) {
      if (!inventorySet.has(sc)) orphanedScenarios.push(sc);
    }
    unmappedScenarios.sort();
    orphanedScenarios.sort();
  }

  const isBlocked =
    !loaded.indexFile || loaded.errors.length > 0 || loaded.features.length === 0 || hasBrokenPrecondition;
  const hasDrift = drifted.length > 0 || unmappedScenarios.length > 0 || orphanedScenarios.length > 0;
  const outcome: MaintainReport['outcome'] = isBlocked ? 'blocked' : hasDrift ? 'changed' : 'clean';

  return {
    schema: 'vgate.maintain/1',
    outcome,
    service: options.serviceName,
    featuresChecked: loaded.features.length,
    drifted,
    unmappedScenarios,
    orphanedScenarios,
    productCodeTouched: false,
  };
}

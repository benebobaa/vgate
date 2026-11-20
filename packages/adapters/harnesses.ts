/**
 * Built-in vendor-agnostic harness definitions and cross-vendor model family inference.
 */

export const BUILTIN_HARNESSES = ['agy', 'claude', 'cursor', 'codex', 'opencode', 'pi', 'omp', 'grokbot'] as const;

export type BuiltinHarness = (typeof BUILTIN_HARNESSES)[number];

export type InstructionsFormat = 'agents-md' | 'claude-md' | 'cursor-mdc';

export type VendorFamily = 'google' | 'anthropic' | 'openai' | 'xai' | 'cursor' | 'multi';

export interface HeadlessSpec {
  command: string;
  args: string[];
  promptMode: 'arg' | 'stdin';
  modelFlag?: string;
  effortFlag?: string;
  jsonFlag?: string;
  extraArgs?: string[];
}

export interface HarnessSpec {
  id: BuiltinHarness;
  displayName: string;
  skillsDir: string;
  instructionsFile: string;
  format: InstructionsFormat;
  headless: HeadlessSpec;
  vendorFamily: VendorFamily;
}

export const HARNESSES: Record<BuiltinHarness, HarnessSpec> = {
  agy: {
    id: 'agy',
    displayName: 'Antigravity (agy)',
    skillsDir: '.agents/skills',
    instructionsFile: 'AGENTS.md',
    format: 'agents-md',
    headless: {
      command: 'agy',
      args: ['-p', '{{prompt}}', '--print-timeout', '0'],
      promptMode: 'arg',
      modelFlag: '--model',
    },
    vendorFamily: 'google',
  },
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    skillsDir: '.claude/skills',
    instructionsFile: 'CLAUDE.md',
    format: 'claude-md',
    headless: {
      command: 'claude',
      args: ['-p', '{{prompt}}', '--output-format', 'text'],
      promptMode: 'arg',
      modelFlag: '--model',
    },
    vendorFamily: 'anthropic',
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    skillsDir: '.cursor/skills',
    instructionsFile: '.cursor/rules/vgate.mdc',
    format: 'cursor-mdc',
    headless: {
      command: 'agent',
      args: ['-p', '{{prompt}}'],
      promptMode: 'arg',
      modelFlag: '--model',
    },
    vendorFamily: 'cursor',
  },
  codex: {
    id: 'codex',
    displayName: 'OpenAI Codex',
    skillsDir: '.agents/skills',
    instructionsFile: 'AGENTS.md',
    format: 'agents-md',
    headless: {
      command: 'codex',
      args: ['exec', '{{prompt}}'],
      promptMode: 'arg',
      modelFlag: '--model',
    },
    vendorFamily: 'openai',
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    skillsDir: '.agents/skills',
    instructionsFile: 'AGENTS.md',
    format: 'agents-md',
    headless: {
      command: 'opencode',
      args: ['run', '{{prompt}}'],
      promptMode: 'arg',
      modelFlag: '--model',
    },
    vendorFamily: 'multi',
  },
  pi: {
    id: 'pi',
    displayName: 'Pi',
    skillsDir: '.agents/skills',
    instructionsFile: 'AGENTS.md',
    format: 'agents-md',
    headless: {
      command: 'pi',
      args: ['-p', '{{prompt}}'],
      promptMode: 'arg',
      modelFlag: '--model',
    },
    vendorFamily: 'multi',
  },
  omp: {
    id: 'omp',
    displayName: 'Oh My Pi (omp)',
    skillsDir: '.agents/skills',
    instructionsFile: 'AGENTS.md',
    format: 'agents-md',
    headless: {
      command: 'omp',
      args: ['-p', '{{prompt}}'],
      promptMode: 'arg',
      modelFlag: '--model',
    },
    vendorFamily: 'multi',
  },
  grokbot: {
    id: 'grokbot',
    displayName: 'Grokbot',
    skillsDir: '.grokbot/skills',
    instructionsFile: 'AGENTS.md',
    format: 'agents-md',
    headless: {
      command: 'grokbot',
      args: ['run', '--prompt', '{{prompt}}'],
      promptMode: 'arg',
      modelFlag: '--model',
    },
    vendorFamily: 'xai',
  },
};

export function isBuiltinHarness(name: string): name is BuiltinHarness {
  return Object.prototype.hasOwnProperty.call(HARNESSES, name);
}

/**
 * Resolves a harness selection (`'all'`, comma-separated string, array, or `undefined`) into a deduplicated list of
 * `HarnessSpec` entries. Throws a clear error if any harness name is unknown.
 */
export function resolveHarnesses(input: string | string[] | undefined): HarnessSpec[] {
  if (input === undefined) {
    return BUILTIN_HARNESSES.map((id) => HARNESSES[id]);
  }

  const rawItems = Array.isArray(input) ? input : [input];
  const tokens = rawItems
    .flatMap((item) => item.split(','))
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return BUILTIN_HARNESSES.map((id) => HARNESSES[id]);
  }

  const unknown = tokens.filter((token) => token !== 'all' && !isBuiltinHarness(token));
  if (unknown.length > 0) {
    throw new Error(`Unknown harness ${unknown.join(', ')}. Supported harnesses: all, ${BUILTIN_HARNESSES.join(', ')}`);
  }

  if (tokens.includes('all')) {
    return BUILTIN_HARNESSES.map((id) => HARNESSES[id]);
  }

  const seen = new Set<BuiltinHarness>();
  const resolved: HarnessSpec[] = [];
  for (const token of tokens) {
    if (isBuiltinHarness(token) && !seen.has(token)) {
      seen.add(token);
      resolved.push(HARNESSES[token]);
    }
  }
  return resolved;
}

const MODEL_FAMILY_RULES: ReadonlyArray<{ family: string; match: (tokens: readonly string[]) => boolean }> = [
  {
    family: 'anthropic',
    match: (tokens) =>
      tokens.some(
        (t) => t === 'anthropic' || t.startsWith('claude') || t === 'opus' || t === 'sonnet' || t === 'haiku',
      ),
  },
  {
    family: 'google',
    match: (tokens) =>
      tokens.some(
        (t) => t === 'google' || t.startsWith('gemini') || t.startsWith('gemma') || t === 'palm' || t === 'vertex',
      ),
  },
  {
    family: 'openai',
    match: (tokens) =>
      tokens.some(
        (t) =>
          t === 'openai' ||
          t.startsWith('gpt') ||
          t.startsWith('chatgpt') ||
          t === 'codex' ||
          t === 'o1' ||
          t === 'o3' ||
          t === 'o4',
      ),
  },
  {
    family: 'xai',
    match: (tokens) => tokens.some((t) => t === 'xai' || t.startsWith('grok')),
  },
  {
    family: 'deepseek',
    match: (tokens) => tokens.some((t) => t.startsWith('deepseek')),
  },
  {
    family: 'meta',
    match: (tokens) => tokens.some((t) => t === 'meta' || t.startsWith('llama')),
  },
  {
    family: 'mistral',
    match: (tokens) =>
      tokens.some((t) => t.startsWith('mistral') || t.startsWith('mixtral') || t.startsWith('codestral')),
  },
  {
    family: 'qwen',
    match: (tokens) => tokens.some((t) => t.startsWith('qwen')),
  },
];

/**
 * Infers the model vendor family (`'anthropic' | 'google' | 'openai' | 'xai' | 'deepseek' | 'meta' | ...`)
 * from the model identifier first, falling back to `fallbackFamily` or the built-in harness `vendorFamily`.
 */
export function inferModelFamily(harness: string, model?: string, fallbackFamily?: string): string {
  if (model !== undefined && model.trim().length > 0) {
    const normalized = model.trim().toLowerCase();
    const tokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
    for (const rule of MODEL_FAMILY_RULES) {
      if (rule.match(tokens)) {
        return rule.family;
      }
    }
  }

  if (fallbackFamily !== undefined && fallbackFamily.trim().length > 0) {
    return fallbackFamily.trim().toLowerCase();
  }

  const normalizedHarness = harness.trim().toLowerCase();
  if (isBuiltinHarness(normalizedHarness)) {
    return HARNESSES[normalizedHarness].vendorFamily;
  }

  return 'unknown';
}

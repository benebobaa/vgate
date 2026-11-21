/**
 * Vendor-agnostic headless agent runner supporting built-in harnesses and custom YAML runners.
 * Executes with `shell: false`, enforces timeout (SIGTERM -> SIGKILL), and caps output safely.
 */
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { HARNESSES, inferModelFamily, isBuiltinHarness } from './harnesses.ts';

export interface CustomRunnerConfig {
  name: string;
  command: string;
  args: string[];
  promptMode?: 'arg' | 'stdin';
  modelFlag?: string;
  effortFlag?: string;
  env?: Record<string, string>;
  vendorFamily?: string;
  timeoutMs?: number;
}

export interface RunAgentOptions {
  harness: string;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  customRunners?: Record<string, CustomRunnerConfig>;
  maxOutputBytes?: number;
}

export interface RunAgentResult {
  ok: boolean;
  harness: string;
  model?: string;
  family: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  command: string;
  args: string[];
}

export interface BuiltCommand {
  command: string;
  args: string[];
  promptMode: 'arg' | 'stdin';
  family: string;
  env: Record<string, string>;
}

const FORBIDDEN_FLAGS = ['--dangerously-skip-permissions'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function assertSafeFlag(token: string): void {
  const trimmed = token.trim();
  for (const forbidden of FORBIDDEN_FLAGS) {
    if (trimmed === forbidden || trimmed.startsWith(`${forbidden}=`)) {
      throw new Error(`Forbidden flag "${forbidden}" is not allowed in runner arguments`);
    }
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

/**
 * Parses custom runner definitions from a YAML string. Accepts either a top-level map of
 * `{ [name]: runnerConfig }` or `{ runners: { [name]: runnerConfig } }`.
 */
export function parseCustomRunners(yamlContent: string): Record<string, CustomRunnerConfig> {
  const parsed: unknown = parseYaml(yamlContent);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Custom runners YAML must be a mapping');
  }

  const root = parsed as Record<string, unknown>;
  const rawMap =
    'runners' in root && typeof root.runners === 'object' && root.runners !== null && !Array.isArray(root.runners)
      ? (root.runners as Record<string, unknown>)
      : root;

  const result: Record<string, CustomRunnerConfig> = {};
  for (const [key, entry] of Object.entries(rawMap)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Custom runner "${key}" must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' && obj.name.trim().length > 0 ? obj.name.trim() : key;
    if (typeof obj.command !== 'string' || obj.command.trim().length === 0) {
      throw new Error(`Custom runner "${name}" requires a non-empty string "command"`);
    }
    if (!Array.isArray(obj.args) || !obj.args.every((item): item is string => typeof item === 'string')) {
      throw new Error(`Custom runner "${name}" requires a string[] "args"`);
    }
    for (const arg of obj.args) {
      assertSafeFlag(arg);
    }

    const promptMode = obj.promptMode;
    if (promptMode !== undefined && promptMode !== 'arg' && promptMode !== 'stdin') {
      throw new Error(`Custom runner "${name}" has invalid promptMode "${JSON.stringify(promptMode)}"`);
    }
    if (obj.modelFlag !== undefined) {
      if (typeof obj.modelFlag !== 'string') throw new Error(`Custom runner "${name}" modelFlag must be a string`);
      assertSafeFlag(obj.modelFlag);
    }
    if (obj.effortFlag !== undefined) {
      if (typeof obj.effortFlag !== 'string') throw new Error(`Custom runner "${name}" effortFlag must be a string`);
      assertSafeFlag(obj.effortFlag);
    }
    if (obj.env !== undefined && !isStringRecord(obj.env)) {
      throw new Error(`Custom runner "${name}" env must be a string-to-string mapping`);
    }
    if (obj.vendorFamily !== undefined && typeof obj.vendorFamily !== 'string') {
      throw new Error(`Custom runner "${name}" vendorFamily must be a string`);
    }
    if (obj.timeoutMs !== undefined && (typeof obj.timeoutMs !== 'number' || !Number.isFinite(obj.timeoutMs))) {
      throw new Error(`Custom runner "${name}" timeoutMs must be a finite number`);
    }

    result[name] = {
      name,
      command: obj.command,
      args: obj.args,
      ...(promptMode !== undefined ? { promptMode } : {}),
      ...(typeof obj.modelFlag === 'string' ? { modelFlag: obj.modelFlag } : {}),
      ...(typeof obj.effortFlag === 'string' ? { effortFlag: obj.effortFlag } : {}),
      ...(obj.env !== undefined ? { env: obj.env } : {}),
      ...(typeof obj.vendorFamily === 'string' ? { vendorFamily: obj.vendorFamily } : {}),
      ...(typeof obj.timeoutMs === 'number' ? { timeoutMs: obj.timeoutMs } : {}),
    };
  }

  return result;
}

export function buildCommand(options: RunAgentOptions): BuiltCommand {
  const custom = options.customRunners?.[options.harness];
  const builtin = isBuiltinHarness(options.harness) ? HARNESSES[options.harness] : undefined;

  if (!custom && !builtin) {
    const customNames = options.customRunners ? Object.keys(options.customRunners) : [];
    const available = [...Object.keys(HARNESSES), ...customNames].join(', ');
    throw new Error(`Unknown harness "${options.harness}". Available harnesses: ${available}`);
  }

  const command = custom ? custom.command : builtin!.headless.command;
  const rawArgs = custom ? [...custom.args] : [...builtin!.headless.args, ...(builtin!.headless.extraArgs ?? [])];
  const promptMode: 'arg' | 'stdin' = custom ? (custom.promptMode ?? 'arg') : builtin!.headless.promptMode;
  const modelFlag = custom ? custom.modelFlag : builtin!.headless.modelFlag;
  const effortFlag = custom ? custom.effortFlag : builtin!.headless.effortFlag;

  for (const arg of rawArgs) {
    assertSafeFlag(arg);
  }
  if (modelFlag !== undefined) assertSafeFlag(modelFlag);
  if (effortFlag !== undefined) assertSafeFlag(effortFlag);

  let promptSubstituted = false;
  let modelSubstituted = false;
  let effortSubstituted = false;
  const args: string[] = [];

  for (const template of rawArgs) {
    if (template === '{{prompt}}') {
      promptSubstituted = true;
      if (promptMode === 'arg') {
        args.push(options.prompt);
      }
      continue;
    }
    if (template === '{{model}}') {
      modelSubstituted = true;
      if (options.model !== undefined) {
        args.push(options.model);
      }
      continue;
    }
    if (template === '{{effort}}') {
      effortSubstituted = true;
      if (options.effort !== undefined) {
        args.push(options.effort);
      }
      continue;
    }

    const replaced = template.replace(/\{\{(prompt|model|effort)\}\}/g, (_match, key: string) => {
      if (key === 'prompt') {
        promptSubstituted = true;
        return promptMode === 'arg' ? options.prompt : '';
      }
      if (key === 'model') {
        modelSubstituted = true;
        return options.model ?? '';
      }
      if (key === 'effort') {
        effortSubstituted = true;
        return options.effort ?? '';
      }
      return '';
    });

    args.push(replaced);
  }

  if (options.model !== undefined && !modelSubstituted && modelFlag !== undefined) {
    args.push(modelFlag, options.model);
  }

  if (options.effort !== undefined && !effortSubstituted && effortFlag !== undefined) {
    args.push(effortFlag, options.effort);
  }

  if (promptMode === 'arg' && !promptSubstituted) {
    args.push(options.prompt);
  }

  const family = inferModelFamily(options.harness, options.model, custom?.vendorFamily);
  const env: Record<string, string> = {
    ...(custom?.env ?? {}),
    ...(options.env ?? {}),
  };

  return { command, args, promptMode, family, env };
}

interface OutputCollector {
  push: (chunk: Buffer) => void;
  text: () => string;
}

function createOutputCollector(maxBytes: number): OutputCollector {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  return {
    push(chunk: Buffer): void {
      if (truncated || maxBytes <= 0) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - bytes;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        bytes += chunk.length;
      } else {
        chunks.push(chunk.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
      }
    },
    text(): string {
      const content = Buffer.concat(chunks, bytes).toString('utf8');
      return truncated ? `${content}\n[output truncated]` : content;
    },
  };
}

const AGENT_BLOCKED_ENV: readonly RegExp[] = [
  /^VGATE_SIGNING_/i,
  /^VGATE_ALLOW_AUTONOMY$/i,
  /^VGATE_OIDC_/i,
  /^VGATE_FACTORY_TOKEN$/i,
  /^VGATE_WEBHOOK_SECRET$/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^GITLAB_TOKEN$/i,
  /^CI_JOB_TOKEN$/i,
  /^AWS_/i,
  /^GCP_/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^SLACK_/i,
  /^LINEAR_/i,
  /^JIRA_/i,
  /^SENTRY_/i,
  /^STRIPE_/i,
  /_WEBHOOK_SECRET$/i,
  /_ADMIN_TOKEN$/i,
  /_BOT_TOKEN$/i,
];

function stripJudgeSecrets(env: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...env, ...extra })) {
    if (value === undefined) continue;
    if (AGENT_BLOCKED_ENV.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

export function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const built = buildCommand(options);
  const custom = options.customRunners?.[options.harness];
  const timeoutMs = options.timeoutMs ?? custom?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  return new Promise<RunAgentResult>((resolvePromise) => {
    const child = spawn(built.command, built.args, {
      cwd: options.cwd,
      env: stripJudgeSecrets(process.env, built.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutCollector = createOutputCollector(maxOutputBytes);
    const stderrCollector = createOutputCollector(maxOutputBytes);
    let timedOut = false;
    let settled = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const cleanupTimers = (): void => {
      if (termTimer !== undefined) {
        clearTimeout(termTimer);
        termTimer = undefined;
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    const finish = (exitCode: number | null, spawnErrorMessage?: string): void => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      const stderrText = stderrCollector.text();
      const stderr = spawnErrorMessage
        ? stderrText.length > 0
          ? `${stderrText}\n${spawnErrorMessage}`
          : spawnErrorMessage
        : stderrText;

      resolvePromise({
        ok: exitCode === 0 && !timedOut && spawnErrorMessage === undefined,
        harness: options.harness,
        ...(options.model !== undefined ? { model: options.model } : {}),
        family: built.family,
        exitCode,
        timedOut,
        durationMs: Math.max(0, Date.now() - startedAt),
        stdout: stdoutCollector.text(),
        stderr,
        command: built.command,
        args: built.args,
      });
    };

    child.stdout.on('data', (chunk: Buffer) => stdoutCollector.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrCollector.push(chunk));

    child.stdin.on('error', () => {
      // Child may exit before consuming stdin; ignore EPIPE.
    });
    if (built.promptMode === 'stdin') {
      child.stdin.end(options.prompt, 'utf8');
    } else {
      child.stdin.end();
    }

    if (timeoutMs > 0) {
      termTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        const graceMs = Math.min(2000, Math.max(100, Math.floor(timeoutMs / 2)));
        killTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, graceMs);
        killTimer.unref();
      }, timeoutMs);
      termTimer.unref();
    }

    child.on('error', (error: Error) => {
      finish(null, error.message);
    });

    child.on('close', (code: number | null) => {
      finish(code);
    });
  });
}

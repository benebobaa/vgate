/**
 * Built-in zero-dependency stdio JSON-RPC 2.0 MCP server (`vgate mcp`) targeting MCP 2025-03-26.
 */
import process from 'node:process';
import { createInterface } from 'node:readline';

export const MCP_PROTOCOL_VERSION = '2025-03-26';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown;
}

export interface VgateMcpServerOptions {
  name?: string;
  version?: string;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const JSON_RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPreformattedToolResult(value: unknown): value is { content: unknown[]; isError?: boolean } {
  return isRecord(value) && Array.isArray(value.content);
}

function okResponse(id: string | number | null, result: unknown): string {
  const payload: JsonRpcSuccessResponse = { jsonrpc: '2.0', id, result };
  return JSON.stringify(payload);
}

function errResponse(id: string | number | null, code: number, message: string, data?: unknown): string {
  const payload: JsonRpcErrorResponse = {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
  return JSON.stringify(payload);
}

export class VgateMcpServer {
  private readonly tools = new Map<string, McpToolDef>();
  private readonly serverName: string;
  private readonly serverVersion: string;
  private initialized = false;

  constructor(tools: readonly McpToolDef[], options: VgateMcpServerOptions = {}) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
    this.serverName = options.name ?? 'vgate';
    this.serverVersion = options.version ?? '1.0.0';
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  async handleMessage(raw: string): Promise<string | null> {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Invalid JSON';
      return errResponse(null, JSON_RPC_ERROR.PARSE_ERROR, `Parse error: ${message}`);
    }

    if (!isRecord(parsed)) {
      return errResponse(null, JSON_RPC_ERROR.INVALID_REQUEST, 'Invalid Request: expected JSON object');
    }

    const request = parsed as unknown as JsonRpcRequest;
    const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id');
    const id = hasId ? (request.id ?? null) : undefined;

    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.method.length === 0) {
      return errResponse(
        id ?? null,
        JSON_RPC_ERROR.INVALID_REQUEST,
        'Invalid Request: missing jsonrpc "2.0" or method',
      );
    }

    if (hasId && id !== null && typeof id !== 'string' && typeof id !== 'number') {
      return errResponse(null, JSON_RPC_ERROR.INVALID_REQUEST, 'Invalid Request: id must be string, number, or null');
    }

    const isNotification = !hasId;

    switch (request.method) {
      case 'initialize': {
        if (isNotification) return null;
        return okResponse(id ?? null, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: this.serverName,
            version: this.serverVersion,
          },
        });
      }

      case 'notifications/initialized': {
        this.initialized = true;
        return isNotification ? null : okResponse(id ?? null, {});
      }

      case 'ping': {
        return isNotification ? null : okResponse(id ?? null, {});
      }

      case 'tools/list': {
        if (isNotification) return null;
        const tools = Array.from(this.tools.values()).map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        }));
        return okResponse(id ?? null, { tools });
      }

      case 'tools/call': {
        if (isNotification) return null;
        if (!isRecord(request.params) || typeof request.params.name !== 'string' || request.params.name.length === 0) {
          return errResponse(id ?? null, JSON_RPC_ERROR.INVALID_PARAMS, 'Invalid params: missing tool name');
        }

        const toolName = request.params.name;
        const tool = this.tools.get(toolName);
        if (!tool) {
          return errResponse(id ?? null, JSON_RPC_ERROR.INVALID_PARAMS, `Unknown tool: ${toolName}`);
        }

        const rawArgs = request.params.arguments;
        if (rawArgs !== undefined && !isRecord(rawArgs)) {
          return errResponse(id ?? null, JSON_RPC_ERROR.INVALID_PARAMS, 'Invalid params: arguments must be an object');
        }

        try {
          const result = await tool.handler(rawArgs ?? {});
          if (isPreformattedToolResult(result)) {
            return okResponse(id ?? null, result);
          }
          const text = typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2);
          return okResponse(id ?? null, {
            content: [{ type: 'text', text }],
            isError: false,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return okResponse(id ?? null, {
            content: [{ type: 'text', text: message }],
            isError: true,
          });
        }
      }

      default: {
        if (isNotification) return null;
        return errResponse(id ?? null, JSON_RPC_ERROR.METHOD_NOT_FOUND, `Method not found: ${request.method}`);
      }
    }
  }

  async serveStdio(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const response = await this.handleMessage(line);
        if (response !== null) {
          output.write(`${response}\n`);
        }
      }
    } finally {
      rl.close();
    }
  }
}

function appendStringFlag(out: string[], flag: string, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    out.push(flag, value);
  }
}

function appendBoolFlag(out: string[], flag: string, value: unknown): void {
  if (value === true) {
    out.push(flag);
  }
}

export function createDefaultTools(executor: (cmd: string, args: string[]) => Promise<unknown>): McpToolDef[] {
  return [
    {
      name: 'vgate_doctor',
      description: 'Run vgate environment, tooling, and project configuration diagnostics.',
      inputSchema: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Optional service name to diagnose.' },
        },
        additionalProperties: false,
      },
      handler: (args) => {
        const cliArgs: string[] = [];
        appendStringFlag(cliArgs, '--service', args.service);
        return executor('doctor', cliArgs);
      },
    },
    {
      name: 'vgate_services',
      description: 'List configured services and their verification definitions.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: () => executor('services', []),
    },
    {
      name: 'vgate_lint',
      description: 'Run polyglot guardrails (guardrails.yaml boundaries, banned patterns, ratchets, fixtures).',
      inputSchema: {
        type: 'object',
        properties: {
          test: { type: 'boolean', description: 'Run rule fixture self-tests (--test).' },
          skipNative: { type: 'boolean', description: 'Skip external native linters (--skip-native).' },
          files: { type: 'string', description: 'Comma-separated file paths to lint (--files).' },
        },
        additionalProperties: false,
      },
      handler: (args) => {
        const cliArgs: string[] = [];
        appendBoolFlag(cliArgs, '--test', args.test);
        appendBoolFlag(cliArgs, '--skip-native', args.skipNative);
        appendStringFlag(cliArgs, '--files', args.files);
        return executor('lint', cliArgs);
      },
    },
    {
      name: 'vgate_gate',
      description: 'Run the deterministic vgate verification gate.',
      inputSchema: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service name to run (--service).' },
          env: { type: 'string', description: 'Target environment name (--env).' },
          steps: { type: 'string', description: 'Comma-separated subset of steps (--steps).' },
        },
        additionalProperties: false,
      },
      handler: (args) => {
        const cliArgs: string[] = [];
        appendStringFlag(cliArgs, '--service', args.service);
        appendStringFlag(cliArgs, '--env', args.env);
        appendStringFlag(cliArgs, '--steps', args.steps);
        return executor('gate', cliArgs);
      },
    },
    {
      name: 'vgate_guard',
      description: 'Run the vgate expectation guard to detect weakened assertions, guardrails, or gate machinery.',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Base git ref to diff against (--base).' },
          service: { type: 'string', description: 'Optional service name; omit for repo-level guard (--service).' },
        },
        required: ['base'],
        additionalProperties: false,
      },
      handler: (args) => {
        const cliArgs: string[] = [];
        appendStringFlag(cliArgs, '--base', args.base);
        appendStringFlag(cliArgs, '--service', args.service);
        return executor('guard', cliArgs);
      },
    },
    {
      name: 'vgate_decide',
      description: 'Evaluate verification evidence and produce a merge decision (merge | needs-approval | blocked).',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Base git ref to judge against (--base).' },
          evidence: { type: 'string', description: 'Directory containing evidence reports (--evidence).' },
        },
        required: ['base', 'evidence'],
        additionalProperties: false,
      },
      handler: (args) => {
        const cliArgs: string[] = [];
        appendStringFlag(cliArgs, '--base', args.base);
        appendStringFlag(cliArgs, '--evidence', args.evidence);
        return executor('decide', cliArgs);
      },
    },
    {
      name: 'vgate_maturity',
      description: 'Report verification maturity level and blockers for the next phase.',
      inputSchema: {
        type: 'object',
        properties: {
          require: { type: 'string', description: 'Optional phase threshold 1..5 (--require).' },
        },
        additionalProperties: false,
      },
      handler: (args) => {
        const cliArgs: string[] = [];
        appendStringFlag(cliArgs, '--require', args.require);
        return executor('maturity', cliArgs);
      },
    },
    {
      name: 'vgate_metrics',
      description: 'Retrieve local-first 5-KPI engineering metrics.',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'string', description: 'Lookback window in days, e.g. 30 (--days).' },
          format: { type: 'string', description: 'Output format: text | html | otel (--format).' },
        },
        additionalProperties: false,
      },
      handler: (args) => {
        const cliArgs: string[] = ['report'];
        appendStringFlag(cliArgs, '--days', args.days);
        appendStringFlag(cliArgs, '--format', args.format);
        return executor('metrics', cliArgs);
      },
    },
    {
      name: 'vgate_verify',
      description: 'Run independent cross-vendor live-app verification against a change set.',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Base git ref to verify against (--base).' },
          mode: { type: 'string', description: 'Verifier mode: auto | full | single | skip (--mode).' },
          verifiers: { type: 'string', description: 'Number of independent verifiers (--verifiers).' },
          authorHarness: {
            type: 'string',
            description: 'Author harness name for separation of powers (--author-harness).',
          },
          authorModel: { type: 'string', description: 'Author model name (--author-model).' },
        },
        required: ['base'],
        additionalProperties: false,
      },
      handler: (args) => {
        const cliArgs: string[] = [];
        appendStringFlag(cliArgs, '--base', args.base);
        appendStringFlag(cliArgs, '--mode', args.mode);
        appendStringFlag(cliArgs, '--verifiers', args.verifiers);
        appendStringFlag(cliArgs, '--author-harness', args.authorHarness);
        appendStringFlag(cliArgs, '--author-model', args.authorModel);
        return executor('verify', cliArgs);
      },
    },
    {
      name: 'vgate_status',
      description: 'Show current vgate workspace health, services, and latest gate status.',
      inputSchema: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Optional service name.' },
        },
        additionalProperties: false,
      },
      handler: (args) => {
        const cliArgs: string[] = [];
        appendStringFlag(cliArgs, '--service', args.service);
        return executor('status', cliArgs);
      },
    },
  ];
}

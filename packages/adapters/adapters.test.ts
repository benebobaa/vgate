import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';
import {
  BUILTIN_HARNESSES,
  HARNESSES,
  MCP_PROTOCOL_VERSION,
  VgateMcpServer,
  buildCommand,
  createDefaultTools,
  inferModelFamily,
  parseCustomRunners,
  projectSkills,
  resolveHarnesses,
  runAgent,
  type CustomRunnerConfig,
  type SkillBundle,
} from './index.ts';

const scratch = mkdtempSync(join(tmpdir(), 'vgate-adapters-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('harnesses', () => {
  it('defines all 8 built-in harnesses with expected paths, formats, and headless specs', () => {
    assert.deepEqual(BUILTIN_HARNESSES, ['agy', 'claude', 'cursor', 'codex', 'opencode', 'pi', 'omp', 'grokbot']);

    assert.equal(HARNESSES.agy.skillsDir, '.agents/skills');
    assert.equal(HARNESSES.agy.instructionsFile, 'AGENTS.md');
    assert.equal(HARNESSES.agy.format, 'agents-md');
    assert.equal(HARNESSES.agy.vendorFamily, 'google');
    assert.equal(HARNESSES.agy.headless.command, 'agy');
    assert.deepEqual(HARNESSES.agy.headless.args, ['-p', '{{prompt}}', '--print-timeout', '0']);

    assert.equal(HARNESSES.claude.skillsDir, '.claude/skills');
    assert.equal(HARNESSES.claude.instructionsFile, 'CLAUDE.md');
    assert.equal(HARNESSES.claude.format, 'claude-md');
    assert.equal(HARNESSES.claude.vendorFamily, 'anthropic');
    assert.equal(HARNESSES.claude.headless.command, 'claude');
    assert.deepEqual(HARNESSES.claude.headless.args, ['-p', '{{prompt}}', '--output-format', 'text']);

    assert.equal(HARNESSES.cursor.skillsDir, '.cursor/skills');
    assert.equal(HARNESSES.cursor.instructionsFile, '.cursor/rules/vgate.mdc');
    assert.equal(HARNESSES.cursor.format, 'cursor-mdc');
    assert.equal(HARNESSES.cursor.vendorFamily, 'cursor');
    assert.equal(HARNESSES.cursor.headless.command, 'agent');
    assert.deepEqual(HARNESSES.cursor.headless.args, ['-p', '{{prompt}}']);

    assert.equal(HARNESSES.codex.skillsDir, '.agents/skills');
    assert.equal(HARNESSES.codex.instructionsFile, 'AGENTS.md');
    assert.equal(HARNESSES.codex.vendorFamily, 'openai');
    assert.equal(HARNESSES.codex.headless.command, 'codex');
    assert.deepEqual(HARNESSES.codex.headless.args, ['exec', '{{prompt}}']);

    assert.equal(HARNESSES.opencode.skillsDir, '.agents/skills');
    assert.equal(HARNESSES.opencode.vendorFamily, 'multi');
    assert.equal(HARNESSES.opencode.headless.command, 'opencode');
    assert.deepEqual(HARNESSES.opencode.headless.args, ['run', '{{prompt}}']);

    assert.equal(HARNESSES.pi.skillsDir, '.agents/skills');
    assert.equal(HARNESSES.pi.vendorFamily, 'multi');
    assert.equal(HARNESSES.pi.headless.command, 'pi');

    assert.equal(HARNESSES.omp.skillsDir, '.agents/skills');
    assert.equal(HARNESSES.omp.vendorFamily, 'multi');
    assert.equal(HARNESSES.omp.headless.command, 'omp');

    assert.equal(HARNESSES.grokbot.skillsDir, '.grokbot/skills');
    assert.equal(HARNESSES.grokbot.instructionsFile, 'AGENTS.md');
    assert.equal(HARNESSES.grokbot.vendorFamily, 'xai');
    assert.equal(HARNESSES.grokbot.headless.command, 'grokbot');
    assert.deepEqual(HARNESSES.grokbot.headless.args, ['run', '--prompt', '{{prompt}}']);

    for (const id of BUILTIN_HARNESSES) {
      assert.equal(HARNESSES[id].id, id);
      assert.equal(HARNESSES[id].headless.promptMode, 'arg');
      assert.equal(HARNESSES[id].headless.modelFlag, '--model');
    }
  });

  it('resolves all, comma-separated, array, and deduplicated harness inputs', () => {
    assert.equal(resolveHarnesses(undefined).length, 8);
    assert.equal(resolveHarnesses('all').length, 8);
    assert.equal(resolveHarnesses([]).length, 8);

    const list = resolveHarnesses('claude, agy , claude,cursor');
    assert.deepEqual(
      list.map((h) => h.id),
      ['claude', 'agy', 'cursor'],
    );

    const fromArray = resolveHarnesses(['codex,pi', 'pi', 'omp']);
    assert.deepEqual(
      fromArray.map((h) => h.id),
      ['codex', 'pi', 'omp'],
    );
  });

  it('throws a clear error on unknown harnesses', () => {
    assert.throws(
      () => resolveHarnesses('agy,unknown-agent'),
      (error: unknown) =>
        error instanceof Error && /unknown-agent/.test(error.message) && /agy, claude/.test(error.message),
    );
  });

  it('infers model vendor family from model name first and falls back to harness vendorFamily', () => {
    assert.equal(inferModelFamily('agy', 'claude-opus-5-5-high'), 'anthropic');
    assert.equal(inferModelFamily('claude', 'gemini-4-neon'), 'google');
    assert.equal(inferModelFamily('opencode', 'gpt-5'), 'openai');
    assert.equal(inferModelFamily('opencode', 'o3-mini'), 'openai');
    assert.equal(inferModelFamily('pi', 'grok-4'), 'xai');
    assert.equal(inferModelFamily('omp', 'deepseek-r1'), 'deepseek');
    assert.equal(inferModelFamily('opencode', 'meta-llama/llama-3.3-70b'), 'meta');
    assert.equal(inferModelFamily('agy'), 'google');
    assert.equal(inferModelFamily('claude'), 'anthropic');
    assert.equal(inferModelFamily('codex'), 'openai');
    assert.equal(inferModelFamily('grokbot'), 'xai');
    assert.equal(inferModelFamily('cursor'), 'cursor');
    assert.equal(inferModelFamily('opencode'), 'multi');
    assert.equal(inferModelFamily('custom-tool', 'unrecognized-model', 'acme'), 'acme');
    assert.equal(inferModelFamily('custom-tool'), 'unknown');
  });
});

describe('compiler (projectSkills)', () => {
  const bundle: SkillBundle = {
    'vgate-gate': {
      'SKILL.md': '---\nname: vgate-gate\ndescription: Run vgate gate.\n---\n\n# Gate\n',
      'references/checks.md': '# Checks\n',
    },
    'vgate-guard': {
      'SKILL.md': '---\nname: vgate-guard\ndescription: Run vgate guard.\n---\n\n# Guard\n',
    },
  };

  it('deduplicates shared .agents/skills and AGENTS.md across harnesses', () => {
    const root = join(scratch, 'dedup');
    mkdirSync(root, { recursive: true });

    const harnesses = resolveHarnesses('agy,codex,opencode,pi,omp,claude,cursor,grokbot');
    const first = projectSkills({ root, harnesses, bundle });

    // 4 distinct skillsDirs: .agents/skills, .claude/skills, .cursor/skills, .grokbot/skills -> 4 * 2 = 8 entries
    assert.equal(first.projected.length, 8);
    assert.equal(first.projected.filter((p) => p.targetDir === '.agents/skills').length, 2);
    assert.ok(first.projected.every((p) => p.result === 'installed'));

    // 3 distinct instruction files: AGENTS.md, CLAUDE.md, .cursor/rules/vgate.mdc
    assert.equal(first.instructions.length, 3);
    assert.deepEqual(
      first.instructions.map((i) => [i.file, i.result]),
      [
        ['AGENTS.md', 'created'],
        ['CLAUDE.md', 'created'],
        ['.cursor/rules/vgate.mdc', 'created'],
      ],
    );

    assert.ok(existsSync(join(root, '.agents/skills/vgate-gate/references/checks.md')));
    assert.ok(existsSync(join(root, '.claude/skills/vgate-guard/SKILL.md')));
    assert.ok(existsSync(join(root, '.cursor/skills/vgate-gate/SKILL.md')));
    assert.ok(existsSync(join(root, '.grokbot/skills/vgate-guard/SKILL.md')));

    // Cursor .mdc frontmatter validation
    const cursorMdc = readFileSync(join(root, '.cursor/rules/vgate.mdc'), 'utf8');
    assert.match(cursorMdc, /^---\ndescription: .+\nalwaysApply: true\n---\n/);
    assert.match(cursorMdc, /vgate-gate/);

    // Second run is completely unchanged
    const second = projectSkills({ root, harnesses, bundle });
    assert.ok(second.projected.every((p) => p.result === 'unchanged'));
    assert.ok(second.instructions.every((i) => i.result === 'unchanged'));
  });

  it('appends pointer section idempotently to pre-existing AGENTS.md and CLAUDE.md', () => {
    const root = join(scratch, 'append');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), '# Project Rules\n\nExisting rules.\n', 'utf8');
    writeFileSync(join(root, 'CLAUDE.md'), '# Claude Rules\n', 'utf8');

    const harnesses = resolveHarnesses('agy,claude');
    const first = projectSkills({
      root,
      harnesses,
      bundle,
      pointerMarker: '<!-- custom:vgate -->',
      pointerSection: '<!-- custom:vgate -->\n## Verification\nRun `vgate gate`.\n',
    });

    assert.deepEqual(
      first.instructions.map((i) => [i.file, i.result]),
      [
        ['AGENTS.md', 'appended'],
        ['CLAUDE.md', 'appended'],
      ],
    );

    const agentsMd = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    assert.match(agentsMd, /^# Project Rules/);
    assert.match(agentsMd, /<!-- custom:vgate -->/);

    const second = projectSkills({
      root,
      harnesses,
      bundle,
      pointerMarker: '<!-- custom:vgate -->',
      pointerSection: '<!-- custom:vgate -->\n## Verification\nRun `vgate gate`.\n',
    });
    assert.deepEqual(
      second.instructions.map((i) => [i.file, i.result]),
      [
        ['AGENTS.md', 'unchanged'],
        ['CLAUDE.md', 'unchanged'],
      ],
    );
  });

  it('supports dryRun, skill filtering, and updated detection', () => {
    const root = join(scratch, 'dry-and-update');
    mkdirSync(root, { recursive: true });

    const dry = projectSkills({
      root,
      harnesses: resolveHarnesses('agy'),
      bundle,
      names: ['vgate-gate'],
      dryRun: true,
    });
    assert.equal(dry.projected.length, 1);
    assert.equal(dry.projected[0].result, 'installed');
    assert.equal(dry.instructions[0].result, 'created');
    assert.ok(!existsSync(join(root, '.agents/skills')));
    assert.ok(!existsSync(join(root, 'AGENTS.md')));

    projectSkills({ root, harnesses: resolveHarnesses('agy'), bundle, names: ['vgate-gate'] });
    writeFileSync(join(root, '.agents/skills/vgate-gate/SKILL.md'), 'modified', 'utf8');

    const updated = projectSkills({ root, harnesses: resolveHarnesses('agy'), bundle, names: ['vgate-gate'] });
    assert.equal(updated.projected[0].result, 'updated');
    assert.equal(
      readFileSync(join(root, '.agents/skills/vgate-gate/SKILL.md'), 'utf8'),
      bundle['vgate-gate']['SKILL.md'],
    );
  });

  it('rejects unknown skill names and path traversal in bundle files', () => {
    const root = join(scratch, 'errors');
    mkdirSync(root, { recursive: true });
    assert.throws(
      () => projectSkills({ root, harnesses: resolveHarnesses('agy'), bundle, names: ['missing-skill'] }),
      /Unknown skill missing-skill/,
    );
    assert.throws(
      () =>
        projectSkills({
          root,
          harnesses: resolveHarnesses('agy'),
          bundle: { bad: { '../../escape.txt': 'nope' } },
        }),
      /Unsafe skill file path/,
    );
  });
});

describe('runner (buildCommand, parseCustomRunners, runAgent)', () => {
  it('builds commands for built-in harnesses without shell injection or forbidden flags', () => {
    const built = buildCommand({
      harness: 'agy',
      prompt: 'Review diff with {{model}} and $(rm -rf /)',
      cwd: scratch,
      model: 'claude-opus-5-5-high',
    });

    assert.equal(built.command, 'agy');
    assert.deepEqual(built.args, [
      '-p',
      'Review diff with {{model}} and $(rm -rf /)',
      '--print-timeout',
      '0',
      '--model',
      'claude-opus-5-5-high',
    ]);
    assert.equal(built.promptMode, 'arg');
    assert.equal(built.family, 'anthropic');
  });

  it('refuses --dangerously-skip-permissions in custom runner configs', () => {
    assert.throws(
      () =>
        buildCommand({
          harness: 'unsafe',
          prompt: 'hello',
          cwd: scratch,
          customRunners: {
            unsafe: {
              name: 'unsafe',
              command: 'claude',
              args: ['-p', '{{prompt}}', '--dangerously-skip-permissions'],
            },
          },
        }),
      /Forbidden flag "--dangerously-skip-permissions"/,
    );
  });

  it('parses custom YAML runners and executes arg mode and stdin mode safely', async () => {
    const yamlConfig = `
runners:
  echo-arg:
    command: ${process.execPath}
    args:
      - -e
      - "process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), tag: process.env.TEST_TAG }))"
      - --
      - "{{prompt}}"
      - "{{model}}"
      - "{{effort}}"
    promptMode: arg
    vendorFamily: custom-vendor
    env:
      TEST_TAG: from-yaml
  echo-stdin:
    command: ${process.execPath}
    args:
      - -e
      - "let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => data += c); process.stdin.on('end', () => process.stdout.write('STDIN:' + data));"
    promptMode: stdin
    vendorFamily: xai
`;
    const customRunners = parseCustomRunners(yamlConfig);
    assert.ok('echo-arg' in customRunners);
    assert.ok('echo-stdin' in customRunners);

    const trickyPrompt = `hello $(echo injected) ; 'quoted' "double" $HOME`;
    const argResult = await runAgent({
      harness: 'echo-arg',
      prompt: trickyPrompt,
      cwd: scratch,
      model: 'gpt-5',
      effort: 'high',
      customRunners,
    });

    assert.equal(argResult.ok, true);
    assert.equal(argResult.exitCode, 0);
    assert.equal(argResult.timedOut, false);
    assert.equal(argResult.family, 'openai');
    const parsedArgOut = JSON.parse(argResult.stdout) as { argv: string[]; tag: string };
    assert.deepEqual(parsedArgOut.argv, [trickyPrompt, 'gpt-5', 'high']);
    assert.equal(parsedArgOut.tag, 'from-yaml');

    const stdinResult = await runAgent({
      harness: 'echo-stdin',
      prompt: 'multiline\nprompt\nbody',
      cwd: scratch,
      customRunners,
    });

    assert.equal(stdinResult.ok, true);
    assert.equal(stdinResult.exitCode, 0);
    assert.equal(stdinResult.family, 'xai');
    assert.equal(stdinResult.stdout, 'STDIN:multiline\nprompt\nbody');
  });

  it('enforces timeout with SIGTERM -> SIGKILL fallback and caps large output', async () => {
    const runners: Record<string, CustomRunnerConfig> = {
      sleeper: {
        name: 'sleeper',
        command: process.execPath,
        // Ignore SIGTERM so SIGKILL fallback is also exercised
        args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        promptMode: 'stdin',
      },
      noisy: {
        name: 'noisy',
        command: process.execPath,
        args: ['-e', "process.stdout.write('A'.repeat(2000));"],
        promptMode: 'stdin',
      },
      missing: {
        name: 'missing',
        command: 'vgate-nonexistent-binary-xyz',
        args: [],
        promptMode: 'stdin',
      },
    };

    const timedOut = await runAgent({
      harness: 'sleeper',
      prompt: '',
      cwd: scratch,
      timeoutMs: 150,
      customRunners: runners,
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timedOut, true);

    const capped = await runAgent({
      harness: 'noisy',
      prompt: '',
      cwd: scratch,
      maxOutputBytes: 64,
      customRunners: runners,
    });
    assert.equal(capped.ok, true);
    assert.match(capped.stdout, /^A{64}\n\[output truncated\]$/);

    const missing = await runAgent({
      harness: 'missing',
      prompt: '',
      cwd: scratch,
      customRunners: runners,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.exitCode, null);
    assert.match(missing.stderr, /ENOENT/);
  });
});

describe('mcp (VgateMcpServer & createDefaultTools)', () => {
  it('handles initialize, notifications/initialized, ping, tools/list, tools/call, and errors', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const tools = createDefaultTools((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'doctor') {
        return Promise.resolve({ ok: true, checks: 5 });
      }
      if (cmd === 'lint') {
        return Promise.reject(new Error('lint failed: 1 violation'));
      }
      return Promise.resolve({ cmd, args });
    });

    const server = new VgateMcpServer(tools, { name: 'vgate', version: '0.1.0' });

    // 1. initialize
    const initRaw = await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: 'test', version: '1.0' } },
      }),
    );
    assert.ok(initRaw !== null);
    const init = JSON.parse(initRaw) as {
      jsonrpc: string;
      id: number;
      result: {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: { tools: unknown };
      };
    };
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result.serverInfo, { name: 'vgate', version: '0.1.0' });
    assert.ok(init.result.capabilities.tools);

    // 2. notifications/initialized -> no response
    const notif = await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.equal(notif, null);
    assert.equal(server.isInitialized, true);

    // 3. ping
    const pingRaw = await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }));
    assert.deepEqual(JSON.parse(pingRaw!), { jsonrpc: '2.0', id: 2, result: {} });

    // 4. tools/list
    const listRaw = await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
    const listed = JSON.parse(listRaw!) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    assert.deepEqual(
      listed.result.tools.map((t) => t.name),
      [
        'vgate_doctor',
        'vgate_services',
        'vgate_lint',
        'vgate_gate',
        'vgate_guard',
        'vgate_decide',
        'vgate_maturity',
        'vgate_metrics',
        'vgate_verify',
        'vgate_status',
      ],
    );

    // 5. tools/call (success)
    const callRaw = await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'vgate_gate', arguments: { service: 'orders', steps: 'test,coverage', env: 'local' } },
      }),
    );
    const callRes = JSON.parse(callRaw!) as {
      result: { isError: boolean; content: Array<{ type: string; text: string }> };
    };
    assert.equal(callRes.result.isError, false);
    assert.deepEqual(calls.at(-1), {
      cmd: 'gate',
      args: ['--service', 'orders', '--env', 'local', '--steps', 'test,coverage'],
    });

    // 6. tools/call (handler throws -> MCP tool error result)
    const errToolRaw = await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'vgate_lint', arguments: {} },
      }),
    );
    const errToolRes = JSON.parse(errToolRaw!) as {
      result: { isError: boolean; content: Array<{ type: string; text: string }> };
    };
    assert.equal(errToolRes.result.isError, true);
    assert.match(errToolRes.result.content[0].text, /lint failed/);

    // 7. tools/call (unknown tool -> JSON-RPC -32602 error)
    const unknownToolRaw = await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'vgate_nonexistent', arguments: {} },
      }),
    );
    const unknownToolRes = JSON.parse(unknownToolRaw!) as { error: { code: number; message: string } };
    assert.equal(unknownToolRes.error.code, -32602);
    assert.match(unknownToolRes.error.message, /Unknown tool: vgate_nonexistent/);

    // 8. Unknown method & parse error
    const badMethodRaw = await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'bogus/method' }));
    assert.equal((JSON.parse(badMethodRaw!) as { error: { code: number } }).error.code, -32601);

    const parseErrRaw = await server.handleMessage('{not valid json');
    assert.equal((JSON.parse(parseErrRaw!) as { error: { code: number } }).error.code, -32700);
  });

  it('serves newline-delimited JSON-RPC over stdio streams', async () => {
    const server = new VgateMcpServer(createDefaultTools((cmd) => Promise.resolve({ ok: true, cmd })));
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const done = server.serveStdio(input, output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vgate_status', arguments: {} } })}\n`,
    );
    input.end();
    await done;

    const lines = chunks
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number; result: unknown });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].id, 1);
    assert.equal(lines[1].id, 2);
  });
});

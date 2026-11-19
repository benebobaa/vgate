/**
 * `init`: makes any repository a vgate project. It writes vgate.yaml (pinned to this vgate), one service's skeleton,
 * the .gitignore entries for what vgate generates, the agent skills, a pointer for the repository's agents and,
 * with --ci, the CI template. It never overwrites a file it did not write without --force, and running it again
 * changes nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { PROJECT_FILE, readProject } from '../framework/project.ts';
import { CLI, EXIT, UsageError, type Result } from './output.ts';
import { ciTemplates, type Runtime } from './runtime.ts';
import { skills } from './skills.ts';
import { VERSION } from './version.ts';

export const SERVICE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
export const AGENT_SECTION = '## Verification gate (vgate)';

/** One file `init` manages. `create`: written whole. `lines`: these lines appended when absent. `section`: appended
 * once, recognised by its first line. */
export interface Planned {
  path: string;
  kind: 'create' | 'lines' | 'section';
  content: string;
}

export interface InitInput {
  root: string;
  version: string;
  service: string;
  /** Relative services and reports directories, from an existing vgate.yaml or the defaults. */
  servicesDir: string;
  reportsDir: string;
  /** Write vgate.yaml (false when the project already has one). */
  writeProjectFile: boolean;
  /** CI template files by project path, when --ci was given. */
  ci?: Record<string, string>;
  /** The agent instruction files that exist (AGENTS.md, CLAUDE.md). */
  agentFiles: string[];
}

const upper = (service: string) => service.toUpperCase().replace(/-/g, '_');

function serviceYaml(service: string): string {
  return `# ${service}: what vgate verifies and how it reaches the service. Every option: docs/project-layout.md of vgate.
name: ${service}
spec: openapi.yaml # the backend's contract, vendored (the generate-api-tests skill replaces the placeholder)

rules:
  strictResponseProperties: true # a response field the contract does not declare fails the gate
  # datetimeOffset: Z            # every datetime in a response carries this UTC offset
  # headers:
  #   always: { X-Request-Id: '/^.+$/' }

schemathesis:
  readOnlyMethods: [GET] # the operations safe to call with generated input in any environment

environments:
  local:
    disposable: true # local data may be wiped and faults injected
    baseUrl: \${${upper(service)}_URL:-http://localhost:8080}
    healthPath: /health
    # auth: { header: Authorization, scheme: Bearer }
    users:
      anonymous: {}
      # member: { token: '\${${upper(service)}_MEMBER_TOKEN}', role: member }
`;
}

function contract(service: string): string {
  return `# Placeholder: replace it with the backend's own contract (the generate-api-tests skill vendors it).
openapi: 3.1.0
info:
  title: ${service}
  version: 0.0.0
paths:
  /health:
    get:
      operationId: health
      responses:
        '200':
          description: The service is up.
`;
}

function inventory(service: string): string {
  return `# Test plan of ${service}: every scenario cites its source; the generate-api-tests skill writes the real one.
service: ${service}
contract: openapi.yaml

operations:
  - id: health
    operation: GET /health
    area: HEALTH
    scenarios:
      - id: HEALTH-200
        title: answers 200 while the service is up
        source: openapi.yaml
`;
}

const FIXTURES = `import { createTest, expect } from '@vgate/framework/fixtures.ts';
import type { paths } from '../generated/openapi.ts';

/** The framework's test, typed by this service's contract. Add the service's own fixtures here. */
export const test = createTest<paths>();

export { expect };
`;

const SPEC = `import { expect, test } from '../support/fixtures.ts';

// Source: openapi.yaml. Every response is also held to the contract by the framework's client.

test.describe('GET /health', () => {
  test('[HEALTH-200] answers 200 while the service is up', async ({ api }) => {
    const res = await api.anonymous().get('/health');
    expect(res.status).toBe(200);
  });
});
`;

function stackScript(service: string): string {
  return `#!/usr/bin/env bash
# Local stack of ${service}: how vgate starts, stops and resets the service under test.
#   ${CLI} up|down|status|reset --service ${service}
# up() must start this checkout's service and leave it answering at its health URL. Prefer declaring an
# \`environment:\` in service.yaml instead (vgate then starts a sealed copy per run and this file can go).
# Building blocks (app_up, app_start, app_wait, wait_until, http_ok, app_status): the stack library vgate names below.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1090
source "\${VGATE_STACK_LIB:?run through vgate: ${CLI} up --service ${service}}"
stack_init ${service}

HEALTH="\${${upper(service)}_URL:-http://localhost:8080}/health"
PORT=$(url_port "$HEALTH") # the port up() starts the app on; status names whatever else holds it

up() {
  # Start it with app_up, which reuses only the app this project started from this build and refuses (exit 3) when
  # something else answers on the port - another checkout's app must never be tested in this code's place:
  #   app_up "$HEALTH" "$PORT" 60 "$STACK_ROOT" <the command that starts the app>
  echo "${service}: up() starts nothing yet; teach it in $HERE/stack.sh (see the comment above)" >&2
  return 1
}

down() { app_stop; }

status() { app_status "$HEALTH" "$STACK_ROOT" "$PORT"; }

reset() {
  echo "reset: nothing wipes the local test data of ${service} yet; teach reset() in $HERE/stack.sh" >&2
  return 1
}

case "\${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  reset) reset ;;
  *) echo "Usage: $0 up|down|status|reset" >&2; exit 2 ;;
esac
`;
}

function agentSection(input: InitInput): string {
  const svc = `${input.servicesDir}/${input.service}`;
  return `
${AGENT_SECTION}

API changes in this repository are verified by vgate (${PROJECT_FILE}, ${input.servicesDir}/). Start with
\`${CLI} doctor --fix\`. Verify with \`${CLI} up --service ${input.service}\` and
\`${CLI} gate --service ${input.service} --json\`, then read ${input.reportsDir}/verdict.json. Before finishing a change
that touches ${svc}/, run \`${CLI} guard --service ${input.service} --base <base ref> --json\`: it says what will need a
human. Skills in .claude/skills: generate-api-tests, sync-api-tests. Never edit ${svc}/known-failures.yaml: propose
the entry to a human.
`;
}

/** Everything `init` would write, as data. Pure: the caller reads the disk and applies the plan. */
export function planInit(input: InitInput): Planned[] {
  if (!SERVICE_NAME.test(input.service))
    throw new UsageError(`--service must be lower-case letters, digits and dashes (got "${input.service}")`);
  const svc = `${input.servicesDir}/${input.service}`;
  const plan: Planned[] = [];
  if (input.writeProjectFile) {
    plan.push({
      path: PROJECT_FILE,
      kind: 'create',
      content: `# A vgate project: the judge is pinned, so every machine and CI give the same verdict.
version: ${input.version}
servicesDir: ${input.servicesDir}
`,
    });
  }
  plan.push(
    { path: `${svc}/service.yaml`, kind: 'create', content: serviceYaml(input.service) },
    { path: `${svc}/openapi.yaml`, kind: 'create', content: contract(input.service) },
    { path: `${svc}/inventory.yaml`, kind: 'create', content: inventory(input.service) },
    { path: `${svc}/support/fixtures.ts`, kind: 'create', content: FIXTURES },
    { path: `${svc}/tests/health.spec.ts`, kind: 'create', content: SPEC },
    { path: `${svc}/stack.sh`, kind: 'create', content: stackScript(input.service) },
    {
      path: '.gitignore',
      kind: 'lines',
      content: [
        '# vgate: generated on every run, from the runtime',
        `${input.servicesDir}/node_modules`,
        `${input.servicesDir}/tsconfig.json`,
        `${input.servicesDir}/package.json`,
        `${input.servicesDir}/*/generated/`,
        `${input.reportsDir}/`,
      ].join('\n'),
    },
  );
  for (const file of input.agentFiles) plan.push({ path: file, kind: 'section', content: agentSection(input) });
  for (const [path, content] of Object.entries(input.ci ?? {}).sort()) plan.push({ path, kind: 'create', content });
  return plan;
}

export type Outcome = 'created' | 'unchanged' | 'overwritten' | 'skipped' | 'appended';

/** Applies one planned file. `skipped`: it exists with other content and --force was not given. */
export function applyPlanned(root: string, planned: Planned, force: boolean): Outcome {
  const file = join(root, planned.path);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (planned.kind === 'create') {
    if (current === planned.content) return 'unchanged';
    if (current !== undefined && !force) return 'skipped';
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, planned.content, planned.path.endsWith('.sh') ? { mode: 0o755 } : undefined);
    return current === undefined ? 'created' : 'overwritten';
  }
  if (planned.kind === 'lines') {
    const have = new Set((current ?? '').split('\n').map((line) => line.trim()));
    const missing = planned.content.split('\n').filter((line) => !have.has(line.trim()));
    // The comment alone is no reason to touch the file.
    if (missing.every((line) => line.startsWith('#'))) return 'unchanged';
    const prefix = current === undefined || current === '' || current.endsWith('\n') ? '' : '\n';
    writeFileSync(file, `${current ?? ''}${prefix}${current ? '\n' : ''}${missing.join('\n')}\n`);
    return current === undefined ? 'created' : 'appended';
  }
  // section: appended once, never rewriting what the file says.
  const marker = planned.content.trim().split('\n')[0];
  if (current?.includes(marker)) return 'unchanged';
  const prefix = current === undefined || current.endsWith('\n') ? '' : '\n';
  writeFileSync(file, `${current ?? ''}${prefix}${planned.content}`);
  return 'appended';
}

export interface InitOptions {
  service?: string;
  ci?: string;
  force: boolean;
}

export function init(target: string, runtime: Runtime, options: InitOptions): Result {
  const root = resolve(target);
  if (!existsSync(root)) throw new UsageError(`No such directory: ${root}`);
  const ci = options.ci;
  if (ci !== undefined && !['github', 'gitlab'].includes(ci))
    throw new UsageError(`--ci takes github or gitlab (got "${ci}")`);

  const hasProject = existsSync(join(root, PROJECT_FILE));
  const existing = hasProject ? readProject(root) : undefined;
  const servicesDir = existing ? relative(root, existing.servicesDir) : 'regression';
  const reportsDir = existing ? relative(root, existing.reportsDir) : 'reports';
  const templates = ciTemplates();
  const ciFiles = ci ? templates[ci] : undefined;
  const version = VERSION === 'dev' ? runtime.packageVersion : VERSION;

  const plan = planInit({
    root,
    version,
    service: options.service ?? 'api',
    servicesDir,
    reportsDir,
    writeProjectFile: !hasProject,
    ci: ciFiles,
    agentFiles: ['AGENTS.md', 'CLAUDE.md'].filter((file) => existsSync(join(root, file))),
  });
  const files = plan.map((planned) => ({ path: planned.path, result: applyPlanned(root, planned, options.force) }));

  const installed = skills({ action: 'install', names: [], dir: join(root, '.claude', 'skills'), dryRun: false });
  const skillRows = (installed.data as { skills: Array<{ skill: string; result: string }> }).skills;

  const skipped = files.filter((file) => file.result === 'skipped');
  const notes: string[] = [];
  if (ci && !ciFiles)
    notes.push(`this build carries no ${ci} CI template; add the gate to CI by hand (vgate's docs/ci.md)`);
  if (ciFiles && Object.keys(ciFiles).some((path) => path.endsWith('CODEOWNERS.vgate.example')))
    notes.push(
      'merge .github/CODEOWNERS.vgate.example into .github/CODEOWNERS and require code-owner review: the workflow, ' +
        'vgate.yaml and known-failures.yaml are the judge',
    );
  const service = options.service ?? 'api';
  const changed = files.filter((file) => !['unchanged', 'skipped'].includes(file.result)).length;

  return {
    command: 'init',
    ok: true,
    exitCode: EXIT.ok,
    summary:
      `${changed} file${changed === 1 ? '' : 's'} written in ${root}` +
      (skipped.length > 0
        ? `, ${skipped.length} kept as they are (exist with other content; --force overwrites)`
        : '') +
      `; skills: ${skillRows.filter((row) => row.result !== 'unchanged').length} installed or updated`,
    data: { root, version, servicesDir, reportsDir, service, files, skills: skillRows, notes },
    next: [
      `${CLI} doctor --fix`,
      `edit ${servicesDir}/${service}/stack.sh so \`${CLI} up --service ${service}\` starts the service`,
      `${CLI} up --service ${service}`,
      `${CLI} gate --service ${service}`,
    ],
    text: [...files.map((file) => `${file.result.padEnd(11)}  ${file.path}`), ...notes.map((note) => `note: ${note}`)],
  };
}

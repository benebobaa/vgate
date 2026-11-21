/**
 * vgate: the command line of the verification gate. Its first user is an agent, so every command answers with one
 * result envelope (`--json`), a meaningful exit code and the commands to run next, and none of them ever prompts.
 *
 *   pnpm exec tsx cli/main.ts <command>     from source
 *   dist/vgate <command>                    the compiled binary (cli/build.ts)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, str } from '../framework/cli/args.ts';
import { loadService } from '../framework/config.ts';
import { inventorySkeleton } from '../framework/inventory.ts';
import { durationMs, PROJECT_FILE, type ProjectConfig } from '../framework/project.ts';
import { affected } from './affected.ts';
import { compat } from './compat.ts';
import { configCheck } from './config-check.ts';
import { migrations } from './migrations.ts';
import { mutate } from './mutate.ts';
import { drift } from './drift.ts';
import { incidentAdd, incidentReport } from './incident.ts';
import { canary, parseDuration } from './canary.ts';
import { smoke } from './smoke.ts';
import { decide, DECISION_FILE } from './decide.ts';
import { doctor } from './doctor.ts';
import {
  benchmarkCommand,
  evalCommand,
  factoryCommand,
  formalCommand,
  lintCommand,
  maintainCommand,
  maturityCommand,
  mcpCommand,
  metricsCommand,
  resumeCommand,
  shipCommand,
  statechartCommand,
  stopCommand,
  verifyCommand,
} from './factory-commands.ts';
import { gate, STEPS, VERDICT_FILE } from './gate.ts';
import { GUARD_FILE, guard } from './guard.ts';
import { init } from './init.ts';
import { CLI, emit, EXIT, UsageError, type Result } from './output.ts';
import { listServices, requireProject, resolveService } from './project.ts';
import { currentRuntime } from './runtime.ts';
import { risk } from './risk.ts';
import { skills } from './skills.ts';
import { stack, STACK_ACTIONS, type StackAction } from './stack.ts';
import { checkPin, installCommand, VERSION } from './version.ts';

const BOOLEANS = [
  'json',
  'fix',
  'dry-run',
  'yes',
  'quiet',
  'help',
  'version',
  'force',
  'write',
  'smoke',
  'all-tests',
  'test',
  'update-ratchet',
  'skip-native',
  'verify-mutation',
  'production-tuned',
] as const;

/** Everything `help` says, as data: `help --json` is how an agent discovers the tool. */
const CATALOGUE = {
  name: CLI,
  about:
    'Vendor-agnostic deterministic verification gate and guardrail CLI for AI coding agents: guardrails, live verification, expectation guard, cross-vendor verifier, and MCP.',
  commands: [
    {
      name: 'init',
      usage: `${CLI} init [--service <name>] [--ci github|gitlab] [--agents <list>] [--packs <list>] [--force]`,
      about: `Make the current directory (or --root) a vgate project: ${PROJECT_FILE} pinned to this version, one service's skeleton, .gitignore entries, the agent skills, a pointer in AGENTS.md/CLAUDE.md, and with --ci the CI template. Never overwrites a file without --force.`,
    },
    {
      name: 'doctor',
      usage: `${CLI} doctor [--service <name>] [--fix]`,
      about:
        'Is this machine and project ready to run the gate? Every failed check names its fix; --fix runs the ones that only touch this project.',
    },
    {
      name: 'skills',
      usage: `${CLI} skills list|install [<skill>...] [--dir <skills dir>] [--agents <list>] [--packs <list>] [--dry-run]`,
      about:
        'The agent skills carried by this build. install writes them to <cwd>/.claude/skills (or --dir) or projects across --agents (agy,claude,cursor,codex,opencode,pi,omp,grokbot); it works outside a project.',
    },
    {
      name: 'services',
      usage: `${CLI} services`,
      about: 'The services this project can verify.',
    },
    {
      name: 'up',
      usage: `${CLI} up --service <name>`,
      about: "Start the service's local stack and wait until it is healthy.",
    },
    {
      name: 'status',
      usage: `${CLI} status --service <name>`,
      about: 'Whether the stack is up and which build it runs.',
    },
    {
      name: 'gate',
      usage: `${CLI} gate --service <name> [--steps ${STEPS.join(',')}]`,
      about: `Run the gate (every step, even after a failure) and write the verdict to ${VERDICT_FILE}. --steps runs a subset; such a verdict is marked incomplete.`,
    },
    {
      name: 'guard',
      usage: `${CLI} guard [--service <name>] --base <git ref>`,
      about: `Compare expectations (contract, plan, service.yaml, known failures, tests, guardrails, ratchets, quarantine, gate machinery) of the working tree with a base ref: auto when nothing was weakened, needs-human (exit 1) otherwise. Omit --service for repo-level guard. Writes ${GUARD_FILE}.`,
    },
    {
      name: 'affected',
      usage: `${CLI} affected --base <git ref>`,
      about:
        "The services a change can break: files changed since the merge base with --base (commits, uncommitted and untracked), mapped through each service's own directory and its `paths:` in service.yaml. Lists deleted services too.",
    },
    {
      name: 'risk',
      usage: `${CLI} risk --base <git ref>`,
      about:
        'How risky the change is (low, medium, high) from the paths it touches: the `risk:` rules of vgate.yaml, or the built-in rules (migrations, auth, money, secrets, CI, infrastructure high; dependencies, containers, contracts medium). The judge files are always high.',
    },
    {
      name: 'decide',
      usage: `${CLI} decide --base <git ref> --evidence <dir> [--details-url <url>]`,
      about: `The pull request's verdict from the gate and guard reports under --evidence: merge (exit 0), needs-approval or blocked (exit 1). Missing or stale evidence never passes. Writes ${DECISION_FILE} and reports/decision.md (the PR comment).`,
    },
    {
      name: 'compat',
      usage: `${CLI} compat --service <name> [--environment <name>]`,
      about:
        "Does the service's contract still serve the clients of the version deployed in each environment of vgate.yaml's `deploy:` (a git ref such as tag:v*, or the live contract URL)? Exit 1 when it breaks something they rely on, 3 when the deployed contract cannot be read.",
    },
    {
      name: 'config-check',
      usage: `${CLI} config-check --service <name> [--environment <name>] [--base <git ref>]`,
      about:
        "Does each environment of `deploy:` provide every key in the service's `config.required`? Reads key names only (dotenv, Kubernetes ConfigMap/Secret/env, key lists), never values. Exit 1 when one is missing; --base marks the keys the change newly requires.",
    },
    {
      name: 'migrations',
      usage: `${CLI} migrations --service <name> --base <git ref>`,
      about:
        "Are the change's database migrations safe to deploy? Lints the added migrations (PostgreSQL: squawk), applies the merge base's migrations, its seed and the change's in a sealed environment, undoes and re-applies them when `down` is configured, and runs the deployed (merge-base) app on the migrated schema against its own read-only tests. Writes reports/migrations.json for decide. Exit 1 when blocked or a human must look.",
    },
    {
      name: 'smoke',
      usage: `${CLI} smoke --service <name> --env <environment>`,
      about:
        "After a deploy: runs the service's smoke subset (service.yaml `smoke:`, or the plan's read-only scenarios) against a deployed environment. In an environment that is not disposable the client refuses every request that is not read-only before it is sent, unless `allowWrites` lists it. Zero tests run is a failure. Writes reports/smoke.json.",
    },
    {
      name: 'canary',
      usage: `${CLI} canary --service <name> --env <environment> [--for 10m] [--every 30s] [--on-fail '<rollback command>'] [--smoke]`,
      about:
        'While a new version takes traffic: polls the metrics of `environments.<env>.canary` (Prometheus or an HTTP JSON endpoint) against their limits and baseline. Exit 0 healthy, 1 breach (runs --on-fail once), 3 metrics unreadable (never a pass, no rollback).',
    },
    {
      name: 'mutate',
      usage: `${CLI} mutate --service <name> --base <git ref> [--budget 20] [--timeout 10m] [--all-tests]`,
      about:
        "Do the tests catch bugs in the code this change touched? Plants one small bug at a time in the changed lines (comparisons, boundaries, conditions, flags, arithmetic, negation, numbers, returned text), rebuilds and restarts the app in a scratch copy, and runs the service's tests: score = caught / (caught + survived). Lists each survivor with the scenario that would catch it. Writes reports/mutation.json for decide (policy.mutationScore). Exit 1 below the policy.",
    },
    {
      name: 'incident',
      usage: `${CLI} incident add --service <name> --title "<what escaped>" [--ticket <id>] [--evidence <request id, curl or http-calls.json>] [--missed-by spec-gap|missing-scenario|stub-drift|environment|not-testable] [--reason <why not testable>] | ${CLI} incident report [--service <name>]`,
      about:
        'The learning loop. add records a bug that escaped to production as <service dir>/incidents/INC-<n>.yaml and its scenario in the plan; from then on the coverage step fails until a test titled [INC-<n>] guards it (not-testable needs a reason). report: why escapes got through, and the share of testable ones the gate would catch today.',
    },
    {
      name: 'drift',
      usage: `${CLI} drift --env <environment> [--service <name>] [--dependency <name>]`,
      about:
        "Has a provider changed under its vendored contract? Asks each dependency's sandbox (environments.<env>.dependencies.<name>.sandbox) and holds every answer strictly to the vendored contract the stubs use. Exit 1 drift (named field and operation), 3 a call not compared: the sandbox unreachable, refusing it (a documented 401 or 5xx), or its secret unset (never a pass). Writes reports/drift.json.",
    },
    {
      name: 'inventory',
      usage: `${CLI} inventory --service <name> [--write]`,
      about:
        "The test plan's skeleton from the service's vendored contract: every operation and documented response, every judgement TODO. --write saves it as <service dir>/inventory.skeleton.yaml (never inventory.yaml).",
    },
    {
      name: 'down',
      usage: `${CLI} down --service <name>`,
      about: 'Stop the local stack; its data is kept.',
    },
    {
      name: 'reset',
      usage: `${CLI} reset --service <name> --yes`,
      about: "DESTRUCTIVE: wipe the service's local test data and re-seed it. Refused without --yes.",
    },
    {
      name: 'lint',
      usage: `${CLI} lint [--test] [--config <file>] [--ratchet <file>] [--update-ratchet] [--skip-native] [--files a,b]`,
      about:
        'Run polyglot codebase guardrails (guardrails.yaml boundaries, banned patterns, comment caps, brownfield ratchets, native linters, AGENTS.md rule table). --test verifies every rule against its known-bad/known-good fixtures; --config/--ratchet let CI run trunk-pinned rules.',
    },
    {
      name: 'verify',
      usage: `${CLI} verify --base <git ref> [--mode auto|full|single|skip] [--verifiers 1] [--author-harness <h>]`,
      about:
        'Run an independent cross-vendor live-app verifier (defaults to 1 verifier) and write reports/verifier.json (signed when VGATE_SIGNING_KEY is set).',
    },
    {
      name: 'eval',
      usage: `${CLI} eval --spec <eval.json>`,
      about: 'Run blinded, anti-eval-awareness skill evaluations with transcript adherence auditing.',
    },
    {
      name: 'maintain',
      usage: `${CLI} maintain [--service <name>]`,
      about:
        'Read-only Feature Map drift audit (clean | changed | blocked). Strictly prohibited from editing product code.',
    },
    {
      name: 'formal',
      usage: `${CLI} formal [--verify-mutation]`,
      about:
        'Run Tier-2 formal verification specs (TLA+, Lean, Bombadil) with sync-commit drift tracking and mutation proof.',
    },
    {
      name: 'statechart',
      usage: `${CLI} statechart --input <spec.tla> [--output <file.mmd>] [--max-arrows 20]`,
      about: 'Render a best-effort Mermaid statechart from a TLA+ specification or DOT graph.',
    },
    {
      name: 'benchmark',
      usage: `${CLI} benchmark --baseline "<cmd>" --candidate "<cmd>" --limiter "<why>" [--runs 5] [--production-tuned]`,
      about: 'Run alternating A/B performance trials under the 7-question Explain-the-Number rigor checklist.',
    },
    {
      name: 'ship',
      usage: `${CLI} ship patch-id --base <ref> | rebase-check --rebases <n> | plan --stack <stack.json>`,
      about:
        'Merge-queue helpers: semantic Patch-ID, 3-rebase ceiling check, and bottom-up contiguous stacked landing plan.',
    },
    {
      name: 'maturity',
      usage: `${CLI} maturity [--require 1..5]`,
      about:
        'Evaluate the 5-phase maturity report (Phases 1-3 advisory; Phases 4-5 require out-of-band VGATE_ALLOW_AUTONOMY=1 to override).',
    },
    {
      name: 'metrics',
      usage: `${CLI} metrics record --kind <kind> [...] | ${CLI} metrics report [--days 30] [--format text|json|html|otel]`,
      about:
        'Local-first 5-KPI engineering ledger (accepted fixes, review time, rework, revert/escaped defects, cost/change).',
    },
    {
      name: 'factory',
      usage: `${CLI} factory serve|status|audit|dispatch [...]`,
      about:
        'Self-hosted Layer 1 outer-loop control plane: credential-isolated workers, untrusted signal framing, and hourly side-effect audits.',
    },
    {
      name: 'stop',
      usage: `${CLI} stop [--reason "<why>"]`,
      about: 'Emergency zero-writes stop switch: halts all factory dispatches and worker writes immediately.',
    },
    {
      name: 'resume',
      usage: `${CLI} resume`,
      about: 'Clear the zero-writes stop order and allow factory dispatches to resume.',
    },
    {
      name: 'mcp',
      usage: `${CLI} mcp`,
      about: 'Start vgate as a stdio JSON-RPC 2.0 MCP server for any MCP-capable coding agent.',
    },
    { name: 'help', usage: `${CLI} help`, about: 'This catalogue.' },
    { name: 'version', usage: `${CLI} version`, about: 'The version of this build.' },
  ],
  flags: [
    { flag: '--json', about: 'Print the result envelope as JSON on stdout and nothing else.' },
    { flag: '--quiet', about: 'Do not stream the output of steps and stacks to stderr (implied by --json).' },
    { flag: '--service <name>', about: 'The service; default: $SERVICE, or the only service of the project.' },
    { flag: '--env <name>', about: 'The environment in service.yaml; default: $TEST_ENV, or local.' },
    {
      flag: '--root <dir>',
      about: `The project; default: the nearest parent of the cwd holding a ${PROJECT_FILE}.`,
    },
  ],
  exitCodes: [
    { code: EXIT.ok, meaning: 'Done; for gate: the verdict is pass.' },
    { code: EXIT.failed, meaning: 'The verification ran and said no: gate verdict fail, guard decision needs-human.' },
    { code: EXIT.usage, meaning: 'The call was wrong: unknown command, flag value, step or service.' },
    { code: EXIT.notReady, meaning: 'Nothing was verified: the machine, the project or the stack is not ready.' },
  ],
  result: {
    envelope: ['command', 'ok', 'exitCode', 'summary', 'data', 'next'],
    next: 'Commands to run next, most useful first.',
    verdictFile: VERDICT_FILE,
    guardFile: GUARD_FILE,
    decisionFile: DECISION_FILE,
  },
};

function help(): Result {
  return {
    command: 'help',
    ok: true,
    exitCode: EXIT.ok,
    summary: `${CLI} ${VERSION}: ${CATALOGUE.commands.length} commands; --json on any of them for machine-readable output`,
    data: { version: VERSION, ...CATALOGUE },
    next: [],
    text: [
      CATALOGUE.about,
      '',
      'Commands:',
      ...CATALOGUE.commands.flatMap((command) => [`  ${command.usage}`, `      ${command.about}`]),
      '',
      'Flags (any command):',
      ...CATALOGUE.flags.map((flag) => `  ${flag.flag.padEnd(18)}${flag.about}`),
      '',
      'Exit codes:',
      ...CATALOGUE.exitCodes.map((exit) => `  ${exit.code}  ${exit.meaning}`),
      '',
    ],
  };
}

/** A project pinned to another vgate: nothing is run, and the install command of its version comes next. */
function pinMismatch(command: string, project: ProjectConfig): Result | undefined {
  const pin = checkPin(project);
  if (pin.state !== 'mismatch') return undefined;
  return {
    command,
    ok: false,
    exitCode: EXIT.notReady,
    summary: `Nothing was run: ${pin.message}`,
    data: { pinned: pin.pinned, running: pin.running, project: project.root },
    next: [pin.fix ?? installCommand(pin.pinned)],
  };
}

async function run(argv: string[]): Promise<Result> {
  const args = parseArgs(argv, BOOLEANS);
  const [command, ...rest] = args._;
  const envName = str(args.env, process.env.TEST_ENV ?? 'local') ?? 'local';
  const live = args.json !== true && args.quiet !== true;

  if (args.version === true || command === 'version') {
    return {
      command: 'version',
      ok: true,
      exitCode: EXIT.ok,
      summary: `${CLI} ${VERSION}`,
      data: { version: VERSION },
      next: [],
    };
  }
  if (command === undefined || command === 'help' || args.help === true) return help();

  // The skills travel in the binary: installing them needs no project.
  if (command === 'skills') {
    return skills({
      action: rest[0],
      names: rest.slice(1),
      dir: str(args.dir),
      agents: str(args.agents),
      packs: str(args.packs),
      root: str(args.root),
      dryRun: args['dry-run'] === true,
    });
  }
  if (command === 'mcp') {
    let proj: ProjectConfig | undefined;
    try {
      proj = requireProject(str(args.root));
    } catch {
      proj = undefined;
    }
    return mcpCommand(proj);
  }

  const runtime = currentRuntime();
  if (command === 'init') {
    if (args.service === true) throw new UsageError('--service needs a name, e.g. --service api');
    if (args.ci === true) throw new UsageError('--ci needs a value: github or gitlab');
    return init(str(args.root) ?? process.cwd(), runtime, {
      service: str(args.service),
      ci: str(args.ci),
      agents: str(args.agents),
      packs: str(args.packs),
      force: args.force === true,
    });
  }

  const project = requireProject(str(args.root));
  const root = project.root;
  const serviceFlag = str(args.service);

  if (command === 'services') {
    const services = listServices(root);
    return {
      command: 'services',
      ok: true,
      exitCode: EXIT.ok,
      summary: `${services.length} service${services.length === 1 ? '' : 's'} in ${root}`,
      // servicesDir lets CI list the services of another ref too (a deleted one is still guarded).
      data: { root, servicesDir: project.servicesDirName, services },
      next: [],
      text: services,
    };
  }
  if (command === 'incident') {
    const action = rest[0];
    if (action === 'add') {
      for (const flag of ['title', 'ticket', 'evidence', 'missed-by', 'reason'] as const)
        if (args[flag] === true) throw new UsageError(`--${flag} needs a value`);
      return incidentAdd(project, {
        service: resolveService(root, serviceFlag),
        title: str(args.title),
        ticket: str(args.ticket),
        evidence: str(args.evidence),
        missedBy: str(args['missed-by']),
        reason: str(args.reason),
      });
    }
    if (action === 'report')
      return incidentReport(project, serviceFlag === undefined ? undefined : resolveService(root, serviceFlag));
    throw new UsageError(`Usage: ${CLI} incident add|report (see ${CLI} help)`);
  }
  if (command === 'drift') {
    if (args.dependency === true) throw new UsageError("--dependency needs a name from the environment's dependencies");
    if (args.env === undefined)
      throw new UsageError('--env needs the environment whose dependencies declare a sandbox');
    return drift(project, {
      service: serviceFlag === undefined ? undefined : resolveService(root, serviceFlag),
      env: envName,
      dependency: str(args.dependency),
    });
  }
  if (command === 'inventory') {
    const svc = loadService(resolveService(root, serviceFlag), envName, root);
    const skeleton = inventorySkeleton(svc);
    const file = join(svc.dir, 'inventory.skeleton.yaml');
    if (args.write === true) writeFileSync(file, skeleton);
    const operations = (skeleton.match(/^ {2}- id: /gm) ?? []).length;
    return {
      command: 'inventory',
      ok: true,
      exitCode: EXIT.ok,
      summary:
        args.write === true
          ? `Skeleton of ${svc.name} (${operations} operations) written to ${file}`
          : `Skeleton of ${svc.name}: ${operations} operations`,
      data: { service: svc.name, operations, file: args.write === true ? file : null, skeleton },
      next: [],
      text: args.write === true ? [] : [skeleton.trimEnd()],
    };
  }
  if (command === 'lint') {
    const files = str(args.files)
      ?.split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    return lintCommand(project, {
      testFixtures: args.test === true,
      updateRatchet: args['update-ratchet'] === true,
      skipNative: args['skip-native'] === true,
      configPath: str(args.config),
      ratchetPath: str(args.ratchet),
      files,
    });
  }
  if (command === 'maturity') {
    const req = str(args.require);
    return maturityCommand(project, req !== undefined ? Number(req) : undefined);
  }
  if (command === 'metrics') {
    const num = (v: string | undefined) => (v !== undefined ? Number(v) : undefined);
    return metricsCommand(project, rest[0], {
      kind: str(args.kind),
      pr: str(args.pr),
      service: serviceFlag,
      reviewMinutes: num(str(args['review-minutes'])),
      tokens: num(str(args.tokens)),
      usd: num(str(args.usd)),
      role: str(args.role),
      days: num(str(args.days)),
      format: str(args.format),
    });
  }
  if (command === 'stop') return stopCommand(project, str(args.reason));
  if (command === 'resume') return resumeCommand(project);
  if (command === 'maintain') return maintainCommand(project, serviceFlag);
  if (command === 'statechart') {
    const maxArrows = str(args['max-arrows']);
    return statechartCommand(project, {
      input: str(args.input),
      output: str(args.output),
      maxArrows: maxArrows !== undefined ? Number(maxArrows) : undefined,
    });
  }
  if (command === 'ship') {
    const rebases = str(args.rebases);
    return shipCommand(project, rest[0], {
      base: str(args.base),
      rebases: rebases !== undefined ? Number(rebases) : undefined,
      stackFile: str(args.stack),
    });
  }
  if (command === 'doctor') {
    // All services when none is named; a named one must exist.
    const service = serviceFlag === undefined ? undefined : resolveService(root, serviceFlag);
    return doctor(project, runtime, { service, env: envName, fix: args.fix === true });
  }

  // Every command that judges or runs the project needs the version it is pinned to.
  const pinned = pinMismatch(command, project);
  if (pinned) return pinned;

  if (command === 'verify') {
    if (args.base === true) throw new UsageError('--base needs a git ref, e.g. origin/main');
    const verifiers = str(args.verifiers);
    return verifyCommand(project, {
      base: str(args.base),
      mode: str(args.mode),
      verifiers: verifiers !== undefined ? Number(verifiers) : undefined,
      authorHarness: str(args['author-harness']),
      authorModel: str(args['author-model']),
    });
  }
  if (command === 'eval') return evalCommand(project, str(args.spec));
  if (command === 'formal') return formalCommand(project, args['verify-mutation'] === true);
  if (command === 'benchmark') {
    const runs = str(args.runs);
    return benchmarkCommand(project, {
      baseline: str(args.baseline),
      candidate: str(args.candidate),
      limiter: str(args.limiter),
      runs: runs !== undefined ? Number(runs) : undefined,
      productionTuned: args['production-tuned'] === true,
    });
  }
  if (command === 'factory') {
    const port = str(args.port);
    return factoryCommand(project, rest[0], {
      host: str(args.host),
      port: port !== undefined ? Number(port) : undefined,
      source: str(args.source),
      payloadFile: str(args.payload),
      sandbox: str(args.sandbox),
    });
  }
  if (command === 'gate') {
    const steps = str(args.steps)
      ?.split(',')
      .map((step) => step.trim())
      .filter(Boolean);
    if (args.steps === true) throw new UsageError(`--steps needs a value: ${STEPS.join(',')}`);
    return gate(project, runtime, { service: resolveService(root, serviceFlag), env: envName, steps, live });
  }
  if (command === 'affected' || command === 'risk' || command === 'decide') {
    if (args.base === true) throw new UsageError('--base needs a git ref, e.g. origin/main');
    if (command === 'affected') return affected(project, str(args.base));
    if (command === 'risk') return risk(project, str(args.base));
    if (args.evidence === true) throw new UsageError('--evidence needs a directory, e.g. reports');
    return decide(project, {
      base: str(args.base),
      evidence: str(args.evidence),
      detailsUrl: str(args['details-url']),
    });
  }
  if (command === 'mutate') {
    if (args.base === true) throw new UsageError('--base needs a git ref, e.g. origin/main');
    const budget = str(args.budget);
    if (args.budget === true || (budget !== undefined && !/^[1-9]\d{0,3}$/.test(budget)))
      throw new UsageError('--budget needs a number of mutants, e.g. --budget 20');
    if (args.timeout === true) throw new UsageError('--timeout needs a duration, e.g. --timeout 10m');
    const timeout = str(args.timeout);
    let timeoutMs: number | undefined;
    try {
      timeoutMs = timeout === undefined ? undefined : durationMs(timeout, '--timeout');
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    return mutate(project, runtime, {
      service: resolveService(root, serviceFlag),
      base: str(args.base),
      env: envName,
      budget: budget === undefined ? undefined : Number(budget),
      timeoutMs,
      allTests: args['all-tests'] === true,
      live,
    });
  }
  if (command === 'migrations') {
    if (args.base === true) throw new UsageError('--base needs a git ref, e.g. origin/main');
    return migrations(project, runtime, {
      service: resolveService(root, serviceFlag),
      base: str(args.base),
      env: envName,
      live,
    });
  }
  if (command === 'smoke')
    return smoke(project, runtime, { service: resolveService(root, serviceFlag), env: envName, live });
  if (command === 'canary') {
    for (const flag of ['for', 'every', 'on-fail'] as const)
      if (args[flag] === true) throw new UsageError(`--${flag} needs a value`);
    return canary(project, runtime, {
      service: resolveService(root, serviceFlag),
      env: envName,
      forMs: str(args.for) === undefined ? 0 : parseDuration(str(args.for) ?? '', '--for'),
      everyMs: parseDuration(str(args.every) ?? '30s', '--every'),
      onFail: str(args['on-fail']),
      smoke: args.smoke === true,
      live,
    });
  }
  if (command === 'compat' || command === 'config-check') {
    if (args.environment === true) throw new UsageError('--environment needs a name from deploy.environments');
    if (args.base === true) throw new UsageError('--base needs a git ref, e.g. origin/main');
    const options = { service: serviceFlag, environment: str(args.environment) };
    return command === 'compat' ? compat(project, options) : configCheck(project, { ...options, base: str(args.base) });
  }
  if (command === 'guard') {
    if (args.base === true) throw new UsageError('--base needs a git ref, e.g. origin/main');
    // Omit --service to run repo-level guardrails/ratchet/quarantine/machinery guard (_repo).
    const service =
      serviceFlag === undefined
        ? undefined
        : /^\w[\w.-]*$/.test(serviceFlag)
          ? serviceFlag
          : resolveService(root, serviceFlag);
    return guard(root, { service, base: str(args.base) });
  }
  if ((STACK_ACTIONS as readonly string[]).includes(command)) {
    return stack(project, runtime, {
      service: resolveService(root, serviceFlag),
      env: envName,
      action: command as StackAction,
      yes: args.yes === true,
      live,
    });
  }
  throw new UsageError(`Unknown command "${command}". Commands: ${CATALOGUE.commands.map((c) => c.name).join(', ')}`);
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
let result: Result;
try {
  result = await run(argv);
} catch (error) {
  const usage = error instanceof UsageError;
  result = {
    command: argv.find((arg) => !arg.startsWith('--')) ?? 'help',
    ok: false,
    exitCode: usage ? EXIT.usage : EXIT.notReady,
    summary: error instanceof Error ? error.message : String(error),
    next: usage ? [`${CLI} help`] : [],
  };
}
if (result.command !== 'mcp') emit(result, json);
// Not process.exit(): a piped stdout must drain before the process ends.
process.exitCode = result.exitCode;

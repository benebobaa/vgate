# vgate

A deterministic verification gate for merge requests written by AI agents.

Agents write the code, the tests and the setup. vgate judges them with plain open-source tooling and no model in the
loop, and its guard decides when a human must look: only when a change weakens what the gate verifies. Every other
change merges on a green gate.

```bash
curl -fsSL https://vgate.benelabs.tech/install.sh | sh
cd your-project
vgate init --service api --ci github   # vgate.yaml, regression/api/, agent skills, .github/workflows/vgate.yml
vgate doctor --fix                     # checks the tools, installs the framework runtime (cached per version)
```

Then ask your coding agent to _"onboard `api` from `<path to the backend>`"_. The `generate-api-tests` skill vendors
the contract, writes a test plan and stops for your review, then writes the tests, runs the gate and reports where the
backend disagrees with its spec. Install details, pinning and verification: [docs/install.md](docs/install.md).

> **Status:** 0.1, early. The source is visible here; a license has not been chosen yet, so until one is added no
> rights beyond running the published binary are granted.

## What the gate checks

| Layer            | Tool                                       | Catches                                                                                                                                              |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract types   | `openapi-typescript` + `tsc`               | Tests that use a field, path or body the contract does not have                                                                                      |
| Every response   | Playwright Test + Ajv                      | An undocumented status, a schema violation or undocumented field, a missing header, a datetime without its offset                                    |
| Streams          | SSE parser + per-event schema              | An event that violates its schema, a stream cut off before its terminal event, a stalled stream ([docs/streaming.md](docs/streaming.md))             |
| Behaviour        | Playwright Test scenarios                  | Wrong codes and values, wrong rows in the database, writes on rejected calls, role and permission rules, signed webhooks                             |
| Generated inputs | Schemathesis                               | Server errors, schema conformance and input handling on read-only operations, from the contract alone                                                |
| Dependencies     | WireMock, Kafka, Redis, Toxiproxy fixtures | Wrong calls to a third party, stubs that lie about it, missing or malformed events, behaviour when a dependency is slow or down                      |
| Completeness     | coverage gate                              | A documented (operation, status, code) no test reaches; a planned scenario no collected test runs; a provider answer no test simulates               |
| Known failures   | registry with ticket, owner and expiry     | An expired or stale entry; a known failure that now passes ([docs/known-failures.md](docs/known-failures.md))                                        |
| The expectations | `vgate guard`                              | A change that weakens the judge: a breaking contract change, a removed scenario or assertion, a loosened rule, a new known failure, edited machinery |
| The framework    | `node:test` self-tests                     | A change to vgate itself that would make it judge wrongly                                                                                            |

Auth: Keycloak password users, static bearer tokens, API keys and cookie sessions with CSRF
([docs/auth.md](docs/auth.md)). Reports: `reports/verdict.json` (the machine-readable verdict), JUnit XML, Playwright
HTML with traces, Allure, `reports/coverage/coverage.md`.

## Three rules

1. **Expectations come from the spec, never from what the backend returns today.** Every scenario cites its source
   (contract, README rule, error-code enum, permission annotation, migration). A test that fails while matching its
   source is a finding, not a test to "fix".
2. **The AI writes the tests; it never runs in the gate.** The gate is plain tooling and gives the same answer every
   time.
3. **Whoever changes the code cannot weaken the judge.** In CI the gate and the guard run from the pinned vgate
   version, never from the merge request's checkout. A change that removes or loosens an expectation, adds a known
   failure or edits the machinery waits for a human approval ([docs/guard.md](docs/guard.md),
   [docs/ci.md](docs/ci.md)).

## The CLI

Made for the agent that operates it as much as for a person: every command takes `--json` and returns one envelope,
`{ command, ok, exitCode, summary, data, next }`; it never prompts; `next` lists the commands that move the caller
forward.

| Command                                          | What it does                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `init [--service <svc>] [--ci github] [--force]` | Makes the current repository a project: `vgate.yaml` (pinned version), the service skeleton, the skills, the CI workflow            |
| `doctor [--service <svc>] [--fix]`               | Checks tools and versions, the runtime, each service's config, contract and stack; every failed check names its fix                 |
| `gate --service <svc> [--steps a,b]`             | Runs every step and writes `reports/verdict.json`: steps, failed tests (scenario id, file, line, message), coverage, known failures |
| `guard --service <svc> --base <ref>`             | Compares the expectations with a base ref: exit 0 `auto`, exit 1 `needs-human` with the findings; writes `reports/guard.json`       |
| `inventory --service <svc> [--write]`            | The test plan's skeleton from the vendored contract, for the agent to enrich                                                        |
| `up` / `down` / `status --service <svc>`         | The service's local stack                                                                                                           |
| `reset --service <svc> --yes`                    | **Destructive**: wipes the service's local test data; refused without `--yes`                                                       |
| `skills list` / `skills install`                 | The agent skills the binary carries                                                                                                 |
| `services`, `help`, `version`                    | The project's services; the command catalogue (`help --json` returns it as data); the build's version                               |

Global flags: `--json`, `--quiet`, `--root <dir>` (default: the nearest parent holding `vgate.yaml`), `--service`,
`--env` (default `$TEST_ENV` or `local`).

| Exit code | Meaning                                                                          |
| --------- | -------------------------------------------------------------------------------- |
| 0         | Done, and the answer is yes (`guard`: may merge on a green gate)                 |
| 1         | The verification ran and failed (`guard`: needs a human)                         |
| 2         | The call was wrong: an unknown command, flag value or service                    |
| 3         | Nothing was verified, because the machine, the project or the stack is not ready |

## A project

```
vgate.yaml                 version: 0.1.1, servicesDir: regression
regression/<svc>/
  service.yaml             rules, auth, dependencies, environments
  openapi.yaml             the vendored contract: approved behaviour, changed only by a sync
  inventory.yaml           the test plan, every scenario citing its source
  known-failures.yaml      optional: failures the gate tolerates until a date (human-only)
  FINDINGS.md              where the backend disagrees with its spec
  stack.sh                 starts the service and its dependencies locally
  support/ tests/
```

The framework itself is not in the project: the binary carries it and unpacks it once per version into
`~/.cache/vgate`. Details: [docs/project-layout.md](docs/project-layout.md). Dependencies (third-party stubs checked
against the provider's contract, Kafka, Redis, faults): [docs/dependencies.md](docs/dependencies.md). Signed webhooks:
[docs/webhooks.md](docs/webhooks.md).

## When the gate fails

1. **Read the failure** in `reports/verdict.json` or the job log: method, path, status and `X-Request-Id`; search the
   backend's logs for that id.
2. **Open the evidence**: each failed test attaches `http-calls.json` (every request and response) and a Playwright
   trace.
3. **Classify:**

   | It is              | Signs                                                  | Do                                                         |
   | ------------------ | ------------------------------------------------------ | ---------------------------------------------------------- |
   | A regression       | The test matches its cited source; the backend changed | Fix the backend                                            |
   | An intended change | A source (contract, README, ticket) now says otherwise | Sync the tests (skill `sync-api-tests`); the plan cites it |
   | A test defect      | The expectation has no source, or the data is wrong    | Fix the test                                               |
   | The environment    | Stack down, stale data, an expired secret              | `vgate status`, `vgate reset --yes` (local)                |

4. **Record** what you cannot resolve in `FINDINGS.md`. Only a human adds a known failure.

## This repository

The source of vgate: `cli/` (the command line), `framework/` (the Playwright-based test framework and its runners),
`.claude/skills/` (the agent skills), `ci/` (GitHub workflow template, GitLab component, CI image), `scripts/` (installer
and release), `docs/`. Two reference services run the whole gate: `services/example` (a REST API with an API key, a
cookie session, a stream and a signed webhook; no Docker) and `services/example-orders` (PostgreSQL, Redis, Kafka and a
third-party payment provider).

```bash
pnpm install
pnpm vgate up --service example
pnpm vgate gate --service example     # selftest, typecheck, lint, tests, contract, coverage
pnpm vgate down --service example
bun cli/build.ts                      # dist/vgate for this machine; --all for every release platform
```

Requirements for development: Node 22, pnpm 10, Bun 1.4, uv (Schemathesis), Docker (`example-orders`). Releasing:
[docs/releasing.md](docs/releasing.md).

## Roadmap

- A license, and signed releases (minisign).
- The web frontend: UI end-to-end tests with the same Playwright setup and the same guard.
- NDJSON and WebSocket streams; asymmetric webhook signatures; more databases than PostgreSQL.
- Scheduled runs against shared environments, where cross-service flows belong.

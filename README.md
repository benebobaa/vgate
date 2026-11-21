# vgate

**Vendor-agnostic deterministic verification gate and guardrail harness for AI coding agents** — ship high-velocity PRs without degrading quality.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) [![CI](https://github.com/benebobaa/vgate/actions/workflows/ci.yml/badge.svg)](https://github.com/benebobaa/vgate/actions/workflows/ci.yml) [![Release](https://img.shields.io/badge/release-v0.1.1-green.svg)](https://vgate.benelabs.tech/latest.json) [![MCP](https://img.shields.io/badge/MCP-stdio-purple.svg)](docs/cli.md)

Works with **Claude Code**, **Cursor**, **Codex**, **Antigravity**, **OpenCode**, **Pi**, **OMP**, **GrokBot**, or any MCP client.

## Why vgate

- **Deterministic first**: Polyglot architecture guardrails (`guardrails.yaml` + ratchets) and real runtime gates (API contracts, Chromium UI, migrations, mutation strength) judge PRs without model guesswork.
- **Un-gameable judge**: CI pins the binary and reads policy/`guardrails.yaml` from trunk, supports HMAC/Ed25519 verdict signing, and routes UX-touching diffs to human approval (`vgate decide`).
- **Vendor-agnostic**: A single binary projects non-clobbering `vgate-*` skills across agent harnesses, dispatches cross-vendor verifiers, and speaks stdio MCP (`vgate mcp`).

## Quick Start

```bash
curl -fsSL https://vgate.benelabs.tech/install.sh | sh
cd your-project
vgate init --service api --ci github --agents claude,cursor,codex,agy
vgate doctor --fix && vgate gate --service api
```

## How It Works

| Pillar                | Mechanism                                                                           | Guide                                                                        |
| --------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Guardrails & Ratchets | Boundaries, banned patterns with `replaceWith`, presets, fixtures (`--test`)        | [docs/guard.md](docs/guard.md)                                               |
| Live Runtime Gates    | OpenAPI, Schemathesis, Playwright UI, migrations, `vgate mutate`                    | [docs/deploy-safety.md](docs/deploy-safety.md)                               |
| Trunk-Executed Guard  | `vgate guard` & `repo-guard` block weakened specs, ratchets, or judge files         | [docs/pr-verification.md](docs/pr-verification.md)                           |
| Cross-Vendor Verifier | Separate-family live-app verifier layered fail-closed over deterministic gates      | [docs/architecture-agentic-factory.md](docs/architecture-agentic-factory.md) |
| Harness Skills & MCP  | Multi-harness `vgate-*` skills, 1-source `vgate-verify`, stdio JSON-RPC `vgate mcp` | [docs/cli.md](docs/cli.md)                                                   |
| Metrics & Factory     | 5-KPI ledger, advisory maturity, experimental primitives (`DockerSandbox`)          | [docs/architecture-agentic-factory.md](docs/architecture-agentic-factory.md) |

## Core Commands

Every command supports `--json` and exits `0` (pass), `1` (fail/human), `2` (usage), or `3` (not ready).

| Command                      | Purpose                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `vgate init`                 | Initialize `vgate.yaml`, service skeleton, CI workflow, and agent skills  |
| `vgate doctor [--fix]`       | Check host tools and unpack the version-pinned framework runtime          |
| `vgate lint [--test]`        | Run `guardrails.yaml` rules/ratchets or prove rule fixtures can fail      |
| `vgate gate --service <svc>` | Run full deterministic suite and write `reports/verdict.json`             |
| `vgate guard --base <ref>`   | Flag weakened expectations, ratchets, quarantine, or judge machinery      |
| `vgate decide --base <ref>`  | Produce stacked merge decision (`merge` \| `needs-approval` \| `blocked`) |
| `vgate verify --base <ref>`  | Run independent cross-vendor live-app verifier (`reports/verifier.json`)  |
| `vgate skills install`       | Project `vgate-*` skills cleanly across configured coding agents          |
| `vgate mcp`                  | Start the built-in stdio JSON-RPC 2.0 MCP server                          |
| `vgate metrics report`       | Summarize local 5-KPI ledger (`text`, `json`, `html`, `otel`)             |

Full command reference: [docs/cli.md](docs/cli.md) or `vgate help --json`.

## Documentation

- [Architecture](docs/architecture-agentic-factory.md) — 3-layer factory design & security invariants
- [CLI Reference](docs/cli.md) — all commands, flags, exit codes, experimental factory commands
- [Installation](docs/install.md) — version pinning, minisign verification, Linux/macOS setup
- [CI Integration](docs/ci.md) — GitHub Actions (`repo-guard` + `decide`) and GitLab components
- [PR Verification](docs/pr-verification.md) — risk tiers, human-taste UX rules, failure triage
- [Frontend](docs/frontend.md) · [Deploy Safety](docs/deploy-safety.md) · [Mutation](docs/mutation.md) · [Dependencies](docs/dependencies.md) · [Releasing](docs/releasing.md)

## Development & License

```bash
pnpm install
pnpm task selftest && pnpm vgate lint
bun cli/build.ts
```

Licensed under [Apache-2.0](LICENSE). Release checksums are signed with [minisign.pub](minisign.pub).

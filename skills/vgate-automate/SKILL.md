---
name: vgate-automate
description: CLI harvesting — graduate repeated Playwright, CDP, PTY, or AST verification sequences into a deterministic, testable repo CLI (`--json`, `--dry-run`, `--help`) to save agent context.
pack: core
---

# vgate-automate

Stop burning context window rebuilding throwaway verification or codemod scripts. When you run the same multi-step driving or inspection sequence twice, graduate it into a permanent repo CLI.

## Design Requirements

1. **Deterministic & Composable**: Small subcommands with predictable exit codes (`0` ok, `1` failed, `2` usage, `3` not ready).
2. **Agent-First Interface**: Support `--json` for structured output, rich `--help`, actionable error messages naming the fix, and never prompt interactively.
3. **Safe by Default**: Require `--dry-run` support on every destructive or state-mutating action; verify dry-run touches no network or persistent state.
4. **One-Command Seeded Setup**: Pair with `vgate up --service <svc>` so any agent can run the CLI from an empty data directory.
5. **Register in Feature Map**: Reference the harvested CLI command inside `<servicesDir>/<svc>/features/` so `vgate-verify` and independent verifiers reuse it automatically.

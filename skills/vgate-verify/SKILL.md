---
name: vgate-verify
description: Drive and verify the live application via vgate and its Feature Map with mandatory evidence and explicit skip-logging. Regenerate from vgate.yaml + features/ so the skill never drifts from the runner.
pack: core
---

# vgate-verify

Prove changed behavior against the live application. Compilation and unit tests never substitute for runtime proof.

## Execution Protocol

1. **Copy every step into your task list** before starting so no verification step is silently dropped.
2. **Doctor & Launch**: Run `vgate doctor --fix --json` and `vgate up --service <svc> --json`. Confirm the app is genuinely ready from a clean data directory (not merely listening on a port).
3. **Drive Real User Paths**: Follow `<servicesDir>/<svc>/features/` recipes using stable selectors (`data-testid`, ARIA labels, routes, CLI flags) and run `vgate gate --service <svc> --json`.
4. **Evidence**: Collect `reports/verdict.json`, traces, screenshots/videos, and side-effect checks (DB rows, files, events). Verify dry-run modes never hit external networks.
5. **Cleanup**: Run `vgate down --service <svc>` (never kill by generic process name) and verify evidence artifacts survived teardown in `reports/`.
6. **Skip-Logging Discipline**: If any verification step is skipped, record the exact step name, reason, and risk in your final summary. Silent skips are forbidden.

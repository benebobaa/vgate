# Architecture: Vendor-Agnostic 3-Layer Agentic Engineering Factory

This document records the architecture for `vgate` `0.1.x` — a 100% Apache-2.0, vendor-agnostic 3-layer agentic engineering factory.

> **Honest scope:** `vgate` compresses the **tooling, guardrail, verification-harness, and orchestration R&D** required to run high-throughput coding agents safely. It does **not** magically eliminate the repository cleanup, test authoring, and organizational trust calibration each engineering team still has to earn.

## Core Security & Engineering Invariants

1. **Inverted Pyramid of Trust**: Invest first in deterministic repository guardrails (`guardrails.yaml` backed by polyglot rules, brownfield ratchets, opt-in presets, rule fixtures `vgate lint --test`, and native linters like `eslint` / `ast-grep`) and live/formal verification (`vgate gate`, `vgate formal`, `vgate mutate`). Keep markdown skills thin, namespaced (`vgate-*`), and generated from 1 source of truth (`vgate.yaml` + `features/`).
2. **`vgate guard` as an Execution Mechanism, Not a Policy**:
   - CI reads the pinned `vgate` version from **trunk (`PR_BASE` / `QUEUE_BASE`)**, never trusting a PR to downgrade its own judge.
   - Protected judge/guardrail paths (`vgate.yaml`, `guardrails.yaml`, `.vgate-ratchet.json`, `.vgate-quarantine.yaml`, `known-failures.yaml`, CI workflows, `CODEOWNERS`, `vgate-*` skills) fail closed (`needs-human`) and require out-of-band `CODEOWNERS` / protected-environment approval.
   - Phase 4/5 autonomy overrides live strictly out-of-band (`VGATE_ALLOW_AUTONOMY=1` CI/org env var), **never** in PR-editable `vgate.yaml`.
3. **Stacked Fail-Closed Verdict + Signed Evidence**:
   - Deterministic gates (`vgate lint`, `vgate gate`, `vgate guard`, deploy safety) are mandatory and non-overridable.
   - An independent cross-vendor live-app verifier (default `verifiers: 1`, `count > 1` optional) layers additively on top: it can `FAIL` or escalate (`PASS+NOTES`) a green deterministic gate, never override a red gate or weaken `vgate guard`.
   - Verdicts support cryptographic signing (`vgate.signature/1`, HMAC-SHA256 or Ed25519) with CI environment metadata attached (full GitHub OIDC JWT/JWKS attestation is a follow-up), using keys stripped from worker sandboxes.
4. **Flake Policy & Taste vs. Mechanical Boundary**:
   - Live-app lanes enforce retry budgets, `inconclusive` semantics on unquarantined flakes, and an expiring `.vgate-quarantine.yaml` ledger guarded by `vgate guard`.
   - User-facing UX/UI files (`uxPaths` / `DEFAULT_UX_PATHS`) route to `needs-approval` for human taste & dogfooding review even under `autoMerge: high`.
5. **True Vendor Agnosticism & Non-Clobbering Interop**:
   - Dual-layer adapter: canonical namespaced `vgate-*` skills + `vgate-verify` generated from `vgate.yaml` + `features/`, projected cleanly across `.agents/skills/`, `.claude/skills/`, `.cursor/skills/` + `.cursor/rules/vgate.mdc`, plus built-in stdio `vgate mcp` server.
   - Headless dispatch via built-in drivers (`claude`, `codex`, `agy`, `cursor`, `opencode`, `pi`, `omp`, `grokbot`) + generic YAML command driver (zero vendor lock-in).
6. **Hard Layer 1 ↔ Layer 2 Isolation**:
   - All external signal text (Slack, Linear, GitHub, GitLab, Jira, Sentry, review bots) is wrapped in `<untrusted_signal_data>` — strictly data, never executable instructions.
   - Worker sandboxes strip coordinator tokens, signing keys, and `VGATE_ALLOW_AUTONOMY`, default to `deny-default` egress, enforce 4-part handoff contracts (rejecting duration-only finish conditions), audit workers strictly via observable commits/artifacts, and obey instant zero-writes `vgate stop`.

## Package Layout

All modules live under `packages/` and compile into the single `vgate` binary with lazy tool hydration via `vgate doctor --fix`:

| Package                 | Responsibility                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/adapters`     | Dual-layer harness skill projector, headless CLI runner + generic YAML driver, and stdio MCP server (`vgate mcp`).                                                                                                                                                                                                                                                                                          |
| `packages/guardrails`   | Polyglot boundary/API/comment-density engine, brownfield ratchets, opt-in presets (`minimal-ts`, `dune-react`, `strict-go`, `strict-python`, `ast-grep`), rule fixtures (`vgate lint --test`), native linter bridge, rule-to-enforcer registry, and `vgate guard` rule.                                                                                                                                     |
| `packages/playbooks`    | Lean namespaced `vgate-*` skills (`skills/`), 1-source-of-truth `vgate-verify` generator, and blinded skill eval runner (`vgate eval`).                                                                                                                                                                                                                                                                     |
| `packages/verification` | Generalized surfaces (`cli`, `library` alongside `api`, `web`), unified Feature Maps + `vgate maintain`, flake policy & expiring quarantine, cryptographic verdict signing (`vgate.signature/1`), opt-in Tier-2 formal checks (`vgate formal`, best-effort `vgate statechart`, `vgate benchmark`), Patch-ID carry-over, 3-rebase ceiling, contiguous stacked landing, and artifact-first PR review bundles. |
| `packages/verifier`     | Cross-vendor single-default Independent Live-App Verifier (`vgate verify`), Role Router, hard spend/retry circuit breakers, Dr. Eggbot routine ROI auditor, and local-first 5-KPI ledger (`vgate metrics` + HTML/Prometheus export).                                                                                                                                                                        |
| `packages/maturity`     | 5-phase maturity engine (`vgate maturity`): Phases 1–3 advisory readiness; Phases 4–5 out-of-band `VGATE_ALLOW_AUTONOMY` seatbelt.                                                                                                                                                                                                                                                                          |
| `packages/factory`      | Experimental Layer 1 control-plane primitives (`vgate factory`), 4-part handoff contract, instant zero-writes `vgate stop`/`resume`, credential-isolated sandboxes including kernel-isolated `DockerSandbox` (`--network none`), untrusted-input signal connectors + post-release fuzz diffing, and side-effect trail auditor.                                                                              |

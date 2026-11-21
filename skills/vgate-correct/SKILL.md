---
name: vgate-correct
description: Escalate any recurring agent mistake up the 4-level deterministic hierarchy into guardrails.yaml rules with known-bad/known-good fixtures (`vgate lint --test`) instead of piling prose into AGENTS.md.
pack: core
---

# vgate-correct

Triggered whenever an agent repeats a mistake twice. Fix the entire error class at the highest deterministic level that works.

## 4-Level Escalation Hierarchy

1. **Architecture**: Single owner per state, single supported path per recurring task, hide internal modules, delete deprecated patterns agents might mimic.
2. **Types, Guardrails & Ratchets**: Make illegal states unrepresentable in types. Otherwise add a rule to `guardrails.yaml` (boundary, banned pattern with exact `replaceWith`, or native linter / `ast-grep` rule). For legacy brownfield code, enable `ratcheted: true` and baseline existing occurrences so only new regressions fail.
3. **Behavioral Tests**: Add an observable behavior scenario to `inventory.yaml` / tests and prove it fails against the bug (`vgate mutate` or fail-first check).
4. **Prose Rule Table (Last Resort)**: Only for genuinely subjective judgment calls. Add a row to `## Rule Table` in `AGENTS.md` naming its automated enforcer (or explicitly `judgment`).

## Mandatory Proof ("Able to Fail")

- Every new rule in `guardrails.yaml` MUST include `fixtures.bad` and `fixtures.good`.
- Run `vgate lint --test --json` and `vgate lint --json` to prove the rule catches the bad fixture, passes the good fixture, and passes the repository.

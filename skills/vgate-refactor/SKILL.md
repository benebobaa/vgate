---
name: vgate-refactor
description: Behavior-preserving refactoring — pin observable behavior before editing, migrate all callers and delete legacy paths in one wave, and revert if reader load does not drop.
pack: core
---

# vgate-refactor

Refactoring without an executable behavior pin is guessing. Type-checking and linting are NOT behavior pins.

## Steps

1. **Pin Observable Behavior**: Confirm existing `vgate gate` scenarios (or add a characterization/equivalence test) cover the behavior being refactored, and verify they pass before touching code.
2. **One-Wave Migration**: Migrate all callers off the legacy API and delete the legacy path in the same change — leave zero dual paths or compatibility shims for future agents to mimic.
3. **Tighten Ratchets**: If the refactor eliminated legacy violations in `.vgate-ratchet.json`, run `vgate lint --update-ratchet` so the baseline ratchets down permanently.
4. **Verify & Check Reader Load**: Run `vgate lint`, `vgate gate`, and `vgate guard`. If the refactor did not lower reader load or simplify boundaries, revert it.

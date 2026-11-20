---
name: vgate-formal
description: Opt-in Tier-2 formal verification (TLA+, Bombadil UI fuzzing, Lean), Sync Commit Tracking, Mutation Proof ("able to fail"), best-effort Mermaid statecharts, and 7-question performance benchmarks.
pack: rigor
---

# vgate-formal

Reserve formal methods and rigorous benchmarks for the highest-harm invariants and user-visible latency paths.

## Engine Selection Matrix

- **Event ordering, retries, locks, distributed sync** -> `TLA+` (`vgate formal`)
- **Chaotic UI click/keyboard exploration** -> `Bombadil` (`@antithesishq/bombadil`)
- **Unbounded algorithmic invariants** -> `Lean`
- **Performance claims** -> `vgate benchmark` (7-question Explain-the-Number rigor; defaults to `inconclusive` when any check or limiter is missing)

## Non-Negotiable Safeguards

1. **Mutation Proof ("Able to Fail")**: A formal check that never failed proves nothing. Run `vgate formal --verify-mutation` with a scratch defect and verify the engine catches it and restores the file cleanly.
2. **Sync Commit Tracking**: Record `syncCommit` and `coveredFiles` in the formal spec config. Whenever covered production code changes, re-sync the model strictly from code and re-run `vgate formal`.
3. **Best-Effort Statecharts**: Use `vgate statechart` to render a readable Mermaid state diagram (<=500 states, ~20 arrows) for PM/designer review; reproduce any flagged counterexample in real code before filing a bug.

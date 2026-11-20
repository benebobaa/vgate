---
name: vgate-bugfix
description: Fail-first bug fix workflow — reproduce the failure on the real surface before patching, apply the minimal root-cause fix, and prove the exact same check passes under vgate.
pack: core
---

# vgate-bugfix

Never patch a bug you have not first watched fail on the real surface.

## Steps

1. **Reproduce First**: Write or run a check targeting the exact user-observable failure (API, Web, CLI, or Library surface) and confirm it FAILS on current code.
2. **Attack the Premise**: If two fix attempts fail, stop patching symptoms — write down the shared assumption and test it directly.
3. **Minimal Root-Cause Patch**: Apply the smallest diff that fixes the root cause without adding dead code, workarounds, or dual paths.
4. **Prove It Works**: Re-run the exact same failing check and confirm it PASSES. Run `vgate lint --json`, `vgate gate --service <svc> --json`, and `vgate guard --service <svc> --base <base> --json`.
5. **Record Escapes**: If the bug reached production, register it via `vgate incident add` so it cannot escape twice. Log explicit reasons for any skipped step.

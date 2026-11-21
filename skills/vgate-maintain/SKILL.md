---
name: vgate-maintain
description: Run a scheduled read-only drift audit of Feature Maps and verification harnesses (`vgate maintain`). Never edits product code; exits clean, changed, or blocked.
pack: core
---

# vgate-maintain

Keep Feature Maps (`features/`) and runtime verification skills synced with the codebase without hiding product regressions.

## Rules

1. Run `vgate maintain --service <svc> --json`.
2. **Hard Boundary**: NEVER edit product source code during maintenance. If a mapped user flow is broken in the app, report a product regression (`blocked`) instead of weakening the feature map or test.
3. Reconcile selector/route/endpoint drift strictly inside `<servicesDir>/<svc>/features/` and regenerate `vgate-verify` if needed.
4. Execute one live verification pass (`vgate gate --service <svc> --json`) to prove the updated map works end-to-end.
5. End in strictly one of three outcomes: `clean` (no PR), `changed` (PR confined exclusively to verification/feature-map files), or `blocked` (product regression or broken precondition reported).

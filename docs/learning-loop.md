# The learning loop

No gate catches everything. What it can do is never let the same bug through twice, and show whether it is getting
better. vgate does both with incidents (bugs that escaped to production) and with provider drift checks (the one
blind spot of contract-checked stubs).

## Incidents

An incident is a bug that reached production. Recording it turns it into a permanent part of the gate:

```bash
vgate incident add --service orders --title "Refunds above the order total were accepted" \
  --ticket OPS-412 --evidence "X-Request-Id 3f2a…" --missed-by missing-scenario
```

This writes `<service dir>/incidents/INC-<n>.yaml` and adds scenario `INC-<n>` to the plan (`inventory.yaml`,
under `incidents.scenarios`), its expectation left as a TODO: the correct behaviour comes from the spec or the ticket,
never from what the fixed code returns. Then a test titled `[INC-<n>] …` reproduces the incident; it must fail on the
code that shipped the bug and pass on the fix. The agent skill `learn-from-incident` walks an agent through exactly
that.

```yaml
# incidents/INC-3.yaml
title: Refunds above the order total were accepted
date: 2026-11-19
ticket: OPS-412 # optional
evidence: X-Request-Id 3f2a… # optional: a request id, a curl, a path to http-calls.json
missedBy: missing-scenario # why the gate let it through (below)
reason: … # required with missedBy: not-testable
scenario: INC-3 # always the incident's own id
status: guarded # open | guarded | closed
```

`missedBy` is the lesson's class:

| Class              | The gate missed it because                                             | Besides the test, fix                    |
| ------------------ | ---------------------------------------------------------------------- | ---------------------------------------- |
| `spec-gap`         | No source described the correct behaviour                              | The spec: add the rule the test cites    |
| `missing-scenario` | The spec said it; the plan had no scenario for it                      | Nothing else: the scenario was the gap   |
| `stub-drift`       | A provider changed under its vendored contract                         | Declare a sandbox and run `vgate drift`  |
| `environment`      | Production differs from the sealed environment                         | Bring the difference into `environment:` |
| `not-testable`     | No black-box test can observe it (needs `reason`, reviewed by a human) | Monitoring, or a test at another level   |

### What the gate enforces

- **Coverage** (the `coverage` step): every incident needs its scenario in the plan and a test the run collected
  whose title carries `[INC-<n>]` (whole id: `[INC-12]` does not guard INC-1). Otherwise the step fails with
  "incident INC-3 has no regression test". `missedBy: not-testable` with a reason is exempt.
- **Guard** (rule `incident-dropped`): deleting an incident file, re-pointing its `scenario`, or newly marking it
  `not-testable` needs a human. Removing its scenario or its test is caught by `plan-weakened` and `tests-weakened`.
  A new incident is information, never a finding.

### Is it learning?

```bash
vgate incident report [--service orders] [--json]
```

Counts per `missedBy`, how many incidents a regression test now guards, and the share of testable escapes the gate
would catch today (guarded / (all - not testable)). It reads the last run's JUnit reports; without a run, the test
sources (and says so). Over months, watch two numbers: escapes per release going down, and the classes shifting away
from `missing-scenario` (the plan is getting more complete) toward the rarer `environment` and `spec-gap`.

## Provider drift

Stubs of third parties may only answer what each provider's vendored contract documents. That keeps them honest
about the contract, but not about the provider: if the provider changes and the vendored contract does not, the stubs
and the tests keep agreeing with each other while production breaks. `vgate drift` asks the provider's own sandbox:

```yaml
# service.yaml
environments:
  local:
    dependencies:
      payments:
        kind: http-stub
        adminUrl: '{payments.adminUrl}'
        contract: deps/payments.openapi.yaml
        sandbox: # read only by vgate drift; its ${VAR}s never stop the gate
          url: https://sandbox.payments.example
          headers: { Authorization: 'Bearer ${PAYMENTS_SANDBOX_KEY}' }
          requests: # optional; default: every GET of the contract without path parameters
            - { operation: 'POST /charges', body: { amount: 100, currency: IDR, customer: c1, reference: drift-1 } }
            - { operation: 'GET /charges/{id}', path: /charges/ch_test_1 }
```

```bash
vgate drift --env local [--service orders] [--dependency payments]
```

Every answer is held strictly to the vendored contract: an undocumented status, a missing required field or a field
the contract does not declare is drift. A missing field next to a new one is reported as a likely rename. Requests
and bodies are checked against the contract before anything is sent.

| Exit | Meaning                                                                                |
| ---- | -------------------------------------------------------------------------------------- |
| 0    | Every sandbox answer matches the vendored contract                                     |
| 1    | Drift: the operation, status and fields are named (a sure finding wins over an outage) |
| 2    | A wrong call, or no dependency of the environment declares a sandbox                   |
| 3    | Nothing could be compared: a sandbox unreachable, or a secret it names not set         |

`vgate init --ci github` installs `.github/workflows/vgate-drift.yml`: daily, it runs `vgate drift` and opens (or
updates) one issue titled "vgate: provider drift". The repository variable `VGATE_DRIFT_ENVIRONMENT` names the
environment (default `local`); its GitHub environment holds the secret `VGATE_ENV` (`KEY=value` lines). A project
with no sandbox declared gets a green run and a note.

Write requests to a sandbox only where the provider's sandbox is made for it (test cards, test accounts). Drift on a
fixed day is a reason to update the vendored contract (then the gate holds stubs and tests to it) or to ask the
provider why it changed, not to loosen anything.

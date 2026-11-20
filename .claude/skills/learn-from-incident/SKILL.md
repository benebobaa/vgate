---
name: learn-from-incident
pack: core
description: Turns a bug that escaped to production into a permanent vgate regression test - records the incident with `vgate incident add`, writes its scenario and a test that goes red on the buggy commit and green on the fix, runs the gate and the guard, and classifies why the gate missed it. Use when a production bug, incident, outage, postmortem, escaped defect or customer-reported failure needs a regression test, when someone asks "would vgate have caught this?", or when the coverage step reports an incident without a regression test.
---

# Learn from an incident

An **escape** is a bug the gate let through to production. Each escape is a lesson the gate has not learned yet: once
it carries a scenario and a test titled `[INC-<n>]`, the coverage step fails whenever that test goes missing, so the
same bug cannot escape twice. Your job is to make the test prove the lesson: **red** on the code that shipped the bug,
**green** on the fix.

`<svc-dir>`, the commands, the JSON envelope and the vgate docs are as in `../generate-api-tests/SKILL.md` ("Where
things are"). The incident file and the coverage rules are in the vgate docs, `learning-loop.md`.

## The rule

The expectation comes from the spec or the ticket: the contract, the README's rules, the acceptance criteria, what the
product owner says should happen. Never from what the fixed code returns now; a test copied from the fix's output
proves only that the fix does what it does. When no source says what is correct, record the question in the plan's
`openQuestions` and ask a human before writing the expectation.

Known failures stay with humans: an incident is never tolerated through `known-failures.yaml`.

## Workflow

### 1. Record

Gather the evidence: the ticket, the request id or `http-calls.json`, the logs, the commit that shipped the bug and
the commit that fixes it (if there is one yet).

```bash
vgate incident add --service <svc> --title "<what went wrong, in the user's words>" \
  --ticket <id> --evidence "<request id, curl or path>" --missed-by <class>
```

`--missed-by` is your diagnosis of why the gate let it through:

| Class              | The gate missed it because                                                              |
| ------------------ | --------------------------------------------------------------------------------------- |
| `spec-gap`         | No source described the correct behaviour (the spec needs the rule, then the test)      |
| `missing-scenario` | The spec said it, the plan had no scenario for it                                       |
| `stub-drift`       | A provider changed under its vendored contract (also run `vgate drift`)                 |
| `environment`      | Production differs from the sealed environment (config, data volume, a real dependency) |
| `not-testable`     | No black-box test can observe it; give `--reason`, and expect a human to review it      |

Done when `<svc-dir>/incidents/INC-<n>.yaml` exists and, unless not testable, the plan holds scenario `INC-<n>`.

### 2. Write the scenario and the test

Fill in the scenario's `expect` in `inventory.yaml` from the source (cite it in `sources`), then the test, titled
`[INC-<n>] <behaviour>`, reproducing the incident's request as closely as the evidence allows. Use the conventions of
`../generate-api-tests/references/test-conventions.md`.

Done when the test asserts the specific behaviour the incident broke, not merely a status code.

### 3. Prove red, then green

1. On a checkout of the commit that shipped the bug (or the current code, when the fix is not written yet):
   `vgate up`, then `vgate gate --service <svc> --steps test --json`. The `[INC-<n>]` test must be **red**, failing on
   the incident's symptom. If it is green, it does not reproduce the escape: revise the test, not the expectation.
2. On the fix: `vgate gate --service <svc> --json`. The whole gate must be green, and the coverage step must report
   no unguarded incident.

Done when you have seen both verdicts, and you quote both in your report (summary and the failing message of the red
one).

### 4. Guard and close

Run `vgate guard --service <svc> --base <base ref> --json`. Adding an incident and its test weakens nothing; any
finding means something else changed and needs explaining. Set the incident's `status: guarded`.

Report: the incident id, the class and why, the red and green evidence, the guard result, and anything the class says
the team should change beyond the test (a spec rule to add, a sandbox to declare for `vgate drift`, a production
difference to bring into the sealed environment). `vgate incident report` shows the learning so far.

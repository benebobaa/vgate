# Known failures

A test that fails because the backend disagrees with its spec is a finding, not a test to change. While the fix is
on its way, the gate can tolerate that one failure, but only through one file per service:
`services/<svc>/known-failures.yaml`. Tests never mark themselves as failing; ESLint refuses `test.fail`,
`test.fixme` and `testInfo.fail` in `services/*/tests` and `services/*/support`.

```yaml
failures:
  - id: CRT-201 # the scenario id in the test title: [CRT-201]
    match: 'with tags' # optional: only the tests whose title also contains this text
    ticket: BUG-123 # one word
    owner: team-api
    expires: 2026-12-31 # YYYY-MM-DD; the entry applies through this day
    reason: FINDINGS.md F-001, updatedAt is returned as null
```

## Who may change it

| Change           | Who                                                                  |
| ---------------- | -------------------------------------------------------------------- |
| Add an entry     | A human, in a reviewed MR. The file is a protected path (CODEOWNERS) |
| Renew an expiry  | A human, with the ticket's current state in the MR description       |
| Remove an entry  | Anyone, agents included: the gate tells you when one must go         |
| Narrow (`match`) | Anyone: it tolerates less                                            |

An agent that finds a failure it cannot resolve records it in `FINDINGS.md` and proposes the entry in its MR
description (id, ticket, reason). It never edits this file.

## What the gate does with it

| Situation                                             | Result                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| A registered test fails                               | Tolerated; listed under `tests.knownFailures` in `reports/verdict.json`   |
| A registered test passes                              | **Red**: "expected to fail, but passed". The fix landed; remove the entry |
| An entry has expired                                  | **Red**; its test runs as a normal test again                             |
| An entry matches no test of a complete run            | **Red** (stale): the test was renamed or removed                          |
| The file is malformed (missing field, bad id or date) | **Red** before any test runs; every problem is named                      |

The check runs inside `task test` (`framework/cli/known-failures.ts`), so `task gate` and `vgate gate` agree. A run
filtered with `task test -- --grep ...` checks expiry only, since a test missing from it proves nothing.

Every tolerated failure stays visible: the verdict counts it, names its ticket, and the Playwright and Allure reports
show it as an expected failure with a `known-failure` annotation.

# The expectation guard (`vgate guard`)

The gate checks the code against the expectations. The guard checks the expectations themselves. It compares a base
git ref with the working tree and decides one of two things:

- **`auto`**: nothing the gate verifies was weakened, so a green gate is enough to merge.
- **`needs-human`**: the change weakens what the gate verifies, so a human must approve it.

This is how "code and tests merge on a green gate; only weakened expectations need a human" is enforced instead of
remembered. An agent may write the code, the tests and the plan in one merge request. It cannot also make the gate
easier to pass without a person seeing it.

```bash
vgate guard --service <svc> --base <git ref> [--json]
```

The guard reads base files with `git show <ref>:<path>` and head files from the working tree, untracked files
included. The project may sit below the git top level. The result is written to `reports/guard.json`
(`schema: vgate.guard/1`):

```json
{
  "schema": "vgate.guard/1",
  "service": "example",
  "base": "main",
  "decision": "needs-human",
  "findings": [
    { "rule": "plan-weakened", "file": "services/example/inventory.yaml", "detail": "scenario HLT-200 removed" }
  ],
  "info": []
}
```

`findings` are the weakenings. `info` lists the changes the guard judged additive, such as a new operation, scenario,
optional field or test, so a reader can see that the guard looked at them.

| Exit code | Meaning                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| 0         | `auto`                                                                         |
| 1         | `needs-human`; `next` names each file a human must review and the rules it hit |
| 2         | Wrong call: no `--base`, a base ref git does not know, or a service in neither |
| 3         | Not a git repository                                                           |

## What it checks

| Rule                  | File                                                      | Needs a human when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract-breaking`   | `services/<svc>/openapi.yaml` (or `spec` in service.yaml) | An operation is removed; a documented (operation, status, code) is removed, using the same loader as the coverage gate; a response property is removed or changes type (after `$ref`, `allOf`/`oneOf`/`anyOf` and array items are resolved); a request property, request body or parameter becomes required; the contract is deleted or no longer loads                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `plan-weakened`       | `services/<svc>/inventory.yaml`                           | A scenario id is removed (per operation or in a cross-cutting section such as `auth`); a new `excluded` entry appears; the plan is deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `config-loosened`     | `services/<svc>/service.yaml`                             | `coverage.exclude` gains an entry; `rules.strictResponseProperties` is turned off; `rules.optionalPropertiesNullable` is turned on; `rules.datetimeOffset` or `rules.envelope` is removed; a header rule is removed or changed; `schemathesis.excludeChecks` gains an entry; `schemathesis.maxExamples` is lowered (a removed value counts as the default 25); `schemathesis.users` loses an identity or narrows from every user to a list; `schemathesis.readOnlyPaths` or `readOnlyMethods` changes; `rules.streaming` changes or is removed; for a UI service ([frontend.md](frontend.md)): `ui:` removed, `ui.a11y.minImpact` lowered, an axe rule added to `ui.a11y.disable`, an origin added to `ui.allowedOrigins`, a viewport removed, a budget in `ui.budgets` removed or raised |
| `known-failure-added` | `services/<svc>/known-failures.yaml`                      | An entry is added (keyed by `id` and `match`), or its `expires` moves later. Removing an entry is info                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `incident-dropped`    | `services/<svc>/incidents/INC-<n>.yaml`                   | An incident is deleted, its `scenario` changes, or it is newly marked `missedBy: not-testable` (which exempts it from the coverage gate). A new incident is info ([learning-loop.md](learning-loop.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tests-weakened`      | `services/<svc>/tests/**`, `services/<svc>/support/**`    | A source file is deleted; a file has fewer assertion calls (`expect…(`, comments ignored) than at the base; a scenario id `[ID]` in the base sources is in none of the head sources; a file gains `.fail(`, `.fixme(` or `.skip(`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `visual-changed`      | `services/<svc>/tests/**/__screenshots__/**/*.png`        | A committed visual baseline is changed or deleted (the image diff is in the run's evidence). A new baseline is info ([frontend.md](frontend.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `machinery-changed`   | the judge                                                 | Any change to `vgate.yaml`, `.github/workflows/vgate.yml`, `.gitlab-ci.yml`, `.github/CODEOWNERS`, `.gitlab/CODEOWNERS`, `framework/`, `cli/`, `.claude/skills/`, `Taskfile.yml`, `playwright.config.ts`, `eslint.config.js`, `tsconfig.json`, `package.json`, `pnpm-lock.yaml`, `.prettierrc.json` or `.prettierignore`, or a file directly in the services directory                                                                                                                                                                                                                                                                                                                                                                                                                    |

A changed header rule counts as a finding even when it might be stricter. The guard cannot tell whether a new regex
or template accepts more, so a person decides.

## How CI uses it

In a merge request pipeline the guard runs next to the gate, from the same pinned `vgate` image. The judge never comes
from the merge request:

```bash
vgate guard --service "$SERVICE" --base "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --json
```

- `auto` together with a green gate means the merge request may merge without anyone reviewing it.
- `needs-human` blocks the automatic merge until an approval from the owners of the flagged paths resolves it.
- `machinery-changed` exists because in CI the gate and the guard run from the image, not from the merge request's
  copy. A merge request that edits the judge is reviewed by a person, then released as a new image.

The pipeline wiring and the approval rule are described in [ci.md](ci.md).

## Limits

The guard compares text and structure, not meaning.

- **Assertions:** it counts assertion calls per file. It cannot tell whether a changed assertion is weaker, for
  example `toBe(201)` changed to `toBeGreaterThan(0)`, or whether an assertion moved into a helper outside `support/`.
- **Renames:** a renamed test file reads as one file deleted and one added, so it is flagged. A human confirms the
  rename.
- **Contract coverage:** request-side changes are checked only for newly required properties, bodies and parameters,
  not for removed request properties. Changes to enums, formats inside `oneOf` branches, and constraints such as
  `maxLength` or `minimum` are not compared.
- **Code:** it never looks at application code. That is the gate's job, and a green gate is still required.

The code review of the tests remains the place to judge assertion strength. The guard makes sure that review happens
whenever an expectation got easier to meet.

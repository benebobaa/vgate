# Projects and the runtime

vgate verifies any repository. The repository holds what is verified: the contract, the plan and the tests. The
framework that verifies it, called the runtime, never lives there, so a merge request cannot edit its own judge.

## A project

A project is any directory with a `vgate.yaml`. `vgate init` writes it:

```yaml
version: 0.3.0 # the vgate this project is pinned to
servicesDir: regression # default regression: <servicesDir>/<service>/service.yaml
reportsDir: reports # default reports: verdict.json, guard.json, JUnit, traces, logs
```

```
vgate.yaml
regression/
  <service>/
    service.yaml            what is verified and how to reach it (rules, environments, users, dependencies)
    openapi.yaml            the vendored contract
    inventory.yaml          the test plan
    known-failures.yaml     optional, human-only (docs/known-failures.md)
    stack.sh                up | down | status | reset
    support/ tests/
  node_modules              generated: a symlink to the runtime's node_modules (gitignored)
  tsconfig.json             generated: the runtime's TypeScript settings over the services (gitignored)
  package.json              generated: makes the tests ES modules, like the framework (gitignored)
reports/                    gitignored
```

The project needs no `package.json`, `node_modules` or framework code of its own. vgate rewrites the three generated
files on every run. If a file with one of those names exists and vgate did not write it, vgate refuses to replace it
and says so.

A directory without `vgate.yaml` that has `framework/config.ts` next to `services/` is the old layout. It still works
(services in `services/`, evidence in `reports/`).

## The runtime

The runtime is made of `framework/`, `cli/`, `package.json`, `pnpm-lock.yaml`, the TypeScript, ESLint, Playwright and
Prettier configs, and `Taskfile.yml`.

- **The binary** carries these files. The first command that needs them extracts them to
  `$VGATE_HOME/<version>-<hash>/runtime` (`VGATE_HOME` defaults to `~/.cache/vgate`) and runs
  `pnpm install --frozen-lockfile` there once. `vgate doctor` reports whether this has happened and
  `vgate doctor --fix` does it. `gate` and `up` also do it themselves when they need to.
- **From source** (`pnpm vgate`), the runtime is the checkout itself.

Every gate step runs from the runtime against the project. vgate passes the project to the steps in these
environment variables:

- `VGATE_PROJECT`
- `VGATE_SERVICES_DIR`
- `VGATE_REPORTS`
- `VGATE_RUNTIME`
- `VGATE_STACK_LIB`

Where the checks apply:

- **Typecheck** uses the generated `<servicesDir>/tsconfig.json`, which extends the runtime's.
- **Lint** uses the runtime's ESLint rules and Prettier settings, over `<servicesDir>` only. The project's own lint
  config is not used, because it could weaken the judge.
- **Playwright** runs with the runtime's config. Its `testDir` is `<servicesDir>/<service>/tests`.

## How the tests reach the framework

Tests import the framework by package name:

```ts
import { createTest, expect } from '@vgate/framework/fixtures.ts';
import { Db } from '@vgate/framework/db/postgres.ts';
```

`<servicesDir>/node_modules` is a symlink to the runtime's `node_modules`. In there, `@vgate/framework` is linked to
the runtime's `framework/` (the runtime's `package.json` declares `"@vgate/framework": "link:framework"`). So Node,
tsx, Playwright, tsc and ESLint resolve `@vgate/framework`, `@playwright/test` and `pg` the same way. There is one
copy of each package, which is what Playwright requires of `@playwright/test`.

## Stack scripts

A `stack.sh` gets its building blocks from the library vgate names in `VGATE_STACK_LIB`:

```bash
source "${VGATE_STACK_LIB:?run through vgate: vgate up --service <name>}"
```

The library sets three paths for the script:

| Variable        | Holds                                                         |
| --------------- | ------------------------------------------------------------- |
| `STACK_ROOT`    | the project                                                   |
| `STACK_RUNTIME` | the runtime (`$STACK_RUNTIME/node_modules/.bin/tsx` is there) |
| `STACK_REPORTS` | where its logs and build id go                                |

## The version pin

`vgate.yaml`'s `version` names the vgate that may judge the project. Another version refuses to run `gate`, `guard`
or a stack command. It exits 3 and names the install command for the pinned version:

```
curl -fsSL https://vgate.benelabs.tech/install.sh | VGATE_VERSION=<version> sh
```

A development build (`dev`, run from source) runs any project. `doctor` warns about it.

The guard treats `vgate.yaml` as machinery: moving the pin changes the judge, so it needs a human. Files directly in
`<servicesDir>/` (not in a service) and `.github/workflows/vgate.yml` count as machinery too.

## `vgate init`

```
vgate init [--service <name>] [--ci github|gitlab] [--force] [--root <dir>]
```

It writes:

- `vgate.yaml`, pinned to the running version
- a service skeleton: `service.yaml`, a placeholder contract, a plan, fixtures, one test and `stack.sh`
- the `.gitignore` lines for what vgate generates
- the agent skills, into `.claude/skills`
- a "Verification gate (vgate)" section appended to `AGENTS.md` and `CLAUDE.md` where they exist; the existing text
  is never rewritten
- with `--ci github`: `.github/workflows/vgate.yml`, plus `.github/CODEOWNERS.vgate.example` to merge by hand

Running it again changes nothing. A file that exists with other content is kept unless `--force` is given. `--json`
lists every file and what happened to it.

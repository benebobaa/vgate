# Deploy safety

A pull request can pass every test and still fail the moment it is deployed. Two causes account for most of those
failures, and both are visible before the merge:

1. **The contract breaks the clients of what is running.** A response field is removed, a parameter becomes
   required. The guard compares a change with its base branch, but the base may already hold a breaking change that
   never reached production, and the clients that matter (mobile apps, partners, other services) talk to production.
   `vgate compat` compares with the version **deployed** in each environment.
2. **The code needs a setting the environment does not have.** A change starts reading `PAYMENTS_URL`; nobody added
   it to production; the new version crashes at start-up. `vgate config-check` compares the settings the service
   requires with the settings each environment provides.

Both run inside `vgate decide`, so the pull request comment has a "Safe to deploy" section, and both are commands of
their own for a person or an agent to run before opening the pull request.

## Configuration

```yaml
# vgate.yaml
deploy:
  environments:
    production:
      contract: { ref: 'tag:v*' } # the deployed version: the newest git tag matching v*, by version order
      config: { file: deploy/production.env.example } # the keys production provides
    staging:
      contract: { url: https://staging-api.example.com/openapi.json } # or the contract the environment serves
      config:
        - { file: k8s/staging/configmap.yaml }
        - { file: k8s/staging/deployment.yaml }
  policy:
    breaking: needs-approval # or block: a change that breaks a deployed contract never merges
```

```yaml
# regression/orders/service.yaml
config:
  required: [DATABASE_URL, PAYMENTS_URL, PAYMENTS_SIGNING_SECRET] # the settings the service cannot start without
```

### Where the deployed contract comes from

| `contract:`                         | Reads                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `{ ref: 'tag:v*' }`                 | the service's contract at the newest git tag matching `v*` (version order: `v1.10.0` after `v1.9.0`) |
| `{ ref: production }`               | any branch, tag or commit: for teams that track what is deployed in a branch                         |
| `{ url: https://.../openapi.json }` | the contract the environment serves, JSON or YAML, fetched with a 10 second timeout                  |

Use a ref when every deploy is tagged (the common case: release tags). Use a URL when the environment can serve its
contract; it then reflects exactly what runs, including hotfixes deployed without a tag. In CI the checkout must
include tags and history (`actions/checkout` with `fetch-depth: 0`, which the vgate workflow uses).

If the deployed version has no contract for the service, the service is not deployed there yet: nothing depends on it,
and the check passes with that note.

### Where an environment's settings come from

| `format:` (guessed when absent) | Keys read                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `dotenv` (`.env` file names)    | `KEY=value` and `export KEY=value` lines                                                       |
| `k8s` (YAML with `kind:`)       | ConfigMap and Secret `data`, `stringData`, `binaryData`; container `env` names in any workload |
| `keys`                          | a YAML or JSON list of names, or a mapping whose keys are the names                            |

Several files add up. Only key names are read; values are never printed, stored or compared. `envFrom` references in
Kubernetes are not followed (the check says so): list those keys in a ConfigMap or Secret file the check reads.

The config files are a declaration of what an environment provides. For teams that deploy from manifests in the
repository (GitOps), they are the real configuration. For teams whose settings live in a secret manager, keep a
`<environment>.env.example` that lists the key names, and treat adding a key to it as part of adding the setting.

## What the decision does with it

| Result                                                       | Decision                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| a required key is missing from an environment                | `blocked`: deploying would fail                               |
| the contract breaks what clients of the deployed version use | `needs-approval` (or `blocked` with `policy.breaking: block`) |
| the deployed contract or a config file cannot be read        | `needs-approval`: unknown is never treated as safe            |
| the change edits a config file of `deploy:` itself           | `needs-approval`: a person confirms the settings exist there  |
| compatible, and every required key present                   | no effect: the other rules decide                             |
| no `deploy:` block                                           | no effect; the comment says deploy safety was not checked     |

The comment names the keys the change **newly** requires (absent from the base's `service.yaml`), since that is the
usual cause, and the keys that were already missing, which mean the config file is out of date.

The checks run for every service the change affects, in every environment. They need no running stack: git, the
files in the repository, and for a URL source, one request.

## Commands

```bash
vgate compat --service orders                         # every environment of deploy:
vgate compat --service orders --environment production
vgate config-check --service orders --base origin/main # --base: mark the keys this change newly requires
```

| Exit | `compat`                                  | `config-check`                          |
| ---- | ----------------------------------------- | --------------------------------------- |
| 0    | compatible everywhere (or not configured) | complete everywhere (or not configured) |
| 1    | breaks the deployed contract somewhere    | a required key is missing somewhere     |
| 3    | a deployed contract could not be read     | a config file could not be read         |

## Limits

- The contract rules are the guard's: removed operations and documented responses, removed or retyped response
  properties, newly required request properties and parameters. A change in meaning that keeps the same shape is not
  a contract change; the gate's scenarios catch those.
- `config.required` is a declaration in the repository. A change that starts reading a new setting without declaring
  it passes this check; the gate's stack, started with the environment's keys only, is where that shows.
- Database migrations, the other classic deploy failure, are checked by `vgate migrations` (below).

## Database migrations

Migrations run before the new code is live: for a while, the version deployed today runs on the new schema. That
window is where a deploy takes production down, so a change that adds migrations is checked against it before it
merges.

```yaml
# regression/orders/service.yaml
environment:
  dependencies:
    db:
      kind: postgres
      seed: seed.sql # loaded after the migrations that exist at the base
      migrate:
        dir: services/orders/db/migrations # repository path, from vgate.yaml's directory
        command: goose -dir /migrations postgres "$DATABASE_URL" up
        down: goose -dir /migrations postgres "$DATABASE_URL" down # undoes one migration per run; optional
        image: ghcr.io/kukymbr/goose-docker:3.26.0 # default: the dependency's own image (psql for postgres)
        smoke: 'GET /' # Playwright --grep of the base tests that run on the migrated schema; default 'GET /'
```

`command` and `down` run in a container on the environment's sealed network, with the migrations mounted at
`/migrations` and `DATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (and `PGPASSWORD`)
pointing at the dependency. `vgate up` runs them too, between the database being ready and its seed. Any tool that
runs in a container fits:

| Tool                         | `command` (the image ships the tool)                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| goose                        | `goose -dir /migrations postgres "$DATABASE_URL" up`                                                                                       |
| golang-migrate               | `migrate -path /migrations -database "$DATABASE_URL?sslmode=disable" up`                                                                   |
| Flyway                       | `flyway -url=jdbc:postgresql://$DB_HOST:$DB_PORT/$DB_NAME -user=$DB_USER -password=$DB_PASSWORD -locations=filesystem:/migrations migrate` |
| Alembic, Prisma, knex, Rails | the app image with its migrate subcommand (`image:` = the app's), pointing it at `$DATABASE_URL`                                           |
| plain SQL                    | psql in the postgres image, as `services/example-migrations/service.yaml` does                                                             |

`vgate migrations --service <svc> --base <ref>` checks the migrations the change adds (forward files only: a
`*.down.sql` or Flyway `U<n>__` file undoes one and is not counted):

1. **Lint** (PostgreSQL): the added `.sql` files through [squawk](https://squawkhq.com) (`squawk-cli`, pinned, run
   with npx on demand so only projects with Postgres migrations download it). The findings that are a real risk for
   the running version - a NOT NULL column without a default, an index built without `CONCURRENTLY`, a renamed or
   dropped column or table, a type change, a constraint or foreign key added without `NOT VALID`, a full-table lock -
   are risky; squawk's hygiene rules (timeouts, `IF NOT EXISTS`, bigint over int) are shown as information only.
2. **Apply**: a sealed environment of the merge base; its migrations, its seed, then this change's migrations. Each
   must succeed; the time each took is reported.
3. **Round trip** (with `down`): the added migrations are undone and applied again.
4. **Old code, new schema**: the app built from the merge base (the deployed code) starts on the migrated database,
   and the base's own read-only tests (the base's `smoke`, which the change cannot narrow) run against it.

| Outcome                                                        | `vgate migrations` | `vgate decide`                                                                     |
| -------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| applies, undoes, the deployed code passes, nothing risky       | safe, exit 0       | no objection                                                                       |
| a risky lint finding on migrations that otherwise pass         | exit 1             | needs a human                                                                      |
| not verifiable: squawk did not run, no smoke test matched      | exit 1             | needs a human                                                                      |
| an applied migration of the base edited or removed             | exit 1             | needs a human                                                                      |
| a migration does not apply or undo                             | blocked, exit 1    | blocked                                                                            |
| the deployed code fails on the migrated schema                 | blocked, exit 1    | blocked: "deploying this migration before the new code breaks the running version" |
| the change touches a migrations directory, no current evidence | -                  | blocked                                                                            |
| Docker, the base or the environment is not available           | exit 3             | (no evidence)                                                                      |

It writes `reports/migrations.json` (`vgate.migrations/1`), bound to the merge base and the commit like a gate
verdict; `vgate decide` reads it from the evidence directory and puts it under "Database migrations" in the pull
request comment. A migrations directory is high risk by default (`vgate risk`), so with `policy.autoMerge` below
`high` a person still approves; the evidence turns that into a short read.

Limits: one migrating dependency per service; the old-code check needs the deployed app to run as a container (a host
command is reported as not checked); squawk reads PostgreSQL only (MySQL migrations are applied and round-tripped, not
linted); the data is the seed, not production's volume, so the time a lock lasts on a large table is not measured.

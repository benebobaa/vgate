# example-migrations: the reference for `vgate migrations`

A read-only catalogue of items in PostgreSQL (`app/server.ts`). Its schema lives in `db/migrations` as plain SQL
(`NNNN_name.up.sql` and `NNNN_name.down.sql`), applied by the psql runner in `service.yaml`. It exists to show what
`vgate migrations --service example-migrations --base <ref>` checks before a change's migrations reach production: the
lint, the apply on top of the base's schema and seed, the round trip, and the version deployed today running on the
migrated schema (docs/deploy-safety.md).

Rules:

1. `GET /items` lists every item by id, each with its `name`.
2. A database error answers 500 with `{ error: "internal", message }`.

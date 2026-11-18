# example-orders: the framework's reference for a service with dependencies

An orders API that lives in this repo (`server.ts`) and talks to everything a typical microservice does: its own
PostgreSQL, a Redis cache, Kafka, and a third-party payment provider over HTTP. The dependencies run as real
containers (`compose.yaml`); the provider is WireMock, reached through toxiproxy, and every answer it gives comes from
a test's stub that its own contract (`deps/payments.openapi.yaml`) allows.

```bash
pnpm vgate up --service example-orders     # containers + app, about 10s once the images are pulled
pnpm vgate gate --service example-orders
```

| Dependency       | Kind (service.yaml) | What the tests do with it                                                                   |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| Payment provider | `http-stub`         | stub its answers (refused when the contract does not document them), read what the app sent |
| `orders.created` | `kafka`             | find the event of this test, schema-checked; prove nothing was published                    |
| Redis            | `redis`             | read idempotency and cache entries and their TTLs                                           |
| toxiproxy        | `toxiproxy`         | slow the provider down past the timeout, take it down (tests/faults only)                   |
| PostgreSQL       | `db`                | rows written, or not written                                                                |

The backend's own documentation would normally be the spec source; here it is this file, `openapi.yaml`, the
provider's contract and the event schema in `deps/`.

## Rules (the spec the tests cite)

1. Every call except `GET /health` needs an `X-Api-Key`. A missing or unknown key answers 401 `unauthorized` with
   `WWW-Authenticate: ApiKey`, before anything else is checked.
2. `POST /orders` needs an `Idempotency-Key` header (`^[A-Za-z0-9._-]{8,64}$`) and a body with `customerId`
   (`^[a-z0-9._-]{1,64}$`), `amount` (integer, 1 to 100000000, minor units) and `currency` (`IDR` or `USD`), and
   nothing else, sent as `application/json`. Anything else answers 400 `bad_request`; the header is checked before
   the body, and nothing is charged.
3. A repeat with the same `Idempotency-Key` and the same body answers 201 with the first order, without charging,
   writing or publishing again. The same key with a different body answers 409 `idempotency_conflict`. Only a created
   order is remembered (Redis `idempotency:<key>`, for 24 hours); after a decline or a failure the same key can be
   retried.
4. The order is paid first: `POST /charges` to the provider with `amount`, `currency`, `customer` (the `customerId`)
   and `reference` (the `Idempotency-Key`). The provider's 201 creates the order. Its 402 answers 402
   `payment_declined` with `reason` set to the provider's decline code. Any other answer, or no connection, answers
   503 `payment_unavailable`. No answer within 2 seconds answers 504 `payment_timeout`.
5. When the payment does not succeed (rule 4), nothing is written to the database, nothing is published and nothing
   is remembered.
6. A created order answers 201 with `status: paid` and the provider's charge id as `chargeId`, is stored in the
   `orders` table, and is published once on `orders.created` (key: the order id) as `deps/events/orders.created.schema.json`
   describes.
7. `GET /orders/{orderId}` answers the order, or 404 `not_found` for an unknown id or one that is not a UUID. It reads
   through Redis: the first read caches the order at `order:<id>` for 300 seconds.
8. Every response carries an `X-Request-Id` (UUID); every body is JSON; every datetime is UTC (`Z`).

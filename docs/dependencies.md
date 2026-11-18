# Testing a service with dependencies

A microservice is verified alone, with everything it talks to under the test's control: its own infrastructure
(database, cache, broker) runs as real containers, and every third party or sibling service is a stub that may only
answer what that provider's contract documents. Faults between the service and a dependency come from toxiproxy.
`services/example-orders` is the working reference: Postgres, Redis, Kafka, a stubbed payment provider and toxiproxy,
with a passing gate and a suite that turns red on each of seven deliberate bugs.

## Declaring them

Per environment in `service.yaml` (parsed by `framework/deps/config.ts`):

```yaml
environments:
  local:
    disposable: true
    dependencies:
      payments: # a third party
        kind: http-stub
        adminUrl: http://${STACK_HOST:-localhost}:58080 # WireMock
        contract: deps/payments.openapi.yaml # the provider's contract, vendored like the service's own
        proxy: payments # optional: the toxiproxy proxy between the service and the stub
      events:
        kind: kafka
        brokers: ['${STACK_HOST:-localhost}:59092']
        topics:
          orders.created: { schema: deps/events/orders.created.schema.json } # every topic needs a schema
      cache: { kind: redis, url: 'redis://${STACK_HOST:-localhost}:56379' }
      proxies: { kind: toxiproxy, url: 'http://${STACK_HOST:-localhost}:58474' }
```

`http-stub` and `toxiproxy` are refused on an environment that is not `disposable`: a stub replaces a real provider and
a fault breaks a shared one. Write container hosts as `${STACK_HOST:-localhost}`; under Docker-in-Docker in CI the
ports answer on another host (`docker`), and the compose file binds to `${STACK_BIND:-127.0.0.1}` and advertises
Kafka's external listener at the same `STACK_HOST`.

## Using them in tests

Build the service's `test` from `createDepsTest<paths>()` (`framework/deps/fixtures.ts`) instead of `createTest`:

| Fixture        | Scope  | What it does                                                                                                                                                                                                                                      |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stubs.<name>` | test   | `stub({ operation, match, status, body })` refuses an answer the provider's contract does not document; `calls()` returns what the service sent, each request checked against the provider's request schema. Stubs are removed when the test ends |
| `events`       | worker | `expect(topic, predicate)` waits for the event and checks it against the topic's schema; `expectNone` and `published` first wait until the consumer has read everything published so far                                                          |
| `cache`        | worker | `get(key)` with the value and TTL, `exists`, `ttl`, `keys(pattern)` (SCAN)                                                                                                                                                                        |
| `faults`       | worker | `latency(dep, ms)`, `down(dep)` through toxiproxy, undone after every test; plus `pause`/`unpause` of a compose service. Fault tests live in `tests/faults/`, which the serial `faults` project runs alone                                        |

## Isolation under parallel workers

Designed, not hoped for, and exercised on every run (`example-orders` runs its suite with `mode: 'parallel'`; it
passed 6 repeats x 25 tests on 4 workers):

- **Stubs** must match on a value of the request (`match: { '$.customer': id }`); an empty match is refused, because a
  catch-all stub would answer other tests' calls. The value is one the test made run-unique (`unique()`).
- **`calls()`** fetches the operation's requests and evaluates `match` itself. WireMock's journal search caches parsed
  bodies by Java `String.hashCode`, so bodies whose hashes collide (run-unique ids such as `cus.r.3n` and `cus.r.50`
  do) return each other's requests, or none; this was found by the parallel run, and is pinned by a self-test. Live
  stub matching is not affected. Match paths are therefore limited to simple JSONPaths (`$.a.b[0]`).
- **Events** are found by a value the test made unique (its customer id); each worker reads every topic from the
  earliest offset in a consumer group of its own.
- **Rows and cache keys** carry the same unique values.

## Provider coverage

`tsx framework/deps/coverage.ts --service <svc> [--strict]` lists every documented answer of every stubbed provider
and whether a test stubbed it in the last run (`reports/coverage/providers.json`). A provider answer nobody simulates
is a path of the service nobody verified. It is not yet a gate step.

## Library choices

- **Kafka: `@platformatic/kafka`.** Pure TypeScript with no native addon (installs anywhere, including slim CI
  images), actively released (2.16.0, November 2026), and tested against Kafka 3.5 to 4.2. `kafkajs` has had no
  release since February 2023. `@confluentinc/kafka-javascript` is maintained and fast but wraps native librdkafka:
  a platform-specific binary in every test runner image, for throughput a test consumer does not need.
- **Redis: `redis` (node-redis 6).** The client Redis itself maintains and recommends; `ioredis` is maintained too, but
  nothing here needs its cluster ergonomics.
- **HTTP stubs: WireMock 3 via its admin API, with plain `fetch`.** Language-neutral, the de facto standard, and its
  stubs are data a reviewer can read. No client library: the framework uses five admin endpoints.
- **Faults: toxiproxy via its HTTP API.** Latency and outages at the TCP level, which a stub's own delay cannot model
  (a refused connection, a slow network for every caller).
- **Event schemas: Ajv (JSON Schema 2020-12)**, the validator the framework already uses for responses.

## Not done yet

Sibling services as stubs generated from their OpenAPI (today a stub is declared per test), message-driven inputs
(the service consuming a topic), Redis/Kafka faults through toxiproxy, and provider coverage as a gate step.

# Sealed environments

A verification run should neither need nor touch a shared environment. When a service declares an `environment` in
its `service.yaml`, `vgate up` starts a copy of the system for this run alone and `vgate down` destroys it: the app,
built from the code under test, and its dependencies, on a network with no route to the internet, to the host's
networks or to another run. The verdict records that it was sealed and lists every outbound attempt; one made by the
app fails the gate.

Services without an `environment` keep their `stack.sh` (`kind: script` in the verdict, not sealed).

## Declaring it

```yaml
environment:
  sealed: true # the default; false only for an app run as a host command (then recorded as not sealed)
  app:
    build: { context: services/orders, dockerfile: Dockerfile, target: runtime } # or image: <ref>, or command: <host command>
    port: 8080 # the port the app listens on inside its container
    health: /health
    env:
      DATABASE_URL: '{db.url}' # placeholders: {<dependency>.<export>}, resolved per run
      PAYMENTS_URL: '{payments.url}'
      API_KEY: '${ORDERS_API_KEY:-test-key}' # environment variables work as everywhere in service.yaml
  dependencies:
    db: { kind: postgres, options: { database: orders }, seed: seed.sql }
    cache: { kind: redis }
    events: { kind: kafka, topics: { orders.created: { partitions: 3 } } }
    payments: { kind: wiremock, faults: true }

environments:
  local:
    disposable: true
    baseUrl: '{app.url}' # the tests' side of the same placeholders
    db: { url: '{db.url}' }
    dependencies:
      payments:
        {
          kind: http-stub,
          adminUrl: '{payments.adminUrl}',
          contract: deps/payments.openapi.yaml,
          proxy: '{payments.proxy}',
        }
      events:
        {
          kind: kafka,
          brokers: ['{events.brokers}'],
          topics: { orders.created: { schema: deps/events/orders.created.schema.json } },
        }
      cache: { kind: redis, url: '{cache.url}' }
      proxies: { kind: toxiproxy, url: '{edge.api}' }
```

- `build.context` and `build.dockerfile` resolve against the project root (where `vgate.yaml` is). A kind's file
  options resolve against the service directory: postgres `seed`, mysql and mongodb `init`, keycloak `realmFile`; a
  file option the kind does not take is refused. Build the app the way production does (its own Dockerfile), so the run tests what ships.
- Placeholders are `{name.key}` with a dot. Inside `environment.app.env` they resolve to what the app sees (a
  dependency by its name, `db:5432`); in `environments.<env>` to what the tests on the host see (`127.0.0.1:<port>`).
  `{app.url}`, `{app.port}` and `{edge.api}` exist on the tests' side. Until `vgate up` has run, they stay as written.
- Host ports are never written down: each run chooses free ones, so two runs (two pull requests on one runner, a
  laptop and its CI) never collide. A dependency with `ports:` is refused.
- `faults: true` routes the app's calls to that dependency through the edge, on a proxy named after it; the tests slow
  or cut it with the `faults` fixture (`{edge.api}`, `proxy: '{payments.proxy}'`). Kafka also advertises the proxy, so
  a client that reconnects goes through it again.
- `migrate: { dir, command, down?, image? }` on a database runs `command` in a tool container (the database's own image
  by default, with the migrations directory at `/migrations` and `DATABASE_URL` set) after the database is ready and
  before its `seed`, so the seed fills migrated tables (docs/deploy-safety.md).

## How it is built

```
network sealed (internal: Docker gives it no gateway)
  app ──► dependencies, by name                every container resolves names through `dns`
  app ──► edge ──► a dependency with faults
  dns: answers nothing outside the environment, logs every name asked for (the outbound watch)
network edge (an ordinary bridge)
  edge: Toxiproxy, the only container with published ports (127.0.0.1, chosen per run); its API listens on the
        edge network only, so the app cannot create a proxy to the outside through it
tests on the host ──► 127.0.0.1:<port> ──► edge ──► app or dependency
```

`vgate up` builds the app first, then starts the dependencies, waits until each is healthy and runs its setup (topics,
migrations, seed data), then starts the app and waits for its health path. The built image is named
`vgate/<service>-app:<hash of the build context>`: an unchanged app is built once and reused by every later run,
and a new build removes the superseded one, so runs do not fill the disk. If anything fails, everything started is removed and
the error carries the containers' last log lines. The run's files are in `<reports>/env/<service>/` and its state in
`<reports>/env/<service>.json` (what config reads to resolve the tests' placeholders). `vgate down` removes the
containers, the networks and the volumes: an environment is disposable. Every container and network carries the labels
`dev.vgate.reports` (the project) and `dev.vgate.service`, so `down` also finds a run whose state file is gone (a
crash, a deleted reports dir), and `up` always starts from nothing: an environment is never adopted.
`vgate reset --yes` is a fresh environment.

A service without a declared environment is started by its `stack.sh`. There, `app_up` (framework/stack/lib.sh)
starts the app unless this project's own app, from the build checked out now, already runs; anything else answering on
the port (another checkout's app, a hand-started server) is refused with exit 3 and named, never tested in this code's
place.

## The outbound watch

Every container's resolver is the environment's `dns`, which knows no outside name: a lookup of `example.com` fails and
is logged with the address that asked. Containers get no search domain, so the log holds exactly the names asked for
(`s3.amazonaws.com` is outbound even next to a dependency named `s3`). `vgate gate` reads that log into `sandbox.outbound` of `verdict.json`:

```json
"sandbox": { "kind": "declared", "sealed": true, "project": "vgate-orders-3f9a1c",
             "outbound": [{ "from": "app", "host": "example.com", "port": null, "blocked": true }] }
```

An attempt by the app fails the verdict (the app depends on something its environment does not provide: a hard-coded
third party, a telemetry endpoint, a shared database). Attempts by dependencies (an image phoning home) are listed but
do not fail it. Limits: DNS shows names, not ports; a connection to a literal IP address is blocked by the network but
not listed.

## The catalog

`kind:` names an entry of the catalog (`framework/env/catalog/`): `postgres`, `redis`, `kafka`, `wiremock`,
`toxiproxy`, and the further kinds listed in `catalog/extra.ts` (docs/catalog.md). A kind fixes a pinned image
(`image:` overrides it), its ports, its configuration from `options`, its health check, its setup and the values it
exports for placeholders. Add a kind by adding one file there.

## Requirements and limits

- Docker with Compose v2 where the gate runs: a laptop, or a CI runner with Docker (GitHub's hosted runners have it).
- An app run as a host `command` cannot be sealed: its own calls are not watched. Its port is fixed, so `up` refuses
  when something already listens there.
- Kafka's tests reach the broker through the edge on the external listener, which advertises the run's host port.
- The first `up` pulls images and builds the app; later runs reuse Docker's caches.

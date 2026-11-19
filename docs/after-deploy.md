# After the deploy: smoke, canary, rollback

The pull request gate proves a change against its spec in a sealed copy of the system. That copy is not production:
real traffic, real data, real configuration and real dependencies only meet the change once it is deployed. vgate's
part after the merge is to say, within minutes, whether the deployed version is healthy, and to start the rollback when
it is not.

```
merge -> deploy to staging -> vgate smoke (staging) -> deploy to production (canary) -> vgate canary (+ smoke)
                                   | fail                                                   | breach
                                   v                                                        v
                              rollback / stop                                          rollback (once)
```

## Smoke: a deployed environment answers as its spec says

```bash
vgate smoke --service api --env staging
```

`smoke` runs the service's **smoke subset** of its own tests against an environment of service.yaml that already
exists: nothing is started, seeded or reset.

- **The subset**: `smoke.scenarios` (scenario ids) or `smoke.grep` (a Playwright `--grep`) in service.yaml. Without
  either, the plan's scenarios of read-only operations (GET/HEAD, or what `schemathesis.readOnlyPaths` /
  `readOnlyMethods` mark as writing nothing).
- **Zero tests run is a failure.** A smoke run that verified nothing never reads as a pass.
- **Writes are refused before they are sent.** In an environment with `disposable: false`, the client refuses every
  request that is not read-only, before it leaves the machine: the test fails with
  `write refused in environment <name>: POST /notes ...`. This holds for calls, streams, webhooks, session logins and
  Playwright's own `request` fixture. A write is judged by the path that goes out (a `..` segment past a read-only or
  allowed operation is refused) and by any method-override header (`X-HTTP-Method-Override: DELETE` on a GET is a
  DELETE). A test that creates its own data first therefore cannot be a smoke test: list the ones that only read in
  `smoke.scenarios`.
- **The other doors.** The `db` fixture opens read-only sessions (`default_transaction_read_only`), and `kc` provisions
  no Keycloak users. The dependency helpers refuse every operation that changes a dependency, before it is sent:
  - S3 `put` and `create-bucket`;
  - SQS `send`, `create` and `receive` (receiving deletes the message);
  - RabbitMQ `publish`, `take` (consumes a message) and `spy` (declares a temporary queue);
  - mail `delete` (clearing the inbox);
  - MySQL `write` (any statement that is not a plain read). The session itself is also `READ ONLY`, so the server refuses
    what the check would miss, and runs one statement per query (`multipleStatements` in the URL is dropped).

  Kafka, Redis and MongoDB helpers only read. Stubs and faults are refused outright on such an environment.

- **A test's own connection.** A test's own `fetch` or node `http`/`https` request (`request`, `get`, a library on top
  of them, Playwright's `request`, every redirect they follow) is judged as it goes out: by its path, like the client,
  when it goes to the environment's base URL; refused when it writes to any other host, which may be the environment
  under another name (an IP address, another port). Reads go anywhere. The framework's own calls are judged by their
  own rule, and the lint step refuses test code that imports the framework's door past the guard (`frameworkFetch`,
  `asFramework`, `unguarded`). http2, a raw socket, a child process (`curl`) or a driver the test opens itself stays
  outside the guard. A database user with read rights only is the stronger guard.
- **Load.** `vgate perf` (k6) refuses an environment that is not disposable unless it sets `allowLoad: true`.
- **`allowWrites`** lists the few writes an environment accepts from the tests, typically a synthetic account's login:
  `METHOD /template` for an API call, `dependency:operation` for a helper (`events:publish`, `files:put`; exact pairs,
  no wildcards):

  ```yaml
  smoke:
    scenarios: [HLT-200, LST-200, ME-200]

  environments:
    production:
      disposable: false
      baseUrl: https://api.example.com
      healthPath: /health
      auth:
        {
          session: { login: { path: /auth/login, body: { email: '{username}', password: '{password}' } }, cookie: sid },
        }
      users:
        synthetic: { username: synthetic@example.com, password: '${SYNTHETIC_PASSWORD}' }
      allowWrites: ['POST /auth/login']
  ```

  A **synthetic account** is a real account of the environment that exists only for verification: no customer's data,
  limited rights, its activity easy to filter out of analytics and billing. It lets a smoke run read what a signed-in
  user reads without touching anyone's data.

- Fault injection, fuzzing (`vgate fuzz`, every operation), `vgate reset` and `vgate mutate` refuse an environment that
  is not disposable.

The result is `reports/smoke.json` (`vgate.verdict/1` with `kind: deployed`, `complete: false`): `vgate decide` never
takes it for a pull request's gate verdict.

## Canary: a new version stays within its limits

```bash
vgate canary --service api --env production --for 10m --every 30s --on-fail 'kubectl argo rollouts abort api'
```

`canary` polls the metrics of the version taking traffic for a window and compares them with limits:

```yaml
environments:
  production:
    canary:
      source: prometheus # or http: url answers JSON, queries are dotted paths into it
      url: https://prometheus.internal:9090
      headers: { Authorization: 'Bearer ${PROM_TOKEN}' }
      queries:
        errorRate: 'sum(rate(http_requests_total{app="api",track="canary",code=~"5.."}[2m])) / sum(rate(http_requests_total{app="api",track="canary"}[2m]))'
        p95Ms: '1000 * histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{app="api",track="canary"}[2m])))'
      limits: { errorRate: 0.01, p95Ms: 500 } # the highest value allowed
      baseline: # optional: the version being replaced, same metrics
        errorRate: 'sum(rate(http_requests_total{app="api",track="stable",code=~"5.."}[2m])) / sum(rate(http_requests_total{app="api",track="stable"}[2m]))'
      maxRatio: 2 # the canary may be at most twice as bad as the baseline
```

| Exit | Meaning                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Healthy for the whole window                                                                                                                                                          |
| 1    | Breach: a metric above its limit, above `maxRatio` x its baseline, or the smoke failed (with `--smoke`). The summary names the metric, its value and its limit. `--on-fail` runs once |
| 3    | A metric could not be read in some round (unreachable, an error, no series, NaN), and nothing breached: unknown, **never a pass**, and no rollback                                    |

Each metric is read and judged on its own, every round: one that cannot be read neither hides another's breach nor
ends the watch. A query that returns several series (per pod, per route) is judged by its worst; `+Inf` (a latency
beyond the histogram's top bucket) is above any limit.

`--smoke` also runs the smoke subset each round.

## Wiring it in

**GitHub Actions** (`vgate init --ci github` installs `.github/workflows/vgate-after-deploy.yml`): on a successful
`deployment_status` to an environment the repository variable `VGATE_DEPLOY_ENVIRONMENTS` lists (default:
`staging production`) it smokes the environment, then watches the canary of every service that configures one; on a
failed smoke it runs the repository variable `VGATE_ROLLBACK_COMMAND` once (a breached canary runs it itself). Other
environments are never verified: a pull request's preview deployment, from a fork too, names a commit nobody
reviewed, and the workflow runs that commit's tests with the environment's credentials. The GitHub environment and the service.yaml
environment share a name; the environment's credentials come from its secret `VGATE_ENV` (`KEY=value` lines, the
`${VAR}`s of service.yaml). With the variable `VGATE_PROBE_ENVIRONMENT` set, the same workflow also probes that
environment every hour (smoke only, never a rollback).

**Argo Rollouts**: an `AnalysisTemplate` whose metric is a Job running vgate; the rollout aborts when it fails.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata: { name: vgate-canary }
spec:
  metrics:
    - name: vgate
      provider:
        job:
          spec:
            backoffLimit: 0
            template:
              spec:
                restartPolicy: Never
                containers:
                  - name: vgate
                    image: your-registry/your-app-vgate:<tag> # vgate's ci/Dockerfile plus your regression/ folder (docs/ci.md)
                    command: [vgate, canary, --service, api, --env, production, --for, 5m, --smoke]
```

**Flagger**: a `webhooks` entry of type `rollout` pointing at a small service that runs `vgate canary` (or `smoke`)
and answers 200 on exit 0, anything else otherwise; Flagger halts and rolls back on failures.

**Any pipeline**: run `vgate smoke` after the deploy step and `vgate canary --on-fail '<your rollback>'` after the
traffic shift; exit codes are the contract.

## What it does not do

- It does not deploy, shift traffic or roll back by itself: the deploy tool does, and vgate tells it when.
- A smoke run checks what the subset covers, against the environment's real data; it cannot create the states a
  sealed run can (that is the pull request gate's job).
- Metrics are only as good as their queries: a canary that sees no traffic has no series and answers unknown (3).

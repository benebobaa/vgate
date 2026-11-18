# Dependency catalog

The kinds a sealed environment can start besides the core ones (`postgres`, `redis`, `kafka`, `wiremock`,
`toxiproxy`), each with a pinned image, a health check, the values it exports and a helper for the tests. A
dependency is declared under `environment.dependencies` in service.yaml; its exports fill placeholders such as
`{mail.apiUrl}`, in the app's `env` (the address inside the environment) and in the `environments` block the tests
read (the address on the host).

| Kind         | Image                              | For                                  | Test helper                    |
| ------------ | ---------------------------------- | ------------------------------------ | ------------------------------ |
| `mysql`      | `mysql:8.4.13`                     | a MySQL database                     | `mysql` (framework/deps/mysql) |
| `mongodb`    | `mongo:8.0.38`                     | a MongoDB database                   | `mongo` (framework/deps/mongo) |
| `rabbitmq`   | `rabbitmq:4.4.1-management-alpine` | a message broker (AMQP 0-9-1)        | `broker` (framework/deps/amqp) |
| `s3`         | `chrislusf/seaweedfs:4.54`         | an S3-compatible object store        | `objects` (framework/deps/s3)  |
| `mailpit`    | `axllent/mailpit:v1.34.0`          | an SMTP server that keeps every mail | `inbox` (framework/deps/email) |
| `localstack` | `localstack/localstack:2026.10.8`  | AWS APIs: S3, SQS, SNS               | `objects`, `queues` (deps/sqs) |
| `keycloak`   | `quay.io/keycloak/keycloak:26.4.7` | an OpenID Connect identity provider  | the `password` auth kind       |

`image:` on a dependency replaces the default (for example with a mirror); the kind's options and exports stay the
same.

## Wiring a service

```yaml
# service.yaml
environment:
  app:
    build: { context: services/shop }
    port: 8080
    env:
      SMTP_URL: '{mail.smtpUrl}'
      DB_URL: '{orders.url}'
      S3_ENDPOINT: '{files.url}'
      AMQP_URL: '{broker.url}'
  dependencies:
    mail: { kind: mailpit }
    orders: { kind: mysql, database: shop, init: seed/orders.sql }
    files: { kind: s3, buckets: [invoices] }
    broker: { kind: rabbitmq }

environments:
  local:
    disposable: true
    dependencies: # how the tests reach them, from the same exports
      mail: { kind: mailpit, apiUrl: '{mail.apiUrl}' }
      orders: { kind: mysql, url: '{orders.url}' }
      files: { kind: s3, endpoint: '{files.url}' }
      broker: { kind: rabbitmq, url: '{broker.url}' }
```

Tests take the helpers from `createCatalogTest`:

```ts
import { createCatalogTest } from '@vgate/framework/deps/catalog-fixtures.ts';
export const test = createCatalogTest<paths>();

test('[REG-201] registering sends the verification mail', async ({ api, inbox }) => {
  await api.as('anonymous').post('/users', { body: { email: 'ada@shop.test' } });
  const mail = await inbox.expectMessage({ to: 'ada@shop.test', subject: 'Verify' });
  expect(mail.links[0]).toContain('/verify?token=');
});
```

## Kinds

### mysql

Options: `database`, `user`, `password` (default `app` each; `root` is refused as the application user),
`rootPassword` (default `root`), `init: file.sql` (run by the image on first start, before it accepts TCP, so a
healthy server already holds the seed). Exports: `url` (`mysql://user:password@host:port/database`, credentials
URL-encoded), `host`, `port`, `user`, `password`, `database`. Helper `MySqlDb`: `rows(sql, params)`, `one(...)` (throws
unless exactly one row), `count(...)`; parameterised queries only; dates come back as the stored text.

### mongodb

Options: `database` (default `app`), `user`, `password` (default `app`; the server's root user), `init: file.js` (a
mongosh script, run on first start). Exports: `url` (`mongodb://user:password@host:port/database?authSource=admin`),
`host`, `port`, `user`, `password`, `database`. Helper `MongoDocs`: `find`, `findOne`, `count`,
`expectDocument(collection, filter, { timeoutMs })` for writes made after the answer.

### rabbitmq

Options: `user`, `password` (default `app`), `vhost` (default `/`). Exports: `url` (`amqp://...`), `managementUrl`,
`host`, `port`, `user`, `password`, `vhost`. Helper `AmqpBroker`:

- `spy(exchange, routingKey)` binds a private queue to the exchange **before** the test acts, so the service's own
  consumers still receive every message and the test sees a copy; then `spy.expect(match)` and `spy.expectNone()`.
- `publish(exchange, routingKey, body)` feeds the service.
- `take(queue)` reads a queue directly and consumes the message: only for a queue nothing else drains.

The health check runs only once the broker has written its Erlang cookie: run earlier, the CLI would create the cookie
as root and the broker could never start.

### s3

An S3-compatible store: SeaweedFS's S3 gateway (Apache-2.0). MinIO no longer publishes container images, and a catalog
kind must pin an image that exists; any S3-compatible image can replace it through `image:` if it takes the same
command line. Options: `buckets: [name...]` (created once healthy), `region` (default `us-east-1`). Exports: `url` and
`endpoint`, `host`, `port`, `region`, `accessKey`, `secretKey` (the gateway runs without an identity file and accepts
any signed request, so the app signs exactly as against AWS). Helper `S3Store` (path-style): `createBucket`, `put`,
`get`, `exists`, `list(bucket, prefix)`, `expectObject(bucket, key, { timeoutMs })`.

### mailpit

No options. Exports: `smtpUrl`, `smtpHost`, `smtpPort` (for the app), `apiUrl` and `url` (for the tests), `host`. It
accepts any SMTP login, so an app configured with credentials works unchanged, and it delivers nothing anywhere.
Helper `Inbox`: `expectMessage({ to, subject }, { timeoutMs })` returns the message with its `text`, `html` and
`links`; `expectNone(...)` for "a rejected request sends nothing"; `messages()`, `read(id)`, `clear()`.

### localstack

Options: `services` (default `s3,sqs,sns`), `region` (default `us-east-1`), `buckets`, `queues`, `topics` (created once
healthy), `authToken` (written as `${VAR}`, for LocalStack images that require one). Exports: `url` and `endpoint`,
`host`, `port`, `region`, `accessKey`/`secretKey` (`test`). Usage reporting and update downloads are switched off, so
it stays inside the environment. Helpers: `S3Store` for its S3, `SqsQueues` for SQS: `send`, `receive`,
`expectMessage(queue, match, { timeoutMs })` (it consumes what it reads: use a queue only the test reads). Queue URLs
the server returns are moved onto the endpoint the tests reach, because servers write their own idea of their address
into them.

### keycloak

Development mode. Options: `adminUser`, `adminPassword` (default `admin`), `realmFile: realm.json` (a realm export with
its clients and users, imported on start), `realm` (its name). Exports: `url`, `host`, `port`, `realm`, `tokenUrl`,
`issuer`, `adminUser`, `adminPassword`. The issuer is fixed to the address the app uses inside the environment, so a
token the tests fetch from the host carries the `iss` the app expects. Tests log in through the existing `password`
users of the environment (docs/auth.md) with `keycloak.url: '{idp.url}'`.

## Client libraries

| Need              | Library              | Why                                                                                     |
| ----------------- | -------------------- | --------------------------------------------------------------------------------------- |
| MySQL             | `mysql2`             | The maintained MySQL client for Node, pure JavaScript, promise API                      |
| MongoDB           | `mongodb`            | The official driver; no native build step                                               |
| RabbitMQ          | `amqplib`            | The standard AMQP 0-9-1 client, pure JavaScript, no dependencies, ships its types       |
| S3, SQS           | none (`aws-sign.ts`) | Signature V4 in node:crypto instead of the AWS SDK's tens of megabytes in every project |
| Mailpit, Keycloak | none                 | Plain HTTP APIs through `fetch`                                                         |

The SigV4 signer is held to AWS's own published example signature in the framework's self-tests.

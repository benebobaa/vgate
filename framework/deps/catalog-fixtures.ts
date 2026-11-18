/**
 * Playwright fixtures for the catalog's dependencies, on top of createDepsTest (stubs, events, cache, faults). A
 * service whose environment has a mail server, an object store, AWS, MySQL, MongoDB or RabbitMQ builds its `test`
 * from `createCatalogTest<paths>()`:
 *
 *   inbox     the mailpit dependency's messages              (framework/deps/email.ts)
 *   objects   the s3 (or aws) dependency's buckets          (framework/deps/s3.ts)
 *   queues    the aws dependency's SQS queues               (framework/deps/sqs.ts)
 *   mysql     the mysql dependency                          (framework/deps/mysql.ts)
 *   mongo     the mongodb dependency                        (framework/deps/mongo.ts)
 *   broker    the rabbitmq dependency                       (framework/deps/amqp.ts)
 *
 * Each is created on first use, once per worker, and fails with what the environment lacks when it has no such
 * dependency (or several).
 */
import { AmqpBroker } from './amqp.ts';
import { soleOf, type CatalogDependency } from './catalog-config.ts';
import { Inbox } from './email.ts';
import { createDepsTest } from './fixtures.ts';
import { MongoDocs } from './mongo.ts';
import { MySqlDb } from './mysql.ts';
import { S3Store } from './s3.ts';
import { SqsQueues } from './sqs.ts';

export interface CatalogWorkerFixtures {
  inbox: Inbox;
  objects: S3Store;
  queues: SqsQueues;
  mysql: MySqlDb;
  mongo: MongoDocs;
  broker: AmqpBroker;
}

// The environment's dependencies, with the catalog's kinds among them (parsed by deps/config.ts).
type Deps = Record<string, { kind: string } | CatalogDependency>;

export function createCatalogTest<P>() {
  return createDepsTest<P>().extend<object, CatalogWorkerFixtures>({
    inbox: [
      async ({ svc }, use) => {
        const dep = soleOf((svc.env.dependencies ?? {}) as Deps, ['mailpit'], 'inbox', svc.env.name);
        await use(new Inbox(dep.apiUrl));
      },
      { scope: 'worker' },
    ],
    objects: [
      async ({ svc }, use) => {
        const dep = soleOf((svc.env.dependencies ?? {}) as Deps, ['s3', 'aws'], 'objects', svc.env.name);
        await use(new S3Store(dep));
      },
      { scope: 'worker' },
    ],
    queues: [
      async ({ svc }, use) => {
        const dep = soleOf((svc.env.dependencies ?? {}) as Deps, ['aws'], 'queues', svc.env.name);
        await use(new SqsQueues(dep));
      },
      { scope: 'worker' },
    ],
    mysql: [
      async ({ svc }, use) => {
        const dep = soleOf((svc.env.dependencies ?? {}) as Deps, ['mysql'], 'mysql', svc.env.name);
        const db = MySqlDb.connect(dep.url);
        await use(db);
        await db.close();
      },
      { scope: 'worker' },
    ],
    mongo: [
      async ({ svc }, use) => {
        const dep = soleOf((svc.env.dependencies ?? {}) as Deps, ['mongodb'], 'mongo', svc.env.name);
        const docs = await MongoDocs.connect(dep.url);
        await use(docs);
        await docs.close();
      },
      { scope: 'worker' },
    ],
    broker: [
      async ({ svc }, use) => {
        const dep = soleOf((svc.env.dependencies ?? {}) as Deps, ['rabbitmq'], 'broker', svc.env.name);
        const broker = await AmqpBroker.connect(dep.url);
        await use(broker);
        await broker.close();
      },
      { scope: 'worker' },
    ],
  });
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catalogKinds, kindOf } from '../env/catalog/index.ts';
import type { Endpoint, KindContext } from '../env/catalog/types.ts';
import { amzDate, awsEncode, canonicalRequest, signRequest, xmlValues } from './aws-sign.ts';
import { parseCatalogDependency, soleOf } from './catalog-config.ts';
import { linksIn } from './email.ts';
import { SqsQueues } from './sqs.ts';

const internal = (ports: Record<string, number>): Endpoint => ({ host: 'dep', ports });
const external = (ports: Record<string, number>): Endpoint => ({
  host: '127.0.0.1',
  ports: Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, port + 50000])),
});

function context(
  kind: string,
  options: Record<string, unknown> = {},
): { ctx: KindContext; ports: Record<string, number> } {
  const ports = kindOf(kind)?.ports ?? {};
  return { ctx: { name: 'dep', options, internal: internal(ports), external: external(ports) }, ports };
}

describe('catalog kinds', () => {
  it('registers every extra kind next to the core ones, each with a pinned image', () => {
    for (const kind of ['mysql', 'mongodb', 'rabbitmq', 's3', 'mailpit', 'localstack', 'keycloak']) {
      const found = kindOf(kind);
      assert.ok(found, `${kind} is registered (have ${catalogKinds().join(', ')})`);
      assert.match(found.defaultImage, /:[^:]+$/, `${kind} pins a tag`);
      assert.doesNotMatch(found.defaultImage, /:latest$/, `${kind} is not latest`);
    }
  });

  it('mysql: credentials from options, URL-encoded, and a root application user refused', () => {
    const { ctx } = context('mysql', { database: 'orders', user: 'shop', password: 'p@ss/word' });
    const kind = kindOf('mysql')!;
    assert.deepEqual(kind.environment!(ctx), {
      MYSQL_DATABASE: 'orders',
      MYSQL_USER: 'shop',
      MYSQL_PASSWORD: 'p@ss/word',
      MYSQL_ROOT_PASSWORD: 'root',
    });
    assert.equal(kind.exports(ctx.external, ctx).url, 'mysql://shop:p%40ss%2Fword@127.0.0.1:53306/orders');
    assert.equal(kind.exports(ctx.internal, ctx).url, 'mysql://shop:p%40ss%2Fword@dep:3306/orders');
    assert.throws(() => kind.environment!(context('mysql', { user: 'root' }).ctx), /administrator/);
    assert.deepEqual(kind.mounts!(context('mysql', { init: '/abs/seed.sql' }).ctx), {
      '/abs/seed.sql': '/docker-entrypoint-initdb.d/seed.sql',
    });
  });

  it('mongodb: authSource=admin and the database in the path', () => {
    const { ctx } = context('mongodb', { database: 'catalog' });
    assert.equal(
      kindOf('mongodb')!.exports(ctx.external, ctx).url,
      'mongodb://app:app@127.0.0.1:77017/catalog?authSource=admin',
    );
  });

  it('rabbitmq: the default vhost leaves the URL bare, another is encoded', () => {
    const kind = kindOf('rabbitmq')!;
    const plain = context('rabbitmq').ctx;
    assert.equal(kind.exports(plain.internal, plain).url, 'amqp://app:app@dep:5672');
    const vhost = context('rabbitmq', { vhost: 'shop/eu' }).ctx;
    assert.equal(kind.exports(vhost.internal, vhost).url, 'amqp://app:app@dep:5672/shop%2Feu');
    assert.equal(kind.exports(vhost.external, vhost).managementUrl, 'http://127.0.0.1:65672');
  });

  it('s3 and localstack: bucket, queue and topic names checked; setup creates each', () => {
    const s3 = kindOf('s3')!;
    assert.equal(s3.setup!(context('s3', { buckets: ['invoices', 'exports.v2'] }).ctx).length, 2);
    assert.throws(() => s3.setup!(context('s3', { buckets: ['Bad_Bucket'] }).ctx), /bucket names/);
    assert.throws(() => s3.setup!(context('s3', { buckets: 'one' }).ctx), /bucket names/);
    const ls = kindOf('localstack')!;
    const setup = ls.setup!(context('localstack', { buckets: ['b1'], queues: ['q1'], topics: ['t1'] }).ctx);
    assert.deepEqual(
      setup.map((cmd) => cmd.slice(1, 3)),
      [
        ['s3api', 'create-bucket'],
        ['sqs', 'create-queue'],
        ['sns', 'create-topic'],
      ],
    );
    assert.throws(() => ls.setup!(context('localstack', { queues: ['bad name'] }).ctx), /queues/);
    const env = ls.environment!(context('localstack', { authToken: 'tok' }).ctx);
    assert.equal(env.LOCALSTACK_AUTH_TOKEN, 'tok');
    assert.equal(ls.environment!(context('localstack').ctx).LOCALSTACK_AUTH_TOKEN, undefined);
  });

  it('keycloak: the issuer is the app-side address from either side, and a seed turns on the realm import', () => {
    const kind = kindOf('keycloak')!;
    const { ctx } = context('keycloak', { realm: 'shop', realmFile: '/abs/realm.json' });
    const outside = kind.exports(ctx.external, ctx);
    assert.equal(outside.issuer, 'http://dep:8080/realms/shop');
    assert.equal(kind.exports(ctx.internal, ctx).issuer, outside.issuer);
    assert.equal(outside.tokenUrl, 'http://127.0.0.1:58080/realms/shop/protocol/openid-connect/token');
    assert.deepEqual(kind.command!(ctx), ['start-dev', '--import-realm']);
    assert.deepEqual(kind.command!(context('keycloak').ctx), ['start-dev']);
    assert.equal(kind.environment!(ctx).KC_HOSTNAME, 'http://dep:8080');
  });

  it('mailpit: SMTP for the app, the API for the tests', () => {
    const { ctx } = context('mailpit');
    const kind = kindOf('mailpit')!;
    assert.equal(kind.exports(ctx.internal, ctx).smtpUrl, 'smtp://dep:1025');
    assert.equal(kind.exports(ctx.external, ctx).apiUrl, 'http://127.0.0.1:58025');
  });
});

describe('SigV4', () => {
  // AWS's published example ("Create a canonical request" / "Calculate the signature", IAM ListUsers).
  it("matches AWS's documented example signature", () => {
    const headers = signRequest(
      {
        method: 'GET',
        url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        now: new Date('2015-08-30T12:36:00Z'),
      },
      {
        accessKey: 'AKIDEXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
        service: 'iam',
      },
    );
    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
    assert.equal(headers['x-amz-date'], '20150830T123600Z');
    assert.equal(headers.host, undefined, 'host is left to fetch');
  });

  it('encodes per RFC 3986 and sorts the query; S3 signs its payload hash', () => {
    assert.equal(awsEncode("a b!'()*~"), 'a%20b%21%27%28%29%2A~');
    assert.equal(amzDate(new Date('2024-01-02T03:04:05.678Z')), '20240102T030405Z');
    const { text } = canonicalRequest(
      { method: 'get', url: 'http://s3.local/bucket/a%20b/c?prefix=x y&list-type=2' },
      { host: 's3.local' },
    );
    assert.equal(text.split('\n').slice(0, 3).join('|'), 'GET|/bucket/a%20b/c|list-type=2&prefix=x%20y');
    const s3 = signRequest(
      { method: 'PUT', url: 'http://s3.local/b/k', body: 'hi', contentSha256Header: true },
      { accessKey: 'a', secretKey: 's', region: 'us-east-1', service: 's3' },
    );
    assert.equal(s3['x-amz-content-sha256'], '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4');
    assert.match(s3.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);
  });

  it('reads XML values and decodes entities', () => {
    assert.deepEqual(xmlValues('<a><Key>x&amp;y</Key><Key>&lt;z&gt;</Key></a>', 'Key'), ['x&y', '<z>']);
  });
});

describe('catalog test config', () => {
  it('parses each test-side kind and checks URL schemes', () => {
    assert.deepEqual(parseCatalogDependency('mailpit', { apiUrl: 'http://127.0.0.1:8025/' }, 'm'), {
      kind: 'mailpit',
      apiUrl: 'http://127.0.0.1:8025',
    });
    assert.equal(parseCatalogDependency('aws', { endpoint: 'http://x:4566' }, 'a')?.kind, 'aws');
    assert.equal(
      (parseCatalogDependency('s3', { endpoint: 'http://x' }, 's') as { region: string }).region,
      'us-east-1',
    );
    assert.throws(() => parseCatalogDependency('mysql', { url: 'postgres://x/db' }, 'db'), /mysql URL/);
    assert.throws(() => parseCatalogDependency('rabbitmq', {}, 'b'), /b\.url is required/);
    assert.throws(() => parseCatalogDependency('mailpit', { apiUrl: 'not a url' }, 'm'), /must be a URL/);
    assert.equal(parseCatalogDependency('kafka', { brokers: [] }, 'k'), undefined);
  });

  it('a fixture names a missing or ambiguous dependency', () => {
    const deps = { a: { kind: 'mysql', url: 'mysql://x/y' }, b: { kind: 'mysql', url: 'mysql://x/z' } };
    assert.throws(() => soleOf(deps, ['mysql'], 'mysql', 'local'), /exactly one mysql .*found 2: a, b/);
    assert.throws(() => soleOf({}, ['mailpit'], 'inbox', 'local'), /found 0\)/);
    assert.equal(soleOf({ a: deps.a }, ['mysql'], 'mysql', 'local').url, 'mysql://x/y');
  });
});

describe('mail links', () => {
  it('finds http links in text and HTML once each, decoding &amp; and trimming punctuation', () => {
    assert.deepEqual(
      linksIn(
        'Verify: https://app.test/verify?t=1&u=2.',
        '<a href="https://app.test/verify?t=1&amp;u=2">x</a> http://b.test/x)',
      ),
      ['https://app.test/verify?t=1&u=2', 'http://b.test/x'],
    );
  });
});

describe('SQS queue URLs', () => {
  it("keeps only the path of the server's queue URL, on the endpoint the tests reach", () => {
    const queues = new SqsQueues({ endpoint: 'http://127.0.0.1:61234/' });
    assert.equal(
      queues.rebase('http://localhost:9324/000000000000/orders'),
      'http://127.0.0.1:61234/000000000000/orders',
    );
    assert.equal(
      queues.rebase('http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/orders'),
      'http://127.0.0.1:61234/000000000000/orders',
    );
  });
});

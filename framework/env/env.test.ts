import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnvironment, type EnvironmentDecl } from './declare.ts';
import { dnsAddress, plan, projectName, type PlanInput } from './generate.ts';
import { parseOutbound } from './lifecycle.ts';
import { hasPlaceholders, resolveDeep, resolvePlaceholders } from './placeholders.ts';

const dirs = { service: '/repo/regression/orders', project: '/repo' };

const declared = (): EnvironmentDecl =>
  parseEnvironment(
    {
      app: {
        build: { context: 'services/orders' },
        port: 8080,
        health: '/health',
        env: { DB: '{db.url}', PAY: '{payments.url}', BROKERS: '{events.brokers}', MODE: 'test' },
      },
      dependencies: {
        db: { kind: 'postgres', options: { database: 'orders' }, seed: 'seed.sql' },
        events: { kind: 'kafka', topics: { 'orders.created': { partitions: 2 } } },
        payments: { kind: 'wiremock', faults: true },
      },
    },
    dirs,
  )!;

const ports = new Map<string, number>([
  ['edge.api', 41001],
  ['app', 41002],
  ['db.main', 41003],
  ['events.external', 41004],
  ['payments.main', 41005],
]);

const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  service: 'orders',
  runId: 'r1',
  decl: declared(),
  hostPort: (key) => ports.get(key) ?? 0,
  subnet: '10.77.3.0/24',
  envDir: '/tmp/env',
  ...overrides,
});

describe('parseEnvironment', () => {
  it('is absent without an environment block, and resolves paths', () => {
    assert.equal(parseEnvironment(undefined, dirs), undefined);
    const decl = declared();
    assert.equal(decl.sealed, true);
    assert.equal(decl.app.build?.context, '/repo/services/orders');
    assert.equal(decl.dependencies.db.options.seed, '/repo/regression/orders/seed.sql');
    assert.equal(decl.dependencies.payments.faults, true);
  });

  it('refuses fixed host ports, unknown kinds, reserved names and a sealed host command', () => {
    const app = { image: 'x:1', port: 80 };
    assert.throws(
      () => parseEnvironment({ app, dependencies: { db: { kind: 'postgres', ports: ['5432:5432'] } } }, dirs),
      /chosen per run/,
    );
    assert.throws(
      () => parseEnvironment({ app, dependencies: { db: { kind: 'oracle' } } }, dirs),
      /not in the catalog/,
    );
    assert.throws(() => parseEnvironment({ app, dependencies: { edge: { kind: 'redis' } } }, dirs), /reserved/);
    assert.throws(() => parseEnvironment({ app: { command: 'node s.js', port: 80 } }, dirs), /cannot be sealed/);
    assert.ok(parseEnvironment({ sealed: false, app: { command: 'node s.js', port: 80 } }, dirs));
    assert.throws(() => parseEnvironment({ app: { image: 'x', build: 'y', port: 80 } }, dirs), /exactly one/);
  });
});

describe('plan', () => {
  it('seals the network, publishes only through the edge, on the per-run host ports', () => {
    const p = plan(input());
    const compose = p.compose as {
      name: string;
      networks: { sealed: { internal: boolean } };
      services: Record<string, { ports?: string[]; networks: unknown; dns?: string[] }>;
    };
    assert.equal(compose.name, 'vgate-orders-r1');
    assert.equal(compose.networks.sealed.internal, true);
    for (const [name, service] of Object.entries(compose.services)) {
      if (name === 'edge') continue;
      assert.equal(service.ports, undefined, `${name} must publish nothing`);
    }
    assert.deepEqual(compose.services.edge.ports, [
      '127.0.0.1:41001:8474',
      '127.0.0.1:41003:20000',
      '127.0.0.1:41004:20001',
      '127.0.0.1:41005:20002',
      '127.0.0.1:41002:20003',
    ]);
    assert.deepEqual(compose.services.app.networks, ['sealed']);
    assert.deepEqual(compose.services.app.dns, ['10.77.3.53']);
    // No search domain anywhere: the DNS log shows exactly the names asked for.
    for (const [name, service] of Object.entries(compose.services))
      if (name !== 'dns') assert.deepEqual((service as { dns_search?: string[] }).dns_search, ['.'], name);
    assert.equal(p.sealed, true);
  });

  it('keeps the edge API off the sealed network: the app cannot create a proxy to the outside', () => {
    const compose = plan(input()).compose as {
      networks: Record<string, { ipam?: { config: Array<{ subnet: string }> } }>;
      services: { edge: { command: string[]; networks: Record<string, { ipv4_address?: string }> } };
    };
    // The edge network has a gateway; the API listens on the edge's address there, which the sealed side cannot route to.
    assert.deepEqual(compose.networks.edge.ipam?.config, [{ subnet: '10.141.3.0/24' }]);
    assert.equal(compose.services.edge.networks.edge.ipv4_address, '10.141.3.2');
    assert.ok(compose.services.edge.command.includes('-host=10.141.3.2'), compose.services.edge.command.join(' '));
    assert.ok(!compose.services.edge.command.some((arg) => arg.includes('0.0.0.0')));
  });

  it("resolves the app's placeholders from inside and the tests' from the host", () => {
    const p = plan(input());
    assert.equal(p.appEnv.DB, 'postgres://app:app@db:5432/orders');
    assert.equal(p.appEnv.BROKERS, 'events:9092');
    // faults: the app reaches the provider through the edge's proxy named after it
    assert.equal(p.appEnv.PAY, 'http://edge:30000');
    assert.ok(p.edgeConfig.some((proxy) => proxy.name === 'payments' && proxy.upstream === 'payments:8080'));
    assert.equal(p.external.db.url, 'postgres://app:app@127.0.0.1:41003/orders');
    assert.equal(p.external.events.brokers, '127.0.0.1:41004');
    assert.equal(p.external.payments.adminUrl, 'http://127.0.0.1:41005');
    assert.equal(p.external.payments.proxy, 'payments');
    assert.equal(p.external.app.url, 'http://127.0.0.1:41002');
    assert.equal(p.external.edge.api, 'http://127.0.0.1:41001');
  });

  it('advertises Kafka at the host port the tests dial', () => {
    const p = plan(input());
    const env = (p.compose as { services: Record<string, { environment: Record<string, string> }> }).services.events
      .environment;
    assert.match(env.KAFKA_ADVERTISED_LISTENERS, /EXTERNAL:\/\/127\.0\.0\.1:41004/);
  });

  it('refuses a host port that was not chosen per run, and an unknown placeholder', () => {
    assert.throws(() => plan(input({ hostPort: () => 0 })), /chosen per run/);
    const decl = declared();
    decl.app.env.X = '{nope.url}';
    assert.throws(() => plan(input({ decl })), /unknown placeholder \{nope\.url\}/);
  });

  it('gives each run its own project name and DNS address', () => {
    assert.notEqual(projectName('orders', 'a1'), projectName('orders', 'b2'));
    assert.equal(dnsAddress('10.64.200.0/24'), '10.64.200.53');
    assert.throws(() => dnsAddress('10.0.0.0/16'), /a\.b\.c\.0\/24/);
  });
});

describe('placeholders', () => {
  it('needs a dot, so a header template such as {origin} is left alone', () => {
    const values = { app: { url: 'http://127.0.0.1:1' } };
    assert.equal(resolvePlaceholders('{app.url}/x {origin}', values, 'here'), 'http://127.0.0.1:1/x {origin}');
    assert.deepEqual(resolveDeep({ a: ['{app.url}'] }, values, 'here'), { a: ['http://127.0.0.1:1'] });
    assert.equal(hasPlaceholders({ a: '{origin}' }), false);
    assert.equal(hasPlaceholders({ a: ['{app.url}'] }), true);
  });
});

describe('parseOutbound', () => {
  const log = [
    '[INFO] 10.77.3.4:41234 - 2211 "A IN example.com. udp 29 false 512" NXDOMAIN qr,aa,rd 29 0.0001s',
    '[INFO] 10.77.3.4:41235 - 2212 "AAAA IN example.com. udp 29 false 512" NXDOMAIN qr,aa,rd 29 0.0001s',
    '[INFO] 10.77.3.5:41236 - 2213 "A IN telemetry.vendor.io. udp 29 false 512" NXDOMAIN',
    '[INFO] 10.77.3.4:41237 - 2214 "A IN db. udp 29 false 512" NXDOMAIN',
    '[INFO] 10.77.3.4:41238 - 2215 "A IN payments.example.net. udp 29 false 512" NXDOMAIN',
    'CoreDNS-1.12.1',
  ].join('\n');

  it('names who asked for what, once each; an outside name that starts like a dependency is outbound too', () => {
    const out = parseOutbound(log, { '10.77.3.4': 'app', '10.77.3.5': 'payments' }, ['app', 'db', 'payments']);
    assert.deepEqual(out, [
      { from: 'app', host: 'example.com', port: null, blocked: true },
      { from: 'payments', host: 'telemetry.vendor.io', port: null, blocked: true },
      { from: 'app', host: 'payments.example.net', port: null, blocked: true },
    ]);
  });
});

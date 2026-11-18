import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseEnvironment } from './declare.ts';
import { plan, type PlanInput } from './generate.ts';
import { appImageName, contextHash, projectsFromListing, runLabels, splitSetup, supersededTags } from './lifecycle.ts';

const temps: string[] = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function context(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-ctx-'));
  temps.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const dirs = { service: '/repo/regression/orders', project: '/repo' };
const decl = (faults = false) =>
  parseEnvironment(
    {
      app: { build: { context: 'app' }, port: 8080, health: '/health', env: { BROKERS: '{events.brokers}' } },
      dependencies: { events: { kind: 'kafka', topics: { t: {} }, faults } },
    },
    dirs,
  )!;
const ports = new Map([
  ['edge.api', 41001],
  ['app', 41002],
  ['events.external', 41004],
  ['db.main', 41005],
  ['cache.main', 41006],
]);
const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  service: 'orders',
  runId: 'r1',
  decl: decl(),
  hostPort: (key) => ports.get(key) ?? 0,
  subnet: '10.77.3.0/24',
  envDir: '/tmp/env',
  ...overrides,
});

describe('app images are reused, not left behind per run', () => {
  it('names the built image after the build context, so an unchanged app is built once', () => {
    const image = appImageName('Orders', 'abc123def456', '/work/shop/reports');
    assert.match(image, /^vgate\/orders-[0-9a-f]{8}-app:abc123def456$/);
    assert.equal(appImageName('Orders', 'abc123def456', '/work/shop/reports'), image, 'stable for one project');
    // Two projects with a service of the same name never share a repository, so pruning one leaves the other alone.
    const other = appImageName('Orders', 'abc123def456', '/work/billing/reports');
    assert.notEqual(other.split(':')[0], image.split(':')[0]);
    assert.deepEqual(supersededTags(`${image}\n${other}`, image), []);
    const app = (plan(input({ appImage: image })).compose as { services: Record<string, Record<string, unknown>> })
      .services.app;
    assert.equal(app.image, image);
    assert.ok(app.build, 'still built from the context');
  });

  it('hashes what docker build sees: content, Dockerfile and target, minus node_modules and .dockerignore', () => {
    const dir = context({ 'server.ts': 'a', Dockerfile: 'FROM x', '.dockerignore': 'dist\n*.log\n' });
    const first = contextHash(dir, 'Dockerfile');
    assert.equal(contextHash(dir, 'Dockerfile'), first, 'stable');
    writeFileSync(join(dir, 'debug.log'), 'noise');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), 'noise');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'out.js'), 'noise');
    assert.equal(contextHash(dir, 'Dockerfile'), first, 'ignored files do not change the build');
    assert.notEqual(contextHash(dir, 'Dockerfile', 'test'), first, 'another target is another build');
    writeFileSync(join(dir, 'server.ts'), 'b');
    assert.notEqual(contextHash(dir, 'Dockerfile'), first, 'a code change is a new build');
  });

  it('removes every other tag of the app image and keeps the current one', () => {
    const listing = [
      'vgate/orders-app:aaa111',
      'vgate/orders-app:bbb222',
      'vgate/orders-app:<none>',
      'vgate/payments-app:ccc333',
    ].join('\n');
    assert.deepEqual(supersededTags(listing, 'vgate/orders-app:bbb222'), ['vgate/orders-app:aaa111']);
  });
});

describe('down finds a run without its state file', () => {
  it('labels every container and network with the project and service', () => {
    const labels = runLabels('/repo/reports', 'orders');
    const compose = plan(input({ labels })).compose as {
      services: Record<string, { labels?: Record<string, string> }>;
      networks: Record<string, { labels?: Record<string, string> }>;
    };
    for (const [name, service] of Object.entries(compose.services)) assert.deepEqual(service.labels, labels, name);
    for (const [name, network] of Object.entries(compose.networks)) assert.deepEqual(network.labels, labels, name);
  });

  it("takes only this service's compose projects from docker's listing, once each", () => {
    const listing = ['vgate-orders-a1b2c3', '', 'vgate-orders-a1b2c3', 'vgate-orders-d4e5f6', 'vgate-payments-zz'].join(
      '\n',
    );
    assert.deepEqual(projectsFromListing(listing, 'orders'), ['vgate-orders-a1b2c3', 'vgate-orders-d4e5f6']);
  });
});

describe('kafka behind the edge (faults: true)', () => {
  it('gives the app the proxy as its brokers and advertises the proxy, so reconnects are faulted too', () => {
    const planned = plan(input({ decl: decl(true) }));
    const proxy = planned.edgeConfig.find((proxy) => proxy.name === 'events');
    assert.ok(proxy, 'a proxy named after the dependency');
    const port = proxy.listen.split(':')[1];
    assert.equal(proxy.upstream, 'events:9092');
    assert.equal(planned.appEnv.BROKERS, `edge:${port}`);
    const env = (planned.compose as { services: Record<string, { environment: Record<string, string> }> }).services
      .events.environment;
    assert.match(env.KAFKA_ADVERTISED_LISTENERS, new RegExp(`PLAINTEXT://edge:${port},`));
  });

  it('without faults the app dials the broker by name on its internal listener', () => {
    const planned = plan(input());
    assert.equal(planned.appEnv.BROKERS, 'events:9092');
  });
});

describe('file options of a kind', () => {
  it('resolve against the service directory; a file option the kind does not take is refused', () => {
    const env = (deps: Record<string, unknown>) =>
      parseEnvironment({ app: { image: 'x:1', port: 80 }, dependencies: deps }, dirs);
    assert.equal(
      env({ db: { kind: 'mysql', init: 'seed/orders.sql' } })!.dependencies.db.options.init,
      '/repo/regression/orders/seed/orders.sql',
    );
    assert.equal(
      env({ db: { kind: 'postgres', seed: 's.sql' } })!.dependencies.db.options.seed,
      '/repo/regression/orders/s.sql',
    );
    assert.equal(
      env({ idp: { kind: 'keycloak', realmFile: 'realm.json' } })!.dependencies.idp.options.realmFile,
      '/repo/regression/orders/realm.json',
    );
    assert.throws(() => env({ db: { kind: 'mysql', seed: 'x.sql' } }), /takes init instead/);
  });
});

describe('migrations of a dependency (migrate:)', () => {
  const withMigrations = () =>
    parseEnvironment(
      {
        app: { image: 'x:1', port: 80 },
        dependencies: {
          db: { kind: 'postgres', seed: 'seed.sql', migrate: { dir: 'db/migrations', command: 'apply-all' } },
          cache: { kind: 'redis' },
        },
      },
      dirs,
    )!;

  it('adds a tool service per migrating dependency, on the sealed network, never started by up', () => {
    const planned = plan(input({ decl: withMigrations(), projectRoot: '/repo' }));
    assert.deepEqual(
      planned.migrations.map((m) => [m.dependency, m.service, m.config.dir]),
      [['db', 'migrate-db', '/repo/db/migrations']],
    );
    const service = (planned.compose as { services: Record<string, Record<string, unknown>> }).services['migrate-db'];
    assert.deepEqual(service.profiles, ['tools']);
    assert.deepEqual(service.networks, ['sealed']);
    assert.match(String(service.image), /^postgres:/);
  });

  it('changes nothing for a service without migrate:', () => {
    const planned = plan(input());
    assert.deepEqual(planned.migrations, []);
    const services = Object.keys((planned.compose as { services: Record<string, unknown> }).services);
    assert.ok(!services.some((name) => name.startsWith('migrate-')), services.join(', '));
  });

  it('runs migrations after the readiness query and before the seed', () => {
    const ready = ['pg_isready'];
    const seed = ['psql', '-f', 'seed.sql'];
    assert.deepEqual(splitSetup([ready, seed], true), { before: [ready], after: [seed] });
    assert.deepEqual(splitSetup([ready, seed], false), { before: [ready, seed], after: [] });
  });
});

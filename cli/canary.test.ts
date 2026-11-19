import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseCanary } from '../framework/config.ts';
import { readProject } from '../framework/project.ts';
import { canary, evaluate, parseDuration, readMetric, type Fetcher } from './canary.ts';
import { EXIT } from './output.ts';
import type { Runtime } from './runtime.ts';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('canary: limits and baseline', () => {
  const cfg = { limits: { errorRate: 0.01, p95Ms: 500 } };
  it('is healthy at or below every limit', () => {
    assert.deepEqual(evaluate(cfg, { errorRate: 0.01, p95Ms: 120 }), []);
  });
  it('breaches above a limit, naming the metric, its value and the limit', () => {
    assert.deepEqual(evaluate(cfg, { errorRate: 0.05, p95Ms: 120 }), [
      { metric: 'errorRate', value: 0.05, limit: 0.01, kind: 'limit' },
    ]);
  });
  it('breaches at more than maxRatio times a baseline above 0, even under the absolute limit', () => {
    const breaches = evaluate({ ...cfg, maxRatio: 2 }, { errorRate: 0.009, p95Ms: 120 }, { errorRate: 0.004 });
    assert.deepEqual(
      breaches.map((b) => [b.metric, b.kind]),
      [['errorRate', 'baseline']],
    );
    assert.deepEqual(evaluate({ ...cfg, maxRatio: 2 }, { errorRate: 0.009, p95Ms: 120 }, { errorRate: 0 }), []);
  });
  it('reads durations', () => {
    assert.equal(parseDuration('30s', 'x'), 30_000);
    assert.equal(parseDuration('10m', 'x'), 600_000);
    assert.equal(parseDuration('250ms', 'x'), 250);
    assert.equal(parseDuration('5', 'x'), 5000);
    assert.throws(() => parseDuration('soon', '--for'), /--for: a duration/);
  });
  it('validates its configuration', () => {
    assert.throws(() => parseCanary({ source: 'x', url: 'http://p' }, 'c'), /source/);
    assert.throws(
      () => parseCanary({ source: 'prometheus', url: 'http://p', queries: { e: 'q' }, limits: {} }, 'c'),
      /limits\.e/,
    );
  });
});

const reply =
  (status: number, body: unknown): Fetcher =>
  () =>
    Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });

describe('canary: reading metrics never turns missing data into a value', () => {
  const prom = { source: 'prometheus' as const, url: 'http://prom' };
  it('reads a Prometheus vector and scalar', async () => {
    const vector = { status: 'success', data: { resultType: 'vector', result: [{ value: [1, '0.02'] }] } };
    assert.equal(await readMetric(prom, 'q', reply(200, vector)), 0.02);
    const scalar = { status: 'success', data: { resultType: 'scalar', result: [1, '7'] } };
    assert.equal(await readMetric(prom, 'q', reply(200, scalar)), 7);
  });
  it('fails on an empty vector, an error status, a non-200 or no answer', async () => {
    const empty = { status: 'success', data: { resultType: 'vector', result: [] } };
    await assert.rejects(readMetric(prom, 'q', reply(200, empty)), /no value/);
    await assert.rejects(readMetric(prom, 'q', reply(200, { status: 'error', error: 'bad' })), /refused/);
    await assert.rejects(readMetric(prom, 'q', reply(503, {})), /answered 503/);
    await assert.rejects(
      readMetric(prom, 'q', () => Promise.reject(new Error('ECONNREFUSED'))),
      /unreachable/,
    );
  });
  it('takes the worst of several series, +Inf as above any limit, NaN as no value', async () => {
    const vector = (...values: string[]) => ({
      status: 'success',
      data: { resultType: 'vector', result: values.map((v) => ({ value: [1, v] })) },
    });
    // Per pod: one healthy pod listed first must not hide the failing one.
    assert.equal(await readMetric(prom, 'q', reply(200, vector('0.001', '0.5', 'NaN'))), 0.5);
    assert.equal(await readMetric(prom, 'q', reply(200, vector('+Inf'))), Infinity);
    await assert.rejects(readMetric(prom, 'q', reply(200, vector('NaN'))), /no value/);
  });
  it('reads a dotted path of an HTTP JSON source', async () => {
    const http = { source: 'http' as const, url: 'http://m/health.json' };
    assert.equal(await readMetric(http, 'stats.errors', reply(200, { stats: { errors: '3' } })), 3);
    await assert.rejects(readMetric(http, 'stats.missing', reply(200, { stats: {} })), /no value/);
  });
});

// The command end to end, against a Prometheus-compatible stub serving whatever the test sets.
describe('canary: the command', () => {
  let errorRate = '0.001';
  let up = true;
  const prom = createServer((req, res) => {
    if (!up) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const query = new URL(req.url ?? '/', 'http://x').searchParams.get('query') ?? '';
    const value = query.includes('error') ? errorRate : '120';
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [0, value] }] } }));
  });
  after(() => prom.close());

  function project(port: number) {
    const root = mkdtempSync(join(tmpdir(), 'vgate-canary-'));
    dirs.push(root);
    writeFileSync(join(root, 'vgate.yaml'), 'version: 0.3.0\nservicesDir: services\n');
    mkdirSync(join(root, 'services', 'api'), { recursive: true });
    writeFileSync(
      join(root, 'services', 'api', 'service.yaml'),
      [
        'spec: openapi.yaml',
        'environments:',
        '  production:',
        '    baseUrl: http://127.0.0.1:1',
        '    disposable: false',
        '    users: {}',
        '    canary:',
        '      source: prometheus',
        `      url: http://127.0.0.1:${port}`,
        "      queries: { errorRate: 'sum(rate(http_errors[1m]))', p95Ms: 'p95' }",
        '      limits: { errorRate: 0.01, p95Ms: 500 }',
      ].join('\n'),
    );
    return { root, project: readProject(root) };
  }

  it('answers healthy (0), breach (1, running --on-fail once) and unknown (3, no rollback)', async () => {
    await new Promise<void>((done) => prom.listen(0, '127.0.0.1', done));
    const { root, project: p } = project((prom.address() as AddressInfo).port);
    const runtime = { root } as Runtime;
    const marker = join(root, 'rolled-back');
    const run = () =>
      canary(p, runtime, {
        service: 'api',
        env: 'production',
        forMs: 30,
        everyMs: 10,
        onFail: `echo once >> '${marker}'`,
        smoke: false,
        live: false,
        sleep: () => Promise.resolve(),
      });

    const healthy = await run();
    assert.equal(healthy.exitCode, EXIT.ok, healthy.summary);
    assert.ok(!existsSync(marker));

    errorRate = '0.2';
    const breach = await run();
    assert.equal(breach.exitCode, EXIT.failed);
    assert.match(breach.summary, /errorRate 0\.2 above its limit 0\.01/);
    assert.equal(readFileSync(marker, 'utf8'), 'once\n', 'the rollback ran exactly once');

    up = false;
    const unknown = await run();
    assert.equal(unknown.exitCode, EXIT.notReady);
    assert.match(unknown.summary, /UNKNOWN/);
    assert.equal(readFileSync(marker, 'utf8'), 'once\n', 'no rollback on unreadable metrics');
  });

  it('a metric it cannot read neither hides a breach of another nor ends the watch', async () => {
    const { root, project: p } = project(1);
    const runtime = { root } as Runtime;
    // Round 1: the p95 query times out; round 2: the error rate breaches while the p95 is still unreadable.
    let round = 0;
    const fetcher: Fetcher = (url) => {
      const query = new URL(url).searchParams.get('query') ?? '';
      if (query === 'p95') return Promise.reject(new Error('timeout'));
      if (query.includes('error')) round++;
      const value = round >= 2 ? '0.5' : '0.001';
      return reply(200, { status: 'success', data: { resultType: 'vector', result: [{ value: [0, value] }] } })(url, {
        headers: {},
      });
    };
    const result = await canary(p, runtime, {
      service: 'api',
      env: 'production',
      forMs: 60_000,
      everyMs: 1,
      onFail: `echo once >> '${join(root, 'rolled-back')}'`,
      smoke: false,
      live: false,
      fetcher,
      sleep: () => Promise.resolve(),
    });
    assert.equal(result.exitCode, EXIT.failed, result.summary);
    assert.match(result.summary, /errorRate 0\.5 above its limit 0\.01/);
    assert.equal(round, 2, 'the watch went on after the unreadable round');
    assert.equal(readFileSync(join(root, 'rolled-back'), 'utf8'), 'once\n');
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import { loadService } from '../framework/config.ts';
import { readProject } from '../framework/project.ts';
import { checkSandbox, describe as explain, drift, sandboxesOf } from './drift.ts';
import { EXIT, UsageError } from './output.ts';

// The provider's contract, inline: the self-tests also run inside users' projects, where no reference service exists.
const CONTRACT = `openapi: 3.1.0
info: { title: Payments provider, version: '1' }
paths:
  /charges:
    post:
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: '#/components/schemas/ChargeRequest' } } }
      responses:
        '201':
          description: The charge succeeded
          content: { application/json: { schema: { $ref: '#/components/schemas/Charge' } } }
        '402':
          description: Declined
          content: { application/json: { schema: { $ref: '#/components/schemas/Decline' } } }
components:
  schemas:
    ChargeRequest:
      type: object
      additionalProperties: false
      required: [amount, currency, customer, reference]
      properties:
        amount: { type: integer, minimum: 1 }
        currency: { type: string, enum: [IDR, USD] }
        customer: { type: string, minLength: 1 }
        reference: { type: string, minLength: 1 }
    Charge:
      type: object
      required: [id, status, amount, currency]
      properties:
        id: { type: string }
        status: { type: string, enum: [succeeded] }
        amount: { type: integer }
        currency: { type: string, enum: [IDR, USD] }
    Decline:
      type: object
      required: [code, message]
      properties:
        code: { type: string }
        message: { type: string }
`;
const dirs: string[] = [];
const servers: Server[] = [];
after(() => {
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  servers.forEach((server) => server.close());
});

/** A stand-in for the provider's sandbox: answers POST /charges with `charge`. */
async function provider(charge: Record<string, unknown>, status = 201): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/charges' || req.headers.authorization !== 'Bearer sandbox-key') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(charge));
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const CHARGE = { id: 'ch_test_1', status: 'succeeded', amount: 100, currency: 'IDR' };
const REQUEST = { amount: 100, currency: 'IDR', customer: 'c1', reference: 'drift-1' };

function serviceYaml(url: string, extra = ''): string {
  return [
    'name: orders',
    'environments:',
    '  local:',
    '    dependencies:',
    '      payments:',
    '        kind: http-stub',
    '        adminUrl: http://localhost:1',
    '        contract: deps/payments.openapi.yaml',
    '        sandbox:',
    `          url: ${url}`,
    "          headers: { Authorization: 'Bearer ${PAYMENTS_SANDBOX_KEY}' }",
    '          requests:',
    `            - { operation: 'POST /charges', body: ${JSON.stringify(REQUEST)} }`,
    extra,
  ].join('\n');
}

function project(url: string): string {
  const root = mkdtempSync(join(tmpdir(), 'vgate-drift-'));
  dirs.push(root);
  writeFileSync(join(root, 'vgate.yaml'), 'version: 0.4.0\nservicesDir: regression\n');
  mkdirSync(join(root, 'regression/orders/deps'), { recursive: true });
  writeFileSync(join(root, 'regression/orders/deps/payments.openapi.yaml'), CONTRACT);
  writeFileSync(join(root, 'regression/orders/service.yaml'), serviceYaml(url));
  return root;
}

describe('drift: reading the sandboxes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vgate-drift-contract-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'deps'));
  writeFileSync(join(dir, 'deps/payments.openapi.yaml'), CONTRACT);
  const env = { PAYMENTS_SANDBOX_KEY: 'sandbox-key' };

  it('reads the sandbox, its secret and its requests, checked against the provider contract', () => {
    const [sandbox] = sandboxesOf(
      parse(serviceYaml('https://sandbox.example')),
      'orders',
      'local',
      dir,
      undefined,
      env,
    );
    assert.equal(sandbox.headers.Authorization, 'Bearer sandbox-key');
    assert.deepEqual(
      sandbox.requests.map((r) => r.operation),
      ['POST /charges'],
    );
  });

  it('names a missing secret instead of sending a request without it', () => {
    assert.throws(
      () => sandboxesOf(parse(serviceYaml('https://sandbox.example')), 'orders', 'local', dir, undefined, {}),
      /PAYMENTS_SANDBOX_KEY is required/,
    );
  });

  it('refuses requests the contract does not document, or bodies it would refuse', () => {
    const unknown = serviceYaml('https://s.example').replace("'POST /charges'", "'DELETE /charges'");
    assert.throws(() => sandboxesOf(parse(unknown), 'orders', 'local', dir, undefined, env), UsageError);
    const badBody = serviceYaml('https://s.example').replace('"currency":"IDR"', '"currency":"EUR"');
    assert.throws(() => sandboxesOf(parse(badBody), 'orders', 'local', dir, undefined, env), /request schema/);
  });

  it('says a missing field plus a new one looks like a rename', () => {
    assert.match(
      explain(["/ must have required property 'id'", '/ must NOT have unevaluated properties "chargeId"']).at(-1) ?? '',
      /looks renamed: "id" missing, "chargeId" new/,
    );
  });
});

describe('a sandbox and the gate', () => {
  it("never needs the sandbox's secret to load the service for a gate", () => {
    const root = project('https://sandbox.example');
    writeFileSync(
      join(root, 'regression/orders/service.yaml'),
      `spec: openapi.yaml\n${serviceYaml('https://sandbox.example')}`.replace(
        '    dependencies:',
        '    disposable: true\n    baseUrl: http://localhost:1\n    users: {}\n    dependencies:',
      ),
    );
    delete process.env.PAYMENTS_SANDBOX_KEY;
    const svc = loadService('orders', 'local', root);
    assert.equal(svc.env.dependencies?.payments?.kind, 'http-stub');
  });
});

describe('vgate drift against a sandbox', () => {
  let compliant = '';
  let renamed = '';
  let undocumented = '';
  before(async () => {
    process.env.PAYMENTS_SANDBOX_KEY = 'sandbox-key';
    compliant = await provider(CHARGE);
    const { id, ...rest } = CHARGE;
    renamed = await provider({ ...rest, chargeId: id });
    undocumented = await provider({ code: 'gone', message: 'moved' }, 410);
  });

  it('passes when the sandbox answers as the vendored contract says', async () => {
    const result = await drift(readProject(project(compliant)), { env: 'local' });
    assert.equal(result.exitCode, EXIT.ok, result.summary);
  });

  it('fails on a renamed field, naming the operation and the fields', async () => {
    const result = await drift(readProject(project(renamed)), { env: 'local' });
    assert.equal(result.exitCode, EXIT.failed);
    assert.match(result.summary, /DRIFT: 1 of 1 .*payments POST \/charges/);
    assert.ok((result.text ?? []).some((line) => /looks renamed: "id" missing, "chargeId" new/.test(line)));
  });

  it('fails on a status the contract does not document', async () => {
    const [sandbox] = sandboxesOf(
      parse(serviceYaml(undocumented)),
      'orders',
      'local',
      join(project(undocumented), 'regression/orders'),
    );
    const [check] = await checkSandbox(sandbox);
    assert.equal(check.state, 'drift');
    assert.match(check.problems[0], /status 410 is not documented/);
  });

  it('never passes when the sandbox cannot be reached', async () => {
    const result = await drift(readProject(project('http://127.0.0.1:9')), { env: 'local' });
    assert.equal(result.exitCode, EXIT.notReady);
    assert.match(result.summary, /NOT CHECKED/);
  });

  it('refuses a run with nothing to compare', async () => {
    const root = project(compliant);
    writeFileSync(join(root, 'regression/orders/service.yaml'), 'name: orders\nenvironments:\n  local: {}\n');
    await assert.rejects(drift(readProject(root), { env: 'local' }), /declares a sandbox/);
  });
});

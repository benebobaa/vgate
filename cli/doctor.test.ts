import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ServiceConfig } from '../framework/config.ts';
import { atLeast, checkTool, healthUrl, parseVersion } from './doctor.ts';

describe('parseVersion', () => {
  it('reads the version out of what each tool prints', () => {
    assert.deepEqual(parseVersion('v22.22.0'), [22, 22, 0]);
    assert.deepEqual(parseVersion('10.17.1'), [10, 17, 1]);
    assert.deepEqual(parseVersion('openjdk version "21.0.4" 2026-07-16'), [21, 0, 4]);
    assert.deepEqual(parseVersion('git version 2.50.1 (Apple Git-155)'), [2, 50, 1]);
    assert.deepEqual(parseVersion('GNU bash, version 5.2.37(1)-release (aarch64-apple-darwin24.0.0)'), [5, 2, 37]);
  });

  it('fills the parts a short version leaves out with zero', () => {
    assert.deepEqual(parseVersion('22'), [22, 0, 0]);
    assert.deepEqual(parseVersion('uvx 0.9'), [0, 9, 0]);
  });

  it('does not take a digit in the tool name for the version', () => {
    assert.deepEqual(parseVersion('k6 v1.2'), [1, 2, 0]);
    assert.deepEqual(parseVersion('k6 v1.2.3 (commit/abc, go1.24.4, darwin/arm64)'), [1, 2, 3]);
  });

  it('gives undefined when there is no version', () => {
    assert.equal(parseVersion('command not found'), undefined);
    assert.equal(parseVersion(''), undefined);
  });
});

describe('atLeast', () => {
  it('accepts the same version and anything above it', () => {
    assert.ok(atLeast([22, 0, 0], [22, 0, 0]));
    assert.ok(atLeast([22, 1, 0], [22, 0, 0]));
    assert.ok(atLeast([22, 0, 1], [22, 0, 0]));
    assert.ok(atLeast([23, 0, 0], [22, 9, 9]));
  });

  it('rejects anything below, whichever part is short', () => {
    assert.ok(!atLeast([21, 9, 9], [22, 0, 0]));
    assert.ok(!atLeast([22, 3, 9], [22, 4, 0]));
    assert.ok(!atLeast([22, 4, 0], [22, 4, 1]));
  });

  it('reads a missing part as zero', () => {
    assert.ok(atLeast([22], [22, 0, 0]));
    assert.ok(atLeast([22, 0, 0], [22]));
    assert.ok(!atLeast([22], [22, 0, 1]));
  });
});

describe('healthUrl', () => {
  const service = (healthPath?: string) =>
    ({ env: { baseUrl: 'http://localhost:8090', healthPath } }) as unknown as ServiceConfig;

  it('joins the base URL and the health path', () => {
    assert.equal(healthUrl(service('/health')), 'http://localhost:8090/health');
  });

  it('is undefined for a service that names no health path', () => {
    assert.equal(healthUrl(service()), undefined);
  });
});

describe('checkTool', () => {
  it('reports the line that carries the version, past a heading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vgate-doctor-'));
    const tool = join(dir, 'tool');
    writeFileSync(tool, '#!/bin/sh\necho "tool version information:"\necho "    revision: 4.91"\n');
    chmodSync(tool, 0o755);
    const check = checkTool({ id: 'tool', command: tool, args: ['-v'], fix: 'install it' });
    assert.equal(check.status, 'ok');
    assert.equal(check.detail, 'revision: 4.91');
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, not fails, when an optional tool such as lsof is missing', () => {
    const check = checkTool({
      id: 'lsof',
      command: 'vgate-no-such-tool',
      args: ['-v'],
      optional: 'up restarts the app every time',
      fix: 'apt-get install -y lsof',
    });
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /not installed \(up restarts the app every time\)/);
  });
});

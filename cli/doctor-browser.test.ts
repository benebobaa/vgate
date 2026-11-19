import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ServiceConfig } from '../framework/config.ts';
import { browserCheck, uvNeeded } from './doctor.ts';
import type { Runtime } from './runtime.ts';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function runtime(installed: boolean): Runtime {
  const root = mkdtempSync(join(tmpdir(), 'vgate-browser-'));
  dirs.push(root);
  if (installed) mkdirSync(join(root, 'node_modules', '@playwright', 'test'), { recursive: true });
  return { root } as Runtime;
}

describe('doctor: the browser of UI services', () => {
  it('checks nothing when no service has a UI', () => {
    assert.equal(
      browserCheck(runtime(true), [], () => '/nowhere'),
      undefined,
    );
  });

  it('fails with the fix when Chromium is missing, and passes when it is there', () => {
    const rt = runtime(true);
    const missing = browserCheck(rt, ['web'], () => join(rt.root, 'chrome'));
    assert.equal(missing?.status, 'fail');
    assert.equal(missing?.autofix, true);
    assert.match(missing?.detail ?? '', /Chromium is not installed .* web/);

    const chrome = join(rt.root, 'chrome');
    writeFileSync(chrome, '');
    assert.equal(browserCheck(rt, ['web'], () => chrome)?.status, 'ok');
    // Playwright that cannot even name its browser is a missing browser, not a pass.
    assert.equal(browserCheck(rt, ['web'], () => undefined)?.status, 'fail');
  });

  it('asks for the runtime first when it is not installed', () => {
    const check = browserCheck(runtime(false), ['web', 'admin'], () => '/nowhere');
    assert.equal(check?.status, 'fail');
    assert.match(check?.detail ?? '', /runtime is not installed yet .* web, admin/);
  });
});

describe('doctor: uv, for the contract step', () => {
  it('is needed by every service with a contract, a UI service with one too, and by a service that does not load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vgate-uv-'));
    dirs.push(dir);
    const spec = join(dir, 'openapi.yaml');
    writeFileSync(spec, 'openapi: 3.1.0\n');
    const svc = (over: Partial<ServiceConfig>) =>
      ({ name: 's', specPath: join(dir, 'none.yaml'), ...over }) as ServiceConfig;
    const ui = {
      allowedOrigins: ['self'],
      viewports: {},
      clock: '',
      a11y: { minImpact: 'serious' as const, disable: [] },
    };
    assert.equal(uvNeeded([svc({ ui })]), false, 'a UI service without a contract');
    assert.equal(uvNeeded([svc({ ui, specPath: spec })]), true, 'a UI service with a contract runs Schemathesis');
    assert.equal(uvNeeded([svc({ ui }), svc({ specPath: spec })]), true);
    assert.equal(uvNeeded([svc({ ui }), undefined]), true);
    assert.equal(uvNeeded([]), true);
  });
});

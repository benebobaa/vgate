import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { browserCheck } from './doctor.ts';
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

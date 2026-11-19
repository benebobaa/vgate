import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readProject } from '../framework/project.ts';
import type { Runtime } from './runtime.ts';
import { stack } from './stack.ts';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('reset', () => {
  it('never wipes an environment that is not disposable, whatever its stack.sh would do', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vgate-reset-'));
    dirs.push(root);
    writeFileSync(join(root, 'vgate.yaml'), 'version: 0.3.0\nservicesDir: services\n');
    const dir = join(root, 'services', 'api');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'service.yaml'),
      'spec: openapi.yaml\nenvironments:\n  production:\n    baseUrl: http://127.0.0.1:1\n    disposable: false\n    users: {}\n',
    );
    const marker = join(root, 'wiped');
    writeFileSync(join(dir, 'stack.sh'), `touch '${marker}'\n`);
    await assert.rejects(
      stack(readProject(root), { root } as Runtime, {
        service: 'api',
        action: 'reset',
        env: 'production',
        yes: true,
        live: false,
      }),
      /reset wipes data: environment production of api is not disposable/,
    );
    assert.ok(!existsSync(marker), 'stack.sh never ran');
  });
});

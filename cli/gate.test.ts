import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readProject } from '../framework/project.ts';
import { gate } from './gate.ts';
import { EXIT } from './output.ts';
import { currentRuntime } from './runtime.ts';

const scratch = mkdtempSync(join(tmpdir(), 'vgate-gate-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('gate', () => {
  it('leaves no earlier verdict behind when it stops before running a step', async () => {
    writeFileSync(join(scratch, 'vgate.yaml'), 'servicesDir: services\n');
    mkdirSync(join(scratch, 'reports'), { recursive: true });
    const verdict = join(scratch, 'reports', 'verdict.json');
    writeFileSync(verdict, JSON.stringify({ schema: 'vgate.verdict/1', service: 'svc', verdict: 'pass' }));

    // No service.yaml: nothing can be verified.
    const result = await gate(readProject(scratch), currentRuntime(), { service: 'svc', env: 'local', live: false });
    assert.equal(result.exitCode, EXIT.notReady);
    assert.equal(existsSync(verdict), false, 'a stale passing verdict.json survived a gate that verified nothing');
  });
});

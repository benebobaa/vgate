import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { capture } from './project.ts';
import { PACKAGE_MANAGER_ENV, stepEnv, toolEnv, type Runtime } from './runtime.ts';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('package-manager neutrality', () => {
  it('gives every step the switches that stop corepack and pnpm refusing to run in a bun or yarn project', () => {
    const env = stepEnv(
      {
        root: '/p',
        servicesDir: '/p/regression',
        reportsDir: '/p/reports',
        servicesDirName: 'regression',
        declared: true,
        policy: { autoMerge: 'none' },
      },
      { root: '/r' } as Runtime,
    );
    for (const [name, value] of Object.entries(PACKAGE_MANAGER_ENV)) assert.equal(env[name], value, name);
  });

  // The first external project declared `"packageManager": "bun@..."`, and vgate's pnpm calls failed there until the
  // user added an .npmrc. Runs where pnpm is installed (CI and every machine that passed `vgate doctor`).
  const pnpm = capture('pnpm', ['--version'], tmpdir(), 15_000);
  it('runs pnpm inside a project that declares bun as its package manager', { skip: pnpm.missing }, () => {
    const project = mkdtempSync(join(tmpdir(), 'vgate-bun-project-'));
    dirs.push(project);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'bun@1.4.4' }));
    const run = capture('pnpm', ['--version'], project, 30_000, toolEnv());
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /^\d+\.\d+/);
  });
});

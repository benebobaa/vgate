import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkTool } from './doctor.ts';
import { capture } from './project.ts';
import { PACKAGE_MANAGER_ENV, stepEnv, type Runtime } from './runtime.ts';

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

  // The first external project declared `"packageManager": "bun@..."`, and vgate's pnpm calls failed there: pnpm
  // refuses a project configured for another manager, and corepack refuses even to start pnpm inside it. vgate
  // therefore never runs pnpm with a project as its working directory: doctor asks from a neutral directory, the
  // runtime installs inside the runtime. Runs where pnpm is installed (CI and every machine that passed doctor).
  const pnpm = capture('pnpm', ['--version'], tmpdir(), 15_000);
  it('finds pnpm while the caller stands in a project that declares bun', { skip: pnpm.missing }, () => {
    const project = mkdtempSync(join(tmpdir(), 'vgate-bun-project-'));
    dirs.push(project);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app', packageManager: 'bun@1.4.4' }));
    const here = process.cwd();
    process.chdir(project);
    try {
      const check = checkTool({ id: 'pnpm', command: 'pnpm', args: ['--version'], fix: 'corepack enable pnpm' });
      assert.equal(check.status, 'ok', check.detail);
      assert.match(check.detail, /\d+\.\d+/);
    } finally {
      process.chdir(here);
    }
  });
});

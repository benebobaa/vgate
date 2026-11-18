import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// The stack library every stack.sh sources: app_up must never adopt an app this project did not start. On a real pull
// request a server another checkout left on the port answered the health check, and the gate tested that code.
const LIB = join(dirname(fileURLToPath(import.meta.url)), 'lib.sh');
const work = mkdtempSync(join(tmpdir(), 'vgate-lib-'));
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill('SIGKILL');
  spawnSync('bash', ['-c', `source "${LIB}"; stack_init t; app_stop`], { env: env(), encoding: 'utf8' });
  rmSync(work, { recursive: true, force: true });
});

writeFileSync(
  join(work, 'server.js'),
  "require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n",
);

const hasLsof = spawnSync('lsof', ['-v']).error === undefined;

function env(): NodeJS.ProcessEnv {
  return { ...process.env, VGATE_PROJECT: work, VGATE_REPORTS: join(work, 'reports') };
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => done(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (
      await fetch(url).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`nothing answered at ${url}`);
}

function appUp(port: number) {
  const script = `source "${LIB}"; stack_init t; PORT=${port} app_up "http://127.0.0.1:${port}/health" ${port} 10 "${work}" node "${work}/server.js"`;
  return spawnSync('bash', ['-c', script], {
    env: { ...env(), PORT: String(port) },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('app_up (framework/stack/lib.sh)', () => {
  it(
    'refuses a healthy app on its port that this project did not start, naming who holds it',
    { skip: !hasLsof },
    async () => {
      const port = await freePort();
      const stray = spawn('node', [join(work, 'server.js')], { env: { ...process.env, PORT: String(port) } });
      children.push(stray);
      await waitFor(`http://127.0.0.1:${port}/health`);
      const run = appUp(port);
      assert.equal(run.status, 3, run.stdout + run.stderr);
      assert.match(run.stderr, new RegExp(`held by node \\(pid ${stray.pid}\\)`));
      stray.kill('SIGKILL');
    },
  );

  it('starts its own app, then recognises it as its own on the next up', { skip: !hasLsof }, async () => {
    const port = await freePort();
    const first = appUp(port);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /Starting t/);
    const second = appUp(port);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /already UP/);
  });
});

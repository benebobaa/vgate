import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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

// A server that keeps its port for 2s after SIGTERM, as an app draining connections does.
writeFileSync(
  join(work, 'slow.js'),
  "const s = require('node:http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n" +
    "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 2000));\n",
);
// A server that ignores SIGTERM.
writeFileSync(
  join(work, 'stubborn.js'),
  "require('node:http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n" +
    "process.on('SIGTERM', () => {});\n",
);
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

async function waitGone(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (
      !(await fetch(url).then(
        (r) => r.ok,
        () => false,
      ))
    )
      return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`still answering at ${url}`);
}

// A PATH with the tools the library uses but no lsof, as on a machine without it.
const noLsof = (() => {
  const dir = join(work, 'bin-no-lsof');
  mkdirSync(dir);
  const tools = 'bash sh curl git ps pgrep cat head tr seq sleep mkdir rm node nohup env dirname tail readlink';
  for (const tool of tools.split(' ')) {
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found.startsWith('/')) symlinkSync(found, join(dir, tool));
  }
  return dir;
})();

interface Opts {
  repo?: string; // the checkout the app is built from (BUILD_REPO), as a service's stack.sh sets it
  cmd?: string; // the command that starts the app
  path?: string; // PATH override
}

function run(script: string, port: number, o: Opts, extra: NodeJS.ProcessEnv = {}) {
  const e = { ...env(), PORT: String(port), ...(o.path ? { PATH: o.path } : {}), ...extra };
  const lib = `source "${LIB}"; stack_init t; BUILD_REPO="${o.repo ?? ''}"; `;
  return spawnSync('bash', ['-c', lib + script], { env: e, encoding: 'utf8', timeout: 60_000 });
}

function status(port: number, o: Opts = {}) {
  return run(`app_status "http://127.0.0.1:${port}/health" "${o.repo ?? ''}" ${port}`, port, o);
}

function appUp(port: number, o: Opts = {}) {
  const cmd = o.cmd ?? `node "${work}/server.js"`;
  return run(`app_up "http://127.0.0.1:${port}/health" ${port} 10 "${work}" ${cmd}`, port, o);
}

function appStop() {
  return spawnSync('bash', ['-c', `source "${LIB}"; stack_init t; app_stop`], { env: env(), encoding: 'utf8' });
}

// A git checkout with one commit; returns a function that runs git in it.
function checkout(name: string) {
  const repo = join(work, name);
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  mkdirSync(repo);
  git('init', '-q');
  writeFileSync(join(repo, 'f'), 'a\n');
  git('add', 'f');
  git('commit', '-qm', 'a');
  const commit = () => {
    writeFileSync(join(repo, 'f'), `${Date.now()}\n`);
    git('commit', '-qam', 'next');
    return git('rev-parse', '--short', 'HEAD');
  };
  return { repo, head: () => git('rev-parse', '--short', 'HEAD'), commit };
}

// On Linux, /proc/<pid>/exe resolves symlinks (e.g. Fedora's /usr/bin/node -> /usr/bin/node-24); elsewhere ps comm
// reports the invoked executable's basename.
const nodeName = basename(process.platform === 'linux' ? realpathSync(process.execPath) : process.execPath);
const nodePattern = nodeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stray(port: number) {
  const child = spawn(process.execPath, [join(work, 'server.js')], { env: { ...process.env, PORT: String(port) } });
  children.push(child);
  return child;
}

describe('app_up (framework/stack/lib.sh)', () => {
  it(
    'refuses a healthy app on its port that this project did not start, naming who holds it',
    { skip: !hasLsof },
    async () => {
      const port = await freePort();
      const other = stray(port);
      await waitFor(`http://127.0.0.1:${port}/health`);
      const up = appUp(port);
      assert.equal(up.status, 3, up.stdout + up.stderr);
      assert.match(up.stderr, new RegExp(`held by ${nodePattern} \\(pid ${other.pid}\\)`));
      other.kill('SIGKILL');
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

  it('status does not vouch for the build of an app it did not start', { skip: !hasLsof }, async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/health`;
    const own = appUp(port);
    assert.equal(own.status, 0, own.stdout + own.stderr);
    assert.doesNotMatch(status(port).stdout, /not this project's/);
    // The recorded app is gone, and something else now answers on the same port with a stale build file left behind.
    appStop();
    await waitGone(url);
    const other = stray(port);
    await waitFor(url);
    writeFileSync(join(work, 'reports', 'stack', 't.build'), 'abc1234\n');
    const theirs = status(port);
    assert.match(
      theirs.stdout,
      new RegExp(`build     not this project's: port ${port} is held by ${nodePattern} \\(pid ${other.pid}\\)`),
    );
    assert.ok(!theirs.stdout.includes('abc1234'), theirs.stdout);
    other.kill('SIGKILL');
  });

  it('status does not vouch for a build when its app died and another took the port', { skip: !hasLsof }, async () => {
    // The pid and build files survive a crash: the recorded pid is dead, and another checkout's app holds the port.
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/health`;
    const own = appUp(port);
    assert.equal(own.status, 0, own.stdout + own.stderr);
    process.kill(Number(readFileSync(join(work, 'reports', 'stack', 't.pid'), 'utf8')), 'SIGKILL');
    await waitGone(url);
    const other = stray(port);
    await waitFor(url);
    const theirs = status(port);
    assert.match(
      theirs.stdout,
      new RegExp(`build     not this project's: port ${port} is held by ${nodePattern} \\(pid ${other.pid}\\)`),
    );
    const up = appUp(port);
    assert.equal(up.status, 3, up.stdout + up.stderr);
    other.kill('SIGKILL');
  });

  it(
    'status flags its own app from an older checkout as stale, and up then replaces it',
    { skip: !hasLsof },
    async () => {
      // The server is a grandchild of the recorded pid (npm run -> sh -> node) and holds its port 2s after SIGTERM.
      const { repo, head, commit } = checkout('repo');
      const cmd = `bash -c "bash -c 'node ${work}/slow.js; true'; true"`;
      const port = await freePort();
      const started = head();
      const up = appUp(port, { repo, cmd });
      assert.equal(up.status, 0, up.stdout + up.stderr);
      assert.match(status(port, { repo }).stdout, new RegExp(`^build     ${started}$`, 'm'));
      const now = commit();
      const stale = status(port, { repo });
      assert.doesNotMatch(stale.stdout, /not this project's/, stale.stdout);
      assert.match(
        stale.stdout,
        new RegExp(`^build     ${started} \\(stale: the checkout is ${now} now; vgate up restarts it\\)$`, 'm'),
      );
      // And up does what status promised: it replaces the stale app instead of refusing the port.
      const again = appUp(port, { repo, cmd });
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.match(again.stdout, /Starting t/);
      assert.match(status(port, { repo }).stdout, new RegExp(`^build     ${now}$`, 'm'));
      appStop();
      await waitGone(`http://127.0.0.1:${port}/health`);
    },
  );

  it(
    'without lsof, status does not vouch for the build and up restarts rather than reuses',
    { skip: !hasLsof },
    async () => {
      const { repo, head } = checkout('repo-no-lsof');
      const port = await freePort();
      const up = appUp(port, { repo });
      assert.equal(up.status, 0, up.stdout + up.stderr);
      const blind = status(port, { repo, path: noLsof });
      assert.match(
        blind.stdout,
        new RegExp(`^build     ${head()}\\? unverified: vgate cannot see who listens on port ${port}`, 'm'),
        blind.stdout + blind.stderr,
      );
      const again = appUp(port, { repo, path: noLsof });
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.match(again.stdout, /Starting t/);
      assert.doesNotMatch(again.stdout, /already UP/);
    },
  );

  it('down never kills a process that merely reuses the recorded pid', () => {
    // A pid file left from before a reboot: the pid now belongs to an unrelated process with children of its own.
    const unrelated = spawn('bash', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    children.push(unrelated);
    const dir = join(work, 'reports', 'stack');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 't.pid'), `${unrelated.pid}\n`);
    writeFileSync(join(dir, 't.started'), 'Thu Jan  1 00:00:00 1970\n');
    const down = appStop();
    assert.match(down.stdout, /that pid now belongs to a process started later; not killed/, down.stdout);
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0), 'the unrelated process was killed');
    unrelated.kill('SIGKILL');
  });

  it('up names its own previous app when it will not let go of the port', { skip: !hasLsof }, async () => {
    const port = await freePort();
    const cmd = `node "${work}/stubborn.js"`;
    const up = appUp(port, { cmd });
    assert.equal(up.status, 0, up.stdout + up.stderr);
    // Unhealthy now: up must replace it, and the old one ignores SIGTERM.
    writeFileSync(join(work, 'reports', 'stack', 't.build'), 'not-this-build\n');
    const again = run(
      `app_up "http://127.0.0.1:${port}/health" ${port} 10 "${work}" ${cmd}`,
      port,
      {},
      { STACK_RELEASE_SECONDS: '2' },
    );
    assert.equal(again.status, 3, again.stdout + again.stderr);
    assert.match(again.stderr, /its previous app \(pid \d+\) still runs 2s after it was told to stop/);
    assert.doesNotMatch(again.stderr, /did not start/);
    const pid = Number(/pid (\d+)/.exec(again.stderr)![1]);
    process.kill(pid, 'SIGKILL');
  });
});

describe('url_port (framework/stack/lib.sh)', () => {
  const cases: [string, string][] = [
    ['http://localhost:8080/health', '8080'],
    ['https://x.io/a', '443'],
    ['HTTPS://x.io/a', '443'],
    ['http://h', '80'],
    ['http://u:p@h:9/x', '9'],
    ['http://[::1]:7/x', '7'],
    ['http://[::1]/x', '80'],
    ['http://h:8080?a=1', '8080'],
    ['http://h:8080#f', '8080'],
  ];
  for (const [url, port] of cases) {
    it(`${url} -> ${port}`, () => {
      const r = spawnSync('bash', ['-c', `source "${LIB}"; url_port "$1"`, '_', url], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), port);
    });
  }
  it('fails, rather than guessing, on a port that is empty or not a number', () => {
    for (const url of ['http://h:/health', 'http://h:abc/']) {
      const r = spawnSync('bash', ['-c', `set -e; source "${LIB}"; p=$(url_port "$1"); echo "reached $p"`, '_', url], {
        encoding: 'utf8',
      });
      assert.notEqual(r.status, 0, url);
      assert.doesNotMatch(r.stdout, /reached/);
      assert.match(r.stderr, /no port number/);
    }
  });
});

describe('proc_name (framework/stack/lib.sh)', () => {
  function fakeBin(name: string, psOutput: string, psExit = 0): string {
    const dir = join(work, `bin-${name}`);
    mkdirSync(dir, { recursive: true });
    const ps = join(dir, 'ps');
    writeFileSync(ps, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(psOutput)}\nexit ${psExit}\n`);
    chmodSync(ps, 0o755);
    return dir;
  }

  function runProcName(pid: number, procRoot: string, binDir: string) {
    return spawnSync('bash', ['-c', `set -euo pipefail; source "${LIB}"; proc_name "${pid}"`], {
      env: { ...env(), STACK_PROC_ROOT: procRoot, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
  }

  it('prefers /proc/<pid>/exe over the thread name reported by ps comm (Node 24 MainThread on Linux)', () => {
    const procRoot = join(work, 'proc-linux');
    mkdirSync(join(procRoot, '4242'), { recursive: true });
    symlinkSync('/home/user/.nvm/versions/node/v24.22.1/bin/node', join(procRoot, '4242', 'exe'));
    const r = runProcName(4242, procRoot, fakeBin('mainthread', 'MainThread'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'node\n');
  });

  it('strips the Linux (deleted) suffix from /proc/<pid>/exe', () => {
    const procRoot = join(work, 'proc-deleted');
    mkdirSync(join(procRoot, '4243'), { recursive: true });
    symlinkSync('/tmp/build/my-api (deleted)', join(procRoot, '4243', 'exe'));
    const r = runProcName(4243, procRoot, fakeBin('deleted', 'MainThread'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'my-api\n');
  });

  it('falls back to the trimmed basename of ps comm when /proc/<pid>/exe is unavailable', () => {
    const missing = join(work, 'proc-missing');
    const bare = runProcName(4243, missing, fakeBin('bare', '  node  '));
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(bare.stdout, 'node\n');

    const padded = runProcName(4244, missing, fakeBin('padded', '  /opt/homebrew/bin/node  '));
    assert.equal(padded.status, 0, padded.stderr);
    assert.equal(padded.stdout, 'node\n');

    const spaced = runProcName(4245, missing, fakeBin('spaced', '/Applications/My App.app/Contents/MacOS/My App'));
    assert.equal(spaced.status, 0, spaced.stderr);
    assert.equal(spaced.stdout, 'My App\n');
  });

  it('falls back cleanly under set -euo pipefail when neither /proc nor ps can name the process', () => {
    const missing = join(work, 'proc-gone');
    const binDir = fakeBin('gone', '', 1);
    const r = runProcName(4246, missing, binDir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '\n');

    const holder = spawnSync(
      'bash',
      ['-c', `set -euo pipefail; source "${LIB}"; port_pid() { echo 4246; }; port_holder 9999`],
      {
        env: { ...env(), STACK_PROC_ROOT: missing, PATH: `${binDir}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    );
    assert.equal(holder.status, 0, holder.stderr);
    assert.equal(holder.stdout, 'a process (pid 4246)\n');
  });
});

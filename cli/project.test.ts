import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { UsageError } from './output.ts';
import { capture, findRoot, listServices, requireRoot, resolveService } from './project.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'vgate-project-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A project directory with the given services; `bare` ones are directories without a service.yaml. */
function project(name: string, services: string[], bare: string[] = []): string {
  const root = join(scratch, name);
  mkdirSync(join(root, 'framework'), { recursive: true });
  writeFileSync(join(root, 'framework', 'config.ts'), '');
  mkdirSync(join(root, 'services'), { recursive: true });
  for (const service of services) {
    mkdirSync(join(root, 'services', service), { recursive: true });
    writeFileSync(join(root, 'services', service, 'service.yaml'), `name: ${service}\n`);
  }
  for (const dir of bare) mkdirSync(join(root, 'services', dir), { recursive: true });
  return root;
}

describe('findRoot', () => {
  it('finds the project from the root itself and from a directory deep inside it', () => {
    const root = project('find', ['notes']);
    const deep = join(root, 'services', 'notes', 'tests', 'deep');
    mkdirSync(deep, { recursive: true });
    assert.equal(findRoot(root), root);
    assert.equal(findRoot(deep), root);
  });

  it('needs both framework/config.ts and services/', () => {
    const half = join(scratch, 'half');
    mkdirSync(join(half, 'services'), { recursive: true });
    assert.equal(findRoot(half), undefined);
  });

  it('is undefined where no parent is a project', () => {
    const outside = join(scratch, 'outside', 'deeper');
    mkdirSync(outside, { recursive: true });
    assert.equal(findRoot(outside), undefined);
  });
});

describe('requireRoot', () => {
  it('returns the project of the given directory', () => {
    const root = project('require', ['notes']);
    assert.equal(requireRoot(join(root, 'services')), root);
  });

  it('rejects a directory outside any project, naming it', () => {
    const outside = join(scratch, 'no-project');
    mkdirSync(outside, { recursive: true });
    assert.throws(
      () => requireRoot(outside),
      (error: unknown) => error instanceof UsageError && error.message.includes(outside),
    );
  });
});

describe('listServices', () => {
  it('lists the directories that hold a service.yaml, sorted', () => {
    const root = project('list', ['zeta', 'alpha', 'mid'], ['drafts']);
    writeFileSync(join(root, 'services', 'README.md'), 'not a service');
    assert.deepEqual(listServices(root), ['alpha', 'mid', 'zeta']);
  });

  it('is empty for a project without services', () => {
    assert.deepEqual(listServices(project('none', [])), []);
  });
});

describe('resolveService', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.SERVICE;
    delete process.env.SERVICE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SERVICE;
    else process.env.SERVICE = saved;
  });

  const several = project('several', ['alpha', 'beta']);
  const sole = project('sole', ['only']);

  it('takes the flag before the SERVICE variable', () => {
    process.env.SERVICE = 'alpha';
    assert.equal(resolveService(several, 'beta'), 'beta');
  });

  it('takes the SERVICE variable when there is no flag', () => {
    process.env.SERVICE = 'alpha';
    assert.equal(resolveService(several, undefined), 'alpha');
  });

  it('defaults to the only service there is', () => {
    assert.equal(resolveService(sole, undefined), 'only');
  });

  it('never picks one of several: it asks, naming them', () => {
    assert.throws(
      () => resolveService(several, undefined),
      (error: unknown) => error instanceof UsageError && error.message.includes('alpha, beta'),
    );
  });

  it('rejects a service the project does not have, from the flag or the variable', () => {
    assert.throws(
      () => resolveService(several, 'gamma'),
      (error: unknown) => error instanceof UsageError && /"gamma".*alpha, beta/.test(error.message),
    );
    process.env.SERVICE = 'gamma';
    assert.throws(() => resolveService(sole, undefined), UsageError);
  });
});

describe('capture', () => {
  it('returns the exit code and what the program printed on both streams', () => {
    const run = capture(process.execPath, ['-e', 'console.log("out"); console.error("err"); process.exit(4)']);
    assert.equal(run.code, 4);
    assert.equal(run.missing, false);
    assert.match(run.out, /out/);
    assert.match(run.out, /err/);
  });

  it('flags a program that is not on PATH instead of throwing', () => {
    const run = capture('vgate-no-such-program', []);
    assert.equal(run.missing, true);
    assert.equal(run.code, null);
  });
});

/**
 * The portable layout: a project is a directory with vgate.yaml, the runtime lives elsewhere, the pin decides which
 * vgate may judge, and `init` writes a project idempotently.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { readProject } from '../framework/project.ts';
import { AGENT_SECTION, applyPlanned, planInit, type InitInput } from './init.ts';
import { UsageError } from './output.ts';
import { findRoot } from './project.ts';
import { bundleRuntime, hashFiles, linkProject, RUNTIME_PATHS, type Runtime } from './runtime.ts';
import { checkPin } from './version.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'vgate-portable-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
const repo = resolve(import.meta.dirname, '..');

function dir(...parts: string[]): string {
  const path = join(scratch, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

describe('readProject', () => {
  it('reads version, servicesDir and reportsDir, defaulting to regression/ and reports/', () => {
    const root = dir('read');
    writeFileSync(join(root, 'vgate.yaml'), 'version: 1.2.3\n');
    const project = readProject(root);
    assert.equal(project.version, '1.2.3');
    assert.equal(project.servicesDir, join(root, 'regression'));
    assert.equal(project.reportsDir, join(root, 'reports'));
    assert.equal(project.declared, true);
  });

  it('keeps the old layout (services/, reports/) without a vgate.yaml', () => {
    const project = readProject(dir('legacy'));
    assert.equal(project.servicesDirName, 'services');
    assert.equal(project.declared, false);
  });

  it('refuses a services directory outside the project', () => {
    const root = dir('escape');
    writeFileSync(join(root, 'vgate.yaml'), 'servicesDir: ../elsewhere\n');
    assert.throws(() => readProject(root), /inside the project/);
  });
});

describe('findRoot with vgate.yaml', () => {
  it('finds the nearest vgate.yaml from deep inside the project', () => {
    const root = dir('found');
    writeFileSync(join(root, 'vgate.yaml'), 'version: 1.0.0\n');
    assert.equal(findRoot(dir('found', 'regression', 'api', 'tests')), root);
  });
});

describe('checkPin', () => {
  const project = (version?: string) => ({ ...readProject(dir('pin')), version });

  it('accepts the pinned version and refuses another, naming the install command of the pinned one', () => {
    assert.equal(checkPin(project('1.2.3'), '1.2.3').state, 'ok');
    const mismatch = checkPin(project('1.2.3'), '1.3.0');
    assert.equal(mismatch.state, 'mismatch');
    assert.match(mismatch.fix ?? '', /install\.sh \| VGATE_VERSION=1\.2\.3 sh$/);
  });

  it('lets a development build run anything, and calls an unpinned project out', () => {
    assert.equal(checkPin(project('1.2.3'), 'dev').state, 'dev');
    assert.equal(checkPin(project(undefined), '1.2.3').state, 'unpinned');
  });

  // Only in the framework's checkout: an extracted runtime carries no vgate.yaml of its own.
  const checkout = existsSync(join(repo, 'vgate.yaml'));
  it(
    "holds this repository's own pin to its package version, so a binary built here runs here",
    { skip: !checkout },
    () => {
      const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string };
      assert.equal(readProject(repo).version, version);
    },
  );
});

describe('the runtime bundle', () => {
  it('carries the framework, the CLI and the configs, and nothing installed or built', () => {
    const files = bundleRuntime(repo);
    for (const entry of RUNTIME_PATHS)
      assert.ok(
        Object.keys(files).some((path) => path.startsWith(entry)),
        entry,
      );
    assert.ok(files['framework/package.json'], 'the @vgate/framework package manifest');
    assert.ok(!Object.keys(files).some((path) => /(^|\/)(node_modules|\.DS_Store|services)(\/|$)/.test(path)));
  });

  it('hashes content and paths, so a changed file is another runtime', () => {
    assert.equal(hashFiles({ a: '1', b: '2' }), hashFiles({ b: '2', a: '1' }));
    assert.notEqual(hashFiles({ a: '1' }), hashFiles({ a: '2' }));
    assert.notEqual(hashFiles({ a: '1' }), hashFiles({ b: '1' }));
  });
});

describe('linkProject', () => {
  const runtime = (root: string): Runtime => ({ mode: 'embedded', root, packageVersion: '1.0.0' });

  it('links <servicesDir>/node_modules to the runtime and writes the generated tsconfig, idempotently', () => {
    const rt = dir('rt', 'runtime');
    mkdirSync(join(rt, 'node_modules'), { recursive: true });
    const root = dir('linked');
    writeFileSync(join(root, 'vgate.yaml'), 'servicesDir: regression\n');
    const project = readProject(root);
    const first = linkProject(project, runtime(rt));
    assert.ok(first.ok);
    const link = join(root, 'regression', 'node_modules');
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), join(rt, 'node_modules'));
    const tsconfig = JSON.parse(readFileSync(join(root, 'regression', 'tsconfig.json'), 'utf8')) as { extends: string };
    assert.equal(tsconfig.extends, join(rt, 'tsconfig.json'));
    const manifest = JSON.parse(readFileSync(join(root, 'regression', 'package.json'), 'utf8')) as { type: string };
    assert.equal(manifest.type, 'module', 'the tests are ES modules, like the framework they import');
    assert.deepEqual(linkProject(project, runtime(rt)).actions, []);
  });

  it("refuses to replace a project's own node_modules or tsconfig.json", () => {
    const root = dir('owned');
    writeFileSync(join(root, 'vgate.yaml'), 'servicesDir: regression\n');
    mkdirSync(join(root, 'regression', 'node_modules'), { recursive: true });
    const result = linkProject(readProject(root), runtime(dir('rt2')));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /real directory/);
  });

  it('removes what a binary run generated when the project is the runtime itself', () => {
    const root = dir('self');
    const project = readProject(root);
    mkdirSync(project.servicesDir, { recursive: true });
    linkProject(project, runtime(dir('rt3')));
    const result = linkProject(project, runtime(root));
    assert.ok(result.ok);
    assert.equal(existsSync(join(project.servicesDir, 'tsconfig.json')), false);
    assert.equal(existsSync(join(project.servicesDir, 'node_modules')), false);
    assert.equal(existsSync(join(project.servicesDir, 'package.json')), false);
  });
});

describe('init', () => {
  const input = (root: string, extra: Partial<InitInput> = {}): InitInput => ({
    root,
    version: '1.0.0',
    service: 'api',
    servicesDir: 'regression',
    reportsDir: 'reports',
    writeProjectFile: true,
    agentFiles: [],
    ...extra,
  });

  it('plans vgate.yaml, the service skeleton, the .gitignore lines, agent pointers and CI files', () => {
    const paths = planInit(
      input('/x', { agentFiles: ['AGENTS.md'], ci: { '.github/workflows/vgate.yml': 'on: push\n' } }),
    ).map((p) => p.path);
    for (const path of [
      'vgate.yaml',
      'regression/api/service.yaml',
      'regression/api/openapi.yaml',
      'regression/api/inventory.yaml',
      'regression/api/support/fixtures.ts',
      'regression/api/tests/health.spec.ts',
      'regression/api/stack.sh',
      '.gitignore',
      'AGENTS.md',
      '.github/workflows/vgate.yml',
    ])
      assert.ok(paths.includes(path), path);
    assert.ok(!planInit(input('/x', { writeProjectFile: false })).some((p) => p.path === 'vgate.yaml'));
  });

  it('refuses a service name that is not lower-case letters, digits and dashes', () => {
    assert.throws(() => planInit(input('/x', { service: 'My Api' })), UsageError);
  });

  it('writes once, changes nothing the second time, keeps a different file without --force, overwrites with it', () => {
    const root = dir('init');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n\nBe careful.');
    const plan = planInit(input(root, { agentFiles: ['AGENTS.md'] }));
    const results = plan.map((planned) => applyPlanned(root, planned, false));
    assert.deepEqual(results.slice(0, 7), Array(7).fill('created'));
    assert.deepEqual(
      plan.map((planned) => applyPlanned(root, planned, false)),
      Array(plan.length).fill('unchanged'),
    );

    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    assert.ok(agents.startsWith('# Agents\n\nBe careful.\n'), 'the original text is kept');
    assert.equal(agents.split(AGENT_SECTION).length, 2, 'the section is appended once');
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
    assert.ok(ignore.includes('node_modules/') && ignore.includes('regression/node_modules'));

    const service = plan.find((planned) => planned.path.endsWith('service.yaml'));
    assert.ok(service);
    writeFileSync(join(root, service.path), 'name: mine\n');
    assert.equal(applyPlanned(root, service, false), 'skipped');
    assert.equal(readFileSync(join(root, service.path), 'utf8'), 'name: mine\n');
    assert.equal(applyPlanned(root, service, true), 'overwritten');
    assert.equal(readFileSync(join(root, service.path), 'utf8'), service.content);
  });
});

describe('README conciseness budget', () => {
  const readmePath = join(repo, 'README.md');
  const skipIfUnpacked = existsSync(readmePath) ? false : 'README.md is not unpacked into a project runtime';

  it('stays concise (<= 130 lines and <= 850 words)', { skip: skipIfUnpacked }, () => {
    const text = readFileSync(readmePath, 'utf8');
    const lines = text.trimEnd().split('\n').length;
    const words = text.trim().split(/\s+/).length;
    assert.ok(lines <= 130, `README.md is ${lines} lines (budget: <= 130); move details into docs/`);
    assert.ok(words <= 850, `README.md is ${words} words (budget: <= 850); keep top-level README focused`);
  });
});

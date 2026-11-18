import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { UsageError } from './output.ts';
import { describeSkill, readSkills, skills, type Bundle } from './skills.ts';

const scratch = mkdtempSync(join(tmpdir(), 'vgate-skills-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const SKILL_MD = '---\nname: make-tests\ndescription: Writes the tests of a service.\n---\n\n# Make tests\n';

describe('readSkills', () => {
  const source = join(scratch, 'source');
  write(join(source, 'make-tests', 'SKILL.md'), SKILL_MD);
  write(join(source, 'make-tests', 'references', 'format.md'), 'the format\n');
  write(join(source, 'make-tests', 'evals', 'evals.json'), '{}');
  write(join(source, 'make-tests', '.DS_Store'), 'junk');
  write(join(source, 'make-tests', 'references', '.hidden'), 'junk');
  write(join(source, 'make-tests-workspace', 'iteration-1', 'review.html'), '<html>');
  write(join(source, 'README.md'), 'not a skill');

  it('keeps SKILL.md and references, leaves out evals/ and dotfiles', () => {
    assert.deepEqual(readSkills(source), {
      'make-tests': { 'SKILL.md': SKILL_MD, 'references/format.md': 'the format\n' },
    });
  });

  it('takes only directories that hold a SKILL.md for skills', () => {
    assert.deepEqual(Object.keys(readSkills(source)), ['make-tests']);
  });

  it('is empty for a directory that does not exist', () => {
    assert.deepEqual(readSkills(join(scratch, 'nowhere')), {});
  });
});

describe('describeSkill', () => {
  it('reads the description of the frontmatter', () => {
    assert.equal(describeSkill(SKILL_MD), 'Writes the tests of a service.');
  });

  it('reads a folded description as one trimmed text', () => {
    assert.equal(
      describeSkill('---\nname: x\ndescription: >\n  Writes tests\n  for a service.\n---\n'),
      'Writes tests for a service.',
    );
  });

  it('is empty without frontmatter or without a description', () => {
    assert.equal(describeSkill('# Make tests\n'), '');
    assert.equal(describeSkill('---\nname: x\n---\n'), '');
  });
});

describe('skills', () => {
  const bundle: Bundle = {
    'make-tests': { 'SKILL.md': SKILL_MD, 'references/format.md': 'the format\n' },
    'sync-tests': { 'SKILL.md': '---\nname: sync-tests\ndescription: Keeps the tests in step.\n---\n' },
  };
  type Row = { skill: string; state?: string; result?: string; files?: number; description?: string };
  const rows = (data: unknown) => (data as { skills: Row[] }).skills;
  const run = (dir: string, action: string | undefined, names: string[] = [], dryRun = false) =>
    skills({ action, names, dir, dryRun }, bundle);

  it('lists every skill as absent before anything is installed, and points at install', () => {
    const dir = join(scratch, 'list-empty');
    const result = run(dir, 'list');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      rows(result.data).map((row) => [row.skill, row.state, row.description]),
      [
        ['make-tests', 'absent', 'Writes the tests of a service.'],
        ['sync-tests', 'absent', 'Keeps the tests in step.'],
      ],
    );
    assert.deepEqual(result.next, ['vgate skills install']);
    assert.ok(!existsSync(dir), 'list writes nothing');
  });

  it('installs the files, then finds nothing to change', () => {
    const dir = join(scratch, 'install');
    const first = run(dir, 'install');
    assert.deepEqual(
      rows(first.data).map((row) => [row.skill, row.result, row.files]),
      [
        ['make-tests', 'installed', 2],
        ['sync-tests', 'installed', 1],
      ],
    );
    assert.equal(readFileSync(join(dir, 'make-tests', 'SKILL.md'), 'utf8'), SKILL_MD);
    assert.equal(readFileSync(join(dir, 'make-tests', 'references', 'format.md'), 'utf8'), 'the format\n');
    assert.ok(existsSync(join(dir, 'sync-tests', 'SKILL.md')));

    const second = run(dir, 'install');
    assert.deepEqual(
      rows(second.data).map((row) => row.result),
      ['unchanged', 'unchanged'],
    );
    const listed = run(dir, 'list');
    assert.deepEqual(
      rows(listed.data).map((row) => row.state),
      ['current', 'current'],
    );
    assert.deepEqual(listed.next, []);
  });

  it('sees an edited file as outdated and restores it on install', () => {
    const dir = join(scratch, 'outdated');
    run(dir, 'install');
    const edited = join(dir, 'make-tests', 'references', 'format.md');
    writeFileSync(edited, 'changed by hand\n');

    assert.deepEqual(
      rows(run(dir, 'list').data).map((row) => row.state),
      ['outdated', 'current'],
    );
    assert.deepEqual(
      rows(run(dir, 'install').data).map((row) => row.result),
      ['updated', 'unchanged'],
    );
    assert.equal(readFileSync(edited, 'utf8'), 'the format\n');
  });

  it('sees a deleted file as outdated', () => {
    const dir = join(scratch, 'deleted');
    run(dir, 'install');
    rmSync(join(dir, 'make-tests', 'references', 'format.md'));
    assert.equal(rows(run(dir, 'list', ['make-tests']).data)[0].state, 'outdated');
  });

  it('writes nothing on a dry run, and says what would change', () => {
    const dir = join(scratch, 'dry-run');
    const result = run(dir, 'install', [], true);
    assert.deepEqual(
      rows(result.data).map((row) => row.result),
      ['installed', 'installed'],
    );
    assert.match(result.summary, /^Dry run: 2 of 2/);
    assert.ok(!existsSync(dir));
  });

  it('acts on the named skills only', () => {
    const dir = join(scratch, 'named');
    const result = run(dir, 'install', ['sync-tests']);
    assert.deepEqual(
      rows(result.data).map((row) => row.skill),
      ['sync-tests'],
    );
    assert.ok(existsSync(join(dir, 'sync-tests', 'SKILL.md')));
    assert.ok(!existsSync(join(dir, 'make-tests')));
  });

  it('rejects a skill it does not carry, naming the ones it does', () => {
    assert.throws(
      () => run(join(scratch, 'unknown'), 'install', ['no-such-skill']),
      (error: unknown) => error instanceof UsageError && /no-such-skill.*make-tests, sync-tests/.test(error.message),
    );
  });

  it('rejects an action it does not know', () => {
    assert.throws(() => run(join(scratch, 'action'), 'remove'), UsageError);
    assert.throws(() => run(join(scratch, 'action'), undefined), UsageError);
  });
});

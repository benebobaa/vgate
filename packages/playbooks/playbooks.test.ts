import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BANNED_EVAL_WORDS,
  auditTranscriptAdherence,
  buildBlindedJudgePrompt,
  checkBlindingLeaks,
  filterBundleByPacks,
  listPackCatalog,
  organicWorkspaceName,
  parseJudgeResponse,
  parseSkillMeta,
  readCanonicalSkills,
  runBlindedEval,
  type AgentExecutor,
  type EvalSpec,
} from './index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

const EXPECTED_CORE = [
  'vgate-automate',
  'vgate-bugfix',
  'vgate-correct',
  'vgate-maintain',
  'vgate-refactor',
  'vgate-verify',
];

const EXPECTED_RIGOR = ['vgate-formal'];

const EXPECTED_SCALE = ['vgate-ship'];

const scratch = mkdtempSync(join(tmpdir(), 'vgate-playbooks-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('canonical skills and pack catalog', () => {
  const bundle = readCanonicalSkills(SKILLS_DIR);

  it('loads all 8 lean namespaced vgate-* canonical skills with valid frontmatter and pack tags', () => {
    const names = Object.keys(bundle).sort();
    assert.equal(names.length, 8);
    for (const name of names) {
      assert.ok(name.startsWith('vgate-'), `canonical skill must be namespaced vgate-*, got ${name}`);
      const skillMd = bundle[name]['SKILL.md'];
      assert.equal(typeof skillMd, 'string');
      const meta = parseSkillMeta(name, skillMd);
      assert.equal(meta.name, name);
      assert.ok(meta.description.length > 10, `description too short for ${name}`);
      assert.ok(['core', 'rigor', 'scale'].includes(meta.pack), `invalid pack for ${name}`);
    }
  });

  it('categorizes skills accurately in listPackCatalog', () => {
    const catalog = listPackCatalog(bundle);
    assert.deepEqual(
      catalog.core.map((s) => s.name),
      EXPECTED_CORE,
    );
    assert.deepEqual(
      catalog.rigor.map((s) => s.name),
      EXPECTED_RIGOR,
    );
    assert.deepEqual(
      catalog.scale.map((s) => s.name),
      EXPECTED_SCALE,
    );
  });

  it('filters bundles by core, rigor, scale, combinations, and full', () => {
    assert.deepEqual(Object.keys(filterBundleByPacks(bundle, ['core'])), EXPECTED_CORE);
    assert.deepEqual(Object.keys(filterBundleByPacks(bundle, ['rigor'])), EXPECTED_RIGOR);
    assert.deepEqual(Object.keys(filterBundleByPacks(bundle, ['scale'])), EXPECTED_SCALE);
    assert.equal(Object.keys(filterBundleByPacks(bundle, ['core', 'rigor'])).length, 7);
    assert.equal(Object.keys(filterBundleByPacks(bundle, ['full'])).length, 8);
  });

  it('rejects invalid frontmatter or missing pack', () => {
    assert.throws(() => parseSkillMeta('broken', '# No frontmatter\n'), /missing YAML frontmatter/i);
    assert.throws(
      () => parseSkillMeta('bad-pack', '---\nname: bad-pack\ndescription: Valid desc\npack: unknown\n---\n'),
      /invalid frontmatter "pack"/i,
    );
  });
});

describe('blinding leak detection and organic workspace names', () => {
  it('catches every banned word across workspaceName, prompt, and fileNames (case-insensitive)', () => {
    for (const word of BANNED_EVAL_WORDS) {
      const upper = word.toUpperCase();
      const wsLeaks = checkBlindingLeaks({
        workspaceName: `acme-${upper}-1234`,
        prompt: 'Fix cart totals',
        fileNames: [],
      });
      assert.ok(
        wsLeaks.some((leak) => leak.includes(`"${word}"`) && leak.startsWith('workspaceName:')),
        `expected workspaceName leak for ${word}`,
      );

      const promptLeaks = checkBlindingLeaks({
        workspaceName: 'acme-cart-fix-1234',
        prompt: `Please ${word} the checkout handler.`,
        fileNames: [],
      });
      assert.ok(
        promptLeaks.some((leak) => leak.includes(`"${word}"`) && leak.startsWith('prompt:')),
        `expected prompt leak for ${word}`,
      );

      const fileLeaks = checkBlindingLeaks({
        workspaceName: 'acme-cart-fix-1234',
        prompt: 'Fix cart totals',
        fileNames: [`src/my_${word}_helper.ts`],
      });
      assert.ok(
        fileLeaks.some((leak) => leak.includes(`"${word}"`) && leak.includes(`my_${word}_helper.ts`)),
        `expected fileName leak for ${word}`,
      );
    }
  });

  it('does not false-positive on clean substrings like latest or contest', () => {
    const leaks = checkBlindingLeaks({
      workspaceName: 'acme-checkout-fix-4821',
      prompt: 'Update the latest invoice totals and resolve contestable rounding.',
      fileNames: ['src/latest-invoice.ts', 'src/rounding.ts'],
    });
    assert.deepEqual(leaks, []);
  });

  it('generates organic workspace names with zero blinding leaks', () => {
    for (let i = 0; i < 30; i += 1) {
      const seeded = organicWorkspaceName(`seed-${i}`);
      assert.match(seeded, /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
      assert.deepEqual(checkBlindingLeaks({ workspaceName: seeded, prompt: '', fileNames: [] }), []);
    }
    const randomName = organicWorkspaceName();
    assert.match(randomName, /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
    assert.deepEqual(checkBlindingLeaks({ workspaceName: randomName, prompt: '', fileNames: [] }), []);
    assert.equal(organicWorkspaceName('deterministic-seed'), organicWorkspaceName('deterministic-seed'));
  });
});

describe('transcript adherence auditing', () => {
  it('never trusts prose claims when files were not actually opened', () => {
    const proseOnly = [
      'I carefully read skills/ship/SKILL.md and followed every single instruction in it.',
      'Per skills/deslop/SKILL.md, I deleted the dead helper.',
    ].join('\n');

    const audit = auditTranscriptAdherence(proseOnly, ['skills/ship/SKILL.md', 'skills/deslop/SKILL.md']);
    assert.equal(audit.adhered, false);
    assert.deepEqual(audit.opened, []);
    assert.deepEqual(audit.missing, ['skills/ship/SKILL.md', 'skills/deslop/SKILL.md']);
  });

  it('accepts explicit openedFiles telemetry and structured tool read traces', () => {
    const transcript = [
      '[tool:read_file] /tmp/acme-checkout-fix-1234/skills/ship/SKILL.md',
      '{"tool":"read_file","arguments":{"path":"./skills/deslop/SKILL.md"}}',
      'Applied the cleanup.',
    ].join('\n');

    const audit = auditTranscriptAdherence(
      transcript,
      ['skills/ship/SKILL.md', 'skills/deslop/SKILL.md', 'src/cart.ts'],
      ['/tmp/acme-checkout-fix-1234/src/cart.ts'],
    );
    assert.equal(audit.adhered, true);
    assert.deepEqual(audit.opened, ['skills/ship/SKILL.md', 'skills/deslop/SKILL.md', 'src/cart.ts']);
    assert.deepEqual(audit.missing, []);
  });
});

describe('blinded judge prompt, parsing, and end-to-end runBlindedEval', () => {
  const fixtureDir = join(scratch, 'fixture-repo');
  mkdirSync(join(fixtureDir, 'src'), { recursive: true });
  writeFileSync(
    join(fixtureDir, 'src', 'tax.ts'),
    'export function calcTax(amount: number): number { return amount * 0.1; }\n',
  );

  const skillAlphaDir = join(scratch, 'skill-alpha');
  mkdirSync(skillAlphaDir, { recursive: true });
  writeFileSync(
    join(skillAlphaDir, 'SKILL.md'),
    '---\nname: alpha-guide\ndescription: Minimal fix guidance.\npack: core\n---\n\n# Alpha\n',
  );

  const skillBetaDir = join(scratch, 'skill-beta');
  mkdirSync(skillBetaDir, { recursive: true });
  writeFileSync(
    join(skillBetaDir, 'SKILL.md'),
    '---\nname: beta-guide\ndescription: Thorough fix guidance.\npack: core\n---\n\n# Beta\n',
  );

  const baseSpec: EvalSpec = {
    id: 'tax-rounding-01',
    taskPrompt: 'Fix rounding precision in src/tax.ts so cent values round half-up accurately.',
    fixtureDir,
    expectedOpenedFiles: ['src/tax.ts'],
    rubric: [
      { criterion: 'correctness', weight: 2, description: 'Accurately handles decimal cent rounding.' },
      { criterion: 'simplicity', weight: 1, description: 'Minimal, readable change with zero dead code.' },
      { criterion: 'safety', weight: 1, description: 'Handles zero and negative boundary inputs cleanly.' },
    ],
    variants: [
      { id: 'variant-minimal', label: 'Minimal Alpha', skillDir: skillAlphaDir, harness: 'codex', model: 'model-a' },
      { id: 'variant-thorough', label: 'Thorough Beta', skillDir: skillBetaDir, harness: 'claude', model: 'model-b' },
    ],
    judge: { harness: 'judge-harness', model: 'cross-family-judge' },
  };

  it('strips variant IDs, labels, and skill paths from blinded judge prompts and parses JSON responses', () => {
    const prompt = buildBlindedJudgePrompt(baseSpec, [
      {
        blindLabel: 'Option A',
        output: `Implemented using variant-minimal from ${skillAlphaDir} (Minimal Alpha).`,
        diff: '+export const rounded = Math.round(v * 100) / 100;',
      },
      {
        blindLabel: 'Option B',
        output: `Implemented using variant-thorough from ${skillBetaDir} (Thorough Beta).`,
        diff: '+export const rounded = Number(v.toFixed(2));',
      },
    ]);

    assert.ok(!prompt.includes('variant-minimal'));
    assert.ok(!prompt.includes('variant-thorough'));
    assert.ok(!prompt.includes('Minimal Alpha'));
    assert.ok(!prompt.includes('Thorough Beta'));
    assert.ok(!prompt.includes(skillAlphaDir));
    assert.ok(!prompt.includes(skillBetaDir));
    assert.ok(prompt.includes('Option A'));
    assert.ok(prompt.includes('Option B'));

    const parsed = parseJudgeResponse(
      'Here is my verdict:\n```json\n{"Option A":{"scores":{"correctness":9,"simplicity":8,"safety":9},"total":26,"rationale":"Clean and exact."},"Option B":{"scores":{"correctness":7,"simplicity":7,"safety":6},"total":20,"rationale":"toFixed edge cases."}}\n```',
      ['Option A', 'Option B'],
    );
    assert.equal(parsed['Option A'].total, 26);
    assert.equal(parsed['Option B'].total, 20);
  });

  it('rejects specs with fewer than 3 or more than 6 rubric criteria and rejects blinding leaks', async () => {
    const noopExecutor: AgentExecutor = () =>
      Promise.resolve({
        ok: true,
        stdout: '{}',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      });

    await assert.rejects(
      () => runBlindedEval({ ...baseSpec, rubric: baseSpec.rubric.slice(0, 2) }, noopExecutor),
      /between 3 and 6 criteria/i,
    );

    await assert.rejects(
      () =>
        runBlindedEval(
          { ...baseSpec, taskPrompt: 'This is a benchmark experiment to score candidate solutions.' },
          noopExecutor,
          { workRoot: join(scratch, 'leak-work'), reportsDir: join(scratch, 'leak-reports') },
        ),
      /Blinding leak\(s\) detected/i,
    );
  });

  it('runs full blinded flow end-to-end, maps labels back, and writes JSON + Markdown reports', async () => {
    const workRoot = join(scratch, 'e2e-work');
    const reportsDir = join(scratch, 'e2e-reports');
    const seenWorkspaces: string[] = [];
    let capturedJudgePrompt = '';

    const mockExecutor: AgentExecutor = ({ harness, prompt, cwd }) => {
      return Promise.resolve().then(() => {
        if (harness === 'judge-harness') {
          capturedJudgePrompt = prompt;
          const optionASection = prompt.split('## Option A')[1]?.split('## Option B')[0] ?? '';
          const optionAHasBetterFix = optionASection.includes('Number.EPSILON');
          const response = optionAHasBetterFix
            ? {
                'Option A': {
                  scores: { correctness: 10, simplicity: 9, safety: 9 },
                  total: 28,
                  rationale: 'Handles IEEE 754 edge cases cleanly.',
                },
                'Option B': {
                  scores: { correctness: 7, simplicity: 8, safety: 7 },
                  total: 22,
                  rationale: 'Basic rounding without epsilon guard.',
                },
              }
            : {
                'Option A': {
                  scores: { correctness: 7, simplicity: 8, safety: 7 },
                  total: 22,
                  rationale: 'Basic rounding without epsilon guard.',
                },
                'Option B': {
                  scores: { correctness: 10, simplicity: 9, safety: 9 },
                  total: 28,
                  rationale: 'Handles IEEE 754 edge cases cleanly.',
                },
              };
          return {
            ok: true,
            stdout: JSON.stringify(response),
            stderr: '',
            exitCode: 0,
            durationMs: 15,
          };
        }

        seenWorkspaces.push(cwd);
        const targetFile = join(cwd, 'src', 'tax.ts');
        if (harness === 'claude') {
          writeFileSync(
            targetFile,
            'export function calcTax(amount: number): number { return Math.round((amount * 0.1 + Number.EPSILON) * 100) / 100; }\n',
          );
          return {
            ok: true,
            stdout: '[tool:read_file] src/tax.ts\nUpdated tax calculation with epsilon rounding.',
            stderr: '',
            exitCode: 0,
            openedFiles: [targetFile],
            durationMs: 42,
          };
        }

        writeFileSync(
          targetFile,
          'export function calcTax(amount: number): number { return Math.round(amount * 10) / 100; }\n',
        );
        return {
          ok: true,
          stdout: 'Updated tax calculation.',
          stderr: '',
          exitCode: 0,
          durationMs: 25,
        };
      });
    };

    const report = await runBlindedEval(baseSpec, mockExecutor, { workRoot, reportsDir });

    assert.equal(seenWorkspaces.length, 2);
    assert.notEqual(seenWorkspaces[0], seenWorkspaces[1]);
    assert.ok(!capturedJudgePrompt.includes('variant-minimal'));
    assert.ok(!capturedJudgePrompt.includes('variant-thorough'));
    assert.ok(!capturedJudgePrompt.includes('Minimal Alpha'));
    assert.ok(!capturedJudgePrompt.includes('Thorough Beta'));

    assert.equal(report.winner, 'variant-thorough');
    assert.deepEqual(report.rankings, ['variant-thorough', 'variant-minimal']);
    assert.deepEqual(report.blindingLeaks, []);

    const thorough = report.variants.find((v) => v.id === 'variant-thorough');
    const minimal = report.variants.find((v) => v.id === 'variant-minimal');
    assert.ok(thorough && minimal);
    assert.equal(thorough.total, 28);
    assert.equal(thorough.adherence.adhered, true);
    assert.equal(minimal.total, 22);
    assert.equal(minimal.adherence.adhered, false);
    assert.deepEqual(minimal.adherence.missing, ['src/tax.ts']);

    assert.equal(report.blindMapping[thorough.blindLabel], 'variant-thorough');
    assert.equal(report.blindMapping[minimal.blindLabel], 'variant-minimal');

    assert.ok(existsSync(report.reportPaths.json));
    assert.ok(existsSync(report.reportPaths.markdown));
    const persistedJson = JSON.parse(readFileSync(report.reportPaths.json, 'utf8')) as { winner: string };
    assert.equal(persistedJson.winner, 'variant-thorough');
    const persistedMd = readFileSync(report.reportPaths.markdown, 'utf8');
    assert.ok(persistedMd.includes('# Blinded Skill Report: tax-rounding-01'));
    assert.ok(persistedMd.includes('variant-thorough'));
  });
});

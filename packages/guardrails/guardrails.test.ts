import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_IGNORE,
  GUARDRAILS_FILE,
  RATCHET_FILE,
  analyzeComments,
  extractImports,
  guardrailsConfigRule,
  loadGuardrails,
  parseGuardrails,
  ratchetBaselineRule,
  readRatchetBaseline,
  runGuardrails,
  stripComments,
  type RatchetBaseline,
} from './index.ts';

function withTempRepo(files: Record<string, string>, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'vgate-guardrails-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(root, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeRepoFile(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

describe('guardrails config', () => {
  it('parses defaults for empty YAML', () => {
    const cfg = parseGuardrails('');
    assert.deepEqual(cfg.boundaries, []);
    assert.deepEqual(cfg.bannedPatterns, []);
    assert.deepEqual(cfg.nativeLinters, []);
    assert.equal(cfg.ratchetFile, RATCHET_FILE);
    assert.deepEqual(cfg.ignore, [...DEFAULT_IGNORE]);
    assert.equal(cfg.ruleTable?.file, 'AGENTS.md');
  });

  it('parses full guardrails.yaml and loads from disk', () => {
    const yaml = `
boundaries:
  - id: ui-no-server
    from: ['src/ui/**']
    disallowImports: ['src/server/**', '**/db/**']
    replaceWith: 'Call the typed API client in src/api/'
    reason: 'UI must not import server internals'
bannedPatterns:
  - id: no-eval
    pattern: '\\beval\\s*\\('
    files: ['src/**/*.ts']
    exclude: ['src/**/*.test.ts']
    replaceWith: 'Use JSON.parse or a safe parser'
    severity: error
    ratcheted: true
comments:
  maxRatio: 0.25
  maxInlinePerFile: 5
  ignoreLicenseHeaders: true
  ignoreDocComments: true
  ratcheted: false
nativeLinters:
  - id: tsc
    command: node
    args: ['-e', 'process.exit(0)']
    configFiles: ['tsconfig.json']
ruleTable:
  file: AGENTS.md
  requireEnforcer: true
ratchetFile: .custom-ratchet.json
ignore:
  - 'node_modules/**'
  - 'generated/**'
`;
    withTempRepo({ [GUARDRAILS_FILE]: yaml }, (root) => {
      const cfg = loadGuardrails(root);
      assert.ok(cfg);
      assert.equal(cfg.boundaries.length, 1);
      assert.equal(cfg.boundaries[0].id, 'ui-no-server');
      assert.equal(cfg.bannedPatterns[0].ratcheted, true);
      assert.equal(cfg.comments?.maxRatio, 0.25);
      assert.equal(cfg.comments?.maxInlinePerFile, 5);
      assert.equal(cfg.nativeLinters[0].id, 'tsc');
      assert.equal(cfg.ratchetFile, '.custom-ratchet.json');
      assert.deepEqual(cfg.ignore, ['node_modules/**', 'generated/**']);
    });
  });

  it('returns undefined when guardrails.yaml does not exist', () => {
    withTempRepo({}, (root) => {
      assert.equal(loadGuardrails(root), undefined);
    });
  });

  it('rejects invalid regex, invalid severity, duplicate ids, and out-of-range maxRatio', () => {
    assert.throws(
      () =>
        parseGuardrails(`
bannedPatterns:
  - id: bad-re
    pattern: '[unclosed'
    replaceWith: 'fix'
`),
      /valid RegExp/,
    );
    assert.throws(
      () =>
        parseGuardrails(`
bannedPatterns:
  - id: dup
    pattern: 'foo'
    replaceWith: 'bar'
  - id: dup
    pattern: 'baz'
    replaceWith: 'qux'
`),
      /duplicate/,
    );
    assert.throws(
      () =>
        parseGuardrails(`
comments:
  maxRatio: 1.5
`),
      /between 0 and 1/,
    );
  });
});

describe('polyglot scanner: extractImports', () => {
  it('extracts TS/JS static, export, side-effect, require, and dynamic imports with relative resolution', () => {
    const src = `
// import ignored from '../server/secret';
import type { User } from '../server/db';
import {
  render,
  hydrate,
} from './render';
export { helper } from '../shared/util';
import './polyfill.css';
const fs = require('node:fs');
const dyn = await import('../server/lazy.ts');
`;
    const imports = extractImports(src, 'src/ui/page.ts');
    assert.deepEqual(
      imports.map((i) => ({ specifier: i.specifier, line: i.line, resolvedHint: i.resolvedHint })),
      [
        { specifier: '../server/db', line: 3, resolvedHint: 'src/server/db' },
        { specifier: './render', line: 4, resolvedHint: 'src/ui/render' },
        { specifier: '../shared/util', line: 8, resolvedHint: 'src/shared/util' },
        { specifier: './polyfill.css', line: 9, resolvedHint: 'src/ui/polyfill.css' },
        { specifier: 'node:fs', line: 10, resolvedHint: undefined },
        { specifier: '../server/lazy.ts', line: 11, resolvedHint: 'src/server/lazy.ts' },
      ],
    );
  });

  it('extracts Go single and grouped imports while ignoring commented imports', () => {
    const src = `package ui

// import "internal/secret"
import "fmt"
import (
\t"context"
\tdb "myorg/app/internal/db" // inline comment
\t_ "myorg/app/driver"
)
`;
    const imports = extractImports(src, 'pkg/ui/handler.go');
    assert.deepEqual(
      imports.map((i) => ({ specifier: i.specifier, line: i.line })),
      [
        { specifier: 'fmt', line: 4 },
        { specifier: 'context', line: 6 },
        { specifier: 'myorg/app/internal/db', line: 7 },
        { specifier: 'myorg/app/driver', line: 8 },
      ],
    );
  });

  it('extracts Python absolute and relative imports with resolved paths', () => {
    const src = `# from ..server.db import ignored
import os, sys as system
from app.domain.models import Order
from ..server.db import query
from .helpers import format_date
`;
    const imports = extractImports(src, 'src/ui/page.py');
    assert.deepEqual(
      imports.map((i) => ({ specifier: i.specifier, line: i.line, resolvedHint: i.resolvedHint })),
      [
        { specifier: 'os', line: 2, resolvedHint: undefined },
        { specifier: 'sys', line: 2, resolvedHint: undefined },
        { specifier: 'app.domain.models', line: 3, resolvedHint: 'app/domain/models' },
        { specifier: '..server.db', line: 4, resolvedHint: 'src/server/db' },
        { specifier: '.helpers', line: 5, resolvedHint: 'src/ui/helpers' },
      ],
    );
  });

  it('extracts Rust use trees, mod declarations, and handles lifetimes cleanly', () => {
    const src = `// use crate::server::ignored;
use crate::server::{db, auth as server_auth};
pub mod local_helper;
fn borrow<'a>(x: &'a str) -> &'a str { x }
`;
    const imports = extractImports(src, 'src/ui/view.rs');
    assert.deepEqual(
      imports.map((i) => ({ specifier: i.specifier, line: i.line, resolvedHint: i.resolvedHint })),
      [
        { specifier: 'crate::server::db', line: 2, resolvedHint: 'src/server/db' },
        { specifier: 'crate::server::auth', line: 2, resolvedHint: 'src/server/auth' },
        { specifier: 'local_helper', line: 3, resolvedHint: 'src/ui/local_helper' },
      ],
    );
  });

  it('extracts Java/Kotlin, C#, and Ruby imports', () => {
    const javaImports = extractImports('import com.acme.internal.Repo;\n', 'src/Ui.java');
    assert.equal(javaImports[0].resolvedHint, 'com/acme/internal/Repo');

    const csImports = extractImports('using Acme.Internal.Db;\n', 'src/Ui.cs');
    assert.equal(csImports[0].resolvedHint, 'Acme/Internal/Db');

    const rbImports = extractImports("require_relative '../server/db'\nrequire 'json'\n", 'src/ui/page.rb');
    assert.deepEqual(
      rbImports.map((i) => ({ specifier: i.specifier, resolvedHint: i.resolvedHint })),
      [
        { specifier: '../server/db', resolvedHint: 'src/server/db' },
        { specifier: 'json', resolvedHint: undefined },
      ],
    );
  });
});

describe('polyglot scanner: analyzeComments', () => {
  it('NEVER counts URLs inside strings, template literals, or regexes as comments', () => {
    const tsSource = `const a = 'https://example.com/a//b';
const b = "http://localhost:8080/api/*not-a-comment*/";
const c = \`https://api.example.com/\${id}//status\`;
const re = /https:\\/\\/example\\.com/;
export const urls = [a, b, c, re];
`;
    const res = analyzeComments(tsSource, 'src/urls.ts');
    assert.equal(res.totalLines, 5);
    assert.equal(res.codeLines, 5);
    assert.equal(res.commentLines, 0);
    assert.equal(res.inlineComments, 0);
    assert.equal(res.ratio, 0);

    const pySource = `url1 = "https://example.com/#fragment"
url2 = 'http://example.com/#anchor'
doc = """line1
# not a comment inside triple-quoted string
"""
`;
    const pyRes = analyzeComments(pySource, 'src/urls.py');
    assert.equal(pyRes.commentLines, 0);
    assert.equal(pyRes.inlineComments, 0);
  });

  it('counts C-like line, block, and inline comments accurately and respects ignore options', () => {
    const src = `// Copyright 2026 Acme Corp
// SPDX-License-Identifier: Apache-2.0

/**
 * Adds two numbers.
 */
// Regular explanation comment
export function add(a: number, b: number): number {
  const sum = a + b; // inline comment
  /* block inline */ return sum;
}
`;
    const all = analyzeComments(src, 'src/math.ts');
    assert.equal(all.codeLines, 4);
    assert.equal(all.commentLines, 8); // 2 license + 3 doc + 1 regular + 2 inline
    assert.equal(all.inlineComments, 2);

    const ignored = analyzeComments(src, 'src/math.ts', {
      ignoreLicenseHeaders: true,
      ignoreDocComments: true,
    });
    assert.equal(ignored.codeLines, 4);
    assert.equal(ignored.commentLines, 3); // 1 regular + 2 inline
    assert.equal(ignored.inlineComments, 2);
    assert.ok(Math.abs(ignored.ratio - 3 / 7) < 1e-9);
  });

  it('strips comments while preserving line numbers and strings', () => {
    const src = `const url = "https://example.com"; // eval('x')
/* eval('y') */
const ok = 42;
`;
    const stripped = stripComments(src, 'src/a.ts');
    assert.ok(stripped.includes('https://example.com'));
    assert.ok(!stripped.includes('eval'));
    assert.equal(stripped.split('\n').length, src.split('\n').length);
  });
});

describe('guardrails engine', () => {
  it('enforces TS, Go, and Python boundary rules using both raw specifiers and resolved paths', () => {
    withTempRepo(
      {
        [GUARDRAILS_FILE]: `
boundaries:
  - id: ui-no-server-ts
    from: ['src/ui/**/*.ts']
    disallowImports: ['src/server/**']
    replaceWith: 'Import from src/client/api.ts'
    reason: 'UI must not reach into server modules'
  - id: go-no-internal-db
    from: ['pkg/api/**/*.go']
    disallowImports: ['**/internal/db/**']
    replaceWith: 'Inject a repository interface'
  - id: py-no-server-db
    from: ['app/ui/**/*.py']
    disallowImports: ['app/server/**']
    replaceWith: 'Use app.client.http'
`,
        'src/ui/page.ts': `import { query } from '../server/db';\nexport const x = query;\n`,
        'src/ui/clean.ts': `import { api } from '../client/api';\nexport const y = api;\n`,
        'pkg/api/handler.go': `package api\nimport (\n  "myorg/internal/db/postgres"\n)\n`,
        'app/ui/view.py': `from ..server.db import fetch\n`,
      },
      (root) => {
        const report = runGuardrails(root);
        assert.equal(report.schema, 'vgate.lint/1');
        assert.equal(report.ok, false);
        assert.equal(report.violations.length, 3);

        const byRule = new Map(report.violations.map((v) => [v.ruleId, v]));
        assert.equal(byRule.get('ui-no-server-ts')?.file, 'src/ui/page.ts');
        assert.equal(byRule.get('ui-no-server-ts')?.line, 1);
        assert.equal(byRule.get('ui-no-server-ts')?.replaceWith, 'Import from src/client/api.ts');
        assert.equal(byRule.get('go-no-internal-db')?.file, 'pkg/api/handler.go');
        assert.equal(byRule.get('py-no-server-db')?.file, 'app/ui/view.py');
      },
    );
  });

  it('checks banned patterns with replaceWith, skips comments for code patterns, and catches directive patterns', () => {
    withTempRepo(
      {
        [GUARDRAILS_FILE]: `
bannedPatterns:
  - id: no-eval
    pattern: '\\beval\\s*\\('
    files: ['src/**/*.ts']
    exclude: ['src/legacy/**']
    replaceWith: 'Use JSON.parse()'
  - id: no-ts-ignore
    pattern: '@ts-ignore'
    files: ['src/**/*.ts']
    replaceWith: 'Fix the type error properly'
  - id: prefer-logger
    pattern: 'console\\.log\\('
    files: ['src/**/*.ts']
    replaceWith: 'Use logger.info()'
    severity: warn
`,
        'src/a.ts': `// Never call eval() in production
export function run(x: string) {
  // @ts-ignore
  return eval(x);
}
`,
        'src/legacy/old.ts': `export const v = eval('1 + 1');\n`,
        'src/warn-only.ts': `console.log('hi');\n`,
      },
      (root) => {
        const report = runGuardrails(root);
        assert.equal(report.ok, false);

        const noEval = report.violations.filter((v) => v.ruleId === 'no-eval');
        assert.equal(noEval.length, 1);
        assert.equal(noEval[0].file, 'src/a.ts');
        assert.equal(noEval[0].line, 4); // line 1 comment was skipped!
        assert.equal(noEval[0].replaceWith, 'Use JSON.parse()');

        const tsIgnore = report.violations.filter((v) => v.ruleId === 'no-ts-ignore');
        assert.equal(tsIgnore.length, 1);
        assert.equal(tsIgnore[0].line, 3);

        const warnOnly = report.violations.filter((v) => v.ruleId === 'prefer-logger');
        assert.equal(warnOnly.length, 1);
        assert.equal(warnOnly[0].severity, 'warn');
      },
    );
  });

  it('enforces comment density caps without flagging URLs', () => {
    withTempRepo(
      {
        [GUARDRAILS_FILE]: `
comments:
  maxRatio: 0.3
  maxInlinePerFile: 1
  files: ['src/**/*.ts']
`,
        'src/noisy.ts': `// c1
// c2
// c3
const a = 1; // inline 1
const b = 2; // inline 2
`,
        'src/urls.ts': `const u1 = 'https://a.example/x//y';
const u2 = "https://b.example/z//w";
const u3 = \`https://c.example/\${u1}//end\`;
export { u1, u2, u3 };
`,
      },
      (root) => {
        const report = runGuardrails(root);
        assert.equal(report.ok, false);
        assert.deepEqual(
          report.violations.map((v) => ({ ruleId: v.ruleId, file: v.file })),
          [
            { ruleId: 'comments:max-ratio', file: 'src/noisy.ts' },
            { ruleId: 'comments:max-inline', file: 'src/noisy.ts' },
          ],
        );
      },
    );
  });

  it('runs brownfield ratchet lifecycle: fail without baseline, update, pass at baseline, fail above/new file, tighten', () => {
    withTempRepo(
      {
        [GUARDRAILS_FILE]: `
bannedPatterns:
  - id: no-any
    pattern: '\\bas\\s+any\\b'
    files: ['src/**/*.ts']
    replaceWith: 'Use unknown and narrow'
    ratcheted: true
`,
        'src/legacy.ts': `export const a = 1 as any;\nexport const b = 2 as any;\n`,
      },
      (root) => {
        // 1. Without baseline file, violations fail.
        const initial = runGuardrails(root);
        assert.equal(initial.ok, false);
        assert.equal(initial.violations.length, 2);
        assert.equal(initial.baselined, 0);

        // 2. Initialize baseline with updateRatchet: true.
        const initUpdate = runGuardrails(root, { updateRatchet: true });
        assert.equal(initUpdate.ok, true);
        assert.equal(initUpdate.violations.length, 0);
        assert.equal(initUpdate.baselined, 2);
        const saved = readRatchetBaseline(join(root, RATCHET_FILE));
        assert.equal(saved?.counts['no-any']?.['src/legacy.ts'], 2);

        // 3. Re-running at baseline passes with baselined=2.
        const atBaseline = runGuardrails(root);
        assert.equal(atBaseline.ok, true);
        assert.equal(atBaseline.baselined, 2);
        assert.equal(atBaseline.tightenings.length, 0);

        // 4. Adding a 3rd occurrence in legacy.ts fails (excess = 1).
        writeRepoFile(
          root,
          'src/legacy.ts',
          `export const a = 1 as any;\nexport const b = 2 as any;\nexport const c = 3 as any;\n`,
        );
        const exceeded = runGuardrails(root);
        assert.equal(exceeded.ok, false);
        assert.equal(exceeded.baselined, 2);
        assert.equal(exceeded.violations.length, 1);
        assert.match(exceeded.violations[0].message, /ratchet exceeded: 3 > baseline 2/);

        // 5. Reverting legacy.ts to 2 and adding a NEW file with 1 occurrence fails!
        writeRepoFile(root, 'src/legacy.ts', `export const a = 1 as any;\nexport const b = 2 as any;\n`);
        writeRepoFile(root, 'src/brand-new.ts', `export const n = 9 as any;\n`);
        const newFile = runGuardrails(root);
        assert.equal(newFile.ok, false);
        assert.equal(newFile.violations.length, 1);
        assert.equal(newFile.violations[0].file, 'src/brand-new.ts');

        // 6. Removing the new file and reducing legacy.ts from 2 -> 1 emits a tightening!
        rmSync(join(root, 'src/brand-new.ts'));
        writeRepoFile(root, 'src/legacy.ts', `export const a = 1 as any;\n`);
        const tightened = runGuardrails(root);
        assert.equal(tightened.ok, true);
        assert.equal(tightened.baselined, 1);
        assert.deepEqual(tightened.tightenings, [{ ruleId: 'no-any', file: 'src/legacy.ts', baseline: 2, actual: 1 }]);

        // 7. Running updateRatchet: true persists the tightened count on disk.
        const persisted = runGuardrails(root, { updateRatchet: true });
        assert.equal(persisted.ok, true);
        assert.deepEqual(persisted.tightenings, [{ ruleId: 'no-any', file: 'src/legacy.ts', baseline: 2, actual: 1 }]);
        const updatedJson = JSON.parse(readFileSync(join(root, RATCHET_FILE), 'utf8')) as RatchetBaseline;
        assert.equal(updatedJson.counts['no-any']['src/legacy.ts'], 1);
      },
    );
  });

  it('validates AGENTS.md rule tables under ## Rule Table and ## Guardrail Rules', () => {
    withTempRepo(
      {
        [GUARDRAILS_FILE]: `
ruleTable:
  file: AGENTS.md
  requireEnforcer: true
`,
        'AGENTS.md': `# Agents Guide

## Rule Table

| Rule | Enforcer |
| --- | --- |
| No eval in app code | \`guardrails.yaml:no-eval\` |
| Clear naming | judgment |
| Never log PII | manual |
| Always validate inputs | |
| No circular deps | none |

## Other Section

| Not a rule | Notes |
| --- | --- |
| Ignored | none |
`,
      },
      (root) => {
        const report = runGuardrails(root);
        assert.equal(report.ok, false);
        assert.equal(report.ruleTable.checked, true);
        assert.equal(report.ruleTable.file, 'AGENTS.md');
        assert.deepEqual(report.ruleTable.unenforced, [
          { rule: 'Never log PII', line: 9 },
          { rule: 'Always validate inputs', line: 10 },
          { rule: 'No circular deps', line: 11 },
        ]);
        assert.equal(report.violations.filter((v) => v.kind === 'rule-table').length, 3);
      },
    );
  });

  it('executes native linters with shell: false and captures pass/fail output', () => {
    withTempRepo(
      {
        [GUARDRAILS_FILE]: `
nativeLinters:
  - id: pass-check
    command: ${process.execPath}
    args: ['-e', 'console.log("all clean")']
  - id: fail-check
    command: ${process.execPath}
    args: ['-e', 'console.error("lint boom"); process.exit(2)']
    configFiles: ['.eslintrc.json']
    reason: 'Must pass lint'
`,
      },
      (root) => {
        const report = runGuardrails(root);
        assert.equal(report.ok, false);
        assert.equal(report.nativeLinters.length, 2);
        assert.equal(report.nativeLinters[0].ok, true);
        assert.equal(report.nativeLinters[0].exitCode, 0);
        assert.equal(report.nativeLinters[0].output, 'all clean');

        assert.equal(report.nativeLinters[1].ok, false);
        assert.equal(report.nativeLinters[1].exitCode, 2);
        assert.match(report.nativeLinters[1].output, /lint boom/);
        assert.equal(report.violations.length, 1);
        assert.equal(report.violations[0].kind, 'native-linter');
        assert.equal(report.violations[0].file, '.eslintrc.json');

        const skipped = runGuardrails(root, { skipNativeLinters: true });
        assert.equal(skipped.ok, true);
        assert.equal(skipped.nativeLinters.length, 0);
      },
    );
  });

  it('supports ## Guardrail Rules heading, ratcheted comments, binary file skipping, and scoped file runs', () => {
    withTempRepo(
      {
        [GUARDRAILS_FILE]: `
comments:
  maxInlinePerFile: 1
  files: ['src/**/*.ts']
  ratcheted: true
ruleTable:
  file: AGENTS.md
  requireEnforcer: true
`,
        'AGENTS.md': `## Guardrail Rules

| Invariant | Enforcer |
| --- | --- |
| Keep comments concise | \`guardrails.yaml:comments\` |
| Architecture clarity | judgment: reviewed in PR |
`,
        'src/a.ts': `const a = 1; // c1\nconst b = 2; // c2\n`,
        'src/b.ts': `const x = 1; // c1\nconst y = 2; // c2\n`,
      },
      (root) => {
        // Add a binary file with NUL bytes to ensure scanner skips it cleanly.
        writeFileSync(join(root, 'src/blob.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]));

        // Initialize comment ratchet baseline.
        const init = runGuardrails(root, { updateRatchet: true });
        assert.equal(init.ok, true);
        assert.equal(init.ruleTable.checked, true);
        assert.deepEqual(init.ruleTable.unenforced, []);

        // Scoped run on src/a.ts alone must not report a false tightening for unscanned src/b.ts.
        const scoped = runGuardrails(root, { files: ['src/a.ts'] });
        assert.equal(scoped.ok, true);
        assert.equal(scoped.filesScanned, 1);
        assert.deepEqual(scoped.tightenings, []);

        // Adding a 3rd inline comment to src/a.ts exceeds the comment ratchet baseline.
        writeRepoFile(root, 'src/a.ts', `const a = 1; // c1\nconst b = 2; // c2\nconst c = 3; // c3\n`);
        const failed = runGuardrails(root);
        assert.equal(failed.ok, false);
        assert.equal(failed.violations.length, 1);
        assert.equal(failed.violations[0].ruleId, 'comments:max-inline');
      },
    );
  });
});

describe('vgate guard anti-weakening rules', () => {
  const baseConfig = `
boundaries:
  - id: ui-no-server
    from: ['src/ui/**', 'src/web/**']
    disallowImports: ['src/server/**', 'src/db/**']
    replaceWith: 'Use API client'
bannedPatterns:
  - id: no-eval
    pattern: '\\beval\\('
    files: ['src/**']
    replaceWith: 'Use JSON.parse'
    severity: error
    ratcheted: false
comments:
  maxRatio: 0.25
  maxInlinePerFile: 3
  ignoreDocComments: false
nativeLinters:
  - id: eslint
    command: pnpm
    args: ['lint']
    configFiles: ['eslint.config.js', '.eslintrc.json']
ruleTable:
  file: AGENTS.md
  requireEnforcer: true
ignore:
  - 'node_modules/**'
`;

  it('guardrailsConfigRule flags deleted config', () => {
    const res = guardrailsConfigRule(GUARDRAILS_FILE, baseConfig, undefined);
    assert.equal(res.findings.length, 1);
    assert.match(res.findings[0].detail, /deleted/);
  });

  it('guardrailsConfigRule catches every loosening bypass', () => {
    const weakened = `
boundaries:
  - id: ui-no-server
    from: ['src/ui/**']
    disallowImports: ['src/server/**']
    replaceWith: 'Use API client'
bannedPatterns:
  - id: no-eval
    pattern: '\\beval\\('
    files: ['src/app/**']
    exclude: ['src/app/hack.ts']
    replaceWith: 'Use JSON.parse'
    severity: warn
    ratcheted: true
comments:
  maxRatio: 0.4
  maxInlinePerFile: 10
  ignoreDocComments: true
nativeLinters:
  - id: eslint
    command: pnpm
    args: ['lint', '--quiet']
    configFiles: ['eslint.config.js']
ruleTable:
  file: AGENTS.md
  requireEnforcer: false
ignore:
  - 'node_modules/**'
  - 'src/legacy/**'
`;
    const res = guardrailsConfigRule(GUARDRAILS_FILE, baseConfig, weakened);
    const details = res.findings.map((f) => f.detail);
    assert.ok(details.some((d) => d.includes('narrowed from (lost src/web/**)')));
    assert.ok(details.some((d) => d.includes('narrowed disallowImports (lost src/db/**)')));
    assert.ok(details.some((d) => d.includes('narrowed files (lost src/**)')));
    assert.ok(details.some((d) => d.includes('added exclude: src/app/hack.ts')));
    assert.ok(details.some((d) => d.includes('turned ratcheted on')));
    assert.ok(details.some((d) => d.includes('lowered severity error -> warn')));
    assert.ok(details.some((d) => d.includes('comments.maxRatio raised 0.25 -> 0.4')));
    assert.ok(details.some((d) => d.includes('comments.maxInlinePerFile raised 3 -> 10')));
    assert.ok(details.some((d) => d.includes('comments.ignoreDocComments turned on')));
    assert.ok(details.some((d) => d.includes('command/args changed')));
    assert.ok(details.some((d) => d.includes('removed protected configFile: .eslintrc.json')));
    assert.ok(details.some((d) => d.includes('ruleTable.requireEnforcer turned off')));
    assert.ok(details.some((d) => d.includes('ignore added: src/legacy/**')));
  });

  it('guardrailsConfigRule catches removed boundary, bannedPattern, comments, and nativeLinter', () => {
    const stripped = `
boundaries: []
bannedPatterns: []
nativeLinters: []
ruleTable:
  file: OTHER.md
  requireEnforcer: true
`;
    const res = guardrailsConfigRule(GUARDRAILS_FILE, baseConfig, stripped);
    const details = res.findings.map((f) => f.detail);
    assert.ok(details.some((d) => d.includes('boundary rule "ui-no-server" removed')));
    assert.ok(details.some((d) => d.includes('banned pattern "no-eval" removed')));
    assert.ok(details.some((d) => d.includes('comments guardrail removed')));
    assert.ok(details.some((d) => d.includes('native linter "eslint" removed')));
    assert.ok(details.some((d) => d.includes('ruleTable.file changed AGENTS.md -> OTHER.md')));
  });

  it('guardrailsConfigRule treats strictly additive/tightening changes as info with zero findings', () => {
    const stricter = `
boundaries:
  - id: ui-no-server
    from: ['src/ui/**', 'src/web/**', 'src/mobile/**']
    disallowImports: ['src/server/**', 'src/db/**', 'src/admin/**']
    replaceWith: 'Use API client'
  - id: shared-pure
    from: ['src/shared/**']
    disallowImports: ['src/server/**']
    replaceWith: 'Keep shared pure'
bannedPatterns:
  - id: no-eval
    pattern: '\\beval\\('
    files: ['src/**']
    replaceWith: 'Use JSON.parse'
    severity: error
    ratcheted: false
  - id: no-debugger
    pattern: '\\bdebugger\\b'
    replaceWith: 'Remove debugger'
comments:
  maxRatio: 0.2
  maxInlinePerFile: 2
  ignoreDocComments: false
nativeLinters:
  - id: eslint
    command: pnpm
    args: ['lint']
    configFiles: ['eslint.config.js', '.eslintrc.json', 'tsconfig.json']
ruleTable:
  file: AGENTS.md
  requireEnforcer: true
ignore:
  - 'node_modules/**'
`;
    const res = guardrailsConfigRule(GUARDRAILS_FILE, baseConfig, stricter);
    assert.deepEqual(res.findings, []);
    assert.ok(res.info.length >= 4);
  });

  it('ratchetBaselineRule flags deletion, count increases, and newly added files while treating decreases as info', () => {
    const baseRatchet = JSON.stringify({
      schema: 'vgate.ratchet/1',
      updatedAt: '2026-11-01T00:00:00Z',
      counts: {
        'no-any': {
          'src/a.ts': 4,
          'src/b.ts': 2,
        },
      },
    });

    // Deleted baseline
    const deleted = ratchetBaselineRule(RATCHET_FILE, baseRatchet, undefined);
    assert.equal(deleted.findings.length, 1);
    assert.match(deleted.findings[0].detail, /deleted/);

    // Increased count + newly added file
    const weakened = JSON.stringify({
      schema: 'vgate.ratchet/1',
      updatedAt: '2026-11-20T00:00:00Z',
      counts: {
        'no-any': {
          'src/a.ts': 5,
          'src/b.ts': 2,
          'src/new.ts': 1,
        },
      },
    });
    const bad = ratchetBaselineRule(RATCHET_FILE, baseRatchet, weakened);
    assert.equal(bad.findings.length, 2);
    assert.ok(bad.findings.some((f) => f.detail.includes('raised no-any for src/a.ts: 4 -> 5')));
    assert.ok(bad.findings.some((f) => f.detail.includes('added no-any for src/new.ts (count 1)')));

    // Decreased count + removed file -> tightening (info only!)
    const tightened = JSON.stringify({
      schema: 'vgate.ratchet/1',
      updatedAt: '2026-11-20T00:00:00Z',
      counts: {
        'no-any': {
          'src/a.ts': 2,
        },
      },
    });
    const good = ratchetBaselineRule(RATCHET_FILE, baseRatchet, tightened);
    assert.deepEqual(good.findings, []);
    assert.equal(good.info.length, 2);
    assert.ok(good.info.some((i) => i.detail.includes('tightened no-any for src/a.ts: 4 -> 2')));
    assert.ok(good.info.some((i) => i.detail.includes('removed no-any for src/b.ts (was 2)')));
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { apply, candidates, hint, mutantId, sample } from './operators.ts';
import { changedLines, count, isMutationSource, mutationVerdict } from './score.ts';
import { codeOnly, languageOf, tokenize } from './tokenize.ts';

const ops = (file: string, text: string, line?: number) =>
  candidates(file, text, line === undefined ? 'all' : new Set([line])).map(
    (c) => `${c.operator}:${c.original}->${c.replacement}`,
  );

describe('tokenize', () => {
  it('blanks comments, strings, templates and regular expressions, and keeps the code', () => {
    const ts = [
      'const a = x < y; // x < y in a comment',
      'const s = \'a < b\' + "c == d";',
      'const t = `a ${b == c} d`;',
      'const r = /a<b/.test(s);',
      '/* x >= y',
      '   across lines */ const z = 1;',
    ].join('\n');
    const masked = codeOnly(ts, tokenize(ts, languageOf('x.ts')!));
    const lines = masked.split('\n');
    assert.match(lines[0], /x < y;\s+$/);
    assert.doesNotMatch(lines[1], /<|==/);
    assert.doesNotMatch(lines[2], /==/);
    assert.doesNotMatch(lines[3], /a<b/);
    assert.doesNotMatch(lines[4], />=/);
    assert.match(lines[5], /const z = 1;$/);
    assert.equal(masked.length, ts.length, 'offsets are kept');
  });

  it('knows Go raw strings, Java text blocks and Python comments and triple quotes', () => {
    // Inside the raw string nothing; the `+` joining the two strings is code.
    assert.deepEqual(ops('a.go', 'x := `a < b` + "c"\n'), ['arithmetic:+->-']);
    assert.deepEqual(ops('A.java', 'String s = """\n a == b\n""";\n'), []);
    assert.deepEqual(ops('a.py', 'x = 1  # a < b\ns = """a == b"""\n'), ['number:1->2']);
  });

  it('never escapes into a comment or a string: nested comments, multi-line literals, JSX and divisions', () => {
    const inside = ' a < b && c == 1 ';
    // Commented-out code with its own comment, where block comments nest.
    for (const file of ['a.rs', 'a.kt', 'a.swift', 'a.scala', 'a.dart'])
      assert.deepEqual(ops(file, `/* old\n /* note */\n${inside}\n*/\nx = 1\n`), ['number:1->2'], file);
    // Where they do not nest, the first `*/` ends the comment.
    assert.deepEqual(ops('a.java', `/* old /* note */ x = 1;\n`), ['number:1->2']);
    // Literals over several lines.
    for (const [file, literal] of [
      ['a.swift', `"""\n${inside}\n"""`],
      ['a.dart', `'''\n${inside}\n'''`],
      ['a.rs', `"one\n${inside}\n"`],
      ['a.rs', `r#"say "hi\n${inside}\n"#`],
      ['a.cs', `@"C:\\dir\\"`],
      ['a.cs', `@"one\n${inside}\n"`],
      ['a.cpp', `R"sql(\n${inside}\n)sql"`],
    ])
      assert.deepEqual(ops(file, `s = ${literal};\nx = 1;\n`), ['number:1->2'], `${file} ${literal}`);
    // A JSX closing tag, a postfix increment and a line that starts with `/` are not regular expressions.
    assert.deepEqual(ops('a.tsx', `const x = <a>link</a>; // ${inside}\n`), []);
    assert.deepEqual(ops('a.ts', `const avg = n++ / 2; /* note\n${inside} */\n`), ['number:2->3']);
    assert.deepEqual(ops('a.ts', `x = a\n  / 2; /* note\n${inside} */\n`), ['number:2->3']);
    // While a regular expression on its own line is one.
    assert.deepEqual(ops('a.ts', `ok(\n  /${inside}/.test(s),\n);\n`), []);
  });
});

describe('operators', () => {
  it('plants each classic bug in code, and never in a comment or a string', () => {
    assert.deepEqual(ops('a.ts', 'if (amount < 1 || amount >= max) return x === y && !ok;'), [
      'boundary:<-><=',
      'number:1->2',
      'logical:||->&&',
      'boundary:>=->>',
      'equality:===->!==',
      'logical:&&->||',
      'negation:!->',
    ]);
    assert.deepEqual(ops('a.ts', 'const total = a + b - 3; const on = true;'), [
      'arithmetic:+->-',
      'arithmetic:-->+',
      'number:3->4',
      'boolean:true->false',
    ]);
    assert.deepEqual(ops('a.ts', "// if (a < b) return 'x';"), []);
  });

  it('leaves generics, arrows, increments, assignments and non-null assertions alone', () => {
    assert.deepEqual(ops('a.ts', 'const m: Map<string, Array<T>> = new Map<string, T>();'), []);
    assert.deepEqual(
      ops('a.ts', 'const f = (a) => a?.b!; i++; j -= k; x != y;').filter((o) => !o.startsWith('equality')),
      [],
    );
    assert.deepEqual(ops('a.kt', 'val n = x!!.size'), []);
    assert.deepEqual(ops('a.ts', "if (!['IDR', 'USD'].includes(c)) x();"), ['negation:!->']);
    assert.deepEqual(ops('a.ts', 'const big = 100_000_000; const hex = 0x1f; const id = v2;'), []);
  });

  it('empties the text a function returns, keeping its quotes', () => {
    assert.deepEqual(ops('a.ts', "  return 'IDR';"), ["return-string:'IDR'->''"]);
    assert.deepEqual(ops('a.py', "    return f'{x} items'"), ["return-string:f'{x} items'->f''"]);
    assert.deepEqual(ops('a.ts', "  return '';"), []);
    assert.deepEqual(ops('a.ts', "  const s = 'IDR';"), []);
  });

  it('Python: and/or, True/False, dropping not', () => {
    assert.deepEqual(ops('a.py', 'if a and not b or c == True:'), [
      'logical:and->or',
      'negation:not ->',
      'logical:or->and',
      'equality:==->!=',
      'boolean:True->False',
    ]);
  });

  it('only the asked lines, with a deterministic id per place and change', () => {
    const text = 'a < b\nc < d\n';
    const only = candidates('x.ts', text, new Set([2]));
    assert.deepEqual(
      only.map((c) => [c.line, c.column]),
      [[2, 3]],
    );
    assert.equal(only[0].id, mutantId('x.ts', 2, 3, 'boundary', '<'));
    assert.equal(candidates('x.ts', text, new Set([2]))[0].id, only[0].id);
    assert.notEqual(candidates('y.ts', text, new Set([2]))[0].id, only[0].id);
    assert.equal(apply(text, only[0]), 'a < b\nc <= d\n');
    assert.throws(() => apply('changed', only[0]), /the file changed/);
  });

  it('no candidates for files of a language vgate does not mutate', () => {
    assert.equal(languageOf('README.md'), undefined);
    assert.deepEqual(candidates('schema.sql', 'a < b', 'all'), []);
  });

  it('samples across files, then lines, in a fixed order', () => {
    const many = [...candidates('b.ts', 'a < b && c < d\ne < f\n', 'all'), ...candidates('a.ts', 'g < h\n', 'all')];
    const picked = sample(many, 3);
    assert.deepEqual(
      picked.map((c) => `${c.file}:${c.line}:${c.column}`),
      ['a.ts:1:3', 'b.ts:1:3', 'b.ts:2:3'],
    );
    assert.deepEqual(sample(many, 3), picked);
    assert.equal(sample(many, 100).length, many.length);
  });

  it('hints say what scenario would have caught the survivor', () => {
    const c = candidates('orders.ts', 'if (amount >= max) x();', 'all')[0];
    assert.match(hint(c), /`>=` became `>` in orders\.ts:1: add a scenario at the exact limit value/);
  });
});

describe('score', () => {
  it('reads the changed lines of a diff, ignoring deletions', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -3,0 +4,2 @@',
      '+a',
      '+b',
      '@@ -10 +12 @@',
      '-c',
      '+d',
      '@@ -20,3 +21,0 @@',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
    ].join('\n');
    const lines = changedLines(diff);
    assert.deepEqual([...(lines.get('x.ts') ?? [])], [4, 5, 12]);
    assert.equal(lines.has('gone.ts'), false);
  });

  it('counts only killed and survived in the score; null when nothing could be judged', () => {
    const c = count([
      { status: 'killed' },
      { status: 'killed' },
      { status: 'survived' },
      { status: 'timeout' },
      { status: 'build-error' },
      { status: 'not-run' },
    ]);
    assert.deepEqual(c, {
      total: 6,
      killed: 2,
      survived: 1,
      timeout: 1,
      buildError: 1,
      notRun: 1,
      flaky: 0,
      score: 0.667,
    });
    // A flaky mutant is neither caught nor missed.
    assert.equal(count([{ status: 'killed' }, { status: 'flaky' }, { status: 'flaky' }]).score, 1);
    assert.equal(count([{ status: 'build-error' }]).score, null);
  });

  it('judges a score against the policy', () => {
    const at = (score: number | null) => ({ ...count([]), score });
    assert.equal(mutationVerdict(0, at(null), 0.7), 'not-applicable');
    assert.equal(mutationVerdict(3, at(null), 0.7), 'unmeasured');
    assert.equal(mutationVerdict(3, at(0.5), 0.7), 'below');
    assert.equal(mutationVerdict(3, at(0.7), 0.7), 'pass');
    assert.equal(mutationVerdict(3, at(0.1), undefined), 'pass');
  });

  it('mutates the service code only: not tests, generated code, migrations or another service', () => {
    const o = { servicesDir: 'regression/', service: 'orders', migrationDirs: ['db/migrations'] };
    assert.equal(isMutationSource('src/orders/total.ts', o), true);
    assert.equal(isMutationSource('regression/orders/app/server.ts', o), true);
    // Beside the service's verification files only when `paths:` names it as the service's code.
    assert.equal(isMutationSource('regression/orders/server.ts', o), false);
    assert.equal(
      isMutationSource('regression/orders/server.ts', { ...o, declared: (f) => f === 'regression/orders/server.ts' }),
      true,
    );
    assert.equal(
      isMutationSource('regression/orders/tests/a.ts', { ...o, declared: () => true }),
      false,
      'tests stay tests',
    );
    for (const file of [
      'src/orders/total.test.ts',
      'internal/orders/total_test.go',
      'src/test/java/OrdersTest.java',
      'tests/test_orders.py',
      'regression/orders/tests/orders.spec.ts',
      'regression/orders/support/fixtures.ts',
      'regression/payments/app/server.ts',
      'regression/orders/service.ts',
      'db/migrations/001_init.go',
      'api/orders.pb.go',
      'dist/index.js',
      'README.md',
    ])
      assert.equal(isMutationSource(file, o), false, file);
  });
});

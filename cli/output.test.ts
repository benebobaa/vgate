import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { emit, EXIT, stripAnsi, tail, type Result } from './output.ts';

describe('stripAnsi', () => {
  it('removes colour and cursor codes and leaves the text', () => {
    assert.equal(stripAnsi('\u001b[31mFAIL\u001b[0m \u001b[1;32mok\u001b[39m \u001b[2K'), 'FAIL ok ');
    assert.equal(stripAnsi('plain [not a code]'), 'plain [not a code]');
  });
});

describe('tail', () => {
  const log = ['first', '', '\u001b[32msecond\u001b[0m   ', '   ', 'third', 'fourth\t', ''].join('\n');

  it('keeps the last lines, without empty ones, colour codes or trailing space', () => {
    assert.deepEqual(tail(log, 3), ['second', 'third', 'fourth']);
  });

  it('gives every line when the log is shorter than the count', () => {
    assert.deepEqual(tail(log, 40), ['first', 'second', 'third', 'fourth']);
  });

  it('is empty for an empty log', () => {
    assert.deepEqual(tail('\n\n', 5), []);
  });
});

describe('emit', () => {
  const result: Result = {
    command: 'doctor',
    ok: false,
    exitCode: EXIT.notReady,
    summary: 'Not ready: 1 of 9 checks failed',
    data: { checks: 9 },
    next: ['vgate doctor --fix'],
    text: ['fail  dependencies  node_modules lacks tsx'],
  };

  function printed(json: boolean): string {
    const write = mock.method(process.stdout, 'write', () => true);
    try {
      emit(result, json);
      return write.mock.calls.map((call) => String(call.arguments[0])).join('');
    } finally {
      write.mock.restore();
    }
  }

  it('prints the envelope alone as JSON, without the human rendering', () => {
    assert.deepEqual(JSON.parse(printed(true)), {
      command: 'doctor',
      ok: false,
      exitCode: 3,
      summary: 'Not ready: 1 of 9 checks failed',
      data: { checks: 9 },
      next: ['vgate doctor --fix'],
    });
  });

  it('prints the rendering, the summary and the next commands as text', () => {
    assert.equal(
      printed(false),
      'fail  dependencies  node_modules lacks tsx\nNot ready: 1 of 9 checks failed\n  next: vgate doctor --fix\n',
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { uniqueFactory } from '../data/unique.ts';
import { parseArgs } from './args.ts';

describe('parseArgs', () => {
  it('reads --key value, --key=value, bare flags and positionals', () => {
    assert.deepEqual(parseArgs(['writer', '--service', 'svc', '--mode=full', '--strict']), {
      _: ['writer'],
      service: 'svc',
      mode: 'full',
      strict: true,
    });
  });

  it('gives a bare flag the next positional as its value (put positionals first)', () => {
    assert.deepEqual(parseArgs(['--strict', 'writer']), { _: [], strict: 'writer' });
  });

  it('never gives a declared boolean a value', () => {
    assert.deepEqual(parseArgs(['--json', 'install', '--dir', 'out'], ['json']), {
      _: ['install'],
      json: true,
      dir: 'out',
    });
  });

  it('treats a flag followed by another flag as bare', () => {
    assert.deepEqual(parseArgs(['--strict', '--service', 'svc']), { _: [], strict: true, service: 'svc' });
  });
});

describe('uniqueFactory', () => {
  it('makes distinct, lower-case, username-safe ids within the length cap', () => {
    const unique = uniqueFactory('k3x9a', 3, 20);
    const ids = Array.from({ length: 50 }, () => unique('Very Long Prefix With Spaces'));
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(id, /^[a-z0-9._-]+$/);
      assert.ok(id.length <= 20, id);
      assert.ok(id.includes('.k3x9a.3'), id);
    }
  });
});

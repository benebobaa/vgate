import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fillTemplate, parseSetCookies } from './session.ts';

describe('fillTemplate', () => {
  it('replaces {username} and {password} in every string, leaves the rest', () => {
    assert.deepEqual(
      fillTemplate(
        { email: '{username}', password: '{password}', remember: true, nested: ['{username}', '{other}'] },
        { username: 'a@b.c', password: 'p' },
      ),
      { email: 'a@b.c', password: 'p', remember: true, nested: ['a@b.c', '{other}'] },
    );
  });
});

describe('parseSetCookies', () => {
  it('keeps name and value, ignores attributes, drops deleted cookies', () => {
    const cookies = parseSetCookies([
      'sid=abc=def; Path=/; HttpOnly; SameSite=Lax',
      'csrf=t1; Path=/',
      'old=x; Max-Age=0',
      'gone=; Path=/',
      'malformed',
    ]);
    assert.deepEqual(
      [...cookies],
      [
        ['sid', 'abc=def'],
        ['csrf', 't1'],
      ],
    );
  });

  it('lets a later header delete an earlier cookie', () => {
    assert.deepEqual([...parseSetCookies(['a=1', 'a=; Max-Age=0'])], []);
  });
});

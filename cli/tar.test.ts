import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { paxRecords } from './tar.ts';

/** One ustar member: a 512-byte header (name, octal size, typeflag) and its data padded to 512. */
function member(name: string, type: string, data: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'latin1');
  header.write(`${Buffer.byteLength(data).toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  header.write(type, 156, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(data) / 512) * 512);
  body.write(data, 0, 'utf8');
  return Buffer.concat([header, body]);
}

describe('paxRecords', () => {
  it('finds an extended-attribute header, and not the same text inside a member (a Bun binary has it)', () => {
    const tar = Buffer.concat([
      member('PaxHeader/LICENSE', 'x', '57 LIBARCHIVE.xattr.com.apple.provenance=AQ\n'),
      member('LICENSE', '0', 'Apache License'),
      member('vgate', '0', 'runtime bytes ... LIBARCHIVE.xattr. ... more bytes'),
      Buffer.alloc(1024),
    ]);
    const records = paxRecords(tar);
    assert.equal(records.length, 1);
    assert.match(records[0] ?? '', /LIBARCHIVE\.xattr\.com\.apple\.provenance/);
  });

  it('finds none in an archive the system tar makes with --no-xattrs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vgate-tar-'));
    writeFileSync(join(dir, 'f'), 'LIBARCHIVE.xattr. inside the data\n');
    const out = join(dir, 'a.tar');
    const made = spawnSync('tar', ['--no-xattrs', '-cf', out, '-C', dir, 'f'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    assert.equal(made.status, 0, made.stderr?.toString());
    assert.deepEqual(
      paxRecords(readFileSync(out)).filter((r) => r.includes('xattr')),
      [],
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

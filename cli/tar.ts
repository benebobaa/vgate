/** Reading tar archives just enough to check what the release build packed. */

/**
 * The pax extended-header records of a tar archive (typeflag x or g), read from the headers only. The members' bytes
 * are not searched: a Bun binary contains libarchive's own "LIBARCHIVE.xattr." string.
 */
export function paxRecords(tar: Buffer): string[] {
  const records: string[] = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === 'x' || type === 'g') records.push(tar.subarray(at + 512, at + 512 + size).toString('utf8'));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return records;
}

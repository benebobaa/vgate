/**
 * Path globs as people write them in .gitignore-like rules (`vgate.yaml` risk rules, service.yaml `paths:`):
 * `*` within a directory, `?` one character, `**` across directories, `{a,b}` alternatives. A glob matches the whole
 * `/`-separated path. Own code rather than a dependency: the compiled binary runs it under Bun as well as Node.
 */

/** Splits `a{b,c}d` into `abd`, `acd`; nested braces expand recursively. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') depth++;
    else if (glob[i] === '}' && --depth === 0) {
      const parts: string[] = [];
      let start = open + 1;
      let level = 0;
      for (let j = open + 1; j < i; j++) {
        if (glob[j] === '{') level++;
        else if (glob[j] === '}') level--;
        else if (glob[j] === ',' && level === 0) {
          parts.push(glob.slice(start, j));
          start = j + 1;
        }
      }
      parts.push(glob.slice(start, i));
      return parts.flatMap((part) => expandBraces(glob.slice(0, open) + part + glob.slice(i + 1)));
    }
  }
  return [glob];
}

function single(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` is zero or more directories; a trailing `**` is everything below.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return out;
}

/**
 * A gitignore-like glob over `/`-separated paths: `*`, `?`, `**`, `{a,b}`. Matches the whole path, ignoring case: a
 * rule for `migrations` must catch .NET's `Migrations/` too, and matching more only ever gates or asks more.
 */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^(?:${expandBraces(glob.replace(/^\.\//, '')).map(single).join('|')})$`, 'i');
}

const compiled = new Map<string, RegExp>();
export function matchesGlob(path: string, glob: string): boolean {
  let re = compiled.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    compiled.set(glob, re);
  }
  return re.test(path);
}

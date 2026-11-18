/**
 * `--key value` and bare `--flag` arguments; positional arguments under `_`. A name listed in `booleans` never takes
 * a value, so `--json example` keeps `example` positional.
 */
export function parseArgs(
  argv: string[],
  booleans: readonly string[] = [],
): Record<string, string | true> & { _: string[] } {
  const out: Record<string, string | true> & { _: string[] } = { _: [] } as never;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
    const next = argv[i + 1];
    if (inline !== undefined) out[key] = inline;
    else if (!booleans.includes(key) && next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

export function str(value: string | true | undefined, fallback?: string): string | undefined {
  return typeof value === 'string' ? value : fallback;
}

export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

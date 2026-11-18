import type { HeaderRules } from '../config.ts';

/** `/regex/` matches by pattern, anything else must equal the actual value after `{name}` substitution. */
export function matchesExpected(expected: string, actual: string | undefined, vars: Record<string, string>): boolean {
  if (actual === undefined) return false;
  if (expected.length > 1 && expected.startsWith('/') && expected.endsWith('/')) {
    return new RegExp(expected.slice(1, -1)).test(actual);
  }
  return actual === expected.replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? `{${name}}`);
}

export interface HeaderContext {
  status: number;
  /** Lower-cased header names, as Playwright returns them. */
  headers: Record<string, string>;
  hasBody: boolean;
  origin?: string;
}

/** Header rule violations of one response. */
export function checkHeaders(rules: HeaderRules | undefined, ctx: HeaderContext): string[] {
  if (!rules) return [];
  const vars = { origin: ctx.origin ?? '' };
  const groups: Array<[string, Record<string, string> | undefined]> = [
    ['always', rules.always],
    ['withBody', ctx.hasBody ? rules.withBody : undefined],
    ['cors', ctx.origin ? rules.cors : undefined],
    [`onStatus ${ctx.status}`, rules.onStatus?.[String(ctx.status)]],
  ];
  const violations: string[] = [];
  for (const [group, expected] of groups) {
    for (const [name, value] of Object.entries(expected ?? {})) {
      const actual = ctx.headers[name.toLowerCase()];
      if (!matchesExpected(value, actual, vars)) {
        violations.push(
          `header ${name} (${group}): expected ${value}, got ${actual === undefined ? '<absent>' : actual}`,
        );
      }
    }
  }
  return violations;
}

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** Every datetime string in the body must carry the expected offset (e.g. `+01:00`), never none or `Z`. */
export function checkDatetimeOffsets(body: unknown, offset: string | undefined, path = ''): string[] {
  if (!offset) return [];
  if (typeof body === 'string') {
    return DATETIME.test(body) && !body.endsWith(offset)
      ? [`${path || '/'}: datetime ${body} lacks offset ${offset}`]
      : [];
  }
  if (Array.isArray(body)) return body.flatMap((item, i) => checkDatetimeOffsets(item, offset, `${path}/${i}`));
  if (body && typeof body === 'object') {
    return Object.entries(body).flatMap(([key, value]) => checkDatetimeOffsets(value, offset, `${path}/${key}`));
  }
  return [];
}

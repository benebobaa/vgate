/**
 * The `ui:` block of a service.yaml: a web frontend verified through a real browser. Pure parsing and the rules the
 * fixtures apply (which origins the page may reach, which accessibility findings fail), so the self-tests can pin them.
 *
 *   ui:
 *     baseUrl: http://localhost:8094        # optional; the environment's baseUrl otherwise
 *     allowedOrigins: [self]                # 'self' = the app's own origin; anything else is blocked and recorded
 *     viewports: { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } }
 *     clock: '2026-01-15T09:00:00Z'         # the page's fixed time, so screenshots and dates are deterministic
 *     a11y: { minImpact: serious, disable: [] }
 *     budgets: { lcpMs: 2500, cls: 0.1 }    # optional web-vitals budget
 */

export const IMPACTS = ['minor', 'moderate', 'serious', 'critical'] as const;
export type Impact = (typeof IMPACTS)[number];

export interface Viewport {
  width: number;
  height: number;
}

export interface UiConfig {
  /** Where the app answers; absent: the environment's baseUrl. */
  baseUrl?: string;
  /** Origins the page may reach: 'self' (the app's own origin) or exact origins such as https://cdn.example.com. */
  allowedOrigins: string[];
  viewports: Record<string, Viewport>;
  /** The fixed time the page sees (Date, timers), ISO 8601. */
  clock: string;
  a11y: { minImpact: Impact; disable: string[] };
  budgets?: { lcpMs?: number; cls?: number };
}

export const DEFAULT_VIEWPORTS: Record<string, Viewport> = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};
export const DEFAULT_CLOCK = '2026-01-15T09:00:00.000Z';

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

function origin(value: string, where: string): string {
  if (value === 'self') return value;
  try {
    const url = new URL(value);
    if (url.origin === 'null' || url.pathname !== '/' || url.search || url.hash)
      fail(where, `"${value}" is not an origin (scheme://host[:port], nothing after it)`);
    return url.origin;
  } catch {
    return fail(where, `"${value}" is not an origin (scheme://host[:port])`);
  }
}

/** Parses `ui:`; undefined when the service declares none. Throws on anything it would have to guess. */
export function parseUi(raw: unknown, where = 'service.yaml ui'): UiConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(where, 'must be a mapping');
  const ui = record(raw);

  if (ui.baseUrl !== undefined && typeof ui.baseUrl !== 'string') fail(`${where}.baseUrl`, 'must be an http(s) URL');
  const baseUrl = ui.baseUrl === undefined ? undefined : ui.baseUrl.replace(/\/$/, '');
  if (baseUrl !== undefined && !/^https?:\/\//.test(baseUrl)) fail(`${where}.baseUrl`, 'must be an http(s) URL');

  const origins = ui.allowedOrigins === undefined ? ['self'] : ui.allowedOrigins;
  if (!Array.isArray(origins) || origins.some((o) => typeof o !== 'string'))
    fail(`${where}.allowedOrigins`, 'must be a list of origins');
  const allowedOrigins = [...new Set((origins as string[]).map((o) => origin(o, `${where}.allowedOrigins`)))];

  const viewports: Record<string, Viewport> = {};
  const rawViewports = ui.viewports === undefined ? DEFAULT_VIEWPORTS : record(ui.viewports);
  for (const [name, value] of Object.entries(rawViewports)) {
    const v = record(value);
    const width = Number(v.width);
    const height = Number(v.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
      fail(`${where}.viewports.${name}`, 'needs a positive integer width and height');
    viewports[name] = { width, height };
  }
  if (Object.keys(viewports).length === 0) fail(`${where}.viewports`, 'declares no viewport');

  if (ui.clock !== undefined && typeof ui.clock !== 'string') fail(`${where}.clock`, 'must be an ISO 8601 time');
  const clock = ui.clock === undefined ? DEFAULT_CLOCK : ui.clock;
  if (Number.isNaN(Date.parse(clock))) fail(`${where}.clock`, `"${clock}" is not an ISO 8601 time`);

  const a11y = record(ui.a11y);
  const minImpact = (a11y.minImpact ?? 'serious') as Impact;
  if (!IMPACTS.includes(minImpact)) fail(`${where}.a11y.minImpact`, `must be one of ${IMPACTS.join(', ')}`);
  const disable = a11y.disable === undefined ? [] : a11y.disable;
  if (!Array.isArray(disable) || disable.some((d) => typeof d !== 'string'))
    fail(`${where}.a11y.disable`, 'must be a list of axe rule ids');

  let budgets: UiConfig['budgets'];
  if (ui.budgets !== undefined) {
    const b = record(ui.budgets);
    budgets = {};
    for (const key of ['lcpMs', 'cls'] as const) {
      if (b[key] === undefined) continue;
      const value = Number(b[key]);
      if (!Number.isFinite(value) || value < 0) fail(`${where}.budgets.${key}`, 'must be a non-negative number');
      budgets[key] = value;
    }
  }

  return {
    baseUrl,
    allowedOrigins,
    viewports,
    clock: new Date(clock).toISOString(),
    a11y: { minImpact, disable: [...new Set(disable as string[])] },
    budgets,
  };
}

/** May the page reach `url`? Its own origin when 'self' is allowed, the listed origins, and in-page schemes. */
export function originAllowed(url: string, appOrigin: string, allowed: readonly string[]): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  // Content the page builds itself never leaves the browser.
  if (['data:', 'blob:', 'about:'].includes(target.protocol)) return true;
  if (
    target.protocol !== 'http:' &&
    target.protocol !== 'https:' &&
    target.protocol !== 'ws:' &&
    target.protocol !== 'wss:'
  )
    return false;
  // A websocket to a host counts as that host's http(s) origin.
  const asHttp = target.origin.replace(/^ws/, 'http');
  const own = asHttp === appOrigin.replace(/\/$/, '');
  if (own && allowed.includes('self')) return true;
  return allowed.some((o) => o !== 'self' && o === asHttp);
}

/** Does an axe finding of `impact` fail the test, given the configured minimum? Unknown impact counts as serious. */
export function impactFails(impact: string | null | undefined, minImpact: Impact): boolean {
  const rank = (i: string) => IMPACTS.indexOf(i as Impact);
  const found = rank(impact ?? 'serious');
  return (found === -1 ? rank('serious') : found) >= rank(minImpact);
}

/** Ranks two impacts: a positive number when `after` lets more findings through than `before` (a loosening). */
export function impactLoosening(before: Impact, after: Impact): number {
  return IMPACTS.indexOf(after) - IMPACTS.indexOf(before);
}

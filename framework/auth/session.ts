/**
 * Session logins: console-style APIs where a user logs in through the service itself and every later call carries
 * the session cookie it set (plus a CSRF token when the service demands one). See docs/auth.md.
 */
import type { EnvironmentConfig, SessionConfig } from '../config.ts';
import { guardWrite } from '../http/write-guard.ts';

/** Replaces `{username}` and `{password}` in every string of a JSON template. */
export function fillTemplate(template: unknown, values: Record<string, string>): unknown {
  if (typeof template === 'string')
    return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
  if (Array.isArray(template)) return template.map((item) => fillTemplate(item, values));
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fillTemplate(value, values)]));
  }
  return template;
}

/** `name=value` pairs of Set-Cookie headers; a cookie the server deletes (Max-Age=0, empty value) is left out. */
export function parseSetCookies(headers: string[]): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const header of headers) {
    const [pair, ...attributes] = header.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const deleted = value === '' || attributes.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a));
    if (deleted) cookies.delete(name);
    else cookies.set(name, value);
  }
  return cookies;
}

function at(body: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      body,
    );
}

export class SessionLogin {
  private readonly sessions = new Map<string, Promise<Record<string, string>>>();

  constructor(
    private readonly env: EnvironmentConfig,
    private readonly cfg: SessionConfig,
  ) {}

  /** The headers of a logged-in user: one login per worker and credentials unless `fresh` asks for a new session. */
  headers(username: string, password: string, who: string, fresh = false): Promise<Record<string, string>> {
    if (fresh) return this.login(username, password, who);
    const key = `${username}\0${password}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = this.login(username, password, who);
      // A failed login is not cached: the next call tries again and fails with its own message.
      session.catch(() => this.sessions.delete(key));
      this.sessions.set(key, session);
    }
    return session;
  }

  /** The headers that carry a session the test obtained itself. */
  forCookie(value: string, csrf?: string): Record<string, string> {
    return {
      Cookie: `${this.cfg.cookie}=${value}`,
      ...(csrf !== undefined && this.cfg.csrf ? { [this.cfg.csrf.header]: csrf } : {}),
    };
  }

  private async login(username: string, password: string, who: string): Promise<Record<string, string>> {
    const { login, cookie, csrf } = this.cfg;
    const method = (login.method ?? 'POST').toUpperCase();
    // A login is a write too: in a shared environment it goes out only when allowWrites lists it (write-guard.ts).
    guardWrite(this.env, method, login.path);
    const url = `${this.env.baseUrl}${login.path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.env.origin ? { Origin: this.env.origin } : {}),
        ...login.headers,
      },
      body: JSON.stringify(fillTemplate(login.body, { username, password })),
      redirect: 'manual',
    });
    const text = await response.text();
    const where = `Session login of user "${who}" (${method} ${login.path})`;
    if (!response.ok) throw new Error(`${where} failed: ${response.status} ${text.slice(0, 300)}`);
    const cookies = parseSetCookies(response.headers.getSetCookie());
    const session = cookies.get(cookie);
    if (session === undefined) {
      throw new Error(
        `${where} answered ${response.status} but set no ${cookie} cookie (set: ${[...cookies.keys()].join(', ') || 'none'})`,
      );
    }
    const headers: Record<string, string> = {
      // Every cookie the login set travels back, as a browser would send it (a double-submit CSRF cookie included).
      Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    };
    if (csrf) {
      let token: unknown;
      if (csrf.cookie) token = cookies.get(csrf.cookie);
      else if (csrf.field) {
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = undefined;
        }
        token = at(body, csrf.field);
      }
      if (typeof token !== 'string' || token === '') {
        throw new Error(
          `${where} gave no CSRF token in ${csrf.cookie ? `cookie ${csrf.cookie}` : `response field ${csrf.field ?? '?'}`}`,
        );
      }
      headers[csrf.header] = token;
    }
    return headers;
  }
}

/** The value of one cookie in a `Cookie` header value (`a=1; b=2`). */
export function cookieValue(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * The contract's security scheme that carries the session cookie (`type: apiKey, in: cookie, name: <cookie>`), so a
 * tool that understands the contract's auth (Schemathesis) can send it, and leave it out on purpose.
 */
export function cookieScheme(spec: unknown, cookie: string): string | undefined {
  const components = (spec as { components?: { securitySchemes?: Record<string, unknown> } } | undefined)?.components;
  for (const [name, scheme] of Object.entries(components?.securitySchemes ?? {})) {
    const s = scheme as { type?: unknown; in?: unknown; name?: unknown };
    if (s.type === 'apiKey' && s.in === 'cookie' && s.name === cookie) return name;
  }
  return undefined;
}

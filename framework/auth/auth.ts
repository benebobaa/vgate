import type { AuthConfig, EnvironmentConfig, SeededUser } from '../config.ts';
import { Keycloak } from './keycloak.ts';
import { SessionLogin } from './session.ts';

/** The request headers that authenticate one call; empty for an anonymous one. */
export type AuthHeaders = () => Promise<Record<string, string>>;

/**
 * Turns the identities of service.yaml into request headers, whatever the service authenticates with:
 *
 * - a user with a `password` logs in through the service itself when `auth.session` is set, and sends the session
 *   cookie it set (and a CSRF header when configured; see docs/auth.md); otherwise it gets a token through the
 *   environment's Keycloak (password grant), sent as `Authorization: Bearer <token>`;
 * - a user with a `token` sends that static credential (a long-lived bearer token, an API key) under `auth.header`
 *   with `auth.scheme` (default `Authorization` and `Bearer`; for an API key e.g. `X-Api-Key` and an empty scheme);
 * - a user with neither calls anonymously.
 */
export class Auth {
  private keycloakClient?: Keycloak;
  private readonly session?: SessionLogin;

  constructor(private readonly env: EnvironmentConfig) {
    if (env.auth?.session) this.session = new SessionLogin(env, env.auth.session);
  }

  private get keycloak(): Keycloak {
    if (!this.env.keycloak)
      throw new Error(`Environment ${this.env.name} has no keycloak: users with a password cannot get a token`);
    return (this.keycloakClient ??= new Keycloak(this.env.keycloak));
  }

  /** The header a token or credential travels in, e.g. `Authorization: Bearer <token>`. */
  header(credential: string): Record<string, string> {
    const { header, scheme } = withDefaults(this.env.auth);
    return { [header]: scheme ? `${scheme} ${credential}` : credential };
  }

  /**
   * Headers of a seeded user from service.yaml. A session user logs in once per worker; `newSession` logs in again,
   * for a test that ends or revokes its session (logout, password change) and must not end everyone else's.
   */
  forUser(name: string, options: { newSession?: boolean } = {}): AuthHeaders {
    const user = this.seeded(name);
    if (user.token !== undefined) {
      const token = user.token;
      return () => Promise.resolve(this.header(token));
    }
    if (user.password !== undefined) {
      const credentials = { username: user.username ?? name, password: user.password };
      return this.forCredentials(credentials, { ...options, who: name });
    }
    return () => Promise.resolve({});
  }

  /** Headers of an identity created during the run: a session login or a Keycloak account with a password. */
  forCredentials(
    credentials: { username: string; password: string },
    options: { newSession?: boolean; who?: string } = {},
  ): AuthHeaders {
    const { session } = this;
    if (session) {
      const who = options.who ?? credentials.username;
      if (!options.newSession) return () => session.headers(credentials.username, credentials.password, who);
      // One new session per caller: every call of this caller reuses it.
      let fresh: Promise<Record<string, string>> | undefined;
      return () => (fresh ??= session.headers(credentials.username, credentials.password, who, true));
    }
    return async () => this.header(await this.keycloak.passwordToken(credentials.username, credentials.password));
  }

  /** Headers carrying a session cookie the test obtained itself (and its CSRF token). */
  forSession(cookie: string, csrf?: string): AuthHeaders {
    if (!this.session) throw new Error(`Environment ${this.env.name} has no auth.session: there is no session cookie`);
    const headers = this.session.forCookie(cookie, csrf);
    return () => Promise.resolve(headers);
  }

  /** Headers carrying a token the test obtained itself. */
  forToken(token: string): AuthHeaders {
    return () => Promise.resolve(this.header(token));
  }

  /** The credentials of a seeded user as `Name: value` header lines (for tools such as Schemathesis or curl). */
  async headerLines(name: string): Promise<string[]> {
    return Object.entries(await this.forUser(name)()).map(([header, value]) => `${header}: ${value}`);
  }

  /** The first credential header line of a seeded user; see headerLines for users that need several. */
  async headerLine(name: string): Promise<string | undefined> {
    return (await this.headerLines(name))[0];
  }

  /**
   * The raw credential of a seeded user: its static token, a Keycloak access token, or for a session user the
   * `Cookie` header value.
   */
  async credential(name: string): Promise<string | undefined> {
    const user = this.seeded(name);
    if (user.token !== undefined) return user.token;
    if (user.password === undefined) return undefined;
    if (this.session) return (await this.forUser(name)()).Cookie;
    return this.keycloak.passwordToken(user.username ?? name, user.password);
  }

  private seeded(name: string): SeededUser {
    const user = this.env.users[name];
    if (!user) {
      throw new Error(
        `User "${name}" is not in service.yaml environments.${this.env.name}.users (have: ${Object.keys(this.env.users).join(', ')})`,
      );
    }
    return user;
  }
}

function withDefaults(auth: AuthConfig | undefined): { header: string; scheme: string } {
  return { header: auth?.header ?? 'Authorization', scheme: auth?.scheme ?? 'Bearer' };
}

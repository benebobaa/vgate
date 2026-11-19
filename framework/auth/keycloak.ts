import type { EnvironmentConfig, KeycloakConfig } from '../config.ts';
import { frameworkFetch } from '../http/write-guard.ts';

interface CachedToken {
  token: string;
  /** Epoch seconds. */
  exp: number;
}

export interface NewKeycloakUser {
  username: string;
  password: string;
  /** Omitted: a default is filled in. `null`: the account has none (Keycloak then refuses it the password grant). */
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

/** The client (and realm) a token is requested through; by default the service's own client and realm. */
export interface TokenClient {
  clientId: string;
  clientSecret?: string;
  realm?: string;
}

export interface KeycloakUser {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

function expiry(token: string): number {
  const payload = token.split('.')[1] ?? '';
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
  return claims.exp ?? 0;
}

/** Decodes a JWT payload without verifying it: for asserting what a token carries, never for trust. */
export function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

/**
 * Keycloak as a test dependency: tokens for test users (password grant on the service's client) and, in disposable
 * environments, provisioning of throwaway users through the Admin API. Every user created here is deleted when the
 * worker ends.
 */
export class Keycloak {
  private readonly tokens = new Map<string, CachedToken>();
  private adminCache?: CachedToken;
  private readonly created = new Set<string>();
  private readonly createdClients = new Set<string>();

  constructor(private readonly cfg: KeycloakConfig) {}

  get issuer(): string {
    return `${this.cfg.url}/realms/${this.cfg.realm}`;
  }

  get canProvision(): boolean {
    return this.cfg.admin !== undefined;
  }

  private async tokenRequest(url: string, form: Record<string, string>): Promise<string> {
    const response = await frameworkFetch(url, { method: 'POST', body: new URLSearchParams(form) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Keycloak token request to ${url} failed: ${response.status} ${text}`);
    return (JSON.parse(text) as { access_token: string }).access_token;
  }

  /** Access token of a user, cached until shortly before it expires. */
  async passwordToken(username: string, password: string): Promise<string> {
    const cached = this.tokens.get(username);
    if (cached && cached.exp - 30 > Date.now() / 1000) return cached.token;
    const token = await this.newPasswordToken(username, password);
    this.tokens.set(username, { token, exp: expiry(token) });
    return token;
  }

  /**
   * A new access token on every call (a new Keycloak session, so a new `sid`), never cached, through `client`
   * (default: the service's own client in the service's realm). For tokens a test needs fresh or from another
   * client: a second session, a short-lived token, a token without the service's audience.
   */
  async newPasswordToken(username: string, password: string, client?: TokenClient): Promise<string> {
    const realm = client?.realm ?? this.cfg.realm;
    const clientId = client?.clientId ?? this.cfg.clientId;
    const clientSecret = client ? client.clientSecret : this.cfg.clientSecret;
    return this.tokenRequest(`${this.cfg.url}/realms/${realm}/protocol/openid-connect/token`, {
      grant_type: 'password',
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      username,
      password,
      scope: 'openid',
    });
  }

  private async adminToken(): Promise<string> {
    const admin = this.cfg.admin;
    if (!admin)
      throw new Error('This environment has no keycloak.admin, or is not disposable: users cannot be provisioned here');
    if (this.adminCache && this.adminCache.exp - 30 > Date.now() / 1000) return this.adminCache.token;
    const token = await this.tokenRequest(
      `${this.cfg.url}/realms/${admin.realm ?? 'master'}/protocol/openid-connect/token`,
      {
        grant_type: 'password',
        client_id: admin.clientId ?? 'admin-cli',
        username: admin.username,
        password: admin.password,
      },
    );
    this.adminCache = { token, exp: expiry(token) };
    return token;
  }

  private async admin(method: string, path: string, body?: unknown): Promise<Response> {
    return frameworkFetch(`${this.cfg.url}/admin/realms/${this.cfg.realm}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.adminToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /**
   * Creates an enabled user and returns it with its id, the token's `sub`. By default the profile is complete
   * (Keycloak refuses the password grant to an incomplete one); pass `null` for a name or the email to leave it out.
   */
  async createUser(user: NewKeycloakUser): Promise<KeycloakUser> {
    const profile = (value: string | null | undefined, fallback: string) =>
      value === null ? undefined : (value ?? fallback);
    const response = await this.admin('POST', '/users', {
      username: user.username,
      enabled: true,
      emailVerified: true,
      firstName: profile(user.firstName, 'Test'),
      lastName: profile(user.lastName, user.username),
      email: profile(user.email, `${user.username}@test.local`),
      credentials: [{ type: 'password', value: user.password, temporary: false }],
    });
    if (response.status !== 201)
      throw new Error(`Keycloak user ${user.username} not created: ${response.status} ${await response.text()}`);
    const id = response.headers.get('location')?.split('/').pop();
    if (!id) throw new Error(`Keycloak created ${user.username} without a Location header`);
    this.created.add(id);
    return (await this.getUser(id)) ?? { id, username: user.username };
  }

  async getUser(id: string): Promise<KeycloakUser | undefined> {
    const response = await this.admin('GET', `/users/${encodeURIComponent(id)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Keycloak user ${id} not read: ${response.status}`);
    return (await response.json()) as KeycloakUser;
  }

  async deleteUser(id: string): Promise<void> {
    const response = await this.admin('DELETE', `/users/${encodeURIComponent(id)}`);
    if (response.status !== 204 && response.status !== 404)
      throw new Error(`Keycloak user ${id} not deleted: ${response.status}`);
    this.created.delete(id);
  }

  /**
   * Creates a client in the realm from a Keycloak ClientRepresentation (e.g. a short token lifespan, or no
   * profile/email scopes) and returns its internal id. Deleted when the worker ends, or earlier with deleteClient.
   */
  async createClient(representation: Record<string, unknown>): Promise<string> {
    const response = await this.admin('POST', '/clients', representation);
    if (response.status !== 201)
      throw new Error(`Keycloak client not created: ${response.status} ${await response.text()}`);
    const id = response.headers.get('location')?.split('/').pop();
    if (!id) throw new Error('Keycloak created a client without a Location header');
    this.createdClients.add(id);
    return id;
  }

  async deleteClient(id: string): Promise<void> {
    const response = await this.admin('DELETE', `/clients/${encodeURIComponent(id)}`);
    if (response.status !== 204 && response.status !== 404)
      throw new Error(`Keycloak client ${id} not deleted: ${response.status}`);
    this.createdClients.delete(id);
  }

  /** Deletes every user and client this instance created. */
  async cleanup(): Promise<void> {
    for (const id of [...this.created]) await this.deleteUser(id);
    for (const id of [...this.createdClients]) await this.deleteClient(id);
  }
}

/** An environment's Keycloak. Provisioning writes users into the realm: only where the environment is disposable. */
export function keycloakOf(env: Pick<EnvironmentConfig, 'disposable'> & { keycloak: KeycloakConfig }): Keycloak {
  return new Keycloak(env.disposable ? env.keycloak : { ...env.keycloak, admin: undefined });
}

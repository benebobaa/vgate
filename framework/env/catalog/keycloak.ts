/**
 * Keycloak in development mode, as the identity provider of the service under test. Options: adminUser and
 * adminPassword (default `admin`); `realmFile: realm.json` is imported on start (a realm export with its clients and users);
 * realm (the realm's name, for the `issuer` export).
 *
 * The issuer is fixed to the address the app uses inside the environment, so a token the tests fetch from the host
 * carries the same `iss` as one the app would see, and the app's issuer check passes.
 */
import { basename } from 'node:path';
import { option } from './options.ts';
import type { DependencyKind, KindContext } from './types.ts';

const realmPath = (ctx: KindContext) => (typeof ctx.options.realmFile === 'string' ? ctx.options.realmFile : undefined);

export const keycloak: DependencyKind = {
  kind: 'keycloak',
  defaultImage: 'quay.io/keycloak/keycloak:26.4.7',
  ports: { main: 8080, management: 9000 },
  pathOptions: ['realmFile'],
  command: (ctx) => ['start-dev', ...(realmPath(ctx) ? ['--import-realm'] : [])],
  environment: (ctx) => ({
    KC_BOOTSTRAP_ADMIN_USERNAME: option(ctx, 'adminUser', 'admin'),
    KC_BOOTSTRAP_ADMIN_PASSWORD: option(ctx, 'adminPassword', 'admin'),
    KC_HEALTH_ENABLED: 'true',
    KC_HOSTNAME: `http://${ctx.internal.host}:${ctx.internal.ports.main}`,
    // Tokens requested from the host still go to the host's address; only the issuer is fixed.
    KC_HOSTNAME_BACKCHANNEL_DYNAMIC: 'true',
  }),
  mounts: (ctx) => {
    const seed = realmPath(ctx);
    return seed ? { [seed]: `/opt/keycloak/data/import/${basename(seed)}` } : {};
  },
  health: { http: { port: 'management', path: '/health/ready' } },
  healthTimeout: 180,
  exports: (endpoint, ctx) => {
    const url = `http://${endpoint.host}:${endpoint.ports.main}`;
    const realm = option(ctx, 'realm', 'master');
    return {
      url,
      host: endpoint.host,
      port: String(endpoint.ports.main),
      realm,
      // The issuer never changes with the side that asks: it is the app's view (see above).
      issuer: `http://${ctx.internal.host}:${ctx.internal.ports.main}/realms/${realm}`,
      tokenUrl: `${url}/realms/${realm}/protocol/openid-connect/token`,
      adminUser: option(ctx, 'adminUser', 'admin'),
      adminPassword: option(ctx, 'adminPassword', 'admin'),
    };
  },
};

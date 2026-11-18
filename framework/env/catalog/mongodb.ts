/**
 * MongoDB, single node. Options: database (default `app`), user and password (default `app`; created as the root user
 * of the server); `init: file.js` (mongosh script) runs during the first start, against `database`.
 */
import { basename } from 'node:path';
import { option } from './options.ts';
import type { DependencyKind, KindContext } from './types.ts';

export const mongoCredentials = (ctx: KindContext) => ({
  database: option(ctx, 'database', 'app'),
  user: option(ctx, 'user', 'app'),
  password: option(ctx, 'password', 'app'),
});

const initPath = (ctx: KindContext) => (typeof ctx.options.init === 'string' ? ctx.options.init : undefined);

export const mongodb: DependencyKind = {
  kind: 'mongodb',
  defaultImage: 'mongo:8.0.38',
  ports: { main: 27017 },
  pathOptions: ['init'],
  environment: (ctx) => {
    const c = mongoCredentials(ctx);
    return {
      MONGO_INITDB_ROOT_USERNAME: c.user,
      MONGO_INITDB_ROOT_PASSWORD: c.password,
      MONGO_INITDB_DATABASE: c.database,
    };
  },
  mounts: (ctx) => {
    const seed = initPath(ctx);
    return seed ? { [seed]: `/docker-entrypoint-initdb.d/${basename(seed)}` } : {};
  },
  // Through the container's own address, not 127.0.0.1: while the init scripts run, the image's temporary server
  // binds to localhost only, so an answer here means the real server (with its user and seed) is up.
  health: {
    exec: [
      'sh',
      '-c',
      'mongosh --quiet --host "$(hostname -i | cut -d" " -f1)" -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand({ ping: 1 }).ok" | grep -q 1',
    ],
  },
  healthTimeout: 120,
  exports: (endpoint, ctx) => {
    const c = mongoCredentials(ctx);
    const port = String(endpoint.ports.main);
    return {
      url: `mongodb://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${endpoint.host}:${port}/${c.database}?authSource=admin`,
      host: endpoint.host,
      port,
      user: c.user,
      password: c.password,
      database: c.database,
    };
  },
};

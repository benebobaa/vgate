/**
 * MySQL. Options: database, user, password (default `app` each), rootPassword (default `root`); `seed: file.sql` runs
 * during the server's first start (its init directory), before it accepts TCP connections.
 */
import { basename } from 'node:path';
import { option } from './options.ts';
import type { DependencyKind, KindContext } from './types.ts';

export const mysqlCredentials = (ctx: KindContext) => ({
  database: option(ctx, 'database', 'app'),
  user: option(ctx, 'user', 'app'),
  password: option(ctx, 'password', 'app'),
  rootPassword: option(ctx, 'rootPassword', 'root'),
});

const seedPath = (ctx: KindContext) => (typeof ctx.options.seed === 'string' ? ctx.options.seed : undefined);

export const mysql: DependencyKind = {
  kind: 'mysql',
  defaultImage: 'mysql:8.4.13',
  ports: { main: 3306 },
  environment: (ctx) => {
    const c = mysqlCredentials(ctx);
    if (c.user === 'root') throw new Error(`${ctx.name}: user root is the administrator; name an application user`);
    return {
      MYSQL_DATABASE: c.database,
      MYSQL_USER: c.user,
      MYSQL_PASSWORD: c.password,
      MYSQL_ROOT_PASSWORD: c.rootPassword,
    };
  },
  mounts: (ctx) => {
    const seed = seedPath(ctx);
    // The image runs *.sql in this directory against MYSQL_DATABASE on its first start.
    return seed ? { [seed]: `/docker-entrypoint-initdb.d/${basename(seed)}` } : {};
  },
  // Over TCP on purpose: while the init scripts run, the image's temporary server listens on the socket only, so a
  // TCP answer means the database, its user and its seed are ready.
  health: {
    exec: ['sh', '-c', 'mysqladmin ping -h 127.0.0.1 --protocol=TCP -uroot -p"$MYSQL_ROOT_PASSWORD" --silent'],
  },
  healthTimeout: 120,
  exports: (endpoint, ctx) => {
    const c = mysqlCredentials(ctx);
    const port = String(endpoint.ports.main);
    return {
      url: `mysql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${endpoint.host}:${port}/${c.database}`,
      host: endpoint.host,
      port,
      user: c.user,
      password: c.password,
      database: c.database,
    };
  },
};

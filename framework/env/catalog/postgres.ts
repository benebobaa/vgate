/** PostgreSQL. Options: database, user, password (default `app` each); `seed: file.sql` runs once it is healthy. */
import { basename } from 'node:path';
import { option } from './options.ts';
import type { DependencyKind, KindContext } from './types.ts';

const credentials = (ctx: KindContext) => ({
  database: option(ctx, 'database', 'app'),
  user: option(ctx, 'user', 'app'),
  password: option(ctx, 'password', 'app'),
});

const seedPath = (ctx: KindContext) => (typeof ctx.options.seed === 'string' ? ctx.options.seed : undefined);

export const postgres: DependencyKind = {
  kind: 'postgres',
  defaultImage: 'postgres:17.6-alpine',
  ports: { main: 5432 },
  pathOptions: ['seed'],
  environment: (ctx) => {
    const c = credentials(ctx);
    return { POSTGRES_DB: c.database, POSTGRES_USER: c.user, POSTGRES_PASSWORD: c.password };
  },
  mounts: (ctx) => {
    const seed = seedPath(ctx);
    return seed ? { [seed]: `/vgate/seed/${basename(seed)}` } : {};
  },
  // Over TCP: during its init scripts the server only listens on the socket, so a TCP answer means init is done.
  health: { exec: ['pg_isready', '-h', '127.0.0.1'] },
  setup: (ctx) => {
    const c = credentials(ctx);
    const seed = seedPath(ctx);
    // pg_isready answers before the init scripts finish; a real query proves the database is usable.
    const ready = ['psql', '-U', c.user, '-d', c.database, '-v', 'ON_ERROR_STOP=1', '-qc', 'SELECT 1'];
    return seed
      ? [
          ready,
          ['psql', '-U', c.user, '-d', c.database, '-v', 'ON_ERROR_STOP=1', '-qf', `/vgate/seed/${basename(seed)}`],
        ]
      : [ready];
  },
  exports: (endpoint, ctx) => {
    const c = credentials(ctx);
    const port = String(endpoint.ports.main);
    return {
      url: `postgres://${c.user}:${c.password}@${endpoint.host}:${port}/${c.database}`,
      host: endpoint.host,
      port,
      user: c.user,
      password: c.password,
      database: c.database,
    };
  },
};

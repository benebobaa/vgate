/** Redis. No options. */
import type { DependencyKind } from './types.ts';

export const redis: DependencyKind = {
  kind: 'redis',
  defaultImage: 'redis:8.2.2-alpine',
  ports: { main: 6379 },
  health: { exec: ['redis-cli', 'ping'] },
  exports: (endpoint) => ({
    url: `redis://${endpoint.host}:${endpoint.ports.main}`,
    host: endpoint.host,
    port: String(endpoint.ports.main),
  }),
};

/**
 * A separate Toxiproxy, for projects that configure their own proxies. Sealed environments rarely need it: their edge
 * is a Toxiproxy already, and `faults: true` on a dependency routes it through the edge (`{edge.api}`).
 */
import type { DependencyKind } from './types.ts';

export const toxiproxy: DependencyKind = {
  kind: 'toxiproxy',
  defaultImage: 'ghcr.io/shopify/toxiproxy:2.12.0',
  ports: { api: 8474 },
  command: () => ['-host=0.0.0.0'],
  health: { http: { port: 'api', path: '/version' } },
  exports: (endpoint) => ({
    url: `http://${endpoint.host}:${endpoint.ports.api}`,
    api: `http://${endpoint.host}:${endpoint.ports.api}`,
  }),
};

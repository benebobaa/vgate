/**
 * WireMock: a third party or sibling service, answering only what the tests stub (framework/deps/stubs.ts holds every
 * stub to the provider's contract). `url` is where the app sends its calls; with `faults: true` the environment
 * routes them through the edge, so the tests can slow or cut the provider (framework/deps/toxiproxy.ts).
 */
import type { DependencyKind } from './types.ts';

export const wiremock: DependencyKind = {
  kind: 'wiremock',
  defaultImage: 'wiremock/wiremock:3.13.1',
  ports: { main: 8080 },
  command: () => ['--disable-banner'],
  health: { http: { port: 'main', path: '/__admin/health' } },
  exports: (endpoint) => {
    const url = `http://${endpoint.host}:${endpoint.ports.main}`;
    return { url, adminUrl: url, host: endpoint.host, port: String(endpoint.ports.main) };
  },
};

/**
 * A kind of dependency a sealed environment can start: its image, ports, configuration, health check and the values
 * it exports to the app (inside the environment) and to the tests (on the host). One file per kind under
 * framework/env/catalog/, registered in index.ts. This contract is stable: kinds are added, the shape does not change.
 */

/** Where something is reached: a host name and its named ports. */
export interface Endpoint {
  /** Inside the environment: the dependency's service name. From the tests: 127.0.0.1. */
  host: string;
  /** Port name -> port number as seen from that side. */
  ports: Record<string, number>;
}

/** Options given to every hook of a kind. */
export interface KindContext {
  /** The dependency's name in service.yaml, which is also its host name inside the environment. */
  name: string;
  /** `options:` of the dependency in service.yaml, as written. */
  options: Record<string, unknown>;
  /** How the tests on the host reach the dependency (through the edge). Known before any container starts. */
  external: Endpoint;
  /** How the app reaches the dependency inside the environment. */
  internal: Endpoint;
}

export type HealthCheck =
  /** A command run inside the container (`docker compose exec`); healthy when it exits 0. */
  | { exec: string[] }
  /** An HTTP GET from the host through the edge; healthy on 2xx. */
  | { http: { port: string; path: string } }
  /** A TCP connection from the host through the edge. */
  | { tcp: { port: string } };

export interface DependencyKind {
  kind: string;
  /** A pinned image that exists (`name:version`, never `latest`). service.yaml may override it with `image:`. */
  defaultImage: string;
  /**
   * Port name -> container port. Every port is reachable inside the environment; the ones listed in `published` are
   * also reachable from the tests on the host, through the edge, on a host port chosen per run.
   */
  ports: Record<string, number>;
  /** The port names the tests need from the host. Default: all of them. */
  published?: string[];
  /** Container environment variables. */
  environment?(ctx: KindContext): Record<string, string>;
  /** Container command (overrides the image's). */
  command?(ctx: KindContext): string[];
  /** Files mounted read-only into the container: absolute host path -> container path. */
  mounts?(ctx: KindContext): Record<string, string>;
  health: HealthCheck;
  /** Seconds to wait for health; default 60. */
  healthTimeout?: number;
  /** Commands run inside the container once healthy (create topics, buckets, users...), in order. */
  setup?(ctx: KindContext): string[][];
  /**
   * Named values for placeholders (`{name.url}`), from one side: called once with the internal endpoint (values for the
   * app's env) and once with the external one (values for service.yaml's environments block, read by the tests).
   */
  exports(endpoint: Endpoint, ctx: KindContext): Record<string, string>;
}

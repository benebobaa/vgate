/**
 * Plans one run's environment from its declaration: a compose project of its own, sealed from the outside world.
 * Pure (no Docker, no network), so the plan is self-tested; framework/env/lifecycle.ts carries it out.
 *
 *   network sealed (internal: no route to the internet, the host or other runs)
 *     app ──────────────► dependencies (by name)        every container resolves names through `dns`
 *     app ──► edge:3xxxx ──► a dependency with faults    (the tests slow or cut it through the edge's API)
 *     dns: answers nothing outside the environment and logs every name asked (the outbound watch)
 *   network edge (an ordinary bridge)
 *     edge: Toxiproxy, the only container with published ports, on 127.0.0.1 and ports chosen per run
 *   tests on the host ──► 127.0.0.1:<port> ──► edge ──► app or dependency
 */
import type { DependencyKind, Endpoint, KindContext } from './catalog/index.ts';
import { kindOf } from './catalog/index.ts';
import type { EnvironmentDecl } from './declare.ts';
import { migrateConfigs, migrateService, type MigrateConfig } from './migrate.ts';
import { resolvePlaceholders, type Values } from './placeholders.ts';

export const EDGE_IMAGE = 'ghcr.io/shopify/toxiproxy:2.12.0';
export const DNS_IMAGE = 'coredns/coredns:1.12.1';
const EDGE_API = 8474;
const LOOPBACK = '127.0.0.1';

export interface PlanInput {
  service: string;
  runId: string;
  decl: EnvironmentDecl;
  /** Host port for a published endpoint (`app`, `edge.api`, `<dependency>.<port name>`), chosen per run. */
  hostPort: (key: string) => number;
  /** The sealed network's subnet, `a.b.c.0/24`, chosen per run. */
  subnet: string;
  /** Absolute directory of this run's generated files (mounted into dns and edge). */
  envDir: string;
  /**
   * The name a built app image gets (`vgate/<service>-app:<hash of its build context>`): stable across runs, so an
   * unchanged app is built once and reused, and a superseded build can be found and removed. Without it compose would
   * name the image after the per-run project and leave one behind on every run.
   */
  appImage?: string;
  /** Labels on every container and network of the run, so `down` finds them even when the state file is gone. */
  labels?: Record<string, string>;
  /** The project root (vgate.yaml's directory): a dependency's `migrate.dir` resolves against it. */
  projectRoot?: string;
}

/** A dependency's migrations: run by `docker compose run` on its tool service, between readiness and the seed. */
export interface PlannedMigration {
  dependency: string;
  /** The compose service that runs them (profile `tools`: `up` never starts it on its own). */
  service: string;
  config: MigrateConfig;
}

/** `migrate-<dependency>`: the tool service that applies a dependency's migrations. */
export const migrateServiceName = (dependency: string) => `migrate-${dependency}`;

export interface PlannedDependency {
  name: string;
  kind: DependencyKind;
  ctx: KindContext;
  /** Host URL or port the lifecycle uses for http/tcp health checks. */
  hostPorts: Record<string, number>;
}

export interface Plan {
  project: string;
  compose: Record<string, unknown>;
  edgeConfig: Array<{ name: string; listen: string; upstream: string; enabled: boolean }>;
  corefile: string;
  /** host port -> what it reaches; every port the run publishes. */
  published: Array<{ key: string; hostPort: number; edgePort: number; upstream: string }>;
  /** Values for placeholders from the tests' side (service.yaml's environments block). */
  external: Values;
  /** The app's environment, placeholders resolved from inside. */
  appEnv: Record<string, string>;
  /** Containerized app; false for a host command. */
  appInside: boolean;
  appHealthUrl: string;
  dependencies: PlannedDependency[];
  dnsIp: string;
  sealed: boolean;
  /** Dependencies with `migrate:`, in declaration order. */
  migrations: PlannedMigration[];
}

/** `vgate-<service>-<run id>`, lower-case and compose-safe. */
export function projectName(service: string, runId: string): string {
  return `vgate-${service}-${runId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

export function dnsAddress(subnet: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)\.0\/24$/.exec(subnet);
  if (!match) throw new Error(`environment subnet must be a.b.c.0/24, not ${subnet}`);
  return `${match[1]}.${match[2]}.${match[3]}.53`;
}

/**
 * The edge network's subnet, paired with the sealed one (second octet + 64, so it never equals another run's sealed
 * subnet), and the edge's fixed address on it: the edge API listens there only. The sealed network has no route to
 * it, so the app cannot reach the API and create a proxy to an address outside (the edge network has a gateway).
 */
export function edgeAddress(subnet: string): { subnet: string; ip: string } {
  const [a, b, c] = dnsAddress(subnet).split('.').map(Number);
  const base = `${a}.${(b + 64) % 256}.${c}`;
  return { subnet: `${base}.0/24`, ip: `${base}.2` };
}

/**
 * No search domain in any container: the host's (`home.lan`, a CI runner's cloud domain) would turn a lookup of an
 * outside name into one that looks like a name of the environment (`s3.home.lan`), and a failed lookup of `db` into
 * one the watch must guess about. With none, every name the DNS log shows is exactly what was asked.
 */
export const NO_SEARCH = ['.'];

export const COREFILE = `# Every name not answered inside the environment is logged and refused: the outbound watch.
.:53 {
    log
    template ANY ANY {
        rcode NXDOMAIN
    }
}
`;

export function plan(input: PlanInput): Plan {
  const { decl, service, runId } = input;
  const project = projectName(service, runId);
  const dnsIp = dnsAddress(input.subnet);
  const edgeNet = edgeAddress(input.subnet);
  const edgeConfig: Plan['edgeConfig'] = [];
  const published: Plan['published'] = [];
  let nextPublished = 20000;
  let nextFault = 30000;

  const publish = (key: string, upstream: string): number => {
    const edgePort = nextPublished++;
    const hostPort = input.hostPort(key);
    if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535)
      throw new Error(`environment: host port for ${key} must be chosen per run (1024-65535), got ${hostPort}`);
    edgeConfig.push({ name: `pub-${key.replace(/\./g, '-')}`, listen: `0.0.0.0:${edgePort}`, upstream, enabled: true });
    published.push({ key, hostPort, edgePort, upstream });
    return hostPort;
  };

  const apiHostPort = input.hostPort('edge.api');
  published.push({ key: 'edge.api', hostPort: apiHostPort, edgePort: EDGE_API, upstream: 'edge API' });

  const internal: Values = {};
  const external: Values = { edge: { api: `http://${LOOPBACK}:${apiHostPort}` } };
  const dependencies: PlannedDependency[] = [];
  const services: Record<string, Record<string, unknown>> = {};
  const labelled = input.labels && Object.keys(input.labels).length > 0 ? { labels: input.labels } : {};

  for (const [name, dep] of Object.entries(decl.dependencies)) {
    const kind = kindOf(dep.kind);
    if (!kind) throw new Error(`environment.dependencies.${name}: unknown kind ${dep.kind}`);
    const portNames = Object.keys(kind.ports);
    const publishedNames = kind.published ?? portNames;
    const hostPorts: Record<string, number> = {};
    for (const portName of publishedNames) {
      if (kind.ports[portName] === undefined)
        throw new Error(`catalog ${kind.kind}: published port ${portName} is not in ports`);
      hostPorts[portName] = publish(`${name}.${portName}`, `${name}:${kind.ports[portName]}`);
    }
    const externalEndpoint: Endpoint = { host: LOOPBACK, ports: hostPorts };
    let internalEndpoint: Endpoint = { host: name, ports: { ...kind.ports } };
    if (dep.faults) {
      // The app reaches a faulted dependency through the edge, on a proxy named after it. Every port keeps its
      // container number except the first, which becomes the edge's proxy port: kinds that tell clients where to
      // reconnect (Kafka's advertised listener) read ctx.internal, so they advertise the proxy too.
      const first = portNames[0];
      const edgePort = nextFault++;
      edgeConfig.push({ name, listen: `0.0.0.0:${edgePort}`, upstream: `${name}:${kind.ports[first]}`, enabled: true });
      internalEndpoint = { host: 'edge', ports: { ...kind.ports, [first]: edgePort } };
    }
    const ctx: KindContext = { name, options: dep.options, external: externalEndpoint, internal: internalEndpoint };
    internal[name] = kind.exports(internalEndpoint, ctx);
    external[name] = { ...kind.exports(externalEndpoint, ctx), ...(dep.faults ? { proxy: name } : {}) };
    dependencies.push({ name, kind, ctx, hostPorts });

    const mounts = kind.mounts?.(ctx) ?? {};
    services[name] = {
      image: dep.image ?? kind.defaultImage,
      ...(kind.environment ? { environment: kind.environment(ctx) } : {}),
      ...(kind.command ? { command: kind.command(ctx) } : {}),
      ...(Object.keys(mounts).length > 0
        ? { volumes: Object.entries(mounts).map(([from, to]) => `${from}:${to}:ro`) }
        : {}),
      networks: ['sealed'],
      dns: [dnsIp],
      dns_search: NO_SEARCH,
      ...labelled,
    };
  }

  // `migrate:` on a dependency: a tool service on the sealed network, with the dependency's own image by default (a
  // database image has its client), started only by `compose run` before the seed (lifecycle.ts).
  const migrations: PlannedMigration[] = [];
  for (const config of migrateConfigs(decl, input.projectRoot ?? '/')) {
    const dep = dependencies.find((d) => d.name === config.dependency);
    if (!dep) continue;
    const service = migrateServiceName(config.dependency);
    services[service] = {
      ...migrateService(
        config,
        decl.dependencies[config.dependency].image ?? dep.kind.defaultImage,
        dep.kind.exports(dep.ctx.internal, dep.ctx),
        dnsIp,
      ),
      ...labelled,
    };
    migrations.push({ dependency: config.dependency, service, config });
  }

  const appInside = decl.app.command === undefined;
  let appUrl: string;
  let appPort: string;
  if (appInside) {
    const hostPort = publish('app', `app:${decl.app.port}`);
    appUrl = `http://${LOOPBACK}:${hostPort}`;
    appPort = String(hostPort);
  } else {
    // A host command listens on its own port, outside the environment; it reaches dependencies through the edge.
    appUrl = `http://${LOOPBACK}:${decl.app.port}`;
    appPort = String(decl.app.port);
  }
  external.app = { url: appUrl, port: appPort };

  // Inside, the app sees the dependencies by name; a host app sees them as the tests do.
  const appValues = appInside ? internal : external;
  const appEnv = Object.fromEntries(
    Object.entries(decl.app.env).map(([key, value]) => [
      key,
      resolvePlaceholders(value, appValues, `environment.app.env.${key}`),
    ]),
  );

  if (appInside) {
    services.app = {
      ...(decl.app.build
        ? {
            build: {
              context: decl.app.build.context,
              ...(decl.app.build.dockerfile ? { dockerfile: decl.app.build.dockerfile } : {}),
              ...(decl.app.build.target ? { target: decl.app.build.target } : {}),
            },
            ...(input.appImage ? { image: input.appImage } : {}),
          }
        : { image: decl.app.image }),
      environment: appEnv,
      networks: ['sealed'],
      dns: [dnsIp],
      dns_search: NO_SEARCH,
      depends_on: Object.keys(decl.dependencies),
      ...labelled,
    };
  }

  services.dns = {
    image: DNS_IMAGE,
    command: ['-conf', '/etc/coredns/Corefile'],
    volumes: [`${input.envDir}/Corefile:/etc/coredns/Corefile:ro`],
    networks: { sealed: { ipv4_address: dnsIp } },
    ...labelled,
  };
  services.edge = {
    image: EDGE_IMAGE,
    // The API on the edge network's address only: the tests reach it through the published port, the app cannot.
    command: [`-host=${edgeNet.ip}`, '-config=/config/edge.json'],
    volumes: [`${input.envDir}/edge.json:/config/edge.json:ro`],
    networks: { sealed: {}, edge: { ipv4_address: edgeNet.ip } },
    ports: published.map((p) => `${LOOPBACK}:${p.hostPort}:${p.edgePort}`),
    dns: [dnsIp],
    dns_search: NO_SEARCH,
    ...labelled,
  };

  return {
    project,
    compose: {
      name: project,
      networks: {
        // internal: Docker gives the network no gateway, so nothing on it reaches anything off it.
        sealed: { internal: true, ipam: { config: [{ subnet: input.subnet }] }, ...labelled },
        edge: { ipam: { config: [{ subnet: edgeNet.subnet }] }, ...labelled },
      },
      services,
    },
    edgeConfig,
    corefile: COREFILE,
    published,
    external,
    appEnv,
    appInside,
    appHealthUrl: `${appUrl}${decl.app.health}`,
    dependencies,
    dnsIp,
    sealed: decl.sealed && appInside,
    migrations,
  };
}

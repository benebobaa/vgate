/**
 * `canary`: watches a version that has started to take traffic, and says whether it stays within its limits. It reads
 * the limits from service.yaml (`environments.<name>.canary`), polls the metrics source (Prometheus, or any HTTP JSON
 * endpoint) for a window, and answers healthy (0), breach (1: the metric, its value and its limit) or unknown (3: the
 * metrics could not be read, which is never a pass). On a breach it can run one rollback command (`--on-fail`), and
 * each round can also run the smoke subset (`--smoke`).
 */
import { spawnSync } from 'node:child_process';
import { loadService, type CanaryConfig, type ServiceConfig } from '../framework/config.ts';
import type { ProjectConfig } from '../framework/project.ts';
import { CLI, EXIT, UsageError, tail, type Result } from './output.ts';
import type { Runtime } from './runtime.ts';
import { smoke } from './smoke.ts';

/** `500ms`, `30s`, `10m`, `1h` (or a bare number of seconds) in milliseconds. */
export function parseDuration(text: string, what: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!match) throw new UsageError(`${what}: a duration such as 30s, 10m or 1h (got "${text}")`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
  return Math.round(Number(match[1]) * unit);
}

export type Fetcher = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** One metric's value; throws with a plain reason when it cannot be read (never a silent zero). */
export async function readMetric(
  cfg: Pick<CanaryConfig, 'source' | 'url' | 'headers'>,
  query: string,
  fetcher: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
): Promise<number> {
  const url = cfg.source === 'prometheus' ? `${cfg.url}/api/v1/query?query=${encodeURIComponent(query)}` : cfg.url;
  let response;
  try {
    response = await fetcher(url, { headers: { Accept: 'application/json', ...cfg.headers } });
  } catch (error) {
    throw new Error(`metrics source unreachable (${cfg.url}): ${(error as Error).message}`, { cause: error });
  }
  if (!response.ok) throw new Error(`metrics source answered ${response.status} (${cfg.url})`);
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error(`metrics source did not answer JSON (${cfg.url})`);
  }
  const value = cfg.source === 'prometheus' ? prometheusValue(body, query) : jsonPath(body, query);
  // NaN (0/0: no traffic) is no value; +Inf (a latency beyond the histogram's top bucket) is above any limit.
  if (value === undefined || Number.isNaN(value) || value === -Infinity)
    throw new Error(`no value for "${query}" (${cfg.url})`);
  return value;
}

/** A Prometheus sample's value: a decimal string, or `NaN`, `+Inf`, `-Inf`. */
const sampleValue = (sample: unknown): number =>
  Array.isArray(sample)
    ? sample[1] === '+Inf'
      ? Infinity
      : sample[1] === '-Inf'
        ? -Infinity
        : Number(sample[1])
    : NaN;

function prometheusValue(body: unknown, query: string): number | undefined {
  const data = (body as { status?: string; data?: { resultType?: string; result?: unknown } }) ?? {};
  if (data.status !== 'success')
    throw new Error(`Prometheus refused "${query}": ${JSON.stringify(body).slice(0, 200)}`);
  const result = data.data?.result;
  // scalar: [ts, "v"]; vector: [{ value: [ts, "v"] }]. An empty vector (no series, no traffic) is no data.
  if (data.data?.resultType === 'scalar' && Array.isArray(result)) return sampleValue(result);
  if (Array.isArray(result) && result.length > 0) {
    // Several series (per pod, per route): the worst counts, a limit being the highest value allowed for each.
    const values = result
      .map((series) => sampleValue((series as { value?: unknown })?.value))
      .filter((v) => !Number.isNaN(v));
    return values.length > 0 ? Math.max(...values) : undefined;
  }
  return undefined;
}

function jsonPath(body: unknown, path: string): number | undefined {
  const value = path
    .split('.')
    .reduce<unknown>(
      (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      body,
    );
  return typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : undefined;
}

export interface Breach {
  metric: string;
  value: number;
  limit: number;
  /** `limit`: above its absolute limit; `baseline`: more than maxRatio times the version it replaces. */
  kind: 'limit' | 'baseline';
  baseline?: number;
}

/** The breaches of one round: a value above its limit, or above maxRatio times its baseline (when the baseline is > 0). */
export function evaluate(
  cfg: Pick<CanaryConfig, 'limits' | 'maxRatio'>,
  values: Record<string, number>,
  baseline: Record<string, number> = {},
): Breach[] {
  const breaches: Breach[] = [];
  const maxRatio = cfg.maxRatio ?? 2;
  for (const [metric, value] of Object.entries(values)) {
    const limit = cfg.limits[metric];
    if (limit !== undefined && value > limit) breaches.push({ metric, value, limit, kind: 'limit' });
    const base = baseline[metric];
    if (base !== undefined && base > 0 && value > base * maxRatio)
      breaches.push({ metric, value, limit: base * maxRatio, kind: 'baseline', baseline: base });
  }
  return breaches;
}

export interface Round {
  at: string;
  values: Record<string, number>;
  baseline: Record<string, number>;
  breaches: Breach[];
  /** The metrics that could not be read this round (why), when any. */
  unreadable?: string[];
  smoke?: 'pass' | 'fail';
}

export interface CanaryOptions {
  service: string;
  env: string;
  /** The window to watch, in ms; 0 = one round. */
  forMs: number;
  everyMs: number;
  onFail?: string;
  smoke: boolean;
  live: boolean;
  /** For tests: the metrics fetcher and the pause between rounds. */
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
}

export async function canary(project: ProjectConfig, runtime: Runtime, options: CanaryOptions): Promise<Result> {
  const { service, env } = options;
  let svc: ServiceConfig;
  try {
    svc = loadService(service, env, project.root);
  } catch (error) {
    return {
      command: 'canary',
      ok: false,
      exitCode: EXIT.notReady,
      summary: (error as Error).message,
      data: { service, environment: env },
      next: [`${CLI} doctor --service ${service}`],
    };
  }
  const cfg = svc.env.canary;
  if (!cfg)
    throw new UsageError(
      `${service} service.yaml has no environments.${env}.canary: name a metrics source, queries and limits (docs/after-deploy.md)`,
    );
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const say = (line: string) => options.live && process.stderr.write(`${line}\n`);
  const started = Date.now();
  const rounds: Round[] = [];
  let unknown: string | undefined;

  for (;;) {
    const round: Round = { at: new Date().toISOString(), values: {}, baseline: {}, breaches: [] };
    // Every metric is read and judged on its own: one that cannot be read (a timeout, no baseline traffic) neither
    // hides another's breach nor ends the watch; the window then ends unknown at best, never healthy.
    const unreadable: string[] = [];
    const read = async (queries: Record<string, string>, into: Record<string, number>) => {
      for (const [metric, query] of Object.entries(queries)) {
        try {
          into[metric] = await readMetric(cfg, query, options.fetcher);
        } catch (error) {
          unreadable.push((error as Error).message);
        }
      }
    };
    await read(cfg.queries, round.values);
    await read(cfg.baseline ?? {}, round.baseline);
    if (unreadable.length > 0) {
      round.unreadable = unreadable;
      unknown ??= unreadable[0];
    }
    round.breaches = evaluate(cfg, round.values, round.baseline);
    if (options.smoke) {
      const run = await smoke(project, runtime, { service, env, live: options.live });
      round.smoke = run.ok ? 'pass' : 'fail';
    }
    rounds.push(round);
    say(
      `${round.at}  ${Object.entries(round.values)
        .map(([m, v]) => `${m}=${v}`)
        .join(
          ' ',
        )}${round.unreadable ? '  UNREADABLE' : ''}${round.breaches.length ? '  BREACH' : ''}${round.smoke ? `  smoke=${round.smoke}` : ''}`,
    );
    if (round.breaches.length > 0 || round.smoke === 'fail') break;
    if (Date.now() - started + options.everyMs > options.forMs) break;
    await sleep(options.everyMs);
  }

  const last = rounds[rounds.length - 1];
  // A breach is a breach even in a round with an unreadable metric; unreadable rounds without one leave it unknown.
  const breached = last.breaches.length > 0 || last.smoke === 'fail';
  // A rollback runs once, and only on a breach: unreadable metrics say nothing about the version (docs/after-deploy.md).
  let rollback: { command: string; exitCode: number | null; output: string[] } | undefined;
  if (breached && options.onFail) {
    const run = spawnSync('sh', ['-c', options.onFail], { encoding: 'utf8', timeout: 600_000, env: process.env });
    rollback = {
      command: options.onFail,
      exitCode: run.status,
      output: tail(`${run.stdout ?? ''}${run.stderr ?? ''}`, 20),
    };
  }
  const describe = (b: Breach) =>
    b.kind === 'limit'
      ? `${b.metric} ${b.value} above its limit ${b.limit}`
      : `${b.metric} ${b.value} above ${cfg.maxRatio ?? 2}x the baseline ${b.baseline}`;
  const verdict = breached ? 'breach' : unknown ? 'unknown' : 'healthy';
  const summary =
    verdict === 'healthy'
      ? `CANARY HEALTHY ${service}/${env}: ${rounds.length} round${rounds.length === 1 ? '' : 's'} within limits`
      : verdict === 'unknown'
        ? `CANARY UNKNOWN ${service}/${env}: ${unknown}`
        : `CANARY BREACH ${service}/${env}: ${[...last.breaches.map(describe), ...(last.smoke === 'fail' ? ['smoke failed'] : [])].join('; ')}` +
          (rollback ? `; rollback ran (exit ${rollback.exitCode})` : '');
  return {
    command: 'canary',
    ok: verdict === 'healthy',
    exitCode: verdict === 'healthy' ? EXIT.ok : verdict === 'breach' ? EXIT.failed : EXIT.notReady,
    summary,
    data: {
      schema: 'vgate.canary/1',
      service,
      environment: env,
      source: cfg.source,
      verdict,
      rounds,
      unknown,
      rollback,
    },
    next: verdict === 'healthy' ? [] : [`${CLI} canary --service ${service} --env ${env}`],
    text: rollback ? [`rollback: ${rollback.command} -> exit ${rollback.exitCode}`, ...rollback.output] : [],
  };
}

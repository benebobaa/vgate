/**
 * Network faults between the service and a dependency, through toxiproxy: added latency (a slow provider) and an
 * outage (connections refused). Every fault is removed when the test ends, so a failed test cannot leave the stack
 * broken for the next one. Faults affect every caller of the dependency, so tests using them live in tests/faults/,
 * which the serial `faults` project runs alone.
 */
import type { DependencyConfig, HttpStubDependency, ToxiproxyDependency } from './config.ts';
import { frameworkFetch } from '../http/write-guard.ts';

export class Toxiproxy {
  private readonly toxics: Array<{ proxy: string; name: string }> = [];
  private readonly disabled = new Set<string>();

  constructor(private readonly config: ToxiproxyDependency) {}

  private async api(path: string, init: RequestInit = {}): Promise<void> {
    const response = await frameworkFetch(`${this.config.url}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`toxiproxy ${init.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  }

  /** Delays every response from `proxy` by `ms` (plus `jitterMs` at random). */
  async latency(proxy: string, ms: number, jitterMs = 0): Promise<void> {
    const name = `vgate-latency-${this.toxics.length}`;
    await this.api(`/proxies/${proxy}/toxics`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        type: 'latency',
        stream: 'downstream',
        attributes: { latency: ms, jitter: jitterMs },
      }),
    });
    this.toxics.push({ proxy, name });
  }

  /** Takes `proxy` down: new connections are refused and open ones closed. */
  async down(proxy: string): Promise<void> {
    await this.api(`/proxies/${proxy}`, { method: 'POST', body: JSON.stringify({ enabled: false }) });
    this.disabled.add(proxy);
  }

  /** Undoes every fault this instance made. */
  async restore(): Promise<void> {
    const toxics = this.toxics.splice(0);
    const disabled = [...this.disabled];
    this.disabled.clear();
    await Promise.all([
      ...toxics.map(({ proxy, name }) => this.api(`/proxies/${proxy}/toxics/${name}`, { method: 'DELETE' })),
      ...disabled.map((proxy) =>
        this.api(`/proxies/${proxy}`, { method: 'POST', body: JSON.stringify({ enabled: true }) }),
      ),
    ]);
  }
}

/** The proxy name of a dependency (its `proxy` field), with an error naming what is missing. */
export function proxyOf(deps: Record<string, DependencyConfig>, name: string): string {
  const dep = deps[name];
  if (!dep) throw new Error(`No dependency "${name}" in this environment (have: ${Object.keys(deps).join(', ')})`);
  const proxy = (dep as HttpStubDependency).proxy;
  if (dep.kind !== 'http-stub' || !proxy)
    throw new Error(
      `Dependency "${name}" has no toxiproxy proxy: set its proxy field in service.yaml to inject faults`,
    );
  return proxy;
}

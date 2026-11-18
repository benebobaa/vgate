import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Dependency failures through docker compose: a paused container accepts connections and never answers, the way
 * a hung dependency behaves. Only for disposable environments; tests that use it live in a `faults/` folder, which
 * the `faults` project runs alone after every other test.
 */
export class ComposeFaults {
  constructor(private readonly compose: { file: string; project?: string } | undefined) {}

  private async compose_(...args: string[]): Promise<void> {
    if (!this.compose) throw new Error('This environment has no compose: dependency faults cannot be injected');
    const base = ['compose', '-f', this.compose.file, ...(this.compose.project ? ['-p', this.compose.project] : [])];
    await run('docker', [...base, ...args]);
  }

  pause(service: string): Promise<void> {
    return this.compose_('pause', service);
  }

  unpause(service: string): Promise<void> {
    return this.compose_('unpause', service);
  }

  /** Runs `fn` while `service` is paused and always resumes it, then waits until `ready` reports true. */
  async whilePaused<T>(service: string, fn: () => Promise<T>, ready?: () => Promise<boolean>): Promise<T> {
    await this.pause(service);
    try {
      return await fn();
    } finally {
      await this.unpause(service);
      if (ready) await this.waitUntilReady(service, ready);
    }
  }

  private async waitUntilReady(service: string, ready: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (!(await ready().catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`${service} did not recover within 60s after unpause`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

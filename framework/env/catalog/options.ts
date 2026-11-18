/** Reading a kind's `options` (service.yaml) with defaults; shared by the catalog's kinds. */
import type { KindContext } from './types.ts';

export function option(ctx: KindContext, key: string, fallback: string): string {
  const value = ctx.options[key];
  return typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : fallback;
}

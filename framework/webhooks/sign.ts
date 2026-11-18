/**
 * Signs a webhook the way its provider does, so a test can deliver one to the service under test: HMAC over a payload
 * template, written into a header template. See docs/webhooks.md for the providers it expresses.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { WebhookConfig } from '../config.ts';

export interface SignOptions {
  /** Unix time in the config's unit; default now. An old one tests the replay window. */
  timestamp?: number;
  /** The delivery id for `{id}`; default a random UUID. */
  id?: string;
  /** Sign with another secret (a forged delivery). */
  secret?: string;
}

export interface Signed {
  headers: Record<string, string>;
  signature: string;
  timestamp: number;
  id: string;
}

function fill(template: string, values: Record<string, string>): string {
  // One pass: a body that contains `{timestamp}` is not substituted again.
  return template.replace(/\{(body|timestamp|id|signature)\}/g, (match, name: string) => values[name] ?? match);
}

function secretKey(secret: string, encoding: WebhookConfig['secretEncoding']): Buffer {
  if (encoding !== 'base64') return Buffer.from(secret, 'utf8');
  const underscore = secret.indexOf('_');
  return Buffer.from(underscore === -1 ? secret : secret.slice(underscore + 1), 'base64');
}

export function signWebhook(cfg: WebhookConfig, body: string, options: SignOptions = {}): Signed {
  const unitMs = cfg.timestampUnit === 'ms' ? 1 : 1000;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / unitMs);
  const id = options.id ?? randomUUID();
  const values = { body, timestamp: String(timestamp), id };
  const payload = fill(cfg.payload ?? '{body}', values);
  const signature = createHmac(cfg.algorithm ?? 'sha256', secretKey(options.secret ?? cfg.secret, cfg.secretEncoding))
    .update(payload, 'utf8')
    .digest(cfg.encoding ?? 'hex');
  const withSignature = { ...values, signature };
  const headers: Record<string, string> = { [cfg.header]: fill(cfg.format ?? '{signature}', withSignature) };
  for (const [name, template] of Object.entries(cfg.headers ?? {})) headers[name] = fill(template, withSignature);
  return { headers, signature, timestamp, id };
}

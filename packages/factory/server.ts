import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { auditWorkers, latestWorkerStates, type SideEffectProbe, type WorkerTrailRow } from './auditor.ts';
import {
  normalizeSignal,
  SIGNAL_SOURCES,
  verifyWebhookSignature,
  type SignalSource,
  type WorkSignal,
} from './connectors.ts';
import { clearStopOrder, issueStopOrder, readStopOrder } from './contract.ts';

export interface SignalDispatchResult {
  dispatched: boolean;
  workerId?: string;
  reason?: string;
}

export interface FactoryServerOptions {
  projectRoot: string;
  host?: string;
  port?: number;
  /** Bearer token required on control endpoints (`POST /stop`, `/resume`, `/audit`). */
  controlToken?: string;
  /** Only for unit tests: allow unauthenticated local control endpoints when `controlToken` is omitted. */
  allowUnauthenticatedControl?: boolean;
  webhookSecrets?: Partial<Record<SignalSource, string>>;
  onSignal?: (signal: WorkSignal) => Promise<SignalDispatchResult> | SignalDispatchResult;
  auditProbe?: (row: WorkerTrailRow) => SideEffectProbe;
}

export interface FactoryServerHandle {
  server: http.Server;
  start(): Promise<{ host: string; port: number; url: string }>;
  stop(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const VALID_SOURCES = new Set<string>(SIGNAL_SOURCES);

const SIGNATURE_HEADER_NAMES = [
  'x-hub-signature-256',
  'x-vgate-signature-256',
  'x-vgate-signature',
  'x-signature-256',
  'x-signature',
  'linear-signature',
  'x-slack-signature',
  'sentry-hook-signature',
] as const;

function extractSignatureHeader(headers: http.IncomingHttpHeaders): string | undefined {
  for (const name of SIGNATURE_HEADER_NAMES) {
    const value = headers[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
    if (Array.isArray(value) && value.length > 0 && value[0]) {
      return value[0];
    }
  }
  return undefined;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body exceeds maximum allowed size');
  }
}

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function verifyControlAuth(req: http.IncomingMessage, token: string | undefined, allowUnauth: boolean): boolean {
  if (!token) return allowUnauth;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = header.slice('Bearer '.length).trim();
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

export function createFactoryServer(options: FactoryServerOptions): FactoryServerHandle {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4810;
  const allowUnauth = options.allowUnauthenticatedControl === true;
  const queuedSignals: WorkSignal[] = [];

  const defaultProbe = (row: WorkerTrailRow): SideEffectProbe => ({
    commitSha: row.lastCommitSha,
    artifactCount: row.lastArtifactCount,
    processAlive: row.state === 'running',
  });

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://${host}`);
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/health') {
      const stopOrder = readStopOrder(options.projectRoot);
      const workers = [...latestWorkerStates(options.projectRoot).values()];
      const activeWorkers = workers.filter((worker) => worker.state === 'running').length;
      sendJson(res, 200, { ok: true, stopped: stopOrder.stopped, activeWorkers });
      return;
    }

    if (method === 'GET' && pathname === '/status') {
      const stopOrder = readStopOrder(options.projectRoot);
      const workers = [...latestWorkerStates(options.projectRoot).values()];
      sendJson(res, 200, {
        stopped: stopOrder.stopped,
        stopOrder,
        workers,
        signalsQueued: queuedSignals.length,
      });
      return;
    }

    if (method === 'POST' && pathname === '/stop') {
      if (!verifyControlAuth(req, options.controlToken, allowUnauth)) {
        sendJson(res, 401, { error: 'Unauthorized: bearer token required' });
        return;
      }
      const raw = await readRawBody(req);
      const body = parseJsonObject(raw);
      if (body === undefined) {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      const reason = typeof body.reason === 'string' ? body.reason : 'Stopped via control plane';
      const by = typeof body.by === 'string' ? body.by : undefined;
      const stopOrder = issueStopOrder(options.projectRoot, reason, by);
      sendJson(res, 200, { ok: true, stopOrder });
      return;
    }

    if (method === 'POST' && pathname === '/resume') {
      if (!verifyControlAuth(req, options.controlToken, allowUnauth)) {
        sendJson(res, 401, { error: 'Unauthorized: bearer token required' });
        return;
      }
      const stopOrder = clearStopOrder(options.projectRoot);
      sendJson(res, 200, { ok: true, stopOrder });
      return;
    }

    if (method === 'POST' && pathname === '/audit') {
      if (!verifyControlAuth(req, options.controlToken, allowUnauth)) {
        sendJson(res, 401, { error: 'Unauthorized: bearer token required' });
        return;
      }
      // Security invariant: never trust client-supplied nowMs; always use server clock.
      const report = auditWorkers(options.projectRoot, options.auditProbe ?? defaultProbe, Date.now());
      sendJson(res, 200, { ok: true, ...report });
      return;
    }

    if (method === 'POST' && pathname.startsWith('/webhooks/')) {
      const sourceSegment = decodeURIComponent(pathname.slice('/webhooks/'.length));
      if (!VALID_SOURCES.has(sourceSegment)) {
        sendJson(res, 400, { error: `Unknown signal source: ${sourceSegment}` });
        return;
      }
      const source = sourceSegment as SignalSource;
      const raw = await readRawBody(req);

      // Fail-closed: reject webhooks unless a secret is explicitly configured for this source.
      const configuredSecret = options.webhookSecrets?.[source];
      if (!configuredSecret) {
        sendJson(res, 401, { error: `No webhook secret configured for source "${source}" (fail-closed)` });
        return;
      }
      const signatureHeader = extractSignatureHeader(req.headers);
      if (!verifyWebhookSignature(raw, signatureHeader, configuredSecret)) {
        sendJson(res, 401, { error: 'Invalid webhook signature' });
        return;
      }

      const payload = parseJsonObject(raw);
      if (!payload || raw.trim().length === 0) {
        sendJson(res, 400, { error: 'Webhook body must be a JSON object' });
        return;
      }

      const signal = normalizeSignal(source, payload);
      const stopOrder = readStopOrder(options.projectRoot);
      if (stopOrder.stopped) {
        queuedSignals.push(signal);
        sendJson(res, 503, {
          accepted: false,
          held: true,
          reason: stopOrder.reason ?? 'Factory stopped by zero-writes stop order',
          signal,
        });
        return;
      }

      const dispatch: SignalDispatchResult = options.onSignal
        ? await options.onSignal(signal)
        : { dispatched: false, reason: 'No signal dispatcher configured' };

      if (!dispatch.dispatched) {
        queuedSignals.push(signal);
      }

      sendJson(res, 202, { accepted: true, signal, dispatch });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        return;
      }
      if (error instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : 'Internal server error';
      sendJson(res, 500, { error: message });
    });
  });

  return {
    server,
    start(): Promise<{ host: string; port: number; url: string }> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          const addr = server.address() as AddressInfo | null;
          if (!addr) {
            reject(new Error('Factory server failed to bind an address'));
            return;
          }
          resolve({
            host,
            port: addr.port,
            url: `http://${host}:${addr.port}`,
          });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.closeAllConnections?.();
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

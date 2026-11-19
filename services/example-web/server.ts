/**
 * example-web: a small web UI for the example notes API, the framework's reference for a frontend (README.md). It
 * serves public/ and forwards /api/* to the notes API, so the page talks to one origin only.
 *
 *   EXAMPLE_WEB_PORT=8094 EXAMPLE_WEB_API=http://localhost:8093 tsx services/example-web/server.ts
 *
 * EXAMPLE_WEB_CALL_HOME=1 plants a call to a third party in the page, to prove the sealed browser blocks it.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.EXAMPLE_WEB_PORT ?? 8094);
const api = (process.env.EXAMPLE_WEB_API ?? 'http://localhost:8093').replace(/\/$/, '');
const publicDir = join(import.meta.dirname, 'public');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function file(path: string): Buffer | undefined {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  try {
    return readFileSync(join(publicDir, safe));
  } catch {
    return undefined;
  }
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function forward(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const headers: Record<string, string> = {};
  for (const name of ['x-api-key', 'content-type']) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const method = req.method ?? 'GET';
  const payload = method === 'GET' || method === 'HEAD' ? undefined : await body(req);
  const upstream = await fetch(`${api}${path}`, { method, headers, body: payload });
  const text = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
  res.end(text);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const done = (status: number, text: string, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(text);
  };
  if (url.pathname === '/health') return done(200, JSON.stringify({ status: 'UP' }), 'application/json');
  if (url.pathname.startsWith('/api/')) {
    forward(req, res, `${url.pathname.slice('/api'.length)}${url.search}`).catch((error: unknown) =>
      done(502, `notes API unreachable: ${String(error)}`),
    );
    return;
  }
  if (req.method !== 'GET') return done(405, 'method not allowed');
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const content = file(path);
  if (!content) return done(404, 'not found');
  let out = content;
  if (path === '/index.html' && process.env.EXAMPLE_WEB_CALL_HOME === '1') {
    out = Buffer.from(
      content
        .toString('utf8')
        .replace('<!--CALL_HOME-->', `<script>fetch('https://example.com/beacon').catch(() => {});</script>`),
    );
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(out);
});

server.listen(port, () => process.stdout.write(`example-web on http://localhost:${port} (notes API ${api})\n`));

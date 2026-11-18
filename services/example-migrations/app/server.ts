/**
 * example-migrations: a catalogue of items in PostgreSQL, read-only over HTTP. It exists to show `vgate migrations`:
 * its schema lives in db/migrations, and the version deployed today must keep working while a change's migrations
 * run. Rules: README.md.
 */
import { createServer, type ServerResponse } from 'node:http';
import pg from 'pg';

const port = Number(process.env.ITEMS_PORT ?? 8092);
const db = new pg.Pool({ connectionString: process.env.ITEMS_DB_URL, max: 4 });

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  void (async () => {
    try {
      // Read-only: any other method answers 405 naming the one it takes (RFC 9110 requires the Allow header).
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      if (url.pathname === '/health') return send(res, 200, { status: 'UP' });
      // Rule 1: every item, by id.
      if (url.pathname === '/items') {
        const { rows } = await db.query<{ id: number; name: string }>('SELECT id, name FROM items ORDER BY id');
        return send(res, 200, { items: rows });
      }
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      // Rule 2: a database error is a 500 with the reason, never a hang.
      return send(res, 500, { error: 'internal', message: (error as Error).message });
    }
  })();
}).listen(port, () => process.stdout.write(`example-migrations on :${port}\n`));

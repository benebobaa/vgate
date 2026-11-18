/**
 * example-orders (README.md, openapi.yaml): an orders API with real dependencies - PostgreSQL, Redis, Kafka and a
 * third-party payment provider. It is the system under test of the framework's dependency example, written to follow
 * its README; it is not part of the framework.
 *
 * It runs as a container in the service's sealed environment (service.yaml `environment:`, app/Dockerfile), which
 * sets every variable below.
 *
 * ORDERS_CALL_HOME, when set, makes the app call that URL at start-up: a deliberate outbound call, so the framework's
 * self-check can show that a sealed environment refuses it and the gate names it (docs/environments.md).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Producer, stringSerializers } from '@platformatic/kafka';
import pg from 'pg';
import { createClient } from 'redis';

const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const port = Number(env('ORDERS_PORT', '8091'));
const clerkKey = env('ORDERS_CLERK_KEY', 'clerk-key');
const paymentsUrl = env('ORDERS_PAYMENTS_URL', 'http://localhost:58081');
const paymentTimeoutMs = Number(env('ORDERS_PAYMENT_TIMEOUT_MS', '2000')); // rule 4
const IDEMPOTENCY_TTL = 86_400; // rule 3
const ORDER_CACHE_TTL = 300; // rule 7
const TOPIC = 'orders.created';

const callHome = env('ORDERS_CALL_HOME', '');
if (callHome !== '') {
  fetch(callHome, { signal: AbortSignal.timeout(3000) })
    .then(() => process.stdout.write(`called ${callHome}\n`))
    .catch((error: Error) => process.stderr.write(`call home to ${callHome} failed: ${error.message}\n`));
}

const db = new pg.Pool({
  connectionString: env('ORDERS_DB_URL', 'postgres://orders:orders@localhost:55432/orders'),
  max: 8,
});
const redis = createClient({ url: env('ORDERS_REDIS_URL', 'redis://localhost:56379') });
redis.on('error', (error: Error) => process.stderr.write(`redis: ${error.message}\n`));
const producer = new Producer({
  clientId: 'example-orders',
  bootstrapBrokers: env('ORDERS_KAFKA_BROKERS', 'localhost:59092').split(','),
  serializers: stringSerializers,
});

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: 'IDR' | 'USD';
  status: 'paid';
  chargeId: string;
  createdAt: string;
}

type OrderInput = Pick<Order, 'customerId' | 'amount' | 'currency'>;

class Reject extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.setHeader('X-Request-Id', randomUUID());
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new Reject(400, 'bad_request', 'the body must be application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Reject(400, 'bad_request', 'the body is not valid JSON');
  }
}

/** Rule 2. */
function orderInput(raw: unknown): OrderInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Reject(400, 'bad_request', 'the body must be an object');
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !['customerId', 'amount', 'currency'].includes(key));
  if (unknown.length > 0) throw new Reject(400, 'bad_request', `unknown field ${unknown[0]}`);
  const { customerId, amount, currency } = input;
  if (typeof customerId !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(customerId))
    throw new Reject(400, 'bad_request', 'customerId must match ^[a-z0-9._-]{1,64}$');
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > 100_000_000)
    throw new Reject(400, 'bad_request', 'amount must be an integer from 1 to 100000000');
  if (currency !== 'IDR' && currency !== 'USD') throw new Reject(400, 'bad_request', 'currency must be IDR or USD');
  return { customerId, amount, currency };
}

const requestHash = (input: OrderInput) =>
  createHash('sha256')
    .update(JSON.stringify([input.customerId, input.amount, input.currency]))
    .digest('hex');

/** Rule 4: the provider's answer, mapped to ours. Returns the charge id. */
async function charge(input: OrderInput, reference: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${paymentsUrl}/charges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: input.amount, currency: input.currency, customer: input.customerId, reference }),
      signal: AbortSignal.timeout(paymentTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new Reject(504, 'payment_timeout', `the payment provider did not answer within ${paymentTimeoutMs}ms`);
    throw new Reject(503, 'payment_unavailable', 'the payment provider cannot be reached');
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new Reject(504, 'payment_timeout', `the payment provider did not answer within ${paymentTimeoutMs}ms`);
  }
  if (response.status === 201 && typeof body.id === 'string') return body.id;
  if (response.status === 402)
    throw new Reject(402, 'payment_declined', 'the payment provider declined the charge', {
      reason: typeof body.code === 'string' ? body.code : 'unknown',
    });
  throw new Reject(503, 'payment_unavailable', `the payment provider answered ${response.status}`);
}

const fromRow = (row: Record<string, unknown>): Order => ({
  id: String(row.id),
  customerId: String(row.customer_id),
  amount: Number(row.amount),
  currency: row.currency as Order['currency'],
  status: 'paid',
  chargeId: String(row.charge_id),
  createdAt: (row.created_at as Date).toISOString(),
});

async function createOrder(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
  // Rule 2: the header, then the body.
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{8,64}$/.test(key))
    throw new Reject(400, 'bad_request', 'Idempotency-Key must match ^[A-Za-z0-9._-]{8,64}$');
  const input = orderInput(await readJson(req));
  const hash = requestHash(input);

  // Rule 3: a repeat returns the first result; the same key for another request is a conflict.
  const remembered = await redis.get(`idempotency:${key}`);
  if (remembered) {
    const first = JSON.parse(remembered) as { hash: string; order: Order };
    if (first.hash !== hash)
      throw new Reject(409, 'idempotency_conflict', 'this Idempotency-Key was used for a different request');
    return { status: 201, body: first.order };
  }

  // Rules 4 and 5: charge first; only a paid order is written, published and remembered.
  const chargeId = await charge(input, key);
  const { rows } = await db.query(
    `INSERT INTO orders (id, customer_id, amount, currency, status, charge_id, idempotency_key)
     VALUES ($1, $2, $3, $4, 'paid', $5, $6) RETURNING *`,
    [randomUUID(), input.customerId, input.amount, input.currency, chargeId, key],
  );
  const order = fromRow(rows[0] as Record<string, unknown>);
  await producer.send({
    messages: [
      {
        topic: TOPIC,
        key: order.id,
        value: JSON.stringify({
          orderId: order.id,
          customerId: order.customerId,
          amount: order.amount,
          currency: order.currency,
          chargeId: order.chargeId,
          createdAt: order.createdAt,
        }),
      },
    ],
  });
  await redis.set(`idempotency:${key}`, JSON.stringify({ hash, order }), { EX: IDEMPOTENCY_TTL });
  return { status: 201, body: order };
}

/** Rule 7: read through the cache. */
async function getOrder(id: string): Promise<Order> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new Reject(404, 'not_found', 'no order with that id');
  const cached = await redis.get(`order:${id}`);
  if (cached) return JSON.parse(cached) as Order;
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (rows.length === 0) throw new Reject(404, 'not_found', `no order ${id}`);
  const order = fromRow(rows[0] as Record<string, unknown>);
  await redis.set(`order:${id}`, JSON.stringify(order), { EX: ORDER_CACHE_TTL });
  return order;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  if (url.pathname === '/health') {
    if (method !== 'GET') return send(res, 405, undefined, { Allow: 'GET' });
    await db.query('SELECT 1');
    await redis.ping();
    return send(res, 200, { status: 'UP' });
  }
  const item = /^\/orders\/([^/]+)$/.exec(url.pathname);
  const allowed = url.pathname === '/orders' ? ['POST'] : item ? ['GET'] : undefined;
  if (!allowed) throw new Reject(404, 'not_found', `no resource ${url.pathname}`);
  if (!allowed.includes(method)) return send(res, 405, undefined, { Allow: allowed.join(', ') });

  // Rule 1: the key before anything else.
  if (req.headers['x-api-key'] !== clerkKey) throw new Reject(401, 'unauthorized', 'a valid X-Api-Key is required');

  if (!item) {
    const { status, body } = await createOrder(req);
    return send(res, status, body);
  }
  let id: string;
  try {
    id = decodeURIComponent(item[1]);
  } catch {
    throw new Reject(404, 'not_found', 'no order with that id');
  }
  return send(res, 200, await getOrder(id));
}

async function main(): Promise<void> {
  await redis.connect();
  await db.query(`CREATE TABLE IF NOT EXISTS orders (
    id uuid PRIMARY KEY,
    customer_id text NOT NULL,
    amount bigint NOT NULL,
    currency text NOT NULL,
    status text NOT NULL,
    charge_id text NOT NULL,
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof Reject) {
        const headers: Record<string, string> = error.status === 401 ? { 'WWW-Authenticate': 'ApiKey' } : {};
        send(res, error.status, { error: error.kind, message: error.message, ...error.extra }, headers);
      } else {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        send(res, 500, { error: 'internal', message: String(error) });
      }
    });
  }).listen(port, () => process.stdout.write(`example-orders listening on :${port}\n`));
}

main().catch((error: unknown) => {
  process.stderr.write(`example-orders failed to start: ${String(error)}\n`);
  process.exit(1);
});

/**
 * LocalStack: AWS APIs on one port. Options: services (default `s3,sqs,sns`), region (default `us-east-1`),
 * `buckets: [...]`, `queues: [...]`, `topics: [...]` created once healthy, and `authToken` (LOCALSTACK_AUTH_TOKEN,
 * written as `${VAR}`) for images that need one.
 */
import { option } from './options.ts';
import type { DependencyKind, KindContext } from './types.ts';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function names(ctx: KindContext, key: 'buckets' | 'queues' | 'topics'): string[] {
  const raw = ctx.options[key];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((name) => typeof name === 'string' && NAME.test(name)))
    throw new Error(`${ctx.name}.${key} must be a list of names (letters, digits, . _ -)`);
  return raw as string[];
}

export const localstack: DependencyKind = {
  kind: 'localstack',
  defaultImage: 'localstack/localstack:2026.10.8',
  ports: { main: 4566 },
  environment: (ctx) => {
    const env: Record<string, string> = {
      SERVICES: option(ctx, 'services', 's3,sqs,sns'),
      AWS_DEFAULT_REGION: option(ctx, 'region', 'us-east-1'),
      // Keep LocalStack inside the environment: no usage reporting, no update checks.
      DISABLE_EVENTS: '1',
      SKIP_INFRA_DOWNLOADS: '1',
    };
    const token = option(ctx, 'authToken', '');
    if (token) env.LOCALSTACK_AUTH_TOKEN = token;
    return env;
  },
  health: { http: { port: 'main', path: '/_localstack/health' } },
  healthTimeout: 120,
  setup: (ctx) => [
    ...names(ctx, 'buckets').map((name) => ['awslocal', 's3api', 'create-bucket', '--bucket', name]),
    ...names(ctx, 'queues').map((name) => ['awslocal', 'sqs', 'create-queue', '--queue-name', name]),
    ...names(ctx, 'topics').map((name) => ['awslocal', 'sns', 'create-topic', '--name', name]),
  ],
  exports: (endpoint, ctx) => {
    const url = `http://${endpoint.host}:${endpoint.ports.main}`;
    return {
      url,
      endpoint: url,
      host: endpoint.host,
      port: String(endpoint.ports.main),
      region: option(ctx, 'region', 'us-east-1'),
      // LocalStack accepts any credentials; these are the ones its documentation uses.
      accessKey: 'test',
      secretKey: 'test',
    };
  },
};

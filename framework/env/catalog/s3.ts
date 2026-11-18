/**
 * An S3-compatible object store (SeaweedFS's S3 gateway, Apache-2.0). Options: `buckets: [name...]`, created once
 * healthy; region (default `us-east-1`). Without an identity file the gateway accepts any credentials, so the app
 * signs with the exported keys exactly as it would against AWS.
 *
 * Not MinIO: MinIO no longer publishes container images, and a catalog entry must pin an image that exists.
 */
import { option } from './options.ts';
import type { DependencyKind, KindContext } from './types.ts';

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function bucketsOf(ctx: KindContext): string[] {
  const raw = ctx.options.buckets;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((name) => typeof name === 'string' && BUCKET.test(name)))
    throw new Error(`${ctx.name}.buckets must be a list of S3 bucket names (3-63 of a-z 0-9 . -)`);
  return raw as string[];
}

export const s3: DependencyKind = {
  kind: 's3',
  defaultImage: 'chrislusf/seaweedfs:4.54',
  ports: { main: 8333 },
  command: () => ['server', '-dir=/data', '-s3', '-s3.port=8333', '-master.volumeSizeLimitMB=64', '-volume.max=0'],
  // The S3 gateway answers only once master, volume and filer are up behind it.
  health: { http: { port: 'main', path: '/status' } },
  healthTimeout: 90,
  setup: (ctx) => bucketsOf(ctx).map((name) => ['sh', '-c', `echo "s3.bucket.create -name ${name}" | weed shell`]),
  exports: (endpoint, ctx) => {
    const url = `http://${endpoint.host}:${endpoint.ports.main}`;
    return {
      url,
      endpoint: url,
      host: endpoint.host,
      port: String(endpoint.ports.main),
      region: option(ctx, 'region', 'us-east-1'),
      accessKey: 'vgate',
      secretKey: 'vgate-secret',
    };
  },
};

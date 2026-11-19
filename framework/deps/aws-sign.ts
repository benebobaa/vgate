/**
 * AWS Signature Version 4 for the few calls the tests make to S3-compatible stores and LocalStack. A hundred lines of
 * node:crypto instead of the AWS SDK (tens of megabytes in every project's runtime), held to AWS's own published
 * example in aws-sign.test.ts.
 */
import { createHash, createHmac } from 'node:crypto';
import { frameworkFetch } from '../http/write-guard.ts';

export interface AwsCredentials {
  accessKey: string;
  secretKey: string;
  region: string;
  /** `s3`, `sqs`, `sns`... */
  service: string;
}

export interface SignableRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Signing time; default now. */
  now?: Date;
  /** S3 needs `x-amz-content-sha256` on every request; other services do not sign it. */
  contentSha256Header?: boolean;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
export function awsEncode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `20150830T123600Z` */
export function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function canonicalRequest(
  req: SignableRequest,
  headers: Record<string, string>,
): { text: string; signedHeaders: string } {
  const url = new URL(req.url);
  // Each path segment encoded once; the URL parser has already percent-decoded nothing, so decode then encode.
  const path = url.pathname
    .split('/')
    .map((segment) => awsEncode(decodeURIComponent(segment)))
    .join('/');
  const query = [...url.searchParams.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const lower = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const signedHeaders = lower.map(([name]) => name).join(';');
  const text = [
    req.method.toUpperCase(),
    path || '/',
    query,
    lower.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    sha256(req.body ?? ''),
  ].join('\n');
  return { text, signedHeaders };
}

/** The request's headers plus `Authorization`, `X-Amz-Date` (and `x-amz-content-sha256` for S3). */
export function signRequest(req: SignableRequest, creds: AwsCredentials): Record<string, string> {
  const now = req.now ?? new Date();
  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);
  const host = new URL(req.url).host;
  const headers: Record<string, string> = { ...req.headers, host, 'x-amz-date': stamp };
  if (req.contentSha256Header) headers['x-amz-content-sha256'] = sha256(req.body ?? '');
  const { text, signedHeaders } = canonicalRequest(req, headers);
  const scope = `${day}/${creds.region}/${creds.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(text)].join('\n');
  let key = hmac(`AWS4${creds.secretKey}`, day);
  for (const part of [creds.region, creds.service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  // `host` is set by fetch itself; sending it twice is refused by some servers.
  const { host: _host, ...out } = headers;
  return {
    ...out,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** fetch with SigV4; the body is sent exactly as signed. */
export async function awsFetch(
  req: Omit<SignableRequest, 'now'>,
  creds: AwsCredentials,
): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await frameworkFetch(req.url, {
    method: req.method,
    headers: signRequest(req, creds),
    body: req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : Buffer.from(req.body),
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

/** The text of every `<tag>...</tag>` in an XML answer (S3 and SQS speak XML; their answers are flat enough). */
export function xmlValues(xml: string, tag: string): string[] {
  const decode = (text: string) =>
    text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/g, '&');
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) => decode(match[1]));
}

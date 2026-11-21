/**
 * Cryptographic verdict signing & verification (`vgate.signature/1`).
 *
 * Signing keys (`VGATE_SIGNING_KEY` for HMAC-SHA256, or `VGATE_SIGNING_PRIVATE_KEY` / `VGATE_SIGNING_PUBLIC_KEY` for
 * Ed25519) are held strictly by the CI verdict job or Layer 1 control plane and stripped from worker sandboxes by
 * `sanitizeWorkerEnv()`. `vgate decide` verifies signatures fail-closed whenever a verification key is configured.
 */
import { createHmac, sign, timingSafeEqual, verify } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type SignatureAlgorithm = 'hmac-sha256' | 'ed25519';

export interface OidcClaims {
  issuer?: string;
  subject?: string;
  repository?: string;
  workflowRef?: string;
  runId?: string;
}

export interface EvidenceSignature {
  schema: 'vgate.signature/1';
  algorithm: SignatureAlgorithm;
  keyId: string;
  signedAt: string;
  digest: string;
  oidc?: OidcClaims;
}

export interface SignedEnvelope<T = unknown> {
  payload: T;
  signature: EvidenceSignature;
}

/** Deterministic JSON serialization with recursively sorted object keys so signature verification is canonical. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export interface SignOptions {
  algorithm?: SignatureAlgorithm;
  /** Shared HMAC secret (for `hmac-sha256`) or PEM-encoded Ed25519 private key (for `ed25519`). */
  key: string;
  keyId?: string;
  oidc?: OidcClaims;
  signedAt?: string;
}

export function signEvidence<T>(payload: T, options: SignOptions): SignedEnvelope<T> {
  if (!options.key || options.key.trim().length === 0) {
    throw new Error('Signing key must be non-empty');
  }
  const algorithm: SignatureAlgorithm =
    options.algorithm ?? (options.key.includes('BEGIN') ? 'ed25519' : 'hmac-sha256');
  const signedAt = options.signedAt ?? new Date().toISOString();
  const keyId = options.keyId ?? 'ci-verdict';
  const body = canonicalJson({ payload, algorithm, keyId, signedAt, ...(options.oidc ? { oidc: options.oidc } : {}) });

  let digest: string;
  if (algorithm === 'ed25519') {
    digest = sign(null, Buffer.from(body, 'utf8'), options.key).toString('base64');
  } else {
    digest = createHmac('sha256', options.key).update(body, 'utf8').digest('hex');
  }

  return {
    payload,
    signature: {
      schema: 'vgate.signature/1',
      algorithm,
      keyId,
      signedAt,
      digest,
      ...(options.oidc ? { oidc: options.oidc } : {}),
    },
  };
}

export interface VerifySignatureOptions {
  /** Shared HMAC secret (for `hmac-sha256`) or PEM-encoded Ed25519 public key (for `ed25519`). */
  key: string;
  /** Expected algorithm; when omitted, derived strictly from the key format (PEM -> ed25519, else hmac-sha256). */
  expectedAlgorithm?: SignatureAlgorithm;
  expectedIssuer?: string;
  expectedRepository?: string;
}

export function verifyEvidenceSignature(
  envelope: SignedEnvelope<unknown> | undefined,
  options: VerifySignatureOptions,
): { ok: boolean; reason?: string } {
  if (!envelope || !envelope.signature || envelope.signature.schema !== 'vgate.signature/1') {
    return { ok: false, reason: 'Missing or invalid vgate.signature/1 envelope (fail-closed).' };
  }
  if (!options.key || options.key.trim().length === 0) {
    return { ok: false, reason: 'Verification key is empty (fail-closed).' };
  }

  const sig = envelope.signature;
  // Security invariant: never let the untrusted envelope pick the verification algorithm (prevents Ed25519 PEM -> HMAC confusion).
  const expectedAlgorithm: SignatureAlgorithm =
    options.expectedAlgorithm ?? (options.key.includes('BEGIN') ? 'ed25519' : 'hmac-sha256');
  if (sig.algorithm !== expectedAlgorithm) {
    return {
      ok: false,
      reason: `Signature algorithm mismatch: key requires "${expectedAlgorithm}", envelope declared "${String(sig.algorithm)}".`,
    };
  }
  if (options.expectedIssuer && sig.oidc?.issuer !== options.expectedIssuer) {
    return {
      ok: false,
      reason: `OIDC issuer mismatch: expected "${options.expectedIssuer}", got "${sig.oidc?.issuer ?? 'none'}".`,
    };
  }
  if (options.expectedRepository && sig.oidc?.repository !== options.expectedRepository) {
    return {
      ok: false,
      reason: `OIDC repository mismatch: expected "${options.expectedRepository}", got "${sig.oidc?.repository ?? 'none'}".`,
    };
  }

  const body = canonicalJson({
    payload: envelope.payload,
    algorithm: sig.algorithm,
    keyId: sig.keyId,
    signedAt: sig.signedAt,
    ...(sig.oidc ? { oidc: sig.oidc } : {}),
  });

  try {
    if (expectedAlgorithm === 'ed25519') {
      const ok = verify(null, Buffer.from(body, 'utf8'), options.key, Buffer.from(sig.digest, 'base64'));
      return ok ? { ok: true } : { ok: false, reason: 'Ed25519 signature verification failed.' };
    }
    const expected = createHmac('sha256', options.key).update(body, 'utf8').digest();
    const actual = Buffer.from(sig.digest, 'hex');
    if (expected.length !== actual.length) return { ok: false, reason: 'HMAC-SHA256 digest length mismatch.' };
    return timingSafeEqual(expected, actual)
      ? { ok: true }
      : { ok: false, reason: 'HMAC-SHA256 signature verification failed.' };
  } catch (error) {
    return {
      ok: false,
      reason: `Signature verification error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Attaches CI environment provenance metadata (repository, workflow ref, run ID) from `process.env` inside an
 * HMAC-SHA256 or Ed25519 signed envelope. Note: this records environment claims signed by `VGATE_SIGNING_*`; it does
 * NOT fetch or verify a GitHub/GitLab OIDC JWT against a provider JWKS.
 */
export function ciOidcClaims(env: NodeJS.ProcessEnv = process.env): OidcClaims | undefined {
  if (env.GITHUB_ACTIONS === 'true') {
    return {
      issuer: 'https://token.actions.githubusercontent.com',
      repository: env.GITHUB_REPOSITORY,
      workflowRef: env.GITHUB_WORKFLOW_REF,
      runId: env.GITHUB_RUN_ID,
    };
  }
  if (env.GITLAB_CI === 'true') {
    return {
      issuer: env.CI_SERVER_URL,
      repository: env.CI_PROJECT_PATH,
      workflowRef: env.CI_PIPELINE_SOURCE,
      runId: env.CI_PIPELINE_ID,
    };
  }
  return undefined;
}

/**
 * Writes an evidence JSON file, automatically wrapping it in a `vgate.signature/1` signed envelope whenever a signing
 * key is provided (or `VGATE_SIGNING_PRIVATE_KEY` / `VGATE_SIGNING_KEY` is set in the environment).
 */
export function writeSignedOrPlainJson(filePath: string, payload: unknown, explicitKey?: string): boolean {
  const key = explicitKey ?? process.env.VGATE_SIGNING_PRIVATE_KEY ?? process.env.VGATE_SIGNING_KEY;
  mkdirSync(dirname(filePath), { recursive: true });
  if (key && key.trim().length > 0) {
    const signed = signEvidence(payload, { key, oidc: ciOidcClaims() });
    writeFileSync(filePath, `${JSON.stringify(signed, null, 2)}\n`);
    return true;
  }
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return false;
}

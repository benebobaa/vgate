import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import type { WebhookConfig } from '../config.ts';
import { signWebhook } from './sign.ts';

// The shape of a Stripe-like `t=..,v1=..` header, HMAC-SHA256 hex over `{timestamp}.{body}`.
const stripeLike: WebhookConfig = {
  path: '/hooks/pay',
  secret: 'whsec_test',
  header: 'PayBridge-Signature',
  payload: '{timestamp}.{body}',
  format: 't={timestamp},v1={signature}',
};

describe('signWebhook', () => {
  it('signs `{timestamp}.{body}` into a `t=..,v1=..` header, as an independent HMAC computes it', () => {
    const body = '{"order":"o-1","amount":5000}';
    const signed = signWebhook(stripeLike, body, { timestamp: 1755612912 });
    const expected = createHmac('sha256', 'whsec_test').update(`1755612912.${body}`).digest('hex');
    assert.equal(signed.signature, expected);
    assert.deepEqual(signed.headers, { 'PayBridge-Signature': `t=1755612912,v1=${expected}` });
  });

  it('defaults to the current time in seconds, or milliseconds when configured', () => {
    const before = Math.floor(Date.now() / 1000);
    assert.ok(signWebhook(stripeLike, '{}').timestamp >= before);
    assert.ok(signWebhook({ ...stripeLike, timestampUnit: 'ms' }, '{}').timestamp > before * 1000);
  });

  it('signs the body alone by default, in base64 when asked, with another algorithm', () => {
    const plain: WebhookConfig = { path: '/h', secret: 's', header: 'X-Sig', algorithm: 'sha512', encoding: 'base64' };
    const signed = signWebhook(plain, 'hello');
    assert.equal(signed.headers['X-Sig'], createHmac('sha512', 's').update('hello').digest('base64'));
  });

  it('expresses Standard Webhooks: base64 secret after the prefix, `{id}.{timestamp}.{body}`, id and time headers', () => {
    const key = Buffer.from('0123456789abcdef');
    const cfg: WebhookConfig = {
      path: '/h',
      secret: `whsec_${key.toString('base64')}`,
      secretEncoding: 'base64',
      encoding: 'base64',
      payload: '{id}.{timestamp}.{body}',
      header: 'webhook-signature',
      format: 'v1,{signature}',
      headers: { 'webhook-id': '{id}', 'webhook-timestamp': '{timestamp}' },
    };
    const signed = signWebhook(cfg, '{"a":1}', { id: 'msg_1', timestamp: 1700000000 });
    const expected = createHmac('sha256', key).update('msg_1.1700000000.{"a":1}').digest('base64');
    assert.deepEqual(signed.headers, {
      'webhook-signature': `v1,${expected}`,
      'webhook-id': 'msg_1',
      'webhook-timestamp': '1700000000',
    });
  });

  it('does not substitute placeholders inside the body, and signs with another secret when asked', () => {
    const body = '{"note":"{timestamp}"}';
    const signed = signWebhook(stripeLike, body, { timestamp: 1, secret: 'forged' });
    assert.equal(signed.signature, createHmac('sha256', 'forged').update(`1.${body}`).digest('hex'));
  });
});

# Signed webhooks

A service that receives webhooks from a provider (a payment gateway, an email service) verifies the provider's
signature. Tests deliver webhooks signed exactly as the provider signs them, so they can also build the deliveries a
verifier must refuse: old, forged, unsigned, tampered.

```ts
await api.webhook('doit', { event: 'payment.paid', orderId }); // signed, validated against the contract
await api.webhook('doit', payload, { timestamp: Math.floor(Date.now() / 1000) - 8 * 24 * 3600 }); // too old
await api.webhook('doit', payload, { secret: 'whsec_forged' }); // forged
await api.webhook('doit', payload, { unsigned: true }); // no signature header
await api.webhook('doit', payload, { bodyAfterSigning: JSON.stringify({ ...payload, amount: 1 }) }); // tampered
```

The delivery is a call like any other: it goes to the configured path, without an `Origin` (a provider is not a
browser) and without user credentials, and its answer is held to the contract.

## service.yaml

```yaml
environments:
  local:
    webhooks:
      doit:
        path: /api/v1/webhooks/doit
        method: POST # default
        secret: '${DOIT_SIGNING_SECRET}' # per environment: the same value the service under test is given
        header: PayBridge-Signature
        payload: '{timestamp}.{body}' # what is signed; default '{body}'
        format: 't={timestamp},v1={signature}' # the header's value; default '{signature}'
        algorithm: sha256 # sha256 (default), sha1, sha512
        encoding: hex # hex (default) or base64
        timestampUnit: s # s (default) or ms
```

Placeholders: `{body}` (the raw body as sent), `{timestamp}`, `{id}` (a fresh UUID per delivery, or `{ id }`), and in
`format` and `headers` also `{signature}`. Substitution is one pass: a body containing `{timestamp}` stays as it is.

## Providers it expresses

| Scheme                                                                          | Configuration                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stripe-like `t=<ts>,v1=<hex>` over `<ts>.<body>` (e.g. Doit)                    | `payload: '{timestamp}.{body}'`, `format: 't={timestamp},v1={signature}'`                                                                                                                                                                  |
| Plain HMAC of the body in a header (GitHub `X-Hub-Signature-256: sha256=<hex>`) | `header: X-Hub-Signature-256`, `format: 'sha256={signature}'`                                                                                                                                                                              |
| Standard Webhooks / Svix                                                        | `secret: whsec_<base64>`, `secretEncoding: base64`, `encoding: base64`, `payload: '{id}.{timestamp}.{body}'`, `header: webhook-signature`, `format: 'v1,{signature}'`, `headers: { webhook-id: '{id}', webhook-timestamp: '{timestamp}' }` |
| Shopify `X-Shopify-Hmac-Sha256: <base64>` of the body                           | `encoding: base64`                                                                                                                                                                                                                         |

Not expressible: asymmetric signatures (Ed25519, RSA; e.g. Standard Webhooks `v1a`), and schemes that sign headers or
the URL beyond the placeholders above.

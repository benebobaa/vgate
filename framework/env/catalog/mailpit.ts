/**
 * Mailpit: an SMTP server that delivers nothing anywhere and keeps every message for the tests (framework/deps/email.ts
 * reads them through its HTTP API). It accepts any SMTP login, so an app configured with credentials works unchanged.
 * No options.
 */
import type { DependencyKind } from './types.ts';

export const mailpit: DependencyKind = {
  kind: 'mailpit',
  defaultImage: 'axllent/mailpit:v1.34.0',
  ports: { smtp: 1025, api: 8025 },
  environment: () => ({ MP_SMTP_AUTH_ACCEPT_ANY: '1', MP_SMTP_AUTH_ALLOW_INSECURE: '1', MP_MAX_MESSAGES: '5000' }),
  health: { http: { port: 'api', path: '/readyz' } },
  exports: (endpoint) => ({
    smtpHost: endpoint.host,
    smtpPort: String(endpoint.ports.smtp),
    smtpUrl: `smtp://${endpoint.host}:${endpoint.ports.smtp}`,
    url: `http://${endpoint.host}:${endpoint.ports.api}`,
    apiUrl: `http://${endpoint.host}:${endpoint.ports.api}`,
    host: endpoint.host,
  }),
};

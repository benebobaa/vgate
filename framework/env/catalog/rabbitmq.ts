/**
 * RabbitMQ with its management API. Options: user and password (default `app`), vhost (default `/`). Queues and
 * exchanges are the app's to declare (or the tests', through the amqp helper), as on a real broker.
 */
import { option } from './options.ts';
import type { DependencyKind, KindContext } from './types.ts';

export const rabbitCredentials = (ctx: KindContext) => ({
  user: option(ctx, 'user', 'app'),
  password: option(ctx, 'password', 'app'),
  vhost: option(ctx, 'vhost', '/'),
});

export const rabbitmq: DependencyKind = {
  kind: 'rabbitmq',
  defaultImage: 'rabbitmq:4.4.1-management-alpine',
  ports: { main: 5672, management: 15672 },
  environment: (ctx) => {
    const c = rabbitCredentials(ctx);
    return { RABBITMQ_DEFAULT_USER: c.user, RABBITMQ_DEFAULT_PASS: c.password, RABBITMQ_DEFAULT_VHOST: c.vhost };
  },
  // Every listener answers, so the broker accepts the app's connection. Only once the broker has written its Erlang
  // cookie: run earlier, the CLI (as root) would create the cookie itself, owned by root, and the broker could then
  // never read it and would crash on start.
  health: {
    exec: ['sh', '-c', 'test -f /var/lib/rabbitmq/.erlang.cookie && rabbitmq-diagnostics -q check_port_connectivity'],
  },
  healthTimeout: 120,
  exports: (endpoint, ctx) => {
    const c = rabbitCredentials(ctx);
    const vhost = c.vhost === '/' ? '' : `/${encodeURIComponent(c.vhost)}`;
    const auth = `${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}`;
    return {
      url: `amqp://${auth}@${endpoint.host}:${endpoint.ports.main}${vhost}`,
      managementUrl: `http://${endpoint.host}:${endpoint.ports.management}`,
      host: endpoint.host,
      port: String(endpoint.ports.main),
      user: c.user,
      password: c.password,
      vhost: c.vhost,
    };
  },
};

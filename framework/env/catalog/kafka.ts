/**
 * Kafka, single node (KRaft). Two listeners: `main` for the app inside the environment and `external` for the tests,
 * advertised as the host port the edge publishes, so a client on the host is never sent to an address it cannot dial.
 * Options: `topics: { name: { partitions?, schema? } }`, created once healthy (auto-creation is off, as on a real
 * platform).
 */
import { option } from './options.ts';
import type { DependencyKind, KindContext } from './types.ts';

const BIN = '/opt/kafka/bin';

function topics(ctx: KindContext): Array<[string, number]> {
  const raw = ctx.options.topics;
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw as Record<string, unknown>).map(([name, value]) => {
    const partitions = (value as { partitions?: unknown } | null)?.partitions;
    return [name, typeof partitions === 'number' && partitions > 0 ? partitions : 3];
  });
}

export const kafka: DependencyKind = {
  kind: 'kafka',
  defaultImage: 'apache/kafka:4.1.0',
  ports: { main: 9092, external: 19092 },
  published: ['external'],
  environment: (ctx) => ({
    KAFKA_NODE_ID: '1',
    KAFKA_PROCESS_ROLES: 'broker,controller',
    KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093,EXTERNAL://:19092',
    KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://${ctx.name}:9092,EXTERNAL://${ctx.external.host}:${ctx.external.ports.external}`,
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,EXTERNAL:PLAINTEXT',
    KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
    KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
    KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
    // A test broker needs little memory; the image's default heap (1 GB) crowds a CI runner or a laptop's Docker VM.
    KAFKA_HEAP_OPTS: option(ctx, 'heap', '-Xms256m -Xmx512m'),
  }),
  health: { exec: [`${BIN}/kafka-topics.sh`, '--bootstrap-server', 'localhost:9092', '--list'] },
  healthTimeout: 120,
  setup: (ctx) =>
    topics(ctx).map(([name, partitions]) => [
      `${BIN}/kafka-topics.sh`,
      '--bootstrap-server',
      'localhost:9092',
      '--create',
      '--if-not-exists',
      '--topic',
      name,
      '--partitions',
      String(partitions),
      '--replication-factor',
      '1',
    ]),
  exports: (endpoint, ctx) => {
    // Inside, the app dials the internal listener; from the host, the tests dial the external one.
    const port = endpoint.host === ctx.name ? endpoint.ports.main : endpoint.ports.external;
    return { brokers: `${endpoint.host}:${port}`, host: endpoint.host, port: String(port) };
  },
};

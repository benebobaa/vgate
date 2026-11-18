/**
 * More dependency kinds: one file per kind next to this one, each exporting a `DependencyKind`, listed here. index.ts
 * registers them after the core kinds. docs/catalog.md describes each: options, exports, the test helper.
 */
import { keycloak } from './keycloak.ts';
import { localstack } from './localstack.ts';
import { mailpit } from './mailpit.ts';
import { mongodb } from './mongodb.ts';
import { mysql } from './mysql.ts';
import { rabbitmq } from './rabbitmq.ts';
import { s3 } from './s3.ts';
import type { DependencyKind } from './types.ts';

export const CATALOG_EXTRA: DependencyKind[] = [mysql, mongodb, rabbitmq, s3, mailpit, localstack, keycloak];

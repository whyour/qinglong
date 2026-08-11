import {
  POSTGRESQL_MAIN_MIGRATION_STREAM_ID,
  type PostgresMigrationContext,
} from '../adapters/postgresMigrationStreamStore';
import type { MigrationStreamDefinition } from '../core/migrationStream';
import { pg0001SchemaCapabilityMigration } from './pg-0001-schema-capability';
import { pg0002RunCoreMigration } from './pg-0002-run-core';
import { pg0003RunRetryPolicyMigration } from './pg-0003-run-retry-policy';

export const postgresqlMainMigrationStream: MigrationStreamDefinition<PostgresMigrationContext> =
  Object.freeze({
    id: POSTGRESQL_MAIN_MIGRATION_STREAM_ID,
    dialect: 'postgresql',
    migrationIdScheme: 'postgres-prefixed',
    checksumScheme: 'sha256',
    migrations: Object.freeze([
      pg0001SchemaCapabilityMigration,
      pg0002RunCoreMigration,
      pg0003RunRetryPolicyMigration,
    ]),
  });

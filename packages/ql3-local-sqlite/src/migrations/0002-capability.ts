import { defineLocalSqliteMigration } from './sqlMigration';

export const local0002CapabilityMigration = defineLocalSqliteMigration({
  id: '0002-capability',
  statements: [
    `
INSERT INTO "QingLong3SchemaCapabilities" (
  contract_name, contract_version, migration_id, capabilities, updated_at_ms
) VALUES (
  'local-control-core', 1, '0001-run-core', '{"run_core":1,"run_retry_policy":1}',
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
)
    `,
  ],
});

import { CAPABILITIES_V49 } from './0098-capability-v49';
import { defineLocalSqliteMigration } from './sqlMigration';

export const CAPABILITIES_V50 = CAPABILITIES_V49.replace(
  '"legacy_adoption_ledger":1,',
  '"legacy_adoption_ledger":1,"legacy_data_directory_adoption":1,',
);

export const local0100CapabilityV50Migration = defineLocalSqliteMigration({
  id: '0100-capability-v50',
  statements: [
    `UPDATE "QingLong3SchemaCapabilities" SET contract_version = 50, migration_id = '0099-legacy-data-directory-adoptions', capabilities = '${CAPABILITIES_V50}', updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE contract_name = 'local-control-core' AND contract_version = 49 AND migration_id = '0097-plugin-package-secret-binding-transition-receipts' AND capabilities = '${CAPABILITIES_V49}'`,
  ],
});

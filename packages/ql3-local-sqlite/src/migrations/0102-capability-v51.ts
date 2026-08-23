import { CAPABILITIES_V50 } from './0100-capability-v50';
import { defineLocalSqliteMigration } from './sqlMigration';

export const CAPABILITIES_V51 = CAPABILITIES_V50.replace(
  '"legacy_adoption_ledger":1,',
  '"legacy_adoption_ledger":1,"legacy_adoption_provenance":1,',
);

export const local0102CapabilityV51Migration = defineLocalSqliteMigration({
  id: '0102-capability-v51',
  statements: [
    `UPDATE "QingLong3SchemaCapabilities" SET contract_version = 51, migration_id = '0101-legacy-adoption-provenance', capabilities = '${CAPABILITIES_V51}', updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE contract_name = 'local-control-core' AND contract_version = 50 AND migration_id = '0099-legacy-data-directory-adoptions' AND capabilities = '${CAPABILITIES_V50}'`,
  ],
});

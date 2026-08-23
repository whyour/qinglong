import { CAPABILITIES_V51 } from './0102-capability-v51';
import { defineLocalSqliteMigration } from './sqlMigration';

export const CAPABILITIES_V52 = CAPABILITIES_V51.replace(
  '"legacy_adoption_provenance":1,',
  '"legacy_adoption_provenance":1,"secret_config_application":1,',
);

export const local0104CapabilityV52Migration = defineLocalSqliteMigration({
  id: '0104-capability-v52',
  statements: [
    `UPDATE "QingLong3SchemaCapabilities" SET contract_version = 52, migration_id = '0103-secret-config-applications', capabilities = '${CAPABILITIES_V52}', updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE contract_name = 'local-control-core' AND contract_version = 51 AND migration_id = '0101-legacy-adoption-provenance' AND capabilities = '${CAPABILITIES_V51}'`,
  ],
});

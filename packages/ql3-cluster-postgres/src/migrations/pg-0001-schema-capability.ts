import { definePostgresSqlMigration } from './sqlMigration';

export const POSTGRESQL_SCHEMA_CAPABILITY_TABLE = 'schema_capabilities';

export const pg0001SchemaCapabilityMigration = definePostgresSqlMigration({
  id: 'pg-0001-schema-capability',
  statements: [
    `
CREATE TABLE "ql3"."${POSTGRESQL_SCHEMA_CAPABILITY_TABLE}" (
  contract_name varchar(64) PRIMARY KEY,
  contract_version integer NOT NULL
    CONSTRAINT ql3_schema_capabilities_version_check
    CHECK (contract_version >= 0),
  migration_id varchar(128) NOT NULL,
  capabilities jsonb NOT NULL
    CONSTRAINT ql3_schema_capabilities_payload_check
    CHECK (jsonb_typeof(capabilities) = 'object'),
  updated_at_ms bigint NOT NULL
    CONSTRAINT ql3_schema_capabilities_updated_at_check
    CHECK (updated_at_ms >= 0),
  CONSTRAINT ql3_schema_capabilities_migration_fk
    FOREIGN KEY (migration_id)
    REFERENCES "ql3"."schema_migrations" (migration_id)
    DEFERRABLE INITIALLY DEFERRED
)
    `.trim(),
  ],
});

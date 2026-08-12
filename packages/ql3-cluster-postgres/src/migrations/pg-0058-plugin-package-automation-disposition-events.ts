import { CAPABILITIES_V56 } from '../run-management/pg-0057-run-management-stop-boundary';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V57 = CAPABILITIES_V56.replace(
  '"plugin_package_automation_publication":1,',
  '"plugin_package_automation_publication":1,"plugin_package_automation_security_withdrawal":1,',
);

export const pg0058PluginPackageAutomationDispositionEventsMigration =
  definePostgresSqlMigration({
    id: 'pg-0058-plugin-package-automation-disposition-events',
    statements: [
      `CREATE TABLE "ql3"."plugin_package_automation_disposition_events" (event_digest char(64) PRIMARY KEY, event_kind varchar(16) NOT NULL, CONSTRAINT ql3_plugin_package_automation_disposition_kind_check CHECK (event_kind IN ('lifecycle', 'quarantine')), CONSTRAINT ql3_plugin_package_automation_disposition_digest_check CHECK (event_digest ~ '^[0-9a-f]{64}$'))`,
      `INSERT INTO "ql3"."plugin_package_automation_disposition_events" (event_digest, event_kind) SELECT event_digest, 'lifecycle' FROM "ql3"."plugin_package_lifecycle_events"`,
      `INSERT INTO "ql3"."plugin_package_automation_disposition_events" (event_digest, event_kind) SELECT event_digest, 'quarantine' FROM "ql3"."plugin_package_quarantine_events" ON CONFLICT (event_digest) DO NOTHING`,
      `CREATE FUNCTION "ql3"."register_plugin_package_automation_disposition_event"() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, ql3 AS $ql3$ DECLARE kind_value varchar(16); BEGIN kind_value := CASE TG_TABLE_NAME WHEN 'plugin_package_lifecycle_events' THEN 'lifecycle' WHEN 'plugin_package_quarantine_events' THEN 'quarantine' ELSE NULL END; IF kind_value IS NULL THEN RAISE EXCEPTION 'unsupported automation disposition source' USING ERRCODE = 'check_violation'; END IF; INSERT INTO "ql3"."plugin_package_automation_disposition_events" (event_digest, event_kind) VALUES (NEW.event_digest, kind_value) ON CONFLICT (event_digest) DO NOTHING; RETURN NEW; END $ql3$`,
      `REVOKE ALL ON FUNCTION "ql3"."register_plugin_package_automation_disposition_event"() FROM PUBLIC`,
      `CREATE TRIGGER ql3_plugin_package_automation_lifecycle_disposition_insert AFTER INSERT ON "ql3"."plugin_package_lifecycle_events" FOR EACH ROW EXECUTE FUNCTION "ql3"."register_plugin_package_automation_disposition_event"()`,
      `CREATE TRIGGER ql3_plugin_package_automation_quarantine_disposition_insert AFTER INSERT ON "ql3"."plugin_package_quarantine_events" FOR EACH ROW EXECUTE FUNCTION "ql3"."register_plugin_package_automation_disposition_event"()`,
      `ALTER TABLE "ql3"."plugin_package_automation_publications" DROP CONSTRAINT ql3_plugin_package_automation_publication_lifecycle_fk`,
      `ALTER TABLE "ql3"."plugin_package_automation_publications" ADD CONSTRAINT ql3_plugin_package_automation_publication_disposition_fk FOREIGN KEY (lifecycle_event_digest) REFERENCES "ql3"."plugin_package_automation_disposition_events" (event_digest) ON DELETE RESTRICT`,
      `REVOKE ALL ON "ql3"."plugin_package_automation_disposition_events" FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 57, migration_id = 'pg-0058-plugin-package-automation-disposition-events', capabilities = '${CAPABILITIES_V57}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 56 AND migration_id = 'pg-0057-run-management-stop-boundary' AND capabilities = '${CAPABILITIES_V56}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 56' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });

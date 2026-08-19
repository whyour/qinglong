import { CAPABILITIES_V66 } from './pg-0067-cancellation-dispatch-management';
import { definePostgresSqlMigration } from '../migrations/sqlMigration';

export const CAPABILITIES_V67 = CAPABILITIES_V66.replace(
  '"run_cancellation_dispatch_management":1,',
  '"run_cancellation_dispatch_blocked_list":1,"run_cancellation_dispatch_management":1,',
);

export const pg0068CancellationDispatchProjectKeysetMigration =
  definePostgresSqlMigration({
    id: 'pg-0068-cancellation-dispatch-project-keyset',
    statements: [
      `ALTER TABLE "ql3"."run_cancellation_dispatches" ADD COLUMN project_id varchar(128)`,
      `UPDATE "ql3"."run_cancellation_dispatches" AS dispatch SET project_id = run.project_id FROM "ql3"."runs" AS run WHERE run.id = dispatch.run_id`,
      `ALTER TABLE "ql3"."run_cancellation_dispatches" ALTER COLUMN project_id SET NOT NULL`,
      `CREATE UNIQUE INDEX ql3_runs_project_id_uidx ON "ql3"."runs" (project_id, id)`,
      `ALTER TABLE "ql3"."run_cancellation_dispatches" DROP CONSTRAINT ql3_run_cancellation_dispatch_run_fk`,
      `ALTER TABLE "ql3"."run_cancellation_dispatches" ADD CONSTRAINT ql3_run_cancellation_dispatch_run_fk FOREIGN KEY (project_id, run_id) REFERENCES "ql3"."runs" (project_id, id) ON DELETE CASCADE ON UPDATE RESTRICT`,
      `CREATE INDEX ql3_run_cancellation_dispatch_project_blocked_idx ON "ql3"."run_cancellation_dispatches" (project_id, updated_at_ms, run_id) WHERE status = 'blocked'`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 67, migration_id = 'pg-0068-cancellation-dispatch-project-keyset', capabilities = '${CAPABILITIES_V67}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 66 AND migration_id = 'pg-0067-cancellation-dispatch-management' AND capabilities = '${CAPABILITIES_V66}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 66' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });

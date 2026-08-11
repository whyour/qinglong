import { defineLocalSqliteMigration } from './sqlMigration';

export const local0035LocalSchedulerMigration = defineLocalSqliteMigration({
  id: '0035-local-scheduler',
  statements: [
    `
CREATE TABLE "QingLong3LocalTriggerSchedules" (
  project_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  trigger_revision INTEGER NOT NULL,
  next_fire_at_ms INTEGER,
  last_scheduled_at_ms INTEGER,
  state_version INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (project_id, trigger_id),
  CONSTRAINT ql3_local_trigger_schedules_trigger_fk
    FOREIGN KEY (project_id, trigger_id)
    REFERENCES "QingLong3Triggers" (project_id, trigger_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_local_trigger_schedules_revision_check
    CHECK (trigger_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_local_trigger_schedules_state_check
    CHECK (state_version >= 0),
  CONSTRAINT ql3_local_trigger_schedules_time_check CHECK (
    updated_at_ms >= 0 AND
    (next_fire_at_ms IS NULL OR next_fire_at_ms >= 0) AND
    (last_scheduled_at_ms IS NULL OR last_scheduled_at_ms >= 0)
  )
)
    `,
    `CREATE INDEX ql3_local_trigger_schedules_due_idx ON "QingLong3LocalTriggerSchedules" (next_fire_at_ms, project_id, trigger_id) WHERE next_fire_at_ms IS NOT NULL`,
    `CREATE INDEX ql3_local_trigger_schedules_initialize_idx ON "QingLong3LocalTriggerSchedules" (project_id, trigger_id) WHERE next_fire_at_ms IS NULL`,
    `
INSERT INTO "QingLong3LocalTriggerSchedules" (
  project_id, trigger_id, trigger_revision, next_fire_at_ms,
  last_scheduled_at_ms, state_version, updated_at_ms
)
SELECT project_id, trigger_id, current_revision, NULL, NULL, 0, updated_at_ms
FROM "QingLong3Triggers"
    `,
  ],
});

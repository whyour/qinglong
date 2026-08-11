export interface LocalStepRunReferenceTrigger {
  readonly name: string;
  readonly tableName: 'RunAttempts' | 'RunEvents';
  readonly sql: string;
}

export const LOCAL_STEP_RUN_REFERENCE_TRIGGERS = Object.freeze([
  Object.freeze({
    name: 'ql3_local_attempt_step_run_insert_guard',
    tableName: 'RunAttempts',
    sql: `
CREATE TRIGGER ql3_local_attempt_step_run_insert_guard
BEFORE INSERT ON "RunAttempts"
FOR EACH ROW WHEN NEW.step_run_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "StepRuns"
    WHERE id = NEW.step_run_id AND run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'ql3 StepRun reference mismatch') END;
END
    `.trim(),
  }),
  Object.freeze({
    name: 'ql3_local_attempt_step_run_update_guard',
    tableName: 'RunAttempts',
    sql: `
CREATE TRIGGER ql3_local_attempt_step_run_update_guard
BEFORE UPDATE OF run_id, step_run_id ON "RunAttempts"
FOR EACH ROW WHEN NEW.step_run_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "StepRuns"
    WHERE id = NEW.step_run_id AND run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'ql3 StepRun reference mismatch') END;
END
    `.trim(),
  }),
  Object.freeze({
    name: 'ql3_local_event_step_run_insert_guard',
    tableName: 'RunEvents',
    sql: `
CREATE TRIGGER ql3_local_event_step_run_insert_guard
BEFORE INSERT ON "RunEvents"
FOR EACH ROW WHEN NEW.step_run_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "StepRuns"
    WHERE id = NEW.step_run_id AND run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'ql3 StepRun reference mismatch') END;
END
    `.trim(),
  }),
  Object.freeze({
    name: 'ql3_local_event_step_run_update_guard',
    tableName: 'RunEvents',
    sql: `
CREATE TRIGGER ql3_local_event_step_run_update_guard
BEFORE UPDATE OF run_id, step_run_id ON "RunEvents"
FOR EACH ROW WHEN NEW.step_run_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM "StepRuns"
    WHERE id = NEW.step_run_id AND run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'ql3 StepRun reference mismatch') END;
END
    `.trim(),
  }),
] satisfies readonly Readonly<LocalStepRunReferenceTrigger>[]);

export function normalizeLocalSqliteSchemaSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

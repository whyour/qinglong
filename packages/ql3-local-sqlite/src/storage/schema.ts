import { sql } from 'drizzle-orm';

// Canonical Drizzle declaration of the complete Local SQLite storage contract.
import {
  type AnySQLiteColumn,
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const localSchemaMigrations = sqliteTable(
  'QingLong3SchemaMigrations',
  {
    migrationId: text('migration_id').primaryKey(),
    streamId: text('stream_id').notNull(),
    dialect: text('dialect').notNull(),
    checksum: text('checksum').notNull(),
    appliedAtMs: integer('applied_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_local_migrations_dialect_check',
      sql`${table.dialect} = 'sqlite'`,
    ),
    check(
      'ql3_local_migrations_checksum_check',
      sql`length(${table.checksum}) = 64 and ${table.checksum} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_local_migrations_applied_at_check',
      sql`${table.appliedAtMs} >= 0`,
    ),
  ],
);

export const localSchemaCapabilities = sqliteTable(
  'QingLong3SchemaCapabilities',
  {
    contractName: text('contract_name').primaryKey(),
    contractVersion: integer('contract_version').notNull(),
    migrationId: text('migration_id')
      .notNull()
      .references(() => localSchemaMigrations.migrationId),
    capabilities: text('capabilities', { mode: 'json' })
      .$type<Record<string, number>>()
      .notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_local_capabilities_version_check',
      sql`${table.contractVersion} >= 1`,
    ),
    check(
      'ql3_local_capabilities_json_check',
      sql`json_valid(${table.capabilities}) and json_type(${table.capabilities}) = 'object'`,
    ),
    check(
      'ql3_local_capabilities_updated_at_check',
      sql`${table.updatedAtMs} >= 0`,
    ),
  ],
);

export const runs = sqliteTable(
  'Runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    taskId: text('task_id').notNull(),
    taskRevision: text('task_revision').notNull(),
    taskName: text('task_name'),
    taskSnapshotRef: text('task_snapshot_ref'),
    legacyCronId: integer('legacy_cron_id'),
    parentRunId: text('parent_run_id').references(
      (): AnySQLiteColumn => runs.id,
    ),
    retryOfRunId: text('retry_of_run_id').references(
      (): AnySQLiteColumn => runs.id,
    ),
    triggerId: text('trigger_id'),
    triggerType: text('trigger_type').notNull(),
    executionOrigin: text('execution_origin').notNull(),
    executionOwner: text('execution_owner').notNull(),
    triggeredBy: text('triggered_by'),
    requestId: text('request_id'),
    scheduledForMs: integer('scheduled_for_ms'),
    status: text('status').notNull(),
    version: integer('version').notNull().default(0),
    eventSequence: integer('event_sequence').notNull().default(0),
    priority: integer('priority').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
    inputRef: text('input_ref'),
    outputRef: text('output_ref'),
    createdAtMs: integer('created_at_ms').notNull(),
    queuedAtMs: integer('queued_at_ms'),
    startedAtMs: integer('started_at_ms'),
    finishedAtMs: integer('finished_at_ms'),
    cancelRequestedAtMs: integer('cancel_requested_at_ms'),
    cancelReason: text('cancel_reason'),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
  },
  (table) => [
    check(
      'ql3_local_runs_execution_origin_check',
      sql`${table.executionOrigin} in ('manual','scheduled_system','scheduled_node','once','boot','grpc','subscription','system','script','legacy_import')`,
    ),
    check(
      'ql3_local_runs_execution_owner_check',
      sql`${table.executionOwner} in ('legacy','runtime')`,
    ),
    check(
      'ql3_local_runs_status_check',
      sql`${table.status} in ('created','queued','dispatching','running','waiting_approval','retry_wait','lost','succeeded','failed','cancelled','timed_out')`,
    ),
    check('ql3_local_runs_version_check', sql`${table.version} >= 0`),
    check(
      'ql3_local_runs_event_sequence_check',
      sql`${table.eventSequence} >= 0`,
    ),
    check(
      'ql3_local_runs_time_check',
      sql`${table.createdAtMs} >= 0 and (${table.scheduledForMs} is null or ${table.scheduledForMs} >= 0) and (${table.queuedAtMs} is null or ${table.queuedAtMs} >= 0) and (${table.startedAtMs} is null or ${table.startedAtMs} >= 0) and (${table.finishedAtMs} is null or ${table.finishedAtMs} >= 0) and (${table.cancelRequestedAtMs} is null or ${table.cancelRequestedAtMs} >= 0)`,
    ),
    check(
      'ql3_local_runs_cancel_reason_check',
      sql`${table.cancelReason} is null or ${table.cancelReason} in ('user','policy','shutdown','reconcile','timeout')`,
    ),
    uniqueIndex('ql3_local_runs_project_idempotency_uidx')
      .on(table.projectId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('ql3_local_runs_project_created_idx').on(
      table.projectId,
      table.createdAtMs,
      table.id,
    ),
    index('ql3_local_runs_task_created_idx').on(
      table.taskId,
      table.createdAtMs,
      table.id,
    ),
    index('ql3_local_runs_cancel_requested_idx').on(
      table.status,
      table.cancelRequestedAtMs,
      table.id,
    ),
    index('ql3_local_runs_lost_retry_idx').on(
      table.executionOwner,
      table.status,
      table.id,
    ),
    index('ql3_local_runs_dispatch_idx')
      .on(
        table.executionOwner,
        table.status,
        sql`${table.priority} desc`,
        table.queuedAtMs,
        table.id,
      )
      .where(
        sql`${table.executionOwner} = 'runtime' and ${table.status} = 'queued' and ${table.cancelRequestedAtMs} is null`,
      ),
  ],
);

export const stepRuns = sqliteTable(
  'StepRuns',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    parentStepRunId: text('parent_step_run_id'),
    stepKey: text('step_key').notNull(),
    kind: text('kind').notNull(),
    definitionRef: text('definition_ref').notNull(),
    definitionDigest: text('definition_digest').notNull(),
    required: integer('required', { mode: 'boolean' }).notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    inputRef: text('input_ref'),
    outputRef: text('output_ref'),
    approvalRequestId: text('approval_request_id'),
    readyAtMs: integer('ready_at_ms'),
    startedAtMs: integer('started_at_ms'),
    finishedAtMs: integer('finished_at_ms'),
    resultCode: text('result_code'),
    errorSummary: text('error_summary'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    lastMutationId: text('last_mutation_id').notNull(),
    stepRunDigest: text('step_run_digest').notNull(),
    stepRunJson: text('step_run_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.runId, table.parentStepRunId],
      foreignColumns: [table.runId, table.id],
      name: 'ql3_step_runs_parent_fk',
    }).onDelete('restrict'),
    check(
      'ql3_step_runs_identity_check',
      sql`length(${table.id}) between 1 and 128 and length(${table.runId}) between 1 and 128 and (${table.parentStepRunId} is null or (length(${table.parentStepRunId}) between 1 and 128 and ${table.parentStepRunId} <> ${table.id})) and length(${table.stepKey}) between 1 and 128 and length(cast(${table.definitionRef} as blob)) between 1 and 512`,
    ),
    check(
      'ql3_step_runs_kind_check',
      sql`${table.kind} in ('task','tool','model','agent','condition','approval','subworkflow')`,
    ),
    check(
      'ql3_step_runs_status_check',
      sql`${table.status} in ('pending','ready','waiting_approval','running','lost','succeeded','failed','skipped','cancelled','timed_out')`,
    ),
    check(
      'ql3_step_runs_digest_check',
      sql`length(${table.definitionDigest}) = 64 and ${table.definitionDigest} not glob '*[^0-9a-f]*' and length(${table.stepRunDigest}) = 64 and ${table.stepRunDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_step_runs_counter_check',
      sql`${table.required} in (0, 1) and ${table.version} between 1 and 2147483647 and ${table.attemptCount} between 0 and 64`,
    ),
    check(
      'ql3_step_runs_reference_check',
      sql`(${table.inputRef} is null or length(cast(${table.inputRef} as blob)) between 1 and 512) and (${table.outputRef} is null or length(cast(${table.outputRef} as blob)) between 1 and 512) and (${table.approvalRequestId} is null or length(${table.approvalRequestId}) between 1 and 128)`,
    ),
    check(
      'ql3_step_runs_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs} and (${table.readyAtMs} is null or ${table.readyAtMs} between ${table.createdAtMs} and ${table.updatedAtMs}) and (${table.startedAtMs} is null or (${table.readyAtMs} is not null and ${table.startedAtMs} between ${table.readyAtMs} and ${table.updatedAtMs})) and (${table.finishedAtMs} is null or (${table.finishedAtMs} between ${table.createdAtMs} and ${table.updatedAtMs} and (${table.readyAtMs} is null or ${table.finishedAtMs} >= ${table.readyAtMs}) and (${table.startedAtMs} is null or ${table.finishedAtMs} >= ${table.startedAtMs})))`,
    ),
    check(
      'ql3_step_runs_state_shape_check',
      sql`(${table.status} = 'pending' and ${table.readyAtMs} is null and ${table.startedAtMs} is null and ${table.finishedAtMs} is null) or (${table.status} in ('ready','waiting_approval') and ${table.readyAtMs} is not null and ${table.startedAtMs} is null and ${table.finishedAtMs} is null) or (${table.status} in ('running','lost') and ${table.readyAtMs} is not null and ${table.startedAtMs} is not null and ${table.finishedAtMs} is null) or (${table.status} in ('succeeded','failed','skipped','cancelled','timed_out') and ${table.finishedAtMs} is not null)`,
    ),
    check(
      'ql3_step_runs_result_shape_check',
      sql`(${table.status} = 'waiting_approval' and ${table.approvalRequestId} is not null) or ${table.status} <> 'waiting_approval'`,
    ),
    check(
      'ql3_step_runs_result_value_check',
      sql`(${table.outputRef} is null or ${table.status} = 'succeeded') and ((${table.status} = 'succeeded' and ${table.resultCode} is null and ${table.errorSummary} is null) or (${table.status} in ('failed','skipped','cancelled','timed_out','lost') and ${table.resultCode} is not null) or (${table.status} in ('pending','ready','waiting_approval','running') and ${table.resultCode} is null and ${table.errorSummary} is null)) and (${table.resultCode} is null or (length(${table.resultCode}) between 1 and 64 and ${table.resultCode} not glob '*[^a-z0-9_]*' and substr(${table.resultCode}, 1, 1) glob '[a-z]')) and (${table.errorSummary} is null or length(cast(${table.errorSummary} as blob)) between 1 and 2048)`,
    ),
    check(
      'ql3_step_runs_mutation_identity_check',
      sql`length(${table.lastMutationId}) between 1 and 128`,
    ),
    check(
      'ql3_step_runs_json_check',
      sql`length(cast(${table.stepRunJson} as blob)) between 2 and 16384 and json_valid(${table.stepRunJson}) and json_type(${table.stepRunJson}) = 'object' and json_extract(${table.stepRunJson}, '$.schema') = 'qinglong/step-run@v1' and json_extract(${table.stepRunJson}, '$.id') = ${table.id} and json_extract(${table.stepRunJson}, '$.runId') = ${table.runId} and json_extract(${table.stepRunJson}, '$.parentStepRunId') is ${table.parentStepRunId} and json_extract(${table.stepRunJson}, '$.stepKey') = ${table.stepKey} and json_extract(${table.stepRunJson}, '$.kind') = ${table.kind} and json_extract(${table.stepRunJson}, '$.definitionRef') = ${table.definitionRef} and json_extract(${table.stepRunJson}, '$.definitionDigest') = ${table.definitionDigest} and json_extract(${table.stepRunJson}, '$.required') is ${table.required} and json_extract(${table.stepRunJson}, '$.status') = ${table.status} and json_extract(${table.stepRunJson}, '$.version') = ${table.version} and json_extract(${table.stepRunJson}, '$.attemptCount') is ${table.attemptCount} and json_extract(${table.stepRunJson}, '$.inputRef') is ${table.inputRef} and json_extract(${table.stepRunJson}, '$.outputRef') is ${table.outputRef} and json_extract(${table.stepRunJson}, '$.approvalRequestId') is ${table.approvalRequestId} and json_extract(${table.stepRunJson}, '$.readyAtMs') is ${table.readyAtMs} and json_extract(${table.stepRunJson}, '$.startedAtMs') is ${table.startedAtMs} and json_extract(${table.stepRunJson}, '$.finishedAtMs') is ${table.finishedAtMs} and json_extract(${table.stepRunJson}, '$.resultCode') is ${table.resultCode} and json_extract(${table.stepRunJson}, '$.errorSummary') is ${table.errorSummary} and json_extract(${table.stepRunJson}, '$.createdAtMs') is ${table.createdAtMs} and json_extract(${table.stepRunJson}, '$.updatedAtMs') is ${table.updatedAtMs} and json_extract(${table.stepRunJson}, '$.lastMutationId') = ${table.lastMutationId} and json_extract(${table.stepRunJson}, '$.stepRunDigest') = ${table.stepRunDigest}`,
    ),
    uniqueIndex('ql3_step_runs_run_id_uidx').on(table.runId, table.id),
    uniqueIndex('ql3_step_runs_run_step_uidx').on(table.runId, table.stepKey),
    index('ql3_step_runs_run_status_idx').on(
      table.runId,
      table.status,
      table.id,
    ),
    index('ql3_step_runs_recovery_idx')
      .on(table.status, table.updatedAtMs, table.id)
      .where(sql`${table.status} in ('waiting_approval','running','lost')`),
  ],
);

export const runAttempts = sqliteTable(
  'RunAttempts',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepRunId: text('step_run_id'),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull(),
    executorType: text('executor_type').notNull(),
    workerId: text('worker_id'),
    workerSessionId: text('worker_session_id'),
    workerGeneration: integer('worker_generation'),
    executorHandle: text('executor_handle'),
    pid: integer('pid'),
    logArtifactId: text('log_artifact_id'),
    leaseToken: text('lease_token'),
    leaseTokenDigest: text('lease_token_digest'),
    leaseGeneration: integer('lease_generation'),
    leaseVersion: integer('lease_version'),
    leaseExpiresAtMs: integer('lease_expires_at_ms'),
    offerId: text('offer_id'),
    deadlineAtMs: integer('deadline_at_ms'),
    callbackTokenHash: text('callback_token_hash'),
    callbackSequence: integer('callback_sequence').notNull().default(0),
    createdAtMs: integer('created_at_ms').notNull(),
    startedAtMs: integer('started_at_ms'),
    finishedAtMs: integer('finished_at_ms'),
    exitCode: integer('exit_code'),
    errorCode: text('error_code'),
    errorSummary: text('error_summary'),
  },
  (table) => [
    check('ql3_local_attempts_attempt_check', sql`${table.attempt} >= 1`),
    check(
      'ql3_local_attempts_status_check',
      sql`${table.status} in ('claimed','starting','running','succeeded','failed','cancelled','timed_out','lost')`,
    ),
    check(
      'ql3_local_attempts_callback_sequence_check',
      sql`${table.callbackSequence} >= 0`,
    ),
    check(
      'ql3_local_attempts_time_check',
      sql`${table.createdAtMs} >= 0 and (${table.startedAtMs} is null or ${table.startedAtMs} >= 0) and (${table.finishedAtMs} is null or ${table.finishedAtMs} >= 0) and (${table.leaseExpiresAtMs} is null or ${table.leaseExpiresAtMs} >= 0) and (${table.deadlineAtMs} is null or ${table.deadlineAtMs} >= 0)`,
    ),
    uniqueIndex('ql3_local_attempts_run_attempt_uidx').on(
      table.runId,
      table.attempt,
    ),
    index('ql3_local_attempts_run_status_idx').on(
      table.runId,
      table.status,
      table.id,
    ),
    index('ql3_local_attempts_lease_idx').on(table.leaseExpiresAtMs, table.id),
    index('ql3_local_attempts_deadline_idx').on(
      table.status,
      table.deadlineAtMs,
      table.id,
    ),
    index('ql3_run_log_retention_candidate_idx')
      .on(table.executorType, table.status, table.finishedAtMs, table.id)
      .where(sql`${table.logArtifactId} is not null`),
  ],
);

export const runEvents = sqliteTable(
  'RunEvents',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    type: text('type').notNull(),
    dedupeKey: text('dedupe_key'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    attemptId: text('attempt_id').references(() => runAttempts.id, {
      onDelete: 'set null',
    }),
    stepRunId: text('step_run_id'),
    payload: text('payload', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    check('ql3_local_events_sequence_check', sql`${table.sequence} >= 1`),
    check(
      'ql3_local_events_actor_type_check',
      sql`${table.actorType} in ('user','api_app','trigger','agent','mcp_client','worker','executor','system','legacy_shell','scheduler','reconciler','compatibility')`,
    ),
    check(
      'ql3_local_events_payload_check',
      sql`json_valid(${table.payload}) and json_type(${table.payload}) = 'object'`,
    ),
    check('ql3_local_events_created_at_check', sql`${table.createdAtMs} >= 0`),
    uniqueIndex('ql3_local_events_run_sequence_uidx').on(
      table.runId,
      table.sequence,
    ),
    uniqueIndex('ql3_local_events_run_dedupe_uidx')
      .on(table.runId, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    index('ql3_local_events_run_created_idx').on(
      table.runId,
      table.createdAtMs,
      table.id,
    ),
  ],
);

export const stepRunMutations = sqliteTable(
  'StepRunMutations',
  {
    mutationId: text('mutation_id').primaryKey(),
    mutationDigest: text('mutation_digest').notNull(),
    runId: text('run_id').notNull(),
    stepRunId: text('step_run_id').notNull(),
    stepRunDigest: text('step_run_digest').notNull(),
    eventId: text('event_id')
      .notNull()
      .references(() => runEvents.id, { onDelete: 'cascade' }),
    eventSequence: integer('event_sequence').notNull(),
    runVersion: integer('run_version').notNull(),
    stepRunJson: text('step_run_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    committedAtMs: integer('committed_at_ms').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
      name: 'ql3_step_run_mutations_step_fk',
    }).onDelete('cascade'),
    check(
      'ql3_step_run_mutations_identity_check',
      sql`length(${table.mutationId}) between 1 and 128 and length(${table.runId}) between 1 and 128 and length(${table.stepRunId}) between 1 and 128 and length(${table.eventId}) between 1 and 128`,
    ),
    check(
      'ql3_step_run_mutations_digest_check',
      sql`length(${table.mutationDigest}) = 64 and ${table.mutationDigest} not glob '*[^0-9a-f]*' and length(${table.stepRunDigest}) = 64 and ${table.stepRunDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_step_run_mutations_counter_check',
      sql`${table.eventSequence} between 1 and 2147483647 and ${table.runVersion} between 1 and 2147483647 and ${table.committedAtMs} >= 0`,
    ),
    check(
      'ql3_step_run_mutations_json_check',
      sql`length(cast(${table.stepRunJson} as blob)) between 2 and 16384 and json_valid(${table.stepRunJson}) and json_type(${table.stepRunJson}) = 'object' and json_extract(${table.stepRunJson}, '$.schema') = 'qinglong/step-run@v1' and json_extract(${table.stepRunJson}, '$.id') = ${table.stepRunId} and json_extract(${table.stepRunJson}, '$.runId') = ${table.runId} and json_extract(${table.stepRunJson}, '$.lastMutationId') = ${table.mutationId} and json_extract(${table.stepRunJson}, '$.stepRunDigest') = ${table.stepRunDigest}`,
    ),
    uniqueIndex('ql3_step_run_mutations_event_uidx').on(table.eventId),
    index('ql3_step_run_mutations_step_idx').on(
      table.runId,
      table.stepRunId,
      table.eventSequence,
      table.mutationId,
    ),
  ],
);

export const runRetryPolicies = sqliteTable(
  'RunRetryPolicies',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => runs.id, { onDelete: 'cascade' }),
    maxAttempts: integer('max_attempts').notNull(),
    retryOnLost: integer('retry_on_lost', { mode: 'boolean' }).notNull(),
    safety: text('safety').notNull(),
    backoffBaseMs: integer('backoff_base_ms').notNull(),
    backoffMaxMs: integer('backoff_max_ms').notNull(),
    nextAttemptAtMs: integer('next_attempt_at_ms'),
    version: integer('version').notNull().default(0),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_local_retry_max_attempts_check',
      sql`${table.maxAttempts} between 1 and 16`,
    ),
    check('ql3_local_retry_on_lost_check', sql`${table.retryOnLost} in (0, 1)`),
    check(
      'ql3_local_retry_safety_check',
      sql`${table.safety} in ('unknown','idempotent','deduplicated')`,
    ),
    check(
      'ql3_local_retry_backoff_check',
      sql`${table.backoffBaseMs} between 0 and 86400000 and ${table.backoffMaxMs} between ${table.backoffBaseMs} and 86400000`,
    ),
    check('ql3_local_retry_version_check', sql`${table.version} >= 0`),
    check(
      'ql3_local_retry_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs} and (${table.nextAttemptAtMs} is null or ${table.nextAttemptAtMs} >= 0)`,
    ),
    index('ql3_local_retry_due_idx')
      .on(table.nextAttemptAtMs, table.runId)
      .where(sql`${table.nextAttemptAtMs} is not null`),
  ],
);

export const localCompletionReceiptJournal = sqliteTable(
  'LocalCompletionReceiptJournal',
  {
    attemptId: text('attempt_id')
      .primaryKey()
      .references(() => runAttempts.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    quarantineRef: text('quarantine_ref'),
    purgeAfterMs: integer('purge_after_ms'),
    registeredAtMs: integer('registered_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_local_receipt_journal_state_check',
      sql`${table.state} in ('pending','quarantined')`,
    ),
    check(
      'ql3_local_receipt_journal_time_check',
      sql`${table.registeredAtMs} >= 0 and ${table.updatedAtMs} >= ${table.registeredAtMs} and (${table.purgeAfterMs} is null or ${table.purgeAfterMs} >= ${table.updatedAtMs})`,
    ),
    check(
      'ql3_local_receipt_journal_shape_check',
      sql`(${table.state} = 'pending' and ${table.quarantineRef} is null and ${table.purgeAfterMs} is null) or (${table.state} = 'quarantined' and ${table.quarantineRef} is not null and ${table.purgeAfterMs} is not null)`,
    ),
    index('ql3_local_receipt_journal_scan_idx').on(
      table.state,
      table.updatedAtMs,
      table.attemptId,
    ),
    index('ql3_local_receipt_journal_purge_idx')
      .on(table.purgeAfterMs, table.attemptId)
      .where(sql`${table.state} = 'quarantined'`),
  ],
);

export const runAttemptLogArtifactTombstones = sqliteTable(
  'QingLong3RunAttemptLogArtifactTombstones',
  {
    logArtifactId: text('log_artifact_id').primaryKey(),
    projectId: text('project_id').notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => runAttempts.id, { onDelete: 'cascade' }),
    executorType: text('executor_type').notNull(),
    finishedAtMs: integer('finished_at_ms').notNull(),
    eligibleAtMs: integer('eligible_at_ms').notNull(),
    retiredAtMs: integer('retired_at_ms').notNull(),
    disposition: text('disposition').notNull(),
    byteLength: integer('byte_length').notNull(),
    truncated: text('truncated').notNull(),
    maximumBytes: integer('maximum_bytes'),
    truncationObservedAtMs: integer('truncation_observed_at_ms'),
    recordDigest: text('record_digest').notNull(),
  },
  (table) => [
    uniqueIndex('ql3_run_log_tombstone_attempt_uidx').on(table.attemptId),
    index('ql3_run_log_tombstone_retired_idx').on(
      table.retiredAtMs,
      table.attemptId,
    ),
    check(
      'ql3_run_log_tombstone_executor_check',
      sql`${table.executorType} = 'local_process'`,
    ),
    check(
      'ql3_run_log_tombstone_disposition_check',
      sql`${table.disposition} in ('deleted','already_absent')`,
    ),
    check(
      'ql3_run_log_tombstone_truncated_check',
      sql`${table.truncated} in ('true','false','unknown')`,
    ),
    check(
      'ql3_run_log_tombstone_identity_check',
      sql`length(${table.projectId}) between 1 and 128 and length(${table.runId}) between 1 and 128 and length(${table.attemptId}) between 1 and 128 and length(${table.logArtifactId}) = 36 and substr(${table.logArtifactId}, 1, 6) = 'local-' and substr(${table.logArtifactId}, 7) not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_run_log_tombstone_time_check',
      sql`${table.finishedAtMs} >= 0 and ${table.eligibleAtMs} >= ${table.finishedAtMs} and ${table.retiredAtMs} >= ${table.eligibleAtMs}`,
    ),
    check(
      'ql3_run_log_tombstone_size_check',
      sql`${table.byteLength} between 0 and 1073741824 and (${table.disposition} <> 'already_absent' or ${table.byteLength} = 0)`,
    ),
    check(
      'ql3_run_log_tombstone_truncation_shape_check',
      sql`(${table.truncated} = 'unknown' and ${table.maximumBytes} is null and ${table.truncationObservedAtMs} is null) or (${table.truncated} in ('true','false') and ${table.maximumBytes} >= 1 and ${table.truncationObservedAtMs} >= 0)`,
    ),
    check(
      'ql3_run_log_tombstone_digest_check',
      sql`length(${table.recordDigest}) = 64 and ${table.recordDigest} not glob '*[^0-9a-f]*'`,
    ),
  ],
);

export const runAttemptLogRetentionState = sqliteTable(
  'QingLong3RunAttemptLogRetentionState',
  {
    maintenanceId: text('maintenance_id').primaryKey(),
    cursorFinishedAtMs: integer('cursor_finished_at_ms'),
    cursorAttemptId: text('cursor_attempt_id'),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_run_log_retention_state_id_check',
      sql`${table.maintenanceId} = 'local-run-attempt-log'`,
    ),
    check(
      'ql3_run_log_retention_state_cursor_check',
      sql`(${table.cursorFinishedAtMs} is null and ${table.cursorAttemptId} is null) or (${table.cursorFinishedAtMs} >= 0 and length(${table.cursorAttemptId}) between 1 and 128)`,
    ),
    check(
      'ql3_run_log_retention_state_time_check',
      sql`${table.updatedAtMs} >= 0`,
    ),
  ],
);

export const localExecutionContextRecipes = sqliteTable(
  'QingLong3LocalExecutionContextRecipes',
  {
    contextRef: text('context_ref').primaryKey(),
    environmentJson: text('environment_json').notNull(),
    contentDigest: text('content_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_local_context_ref_check',
      sql`length(${table.contextRef}) = 80 and ${table.contextRef} glob 'localctx:sha256:[0-9a-f]*' and length(replace(${table.contextRef}, 'localctx:sha256:', '')) = 64`,
    ),
    check(
      'ql3_local_context_environment_check',
      sql`json_valid(${table.environmentJson}) and json_type(${table.environmentJson}) = 'array' and length(${table.environmentJson}) <= 262144`,
    ),
    check(
      'ql3_local_context_digest_check',
      sql`length(${table.contentDigest}) = 64 and ${table.contentDigest} not glob '*[^0-9a-f]*' and ${table.contextRef} = 'localctx:sha256:' || ${table.contentDigest}`,
    ),
    check('ql3_local_context_created_check', sql`${table.createdAtMs} >= 0`),
  ],
);

export const localTaskExecutionRevisions = sqliteTable(
  'QingLong3LocalTaskExecutionRevisions',
  {
    projectId: text('project_id').notNull(),
    taskId: text('task_id').notNull(),
    taskRevision: text('task_revision').notNull(),
    executorType: text('executor_type').notNull(),
    commandJson: text('command_json').notNull(),
    workingDirectory: text('working_directory'),
    timeoutMs: integer('timeout_ms'),
    contextRef: text('context_ref')
      .notNull()
      .references(() => localExecutionContextRecipes.contextRef, {
        onDelete: 'restrict',
      }),
    contentDigest: text('content_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.taskId, table.taskRevision],
    }),
    check(
      'ql3_local_revision_executor_check',
      sql`${table.executorType} = 'local_process'`,
    ),
    check(
      'ql3_local_revision_command_check',
      sql`json_valid(${table.commandJson}) and json_type(${table.commandJson}) = 'object' and length(${table.commandJson}) between 1 and 131072`,
    ),
    check(
      'ql3_local_revision_working_directory_check',
      sql`${table.workingDirectory} is null or (length(${table.workingDirectory}) between 1 and 4096 and substr(${table.workingDirectory}, 1, 1) = '/')`,
    ),
    check(
      'ql3_local_revision_timeout_check',
      sql`${table.timeoutMs} is null or ${table.timeoutMs} between 1 and 31536000000`,
    ),
    check(
      'ql3_local_revision_digest_check',
      sql`length(${table.contentDigest}) = 64 and ${table.contentDigest} not glob '*[^0-9a-f]*'`,
    ),
    check('ql3_local_revision_created_check', sql`${table.createdAtMs} >= 0`),
  ],
);

export const localSecretEnvelopes = sqliteTable(
  'QingLong3LocalSecretEnvelopes',
  {
    projectId: text('project_id').notNull(),
    name: text('secret_name').notNull(),
    version: integer('version').notNull(),
    mutationId: text('mutation_id').notNull(),
    keyId: text('key_id').notNull(),
    algorithm: text('algorithm').notNull(),
    nonce: blob('nonce', { mode: 'buffer' }).notNull(),
    ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
    authTag: blob('auth_tag', { mode: 'buffer' }).notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.name, table.version] }),
    check(
      'ql3_local_secret_project_check',
      sql`length(${table.projectId}) between 1 and 128 and ${table.projectId} not glob '*[' || char(0) || '-' || char(31) || char(127) || ']*'`,
    ),
    check(
      'ql3_local_secret_name_check',
      sql`length(${table.name}) between 1 and 128 and ${table.name} not glob '*[' || char(0) || '-' || char(31) || char(127) || ']*'`,
    ),
    check(
      'ql3_local_secret_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_local_secret_mutation_check',
      sql`length(${table.mutationId}) between 1 and 64`,
    ),
    check(
      'ql3_local_secret_key_check',
      sql`length(${table.keyId}) between 1 and 128 and ${table.keyId} not glob '*[^A-Za-z0-9._-]*'`,
    ),
    check(
      'ql3_local_secret_algorithm_check',
      sql`${table.algorithm} = 'aes-256-gcm'`,
    ),
    check(
      'ql3_local_secret_crypto_shape_check',
      sql`length(${table.nonce}) = 12 and length(${table.ciphertext}) <= 16384 and length(${table.authTag}) = 16`,
    ),
    check('ql3_local_secret_created_check', sql`${table.createdAtMs} >= 0`),
    uniqueIndex('ql3_local_secret_mutation_uidx').on(
      table.projectId,
      table.name,
      table.mutationId,
    ),
    index('ql3_local_secret_current_idx').on(
      table.projectId,
      table.name,
      sql`${table.version} desc`,
    ),
    index('ql3_local_secret_key_usage_idx').on(
      table.keyId,
      table.projectId,
      table.name,
      table.version,
    ),
  ],
);

export const localProjects = sqliteTable(
  'QingLong3Projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_local_projects_id_check',
      sql`length(${table.id}) between 1 and 128 and ${table.id} not glob '*[' || char(0) || '-' || char(31) || char(127) || ']*'`,
    ),
    check(
      'ql3_local_projects_name_check',
      sql`length(${table.name}) between 1 and 255`,
    ),
    check(
      'ql3_local_projects_slug_check',
      sql`length(${table.slug}) between 1 and 128 and ${table.slug} = lower(${table.slug}) and ${table.slug} not glob '*[^a-z0-9-]*' and substr(${table.slug}, 1, 1) not glob '[^a-z0-9]' and substr(${table.slug}, -1, 1) not glob '[^a-z0-9]'`,
    ),
    check(
      'ql3_local_projects_status_check',
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      'ql3_local_projects_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_local_projects_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    uniqueIndex('ql3_local_projects_slug_uidx').on(table.slug),
  ],
);

export const approvalRequests = sqliteTable(
  'QingLong3ApprovalRequests',
  {
    requestId: text('request_id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    state: text('state').notNull(),
    actionType: text('action_type').notNull(),
    actionRef: text('action_ref').notNull(),
    actionDigest: text('action_digest').notNull(),
    previewDigest: text('preview_digest').notNull(),
    requestedByType: text('requested_by_type').notNull(),
    requestedById: text('requested_by_id').notNull(),
    decisionId: text('decision_id'),
    consumptionId: text('consumption_id'),
    dispatchId: text('dispatch_id'),
    expiresAtMs: integer('expires_at_ms').notNull(),
    requestJson: text('request_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    requestDigest: text('request_digest').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_approval_requests_identity_check',
      sql`length(${table.requestId}) between 1 and 128 and length(${table.actionType}) between 1 and 128 and length(${table.actionRef}) between 1 and 255`,
    ),
    check(
      'ql3_approval_requests_state_version_check',
      sql`(${table.state} = 'pending' and ${table.version} = 1) or (${table.state} in ('approved','rejected') and ${table.version} = 2) or (${table.state} = 'consumed' and ${table.version} = 3)`,
    ),
    check(
      'ql3_approval_requests_digest_check',
      sql`length(${table.actionDigest}) = 64 and ${table.actionDigest} not glob '*[^0-9a-f]*' and length(${table.previewDigest}) = 64 and ${table.previewDigest} not glob '*[^0-9a-f]*' and length(${table.requestDigest}) = 64 and ${table.requestDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_approval_requests_subject_check',
      sql`${table.requestedByType} in ('user','api_app','mcp_client','agent','system','worker') and length(${table.requestedById}) between 1 and 255`,
    ),
    check(
      'ql3_approval_requests_mutation_tuple_check',
      sql`(${table.version} = 1 and ${table.decisionId} is null and ${table.consumptionId} is null and ${table.dispatchId} is null) or (${table.version} = 2 and ${table.decisionId} is not null and ${table.consumptionId} is null and ${table.dispatchId} is null) or (${table.version} = 3 and ${table.decisionId} is not null and ${table.consumptionId} is not null and ${table.dispatchId} is not null)`,
    ),
    check(
      'ql3_approval_requests_json_check',
      sql`length(${table.requestJson}) between 2 and 65536 and json_valid(${table.requestJson}) and json_type(${table.requestJson}) = 'object' and json_extract(${table.requestJson}, '$.id') = ${table.requestId} and json_extract(${table.requestJson}, '$.projectId') = ${table.projectId} and json_extract(${table.requestJson}, '$.version') = ${table.version} and json_extract(${table.requestJson}, '$.state') = ${table.state} and json_extract(${table.requestJson}, '$.action.actionType') = ${table.actionType} and json_extract(${table.requestJson}, '$.action.actionRef') = ${table.actionRef} and json_extract(${table.requestJson}, '$.action.actionDigest') = ${table.actionDigest} and json_extract(${table.requestJson}, '$.action.previewDigest') = ${table.previewDigest}`,
    ),
    check(
      'ql3_approval_requests_time_check',
      sql`${table.expiresAtMs} > 0 and ${table.updatedAtMs} >= 0`,
    ),
    uniqueIndex('ql3_approval_requests_decision_uidx').on(table.decisionId),
    uniqueIndex('ql3_approval_requests_consumption_uidx').on(
      table.consumptionId,
    ),
    uniqueIndex('ql3_approval_requests_dispatch_uidx').on(table.dispatchId),
    index('ql3_approval_requests_pending_idx')
      .on(table.expiresAtMs, table.requestId)
      .where(sql`${table.state} = 'pending'`),
    index('ql3_approval_requests_project_idx').on(
      table.projectId,
      table.updatedAtMs,
      table.requestId,
    ),
  ],
);

export const approvedActionDispatches = sqliteTable(
  'QingLong3ApprovedActionDispatches',
  {
    dispatchId: text('dispatch_id').primaryKey(),
    approvalRequestId: text('approval_request_id')
      .notNull()
      .references(() => approvalRequests.requestId, { onDelete: 'restrict' }),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    actionType: text('action_type').notNull(),
    actionRef: text('action_ref').notNull(),
    actionDigest: text('action_digest').notNull(),
    previewDigest: text('preview_digest').notNull(),
    dispatchJson: text('dispatch_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    dispatchDigest: text('dispatch_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    uniqueIndex('ql3_approved_action_dispatch_request_uidx').on(
      table.approvalRequestId,
    ),
    uniqueIndex('ql3_approved_action_dispatch_lifecycle_uidx').on(
      table.dispatchId,
      table.projectId,
      table.actionType,
      table.actionDigest,
      table.previewDigest,
    ),
    check(
      'ql3_approved_action_dispatch_identity_check',
      sql`length(${table.dispatchId}) between 1 and 128 and length(${table.actionType}) between 1 and 128 and length(${table.actionRef}) between 1 and 255`,
    ),
    check(
      'ql3_approved_action_dispatch_digest_check',
      sql`length(${table.actionDigest}) = 64 and ${table.actionDigest} not glob '*[^0-9a-f]*' and length(${table.previewDigest}) = 64 and ${table.previewDigest} not glob '*[^0-9a-f]*' and length(${table.dispatchDigest}) = 64 and ${table.dispatchDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_approved_action_dispatch_json_check',
      sql`length(${table.dispatchJson}) between 2 and 65536 and json_valid(${table.dispatchJson}) and json_type(${table.dispatchJson}) = 'object' and json_extract(${table.dispatchJson}, '$.id') = ${table.dispatchId} and json_extract(${table.dispatchJson}, '$.approvalRequestId') = ${table.approvalRequestId} and json_extract(${table.dispatchJson}, '$.projectId') = ${table.projectId} and json_extract(${table.dispatchJson}, '$.action.actionType') = ${table.actionType} and json_extract(${table.dispatchJson}, '$.action.actionRef') = ${table.actionRef} and json_extract(${table.dispatchJson}, '$.action.actionDigest') = ${table.actionDigest} and json_extract(${table.dispatchJson}, '$.action.previewDigest') = ${table.previewDigest}`,
    ),
    check(
      'ql3_approved_action_dispatch_time_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    index('ql3_approved_action_dispatch_project_idx').on(
      table.projectId,
      table.createdAtMs,
      table.dispatchId,
    ),
  ],
);

export const approvedActionExecutions = sqliteTable(
  'QingLong3ApprovedActionExecutions',
  {
    dispatchId: text('dispatch_id')
      .primaryKey()
      .references(() => approvedActionDispatches.dispatchId, {
        onDelete: 'restrict',
      }),
    dispatchDigest: text('dispatch_digest').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    eligibleAtMs: integer('eligible_at_ms'),
    nextAttemptAtMs: integer('next_attempt_at_ms'),
    leaseOwner: text('lease_owner'),
    leaseToken: text('lease_token'),
    leaseExpiresAtMs: integer('lease_expires_at_ms'),
    startedAtMs: integer('started_at_ms'),
    resultMutationId: text('result_mutation_id'),
    resultCode: text('result_code'),
    resultDigest: text('result_digest'),
    completedAtMs: integer('completed_at_ms'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    executionJson: text('execution_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    executionDigest: text('execution_digest').notNull(),
  },
  (table) => [
    check(
      'ql3_approved_action_execution_state_check',
      sql`${table.status} in ('pending','leased','executing','retry_wait','succeeded','failed','blocked') and ${table.version} between 0 and 2147483647 and ${table.attemptCount} between 0 and 16 and ${table.maxAttempts} between 1 and 16 and ${table.attemptCount} <= ${table.maxAttempts}`,
    ),
    check(
      'ql3_approved_action_execution_lease_check',
      sql`(${table.leaseOwner} is null and ${table.leaseToken} is null and ${table.leaseExpiresAtMs} is null) or (length(${table.leaseOwner}) between 1 and 128 and length(${table.leaseToken}) between 1 and 128 and ${table.leaseExpiresAtMs} > ${table.updatedAtMs})`,
    ),
    check(
      'ql3_approved_action_execution_result_check',
      sql`(${table.resultMutationId} is null and ${table.resultCode} is null) or (length(${table.resultMutationId}) between 1 and 128 and length(${table.resultCode}) between 1 and 64)`,
    ),
    check(
      'ql3_approved_action_execution_digest_check',
      sql`length(${table.dispatchDigest}) = 64 and ${table.dispatchDigest} not glob '*[^0-9a-f]*' and (${table.resultDigest} is null or (length(${table.resultDigest}) = 64 and ${table.resultDigest} not glob '*[^0-9a-f]*')) and length(${table.executionDigest}) = 64 and ${table.executionDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_approved_action_execution_json_check',
      sql`length(${table.executionJson}) between 2 and 65536 and json_valid(${table.executionJson}) and json_type(${table.executionJson}) = 'object' and json_extract(${table.executionJson}, '$.schema') = 'qinglong/approved-action-execution@v1' and json_extract(${table.executionJson}, '$.dispatchId') = ${table.dispatchId} and json_extract(${table.executionJson}, '$.dispatchDigest') = ${table.dispatchDigest} and json_extract(${table.executionJson}, '$.projectId') = ${table.projectId} and json_extract(${table.executionJson}, '$.status') = ${table.status} and json_extract(${table.executionJson}, '$.version') = ${table.version} and json_extract(${table.executionJson}, '$.attemptCount') = ${table.attemptCount} and json_extract(${table.executionJson}, '$.maxAttempts') = ${table.maxAttempts} and json_extract(${table.executionJson}, '$.executionDigest') = ${table.executionDigest}`,
    ),
    check(
      'ql3_approved_action_execution_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    index('ql3_approved_action_execution_due_idx')
      .on(table.eligibleAtMs, table.dispatchId)
      .where(sql`${table.status} in ('pending','leased','retry_wait')`),
    index('ql3_approved_action_execution_recovery_idx')
      .on(table.leaseExpiresAtMs, table.dispatchId)
      .where(sql`${table.status} = 'executing'`),
    index('ql3_approved_action_execution_project_idx').on(
      table.projectId,
      table.updatedAtMs,
      table.dispatchId,
    ),
  ],
);

export const pluginPackageInstallProposals = sqliteTable(
  'QingLong3PluginPackageInstallProposals',
  {
    actionRef: text('action_ref').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    actionType: text('action_type').notNull(),
    permission: text('permission').notNull(),
    actionDigest: text('action_digest').notNull(),
    previewDigest: text('preview_digest').notNull(),
    proposedByType: text('proposed_by_type').notNull(),
    proposedById: text('proposed_by_id').notNull(),
    fenceProjectVersion: integer('fence_project_version').notNull(),
    fenceBindingVersion: integer('fence_binding_version'),
    createdAtMs: integer('created_at_ms').notNull(),
    proposalJson: text('proposal_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    proposalDigest: text('proposal_digest').notNull(),
  },
  (table) => [
    check(
      'ql3_plugin_package_proposal_identity_check',
      sql`length(${table.actionRef}) between 1 and 255 and ${table.actionType} = 'plugin_package.install' and ${table.permission} = 'package.manage' and ${table.proposedByType} in ('user','api_app','mcp_client','agent','system','worker') and length(${table.proposedById}) between 1 and 255`,
    ),
    check(
      'ql3_plugin_package_proposal_digest_check',
      sql`length(${table.actionDigest}) = 64 and ${table.actionDigest} not glob '*[^0-9a-f]*' and length(${table.previewDigest}) = 64 and ${table.previewDigest} not glob '*[^0-9a-f]*' and length(${table.proposalDigest}) = 64 and ${table.proposalDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_proposal_json_check',
      sql`length(${table.proposalJson}) between 2 and 262144 and json_valid(${table.proposalJson}) and json_type(${table.proposalJson}) = 'object' and json_extract(${table.proposalJson}, '$.schema') = 'qinglong/plugin-package-install-proposal@v1' and json_extract(${table.proposalJson}, '$.actionRef') = ${table.actionRef} and json_extract(${table.proposalJson}, '$.projectId') = ${table.projectId} and json_extract(${table.proposalJson}, '$.actionType') = ${table.actionType} and json_extract(${table.proposalJson}, '$.permission') = ${table.permission} and json_extract(${table.proposalJson}, '$.actionDigest') = ${table.actionDigest} and json_extract(${table.proposalJson}, '$.previewDigest') = ${table.previewDigest} and json_extract(${table.proposalJson}, '$.proposedBy.type') = ${table.proposedByType} and json_extract(${table.proposalJson}, '$.proposedBy.id') = ${table.proposedById} and json_extract(${table.proposalJson}, '$.proposalFence.projectVersion') = ${table.fenceProjectVersion} and json_extract(${table.proposalJson}, '$.proposalFence.bindingVersion') is ${table.fenceBindingVersion} and json_extract(${table.proposalJson}, '$.createdAtMs') = ${table.createdAtMs} and json_extract(${table.proposalJson}, '$.proposalDigest') = ${table.proposalDigest}`,
    ),
    check(
      'ql3_plugin_package_proposal_time_check',
      sql`${table.fenceProjectVersion} > 0 and (${table.fenceBindingVersion} is null or ${table.fenceBindingVersion} > 0) and ${table.createdAtMs} >= 0`,
    ),
    index('ql3_plugin_package_proposal_project_idx').on(
      table.projectId,
      table.createdAtMs,
      table.actionRef,
    ),
  ],
);

export const pluginPackageInstalls = sqliteTable(
  'QingLong3PluginPackageInstalls',
  {
    installationId: text('installation_id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    packageName: text('package_name').notNull(),
    packageVersion: text('package_version').notNull(),
    operation: text('operation').notNull(),
    lockDigest: text('lock_digest').notNull(),
    targetGeneration: integer('target_generation').notNull(),
    previousActiveLockDigest: text('previous_active_lock_digest'),
    activeLockDigest: text('active_lock_digest'),
    state: text('state').notNull(),
    version: integer('version').notNull(),
    lastMutationId: text('last_mutation_id').notNull(),
    lastMutationDigest: text('last_mutation_digest').notNull(),
    lockJson: text('lock_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    recordJson: text('record_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    recordDigest: text('record_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_plugin_package_installs_identity_check',
      sql`length(${table.installationId}) between 1 and 128 and length(${table.packageName}) between 1 and 253 and length(${table.packageVersion}) between 1 and 128 and length(${table.lastMutationId}) between 1 and 128`,
    ),
    check(
      'ql3_plugin_package_installs_operation_check',
      sql`${table.operation} in ('install','reinstall','upgrade','rollback')`,
    ),
    check(
      'ql3_plugin_package_installs_state_check',
      sql`${table.state} in ('queued','staged','activating','active','failed')`,
    ),
    check(
      'ql3_plugin_package_installs_version_check',
      sql`${table.targetGeneration} between 1 and 2147483647 and ${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_plugin_package_installs_digest_check',
      sql`length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and (${table.previousActiveLockDigest} is null or (length(${table.previousActiveLockDigest}) = 64 and ${table.previousActiveLockDigest} not glob '*[^0-9a-f]*')) and (${table.activeLockDigest} is null or (length(${table.activeLockDigest}) = 64 and ${table.activeLockDigest} not glob '*[^0-9a-f]*')) and length(${table.lastMutationDigest}) = 64 and ${table.lastMutationDigest} not glob '*[^0-9a-f]*' and length(${table.recordDigest}) = 64 and ${table.recordDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_installs_record_check',
      sql`length(${table.lockJson}) between 2 and 262144 and json_valid(${table.lockJson}) and json_type(${table.lockJson}) = 'object' and json_extract(${table.lockJson}, '$.lockDigest') = ${table.lockDigest} and json_extract(${table.lockJson}, '$.projectId') = ${table.projectId} and json_extract(${table.lockJson}, '$.packageName') = ${table.packageName} and length(${table.recordJson}) between 2 and 262144 and json_valid(${table.recordJson}) and json_type(${table.recordJson}) = 'object' and json_extract(${table.recordJson}, '$.installationId') = ${table.installationId} and json_extract(${table.recordJson}, '$.projectId') = ${table.projectId} and json_extract(${table.recordJson}, '$.packageName') = ${table.packageName} and json_extract(${table.recordJson}, '$.lockDigest') = ${table.lockDigest} and json_extract(${table.recordJson}, '$.state') = ${table.state} and json_extract(${table.recordJson}, '$.version') = ${table.version} and json_extract(${table.recordJson}, '$.recordDigest') = ${table.recordDigest}`,
    ),
    check(
      'ql3_plugin_package_installs_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    index('ql3_plugin_package_installs_recovery_idx')
      .on(table.state, table.packageName, table.installationId)
      .where(sql`${table.state} in ('queued','staged','activating')`),
    index('ql3_plugin_package_installs_project_history_idx').on(
      table.projectId,
      table.packageName,
      table.createdAtMs,
      table.installationId,
    ),
    uniqueIndex('ql3_plugin_package_installs_snapshot_source_uidx').on(
      table.projectId,
      table.packageName,
      table.installationId,
      table.targetGeneration,
      table.lockDigest,
    ),
    uniqueIndex('ql3_plugin_package_installs_quarantine_target_uidx').on(
      table.projectId,
      table.packageName,
      table.installationId,
      table.lockDigest,
      table.recordDigest,
    ),
  ],
);

export const pluginPackageInstallHeads = sqliteTable(
  'QingLong3PluginPackageInstallHeads',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    packageName: text('package_name').notNull(),
    installationId: text('installation_id')
      .notNull()
      .references(() => pluginPackageInstalls.installationId, {
        onDelete: 'restrict',
      }),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.packageName] }),
    uniqueIndex('ql3_plugin_package_install_heads_install_uidx').on(
      table.installationId,
    ),
    check(
      'ql3_plugin_package_install_heads_identity_check',
      sql`length(${table.packageName}) between 1 and 253 and length(${table.installationId}) between 1 and 128`,
    ),
  ],
);

export const pluginPackageInstallMutations = sqliteTable(
  'QingLong3PluginPackageInstallMutations',
  {
    installationId: text('installation_id')
      .notNull()
      .references(() => pluginPackageInstalls.installationId, {
        onDelete: 'restrict',
      }),
    mutationId: text('mutation_id').notNull(),
    mutationDigest: text('mutation_digest').notNull(),
    resultingRecordDigest: text('resulting_record_digest').notNull(),
    occurredAtMs: integer('occurred_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.installationId, table.mutationId] }),
    check(
      'ql3_plugin_package_install_mutations_identity_check',
      sql`length(${table.mutationId}) between 1 and 128`,
    ),
    check(
      'ql3_plugin_package_install_mutations_digest_check',
      sql`length(${table.mutationDigest}) = 64 and ${table.mutationDigest} not glob '*[^0-9a-f]*' and length(${table.resultingRecordDigest}) = 64 and ${table.resultingRecordDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_install_mutations_time_check',
      sql`${table.occurredAtMs} >= 0`,
    ),
    index('ql3_plugin_package_install_mutations_result_idx').on(
      table.installationId,
      table.resultingRecordDigest,
    ),
  ],
);

export const pluginPackageMaterializedRevisions = sqliteTable(
  'QingLong3PluginPackageMaterializedRevisions',
  {
    generationDigest: text('generation_digest').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    packageName: text('package_name').notNull(),
    generation: integer('generation').notNull(),
    lockDigest: text('lock_digest').notNull(),
    manifestDigest: text('manifest_digest').notNull(),
    revisionDigest: text('revision_digest').notNull(),
    revisionJson: text('revision_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_plugin_package_materialized_revision_identity_check',
      sql`length(${table.packageName}) between 1 and 63 and ${table.generation} between 1 and 2147483647`,
    ),
    check(
      'ql3_plugin_package_materialized_revision_digest_check',
      sql`length(${table.generationDigest}) = 64 and ${table.generationDigest} not glob '*[^0-9a-f]*' and length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and length(${table.manifestDigest}) = 64 and ${table.manifestDigest} not glob '*[^0-9a-f]*' and length(${table.revisionDigest}) = 64 and ${table.revisionDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_materialized_revision_json_check',
      sql`length(${table.revisionJson}) between 2 and 25165824 and json_valid(${table.revisionJson}) and json_type(${table.revisionJson}) = 'object' and json_extract(${table.revisionJson}, '$.schema') = 'qinglong/plugin-package-materialized-revision@v1' and json_extract(${table.revisionJson}, '$.generation.generationDigest') = ${table.generationDigest} and json_extract(${table.revisionJson}, '$.generation.projectId') = ${table.projectId} and json_extract(${table.revisionJson}, '$.generation.packageName') = ${table.packageName} and json_extract(${table.revisionJson}, '$.generation.generation') = ${table.generation} and json_extract(${table.revisionJson}, '$.generation.lockDigest') = ${table.lockDigest} and json_extract(${table.revisionJson}, '$.manifestDigest') = ${table.manifestDigest} and json_extract(${table.revisionJson}, '$.revisionDigest') = ${table.revisionDigest}`,
    ),
    check(
      'ql3_plugin_package_materialized_revision_time_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    uniqueIndex('ql3_plugin_package_materialized_revision_generation_uidx').on(
      table.projectId,
      table.packageName,
      table.generation,
    ),
    index('ql3_plugin_package_materialized_revision_lock_idx').on(
      table.lockDigest,
      table.generationDigest,
    ),
    uniqueIndex(
      'ql3_plugin_package_materialized_revision_snapshot_source_uidx',
    ).on(
      table.projectId,
      table.packageName,
      table.generation,
      table.generationDigest,
      table.lockDigest,
      table.revisionDigest,
    ),
  ],
);

export const pluginPackageSecretBindings = sqliteTable(
  'QingLong3PluginPackageSecretBindings',
  {
    generationDigest: text('generation_digest').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    packageName: text('package_name').notNull(),
    installationId: text('installation_id')
      .notNull()
      .references(() => pluginPackageInstalls.installationId, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    lockDigest: text('lock_digest').notNull(),
    generation: integer('generation').notNull(),
    manifestDigest: text('manifest_digest').notNull(),
    authorityKind: text('authority_kind').notNull(),
    evidenceDigest: text('evidence_digest').notNull(),
    boundAtMs: integer('bound_at_ms').notNull(),
    bindingDigest: text('binding_digest').notNull(),
    bindingJson: text('binding_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    check(
      'ql3_plugin_package_secret_binding_identity_check',
      sql`length(${table.projectId}) between 1 and 128 and length(${table.packageName}) between 1 and 63 and length(${table.installationId}) between 1 and 128 and ${table.generation} between 1 and 2147483647 and ${table.authorityKind} in ('approved-action-execution','local-owner-confirmation') and ${table.boundAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_secret_binding_digest_check',
      sql`length(${table.generationDigest}) = 64 and ${table.generationDigest} not glob '*[^0-9a-f]*' and length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and length(${table.manifestDigest}) = 64 and ${table.manifestDigest} not glob '*[^0-9a-f]*' and length(${table.evidenceDigest}) = 64 and ${table.evidenceDigest} not glob '*[^0-9a-f]*' and length(${table.bindingDigest}) = 64 and ${table.bindingDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_secret_binding_json_check',
      sql`length(cast(${table.bindingJson} as blob)) between 2 and 65536 and json_valid(${table.bindingJson}) and json_type(${table.bindingJson}) = 'object' and json_extract(${table.bindingJson}, '$.schema') = 'qinglong/plugin-package-secret-binding@v1' and json_extract(${table.bindingJson}, '$.target.generationDigest') = ${table.generationDigest} and json_extract(${table.bindingJson}, '$.target.projectId') = ${table.projectId} and json_extract(${table.bindingJson}, '$.target.packageName') = ${table.packageName} and json_extract(${table.bindingJson}, '$.target.installationId') = ${table.installationId} and json_extract(${table.bindingJson}, '$.target.lockDigest') = ${table.lockDigest} and json_extract(${table.bindingJson}, '$.target.generation') = ${table.generation} and json_extract(${table.bindingJson}, '$.target.manifestDigest') = ${table.manifestDigest} and json_extract(${table.bindingJson}, '$.authority.kind') = ${table.authorityKind} and json_extract(${table.bindingJson}, '$.authority.evidenceDigest') = ${table.evidenceDigest} and json_extract(${table.bindingJson}, '$.boundAtMs') = ${table.boundAtMs} and json_extract(${table.bindingJson}, '$.bindingDigest') = ${table.bindingDigest} and json_type(${table.bindingJson}, '$.entries') = 'array' and json_array_length(json_extract(${table.bindingJson}, '$.entries')) between 1 and 64`,
    ),
    uniqueIndex('ql3_plugin_package_secret_binding_generation_uidx').on(
      table.projectId,
      table.packageName,
      table.generation,
    ),
    uniqueIndex('ql3_plugin_package_secret_binding_digest_uidx').on(
      table.bindingDigest,
    ),
    index('ql3_plugin_package_secret_binding_install_idx').on(
      table.installationId,
      table.generationDigest,
    ),
  ],
);

export const pluginPackageSecretBindingTransitionReceipts = sqliteTable(
  'QingLong3PluginPackageSecretBindingTransitionReceipts',
  {
    generationDigest: text('generation_digest').primaryKey(),
    transitionDigest: text('transition_digest').notNull(),
    projectId: text('project_id').notNull(),
    packageName: text('package_name').notNull(),
    installationId: text('installation_id')
      .notNull()
      .references(() => pluginPackageInstalls.installationId, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    lockDigest: text('lock_digest').notNull(),
    generation: integer('generation').notNull(),
    manifestDigest: text('manifest_digest').notNull(),
    previousActiveLockDigest: text('previous_active_lock_digest').notNull(),
    authorityKind: text('authority_kind').notNull(),
    evidenceDigest: text('evidence_digest').notNull(),
    bindingDigest: text('binding_digest').references(
      () => pluginPackageSecretBindings.bindingDigest,
      { onDelete: 'restrict', onUpdate: 'restrict' },
    ),
    committedAtMs: integer('committed_at_ms').notNull(),
    receiptDigest: text('receipt_digest').notNull(),
    receiptJson: text('receipt_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    check(
      'ql3_plugin_package_secret_binding_transition_receipt_identity_check',
      sql`length(${table.projectId}) between 1 and 128 and length(${table.packageName}) between 1 and 63 and length(${table.installationId}) between 1 and 128 and ${table.generation} between 2 and 2147483647 and ${table.authorityKind} in ('approved-action-execution','local-owner-confirmation') and ${table.committedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_secret_binding_transition_receipt_digest_check',
      sql`length(${table.generationDigest}) = 64 and ${table.generationDigest} not glob '*[^0-9a-f]*' and length(${table.transitionDigest}) = 64 and ${table.transitionDigest} not glob '*[^0-9a-f]*' and length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and length(${table.manifestDigest}) = 64 and ${table.manifestDigest} not glob '*[^0-9a-f]*' and length(${table.previousActiveLockDigest}) = 64 and ${table.previousActiveLockDigest} not glob '*[^0-9a-f]*' and length(${table.evidenceDigest}) = 64 and ${table.evidenceDigest} not glob '*[^0-9a-f]*' and (${table.bindingDigest} is null or (length(${table.bindingDigest}) = 64 and ${table.bindingDigest} not glob '*[^0-9a-f]*')) and length(${table.receiptDigest}) = 64 and ${table.receiptDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_secret_binding_transition_receipt_json_check',
      sql`length(cast(${table.receiptJson} as blob)) between 2 and 196608 and json_valid(${table.receiptJson}) and json_type(${table.receiptJson}) = 'object' and json_extract(${table.receiptJson}, '$.schema') = 'qinglong/plugin-package-secret-binding-transition-receipt@v1' and json_extract(${table.receiptJson}, '$.transitionPlan.transitionDigest') = ${table.transitionDigest} and json_extract(${table.receiptJson}, '$.transitionPlan.nextTarget.generationDigest') = ${table.generationDigest} and json_extract(${table.receiptJson}, '$.transitionPlan.nextTarget.projectId') = ${table.projectId} and json_extract(${table.receiptJson}, '$.transitionPlan.nextTarget.packageName') = ${table.packageName} and json_extract(${table.receiptJson}, '$.transitionPlan.nextTarget.installationId') = ${table.installationId} and json_extract(${table.receiptJson}, '$.transitionPlan.nextTarget.lockDigest') = ${table.lockDigest} and json_extract(${table.receiptJson}, '$.transitionPlan.nextTarget.generation') = ${table.generation} and json_extract(${table.receiptJson}, '$.transitionPlan.nextTarget.manifestDigest') = ${table.manifestDigest} and json_extract(${table.receiptJson}, '$.transitionPlan.previousActiveLockDigest') = ${table.previousActiveLockDigest} and json_extract(${table.receiptJson}, '$.authority.kind') = ${table.authorityKind} and json_extract(${table.receiptJson}, '$.authority.evidenceDigest') = ${table.evidenceDigest} and json_extract(${table.receiptJson}, '$.bindingDigest') is ${table.bindingDigest} and json_extract(${table.receiptJson}, '$.committedAtMs') = ${table.committedAtMs} and json_extract(${table.receiptJson}, '$.receiptDigest') = ${table.receiptDigest}`,
    ),
    uniqueIndex(
      'ql3_plugin_package_secret_binding_transition_receipt_transition_uidx',
    ).on(table.transitionDigest),
    uniqueIndex(
      'ql3_plugin_package_secret_binding_transition_receipt_digest_uidx',
    ).on(table.receiptDigest),
    index(
      'ql3_plugin_package_secret_binding_transition_receipt_install_idx',
    ).on(table.installationId, table.generationDigest),
  ],
);

export const projectToolDefinitionSnapshots = sqliteTable(
  'QingLong3ProjectToolDefinitionSnapshots',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    activeVectorDigest: text('active_vector_digest').notNull(),
    definitionsDigest: text('definitions_digest').notNull(),
    snapshotDigest: text('snapshot_digest').notNull(),
    snapshotJson: text('snapshot_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    committedAtMs: integer('committed_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.activeVectorDigest] }),
    check(
      'ql3_project_tool_definition_snapshot_identity_check',
      sql`length(${table.projectId}) between 1 and 128`,
    ),
    check(
      'ql3_project_tool_definition_snapshot_digest_check',
      sql`length(${table.activeVectorDigest}) = 64 and ${table.activeVectorDigest} not glob '*[^0-9a-f]*' and length(${table.definitionsDigest}) = 64 and ${table.definitionsDigest} not glob '*[^0-9a-f]*' and length(${table.snapshotDigest}) = 64 and ${table.snapshotDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_project_tool_definition_snapshot_json_check',
      sql`length(${table.snapshotJson}) between 2 and 8388608 and json_valid(${table.snapshotJson}) and json_type(${table.snapshotJson}) = 'object' and json_extract(${table.snapshotJson}, '$.schema') = 'qinglong/project-tool-definition-snapshot@v1' and json_extract(${table.snapshotJson}, '$.projectId') = ${table.projectId} and json_extract(${table.snapshotJson}, '$.activeVectorDigest') = ${table.activeVectorDigest} and json_extract(${table.snapshotJson}, '$.definitionsDigest') = ${table.definitionsDigest} and json_extract(${table.snapshotJson}, '$.snapshotDigest') = ${table.snapshotDigest}`,
    ),
    check(
      'ql3_project_tool_definition_snapshot_time_check',
      sql`${table.committedAtMs} >= 0`,
    ),
    uniqueIndex('ql3_project_tool_definition_snapshot_digest_uidx').on(
      table.snapshotDigest,
    ),
    uniqueIndex('ql3_project_tool_definition_snapshot_withdrawal_uidx').on(
      table.projectId,
      table.activeVectorDigest,
      table.snapshotDigest,
    ),
    index('ql3_project_tool_definition_snapshot_current_idx').on(
      table.projectId,
      sql`${table.committedAtMs} desc`,
      table.activeVectorDigest,
    ),
  ],
);

export const projectToolDefinitionSnapshotSources = sqliteTable(
  'QingLong3ProjectToolDefinitionSnapshotSources',
  {
    projectId: text('project_id').notNull(),
    activeVectorDigest: text('active_vector_digest').notNull(),
    packageName: text('package_name').notNull(),
    installationId: text('installation_id').notNull(),
    generation: integer('generation').notNull(),
    generationDigest: text('generation_digest').notNull(),
    lockDigest: text('lock_digest').notNull(),
    revisionDigest: text('revision_digest').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.activeVectorDigest, table.packageName],
    }),
    foreignKey({
      columns: [table.projectId, table.activeVectorDigest],
      foreignColumns: [
        projectToolDefinitionSnapshots.projectId,
        projectToolDefinitionSnapshots.activeVectorDigest,
      ],
      name: 'ql3_project_tool_definition_snapshot_source_snapshot_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.projectId,
        table.packageName,
        table.installationId,
        table.generation,
        table.lockDigest,
      ],
      foreignColumns: [
        pluginPackageInstalls.projectId,
        pluginPackageInstalls.packageName,
        pluginPackageInstalls.installationId,
        pluginPackageInstalls.targetGeneration,
        pluginPackageInstalls.lockDigest,
      ],
      name: 'ql3_project_tool_definition_snapshot_source_install_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.projectId,
        table.packageName,
        table.generation,
        table.generationDigest,
        table.lockDigest,
        table.revisionDigest,
      ],
      foreignColumns: [
        pluginPackageMaterializedRevisions.projectId,
        pluginPackageMaterializedRevisions.packageName,
        pluginPackageMaterializedRevisions.generation,
        pluginPackageMaterializedRevisions.generationDigest,
        pluginPackageMaterializedRevisions.lockDigest,
        pluginPackageMaterializedRevisions.revisionDigest,
      ],
      name: 'ql3_project_tool_definition_snapshot_source_revision_fk',
    }).onDelete('restrict'),
    check(
      'ql3_project_tool_definition_snapshot_source_identity_check',
      sql`length(${table.packageName}) between 1 and 63 and length(${table.installationId}) between 1 and 128 and ${table.generation} between 1 and 2147483647`,
    ),
    check(
      'ql3_project_tool_definition_snapshot_source_digest_check',
      sql`length(${table.activeVectorDigest}) = 64 and ${table.activeVectorDigest} not glob '*[^0-9a-f]*' and length(${table.generationDigest}) = 64 and ${table.generationDigest} not glob '*[^0-9a-f]*' and length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and length(${table.revisionDigest}) = 64 and ${table.revisionDigest} not glob '*[^0-9a-f]*'`,
    ),
    index('ql3_project_tool_definition_snapshot_source_generation_idx').on(
      table.generationDigest,
      table.projectId,
      table.packageName,
    ),
    index('ql3_project_tool_definition_snapshot_source_install_idx').on(
      table.installationId,
      table.activeVectorDigest,
    ),
  ],
);

export const taskDefinitions = sqliteTable(
  'QingLong3TaskDefinitions',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    taskId: text('task_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.taskId] }),
    check(
      'ql3_task_definitions_id_check',
      sql`length(${table.projectId}) between 1 and 128 and length(${table.taskId}) between 1 and 128 and ${table.projectId} not glob '*[' || char(0) || '-' || char(31) || char(127) || ']*' and ${table.taskId} not glob '*[' || char(0) || '-' || char(31) || char(127) || ']*'`,
    ),
    check(
      'ql3_task_definitions_revision_check',
      sql`${table.currentRevision} between 1 and 2147483647`,
    ),
    check(
      'ql3_task_definitions_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
  ],
);

export const taskDefinitionRevisions = sqliteTable(
  'QingLong3TaskDefinitionRevisions',
  {
    projectId: text('project_id').notNull(),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    mutationId: text('mutation_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    kind: text('kind').notNull(),
    specJson: text('spec_json').notNull(),
    labelsJson: text('labels_json').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    contentDigest: text('content_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.taskId, table.revision] }),
    foreignKey({
      columns: [table.projectId, table.taskId],
      foreignColumns: [taskDefinitions.projectId, taskDefinitions.taskId],
      name: 'ql3_task_definition_revisions_task_fk',
    }).onDelete('restrict'),
    check(
      'ql3_task_definition_revisions_revision_check',
      sql`${table.revision} between 1 and 2147483647`,
    ),
    check(
      'ql3_task_definition_revisions_mutation_check',
      sql`length(${table.mutationId}) = 36 and substr(${table.mutationId}, 9, 1) = '-' and substr(${table.mutationId}, 14, 1) = '-' and substr(${table.mutationId}, 19, 1) = '-' and substr(${table.mutationId}, 24, 1) = '-' and replace(${table.mutationId}, '-', '') not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_task_definition_revisions_name_check',
      sql`length(${table.name}) between 1 and 255 and (${table.description} is null or length(${table.description}) between 1 and 4096)`,
    ),
    check(
      'ql3_task_definition_revisions_kind_check',
      sql`${table.kind} in ('script','command','workflow','agent','tool')`,
    ),
    check(
      'ql3_task_definition_revisions_spec_check',
      sql`json_valid(${table.specJson}) and json_type(${table.specJson}) = 'object' and length(${table.specJson}) between 1 and 65536`,
    ),
    check(
      'ql3_task_definition_revisions_labels_check',
      sql`json_valid(${table.labelsJson}) and json_type(${table.labelsJson}) = 'object' and length(${table.labelsJson}) between 2 and 16384`,
    ),
    check(
      'ql3_task_definition_revisions_enabled_check',
      sql`${table.enabled} in (0, 1)`,
    ),
    check(
      'ql3_task_definition_revisions_digest_check',
      sql`length(${table.contentDigest}) = 64 and ${table.contentDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_task_definition_revisions_created_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    uniqueIndex('ql3_task_definition_revisions_mutation_uidx').on(
      table.mutationId,
    ),
    index('ql3_task_definition_revisions_project_kind_idx').on(
      table.projectId,
      table.kind,
      table.enabled,
      table.taskId,
      table.revision,
    ),
  ],
);

export const pluginPackageQuarantineEvents = sqliteTable(
  'QingLong3PluginPackageQuarantineEvents',
  {
    eventDigest: text('event_digest').primaryKey(),
    mutationId: text('mutation_id').notNull(),
    revocationReceiptDigest: text('revocation_receipt_digest').notNull(),
    impactDigest: text('impact_digest').notNull(),
    projectId: text('project_id').notNull(),
    packageName: text('package_name').notNull(),
    installationId: text('installation_id').notNull(),
    lockDigest: text('lock_digest').notNull(),
    installState: text('install_state').notNull(),
    installVersion: integer('install_version').notNull(),
    installRecordDigest: text('install_record_digest').notNull(),
    activeLockDigest: text('active_lock_digest'),
    proposerType: text('proposer_type').notNull(),
    proposerId: text('proposer_id').notNull(),
    confirmerType: text('confirmer_type').notNull(),
    confirmerId: text('confirmer_id').notNull(),
    authorizationMode: text('authorization_mode').notNull(),
    reasonCode: text('reason_code').notNull(),
    occurredAtMs: integer('occurred_at_ms').notNull(),
    eventJson: text('event_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    uniqueIndex('ql3_plugin_package_quarantine_mutation_uidx').on(
      table.mutationId,
    ),
    uniqueIndex('ql3_plugin_package_quarantine_target_uidx').on(
      table.projectId,
      table.packageName,
      table.installationId,
      table.lockDigest,
    ),
    foreignKey({
      columns: [
        table.projectId,
        table.packageName,
        table.installationId,
        table.lockDigest,
        table.installRecordDigest,
      ],
      foreignColumns: [
        pluginPackageInstalls.projectId,
        pluginPackageInstalls.packageName,
        pluginPackageInstalls.installationId,
        pluginPackageInstalls.lockDigest,
        pluginPackageInstalls.recordDigest,
      ],
      name: 'ql3_plugin_package_quarantine_install_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'ql3_plugin_package_quarantine_identity_check',
      sql`length(${table.mutationId}) between 1 and 128 and length(${table.packageName}) between 1 and 63 and length(${table.installationId}) between 1 and 128 and ${table.installState} in ('queued','staged','activating','active') and ${table.installVersion} between 1 and 2147483647`,
    ),
    check(
      'ql3_plugin_package_quarantine_state_check',
      sql`(${table.installState} = 'active' and ${table.activeLockDigest} = ${table.lockDigest}) or (${table.installState} <> 'active' and (${table.activeLockDigest} is null or ${table.activeLockDigest} <> ${table.lockDigest}))`,
    ),
    check(
      'ql3_plugin_package_quarantine_subject_check',
      sql`${table.proposerType} in ('user','api_app','mcp_client','agent','system','worker') and ${table.confirmerType} in ('user','api_app','mcp_client','agent','system','worker') and length(${table.proposerId}) between 1 and 255 and length(${table.confirmerId}) between 1 and 255 and ${table.authorizationMode} in ('dual_control','break_glass') and (${table.authorizationMode} = 'break_glass' or ${table.proposerType} <> ${table.confirmerType} or ${table.proposerId} <> ${table.confirmerId}) and ${table.reasonCode} in ('suspected_key_compromise','confirmed_key_compromise')`,
    ),
    check(
      'ql3_plugin_package_quarantine_digest_check',
      sql`length(${table.eventDigest}) = 64 and ${table.eventDigest} not glob '*[^0-9a-f]*' and length(${table.revocationReceiptDigest}) = 64 and ${table.revocationReceiptDigest} not glob '*[^0-9a-f]*' and length(${table.impactDigest}) = 64 and ${table.impactDigest} not glob '*[^0-9a-f]*' and length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and length(${table.installRecordDigest}) = 64 and ${table.installRecordDigest} not glob '*[^0-9a-f]*' and (${table.activeLockDigest} is null or (length(${table.activeLockDigest}) = 64 and ${table.activeLockDigest} not glob '*[^0-9a-f]*'))`,
    ),
    check(
      'ql3_plugin_package_quarantine_json_check',
      sql`length(${table.eventJson}) between 2 and 262144 and json_valid(${table.eventJson}) and json_type(${table.eventJson}) = 'object' and json_extract(${table.eventJson}, '$.schema') = 'qinglong/plugin-package-quarantine-event@v1' and json_extract(${table.eventJson}, '$.mutationId') = ${table.mutationId} and json_extract(${table.eventJson}, '$.revocationReceiptDigest') = ${table.revocationReceiptDigest} and json_extract(${table.eventJson}, '$.impactDigest') = ${table.impactDigest} and json_extract(${table.eventJson}, '$.target.projectId') = ${table.projectId} and json_extract(${table.eventJson}, '$.target.packageName') = ${table.packageName} and json_extract(${table.eventJson}, '$.target.installationId') = ${table.installationId} and json_extract(${table.eventJson}, '$.target.lockDigest') = ${table.lockDigest} and json_extract(${table.eventJson}, '$.target.installState') = ${table.installState} and json_extract(${table.eventJson}, '$.target.installVersion') = ${table.installVersion} and json_extract(${table.eventJson}, '$.target.installRecordDigest') = ${table.installRecordDigest} and ((${table.activeLockDigest} is null and json_type(${table.eventJson}, '$.target.activeLockDigest') = 'null') or json_extract(${table.eventJson}, '$.target.activeLockDigest') = ${table.activeLockDigest}) and json_extract(${table.eventJson}, '$.proposer.type') = ${table.proposerType} and json_extract(${table.eventJson}, '$.proposer.id') = ${table.proposerId} and json_extract(${table.eventJson}, '$.confirmer.type') = ${table.confirmerType} and json_extract(${table.eventJson}, '$.confirmer.id') = ${table.confirmerId} and json_extract(${table.eventJson}, '$.authorizationMode') = ${table.authorizationMode} and json_extract(${table.eventJson}, '$.reasonCode') = ${table.reasonCode} and json_extract(${table.eventJson}, '$.occurredAtMs') = ${table.occurredAtMs} and json_extract(${table.eventJson}, '$.eventDigest') = ${table.eventDigest}`,
    ),
    check(
      'ql3_plugin_package_quarantine_time_check',
      sql`${table.occurredAtMs} >= 0`,
    ),
    index('ql3_plugin_package_quarantine_lock_idx').on(
      table.lockDigest,
      table.projectId,
      table.packageName,
    ),
    index('ql3_plugin_package_quarantine_project_idx').on(
      table.projectId,
      table.packageName,
      table.occurredAtMs,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageWithdrawalReceipts = sqliteTable(
  'QingLong3PluginPackageWithdrawalReceipts',
  {
    eventDigest: text('event_digest')
      .primaryKey()
      .references(() => pluginPackageQuarantineEvents.eventDigest, {
        onDelete: 'restrict',
      }),
    receiptDigest: text('receipt_digest').notNull(),
    projectId: text('project_id').notNull(),
    capabilityStatus: text('capability_status').notNull(),
    taskCount: integer('task_count').notNull(),
    previousActiveVectorDigest: text('previous_active_vector_digest'),
    currentActiveVectorDigest: text('current_active_vector_digest'),
    currentToolSnapshotDigest: text('current_tool_snapshot_digest'),
    retainedSourceCount: integer('retained_source_count').notNull(),
    committedAtMs: integer('committed_at_ms').notNull(),
    receiptJson: text('receipt_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    uniqueIndex('ql3_plugin_package_withdrawal_receipt_uidx').on(
      table.receiptDigest,
    ),
    foreignKey({
      columns: [
        table.projectId,
        table.currentActiveVectorDigest,
        table.currentToolSnapshotDigest,
      ],
      foreignColumns: [
        projectToolDefinitionSnapshots.projectId,
        projectToolDefinitionSnapshots.activeVectorDigest,
        projectToolDefinitionSnapshots.snapshotDigest,
      ],
      name: 'ql3_plugin_package_withdrawal_snapshot_fk',
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_withdrawal_disposition_check',
      sql`(${table.capabilityStatus} = 'not_active' and ${table.taskCount} = 0 and ${table.previousActiveVectorDigest} is null and ${table.currentActiveVectorDigest} is null and ${table.currentToolSnapshotDigest} is null and ${table.retainedSourceCount} = 0) or (${table.capabilityStatus} = 'withdrawn' and ${table.taskCount} between 0 and 128 and ${table.previousActiveVectorDigest} is not null and ${table.currentActiveVectorDigest} is not null and ${table.previousActiveVectorDigest} <> ${table.currentActiveVectorDigest} and ${table.currentToolSnapshotDigest} is not null and ${table.retainedSourceCount} between 0 and 128)`,
    ),
    check(
      'ql3_plugin_package_withdrawal_digest_check',
      sql`length(${table.eventDigest}) = 64 and ${table.eventDigest} not glob '*[^0-9a-f]*' and length(${table.receiptDigest}) = 64 and ${table.receiptDigest} not glob '*[^0-9a-f]*' and (${table.previousActiveVectorDigest} is null or (length(${table.previousActiveVectorDigest}) = 64 and ${table.previousActiveVectorDigest} not glob '*[^0-9a-f]*')) and (${table.currentActiveVectorDigest} is null or (length(${table.currentActiveVectorDigest}) = 64 and ${table.currentActiveVectorDigest} not glob '*[^0-9a-f]*')) and (${table.currentToolSnapshotDigest} is null or (length(${table.currentToolSnapshotDigest}) = 64 and ${table.currentToolSnapshotDigest} not glob '*[^0-9a-f]*'))`,
    ),
    check(
      'ql3_plugin_package_withdrawal_json_check',
      sql`length(${table.receiptJson}) between 2 and 8388608 and json_valid(${table.receiptJson}) and json_type(${table.receiptJson}) = 'object' and json_extract(${table.receiptJson}, '$.schema') = 'qinglong/plugin-package-withdrawal-receipt@v1' and json_extract(${table.receiptJson}, '$.eventDigest') = ${table.eventDigest} and json_extract(${table.receiptJson}, '$.target.projectId') = ${table.projectId} and json_extract(${table.receiptJson}, '$.capability.status') = ${table.capabilityStatus} and json_array_length(json_extract(${table.receiptJson}, '$.capability.taskWithdrawals')) = ${table.taskCount} and ((${table.previousActiveVectorDigest} is null and json_type(${table.receiptJson}, '$.capability.previousActiveVectorDigest') = 'null') or json_extract(${table.receiptJson}, '$.capability.previousActiveVectorDigest') = ${table.previousActiveVectorDigest}) and ((${table.currentActiveVectorDigest} is null and json_type(${table.receiptJson}, '$.capability.currentActiveVectorDigest') = 'null') or json_extract(${table.receiptJson}, '$.capability.currentActiveVectorDigest') = ${table.currentActiveVectorDigest}) and ((${table.currentToolSnapshotDigest} is null and json_type(${table.receiptJson}, '$.capability.currentToolSnapshotDigest') = 'null') or json_extract(${table.receiptJson}, '$.capability.currentToolSnapshotDigest') = ${table.currentToolSnapshotDigest}) and json_extract(${table.receiptJson}, '$.capability.retainedSourceCount') = ${table.retainedSourceCount} and json_extract(${table.receiptJson}, '$.committedAtMs') = ${table.committedAtMs} and json_extract(${table.receiptJson}, '$.receiptDigest') = ${table.receiptDigest}`,
    ),
    check(
      'ql3_plugin_package_withdrawal_time_check',
      sql`${table.committedAtMs} >= 0`,
    ),
    index('ql3_plugin_package_withdrawal_snapshot_idx').on(
      table.currentToolSnapshotDigest,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageWithdrawalTasks = sqliteTable(
  'QingLong3PluginPackageWithdrawalTasks',
  {
    eventDigest: text('event_digest')
      .notNull()
      .references(() => pluginPackageWithdrawalReceipts.eventDigest, {
        onDelete: 'restrict',
      }),
    projectId: text('project_id').notNull(),
    taskId: text('task_id').notNull(),
    previousRevision: integer('previous_revision').notNull(),
    disabledRevision: integer('disabled_revision').notNull(),
    previousContentDigest: text('previous_content_digest').notNull(),
    disabledContentDigest: text('disabled_content_digest').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventDigest, table.taskId] }),
    foreignKey({
      columns: [table.projectId, table.taskId, table.previousRevision],
      foreignColumns: [
        taskDefinitionRevisions.projectId,
        taskDefinitionRevisions.taskId,
        taskDefinitionRevisions.revision,
      ],
      name: 'ql3_plugin_package_withdrawal_task_previous_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.projectId, table.taskId, table.disabledRevision],
      foreignColumns: [
        taskDefinitionRevisions.projectId,
        taskDefinitionRevisions.taskId,
        taskDefinitionRevisions.revision,
      ],
      name: 'ql3_plugin_package_withdrawal_task_disabled_fk',
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_withdrawal_task_identity_check',
      sql`length(${table.taskId}) between 1 and 128 and ${table.previousRevision} between 1 and 2147483646 and ${table.disabledRevision} = ${table.previousRevision} + 1`,
    ),
    check(
      'ql3_plugin_package_withdrawal_task_digest_check',
      sql`length(${table.eventDigest}) = 64 and ${table.eventDigest} not glob '*[^0-9a-f]*' and length(${table.previousContentDigest}) = 64 and ${table.previousContentDigest} not glob '*[^0-9a-f]*' and length(${table.disabledContentDigest}) = 64 and ${table.disabledContentDigest} not glob '*[^0-9a-f]*'`,
    ),
    index('ql3_plugin_package_withdrawal_task_task_idx').on(
      table.projectId,
      table.taskId,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageTaskOwnerships = sqliteTable(
  'QingLong3PluginPackageTaskOwnerships',
  {
    projectId: text('project_id').notNull(),
    taskId: text('task_id').notNull(),
    packageName: text('package_name').notNull(),
    claimedGenerationDigest: text('claimed_generation_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.taskId] }),
    foreignKey({
      columns: [table.projectId, table.taskId],
      foreignColumns: [taskDefinitions.projectId, taskDefinitions.taskId],
      name: 'ql3_plugin_package_task_ownership_task_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [localProjects.id],
      name: 'ql3_plugin_package_task_ownership_project_fk',
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_task_ownership_identity_check',
      sql`length(${table.taskId}) between 1 and 128 and length(${table.packageName}) between 1 and 63`,
    ),
    check(
      'ql3_plugin_package_task_ownership_digest_check',
      sql`length(${table.claimedGenerationDigest}) = 64 and ${table.claimedGenerationDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_task_ownership_namespace_check',
      sql`${table.taskId} like 'pkg:' || ${table.packageName} || ':%'`,
    ),
    check(
      'ql3_plugin_package_task_ownership_time_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    index('ql3_plugin_package_task_ownership_package_idx').on(
      table.projectId,
      table.packageName,
      table.taskId,
    ),
  ],
);

export const pluginPackageTaskReconciliations = sqliteTable(
  'QingLong3PluginPackageTaskReconciliations',
  {
    generationDigest: text('generation_digest')
      .primaryKey()
      .references(() => pluginPackageMaterializedRevisions.generationDigest, {
        onDelete: 'restrict',
      }),
    projectId: text('project_id').notNull(),
    packageName: text('package_name').notNull(),
    generation: integer('generation').notNull(),
    materializedRevisionDigest: text('materialized_revision_digest').notNull(),
    lockDigest: text('lock_digest').notNull(),
    previousLockDigest: text('previous_lock_digest'),
    receiptDigest: text('receipt_digest').notNull(),
    receiptJson: text('receipt_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    committedAtMs: integer('committed_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_plugin_package_task_reconciliation_identity_check',
      sql`length(${table.packageName}) between 1 and 63 and ${table.generation} between 1 and 2147483647`,
    ),
    check(
      'ql3_plugin_package_task_reconciliation_digest_check',
      sql`length(${table.generationDigest}) = 64 and ${table.generationDigest} not glob '*[^0-9a-f]*' and length(${table.materializedRevisionDigest}) = 64 and ${table.materializedRevisionDigest} not glob '*[^0-9a-f]*' and length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and (${table.previousLockDigest} is null or (length(${table.previousLockDigest}) = 64 and ${table.previousLockDigest} not glob '*[^0-9a-f]*')) and length(${table.receiptDigest}) = 64 and ${table.receiptDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_task_reconciliation_json_check',
      sql`length(${table.receiptJson}) between 2 and 8388608 and json_valid(${table.receiptJson}) and json_type(${table.receiptJson}) = 'object' and json_extract(${table.receiptJson}, '$.schema') = 'qinglong/plugin-package-task-reconciliation@v1' and json_extract(${table.receiptJson}, '$.generationDigest') = ${table.generationDigest} and json_extract(${table.receiptJson}, '$.projectId') = ${table.projectId} and json_extract(${table.receiptJson}, '$.packageName') = ${table.packageName} and json_extract(${table.receiptJson}, '$.generation') = ${table.generation} and json_extract(${table.receiptJson}, '$.materializedRevisionDigest') = ${table.materializedRevisionDigest} and json_extract(${table.receiptJson}, '$.lockDigest') = ${table.lockDigest} and json_extract(${table.receiptJson}, '$.receiptDigest') = ${table.receiptDigest}`,
    ),
    check(
      'ql3_plugin_package_task_reconciliation_time_check',
      sql`${table.committedAtMs} >= 0`,
    ),
    uniqueIndex('ql3_plugin_package_task_reconciliation_generation_uidx').on(
      table.projectId,
      table.packageName,
      table.generation,
    ),
    uniqueIndex('ql3_plugin_package_task_reconciliation_receipt_uidx').on(
      table.generationDigest,
      table.receiptDigest,
    ),
    index('ql3_plugin_package_task_reconciliation_lock_idx').on(
      table.lockDigest,
      table.generationDigest,
    ),
  ],
);

export const pluginPackageTaskReconciliationItems = sqliteTable(
  'QingLong3PluginPackageTaskReconciliationItems',
  {
    generationDigest: text('generation_digest')
      .notNull()
      .references(() => pluginPackageTaskReconciliations.generationDigest, {
        onDelete: 'restrict',
      }),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    disposition: text('disposition').notNull(),
    contentDigest: text('content_digest').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.generationDigest, table.taskId] }),
    check(
      'ql3_plugin_package_task_reconciliation_item_identity_check',
      sql`length(${table.taskId}) between 1 and 128 and ${table.revision} between 1 and 2147483647`,
    ),
    check(
      'ql3_plugin_package_task_reconciliation_item_disposition_check',
      sql`${table.disposition} in ('already_disabled','created','disabled','retained','updated')`,
    ),
    check(
      'ql3_plugin_package_task_reconciliation_item_digest_check',
      sql`length(${table.contentDigest}) = 64 and ${table.contentDigest} not glob '*[^0-9a-f]*'`,
    ),
    index('ql3_plugin_package_task_reconciliation_item_task_idx').on(
      table.taskId,
      table.generationDigest,
    ),
  ],
);

export const triggers = sqliteTable(
  'QingLong3Triggers',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    triggerId: text('trigger_id').notNull(),
    taskId: text('task_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.triggerId] }),
    foreignKey({
      columns: [table.projectId, table.taskId],
      foreignColumns: [taskDefinitions.projectId, taskDefinitions.taskId],
      name: 'ql3_triggers_task_fk',
    }).onDelete('restrict'),
    check(
      'ql3_triggers_id_check',
      sql`length(${table.projectId}) between 1 and 128 and length(${table.triggerId}) between 1 and 128 and length(${table.taskId}) between 1 and 128 and ${table.projectId} not glob '*[' || char(0) || '-' || char(31) || char(127) || ']*' and ${table.triggerId} not glob '*[' || char(0) || '-' || char(31) || char(127) || ']*' and ${table.taskId} not glob '*[' || char(0) || '-' || char(31) || char(127) || ']*'`,
    ),
    check(
      'ql3_triggers_revision_check',
      sql`${table.currentRevision} between 1 and 2147483647`,
    ),
    check(
      'ql3_triggers_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    uniqueIndex('ql3_triggers_task_uidx').on(
      table.projectId,
      table.triggerId,
      table.taskId,
    ),
  ],
);

export const triggerRevisions = sqliteTable(
  'QingLong3TriggerRevisions',
  {
    projectId: text('project_id').notNull(),
    triggerId: text('trigger_id').notNull(),
    revision: integer('revision').notNull(),
    mutationId: text('mutation_id').notNull(),
    taskId: text('task_id').notNull(),
    taskRevision: integer('task_revision').notNull(),
    taskContentDigest: text('task_content_digest').notNull(),
    specJson: text('spec_json').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    contentDigest: text('content_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.triggerId, table.revision] }),
    foreignKey({
      columns: [table.projectId, table.triggerId, table.taskId],
      foreignColumns: [triggers.projectId, triggers.triggerId, triggers.taskId],
      name: 'ql3_trigger_revisions_trigger_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.projectId, table.taskId, table.taskRevision],
      foreignColumns: [
        taskDefinitionRevisions.projectId,
        taskDefinitionRevisions.taskId,
        taskDefinitionRevisions.revision,
      ],
      name: 'ql3_trigger_revisions_task_revision_fk',
    }).onDelete('restrict'),
    check(
      'ql3_trigger_revisions_revision_check',
      sql`${table.revision} between 1 and 2147483647 and ${table.taskRevision} between 1 and 2147483647`,
    ),
    check(
      'ql3_trigger_revisions_mutation_check',
      sql`length(${table.mutationId}) = 36 and substr(${table.mutationId}, 9, 1) = '-' and substr(${table.mutationId}, 14, 1) = '-' and substr(${table.mutationId}, 19, 1) = '-' and substr(${table.mutationId}, 24, 1) = '-' and replace(${table.mutationId}, '-', '') not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_trigger_revisions_task_digest_check',
      sql`length(${table.taskContentDigest}) = 64 and ${table.taskContentDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_trigger_revisions_spec_check',
      sql`json_valid(${table.specJson}) and json_type(${table.specJson}) = 'object' and length(${table.specJson}) between 1 and 16384`,
    ),
    check(
      'ql3_trigger_revisions_enabled_check',
      sql`${table.enabled} in (0, 1)`,
    ),
    check(
      'ql3_trigger_revisions_digest_check',
      sql`length(${table.contentDigest}) = 64 and ${table.contentDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_trigger_revisions_created_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    uniqueIndex('ql3_trigger_revisions_mutation_uidx').on(table.mutationId),
    index('ql3_trigger_revisions_project_enabled_idx').on(
      table.projectId,
      table.enabled,
      table.triggerId,
      table.revision,
    ),
    index('ql3_trigger_revisions_task_idx').on(
      table.projectId,
      table.taskId,
      table.taskRevision,
      table.triggerId,
      table.revision,
    ),
  ],
);

export const localTriggerSchedules = sqliteTable(
  'QingLong3LocalTriggerSchedules',
  {
    projectId: text('project_id').notNull(),
    triggerId: text('trigger_id').notNull(),
    triggerRevision: integer('trigger_revision').notNull(),
    nextFireAtMs: integer('next_fire_at_ms'),
    lastScheduledAtMs: integer('last_scheduled_at_ms'),
    stateVersion: integer('state_version').notNull().default(0),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.triggerId] }),
    foreignKey({
      columns: [table.projectId, table.triggerId],
      foreignColumns: [triggers.projectId, triggers.triggerId],
      name: 'ql3_local_trigger_schedules_trigger_fk',
    }).onDelete('restrict'),
    check(
      'ql3_local_trigger_schedules_revision_check',
      sql`${table.triggerRevision} between 1 and 2147483647`,
    ),
    check(
      'ql3_local_trigger_schedules_state_check',
      sql`${table.stateVersion} >= 0`,
    ),
    check(
      'ql3_local_trigger_schedules_time_check',
      sql`${table.updatedAtMs} >= 0 and (${table.nextFireAtMs} is null or ${table.nextFireAtMs} >= 0) and (${table.lastScheduledAtMs} is null or ${table.lastScheduledAtMs} >= 0)`,
    ),
    index('ql3_local_trigger_schedules_due_idx')
      .on(table.nextFireAtMs, table.projectId, table.triggerId)
      .where(sql`${table.nextFireAtMs} is not null`),
    index('ql3_local_trigger_schedules_initialize_idx')
      .on(table.projectId, table.triggerId)
      .where(sql`${table.nextFireAtMs} is null`),
  ],
);

export const localProjectRoleBindings = sqliteTable(
  'QingLong3ProjectRoleBindings',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    version: integer('version').notNull(),
    state: text('state').notNull(),
    role: text('role'),
    mutationId: text('mutation_id').notNull(),
    changedByType: text('changed_by_type').notNull(),
    changedById: text('changed_by_id').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.projectId,
        table.subjectType,
        table.subjectId,
        table.version,
      ],
    }),
    check(
      'ql3_local_bindings_subject_type_check',
      sql`${table.subjectType} in ('user','api_app','mcp_client','agent','system','worker')`,
    ),
    check(
      'ql3_local_bindings_subject_id_check',
      sql`length(${table.subjectId}) between 1 and 255`,
    ),
    check(
      'ql3_local_bindings_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_local_bindings_state_role_check',
      sql`(${table.state} = 'active' and ${table.role} in ('owner','admin','operator','viewer')) or (${table.state} = 'revoked' and ${table.role} is null)`,
    ),
    check(
      'ql3_local_bindings_mutation_check',
      sql`length(${table.mutationId}) between 1 and 64`,
    ),
    check(
      'ql3_local_bindings_changed_by_type_check',
      sql`${table.changedByType} in ('user','api_app','mcp_client','agent','system','worker')`,
    ),
    check(
      'ql3_local_bindings_changed_by_id_check',
      sql`length(${table.changedById}) between 1 and 255`,
    ),
    check('ql3_local_bindings_created_check', sql`${table.createdAtMs} >= 0`),
    uniqueIndex('ql3_local_bindings_mutation_uidx').on(
      table.projectId,
      table.subjectType,
      table.subjectId,
      table.mutationId,
    ),
    index('ql3_local_bindings_current_idx').on(
      table.projectId,
      table.subjectType,
      table.subjectId,
      sql`${table.version} desc`,
    ),
    index('ql3_local_bindings_project_idx').on(
      table.projectId,
      sql`${table.version} desc`,
    ),
  ],
);

export const localSecurityAuditEvents = sqliteTable(
  'QingLong3SecurityAuditEvents',
  {
    eventId: text('event_id').primaryKey(),
    requestId: text('request_id').notNull(),
    operationId: text('operation_id').notNull(),
    projectId: text('project_id').references(() => localProjects.id, {
      onDelete: 'restrict',
    }),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    authenticationId: text('authentication_id'),
    outcome: text('outcome').notNull(),
    reasonsJson: text('reasons_json', { mode: 'json' })
      .$type<readonly string[]>()
      .notNull(),
    fenceProjectVersion: integer('fence_project_version'),
    fenceBindingVersion: integer('fence_binding_version'),
    occurredAtMs: integer('occurred_at_ms').notNull(),
  },
  (table) => [
    check('ql3_local_audit_event_check', sql`length(${table.eventId}) = 36`),
    check(
      'ql3_local_audit_request_check',
      sql`length(${table.requestId}) between 1 and 128`,
    ),
    check(
      'ql3_local_audit_operation_check',
      sql`length(${table.operationId}) between 1 and 128`,
    ),
    check(
      'ql3_local_audit_subject_check',
      sql`(${table.subjectType} is null and ${table.subjectId} is null and ${table.authenticationId} is null) or (${table.subjectType} in ('user','api_app','mcp_client','agent','system','worker') and length(${table.subjectId}) between 1 and 255 and length(${table.authenticationId}) between 1 and 128)`,
    ),
    check(
      'ql3_local_audit_outcome_check',
      sql`${table.outcome} in ('authentication_rejected','authentication_unavailable','authorization_unavailable','denied','approval_required','allowed')`,
    ),
    check(
      'ql3_local_audit_reasons_check',
      sql`json_valid(${table.reasonsJson}) and json_type(${table.reasonsJson}) = 'array' and json_array_length(${table.reasonsJson}) between 1 and 8 and length(${table.reasonsJson}) <= 2048`,
    ),
    check(
      'ql3_local_audit_fence_check',
      sql`(${table.fenceProjectVersion} is null and ${table.fenceBindingVersion} is null) or (${table.fenceProjectVersion} between 1 and 2147483647 and (${table.fenceBindingVersion} is null or ${table.fenceBindingVersion} between 1 and 2147483647))`,
    ),
    check('ql3_local_audit_time_check', sql`${table.occurredAtMs} >= 0`),
    index('ql3_local_audit_project_time_idx').on(
      table.projectId,
      sql`${table.occurredAtMs} desc`,
      sql`${table.eventId} desc`,
    ),
    index('ql3_local_audit_subject_time_idx').on(
      table.subjectType,
      table.subjectId,
      sql`${table.occurredAtMs} desc`,
      sql`${table.eventId} desc`,
    ),
  ],
);

export const localProjectAdministrationMutations = sqliteTable(
  'QingLong3ProjectAdministrationMutations',
  {
    mutationId: text('mutation_id').primaryKey(),
    operation: text('operation').notNull(),
    authorityProjectId: text('authority_project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    projectName: text('project_name').notNull(),
    projectSlug: text('project_slug').notNull(),
    projectStatus: text('project_status').notNull(),
    projectVersion: integer('project_version').notNull(),
    expectedPreviousVersion: integer('expected_previous_version').notNull(),
    changedByType: text('changed_by_type').notNull(),
    changedById: text('changed_by_id').notNull(),
    initialOwnerBindingVersion: integer('initial_owner_binding_version'),
    auditEventId: text('audit_event_id')
      .notNull()
      .unique()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
      }),
    projectCreatedAtMs: integer('project_created_at_ms').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_project_admin_mutation_id_check',
      sql`length(${table.mutationId}) = 36 and substr(${table.mutationId}, 9, 1) = '-' and substr(${table.mutationId}, 14, 1) = '-' and substr(${table.mutationId}, 19, 1) = '-' and substr(${table.mutationId}, 24, 1) = '-' and replace(${table.mutationId}, '-', '') not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_project_admin_operation_check',
      sql`${table.operation} in ('create','archive','restore')`,
    ),
    check(
      'ql3_project_admin_identity_check',
      sql`length(${table.authorityProjectId}) between 1 and 128 and length(${table.projectId}) between 1 and 128 and length(${table.projectName}) between 1 and 255 and length(${table.projectSlug}) between 1 and 128 and ${table.projectSlug} = lower(${table.projectSlug}) and ${table.projectSlug} not glob '*[^a-z0-9-]*' and substr(${table.projectSlug}, 1, 1) not glob '[^a-z0-9]' and substr(${table.projectSlug}, -1, 1) not glob '[^a-z0-9]'`,
    ),
    check(
      'ql3_project_admin_transition_check',
      sql`${table.projectVersion} = ${table.expectedPreviousVersion} + 1 and ${table.projectVersion} between 1 and 2147483647 and ${table.expectedPreviousVersion} between 0 and 2147483646 and ((${table.operation} = 'create' and ${table.expectedPreviousVersion} = 0 and ${table.projectStatus} = 'active' and ${table.initialOwnerBindingVersion} = 1) or (${table.operation} = 'archive' and ${table.expectedPreviousVersion} > 0 and ${table.projectStatus} = 'archived' and ${table.initialOwnerBindingVersion} is null) or (${table.operation} = 'restore' and ${table.expectedPreviousVersion} > 0 and ${table.projectStatus} = 'active' and ${table.initialOwnerBindingVersion} is null))`,
    ),
    check(
      'ql3_project_admin_actor_check',
      sql`${table.changedByType} = 'user' and length(${table.changedById}) between 1 and 255`,
    ),
    check(
      'ql3_project_admin_audit_check',
      sql`${table.auditEventId} = ${table.mutationId}`,
    ),
    check(
      'ql3_project_admin_time_check',
      sql`${table.projectCreatedAtMs} >= 0 and ${table.createdAtMs} >= ${table.projectCreatedAtMs}`,
    ),
    uniqueIndex('ql3_project_admin_project_version_uidx').on(
      table.projectId,
      table.projectVersion,
    ),
    index('ql3_project_admin_authority_time_idx').on(
      table.authorityProjectId,
      sql`${table.createdAtMs} desc`,
      sql`${table.mutationId} desc`,
    ),
  ],
);

export const localSecurityAuditCompactions = sqliteTable(
  'QingLong3SecurityAuditCompactions',
  {
    mutationId: text('mutation_id').primaryKey(),
    requestId: text('request_id').notNull(),
    authorityProjectId: text('authority_project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    retentionMs: integer('retention_ms').notNull(),
    eligibleBeforeMs: integer('eligible_before_ms').notNull(),
    batchLimit: integer('batch_limit').notNull(),
    deletedCount: integer('deleted_count').notNull(),
    deletedPayloadBytes: integer('deleted_payload_bytes').notNull(),
    firstOccurredAtMs: integer('first_occurred_at_ms'),
    firstEventId: text('first_event_id'),
    lastOccurredAtMs: integer('last_occurred_at_ms'),
    lastEventId: text('last_event_id'),
    recordsDigest: text('records_digest').notNull(),
    auditEventId: text('audit_event_id')
      .notNull()
      .unique()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
      }),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_audit_compaction_mutation_check',
      sql`length(${table.mutationId}) = 36 and substr(${table.mutationId}, 9, 1) = '-' and substr(${table.mutationId}, 14, 1) = '-' and substr(${table.mutationId}, 19, 1) = '-' and substr(${table.mutationId}, 24, 1) = '-' and replace(${table.mutationId}, '-', '') not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_audit_compaction_request_check',
      sql`length(${table.requestId}) between 1 and 128`,
    ),
    check(
      'ql3_audit_compaction_authority_check',
      sql`length(${table.authorityProjectId}) between 1 and 128`,
    ),
    check(
      'ql3_audit_compaction_policy_check',
      sql`${table.retentionMs} between 2592000000 and 315360000000 and ${table.eligibleBeforeMs} >= 0 and ${table.eligibleBeforeMs} + ${table.retentionMs} <= ${table.createdAtMs} and ${table.batchLimit} between 1 and 512`,
    ),
    check(
      'ql3_audit_compaction_result_check',
      sql`${table.deletedCount} between 0 and ${table.batchLimit} and ${table.deletedPayloadBytes} between 0 and 16777216 and length(${table.recordsDigest}) = 64 and ${table.recordsDigest} not glob '*[^0-9a-f]*' and ((${table.deletedCount} = 0 and ${table.deletedPayloadBytes} = 0 and ${table.firstOccurredAtMs} is null and ${table.firstEventId} is null and ${table.lastOccurredAtMs} is null and ${table.lastEventId} is null) or (${table.deletedCount} > 0 and ${table.deletedPayloadBytes} > 0 and ${table.firstOccurredAtMs} >= 0 and ${table.lastOccurredAtMs} >= ${table.firstOccurredAtMs} and length(${table.firstEventId}) = 36 and length(${table.lastEventId}) = 36))`,
    ),
    check(
      'ql3_audit_compaction_audit_check',
      sql`${table.auditEventId} = ${table.mutationId}`,
    ),
    check(
      'ql3_audit_compaction_time_check',
      sql`${table.createdAtMs} >= 2592000000`,
    ),
    index('ql3_audit_compaction_authority_time_idx').on(
      table.authorityProjectId,
      sql`${table.createdAtMs} desc`,
      sql`${table.mutationId} desc`,
    ),
  ],
);

export const toolExecutionTraceAnchors = sqliteTable(
  'ToolExecutionTraceAnchors',
  {
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    projectId: text('project_id').notNull(),
    runId: text('run_id').notNull(),
    stepRunId: text('step_run_id').notNull(),
    invocationPlanDigest: text('invocation_plan_digest').notNull(),
    bindingDigest: text('binding_digest').notNull(),
    adapterDigest: text('adapter_digest').notNull(),
    redactionContractDigest: text('redaction_contract_digest').notNull(),
    auditContractDigest: text('audit_contract_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    traceDigest: text('trace_digest').notNull(),
    traceJson: text('trace_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.traceId, table.spanId],
      name: 'tool_execution_trace_anchors_pkey',
    }),
    foreignKey({
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
      name: 'ql3_tool_execution_trace_step_fk',
    }).onDelete('cascade'),
    check(
      'ql3_tool_execution_trace_identity_check',
      sql`length(${table.traceId}) = 32 and ${table.traceId} not glob '*[^0-9a-f]*' and length(${table.spanId}) = 16 and ${table.spanId} not glob '*[^0-9a-f]*' and (${table.parentSpanId} is null or (length(${table.parentSpanId}) = 16 and ${table.parentSpanId} not glob '*[^0-9a-f]*' and ${table.parentSpanId} <> ${table.spanId})) and length(${table.projectId}) between 1 and 128 and length(${table.runId}) between 1 and 128 and length(${table.stepRunId}) between 1 and 128`,
    ),
    check(
      'ql3_tool_execution_trace_digest_check',
      sql`length(${table.invocationPlanDigest}) = 64 and ${table.invocationPlanDigest} not glob '*[^0-9a-f]*' and length(${table.bindingDigest}) = 64 and ${table.bindingDigest} not glob '*[^0-9a-f]*' and length(${table.adapterDigest}) = 64 and ${table.adapterDigest} not glob '*[^0-9a-f]*' and length(${table.redactionContractDigest}) = 64 and ${table.redactionContractDigest} not glob '*[^0-9a-f]*' and length(${table.auditContractDigest}) = 64 and ${table.auditContractDigest} not glob '*[^0-9a-f]*' and length(${table.traceDigest}) = 64 and ${table.traceDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_tool_execution_trace_time_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_tool_execution_trace_json_check',
      sql`length(cast(${table.traceJson} as blob)) between 2 and 16384 and json_valid(${table.traceJson}) and json_type(${table.traceJson}) = 'object' and json_extract(${table.traceJson}, '$.schema') = 'qinglong/tool-execution-trace-anchor@v1' and json_extract(${table.traceJson}, '$.traceId') = ${table.traceId} and json_extract(${table.traceJson}, '$.spanId') = ${table.spanId} and json_extract(${table.traceJson}, '$.parentSpanId') is ${table.parentSpanId} and json_extract(${table.traceJson}, '$.projectId') = ${table.projectId} and json_extract(${table.traceJson}, '$.runId') = ${table.runId} and json_extract(${table.traceJson}, '$.stepRunId') = ${table.stepRunId} and json_extract(${table.traceJson}, '$.invocationPlanDigest') = ${table.invocationPlanDigest} and json_extract(${table.traceJson}, '$.bindingDigest') = ${table.bindingDigest} and json_extract(${table.traceJson}, '$.adapterDigest') = ${table.adapterDigest} and json_extract(${table.traceJson}, '$.redactionContractDigest') = ${table.redactionContractDigest} and json_extract(${table.traceJson}, '$.auditContractDigest') = ${table.auditContractDigest} and json_extract(${table.traceJson}, '$.createdAtMs') is ${table.createdAtMs} and json_extract(${table.traceJson}, '$.traceDigest') = ${table.traceDigest}`,
    ),
    index('ql3_tool_execution_trace_run_idx').on(
      table.runId,
      table.createdAtMs,
      table.traceId,
      table.spanId,
    ),
    index('ql3_tool_execution_trace_step_idx').on(
      table.runId,
      table.stepRunId,
      table.createdAtMs,
      table.traceId,
      table.spanId,
    ),
  ],
);

export const toolExecutionAuditReceipts = sqliteTable(
  'ToolExecutionAuditReceipts',
  {
    eventId: text('event_id')
      .primaryKey()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
      }),
    projectId: text('project_id').notNull(),
    runId: text('run_id').notNull(),
    stepRunId: text('step_run_id').notNull(),
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    traceDigest: text('trace_digest').notNull(),
    invocationPlanDigest: text('invocation_plan_digest').notNull(),
    bindingDigest: text('binding_digest').notNull(),
    auditRecordDigest: text('audit_record_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    receiptDigest: text('receipt_digest').notNull(),
    auditJson: text('audit_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    receiptJson: text('receipt_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.traceId, table.spanId],
      foreignColumns: [
        toolExecutionTraceAnchors.traceId,
        toolExecutionTraceAnchors.spanId,
      ],
      name: 'ql3_tool_execution_audit_trace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
      name: 'ql3_tool_execution_audit_step_fk',
    }).onDelete('cascade'),
    check(
      'ql3_tool_execution_audit_identity_check',
      sql`length(${table.eventId}) between 1 and 128 and length(${table.projectId}) between 1 and 128 and length(${table.runId}) between 1 and 128 and length(${table.stepRunId}) between 1 and 128 and length(${table.traceId}) = 32 and ${table.traceId} not glob '*[^0-9a-f]*' and length(${table.spanId}) = 16 and ${table.spanId} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_tool_execution_audit_digest_check',
      sql`length(${table.traceDigest}) = 64 and ${table.traceDigest} not glob '*[^0-9a-f]*' and length(${table.invocationPlanDigest}) = 64 and ${table.invocationPlanDigest} not glob '*[^0-9a-f]*' and length(${table.bindingDigest}) = 64 and ${table.bindingDigest} not glob '*[^0-9a-f]*' and length(${table.auditRecordDigest}) = 64 and ${table.auditRecordDigest} not glob '*[^0-9a-f]*' and length(${table.receiptDigest}) = 64 and ${table.receiptDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_tool_execution_audit_time_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_tool_execution_audit_json_check',
      sql`length(cast(${table.auditJson} as blob)) between 2 and 8192 and json_valid(${table.auditJson}) and json_type(${table.auditJson}) = 'object' and json_extract(${table.auditJson}, '$.eventId') = ${table.eventId} and json_extract(${table.auditJson}, '$.projectId') = ${table.projectId} and json_extract(${table.auditJson}, '$.operationId') = 'tool.invoke.start' and json_extract(${table.auditJson}, '$.outcome') = 'allowed' and json_type(${table.auditJson}, '$.fence') = 'object' and json_extract(${table.auditJson}, '$.occurredAtMs') is ${table.createdAtMs}`,
    ),
    check(
      'ql3_tool_execution_audit_receipt_json_check',
      sql`length(cast(${table.receiptJson} as blob)) between 2 and 16384 and json_valid(${table.receiptJson}) and json_type(${table.receiptJson}) = 'object' and json_extract(${table.receiptJson}, '$.schema') = 'qinglong/tool-execution-audit-receipt@v1' and json_extract(${table.receiptJson}, '$.eventId') = ${table.eventId} and json_extract(${table.receiptJson}, '$.projectId') = ${table.projectId} and json_extract(${table.receiptJson}, '$.runId') = ${table.runId} and json_extract(${table.receiptJson}, '$.stepRunId') = ${table.stepRunId} and json_extract(${table.receiptJson}, '$.traceId') = ${table.traceId} and json_extract(${table.receiptJson}, '$.spanId') = ${table.spanId} and json_extract(${table.receiptJson}, '$.traceDigest') = ${table.traceDigest} and json_extract(${table.receiptJson}, '$.invocationPlanDigest') = ${table.invocationPlanDigest} and json_extract(${table.receiptJson}, '$.bindingDigest') = ${table.bindingDigest} and json_extract(${table.receiptJson}, '$.auditRecordDigest') = ${table.auditRecordDigest} and json_extract(${table.receiptJson}, '$.createdAtMs') is ${table.createdAtMs} and json_extract(${table.receiptJson}, '$.receiptDigest') = ${table.receiptDigest}`,
    ),
    uniqueIndex('ql3_tool_execution_audit_trace_uidx').on(
      table.traceId,
      table.spanId,
    ),
    index('ql3_tool_execution_audit_run_idx').on(
      table.runId,
      table.createdAtMs,
      table.traceId,
      table.spanId,
    ),
    index('ql3_tool_execution_audit_step_idx').on(
      table.runId,
      table.stepRunId,
      table.createdAtMs,
      table.eventId,
    ),
  ],
);

export const toolExecutionStartBarriers = sqliteTable(
  'ToolExecutionStartBarriers',
  {
    startId: text('start_id').primaryKey(),
    projectId: text('project_id').notNull(),
    runId: text('run_id').notNull(),
    stepRunId: text('step_run_id').notNull(),
    startedStepRunVersion: integer('started_step_run_version').notNull(),
    stepRunMutationId: text('step_run_mutation_id')
      .notNull()
      .references(() => stepRunMutations.mutationId, {
        onDelete: 'restrict',
      }),
    runEventId: text('run_event_id')
      .notNull()
      .references(() => runEvents.id, { onDelete: 'restrict' }),
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    auditEventId: text('audit_event_id')
      .notNull()
      .references(() => toolExecutionAuditReceipts.eventId, {
        onDelete: 'restrict',
      }),
    commandDigest: text('command_digest').notNull(),
    barrierDigest: text('barrier_digest').notNull(),
    startedAtMs: integer('started_at_ms').notNull(),
    barrierJson: text('barrier_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
      name: 'ql3_tool_start_step_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.traceId, table.spanId],
      foreignColumns: [
        toolExecutionTraceAnchors.traceId,
        toolExecutionTraceAnchors.spanId,
      ],
      name: 'ql3_tool_start_trace_fk',
    }).onDelete('restrict'),
    check(
      'ql3_tool_start_identity_check',
      sql`length(${table.startId}) between 1 and 128 and length(${table.projectId}) between 1 and 128 and length(${table.runId}) between 1 and 128 and length(${table.stepRunId}) between 1 and 128 and length(${table.stepRunMutationId}) between 1 and 128 and length(${table.runEventId}) between 1 and 128 and length(${table.traceId}) = 32 and ${table.traceId} not glob '*[^0-9a-f]*' and length(${table.spanId}) = 16 and ${table.spanId} not glob '*[^0-9a-f]*' and length(${table.auditEventId}) between 1 and 128`,
    ),
    check(
      'ql3_tool_start_version_time_check',
      sql`${table.startedStepRunVersion} between 2 and 2147483647 and ${table.startedAtMs} >= 0`,
    ),
    check(
      'ql3_tool_start_digest_check',
      sql`length(${table.commandDigest}) = 64 and ${table.commandDigest} not glob '*[^0-9a-f]*' and length(${table.barrierDigest}) = 64 and ${table.barrierDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_tool_start_json_check',
      sql`length(cast(${table.barrierJson} as blob)) between 2 and 16384 and json_valid(${table.barrierJson}) and json_type(${table.barrierJson}) = 'object' and json_extract(${table.barrierJson}, '$.schema') = 'qinglong/tool-execution-start-barrier@v1' and json_extract(${table.barrierJson}, '$.startId') = ${table.startId} and json_extract(${table.barrierJson}, '$.projectId') = ${table.projectId} and json_extract(${table.barrierJson}, '$.runId') = ${table.runId} and json_extract(${table.barrierJson}, '$.stepRunId') = ${table.stepRunId} and json_extract(${table.barrierJson}, '$.startedStepRunVersion') is ${table.startedStepRunVersion} and json_extract(${table.barrierJson}, '$.stepRunMutationId') = ${table.stepRunMutationId} and json_extract(${table.barrierJson}, '$.runEventId') = ${table.runEventId} and json_extract(${table.barrierJson}, '$.traceId') = ${table.traceId} and json_extract(${table.barrierJson}, '$.spanId') = ${table.spanId} and json_extract(${table.barrierJson}, '$.auditEventId') = ${table.auditEventId} and json_extract(${table.barrierJson}, '$.commandDigest') = ${table.commandDigest} and json_extract(${table.barrierJson}, '$.barrierDigest') = ${table.barrierDigest} and json_extract(${table.barrierJson}, '$.startedAtMs') is ${table.startedAtMs}`,
    ),
    uniqueIndex('ql3_tool_start_step_version_uidx').on(
      table.runId,
      table.stepRunId,
      table.startedStepRunVersion,
    ),
    uniqueIndex('ql3_tool_start_mutation_uidx').on(table.stepRunMutationId),
    uniqueIndex('ql3_tool_start_event_uidx').on(table.runEventId),
    uniqueIndex('ql3_tool_start_trace_uidx').on(table.traceId, table.spanId),
    uniqueIndex('ql3_tool_start_audit_uidx').on(table.auditEventId),
    index('ql3_tool_start_run_time_idx').on(
      table.runId,
      table.startedAtMs,
      table.startId,
    ),
  ],
);

export const toolInvocationInputArtifacts = sqliteTable(
  'ToolInvocationInputArtifacts',
  {
    artifactId: text('artifact_id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    actionRef: text('action_ref').notNull(),
    inputDigest: text('input_digest').notNull(),
    invocationActionDigest: text('invocation_action_digest').notNull(),
    artifactDigest: text('artifact_digest').notNull(),
    keyId: text('key_id').notNull(),
    algorithm: text('algorithm').notNull(),
    plaintextBytes: integer('plaintext_bytes').notNull(),
    sealedAtMs: integer('sealed_at_ms').notNull(),
    artifactJson: text('artifact_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    check(
      'ql3_tool_input_artifact_identity_check',
      sql`length(${table.artifactId}) between 1 and 128 and length(${table.projectId}) between 1 and 128 and length(${table.actionRef}) between 1 and 255 and length(${table.keyId}) between 1 and 128 and ${table.algorithm} = 'aes-256-gcm'`,
    ),
    check(
      'ql3_tool_input_artifact_digest_check',
      sql`length(${table.inputDigest}) = 64 and ${table.inputDigest} not glob '*[^0-9a-f]*' and length(${table.invocationActionDigest}) = 64 and ${table.invocationActionDigest} not glob '*[^0-9a-f]*' and length(${table.artifactDigest}) = 64 and ${table.artifactDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_tool_input_artifact_budget_check',
      sql`${table.plaintextBytes} between 0 and 65536 and ${table.sealedAtMs} >= 0`,
    ),
    check(
      'ql3_tool_input_artifact_json_check',
      sql`length(cast(${table.artifactJson} as blob)) between 2 and 98304 and json_valid(${table.artifactJson}) and json_type(${table.artifactJson}) = 'object' and json_extract(${table.artifactJson}, '$.schema') = 'qinglong/tool-invocation-input-artifact@v1' and json_extract(${table.artifactJson}, '$.artifactId') = ${table.artifactId} and json_extract(${table.artifactJson}, '$.projectId') = ${table.projectId} and json_extract(${table.artifactJson}, '$.actionRef') = ${table.actionRef} and json_extract(${table.artifactJson}, '$.inputDigest') = ${table.inputDigest} and json_extract(${table.artifactJson}, '$.invocationActionDigest') = ${table.invocationActionDigest} and json_extract(${table.artifactJson}, '$.artifactDigest') = ${table.artifactDigest} and json_extract(${table.artifactJson}, '$.keyId') = ${table.keyId} and json_extract(${table.artifactJson}, '$.algorithm') = ${table.algorithm} and json_extract(${table.artifactJson}, '$.plaintextBytes') is ${table.plaintextBytes} and json_extract(${table.artifactJson}, '$.sealedAtMs') is ${table.sealedAtMs}`,
    ),
    uniqueIndex('ql3_tool_input_artifact_action_uidx').on(
      table.projectId,
      table.actionRef,
    ),
    uniqueIndex('ql3_tool_input_artifact_start_binding_uidx').on(
      table.artifactId,
      table.artifactDigest,
      table.projectId,
      table.actionRef,
      table.inputDigest,
    ),
    index('ql3_tool_input_artifact_project_time_idx').on(
      table.projectId,
      table.sealedAtMs,
      table.artifactId,
    ),
  ],
);

export const toolInvocationPreviewArtifacts = sqliteTable(
  'ToolInvocationPreviewArtifacts',
  {
    artifactId: text('artifact_id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    actionRef: text('action_ref').notNull(),
    actionDigest: text('action_digest').notNull(),
    previewDigest: text('preview_digest').notNull(),
    redactionContractDigest: text('redaction_contract_digest').notNull(),
    artifactDigest: text('artifact_digest').notNull(),
    byteLength: integer('byte_length').notNull(),
    sealedAtMs: integer('sealed_at_ms').notNull(),
    artifactJson: text('artifact_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    check(
      'ql3_tool_preview_artifact_identity_check',
      sql`length(${table.artifactId}) between 1 and 128 and length(${table.projectId}) between 1 and 128 and length(${table.actionRef}) between 1 and 255`,
    ),
    check(
      'ql3_tool_preview_artifact_digest_check',
      sql`length(${table.actionDigest}) = 64 and ${table.actionDigest} not glob '*[^0-9a-f]*' and length(${table.previewDigest}) = 64 and ${table.previewDigest} not glob '*[^0-9a-f]*' and length(${table.redactionContractDigest}) = 64 and ${table.redactionContractDigest} not glob '*[^0-9a-f]*' and length(${table.artifactDigest}) = 64 and ${table.artifactDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_tool_preview_artifact_budget_check',
      sql`${table.byteLength} between 2 and 8192 and ${table.sealedAtMs} >= 0`,
    ),
    check(
      'ql3_tool_preview_artifact_json_check',
      sql`length(cast(${table.artifactJson} as blob)) between 2 and 16384 and json_valid(${table.artifactJson}) and json_type(${table.artifactJson}) = 'object' and json_extract(${table.artifactJson}, '$.schema') = 'qinglong/tool-invocation-preview-artifact@v1' and json_extract(${table.artifactJson}, '$.artifactId') = ${table.artifactId} and json_extract(${table.artifactJson}, '$.projectId') = ${table.projectId} and json_extract(${table.artifactJson}, '$.actionRef') = ${table.actionRef} and json_extract(${table.artifactJson}, '$.actionDigest') = ${table.actionDigest} and json_extract(${table.artifactJson}, '$.previewDigest') = ${table.previewDigest} and json_extract(${table.artifactJson}, '$.redactionContractDigest') = ${table.redactionContractDigest} and json_extract(${table.artifactJson}, '$.artifactDigest') = ${table.artifactDigest} and json_extract(${table.artifactJson}, '$.byteLength') is ${table.byteLength} and json_extract(${table.artifactJson}, '$.sealedAtMs') is ${table.sealedAtMs}`,
    ),
    uniqueIndex('ql3_tool_preview_artifact_action_uidx').on(
      table.projectId,
      table.actionRef,
    ),
    uniqueIndex('ql3_tool_preview_artifact_action_digest_uidx').on(
      table.actionDigest,
    ),
    uniqueIndex('ql3_tool_preview_artifact_start_binding_uidx').on(
      table.artifactId,
      table.artifactDigest,
      table.projectId,
      table.actionRef,
      table.actionDigest,
      table.previewDigest,
      table.redactionContractDigest,
    ),
    index('ql3_tool_preview_artifact_project_time_idx').on(
      table.projectId,
      table.sealedAtMs,
      table.artifactId,
    ),
  ],
);

export const toolExecutionStartArtifactBindings = sqliteTable(
  'ToolExecutionStartArtifactBindings',
  {
    startId: text('start_id')
      .primaryKey()
      .references(() => toolExecutionStartBarriers.startId, {
        onDelete: 'restrict',
      }),
    projectId: text('project_id').notNull(),
    actionRef: text('action_ref').notNull(),
    inputArtifactId: text('input_artifact_id').notNull(),
    inputArtifactDigest: text('input_artifact_digest').notNull(),
    inputDigest: text('input_digest').notNull(),
    previewArtifactId: text('preview_artifact_id').notNull(),
    previewArtifactDigest: text('preview_artifact_digest').notNull(),
    actionDigest: text('action_digest').notNull(),
    previewDigest: text('preview_digest').notNull(),
    redactionContractDigest: text('redaction_contract_digest').notNull(),
    boundAtMs: integer('bound_at_ms').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.inputArtifactId,
        table.inputArtifactDigest,
        table.projectId,
        table.actionRef,
        table.inputDigest,
      ],
      foreignColumns: [
        toolInvocationInputArtifacts.artifactId,
        toolInvocationInputArtifacts.artifactDigest,
        toolInvocationInputArtifacts.projectId,
        toolInvocationInputArtifacts.actionRef,
        toolInvocationInputArtifacts.inputDigest,
      ],
      name: 'ql3_tool_start_input_artifact_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.previewArtifactId,
        table.previewArtifactDigest,
        table.projectId,
        table.actionRef,
        table.actionDigest,
        table.previewDigest,
        table.redactionContractDigest,
      ],
      foreignColumns: [
        toolInvocationPreviewArtifacts.artifactId,
        toolInvocationPreviewArtifacts.artifactDigest,
        toolInvocationPreviewArtifacts.projectId,
        toolInvocationPreviewArtifacts.actionRef,
        toolInvocationPreviewArtifacts.actionDigest,
        toolInvocationPreviewArtifacts.previewDigest,
        toolInvocationPreviewArtifacts.redactionContractDigest,
      ],
      name: 'ql3_tool_start_preview_artifact_fk',
    }).onDelete('restrict'),
    check(
      'ql3_tool_start_artifact_identity_check',
      sql`length(${table.startId}) between 1 and 128 and length(${table.projectId}) between 1 and 128 and length(${table.actionRef}) between 1 and 255 and length(${table.inputArtifactId}) between 1 and 128 and length(${table.previewArtifactId}) between 1 and 128`,
    ),
    check(
      'ql3_tool_start_artifact_digest_check',
      sql`length(${table.inputArtifactDigest}) = 64 and ${table.inputArtifactDigest} not glob '*[^0-9a-f]*' and length(${table.inputDigest}) = 64 and ${table.inputDigest} not glob '*[^0-9a-f]*' and length(${table.previewArtifactDigest}) = 64 and ${table.previewArtifactDigest} not glob '*[^0-9a-f]*' and length(${table.actionDigest}) = 64 and ${table.actionDigest} not glob '*[^0-9a-f]*' and length(${table.previewDigest}) = 64 and ${table.previewDigest} not glob '*[^0-9a-f]*' and length(${table.redactionContractDigest}) = 64 and ${table.redactionContractDigest} not glob '*[^0-9a-f]*'`,
    ),
    check('ql3_tool_start_artifact_time_check', sql`${table.boundAtMs} >= 0`),
    index('ql3_tool_start_artifact_input_idx').on(
      table.inputArtifactId,
      table.startId,
    ),
    index('ql3_tool_start_artifact_preview_idx').on(
      table.previewArtifactId,
      table.startId,
    ),
  ],
);

export const toolExecutionCompletions = sqliteTable(
  'ToolExecutionCompletions',
  {
    startId: text('start_id').primaryKey(),
    artifactId: text('artifact_id').notNull(),
    projectId: text('project_id').notNull(),
    runId: text('run_id').notNull(),
    stepRunId: text('step_run_id').notNull(),
    startedStepRunVersion: integer('started_step_run_version').notNull(),
    completedStepRunVersion: integer('completed_step_run_version').notNull(),
    barrierDigest: text('barrier_digest').notNull(),
    adapterDigest: text('adapter_digest').notNull(),
    outputDigest: text('output_digest').notNull(),
    executionResultDigest: text('execution_result_digest').notNull(),
    artifactDigest: text('artifact_digest').notNull(),
    keyId: text('key_id').notNull(),
    algorithm: text('algorithm').notNull(),
    plaintextBytes: integer('plaintext_bytes').notNull(),
    stepRunMutationId: text('step_run_mutation_id').notNull(),
    stepRunMutationDigest: text('step_run_mutation_digest').notNull(),
    completedStepRunDigest: text('completed_step_run_digest').notNull(),
    runEventId: text('run_event_id').notNull(),
    completedAtMs: integer('completed_at_ms').notNull(),
    completionDigest: text('completion_digest').notNull(),
    artifactJson: text('artifact_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    completionJson: text('completion_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.startId],
      foreignColumns: [toolExecutionStartBarriers.startId],
      name: 'ql3_tool_completion_start_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
      name: 'ql3_tool_completion_step_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.stepRunMutationId],
      foreignColumns: [stepRunMutations.mutationId],
      name: 'ql3_tool_completion_mutation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.runEventId],
      foreignColumns: [runEvents.id],
      name: 'ql3_tool_completion_event_fk',
    }).onDelete('restrict'),
    check(
      'ql3_tool_completion_identity_check',
      sql`length(${table.startId}) between 1 and 128 and length(${table.artifactId}) between 1 and 128 and length(${table.projectId}) between 1 and 128 and length(${table.runId}) between 1 and 128 and length(${table.stepRunId}) between 1 and 128 and length(${table.keyId}) between 1 and 128 and length(${table.stepRunMutationId}) between 1 and 128 and length(${table.runEventId}) between 1 and 128`,
    ),
    check(
      'ql3_tool_completion_version_check',
      sql`${table.startedStepRunVersion} between 2 and 2147483646 and ${table.completedStepRunVersion} = ${table.startedStepRunVersion} + 1`,
    ),
    check(
      'ql3_tool_completion_digest_check',
      sql`length(${table.barrierDigest}) = 64 and ${table.barrierDigest} not glob '*[^0-9a-f]*' and length(${table.adapterDigest}) = 64 and ${table.adapterDigest} not glob '*[^0-9a-f]*' and length(${table.outputDigest}) = 64 and ${table.outputDigest} not glob '*[^0-9a-f]*' and length(${table.executionResultDigest}) = 64 and ${table.executionResultDigest} not glob '*[^0-9a-f]*' and length(${table.artifactDigest}) = 64 and ${table.artifactDigest} not glob '*[^0-9a-f]*' and length(${table.stepRunMutationDigest}) = 64 and ${table.stepRunMutationDigest} not glob '*[^0-9a-f]*' and length(${table.completedStepRunDigest}) = 64 and ${table.completedStepRunDigest} not glob '*[^0-9a-f]*' and length(${table.completionDigest}) = 64 and ${table.completionDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_tool_completion_budget_check',
      sql`${table.algorithm} = 'aes-256-gcm' and ${table.plaintextBytes} between 0 and 262144 and ${table.completedAtMs} >= 0 and length(cast(${table.artifactJson} as blob)) between 2 and 393216 and length(cast(${table.completionJson} as blob)) between 2 and 24576`,
    ),
    check(
      'ql3_tool_completion_json_check',
      sql`json_valid(${table.artifactJson}) and json_type(${table.artifactJson}) = 'object' and json_extract(${table.artifactJson}, '$.schema') = 'qinglong/tool-execution-result-artifact@v1' and json_extract(${table.artifactJson}, '$.artifactId') = ${table.artifactId} and json_extract(${table.artifactJson}, '$.projectId') = ${table.projectId} and json_extract(${table.artifactJson}, '$.startId') = ${table.startId} and json_extract(${table.artifactJson}, '$.runId') = ${table.runId} and json_extract(${table.artifactJson}, '$.stepRunId') = ${table.stepRunId} and json_extract(${table.artifactJson}, '$.barrierDigest') = ${table.barrierDigest} and json_extract(${table.artifactJson}, '$.adapterDigest') = ${table.adapterDigest} and json_extract(${table.artifactJson}, '$.outputDigest') = ${table.outputDigest} and json_extract(${table.artifactJson}, '$.executionResultDigest') = ${table.executionResultDigest} and json_extract(${table.artifactJson}, '$.artifactDigest') = ${table.artifactDigest} and json_extract(${table.artifactJson}, '$.keyId') = ${table.keyId} and json_extract(${table.artifactJson}, '$.algorithm') = ${table.algorithm} and json_extract(${table.artifactJson}, '$.plaintextBytes') = ${table.plaintextBytes} and json_extract(${table.artifactJson}, '$.sealedAtMs') = ${table.completedAtMs} and json_valid(${table.completionJson}) and json_type(${table.completionJson}) = 'object' and json_extract(${table.completionJson}, '$.schema') = 'qinglong/tool-execution-completion@v1' and json_extract(${table.completionJson}, '$.startId') = ${table.startId} and json_extract(${table.completionJson}, '$.projectId') = ${table.projectId} and json_extract(${table.completionJson}, '$.runId') = ${table.runId} and json_extract(${table.completionJson}, '$.stepRunId') = ${table.stepRunId} and json_extract(${table.completionJson}, '$.startedStepRunVersion') = ${table.startedStepRunVersion} and json_extract(${table.completionJson}, '$.completedStepRunVersion') = ${table.completedStepRunVersion} and json_extract(${table.completionJson}, '$.barrierDigest') = ${table.barrierDigest} and json_extract(${table.completionJson}, '$.adapterDigest') = ${table.adapterDigest} and json_extract(${table.completionJson}, '$.resultArtifact.artifactId') = ${table.artifactId} and json_extract(${table.completionJson}, '$.resultArtifact.artifactDigest') = ${table.artifactDigest} and json_extract(${table.completionJson}, '$.resultArtifact.outputDigest') = ${table.outputDigest} and json_extract(${table.completionJson}, '$.resultArtifact.executionResultDigest') = ${table.executionResultDigest} and json_extract(${table.completionJson}, '$.stepRunMutationId') = ${table.stepRunMutationId} and json_extract(${table.completionJson}, '$.stepRunMutationDigest') = ${table.stepRunMutationDigest} and json_extract(${table.completionJson}, '$.completedStepRunDigest') = ${table.completedStepRunDigest} and json_extract(${table.completionJson}, '$.runEventId') = ${table.runEventId} and json_extract(${table.completionJson}, '$.completedAtMs') = ${table.completedAtMs} and json_extract(${table.completionJson}, '$.completionDigest') = ${table.completionDigest}`,
    ),
    uniqueIndex('ql3_tool_completion_artifact_uidx').on(table.artifactId),
    uniqueIndex('ql3_tool_completion_mutation_uidx').on(
      table.stepRunMutationId,
    ),
    uniqueIndex('ql3_tool_completion_event_uidx').on(table.runEventId),
    uniqueIndex('ql3_tool_completion_step_version_uidx').on(
      table.runId,
      table.stepRunId,
      table.completedStepRunVersion,
    ),
    index('ql3_tool_completion_project_time_idx').on(
      table.projectId,
      table.completedAtMs,
      table.startId,
    ),
  ],
);

export const toolExecutionFailureCompletions = sqliteTable(
  'ToolExecutionFailureCompletions',
  {
    startId: text('start_id').primaryKey(),
    projectId: text('project_id').notNull(),
    runId: text('run_id').notNull(),
    stepRunId: text('step_run_id').notNull(),
    startedStepRunVersion: integer('started_step_run_version').notNull(),
    completedStepRunVersion: integer('completed_step_run_version').notNull(),
    barrierDigest: text('barrier_digest').notNull(),
    adapterDigest: text('adapter_digest').notNull(),
    outcome: text('outcome').notNull(),
    resultCode: text('result_code').notNull(),
    errorSummary: text('error_summary').notNull(),
    stepRunMutationId: text('step_run_mutation_id').notNull(),
    stepRunMutationDigest: text('step_run_mutation_digest').notNull(),
    completedStepRunDigest: text('completed_step_run_digest').notNull(),
    runEventId: text('run_event_id').notNull(),
    completedAtMs: integer('completed_at_ms').notNull(),
    completionDigest: text('completion_digest').notNull(),
    completionJson: text('completion_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.startId],
      foreignColumns: [toolExecutionStartBarriers.startId],
      name: 'ql3_tool_failure_completion_start_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
      name: 'ql3_tool_failure_completion_step_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.stepRunMutationId],
      foreignColumns: [stepRunMutations.mutationId],
      name: 'ql3_tool_failure_completion_mutation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.runEventId],
      foreignColumns: [runEvents.id],
      name: 'ql3_tool_failure_completion_event_fk',
    }).onDelete('restrict'),
    check(
      'ql3_tool_failure_completion_identity_check',
      sql`length(${table.startId}) between 1 and 128 and length(${table.projectId}) between 1 and 128 and length(${table.runId}) between 1 and 128 and length(${table.stepRunId}) between 1 and 128 and length(${table.stepRunMutationId}) between 1 and 128 and length(${table.runEventId}) between 1 and 128`,
    ),
    check(
      'ql3_tool_failure_completion_version_check',
      sql`${table.startedStepRunVersion} between 2 and 2147483646 and ${table.completedStepRunVersion} = ${table.startedStepRunVersion} + 1`,
    ),
    check(
      'ql3_tool_failure_completion_digest_check',
      sql`length(${table.barrierDigest}) = 64 and ${table.barrierDigest} not glob '*[^0-9a-f]*' and length(${table.adapterDigest}) = 64 and ${table.adapterDigest} not glob '*[^0-9a-f]*' and length(${table.stepRunMutationDigest}) = 64 and ${table.stepRunMutationDigest} not glob '*[^0-9a-f]*' and length(${table.completedStepRunDigest}) = 64 and ${table.completedStepRunDigest} not glob '*[^0-9a-f]*' and length(${table.completionDigest}) = 64 and ${table.completionDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_tool_failure_completion_fact_check',
      sql`(${table.outcome} = 'failed' and ${table.resultCode} = 'tool_adapter_failed' and ${table.errorSummary} = 'Trusted Tool execution failed') or (${table.outcome} = 'timed_out' and ${table.resultCode} = 'tool_deadline_exceeded' and ${table.errorSummary} = 'Trusted Tool execution deadline exceeded')`,
    ),
    check(
      'ql3_tool_failure_completion_budget_check',
      sql`${table.completedAtMs} >= 0 and length(cast(${table.completionJson} as blob)) between 2 and 24576`,
    ),
    check(
      'ql3_tool_failure_completion_json_check',
      sql`json_valid(${table.completionJson}) and json_type(${table.completionJson}) = 'object' and json_extract(${table.completionJson}, '$.schema') = 'qinglong/tool-execution-failure-completion@v1' and json_extract(${table.completionJson}, '$.startId') = ${table.startId} and json_extract(${table.completionJson}, '$.projectId') = ${table.projectId} and json_extract(${table.completionJson}, '$.runId') = ${table.runId} and json_extract(${table.completionJson}, '$.stepRunId') = ${table.stepRunId} and json_extract(${table.completionJson}, '$.startedStepRunVersion') = ${table.startedStepRunVersion} and json_extract(${table.completionJson}, '$.completedStepRunVersion') = ${table.completedStepRunVersion} and json_extract(${table.completionJson}, '$.barrierDigest') = ${table.barrierDigest} and json_extract(${table.completionJson}, '$.adapterDigest') = ${table.adapterDigest} and json_extract(${table.completionJson}, '$.outcome') = ${table.outcome} and json_extract(${table.completionJson}, '$.resultCode') = ${table.resultCode} and json_extract(${table.completionJson}, '$.errorSummary') = ${table.errorSummary} and json_extract(${table.completionJson}, '$.stepRunMutationId') = ${table.stepRunMutationId} and json_extract(${table.completionJson}, '$.stepRunMutationDigest') = ${table.stepRunMutationDigest} and json_extract(${table.completionJson}, '$.completedStepRunDigest') = ${table.completedStepRunDigest} and json_extract(${table.completionJson}, '$.runEventId') = ${table.runEventId} and json_extract(${table.completionJson}, '$.completedAtMs') = ${table.completedAtMs} and json_extract(${table.completionJson}, '$.completionDigest') = ${table.completionDigest}`,
    ),
    uniqueIndex('ql3_tool_failure_completion_mutation_uidx').on(
      table.stepRunMutationId,
    ),
    uniqueIndex('ql3_tool_failure_completion_event_uidx').on(table.runEventId),
    uniqueIndex('ql3_tool_failure_completion_step_version_uidx').on(
      table.runId,
      table.stepRunId,
      table.completedStepRunVersion,
    ),
    index('ql3_tool_failure_completion_project_time_idx').on(
      table.projectId,
      table.completedAtMs,
      table.startId,
    ),
  ],
);

export const toolResultKeyCatalogGenerations = sqliteTable(
  'ToolResultKeyCatalogGenerations',
  {
    authority: text('authority').notNull(),
    generation: integer('generation').notNull(),
    previousGeneration: integer('previous_generation'),
    previousCatalogDigest: text('previous_catalog_digest'),
    activeKeyId: text('active_key_id'),
    mutationKind: text('mutation_kind').notNull(),
    mutationId: text('mutation_id').notNull(),
    catalogDigest: text('catalog_digest').notNull(),
    commandDigest: text('command_digest').notNull(),
    committedAtMs: integer('committed_at_ms').notNull(),
    catalogJson: text('catalog_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.authority, table.generation] }),
    foreignKey({
      columns: [
        table.authority,
        table.previousGeneration,
        table.previousCatalogDigest,
      ],
      foreignColumns: [table.authority, table.generation, table.catalogDigest],
      name: 'ql3_tool_result_key_catalog_previous_fk',
    }).onDelete('restrict'),
    check(
      'ql3_tool_result_key_catalog_authority_check',
      sql`${table.authority} = 'trusted-tool-results'`,
    ),
    check(
      'ql3_tool_result_key_catalog_generation_check',
      sql`${table.generation} between 1 and 2147483647 and ((${table.generation} = 1 and ${table.previousGeneration} is null and ${table.previousCatalogDigest} is null and ${table.mutationKind} = 'bootstrap') or (${table.generation} > 1 and ${table.previousGeneration} = ${table.generation} - 1 and ${table.previousCatalogDigest} is not null and ${table.mutationKind} in ('rotate', 'retire', 'mark_lost', 'restore')))`,
    ),
    check(
      'ql3_tool_result_key_catalog_identity_check',
      sql`${table.activeKeyId} is null or length(${table.activeKeyId}) between 1 and 128 and ${table.activeKeyId} not glob '*[^A-Za-z0-9._-]*' and substr(${table.activeKeyId}, 1, 1) glob '[A-Za-z0-9]'`,
    ),
    check(
      'ql3_tool_result_key_catalog_digest_check',
      sql`(${table.previousCatalogDigest} is null or length(${table.previousCatalogDigest}) = 64 and ${table.previousCatalogDigest} not glob '*[^0-9a-f]*') and length(${table.catalogDigest}) = 64 and ${table.catalogDigest} not glob '*[^0-9a-f]*' and length(${table.commandDigest}) = 64 and ${table.commandDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_tool_result_key_catalog_budget_check',
      sql`${table.committedAtMs} >= 0 and length(${table.mutationId}) between 1 and 128 and length(cast(${table.catalogJson} as blob)) between 2 and 65536`,
    ),
    check(
      'ql3_tool_result_key_catalog_json_check',
      sql`json_valid(${table.catalogJson}) and json_type(${table.catalogJson}) = 'object' and json_extract(${table.catalogJson}, '$.schema') = 'qinglong/tool-result-key-catalog@v1' and json_extract(${table.catalogJson}, '$.generation') = ${table.generation} and ((${table.previousCatalogDigest} is null and json_type(${table.catalogJson}, '$.previousCatalogDigest') = 'null') or json_extract(${table.catalogJson}, '$.previousCatalogDigest') = ${table.previousCatalogDigest}) and ((${table.activeKeyId} is null and json_type(${table.catalogJson}, '$.activeKeyId') = 'null') or json_extract(${table.catalogJson}, '$.activeKeyId') = ${table.activeKeyId}) and json_extract(${table.catalogJson}, '$.mutationKind') = ${table.mutationKind} and json_extract(${table.catalogJson}, '$.mutationId') = ${table.mutationId} and json_extract(${table.catalogJson}, '$.catalogDigest') = ${table.catalogDigest} and json_extract(${table.catalogJson}, '$.committedAtMs') = ${table.committedAtMs} and json_type(${table.catalogJson}, '$.keys') = 'array' and json_array_length(json_extract(${table.catalogJson}, '$.keys')) between 1 and 64`,
    ),
    index('ql3_tool_result_key_catalog_current_idx').on(
      table.authority,
      sql`${table.generation} desc`,
    ),
  ],
);

export const toolExecutionResultKeyBindings = sqliteTable(
  'ToolExecutionResultKeyBindings',
  {
    startId: text('start_id').primaryKey(),
    artifactId: text('artifact_id').notNull(),
    artifactDigest: text('artifact_digest').notNull(),
    catalogAuthority: text('catalog_authority').notNull(),
    catalogGeneration: integer('catalog_generation').notNull(),
    catalogDigest: text('catalog_digest').notNull(),
    keyId: text('key_id').notNull(),
    materialProof: text('material_proof').notNull(),
    bindingDigest: text('binding_digest').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.startId],
      foreignColumns: [toolExecutionCompletions.startId],
      name: 'ql3_tool_result_key_binding_completion_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.artifactId],
      foreignColumns: [toolExecutionCompletions.artifactId],
      name: 'ql3_tool_result_key_binding_artifact_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.catalogAuthority,
        table.catalogGeneration,
        table.catalogDigest,
      ],
      foreignColumns: [
        toolResultKeyCatalogGenerations.authority,
        toolResultKeyCatalogGenerations.generation,
        toolResultKeyCatalogGenerations.catalogDigest,
      ],
      name: 'ql3_tool_result_key_binding_catalog_fk',
    }).onDelete('restrict'),
    check(
      'ql3_tool_result_key_binding_authority_check',
      sql`${table.catalogAuthority} = 'trusted-tool-results'`,
    ),
    check(
      'ql3_tool_result_key_binding_identity_check',
      sql`length(${table.startId}) between 1 and 128 and length(${table.artifactId}) between 1 and 128 and length(${table.keyId}) between 1 and 128 and ${table.keyId} not glob '*[^A-Za-z0-9._-]*' and substr(${table.keyId}, 1, 1) glob '[A-Za-z0-9]' and ${table.catalogGeneration} between 1 and 2147483647`,
    ),
    check(
      'ql3_tool_result_key_binding_digest_check',
      sql`length(${table.artifactDigest}) = 64 and ${table.artifactDigest} not glob '*[^0-9a-f]*' and length(${table.catalogDigest}) = 64 and ${table.catalogDigest} not glob '*[^0-9a-f]*' and length(${table.materialProof}) = 64 and ${table.materialProof} not glob '*[^0-9a-f]*' and length(${table.bindingDigest}) = 64 and ${table.bindingDigest} not glob '*[^0-9a-f]*'`,
    ),
    index('ql3_tool_result_key_binding_catalog_idx').on(
      table.catalogGeneration,
      table.keyId,
      table.startId,
    ),
  ],
);

export const toolExecutionResultRekeyOverlays = sqliteTable(
  'ToolExecutionResultRekeyOverlays',
  {
    overlayId: text('overlay_id').primaryKey(),
    artifactId: text('artifact_id').notNull(),
    sourceBindingDigest: text('source_binding_digest').notNull(),
    revision: integer('revision').notNull(),
    previousOverlayDigest: text('previous_overlay_digest'),
    fromKeyId: text('from_key_id').notNull(),
    targetCatalogAuthority: text('target_catalog_authority').notNull(),
    targetCatalogGeneration: integer('target_catalog_generation').notNull(),
    targetCatalogDigest: text('target_catalog_digest').notNull(),
    targetKeyId: text('target_key_id').notNull(),
    targetMaterialProof: text('target_material_proof').notNull(),
    mutationId: text('mutation_id').notNull().unique(),
    commandDigest: text('command_digest').notNull(),
    overlayDigest: text('overlay_digest').notNull().unique(),
    rekeyedAtMs: integer('rekeyed_at_ms').notNull(),
    overlayJson: text('overlay_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.artifactId],
      foreignColumns: [toolExecutionResultKeyBindings.artifactId],
      name: 'ql3_tool_result_rekey_artifact_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.sourceBindingDigest],
      foreignColumns: [toolExecutionResultKeyBindings.bindingDigest],
      name: 'ql3_tool_result_rekey_binding_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.previousOverlayDigest],
      foreignColumns: [table.overlayDigest],
      name: 'ql3_tool_result_rekey_previous_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.targetCatalogAuthority,
        table.targetCatalogGeneration,
        table.targetCatalogDigest,
      ],
      foreignColumns: [
        toolResultKeyCatalogGenerations.authority,
        toolResultKeyCatalogGenerations.generation,
        toolResultKeyCatalogGenerations.catalogDigest,
      ],
      name: 'ql3_tool_result_rekey_catalog_fk',
    }).onDelete('restrict'),
    check(
      'ql3_tool_result_rekey_revision_check',
      sql`${table.revision} between 1 and 2147483647 and ((${table.revision} = 1 and ${table.previousOverlayDigest} is null) or (${table.revision} > 1 and ${table.previousOverlayDigest} is not null))`,
    ),
    check(
      'ql3_tool_result_rekey_authority_check',
      sql`${table.targetCatalogAuthority} = 'trusted-tool-results'`,
    ),
    check(
      'ql3_tool_result_rekey_identity_check',
      sql`length(${table.overlayId}) between 1 and 128 and length(${table.artifactId}) between 1 and 128 and length(${table.mutationId}) between 1 and 128 and length(${table.fromKeyId}) between 1 and 128 and ${table.fromKeyId} not glob '*[^A-Za-z0-9._-]*' and substr(${table.fromKeyId}, 1, 1) glob '[A-Za-z0-9]' and length(${table.targetKeyId}) between 1 and 128 and ${table.targetKeyId} not glob '*[^A-Za-z0-9._-]*' and substr(${table.targetKeyId}, 1, 1) glob '[A-Za-z0-9]' and ${table.fromKeyId} <> ${table.targetKeyId} and ${table.targetCatalogGeneration} between 1 and 2147483647`,
    ),
    check(
      'ql3_tool_result_rekey_digest_check',
      sql`(${table.previousOverlayDigest} is null or length(${table.previousOverlayDigest}) = 64 and ${table.previousOverlayDigest} not glob '*[^0-9a-f]*') and length(${table.sourceBindingDigest}) = 64 and ${table.sourceBindingDigest} not glob '*[^0-9a-f]*' and length(${table.targetCatalogDigest}) = 64 and ${table.targetCatalogDigest} not glob '*[^0-9a-f]*' and length(${table.targetMaterialProof}) = 64 and ${table.targetMaterialProof} not glob '*[^0-9a-f]*' and length(${table.commandDigest}) = 64 and ${table.commandDigest} not glob '*[^0-9a-f]*' and length(${table.overlayDigest}) = 64 and ${table.overlayDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_tool_result_rekey_budget_check',
      sql`${table.rekeyedAtMs} >= 0 and length(cast(${table.overlayJson} as blob)) between 2 and 393216`,
    ),
    check(
      'ql3_tool_result_rekey_json_check',
      sql`json_valid(${table.overlayJson}) and json_type(${table.overlayJson}) = 'object' and json_extract(${table.overlayJson}, '$.schema') = 'qinglong/tool-execution-result-rekey-overlay@v1' and json_extract(${table.overlayJson}, '$.overlayId') = ${table.overlayId} and json_extract(${table.overlayJson}, '$.sourceArtifact.artifactId') = ${table.artifactId} and json_extract(${table.overlayJson}, '$.sourceBindingDigest') = ${table.sourceBindingDigest} and json_extract(${table.overlayJson}, '$.revision') = ${table.revision} and ((${table.previousOverlayDigest} is null and json_type(${table.overlayJson}, '$.previousOverlayDigest') = 'null') or json_extract(${table.overlayJson}, '$.previousOverlayDigest') = ${table.previousOverlayDigest}) and json_extract(${table.overlayJson}, '$.fromKeyId') = ${table.fromKeyId} and json_extract(${table.overlayJson}, '$.targetCatalogFence.generation') = ${table.targetCatalogGeneration} and json_extract(${table.overlayJson}, '$.targetCatalogFence.catalogDigest') = ${table.targetCatalogDigest} and json_extract(${table.overlayJson}, '$.targetCatalogFence.keyId') = ${table.targetKeyId} and json_extract(${table.overlayJson}, '$.targetCatalogFence.materialProof') = ${table.targetMaterialProof} and json_extract(${table.overlayJson}, '$.rekeyedAtMs') = ${table.rekeyedAtMs} and json_extract(${table.overlayJson}, '$.overlayDigest') = ${table.overlayDigest}`,
    ),
    index('ql3_tool_result_rekey_artifact_idx').on(
      table.artifactId,
      sql`${table.revision} desc`,
    ),
    index('ql3_tool_result_rekey_target_idx').on(
      table.targetKeyId,
      table.artifactId,
      sql`${table.revision} desc`,
    ),
  ],
);

export const toolExecutionResultRekeyHeads = sqliteTable(
  'ToolExecutionResultRekeyHeads',
  {
    artifactId: text('artifact_id').primaryKey(),
    revision: integer('revision').notNull(),
    overlayId: text('overlay_id').notNull().unique(),
    overlayDigest: text('overlay_digest').notNull().unique(),
    targetCatalogGeneration: integer('target_catalog_generation').notNull(),
    targetCatalogDigest: text('target_catalog_digest').notNull(),
    targetKeyId: text('target_key_id').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.artifactId, table.revision, table.overlayDigest],
      foreignColumns: [
        toolExecutionResultRekeyOverlays.artifactId,
        toolExecutionResultRekeyOverlays.revision,
        toolExecutionResultRekeyOverlays.overlayDigest,
      ],
      name: 'ql3_tool_result_rekey_head_overlay_fk',
    }).onDelete('restrict'),
    check(
      'ql3_tool_result_rekey_head_identity_check',
      sql`${table.revision} between 1 and 2147483647 and length(${table.artifactId}) between 1 and 128 and length(${table.overlayId}) between 1 and 128 and length(${table.targetKeyId}) between 1 and 128 and ${table.targetKeyId} not glob '*[^A-Za-z0-9._-]*' and substr(${table.targetKeyId}, 1, 1) glob '[A-Za-z0-9]' and ${table.targetCatalogGeneration} between 1 and 2147483647 and ${table.updatedAtMs} >= 0`,
    ),
    check(
      'ql3_tool_result_rekey_head_digest_check',
      sql`length(${table.overlayDigest}) = 64 and ${table.overlayDigest} not glob '*[^0-9a-f]*' and length(${table.targetCatalogDigest}) = 64 and ${table.targetCatalogDigest} not glob '*[^0-9a-f]*'`,
    ),
    index('ql3_tool_result_rekey_head_target_idx').on(
      table.targetKeyId,
      table.artifactId,
    ),
  ],
);

export const toolResultKeyRetirementReceipts = sqliteTable(
  'ToolResultKeyRetirementReceipts',
  {
    receiptDigest: text('receipt_digest').primaryKey(),
    catalogAuthority: text('catalog_authority').notNull(),
    catalogGeneration: integer('catalog_generation').notNull(),
    catalogDigest: text('catalog_digest').notNull(),
    keyId: text('key_id').notNull(),
    materialProof: text('material_proof').notNull(),
    mutationId: text('mutation_id').notNull().unique(),
    commandDigest: text('command_digest').notNull(),
    bindingCount: integer('binding_count').notNull(),
    overlayHeadCount: integer('overlay_head_count').notNull(),
    uncoveredBindingCount: integer('uncovered_binding_count').notNull(),
    uncoveredOverlayHeadCount: integer(
      'uncovered_overlay_head_count',
    ).notNull(),
    coverageDigest: text('coverage_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    receiptJson: text('receipt_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.catalogAuthority,
        table.catalogGeneration,
        table.catalogDigest,
      ],
      foreignColumns: [
        toolResultKeyCatalogGenerations.authority,
        toolResultKeyCatalogGenerations.generation,
        toolResultKeyCatalogGenerations.catalogDigest,
      ],
      name: 'ql3_tool_result_key_retirement_catalog_fk',
    }).onDelete('restrict'),
    check(
      'ql3_tool_result_key_retirement_authority_check',
      sql`${table.catalogAuthority} = 'trusted-tool-results'`,
    ),
    check(
      'ql3_tool_result_key_retirement_identity_check',
      sql`${table.catalogGeneration} between 1 and 2147483647 and length(${table.keyId}) between 1 and 128 and ${table.keyId} not glob '*[^A-Za-z0-9._-]*' and substr(${table.keyId}, 1, 1) glob '[A-Za-z0-9]' and length(${table.mutationId}) between 1 and 128`,
    ),
    check(
      'ql3_tool_result_key_retirement_count_check',
      sql`${table.bindingCount} between 0 and 2147483647 and ${table.overlayHeadCount} between 0 and 2147483647 and ${table.uncoveredBindingCount} = 0 and ${table.uncoveredOverlayHeadCount} = 0 and ${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_tool_result_key_retirement_digest_check',
      sql`length(${table.receiptDigest}) = 64 and ${table.receiptDigest} not glob '*[^0-9a-f]*' and length(${table.catalogDigest}) = 64 and ${table.catalogDigest} not glob '*[^0-9a-f]*' and length(${table.materialProof}) = 64 and ${table.materialProof} not glob '*[^0-9a-f]*' and length(${table.commandDigest}) = 64 and ${table.commandDigest} not glob '*[^0-9a-f]*' and length(${table.coverageDigest}) = 64 and ${table.coverageDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_tool_result_key_retirement_json_check',
      sql`json_valid(${table.receiptJson}) and json_type(${table.receiptJson}) = 'object' and json_extract(${table.receiptJson}, '$.schema') = 'qinglong/tool-result-key-retirement-receipt@v1' and json_extract(${table.receiptJson}, '$.catalogGeneration') = ${table.catalogGeneration} and json_extract(${table.receiptJson}, '$.catalogDigest') = ${table.catalogDigest} and json_extract(${table.receiptJson}, '$.keyId') = ${table.keyId} and json_extract(${table.receiptJson}, '$.materialProof') = ${table.materialProof} and json_extract(${table.receiptJson}, '$.mutationId') = ${table.mutationId} and json_extract(${table.receiptJson}, '$.bindingCount') = ${table.bindingCount} and json_extract(${table.receiptJson}, '$.overlayHeadCount') = ${table.overlayHeadCount} and json_extract(${table.receiptJson}, '$.uncoveredBindingCount') = 0 and json_extract(${table.receiptJson}, '$.uncoveredOverlayHeadCount') = 0 and json_extract(${table.receiptJson}, '$.coverageDigest') = ${table.coverageDigest} and json_extract(${table.receiptJson}, '$.createdAtMs') = ${table.createdAtMs} and json_extract(${table.receiptJson}, '$.receiptDigest') = ${table.receiptDigest}`,
    ),
    index('ql3_tool_result_key_retirement_catalog_idx').on(
      table.catalogGeneration,
      table.keyId,
    ),
  ],
);

export const pluginPackageAdmissionReceipts = sqliteTable(
  'QingLong3PluginPackageAdmissionReceipts',
  {
    dispatchId: text('dispatch_id')
      .primaryKey()
      .references(() => approvedActionDispatches.dispatchId, {
        onDelete: 'restrict',
      }),
    dispatchDigest: text('dispatch_digest').notNull(),
    approvalRequestId: text('approval_request_id')
      .notNull()
      .references(() => approvalRequests.requestId, { onDelete: 'restrict' }),
    actionRef: text('action_ref').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    packageName: text('package_name').notNull(),
    installationId: text('installation_id')
      .notNull()
      .references(() => pluginPackageInstalls.installationId, {
        onDelete: 'restrict',
      }),
    lockDigest: text('lock_digest').notNull(),
    recordDigest: text('record_digest').notNull(),
    mutationId: text('mutation_id').notNull(),
    mutationDigest: text('mutation_digest').notNull(),
    auditEventId: text('audit_event_id')
      .notNull()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
      }),
    admittedAtMs: integer('admitted_at_ms').notNull(),
    receiptJson: text('receipt_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    receiptDigest: text('receipt_digest').notNull(),
  },
  (table) => [
    check(
      'ql3_plugin_package_admission_identity_check',
      sql`length(${table.dispatchId}) between 1 and 128 and length(${table.approvalRequestId}) between 1 and 128 and length(${table.actionRef}) between 1 and 255 and length(${table.projectId}) between 1 and 128 and length(${table.packageName}) between 1 and 64 and length(${table.installationId}) between 1 and 128 and length(${table.mutationId}) between 1 and 128 and length(${table.auditEventId}) = 36`,
    ),
    check(
      'ql3_plugin_package_admission_digest_check',
      sql`length(${table.dispatchDigest}) = 64 and ${table.dispatchDigest} not glob '*[^0-9a-f]*' and length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and length(${table.recordDigest}) = 64 and ${table.recordDigest} not glob '*[^0-9a-f]*' and length(${table.mutationDigest}) = 64 and ${table.mutationDigest} not glob '*[^0-9a-f]*' and length(${table.receiptDigest}) = 64 and ${table.receiptDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_admission_json_check',
      sql`length(${table.receiptJson}) between 2 and 65536 and json_valid(${table.receiptJson}) and json_type(${table.receiptJson}) = 'object' and json_extract(${table.receiptJson}, '$.schema') = 'qinglong/plugin-package-admission-receipt@v1' and json_extract(${table.receiptJson}, '$.dispatchId') = ${table.dispatchId} and json_extract(${table.receiptJson}, '$.dispatchDigest') = ${table.dispatchDigest} and json_extract(${table.receiptJson}, '$.approvalRequestId') = ${table.approvalRequestId} and json_extract(${table.receiptJson}, '$.actionRef') = ${table.actionRef} and json_extract(${table.receiptJson}, '$.projectId') = ${table.projectId} and json_extract(${table.receiptJson}, '$.packageName') = ${table.packageName} and json_extract(${table.receiptJson}, '$.installationId') = ${table.installationId} and json_extract(${table.receiptJson}, '$.lockDigest') = ${table.lockDigest} and json_extract(${table.receiptJson}, '$.recordDigest') = ${table.recordDigest} and json_extract(${table.receiptJson}, '$.mutationId') = ${table.mutationId} and json_extract(${table.receiptJson}, '$.mutationDigest') = ${table.mutationDigest} and json_extract(${table.receiptJson}, '$.auditEventId') = ${table.auditEventId} and json_extract(${table.receiptJson}, '$.admittedAtMs') = ${table.admittedAtMs} and json_extract(${table.receiptJson}, '$.receiptDigest') = ${table.receiptDigest}`,
    ),
    check(
      'ql3_plugin_package_admission_time_check',
      sql`${table.admittedAtMs} >= 0`,
    ),
    uniqueIndex('ql3_plugin_package_admission_install_uidx').on(
      table.installationId,
    ),
    uniqueIndex('ql3_plugin_package_admission_audit_uidx').on(
      table.auditEventId,
    ),
    index('ql3_plugin_package_admission_project_idx').on(
      table.projectId,
      table.admittedAtMs,
      table.dispatchId,
    ),
  ],
);

export const legacyAdoptions = sqliteTable(
  'QingLong3LegacyAdoptions',
  {
    mutationId: text('mutation_id').primaryKey(),
    decisionId: text('decision_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    profile: text('profile').notNull(),
    planDigest: text('plan_digest').notNull(),
    inventoryDigest: text('inventory_digest').notNull(),
    decisionDigest: text('decision_digest').notNull(),
    receiptDigest: text('receipt_digest').notNull(),
    authorizationFileDigest: text('authorization_file_digest').notNull(),
    publicationDigest: text('publication_digest').notNull(),
    rowCount: integer('row_count').notNull(),
    adoptedTaskCount: integer('adopted_task_count').notNull(),
    adoptedTriggerCount: integer('adopted_trigger_count').notNull(),
    skippedCount: integer('skipped_count').notNull(),
    auditEventId: text('audit_event_id')
      .notNull()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
      }),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_legacy_adoptions_mutation_check',
      sql`length(${table.mutationId}) = 36 and ${table.auditEventId} = ${table.mutationId}`,
    ),
    check(
      'ql3_legacy_adoptions_decision_check',
      sql`length(${table.decisionId}) = 36 and substr(${table.decisionId}, 15, 1) = '7' and replace(${table.decisionId}, '-', '') not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_legacy_adoptions_profile_check',
      sql`${table.profile} in ('edge', 'standalone')`,
    ),
    check(
      'ql3_legacy_adoptions_digest_check',
      sql`length(${table.planDigest}) = 64 and ${table.planDigest} not glob '*[^0-9a-f]*' and length(${table.inventoryDigest}) = 64 and ${table.inventoryDigest} not glob '*[^0-9a-f]*' and length(${table.decisionDigest}) = 64 and ${table.decisionDigest} not glob '*[^0-9a-f]*' and length(${table.receiptDigest}) = 64 and ${table.receiptDigest} not glob '*[^0-9a-f]*' and length(${table.authorizationFileDigest}) = 64 and ${table.authorizationFileDigest} not glob '*[^0-9a-f]*' and length(${table.publicationDigest}) = 64 and ${table.publicationDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_legacy_adoptions_count_check',
      sql`${table.rowCount} between 0 and 100000 and ${table.adoptedTaskCount} between 0 and ${table.rowCount} and ${table.skippedCount} between 0 and ${table.rowCount} and ${table.adoptedTaskCount} + ${table.skippedCount} = ${table.rowCount} and ${table.adoptedTriggerCount} between 0 and 500000`,
    ),
    check('ql3_legacy_adoptions_created_check', sql`${table.createdAtMs} >= 0`),
    uniqueIndex('ql3_legacy_adoptions_decision_uidx').on(table.decisionId),
    index('ql3_legacy_adoptions_project_time_idx').on(
      table.projectId,
      sql`${table.createdAtMs} desc`,
      sql`${table.mutationId} desc`,
    ),
  ],
);

export const legacyDataDirectoryAdoptions = sqliteTable(
  'QingLong3LegacyDataDirectoryAdoptions',
  {
    mutationId: text('mutation_id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    profile: text('profile').notNull(),
    sourceStageManifestDigest: text('source_stage_manifest_digest').notNull(),
    transformationDigest: text('transformation_digest').notNull(),
    modelDigest: text('model_digest').notNull(),
    secretCount: integer('secret_count').notNull(),
    environmentSecretCount: integer('environment_secret_count').notNull(),
    sshSecretCount: integer('ssh_secret_count').notNull(),
    modelJson: text('model_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    publicationDigest: text('publication_digest').notNull(),
    auditEventId: text('audit_event_id')
      .notNull()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    committedAtMs: integer('committed_at_ms').notNull(),
    receiptDigest: text('receipt_digest').notNull(),
    receiptJson: text('receipt_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    check(
      'ql3_legacy_data_directory_adoption_identity_check',
      sql`length(${table.mutationId}) = 36 and substr(${table.mutationId}, 15, 1) = '4' and replace(${table.mutationId}, '-', '') not glob '*[^0-9a-f]*' and ${table.auditEventId} = ${table.mutationId} and length(${table.projectId}) between 1 and 128`,
    ),
    check(
      'ql3_legacy_data_directory_adoption_profile_check',
      sql`${table.profile} in ('edge', 'standalone')`,
    ),
    check(
      'ql3_legacy_data_directory_adoption_digest_check',
      sql`length(${table.sourceStageManifestDigest}) = 64 and ${table.sourceStageManifestDigest} not glob '*[^0-9a-f]*' and length(${table.transformationDigest}) = 64 and ${table.transformationDigest} not glob '*[^0-9a-f]*' and length(${table.modelDigest}) = 64 and ${table.modelDigest} not glob '*[^0-9a-f]*' and length(${table.publicationDigest}) = 64 and ${table.publicationDigest} not glob '*[^0-9a-f]*' and length(${table.receiptDigest}) = 64 and ${table.receiptDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_legacy_data_directory_adoption_count_check',
      sql`${table.secretCount} between 0 and case ${table.profile} when 'edge' then 128 else 512 end and ${table.environmentSecretCount} between 0 and ${table.secretCount} and ${table.sshSecretCount} between 0 and ${table.secretCount} and ${table.environmentSecretCount} + ${table.sshSecretCount} = ${table.secretCount}`,
    ),
    check(
      'ql3_legacy_data_directory_adoption_model_check',
      sql`length(cast(${table.modelJson} as blob)) between 2 and 1048576 and json_valid(${table.modelJson}) and json_type(${table.modelJson}) = 'object' and json_extract(${table.modelJson}, '$.schema') = 'qinglong/legacy-data-directory-applied-model@v1' and json_extract(${table.modelJson}, '$.activation') = 'disabled' and json_extract(${table.modelJson}, '$.config.schema') = 'qinglong/legacy-config-transformation@v1' and json_extract(${table.modelJson}, '$.config.activation') = 'disabled' and json_extract(${table.modelJson}, '$.keyv.schema') = 'qinglong/legacy-keyv-transformation@v1' and json_extract(${table.modelJson}, '$.keyv.activation') = 'disabled' and json_extract(${table.modelJson}, '$.ssh.schema') = 'qinglong/legacy-ssh-transformation@v1' and json_extract(${table.modelJson}, '$.ssh.activation') = 'disabled' and json_extract(${table.modelJson}, '$.manualReview.schema') = 'qinglong/legacy-data-directory-manual-review@v1' and json_extract(${table.modelJson}, '$.manualReview.required') = 0 and json_extract(${table.modelJson}, '$.manualReview.activation') = 'disabled'`,
    ),
    check(
      'ql3_legacy_data_directory_adoption_receipt_check',
      sql`length(cast(${table.receiptJson} as blob)) between 2 and 1048576 and json_valid(${table.receiptJson}) and json_type(${table.receiptJson}) = 'object' and json_extract(${table.receiptJson}, '$.schema') = 'qinglong/legacy-data-directory-adoption-receipt@v1' and json_extract(${table.receiptJson}, '$.mutationId') = ${table.mutationId} and json_extract(${table.receiptJson}, '$.projectId') = ${table.projectId} and json_extract(${table.receiptJson}, '$.profile') = ${table.profile} and json_extract(${table.receiptJson}, '$.sourceStageManifestDigest') = ${table.sourceStageManifestDigest} and json_extract(${table.receiptJson}, '$.transformationDigest') = ${table.transformationDigest} and json_extract(${table.receiptJson}, '$.modelDigest') = ${table.modelDigest} and json_extract(${table.receiptJson}, '$.secretCount') = ${table.secretCount} and json_extract(${table.receiptJson}, '$.environmentSecretCount') = ${table.environmentSecretCount} and json_extract(${table.receiptJson}, '$.sshSecretCount') = ${table.sshSecretCount} and json_extract(${table.receiptJson}, '$.publicationDigest') = ${table.publicationDigest} and json_extract(${table.receiptJson}, '$.auditEventId') = ${table.auditEventId} and json_extract(${table.receiptJson}, '$.committedAtMs') = ${table.committedAtMs} and json_extract(${table.receiptJson}, '$.receiptDigest') = ${table.receiptDigest}`,
    ),
    check(
      'ql3_legacy_data_directory_adoption_time_check',
      sql`${table.committedAtMs} >= 0`,
    ),
    uniqueIndex('ql3_legacy_data_directory_adoption_transformation_uidx').on(
      table.transformationDigest,
    ),
    uniqueIndex('ql3_legacy_data_directory_adoption_receipt_uidx').on(
      table.receiptDigest,
    ),
    index('ql3_legacy_data_directory_adoption_project_time_idx').on(
      table.projectId,
      sql`${table.committedAtMs} desc`,
      sql`${table.mutationId} desc`,
    ),
  ],
);

export const legacyDataDirectoryAdoptionSecrets = sqliteTable(
  'QingLong3LegacyDataDirectoryAdoptionSecrets',
  {
    adoptionMutationId: text('adoption_mutation_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    projectId: text('project_id').notNull(),
    kind: text('kind').notNull(),
    sourceNameDigest: text('source_name_digest').notNull(),
    secretName: text('secret_name').notNull(),
    secretVersion: integer('secret_version').notNull(),
    secretMutationId: text('secret_mutation_id')
      .notNull()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    valueFile: text('value_file').notNull(),
    valueDigest: text('value_digest').notNull(),
    secretRef: text('secret_ref').notNull(),
    itemDigest: text('item_digest').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.adoptionMutationId, table.ordinal] }),
    foreignKey({
      columns: [table.adoptionMutationId],
      foreignColumns: [legacyDataDirectoryAdoptions.mutationId],
      name: 'ql3_legacy_data_directory_adoption_secret_parent_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.projectId, table.secretName, table.secretVersion],
      foreignColumns: [
        localSecretEnvelopes.projectId,
        localSecretEnvelopes.name,
        localSecretEnvelopes.version,
      ],
      name: 'ql3_legacy_data_directory_adoption_secret_envelope_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'ql3_legacy_data_directory_adoption_secret_identity_check',
      sql`${table.ordinal} between 1 and 512 and length(${table.projectId}) between 1 and 128 and ${table.kind} in ('environment', 'ssh_private_key') and length(${table.secretName}) between 1 and 128 and ${table.secretVersion} = 1 and length(${table.secretMutationId}) = 36 and substr(${table.secretMutationId}, 15, 1) = '4' and replace(${table.secretMutationId}, '-', '') not glob '*[^0-9a-f]*' and length(${table.valueFile}) = 83 and ${table.valueFile} glob 'secret-values/[0-9a-f]*.json' and length(${table.secretRef}) between 1 and 512`,
    ),
    check(
      'ql3_legacy_data_directory_adoption_secret_digest_check',
      sql`length(${table.sourceNameDigest}) = 64 and ${table.sourceNameDigest} not glob '*[^0-9a-f]*' and length(${table.valueDigest}) = 64 and ${table.valueDigest} not glob '*[^0-9a-f]*' and length(${table.itemDigest}) = 64 and ${table.itemDigest} not glob '*[^0-9a-f]*'`,
    ),
    uniqueIndex('ql3_legacy_data_directory_adoption_secret_name_uidx').on(
      table.adoptionMutationId,
      table.secretName,
    ),
    uniqueIndex('ql3_legacy_data_directory_adoption_secret_mutation_uidx').on(
      table.secretMutationId,
    ),
    uniqueIndex('ql3_legacy_data_directory_adoption_secret_item_uidx').on(
      table.itemDigest,
    ),
  ],
);

export const localIdentitySubjects = sqliteTable(
  'QingLong3IdentitySubjects',
  {
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subjectType, table.subjectId] }),
    check(
      'ql3_local_identity_type_check',
      sql`${table.subjectType} in ('user','api_app','mcp_client','agent','system','worker')`,
    ),
    check(
      'ql3_local_identity_id_check',
      sql`length(${table.subjectId}) between 1 and 255`,
    ),
    check(
      'ql3_local_identity_status_check',
      sql`${table.status} in ('active','disabled')`,
    ),
    check(
      'ql3_local_identity_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_local_identity_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    index('ql3_local_identity_status_idx').on(
      table.status,
      table.subjectType,
      table.subjectId,
    ),
  ],
);

export const localApiCredentials = sqliteTable(
  'QingLong3ApiCredentials',
  {
    credentialId: text('credential_id').notNull(),
    version: integer('version').notNull(),
    state: text('state').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    secretDigest: text('secret_digest').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    notBeforeAtMs: integer('not_before_at_ms').notNull(),
    expiresAtMs: integer('expires_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.credentialId, table.version] }),
    check(
      'ql3_local_credentials_id_check',
      sql`length(${table.credentialId}) between 1 and 64 and ${table.credentialId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      'ql3_local_credentials_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_local_credentials_state_check',
      sql`${table.state} in ('active','revoked')`,
    ),
    check(
      'ql3_local_credentials_subject_type_check',
      sql`${table.subjectType} in ('user','api_app','mcp_client','agent')`,
    ),
    check(
      'ql3_local_credentials_subject_id_check',
      sql`length(${table.subjectId}) between 1 and 255`,
    ),
    check(
      'ql3_local_credentials_digest_check',
      sql`length(${table.secretDigest}) = 64 and ${table.secretDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_local_credentials_lifetime_check',
      sql`${table.createdAtMs} >= 0 and ${table.notBeforeAtMs} >= ${table.createdAtMs} and ${table.expiresAtMs} > ${table.notBeforeAtMs}`,
    ),
    foreignKey({
      columns: [table.subjectType, table.subjectId],
      foreignColumns: [
        localIdentitySubjects.subjectType,
        localIdentitySubjects.subjectId,
      ],
      name: 'ql3_local_credentials_subject_fk',
    }).onDelete('restrict'),
    index('ql3_local_credentials_current_idx').on(
      table.credentialId,
      sql`${table.version} desc`,
    ),
    index('ql3_local_credentials_subject_idx').on(
      table.subjectType,
      table.subjectId,
      table.credentialId,
      sql`${table.version} desc`,
    ),
  ],
);

export const localApiCredentialPepperBindings = sqliteTable(
  'QingLong3ApiCredentialPepperBindings',
  {
    credentialId: text('credential_id').notNull(),
    credentialVersion: integer('credential_version').notNull(),
    pepperKeyId: text('pepper_key_id')
      .notNull()
      .references(() => localOwnerPepperKeys.pepperKeyId, {
        onDelete: 'restrict',
      }),
  },
  (table) => [
    primaryKey({
      columns: [table.credentialId, table.credentialVersion],
    }),
    check(
      'ql3_local_credential_pepper_key_id_check',
      sql`length(${table.pepperKeyId}) between 1 and 64 and ${table.pepperKeyId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    foreignKey({
      columns: [table.credentialId, table.credentialVersion],
      foreignColumns: [
        localApiCredentials.credentialId,
        localApiCredentials.version,
      ],
      name: 'ql3_local_credential_pepper_binding_credential_fk',
    }).onDelete('restrict'),
    index('ql3_local_credential_pepper_key_idx').on(
      table.pepperKeyId,
      table.credentialId,
      table.credentialVersion,
    ),
    uniqueIndex('ql3_local_credential_pepper_binding_triple_uidx').on(
      table.credentialId,
      table.credentialVersion,
      table.pepperKeyId,
    ),
  ],
);

export const localOwnerPepperKeys = sqliteTable(
  'QingLong3LocalOwnerPepperKeys',
  {
    pepperKeyId: text('pepper_key_id').primaryKey(),
    materialDigest: text('material_digest'),
    backupDigest: text('backup_digest'),
    state: text('state').notNull(),
    version: integer('version').notNull(),
    registerMutationId: text('register_mutation_id'),
    activateMutationId: text('activate_mutation_id'),
    retireMutationId: text('retire_mutation_id'),
    registeredAtMs: integer('registered_at_ms').notNull(),
    activatedAtMs: integer('activated_at_ms'),
    retiredAtMs: integer('retired_at_ms'),
  },
  (table) => [
    check(
      'ql3_local_owner_pepper_key_id_check',
      sql`length(${table.pepperKeyId}) between 1 and 64 and ${table.pepperKeyId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      'ql3_local_owner_pepper_digest_check',
      sql`(${table.materialDigest} is null and ${table.backupDigest} is null) or (length(${table.materialDigest}) = 64 and ${table.materialDigest} not glob '*[^0-9a-f]*' and length(${table.backupDigest}) = 64 and ${table.backupDigest} not glob '*[^0-9a-f]*')`,
    ),
    check(
      'ql3_local_owner_pepper_state_check',
      sql`${table.state} in ('recovery_required','staged','active','retired')`,
    ),
    check(
      'ql3_local_owner_pepper_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_local_owner_pepper_mutation_check',
      sql`(${table.registerMutationId} is null or length(${table.registerMutationId}) = 36) and (${table.activateMutationId} is null or length(${table.activateMutationId}) = 36) and (${table.retireMutationId} is null or length(${table.retireMutationId}) = 36)`,
    ),
    check(
      'ql3_local_owner_pepper_time_check',
      sql`${table.registeredAtMs} >= 0 and (${table.activatedAtMs} is null or ${table.activatedAtMs} >= ${table.registeredAtMs}) and (${table.retiredAtMs} is null or ${table.retiredAtMs} >= ${table.activatedAtMs})`,
    ),
    check(
      'ql3_local_owner_pepper_shape_check',
      sql`(${table.state} = 'recovery_required' and ${table.materialDigest} is null and ${table.backupDigest} is null and ${table.registerMutationId} is null and ${table.activateMutationId} is null and ${table.retireMutationId} is null and ${table.activatedAtMs} is null and ${table.retiredAtMs} is null) or (${table.state} = 'staged' and ${table.materialDigest} is not null and ${table.backupDigest} is not null and ${table.registerMutationId} is not null and ${table.activateMutationId} is null and ${table.retireMutationId} is null and ${table.activatedAtMs} is null and ${table.retiredAtMs} is null) or (${table.state} = 'active' and ${table.materialDigest} is not null and ${table.backupDigest} is not null and ${table.registerMutationId} is not null and ${table.activateMutationId} is not null and ${table.retireMutationId} is null and ${table.activatedAtMs} is not null and ${table.retiredAtMs} is null) or (${table.state} = 'retired' and ${table.materialDigest} is not null and ${table.backupDigest} is not null and ${table.registerMutationId} is not null and ${table.activateMutationId} is not null and ${table.retireMutationId} is not null and ${table.activatedAtMs} is not null and ${table.retiredAtMs} is not null)`,
    ),
    uniqueIndex('ql3_local_owner_pepper_register_mutation_uidx')
      .on(table.registerMutationId)
      .where(sql`${table.registerMutationId} is not null`),
    uniqueIndex('ql3_local_owner_pepper_single_active_uidx')
      .on(table.state)
      .where(sql`${table.state} = 'active'`),
    index('ql3_local_owner_pepper_state_idx').on(
      table.state,
      table.pepperKeyId,
    ),
  ],
);

export const localOwnerPepperActivations = sqliteTable(
  'QingLong3LocalOwnerPepperActivations',
  {
    generation: integer('generation').primaryKey(),
    mutationId: text('mutation_id').notNull(),
    expectedGeneration: integer('expected_generation').notNull(),
    previousPepperKeyId: text('previous_pepper_key_id').references(
      () => localOwnerPepperKeys.pepperKeyId,
      { onDelete: 'restrict' },
    ),
    activePepperKeyId: text('active_pepper_key_id')
      .notNull()
      .references(() => localOwnerPepperKeys.pepperKeyId, {
        onDelete: 'restrict',
      }),
    materialDigest: text('material_digest').notNull(),
    backupDigest: text('backup_digest').notNull(),
    activatedAtMs: integer('activated_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_local_owner_pepper_activation_generation_check',
      sql`${table.generation} between 1 and 2147483647 and ${table.expectedGeneration} = ${table.generation} - 1`,
    ),
    check(
      'ql3_local_owner_pepper_activation_mutation_check',
      sql`length(${table.mutationId}) = 36`,
    ),
    check(
      'ql3_local_owner_pepper_activation_key_check',
      sql`length(${table.activePepperKeyId}) between 1 and 64 and ${table.activePepperKeyId} not glob '*[^A-Za-z0-9._:-]*' and (${table.previousPepperKeyId} is null or (length(${table.previousPepperKeyId}) between 1 and 64 and ${table.previousPepperKeyId} not glob '*[^A-Za-z0-9._:-]*' and ${table.previousPepperKeyId} <> ${table.activePepperKeyId}))`,
    ),
    check(
      'ql3_local_owner_pepper_activation_digest_check',
      sql`length(${table.materialDigest}) = 64 and ${table.materialDigest} not glob '*[^0-9a-f]*' and length(${table.backupDigest}) = 64 and ${table.backupDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_local_owner_pepper_activation_time_check',
      sql`${table.activatedAtMs} >= 0`,
    ),
    uniqueIndex('ql3_local_owner_pepper_activation_mutation_uidx').on(
      table.mutationId,
    ),
    index('ql3_local_owner_pepper_activation_key_idx').on(
      table.activePepperKeyId,
      sql`${table.generation} desc`,
    ),
  ],
);

export const localIdentityProvisionings = sqliteTable(
  'QingLong3LocalIdentityProvisionings',
  {
    slot: integer('slot').primaryKey(),
    mutationId: text('mutation_id').notNull(),
    requestId: text('request_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    credentialId: text('credential_id').notNull(),
    credentialVersion: integer('credential_version').notNull(),
    issuerAuthenticationId: text('issuer_authentication_id').notNull(),
    issuerAuthenticatedAtMs: integer('issuer_authenticated_at_ms').notNull(),
    issuerExpiresAtMs: integer('issuer_expires_at_ms').notNull(),
    auditEventId: text('audit_event_id').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    check('ql3_local_provisioning_singleton_check', sql`${table.slot} = 1`),
    check(
      'ql3_local_provisioning_mutation_check',
      sql`length(${table.mutationId}) = 36`,
    ),
    check(
      'ql3_local_provisioning_request_check',
      sql`length(${table.requestId}) between 1 and 128`,
    ),
    check(
      'ql3_local_provisioning_subject_check',
      sql`${table.subjectType} = 'user' and length(${table.subjectId}) between 1 and 255`,
    ),
    check(
      'ql3_local_provisioning_credential_check',
      sql`length(${table.credentialId}) between 1 and 64 and ${table.credentialVersion} = 1`,
    ),
    check(
      'ql3_local_provisioning_issuer_check',
      sql`length(${table.issuerAuthenticationId}) between 1 and 128 and ${table.issuerAuthenticatedAtMs} <= ${table.createdAtMs} and ${table.issuerExpiresAtMs} > ${table.createdAtMs}`,
    ),
    check(
      'ql3_local_provisioning_audit_check',
      sql`${table.auditEventId} = ${table.mutationId}`,
    ),
    check('ql3_local_provisioning_time_check', sql`${table.createdAtMs} >= 0`),
    foreignKey({
      columns: [table.subjectType, table.subjectId],
      foreignColumns: [
        localIdentitySubjects.subjectType,
        localIdentitySubjects.subjectId,
      ],
      name: 'ql3_local_provisioning_subject_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.credentialId, table.credentialVersion],
      foreignColumns: [
        localApiCredentials.credentialId,
        localApiCredentials.version,
      ],
      name: 'ql3_local_provisioning_credential_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.auditEventId],
      foreignColumns: [localSecurityAuditEvents.eventId],
      name: 'ql3_local_provisioning_audit_fk',
    }).onDelete('restrict'),
    uniqueIndex('ql3_local_provisioning_mutation_uidx').on(table.mutationId),
    uniqueIndex('ql3_local_provisioning_subject_uidx').on(
      table.subjectType,
      table.subjectId,
    ),
    uniqueIndex('ql3_local_provisioning_credential_uidx').on(
      table.credentialId,
      table.credentialVersion,
    ),
  ],
);

export const localOwnerBootstrapChallenges = sqliteTable(
  'QingLong3LocalOwnerBootstrapChallenges',
  {
    projectId: text('project_id').notNull(),
    version: integer('version').notNull(),
    issueMutationId: text('issue_mutation_id').notNull(),
    issueRequestId: text('issue_request_id').notNull(),
    challengeId: text('challenge_id').notNull(),
    tokenDigest: text('token_digest').notNull(),
    issuerAuthenticationId: text('issuer_authentication_id').notNull(),
    issuerAuthenticatedAtMs: integer('issuer_authenticated_at_ms').notNull(),
    issuerExpiresAtMs: integer('issuer_expires_at_ms').notNull(),
    issuedAtMs: integer('issued_at_ms').notNull(),
    expiresAtMs: integer('expires_at_ms').notNull(),
    issueAuditEventId: text('issue_audit_event_id').notNull(),
    consumedAtMs: integer('consumed_at_ms'),
    claimMutationId: text('claim_mutation_id'),
    claimRequestId: text('claim_request_id'),
    claimedSubjectType: text('claimed_subject_type'),
    claimedSubjectId: text('claimed_subject_id'),
    credentialId: text('credential_id'),
    credentialVersion: integer('credential_version'),
    claimAuthenticationId: text('claim_authentication_id'),
    claimAuthenticatedAtMs: integer('claim_authenticated_at_ms'),
    claimExpiresAtMs: integer('claim_expires_at_ms'),
    claimAssurance: text('claim_assurance'),
    claimAuditEventId: text('claim_audit_event_id'),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.version] }),
    check(
      'ql3_local_owner_challenge_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_local_owner_challenge_issue_identity_check',
      sql`length(${table.issueMutationId}) = 36 and length(${table.issueRequestId}) between 1 and 128 and ${table.issueAuditEventId} = ${table.issueMutationId}`,
    ),
    check(
      'ql3_local_owner_challenge_id_check',
      sql`length(${table.challengeId}) = 22 and ${table.challengeId} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      'ql3_local_owner_challenge_digest_check',
      sql`length(${table.tokenDigest}) = 64 and ${table.tokenDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_local_owner_challenge_issuer_check',
      sql`length(${table.issuerAuthenticationId}) between 1 and 128 and ${table.issuerAuthenticatedAtMs} <= ${table.issuedAtMs} and ${table.issuerExpiresAtMs} > ${table.issuedAtMs}`,
    ),
    check(
      'ql3_local_owner_challenge_lifetime_check',
      sql`${table.issuedAtMs} >= 0 and ${table.expiresAtMs} > ${table.issuedAtMs} and ${table.expiresAtMs} - ${table.issuedAtMs} between 60000 and 1800000`,
    ),
    check(
      'ql3_local_owner_challenge_claim_shape_check',
      sql`(${table.consumedAtMs} is null and ${table.claimMutationId} is null and ${table.claimRequestId} is null and ${table.claimedSubjectType} is null and ${table.claimedSubjectId} is null and ${table.credentialId} is null and ${table.credentialVersion} is null and ${table.claimAuthenticationId} is null and ${table.claimAuthenticatedAtMs} is null and ${table.claimExpiresAtMs} is null and ${table.claimAssurance} is null and ${table.claimAuditEventId} is null) or (${table.consumedAtMs} >= ${table.issuedAtMs} and ${table.consumedAtMs} < ${table.expiresAtMs} and length(${table.claimMutationId}) = 36 and length(${table.claimRequestId}) between 1 and 128 and ${table.claimedSubjectType} = 'user' and length(${table.claimedSubjectId}) between 1 and 255 and length(${table.credentialId}) between 1 and 64 and ${table.credentialVersion} between 1 and 2147483647 and length(${table.claimAuthenticationId}) between 1 and 128 and ${table.claimAuthenticatedAtMs} <= ${table.consumedAtMs} and ${table.claimExpiresAtMs} > ${table.consumedAtMs} and ${table.claimAssurance} = 'single_factor' and ${table.claimAuditEventId} = ${table.claimMutationId})`,
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [localProjects.id],
      name: 'ql3_local_owner_challenge_project_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.issueAuditEventId],
      foreignColumns: [localSecurityAuditEvents.eventId],
      name: 'ql3_local_owner_challenge_issue_audit_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.claimedSubjectType, table.claimedSubjectId],
      foreignColumns: [
        localIdentitySubjects.subjectType,
        localIdentitySubjects.subjectId,
      ],
      name: 'ql3_local_owner_challenge_subject_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.credentialId, table.credentialVersion],
      foreignColumns: [
        localApiCredentials.credentialId,
        localApiCredentials.version,
      ],
      name: 'ql3_local_owner_challenge_credential_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.claimAuditEventId],
      foreignColumns: [localSecurityAuditEvents.eventId],
      name: 'ql3_local_owner_challenge_claim_audit_fk',
    }).onDelete('restrict'),
    uniqueIndex('ql3_local_owner_challenge_issue_mutation_uidx').on(
      table.issueMutationId,
    ),
    uniqueIndex('ql3_local_owner_challenge_id_uidx').on(table.challengeId),
    uniqueIndex('ql3_local_owner_challenge_claim_mutation_uidx')
      .on(table.claimMutationId)
      .where(sql`${table.claimMutationId} is not null`),
    index('ql3_local_owner_challenge_current_idx').on(
      table.projectId,
      sql`${table.version} desc`,
    ),
    index('ql3_local_owner_challenge_expiry_idx')
      .on(table.projectId, table.expiresAtMs, sql`${table.version} desc`)
      .where(sql`${table.consumedAtMs} is null`),
  ],
);

export const localOwnerDeliveryAcknowledgements = sqliteTable(
  'QingLong3LocalOwnerDeliveryAcknowledgements',
  {
    mutationId: text('mutation_id').primaryKey(),
    kind: text('kind').notNull(),
    requestId: text('request_id').notNull(),
    projectId: text('project_id'),
    subjectId: text('subject_id'),
    credentialId: text('credential_id'),
    challengeId: text('challenge_id'),
    factDigest: text('fact_digest').notNull(),
    deliveryDigest: text('delivery_digest').notNull(),
    ttlMs: integer('ttl_ms').notNull(),
    acknowledgedAtMs: integer('acknowledged_at_ms').notNull(),
    provisioningMutationId: text('provisioning_mutation_id'),
    challengeMutationId: text('challenge_mutation_id'),
  },
  (table) => [
    check(
      'ql3_local_owner_delivery_ack_mutation_check',
      sql`length(${table.mutationId}) = 36`,
    ),
    check(
      'ql3_local_owner_delivery_ack_request_check',
      sql`length(${table.requestId}) between 1 and 128`,
    ),
    check(
      'ql3_local_owner_delivery_ack_digest_check',
      sql`length(${table.factDigest}) = 64 and ${table.factDigest} not glob '*[^0-9a-f]*' and length(${table.deliveryDigest}) = 64 and ${table.deliveryDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_local_owner_delivery_ack_time_check',
      sql`${table.ttlMs} > 0 and ${table.acknowledgedAtMs} >= 0`,
    ),
    check(
      'ql3_local_owner_delivery_ack_shape_check',
      sql`(${table.kind} = 'credential' and ${table.projectId} is null and length(${table.subjectId}) = 26 and ${table.subjectId} glob 'usr_*' and ${table.subjectId} not glob '*[^A-Za-z0-9_-]*' and length(${table.credentialId}) = 26 and ${table.credentialId} glob 'own_*' and ${table.credentialId} not glob '*[^A-Za-z0-9_-]*' and ${table.challengeId} is null and ${table.provisioningMutationId} = ${table.mutationId} and ${table.challengeMutationId} is null and ${table.ttlMs} between 600000 and 604800000) or (${table.kind} = 'challenge' and length(${table.projectId}) between 1 and 128 and ${table.subjectId} is null and ${table.credentialId} is null and length(${table.challengeId}) = 22 and ${table.challengeId} not glob '*[^A-Za-z0-9_-]*' and ${table.provisioningMutationId} is null and ${table.challengeMutationId} = ${table.mutationId} and ${table.ttlMs} between 60000 and 1800000)`,
    ),
    foreignKey({
      columns: [table.provisioningMutationId],
      foreignColumns: [localIdentityProvisionings.mutationId],
      name: 'ql3_local_owner_delivery_ack_provisioning_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.challengeMutationId],
      foreignColumns: [localOwnerBootstrapChallenges.issueMutationId],
      name: 'ql3_local_owner_delivery_ack_challenge_fk',
    }).onDelete('restrict'),
  ],
);

export const localOwnerDeliveryAcknowledgementGc = sqliteTable(
  'QingLong3LocalOwnerDeliveryAcknowledgementGc',
  {
    gcMutationId: text('gc_mutation_id').primaryKey(),
    gcRequestId: text('gc_request_id').notNull(),
    acknowledgementMutationId: text('acknowledgement_mutation_id').notNull(),
    acknowledgementKind: text('acknowledgement_kind').notNull(),
    deliveryDigest: text('delivery_digest').notNull(),
    acknowledgedAtMs: integer('acknowledged_at_ms').notNull(),
    acknowledgementSemanticDigest: text(
      'acknowledgement_semantic_digest',
    ).notNull(),
    bridgeClearEvidenceDigest: text('bridge_clear_evidence_digest').notNull(),
    retentionPolicyVersion: integer('retention_policy_version').notNull(),
    replayRetentionMs: integer('replay_retention_ms').notNull(),
    auditRetentionMs: integer('audit_retention_ms').notNull(),
    retentionPolicyDigest: text('retention_policy_digest').notNull(),
    retentionEligibleAtMs: integer('retention_eligible_at_ms').notNull(),
    compactedAtMs: integer('compacted_at_ms').notNull(),
    auditEventId: text('audit_event_id')
      .notNull()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
      }),
    provisioningMutationId: text('provisioning_mutation_id').references(
      () => localIdentityProvisionings.mutationId,
      { onDelete: 'restrict' },
    ),
    challengeMutationId: text('challenge_mutation_id').references(
      () => localOwnerBootstrapChallenges.issueMutationId,
      { onDelete: 'restrict' },
    ),
  },
  (table) => [
    check(
      'ql3_local_owner_delivery_ack_gc_mutation_check',
      sql`length(${table.gcMutationId}) = 36 and ${table.auditEventId} = ${table.gcMutationId} and length(${table.acknowledgementMutationId}) = 36 and ${table.acknowledgementMutationId} <> ${table.gcMutationId}`,
    ),
    check(
      'ql3_local_owner_delivery_ack_gc_request_check',
      sql`length(${table.gcRequestId}) between 1 and 128`,
    ),
    check(
      'ql3_local_owner_delivery_ack_gc_digest_check',
      sql`length(${table.deliveryDigest}) = 64 and ${table.deliveryDigest} not glob '*[^0-9a-f]*' and length(${table.acknowledgementSemanticDigest}) = 64 and ${table.acknowledgementSemanticDigest} not glob '*[^0-9a-f]*' and length(${table.bridgeClearEvidenceDigest}) = 64 and ${table.bridgeClearEvidenceDigest} not glob '*[^0-9a-f]*' and length(${table.retentionPolicyDigest}) = 64 and ${table.retentionPolicyDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_local_owner_delivery_ack_gc_retention_check',
      sql`${table.retentionPolicyVersion} = 1 and ${table.replayRetentionMs} between 2592000000 and 315360000000 and ${table.auditRetentionMs} between 2592000000 and 315360000000`,
    ),
    check(
      'ql3_local_owner_delivery_ack_gc_time_check',
      sql`${table.acknowledgedAtMs} >= 0 and ${table.retentionEligibleAtMs} <= ${table.compactedAtMs} and ${table.compactedAtMs} >= ${table.acknowledgedAtMs}`,
    ),
    check(
      'ql3_local_owner_delivery_ack_gc_shape_check',
      sql`(${table.acknowledgementKind} = 'credential' and ${table.provisioningMutationId} = ${table.acknowledgementMutationId} and ${table.challengeMutationId} is null) or (${table.acknowledgementKind} = 'challenge' and ${table.provisioningMutationId} is null and ${table.challengeMutationId} = ${table.acknowledgementMutationId})`,
    ),
    uniqueIndex('ql3_local_owner_delivery_ack_gc_ack_uidx').on(
      table.acknowledgementMutationId,
    ),
    index('ql3_local_owner_delivery_ack_gc_compacted_idx').on(
      table.acknowledgementKind,
      table.compactedAtMs,
      table.acknowledgementMutationId,
    ),
  ],
);

export const localOwnerCredentialRecoveries = sqliteTable(
  'QingLong3LocalOwnerCredentialRecoveries',
  {
    issueMutationId: text('issue_mutation_id').primaryKey(),
    issueRequestId: text('issue_request_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    previousCredentialId: text('previous_credential_id').notNull(),
    previousCredentialVersion: integer('previous_credential_version').notNull(),
    replacementCredentialId: text('replacement_credential_id').notNull(),
    replacementCredentialVersion: integer(
      'replacement_credential_version',
    ).notNull(),
    state: text('state').notNull(),
    issuedAtMs: integer('issued_at_ms').notNull(),
    issueAuditEventId: text('issue_audit_event_id').notNull(),
    deliveryDigest: text('delivery_digest'),
    acknowledgedAtMs: integer('acknowledged_at_ms'),
    completeMutationId: text('complete_mutation_id'),
    completeRequestId: text('complete_request_id'),
    revokedCredentialVersion: integer('revoked_credential_version'),
    completedAtMs: integer('completed_at_ms'),
    completeAuditEventId: text('complete_audit_event_id'),
  },
  (table) => [
    check(
      'ql3_local_owner_recovery_mutation_check',
      sql`length(${table.issueMutationId}) = 36 and ${table.issueAuditEventId} = ${table.issueMutationId} and (${table.completeMutationId} is null or (length(${table.completeMutationId}) = 36 and ${table.completeAuditEventId} = ${table.completeMutationId} and ${table.completeMutationId} <> ${table.issueMutationId}))`,
    ),
    check(
      'ql3_local_owner_recovery_request_check',
      sql`length(${table.issueRequestId}) between 1 and 128 and (${table.completeRequestId} is null or length(${table.completeRequestId}) between 1 and 128)`,
    ),
    check(
      'ql3_local_owner_recovery_identity_check',
      sql`${table.subjectType} = 'user' and length(${table.subjectId}) = 26 and ${table.subjectId} glob 'usr_*' and ${table.subjectId} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      'ql3_local_owner_recovery_credential_check',
      sql`length(${table.previousCredentialId}) between 1 and 64 and ${table.previousCredentialId} not glob '*[^A-Za-z0-9._:-]*' and ${table.previousCredentialVersion} between 1 and 2147483646 and length(${table.replacementCredentialId}) between 1 and 64 and ${table.replacementCredentialId} not glob '*[^A-Za-z0-9._:-]*' and ${table.replacementCredentialId} <> ${table.previousCredentialId} and ${table.replacementCredentialVersion} = 1 and (${table.revokedCredentialVersion} is null or ${table.revokedCredentialVersion} = ${table.previousCredentialVersion} + 1)`,
    ),
    check(
      'ql3_local_owner_recovery_digest_check',
      sql`${table.deliveryDigest} is null or (length(${table.deliveryDigest}) = 64 and ${table.deliveryDigest} not glob '*[^0-9a-f]*')`,
    ),
    check(
      'ql3_local_owner_recovery_time_check',
      sql`${table.issuedAtMs} >= 0 and (${table.acknowledgedAtMs} is null or ${table.acknowledgedAtMs} >= ${table.issuedAtMs}) and (${table.completedAtMs} is null or ${table.completedAtMs} >= ${table.acknowledgedAtMs})`,
    ),
    check(
      'ql3_local_owner_recovery_shape_check',
      sql`(${table.state} = 'issued' and ${table.deliveryDigest} is null and ${table.acknowledgedAtMs} is null and ${table.completeMutationId} is null and ${table.completeRequestId} is null and ${table.revokedCredentialVersion} is null and ${table.completedAtMs} is null and ${table.completeAuditEventId} is null) or (${table.state} = 'acknowledged' and ${table.deliveryDigest} is not null and ${table.acknowledgedAtMs} is not null and ${table.completeMutationId} is null and ${table.completeRequestId} is null and ${table.revokedCredentialVersion} is null and ${table.completedAtMs} is null and ${table.completeAuditEventId} is null) or (${table.state} = 'completed' and ${table.deliveryDigest} is not null and ${table.acknowledgedAtMs} is not null and ${table.completeMutationId} is not null and ${table.completeRequestId} is not null and ${table.revokedCredentialVersion} is not null and ${table.completedAtMs} is not null and ${table.completeAuditEventId} is not null)`,
    ),
    foreignKey({
      columns: [table.subjectType, table.subjectId],
      foreignColumns: [
        localIdentitySubjects.subjectType,
        localIdentitySubjects.subjectId,
      ],
      name: 'ql3_local_owner_recovery_subject_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.previousCredentialId, table.previousCredentialVersion],
      foreignColumns: [
        localApiCredentials.credentialId,
        localApiCredentials.version,
      ],
      name: 'ql3_local_owner_recovery_previous_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.replacementCredentialId,
        table.replacementCredentialVersion,
      ],
      foreignColumns: [
        localApiCredentials.credentialId,
        localApiCredentials.version,
      ],
      name: 'ql3_local_owner_recovery_replacement_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.previousCredentialId, table.revokedCredentialVersion],
      foreignColumns: [
        localApiCredentials.credentialId,
        localApiCredentials.version,
      ],
      name: 'ql3_local_owner_recovery_revoked_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.issueAuditEventId],
      foreignColumns: [localSecurityAuditEvents.eventId],
      name: 'ql3_local_owner_recovery_issue_audit_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.completeAuditEventId],
      foreignColumns: [localSecurityAuditEvents.eventId],
      name: 'ql3_local_owner_recovery_complete_audit_fk',
    }).onDelete('restrict'),
    uniqueIndex('ql3_local_owner_recovery_open_subject_uidx')
      .on(table.subjectId)
      .where(sql`${table.state} <> 'completed'`),
    uniqueIndex('ql3_local_owner_recovery_replacement_uidx').on(
      table.replacementCredentialId,
      table.replacementCredentialVersion,
    ),
    uniqueIndex('ql3_local_owner_recovery_complete_mutation_uidx')
      .on(table.completeMutationId)
      .where(sql`${table.completeMutationId} is not null`),
    index('ql3_local_owner_recovery_previous_idx').on(
      table.previousCredentialId,
      table.previousCredentialVersion,
      table.state,
    ),
  ],
);

export const localOwnerPepperMaterialGc = sqliteTable(
  'QingLong3LocalOwnerPepperMaterialGc',
  {
    prepareMutationId: text('prepare_mutation_id').primaryKey(),
    prepareRequestId: text('prepare_request_id').notNull(),
    pepperKeyId: text('pepper_key_id')
      .notNull()
      .references(() => localOwnerPepperKeys.pepperKeyId, {
        onDelete: 'restrict',
      }),
    materialDigest: text('material_digest').notNull(),
    backupMaterialDigest: text('backup_material_digest').notNull(),
    activePepperKeyId: text('active_pepper_key_id')
      .notNull()
      .references(() => localOwnerPepperKeys.pepperKeyId, {
        onDelete: 'restrict',
      }),
    activeGeneration: integer('active_generation')
      .notNull()
      .references(() => localOwnerPepperActivations.generation, {
        onDelete: 'restrict',
      }),
    activeMaterialDigest: text('active_material_digest').notNull(),
    retentionPolicyVersion: integer('retention_policy_version').notNull(),
    acknowledgementRetentionMs: integer(
      'acknowledgement_retention_ms',
    ).notNull(),
    auditRetentionMs: integer('audit_retention_ms').notNull(),
    backupRetentionMs: integer('backup_retention_ms').notNull(),
    retentionPolicyDigest: text('retention_policy_digest').notNull(),
    referencesInspectedAtMs: integer('references_inspected_at_ms').notNull(),
    retentionEligibleAtMs: integer('retention_eligible_at_ms').notNull(),
    preparedAtMs: integer('prepared_at_ms').notNull(),
    prepareAuditEventId: text('prepare_audit_event_id')
      .notNull()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
      }),
    state: text('state').notNull(),
    completeMutationId: text('complete_mutation_id'),
    completeRequestId: text('complete_request_id'),
    destructionProofDigest: text('destruction_proof_digest'),
    completedAtMs: integer('completed_at_ms'),
    completeAuditEventId: text('complete_audit_event_id').references(
      () => localSecurityAuditEvents.eventId,
      { onDelete: 'restrict' },
    ),
  },
  (table) => [
    check(
      'ql3_local_owner_pepper_gc_mutation_check',
      sql`length(${table.prepareMutationId}) = 36 and ${table.prepareAuditEventId} = ${table.prepareMutationId} and (${table.completeMutationId} is null or (length(${table.completeMutationId}) = 36 and ${table.completeMutationId} <> ${table.prepareMutationId} and ${table.completeAuditEventId} = ${table.completeMutationId}))`,
    ),
    check(
      'ql3_local_owner_pepper_gc_request_check',
      sql`length(${table.prepareRequestId}) between 1 and 128 and (${table.completeRequestId} is null or length(${table.completeRequestId}) between 1 and 128)`,
    ),
    check(
      'ql3_local_owner_pepper_gc_key_check',
      sql`length(${table.pepperKeyId}) between 1 and 64 and ${table.pepperKeyId} not glob '*[^A-Za-z0-9._:-]*' and length(${table.activePepperKeyId}) between 1 and 64 and ${table.activePepperKeyId} not glob '*[^A-Za-z0-9._:-]*' and ${table.pepperKeyId} <> ${table.activePepperKeyId} and ${table.activeGeneration} between 1 and 2147483647`,
    ),
    check(
      'ql3_local_owner_pepper_gc_digest_check',
      sql`length(${table.materialDigest}) = 64 and ${table.materialDigest} not glob '*[^0-9a-f]*' and length(${table.backupMaterialDigest}) = 64 and ${table.backupMaterialDigest} not glob '*[^0-9a-f]*' and length(${table.activeMaterialDigest}) = 64 and ${table.activeMaterialDigest} not glob '*[^0-9a-f]*' and length(${table.retentionPolicyDigest}) = 64 and ${table.retentionPolicyDigest} not glob '*[^0-9a-f]*' and (${table.destructionProofDigest} is null or (length(${table.destructionProofDigest}) = 64 and ${table.destructionProofDigest} not glob '*[^0-9a-f]*'))`,
    ),
    check(
      'ql3_local_owner_pepper_gc_retention_check',
      sql`${table.retentionPolicyVersion} = 1 and ${table.acknowledgementRetentionMs} between 604800000 and 315360000000 and ${table.auditRetentionMs} between 2592000000 and 315360000000 and ${table.backupRetentionMs} between 2592000000 and 315360000000`,
    ),
    check(
      'ql3_local_owner_pepper_gc_time_check',
      sql`${table.referencesInspectedAtMs} = ${table.preparedAtMs} and ${table.retentionEligibleAtMs} <= ${table.preparedAtMs} and ${table.preparedAtMs} >= 0 and (${table.completedAtMs} is null or ${table.completedAtMs} >= ${table.preparedAtMs})`,
    ),
    check(
      'ql3_local_owner_pepper_gc_shape_check',
      sql`(${table.state} = 'prepared' and ${table.completeMutationId} is null and ${table.completeRequestId} is null and ${table.destructionProofDigest} is null and ${table.completedAtMs} is null and ${table.completeAuditEventId} is null) or (${table.state} = 'completed' and ${table.completeMutationId} is not null and ${table.completeRequestId} is not null and ${table.destructionProofDigest} is not null and ${table.completedAtMs} is not null and ${table.completeAuditEventId} is not null)`,
    ),
    uniqueIndex('ql3_local_owner_pepper_gc_key_uidx').on(table.pepperKeyId),
    uniqueIndex('ql3_local_owner_pepper_gc_open_uidx')
      .on(table.state)
      .where(sql`${table.state} = 'prepared'`),
    uniqueIndex('ql3_local_owner_pepper_gc_complete_mutation_uidx')
      .on(table.completeMutationId)
      .where(sql`${table.completeMutationId} is not null`),
    index('ql3_local_owner_pepper_gc_state_idx').on(
      table.state,
      table.retentionEligibleAtMs,
      table.pepperKeyId,
    ),
  ],
);

export const localIdentityAdministrationMutations = sqliteTable(
  'QingLong3IdentityAdministrationMutations',
  {
    mutationId: text('mutation_id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    operation: text('operation').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    subjectVersion: integer('subject_version').notNull(),
    expectedPreviousVersion: integer('expected_previous_version').notNull(),
    status: text('status').notNull(),
    changedByType: text('changed_by_type').notNull(),
    changedById: text('changed_by_id').notNull(),
    auditEventId: text('audit_event_id')
      .notNull()
      .unique()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
      }),
    identityCreatedAtMs: integer('identity_created_at_ms').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_identity_admin_mutation_id_check',
      sql`length(${table.mutationId}) = 36`,
    ),
    check(
      'ql3_identity_admin_operation_check',
      sql`${table.operation} in ('register','enable','disable')`,
    ),
    check(
      'ql3_identity_admin_subject_check',
      sql`${table.subjectType} in ('user','api_app','mcp_client','agent') and length(${table.subjectId}) between 1 and 255`,
    ),
    check(
      'ql3_identity_admin_transition_check',
      sql`${table.subjectVersion} = ${table.expectedPreviousVersion} + 1 and ${table.subjectVersion} between 1 and 2147483647 and ${table.expectedPreviousVersion} between 0 and 2147483646 and ((${table.operation} = 'register' and ${table.expectedPreviousVersion} = 0 and ${table.status} = 'active') or (${table.operation} = 'enable' and ${table.expectedPreviousVersion} > 0 and ${table.status} = 'active') or (${table.operation} = 'disable' and ${table.expectedPreviousVersion} > 0 and ${table.status} = 'disabled'))`,
    ),
    check(
      'ql3_identity_admin_actor_check',
      sql`${table.changedByType} = 'user' and length(${table.changedById}) between 1 and 255`,
    ),
    check(
      'ql3_identity_admin_audit_check',
      sql`${table.auditEventId} = ${table.mutationId}`,
    ),
    check(
      'ql3_identity_admin_time_check',
      sql`${table.identityCreatedAtMs} >= 0 and ${table.createdAtMs} >= ${table.identityCreatedAtMs}`,
    ),
    foreignKey({
      columns: [table.subjectType, table.subjectId],
      foreignColumns: [
        localIdentitySubjects.subjectType,
        localIdentitySubjects.subjectId,
      ],
      name: 'ql3_identity_admin_subject_fk',
    }).onDelete('restrict'),
    index('ql3_identity_admin_subject_idx').on(
      table.subjectType,
      table.subjectId,
      sql`${table.subjectVersion} desc`,
    ),
  ],
);

export const localApiCredentialAdministrationMutations = sqliteTable(
  'QingLong3ApiCredentialAdministrationMutations',
  {
    mutationId: text('mutation_id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    operation: text('operation').notNull(),
    credentialId: text('credential_id').notNull(),
    credentialVersion: integer('credential_version').notNull(),
    expectedPreviousVersion: integer('expected_previous_version').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    subjectStatus: text('subject_status').notNull(),
    state: text('state').notNull(),
    pepperKeyId: text('pepper_key_id').notNull(),
    secretDigest: text('secret_digest').notNull(),
    notBeforeAtMs: integer('not_before_at_ms').notNull(),
    expiresAtMs: integer('expires_at_ms').notNull(),
    deliveryDigest: text('delivery_digest'),
    changedByType: text('changed_by_type').notNull(),
    changedById: text('changed_by_id').notNull(),
    auditEventId: text('audit_event_id')
      .notNull()
      .unique()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
      }),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_credential_admin_mutation_id_check',
      sql`length(${table.mutationId}) = 36`,
    ),
    check(
      'ql3_credential_admin_operation_check',
      sql`${table.operation} in ('issue','rotate','revoke')`,
    ),
    check(
      'ql3_credential_admin_identity_check',
      sql`length(${table.credentialId}) between 1 and 64 and ${table.credentialId} not glob '*[^A-Za-z0-9._:-]*' and ${table.subjectType} in ('user','api_app','mcp_client','agent') and length(${table.subjectId}) between 1 and 255 and ${table.subjectStatus} in ('active','disabled')`,
    ),
    check(
      'ql3_credential_admin_transition_check',
      sql`${table.credentialVersion} = ${table.expectedPreviousVersion} + 1 and ${table.credentialVersion} between 1 and 2147483647 and ${table.expectedPreviousVersion} between 0 and 2147483646 and ((${table.operation} = 'issue' and ${table.expectedPreviousVersion} = 0 and ${table.state} = 'active') or (${table.operation} = 'rotate' and ${table.expectedPreviousVersion} > 0 and ${table.state} = 'active') or (${table.operation} = 'revoke' and ${table.expectedPreviousVersion} > 0 and ${table.state} = 'revoked'))`,
    ),
    check(
      'ql3_credential_admin_digest_check',
      sql`length(${table.pepperKeyId}) between 1 and 64 and ${table.pepperKeyId} not glob '*[^A-Za-z0-9._:-]*' and length(${table.secretDigest}) = 64 and ${table.secretDigest} not glob '*[^0-9a-f]*' and ((${table.operation} in ('issue','rotate') and length(${table.deliveryDigest}) = 64 and ${table.deliveryDigest} not glob '*[^0-9a-f]*') or (${table.operation} = 'revoke' and ${table.deliveryDigest} is null))`,
    ),
    check(
      'ql3_credential_admin_lifetime_check',
      sql`${table.createdAtMs} >= 0 and ${table.notBeforeAtMs} >= ${table.createdAtMs} and ${table.expiresAtMs} > ${table.notBeforeAtMs}`,
    ),
    check(
      'ql3_credential_admin_actor_check',
      sql`${table.changedByType} = 'user' and length(${table.changedById}) between 1 and 255`,
    ),
    check(
      'ql3_credential_admin_audit_check',
      sql`${table.auditEventId} = ${table.mutationId}`,
    ),
    foreignKey({
      columns: [table.credentialId, table.credentialVersion],
      foreignColumns: [
        localApiCredentials.credentialId,
        localApiCredentials.version,
      ],
      name: 'ql3_credential_admin_credential_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.credentialId, table.credentialVersion, table.pepperKeyId],
      foreignColumns: [
        localApiCredentialPepperBindings.credentialId,
        localApiCredentialPepperBindings.credentialVersion,
        localApiCredentialPepperBindings.pepperKeyId,
      ],
      name: 'ql3_credential_admin_pepper_binding_fk',
    }).onDelete('restrict'),
    index('ql3_credential_admin_credential_idx').on(
      table.credentialId,
      sql`${table.credentialVersion} desc`,
    ),
    index('ql3_credential_admin_subject_idx').on(
      table.subjectType,
      table.subjectId,
      sql`${table.createdAtMs} desc`,
    ),
  ],
);

export const localApiCredentialDeliveryAcknowledgements = sqliteTable(
  'QingLong3ApiCredentialDeliveryAcknowledgements',
  {
    credentialMutationId: text('credential_mutation_id')
      .primaryKey()
      .references(() => localApiCredentialAdministrationMutations.mutationId, {
        onDelete: 'restrict',
      }),
    acknowledgementMutationId: text('acknowledgement_mutation_id')
      .notNull()
      .unique(),
    projectId: text('project_id')
      .notNull()
      .references(() => localProjects.id, { onDelete: 'restrict' }),
    deliveryDigest: text('delivery_digest').notNull(),
    acknowledgedByType: text('acknowledged_by_type').notNull(),
    acknowledgedById: text('acknowledged_by_id').notNull(),
    auditEventId: text('audit_event_id')
      .notNull()
      .unique()
      .references(() => localSecurityAuditEvents.eventId, {
        onDelete: 'restrict',
      }),
    acknowledgedAtMs: integer('acknowledged_at_ms').notNull(),
  },
  (table) => [
    check(
      'ql3_credential_delivery_ack_identity_check',
      sql`length(${table.credentialMutationId}) = 36 and length(${table.acknowledgementMutationId}) = 36 and ${table.credentialMutationId} <> ${table.acknowledgementMutationId}`,
    ),
    check(
      'ql3_credential_delivery_ack_digest_check',
      sql`length(${table.deliveryDigest}) = 64 and ${table.deliveryDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_credential_delivery_ack_actor_check',
      sql`${table.acknowledgedByType} = 'user' and length(${table.acknowledgedById}) between 1 and 255`,
    ),
    check(
      'ql3_credential_delivery_ack_audit_check',
      sql`${table.auditEventId} = ${table.acknowledgementMutationId}`,
    ),
    check(
      'ql3_credential_delivery_ack_time_check',
      sql`${table.acknowledgedAtMs} >= 0`,
    ),
    index('ql3_credential_delivery_ack_project_idx').on(
      table.projectId,
      sql`${table.acknowledgedAtMs} desc`,
    ),
  ],
);

export const pluginPackageLifecycleEvents = sqliteTable(
  'QingLong3PluginPackageLifecycleEvents',
  {
    eventDigest: text('event_digest').primaryKey(),
    mutationId: text('mutation_id').notNull(),
    dispatchId: text('dispatch_id').notNull(),
    approvedActionType: text('approved_action_type').notNull(),
    action: text('action').notNull(),
    projectId: text('project_id').notNull(),
    packageName: text('package_name').notNull(),
    installationId: text('installation_id').notNull(),
    lockDigest: text('lock_digest').notNull(),
    installVersion: integer('install_version').notNull(),
    installRecordDigest: text('install_record_digest').notNull(),
    expectedVersion: integer('expected_version').notNull(),
    expectedDisposition: text('expected_disposition').notNull(),
    expectedEventDigest: text('expected_event_digest').references(
      (): AnySQLiteColumn => pluginPackageLifecycleEvents.eventDigest,
      { onDelete: 'restrict' },
    ),
    generationDigest: text('generation_digest').notNull(),
    materializedRevisionDigest: text('materialized_revision_digest').notNull(),
    currentToolSnapshotDigest: text('current_tool_snapshot_digest').notNull(),
    referenceGraphDigest: text('reference_graph_digest').notNull(),
    impactDigest: text('impact_digest').notNull(),
    actionDigest: text('action_digest').notNull(),
    requestedByType: text('requested_by_type').notNull(),
    requestedById: text('requested_by_id').notNull(),
    approvedByType: text('approved_by_type').notNull(),
    approvedById: text('approved_by_id').notNull(),
    authorizationMode: text('authorization_mode').notNull(),
    occurredAtMs: integer('occurred_at_ms').notNull(),
    eventJson: text('event_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    uniqueIndex('ql3_plugin_package_lifecycle_mutation_uidx').on(
      table.mutationId,
    ),
    uniqueIndex('ql3_plugin_package_lifecycle_dispatch_uidx').on(
      table.dispatchId,
    ),
    uniqueIndex('ql3_plugin_package_lifecycle_target_version_uidx').on(
      table.projectId,
      table.packageName,
      table.installationId,
      table.lockDigest,
      table.expectedVersion,
    ),
    foreignKey({
      columns: [
        table.projectId,
        table.packageName,
        table.installationId,
        table.lockDigest,
        table.installRecordDigest,
      ],
      foreignColumns: [
        pluginPackageInstalls.projectId,
        pluginPackageInstalls.packageName,
        pluginPackageInstalls.installationId,
        pluginPackageInstalls.lockDigest,
        pluginPackageInstalls.recordDigest,
      ],
      name: 'ql3_plugin_package_lifecycle_install_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [
        table.dispatchId,
        table.projectId,
        table.approvedActionType,
        table.actionDigest,
        table.impactDigest,
      ],
      foreignColumns: [
        approvedActionDispatches.dispatchId,
        approvedActionDispatches.projectId,
        approvedActionDispatches.actionType,
        approvedActionDispatches.actionDigest,
        approvedActionDispatches.previewDigest,
      ],
      name: 'ql3_plugin_package_lifecycle_dispatch_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'ql3_plugin_package_lifecycle_identity_check',
      sql`length(${table.mutationId}) between 1 and 128 and length(${table.dispatchId}) between 1 and 128 and length(${table.packageName}) between 1 and 63 and length(${table.installationId}) between 1 and 128 and ${table.installVersion} between 1 and 2147483647 and ${table.action} in ('disable','enable','uninstall') and ${table.approvedActionType} = 'plugin_package.lifecycle.' || ${table.action}`,
    ),
    check(
      'ql3_plugin_package_lifecycle_expectation_check',
      sql`(${table.action} = 'disable' and ${table.expectedDisposition} = 'active') or (${table.action} in ('enable','uninstall') and ${table.expectedDisposition} = 'disabled')`,
    ),
    check(
      'ql3_plugin_package_lifecycle_origin_check',
      sql`(${table.expectedVersion} = 0 and ${table.expectedDisposition} = 'active' and ${table.expectedEventDigest} is null) or (${table.expectedVersion} between 1 and 2147483646 and ${table.expectedEventDigest} is not null)`,
    ),
    check(
      'ql3_plugin_package_lifecycle_subject_check',
      sql`${table.requestedByType} = 'user' and ${table.approvedByType} = 'user' and length(${table.requestedById}) between 1 and 255 and length(${table.approvedById}) between 1 and 255 and ${table.authorizationMode} in ('human_confirmation','separation_of_duty') and ((${table.authorizationMode} = 'human_confirmation' and ${table.requestedById} = ${table.approvedById}) or (${table.authorizationMode} = 'separation_of_duty' and ${table.requestedById} <> ${table.approvedById}))`,
    ),
    check(
      'ql3_plugin_package_lifecycle_digest_check',
      sql`length(${table.eventDigest}) = 64 and ${table.eventDigest} not glob '*[^0-9a-f]*' and length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and length(${table.installRecordDigest}) = 64 and ${table.installRecordDigest} not glob '*[^0-9a-f]*' and length(${table.generationDigest}) = 64 and ${table.generationDigest} not glob '*[^0-9a-f]*' and length(${table.materializedRevisionDigest}) = 64 and ${table.materializedRevisionDigest} not glob '*[^0-9a-f]*' and length(${table.currentToolSnapshotDigest}) = 64 and ${table.currentToolSnapshotDigest} not glob '*[^0-9a-f]*' and length(${table.referenceGraphDigest}) = 64 and ${table.referenceGraphDigest} not glob '*[^0-9a-f]*' and length(${table.impactDigest}) = 64 and ${table.impactDigest} not glob '*[^0-9a-f]*' and length(${table.actionDigest}) = 64 and ${table.actionDigest} not glob '*[^0-9a-f]*' and (${table.expectedEventDigest} is null or (length(${table.expectedEventDigest}) = 64 and ${table.expectedEventDigest} not glob '*[^0-9a-f]*'))`,
    ),
    check(
      'ql3_plugin_package_lifecycle_json_check',
      sql`length(${table.eventJson}) between 2 and 524288 and json_valid(${table.eventJson}) and json_type(${table.eventJson}) = 'object' and json_extract(${table.eventJson}, '$.schema') = 'qinglong/plugin-package-lifecycle-event@v1' and json_extract(${table.eventJson}, '$.mutationId') = ${table.mutationId} and json_extract(${table.eventJson}, '$.dispatchId') = ${table.dispatchId} and json_extract(${table.eventJson}, '$.impact.schema') = 'qinglong/plugin-package-lifecycle-impact@v1' and json_extract(${table.eventJson}, '$.impact.action') = ${table.action} and json_extract(${table.eventJson}, '$.impact.target.projectId') = ${table.projectId} and json_extract(${table.eventJson}, '$.impact.target.packageName') = ${table.packageName} and json_extract(${table.eventJson}, '$.impact.target.installationId') = ${table.installationId} and json_extract(${table.eventJson}, '$.impact.target.lockDigest') = ${table.lockDigest} and json_extract(${table.eventJson}, '$.impact.target.installVersion') = ${table.installVersion} and json_extract(${table.eventJson}, '$.impact.target.installRecordDigest') = ${table.installRecordDigest} and json_extract(${table.eventJson}, '$.impact.expected.version') = ${table.expectedVersion} and json_extract(${table.eventJson}, '$.impact.expected.disposition') = ${table.expectedDisposition} and ((${table.expectedEventDigest} is null and json_type(${table.eventJson}, '$.impact.expected.eventDigest') = 'null') or json_extract(${table.eventJson}, '$.impact.expected.eventDigest') = ${table.expectedEventDigest}) and json_extract(${table.eventJson}, '$.impact.generationDigest') = ${table.generationDigest} and json_extract(${table.eventJson}, '$.impact.materializedRevisionDigest') = ${table.materializedRevisionDigest} and json_extract(${table.eventJson}, '$.impact.currentToolSnapshotDigest') = ${table.currentToolSnapshotDigest} and json_extract(${table.eventJson}, '$.impact.referenceGraphDigest') = ${table.referenceGraphDigest} and json_extract(${table.eventJson}, '$.impact.impactDigest') = ${table.impactDigest} and json_extract(${table.eventJson}, '$.actionDigest') = ${table.actionDigest} and json_extract(${table.eventJson}, '$.requestedBy.type') = ${table.requestedByType} and json_extract(${table.eventJson}, '$.requestedBy.id') = ${table.requestedById} and json_extract(${table.eventJson}, '$.approvedBy.type') = ${table.approvedByType} and json_extract(${table.eventJson}, '$.approvedBy.id') = ${table.approvedById} and json_extract(${table.eventJson}, '$.authorizationMode') = ${table.authorizationMode} and json_extract(${table.eventJson}, '$.occurredAtMs') = ${table.occurredAtMs} and json_extract(${table.eventJson}, '$.eventDigest') = ${table.eventDigest}`,
    ),
    check(
      'ql3_plugin_package_lifecycle_time_check',
      sql`${table.occurredAtMs} >= 0`,
    ),
    index('ql3_plugin_package_lifecycle_project_idx').on(
      table.projectId,
      table.packageName,
      table.occurredAtMs,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageLifecycleHeads = sqliteTable(
  'QingLong3PluginPackageLifecycleHeads',
  {
    projectId: text('project_id').notNull(),
    packageName: text('package_name').notNull(),
    installationId: text('installation_id').notNull(),
    lockDigest: text('lock_digest').notNull(),
    installRecordDigest: text('install_record_digest').notNull(),
    version: integer('version').notNull(),
    disposition: text('disposition').notNull(),
    eventDigest: text('event_digest')
      .notNull()
      .references(() => pluginPackageLifecycleEvents.eventDigest, {
        onDelete: 'restrict',
      }),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.packageName] }),
    uniqueIndex('ql3_plugin_package_lifecycle_head_event_uidx').on(
      table.eventDigest,
    ),
    foreignKey({
      columns: [
        table.projectId,
        table.packageName,
        table.installationId,
        table.lockDigest,
        table.installRecordDigest,
      ],
      foreignColumns: [
        pluginPackageInstalls.projectId,
        pluginPackageInstalls.packageName,
        pluginPackageInstalls.installationId,
        pluginPackageInstalls.lockDigest,
        pluginPackageInstalls.recordDigest,
      ],
      name: 'ql3_plugin_package_lifecycle_head_install_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'ql3_plugin_package_lifecycle_head_state_check',
      sql`${table.version} between 1 and 2147483647 and ${table.disposition} in ('active','disabled','uninstalled') and ${table.updatedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_lifecycle_head_digest_check',
      sql`length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and length(${table.installRecordDigest}) = 64 and ${table.installRecordDigest} not glob '*[^0-9a-f]*' and length(${table.eventDigest}) = 64 and ${table.eventDigest} not glob '*[^0-9a-f]*'`,
    ),
  ],
);

export const pluginPackageLifecycleReceipts = sqliteTable(
  'QingLong3PluginPackageLifecycleReceipts',
  {
    eventDigest: text('event_digest')
      .primaryKey()
      .references(() => pluginPackageLifecycleEvents.eventDigest, {
        onDelete: 'restrict',
      }),
    receiptDigest: text('receipt_digest').notNull(),
    projectId: text('project_id').notNull(),
    action: text('action').notNull(),
    capabilityStatus: text('capability_status').notNull(),
    taskCount: integer('task_count').notNull(),
    previousActiveVectorDigest: text('previous_active_vector_digest').notNull(),
    currentActiveVectorDigest: text('current_active_vector_digest').notNull(),
    currentToolSnapshotDigest: text('current_tool_snapshot_digest').notNull(),
    retainedSourceCount: integer('retained_source_count').notNull(),
    committedAtMs: integer('committed_at_ms').notNull(),
    receiptJson: text('receipt_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    uniqueIndex('ql3_plugin_package_lifecycle_receipt_uidx').on(
      table.receiptDigest,
    ),
    foreignKey({
      columns: [
        table.projectId,
        table.currentActiveVectorDigest,
        table.currentToolSnapshotDigest,
      ],
      foreignColumns: [
        projectToolDefinitionSnapshots.projectId,
        projectToolDefinitionSnapshots.activeVectorDigest,
        projectToolDefinitionSnapshots.snapshotDigest,
      ],
      name: 'ql3_plugin_package_lifecycle_receipt_snapshot_fk',
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_lifecycle_receipt_state_check',
      sql`(${table.action} = 'disable' and ${table.capabilityStatus} = 'withdrawn' and ${table.previousActiveVectorDigest} <> ${table.currentActiveVectorDigest}) or (${table.action} = 'enable' and ${table.capabilityStatus} = 'restored' and ${table.previousActiveVectorDigest} <> ${table.currentActiveVectorDigest}) or (${table.action} = 'uninstall' and ${table.capabilityStatus} = 'retired' and ${table.taskCount} = 0 and ${table.previousActiveVectorDigest} = ${table.currentActiveVectorDigest})`,
    ),
    check(
      'ql3_plugin_package_lifecycle_receipt_bounds_check',
      sql`${table.taskCount} between 0 and 128 and ${table.retainedSourceCount} between 0 and 128 and ${table.committedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_lifecycle_receipt_digest_check',
      sql`length(${table.receiptDigest}) = 64 and ${table.receiptDigest} not glob '*[^0-9a-f]*' and length(${table.previousActiveVectorDigest}) = 64 and ${table.previousActiveVectorDigest} not glob '*[^0-9a-f]*' and length(${table.currentActiveVectorDigest}) = 64 and ${table.currentActiveVectorDigest} not glob '*[^0-9a-f]*' and length(${table.currentToolSnapshotDigest}) = 64 and ${table.currentToolSnapshotDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_lifecycle_receipt_json_check',
      sql`length(${table.receiptJson}) between 2 and 524288 and json_valid(${table.receiptJson}) and json_type(${table.receiptJson}) = 'object' and json_extract(${table.receiptJson}, '$.schema') = 'qinglong/plugin-package-lifecycle-receipt@v1' and json_extract(${table.receiptJson}, '$.eventDigest') = ${table.eventDigest} and json_extract(${table.receiptJson}, '$.action') = ${table.action} and json_extract(${table.receiptJson}, '$.target.projectId') = ${table.projectId} and json_extract(${table.receiptJson}, '$.capability.status') = ${table.capabilityStatus} and json_array_length(json_extract(${table.receiptJson}, '$.capability.taskTransitions')) = ${table.taskCount} and json_extract(${table.receiptJson}, '$.capability.previousActiveVectorDigest') = ${table.previousActiveVectorDigest} and json_extract(${table.receiptJson}, '$.capability.currentActiveVectorDigest') = ${table.currentActiveVectorDigest} and json_extract(${table.receiptJson}, '$.capability.currentToolSnapshotDigest') = ${table.currentToolSnapshotDigest} and json_extract(${table.receiptJson}, '$.capability.retainedSourceCount') = ${table.retainedSourceCount} and json_extract(${table.receiptJson}, '$.committedAtMs') = ${table.committedAtMs} and json_extract(${table.receiptJson}, '$.receiptDigest') = ${table.receiptDigest}`,
    ),
    index('ql3_plugin_package_lifecycle_receipt_snapshot_idx').on(
      table.projectId,
      table.currentActiveVectorDigest,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageLifecycleTasks = sqliteTable(
  'QingLong3PluginPackageLifecycleTasks',
  {
    eventDigest: text('event_digest')
      .notNull()
      .references(() => pluginPackageLifecycleReceipts.eventDigest, {
        onDelete: 'restrict',
      }),
    projectId: text('project_id').notNull(),
    taskId: text('task_id').notNull(),
    previousRevision: integer('previous_revision').notNull(),
    currentRevision: integer('current_revision').notNull(),
    previousContentDigest: text('previous_content_digest').notNull(),
    currentContentDigest: text('current_content_digest').notNull(),
    previousEnabled: integer('previous_enabled').notNull(),
    currentEnabled: integer('current_enabled').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventDigest, table.taskId] }),
    foreignKey({
      columns: [table.projectId, table.taskId, table.previousRevision],
      foreignColumns: [
        taskDefinitionRevisions.projectId,
        taskDefinitionRevisions.taskId,
        taskDefinitionRevisions.revision,
      ],
      name: 'ql3_plugin_package_lifecycle_task_previous_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.projectId, table.taskId, table.currentRevision],
      foreignColumns: [
        taskDefinitionRevisions.projectId,
        taskDefinitionRevisions.taskId,
        taskDefinitionRevisions.revision,
      ],
      name: 'ql3_plugin_package_lifecycle_task_current_fk',
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_lifecycle_task_transition_check',
      sql`${table.currentRevision} = ${table.previousRevision} + 1 and ${table.previousEnabled} in (0, 1) and ${table.currentEnabled} in (0, 1) and ${table.previousEnabled} <> ${table.currentEnabled}`,
    ),
    check(
      'ql3_plugin_package_lifecycle_task_digest_check',
      sql`length(${table.previousContentDigest}) = 64 and ${table.previousContentDigest} not glob '*[^0-9a-f]*' and length(${table.currentContentDigest}) = 64 and ${table.currentContentDigest} not glob '*[^0-9a-f]*'`,
    ),
    index('ql3_plugin_package_lifecycle_task_idx').on(
      table.projectId,
      table.taskId,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageAutomationDispositionEvents = sqliteTable(
  'QingLong3PluginPackageAutomationDispositionEvents',
  {
    eventDigest: text('event_digest').primaryKey(),
    eventKind: text('event_kind').notNull(),
  },
  (table) => [
    check(
      'ql3_plugin_package_automation_disposition_kind_check',
      sql`${table.eventKind} in ('lifecycle','quarantine')`,
    ),
    check(
      'ql3_plugin_package_automation_disposition_digest_check',
      sql`length(${table.eventDigest}) = 64 and ${table.eventDigest} not glob '*[^0-9a-f]*'`,
    ),
  ],
);

export const pluginPackageAutomationPublications = sqliteTable(
  'QingLong3PluginPackageAutomationPublications',
  {
    publicationDigest: text('publication_digest').primaryKey(),
    projectId: text('project_id').notNull(),
    packageName: text('package_name').notNull(),
    installationId: text('installation_id').notNull(),
    lockDigest: text('lock_digest').notNull(),
    generation: integer('generation').notNull(),
    generationDigest: text('generation_digest')
      .notNull()
      .references(() => pluginPackageMaterializedRevisions.generationDigest, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    materializedRevisionDigest: text('materialized_revision_digest').notNull(),
    state: text('state').notNull(),
    version: integer('version').notNull(),
    previousPublicationDigest: text('previous_publication_digest').references(
      (): AnySQLiteColumn =>
        pluginPackageAutomationPublications.publicationDigest,
      { onDelete: 'restrict', onUpdate: 'restrict' },
    ),
    lifecycleEventDigest: text('lifecycle_event_digest').references(
      () => pluginPackageAutomationDispositionEvents.eventDigest,
      { onDelete: 'restrict', onUpdate: 'restrict' },
    ),
    publishedAtMs: integer('published_at_ms').notNull(),
    publicationJson: text('publication_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    uniqueIndex('ql3_plugin_package_automation_publication_version_uidx').on(
      table.projectId,
      table.packageName,
      table.version,
    ),
    uniqueIndex('ql3_plugin_package_automation_publication_previous_uidx')
      .on(table.previousPublicationDigest)
      .where(sql`${table.previousPublicationDigest} is not null`),
    index('ql3_plugin_package_automation_publication_generation_idx').on(
      table.generationDigest,
      table.publicationDigest,
    ),
    check(
      'ql3_plugin_package_automation_publication_identity_check',
      sql`length(${table.projectId}) between 1 and 128 and length(${table.packageName}) between 1 and 63 and length(${table.installationId}) between 1 and 128 and ${table.generation} between 1 and 2147483647 and ${table.state} in ('active','withdrawn','absent') and ${table.version} between 1 and 2147483647 and ${table.publishedAtMs} >= 0 and ((${table.version} = 1 and ${table.state} in ('active','absent') and ${table.previousPublicationDigest} is null and ${table.lifecycleEventDigest} is null) or (${table.version} > 1 and ${table.previousPublicationDigest} is not null)) and (${table.state} <> 'withdrawn' or ${table.lifecycleEventDigest} is not null)`,
    ),
    check(
      'ql3_plugin_package_automation_publication_digest_check',
      sql`length(${table.publicationDigest}) = 64 and ${table.publicationDigest} not glob '*[^0-9a-f]*' and length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and length(${table.generationDigest}) = 64 and ${table.generationDigest} not glob '*[^0-9a-f]*' and length(${table.materializedRevisionDigest}) = 64 and ${table.materializedRevisionDigest} not glob '*[^0-9a-f]*' and (${table.previousPublicationDigest} is null or (length(${table.previousPublicationDigest}) = 64 and ${table.previousPublicationDigest} not glob '*[^0-9a-f]*')) and (${table.lifecycleEventDigest} is null or (length(${table.lifecycleEventDigest}) = 64 and ${table.lifecycleEventDigest} not glob '*[^0-9a-f]*'))`,
    ),
    check(
      'ql3_plugin_package_automation_publication_json_check',
      sql`length(cast(${table.publicationJson} as blob)) between 2 and 12582912 and json_valid(${table.publicationJson}) and json_type(${table.publicationJson}) = 'object' and json_extract(${table.publicationJson}, '$.schema') = 'qinglong/plugin-package-automation-publication@v1' and json_extract(${table.publicationJson}, '$.target.projectId') = ${table.projectId} and json_extract(${table.publicationJson}, '$.target.packageName') = ${table.packageName} and json_extract(${table.publicationJson}, '$.target.installationId') = ${table.installationId} and json_extract(${table.publicationJson}, '$.target.lockDigest') = ${table.lockDigest} and json_extract(${table.publicationJson}, '$.target.generation') = ${table.generation} and json_extract(${table.publicationJson}, '$.target.generationDigest') = ${table.generationDigest} and json_extract(${table.publicationJson}, '$.target.materializedRevisionDigest') = ${table.materializedRevisionDigest} and json_extract(${table.publicationJson}, '$.state') = ${table.state} and json_extract(${table.publicationJson}, '$.version') = ${table.version} and ((${table.previousPublicationDigest} is null and json_type(${table.publicationJson}, '$.previousPublicationDigest') = 'null') or json_extract(${table.publicationJson}, '$.previousPublicationDigest') = ${table.previousPublicationDigest}) and ((${table.lifecycleEventDigest} is null and json_type(${table.publicationJson}, '$.lifecycleEventDigest') = 'null') or json_extract(${table.publicationJson}, '$.lifecycleEventDigest') = ${table.lifecycleEventDigest}) and json_extract(${table.publicationJson}, '$.publishedAtMs') = ${table.publishedAtMs} and json_extract(${table.publicationJson}, '$.publicationDigest') = ${table.publicationDigest} and json_type(${table.publicationJson}, '$.definitions.workflows') = 'array' and json_type(${table.publicationJson}, '$.definitions.prompts') = 'array' and ((${table.state} = 'absent' and json_array_length(json_extract(${table.publicationJson}, '$.definitions.workflows')) + json_array_length(json_extract(${table.publicationJson}, '$.definitions.prompts')) = 0) or (${table.state} <> 'absent' and json_array_length(json_extract(${table.publicationJson}, '$.definitions.workflows')) + json_array_length(json_extract(${table.publicationJson}, '$.definitions.prompts')) > 0))`,
    ),
  ],
);

export const pluginPackageAutomationPublicationHeads = sqliteTable(
  'QingLong3PluginPackageAutomationPublicationHeads',
  {
    projectId: text('project_id').notNull(),
    packageName: text('package_name').notNull(),
    publicationDigest: text('publication_digest')
      .notNull()
      .references(() => pluginPackageAutomationPublications.publicationDigest, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    generationDigest: text('generation_digest').notNull(),
    state: text('state').notNull(),
    version: integer('version').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.packageName] }),
    uniqueIndex(
      'ql3_plugin_package_automation_publication_head_digest_uidx',
    ).on(table.publicationDigest),
    check(
      'ql3_plugin_package_automation_publication_head_state_check',
      sql`length(${table.projectId}) between 1 and 128 and length(${table.packageName}) between 1 and 63 and length(${table.publicationDigest}) = 64 and ${table.publicationDigest} not glob '*[^0-9a-f]*' and length(${table.generationDigest}) = 64 and ${table.generationDigest} not glob '*[^0-9a-f]*' and ${table.state} in ('active','withdrawn','absent') and ${table.version} between 1 and 2147483647 and ${table.updatedAtMs} >= 0`,
    ),
  ],
);

export const pluginPackageWorkflowAdmissions = sqliteTable(
  'QingLong3PluginPackageWorkflowAdmissions',
  {
    planDigest: text('plan_digest').primaryKey(),
    planId: text('plan_id').notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    projectId: text('project_id').notNull(),
    packageName: text('package_name').notNull(),
    installationId: text('installation_id').notNull(),
    lockDigest: text('lock_digest').notNull(),
    generation: integer('generation').notNull(),
    generationDigest: text('generation_digest').notNull(),
    materializedRevisionDigest: text('materialized_revision_digest').notNull(),
    publicationDigest: text('publication_digest')
      .notNull()
      .references(() => pluginPackageAutomationPublications.publicationDigest, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    workflowId: text('workflow_id').notNull(),
    workflowDefinitionDigest: text('workflow_definition_digest').notNull(),
    stepCount: integer('step_count').notNull(),
    admittedAtMs: integer('admitted_at_ms').notNull(),
    finalRunVersion: integer('final_run_version').notNull(),
    finalRunEventSequence: integer('final_run_event_sequence').notNull(),
    receiptDigest: text('receipt_digest').notNull(),
    planJson: text('plan_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    receiptJson: text('receipt_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    uniqueIndex('ql3_plugin_package_workflow_admission_plan_uidx').on(
      table.planId,
    ),
    uniqueIndex('ql3_plugin_package_workflow_admission_run_uidx').on(
      table.runId,
    ),
    uniqueIndex('ql3_plugin_package_workflow_admission_receipt_uidx').on(
      table.receiptDigest,
    ),
    uniqueIndex('ql3_plugin_package_workflow_admission_plan_run_uidx').on(
      table.planDigest,
      table.runId,
    ),
    index('ql3_plugin_package_workflow_admission_target_idx').on(
      table.projectId,
      table.packageName,
      table.admittedAtMs,
      table.planDigest,
    ),
    index('ql3_plugin_package_workflow_admission_workflow_history_idx').on(
      table.projectId,
      table.packageName,
      table.workflowId,
      table.admittedAtMs,
      table.runId,
    ),
    check(
      'ql3_plugin_package_workflow_admission_identity_check',
      sql`length(${table.planId}) between 1 and 128 and length(${table.runId}) between 1 and 128 and length(${table.projectId}) between 1 and 128 and length(${table.packageName}) between 1 and 63 and length(${table.installationId}) between 1 and 128 and length(${table.workflowId}) between 1 and 63 and ${table.generation} between 1 and 2147483647 and ${table.stepCount} between 1 and 128 and ${table.admittedAtMs} >= 0 and ${table.finalRunVersion} = ${table.stepCount} + 1 and ${table.finalRunEventSequence} = ${table.stepCount} + 1`,
    ),
    check(
      'ql3_plugin_package_workflow_admission_digest_check',
      sql`length(${table.planDigest}) = 64 and ${table.planDigest} not glob '*[^0-9a-f]*' and length(${table.lockDigest}) = 64 and ${table.lockDigest} not glob '*[^0-9a-f]*' and length(${table.generationDigest}) = 64 and ${table.generationDigest} not glob '*[^0-9a-f]*' and length(${table.materializedRevisionDigest}) = 64 and ${table.materializedRevisionDigest} not glob '*[^0-9a-f]*' and length(${table.publicationDigest}) = 64 and ${table.publicationDigest} not glob '*[^0-9a-f]*' and length(${table.workflowDefinitionDigest}) = 64 and ${table.workflowDefinitionDigest} not glob '*[^0-9a-f]*' and length(${table.receiptDigest}) = 64 and ${table.receiptDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_workflow_admission_plan_json_check',
      sql`length(cast(${table.planJson} as blob)) between 2 and 262144 and json_valid(${table.planJson}) and json_type(${table.planJson}) = 'object' and json_extract(${table.planJson}, '$.schema') = 'qinglong/plugin-package-workflow-execution-plan@v1' and json_extract(${table.planJson}, '$.planId') = ${table.planId} and json_extract(${table.planJson}, '$.planDigest') = ${table.planDigest} and json_extract(${table.planJson}, '$.runId') = ${table.runId} and json_extract(${table.planJson}, '$.target.projectId') = ${table.projectId} and json_extract(${table.planJson}, '$.target.packageName') = ${table.packageName} and json_extract(${table.planJson}, '$.target.installationId') = ${table.installationId} and json_extract(${table.planJson}, '$.target.lockDigest') = ${table.lockDigest} and json_extract(${table.planJson}, '$.target.generation') = ${table.generation} and json_extract(${table.planJson}, '$.target.generationDigest') = ${table.generationDigest} and json_extract(${table.planJson}, '$.target.materializedRevisionDigest') = ${table.materializedRevisionDigest} and json_extract(${table.planJson}, '$.target.publicationDigest') = ${table.publicationDigest} and json_extract(${table.planJson}, '$.target.workflowId') = ${table.workflowId} and json_extract(${table.planJson}, '$.target.workflowDefinitionDigest') = ${table.workflowDefinitionDigest} and json_extract(${table.planJson}, '$.plannedAtMs') = ${table.admittedAtMs} and json_array_length(json_extract(${table.planJson}, '$.steps')) = ${table.stepCount}`,
    ),
    check(
      'ql3_plugin_package_workflow_admission_receipt_json_check',
      sql`length(cast(${table.receiptJson} as blob)) between 2 and 262144 and json_valid(${table.receiptJson}) and json_type(${table.receiptJson}) = 'object' and json_extract(${table.receiptJson}, '$.schema') = 'qinglong/plugin-package-workflow-admission-receipt@v1' and json_extract(${table.receiptJson}, '$.planId') = ${table.planId} and json_extract(${table.receiptJson}, '$.planDigest') = ${table.planDigest} and json_extract(${table.receiptJson}, '$.runId') = ${table.runId} and json_extract(${table.receiptJson}, '$.publicationDigest') = ${table.publicationDigest} and json_extract(${table.receiptJson}, '$.workflowId') = ${table.workflowId} and json_extract(${table.receiptJson}, '$.admittedAtMs') = ${table.admittedAtMs} and json_extract(${table.receiptJson}, '$.finalRunVersion') = ${table.finalRunVersion} and json_extract(${table.receiptJson}, '$.finalRunEventSequence') = ${table.finalRunEventSequence} and json_extract(${table.receiptJson}, '$.receiptDigest') = ${table.receiptDigest} and json_array_length(json_extract(${table.receiptJson}, '$.steps')) = ${table.stepCount}`,
    ),
  ],
);

export const pluginPackageWorkflowAdmissionSteps = sqliteTable(
  'QingLong3PluginPackageWorkflowAdmissionSteps',
  {
    planDigest: text('plan_digest').notNull(),
    runId: text('run_id').notNull(),
    stepKey: text('step_key').notNull(),
    stepRunId: text('step_run_id').notNull(),
    taskId: text('task_id').notNull(),
    taskDefinitionRef: text('task_definition_ref').notNull(),
    taskDefinitionDigest: text('task_definition_digest').notNull(),
    needsJson: text('needs_json', { mode: 'json' })
      .$type<readonly string[]>()
      .notNull(),
    initialStatus: text('initial_status').notNull(),
    mutationId: text('mutation_id')
      .notNull()
      .references(() => stepRunMutations.mutationId, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    eventId: text('event_id')
      .notNull()
      .references(() => runEvents.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
  },
  (table) => [
    primaryKey({ columns: [table.planDigest, table.stepKey] }),
    foreignKey({
      columns: [table.planDigest, table.runId],
      foreignColumns: [
        pluginPackageWorkflowAdmissions.planDigest,
        pluginPackageWorkflowAdmissions.runId,
      ],
      name: 'ql3_plugin_package_workflow_admission_step_admission_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
      name: 'ql3_plugin_package_workflow_admission_step_run_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('ql3_plugin_package_workflow_admission_step_run_uidx').on(
      table.stepRunId,
    ),
    uniqueIndex('ql3_plugin_package_workflow_admission_step_mutation_uidx').on(
      table.mutationId,
    ),
    uniqueIndex('ql3_plugin_package_workflow_admission_step_event_uidx').on(
      table.eventId,
    ),
    index('ql3_plugin_package_workflow_admission_step_task_idx').on(
      table.taskId,
      table.taskDefinitionDigest,
      table.planDigest,
    ),
    check(
      'ql3_plugin_package_workflow_admission_step_identity_check',
      sql`length(${table.runId}) between 1 and 128 and length(${table.stepKey}) between 1 and 63 and length(${table.stepRunId}) between 1 and 128 and length(${table.taskId}) between 1 and 63 and length(cast(${table.taskDefinitionRef} as blob)) between 1 and 512 and length(${table.mutationId}) between 1 and 128 and length(${table.eventId}) between 1 and 128 and ${table.initialStatus} in ('pending','ready')`,
    ),
    check(
      'ql3_plugin_package_workflow_admission_step_digest_check',
      sql`length(${table.planDigest}) = 64 and ${table.planDigest} not glob '*[^0-9a-f]*' and length(${table.taskDefinitionDigest}) = 64 and ${table.taskDefinitionDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_workflow_admission_step_needs_check',
      sql`length(cast(${table.needsJson} as blob)) between 2 and 8192 and json_valid(${table.needsJson}) and json_type(${table.needsJson}) = 'array' and json_array_length(${table.needsJson}) between 0 and 127`,
    ),
  ],
);

export const pluginPackageWorkflowTaskAttemptAdmissions = sqliteTable(
  'QingLong3PluginPackageWorkflowTaskAttemptAdmissions',
  {
    receiptDigest: text('receipt_digest').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => runAttempts.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    planDigest: text('plan_digest').notNull(),
    runId: text('run_id').notNull(),
    stepRunId: text('step_run_id').notNull(),
    stepRunVersion: integer('step_run_version').notNull(),
    stepRunDigest: text('step_run_digest').notNull(),
    generationDigest: text('generation_digest').notNull(),
    resourceTaskId: text('resource_task_id').notNull(),
    taskReconciliationReceiptDigest: text(
      'task_reconciliation_receipt_digest',
    ).notNull(),
    projectId: text('project_id').notNull(),
    taskId: text('task_id').notNull(),
    taskRevision: text('task_revision').notNull(),
    taskDefinitionDigest: text('task_definition_digest').notNull(),
    executorType: text('executor_type').notNull(),
    executionDigest: text('execution_digest').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    eventId: text('event_id')
      .notNull()
      .references(() => runEvents.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    runVersion: integer('run_version').notNull(),
    runEventSequence: integer('run_event_sequence').notNull(),
    admittedAtMs: integer('admitted_at_ms').notNull(),
    receiptJson: text('receipt_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.planDigest, table.runId],
      foreignColumns: [
        pluginPackageWorkflowAdmissions.planDigest,
        pluginPackageWorkflowAdmissions.runId,
      ],
      name: 'ql3_plugin_package_workflow_task_attempt_admission_plan_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
      name: 'ql3_plugin_package_workflow_task_attempt_admission_step_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.generationDigest, table.taskReconciliationReceiptDigest],
      foreignColumns: [
        pluginPackageTaskReconciliations.generationDigest,
        pluginPackageTaskReconciliations.receiptDigest,
      ],
      name: 'ql3_plugin_package_workflow_task_attempt_admission_reconciliation_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.projectId, table.taskId, table.taskRevision],
      foreignColumns: [
        localTaskExecutionRevisions.projectId,
        localTaskExecutionRevisions.taskId,
        localTaskExecutionRevisions.taskRevision,
      ],
      name: 'ql3_plugin_package_workflow_task_attempt_admission_execution_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex(
      'ql3_plugin_package_workflow_task_attempt_admission_attempt_uidx',
    ).on(table.attemptId),
    uniqueIndex(
      'ql3_plugin_package_workflow_task_attempt_admission_event_uidx',
    ).on(table.eventId),
    uniqueIndex(
      'ql3_plugin_package_workflow_task_attempt_admission_epoch_uidx',
    ).on(table.runId, table.stepRunId, table.stepRunVersion),
    uniqueIndex(
      'ql3_plugin_package_workflow_task_attempt_admission_number_uidx',
    ).on(table.runId, table.attemptNumber),
    index(
      'ql3_plugin_package_workflow_task_attempt_admission_candidate_idx',
    ).on(table.runId, table.stepRunId, table.admittedAtMs),
    check(
      'ql3_plugin_package_workflow_task_attempt_admission_identity_check',
      sql`length(${table.attemptId}) between 1 and 128 and length(${table.runId}) between 1 and 128 and length(${table.stepRunId}) between 1 and 128 and length(${table.resourceTaskId}) between 1 and 128 and length(${table.projectId}) between 1 and 128 and length(${table.taskId}) between 1 and 128 and length(${table.taskRevision}) between 1 and 128 and length(${table.eventId}) between 1 and 128 and ${table.executorType} = 'local_process'`,
    ),
    check(
      'ql3_plugin_package_workflow_task_attempt_admission_counter_check',
      sql`${table.stepRunVersion} between 1 and 2147483647 and ${table.attemptNumber} between 1 and 8192 and ${table.runVersion} between 1 and 2147483647 and ${table.runEventSequence} = ${table.runVersion} and ${table.admittedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_workflow_task_attempt_admission_digest_check',
      sql`length(${table.receiptDigest}) = 64 and ${table.receiptDigest} not glob '*[^0-9a-f]*' and length(${table.planDigest}) = 64 and ${table.planDigest} not glob '*[^0-9a-f]*' and length(${table.stepRunDigest}) = 64 and ${table.stepRunDigest} not glob '*[^0-9a-f]*' and length(${table.generationDigest}) = 64 and ${table.generationDigest} not glob '*[^0-9a-f]*' and length(${table.taskReconciliationReceiptDigest}) = 64 and ${table.taskReconciliationReceiptDigest} not glob '*[^0-9a-f]*' and length(${table.taskDefinitionDigest}) = 64 and ${table.taskDefinitionDigest} not glob '*[^0-9a-f]*' and length(${table.executionDigest}) = 64 and ${table.executionDigest} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'ql3_plugin_package_workflow_task_attempt_admission_json_check',
      sql`length(cast(${table.receiptJson} as blob)) between 2 and 16384 and json_valid(${table.receiptJson}) and json_type(${table.receiptJson}) = 'object' and json_extract(${table.receiptJson}, '$.schema') = 'qinglong/plugin-package-workflow-task-attempt-admission@v1' and json_extract(${table.receiptJson}, '$.receiptDigest') = ${table.receiptDigest} and json_extract(${table.receiptJson}, '$.attemptId') = ${table.attemptId} and json_extract(${table.receiptJson}, '$.planDigest') = ${table.planDigest} and json_extract(${table.receiptJson}, '$.runId') = ${table.runId} and json_extract(${table.receiptJson}, '$.stepRunId') = ${table.stepRunId} and json_extract(${table.receiptJson}, '$.stepRunVersion') = ${table.stepRunVersion} and json_extract(${table.receiptJson}, '$.stepRunDigest') = ${table.stepRunDigest} and json_extract(${table.receiptJson}, '$.resourceTaskId') = ${table.resourceTaskId} and json_extract(${table.receiptJson}, '$.taskReconciliationReceiptDigest') = ${table.taskReconciliationReceiptDigest} and json_extract(${table.receiptJson}, '$.taskId') = ${table.taskId} and json_extract(${table.receiptJson}, '$.taskRevision') = ${table.taskRevision} and json_extract(${table.receiptJson}, '$.taskDefinitionDigest') = ${table.taskDefinitionDigest} and json_extract(${table.receiptJson}, '$.executorType') = ${table.executorType} and json_extract(${table.receiptJson}, '$.executionDigest') = ${table.executionDigest} and json_extract(${table.receiptJson}, '$.attemptNumber') = ${table.attemptNumber} and json_extract(${table.receiptJson}, '$.eventId') = ${table.eventId} and json_extract(${table.receiptJson}, '$.runVersion') = ${table.runVersion} and json_extract(${table.receiptJson}, '$.runEventSequence') = ${table.runEventSequence} and json_extract(${table.receiptJson}, '$.admittedAtMs') = ${table.admittedAtMs}`,
    ),
  ],
);

export const localSqliteSchema = Object.freeze({
  localSchemaMigrations,
  localSchemaCapabilities,
  runs,
  stepRuns,
  runAttempts,
  runEvents,
  stepRunMutations,
  runRetryPolicies,
  localCompletionReceiptJournal,
  runAttemptLogArtifactTombstones,
  runAttemptLogRetentionState,
  localExecutionContextRecipes,
  localTaskExecutionRevisions,
  localSecretEnvelopes,
  localProjects,
  approvalRequests,
  approvedActionDispatches,
  approvedActionExecutions,
  pluginPackageInstallProposals,
  pluginPackageInstalls,
  pluginPackageInstallHeads,
  pluginPackageInstallMutations,
  pluginPackageMaterializedRevisions,
  pluginPackageSecretBindings,
  pluginPackageSecretBindingTransitionReceipts,
  pluginPackageQuarantineEvents,
  pluginPackageWithdrawalReceipts,
  pluginPackageWithdrawalTasks,
  pluginPackageLifecycleEvents,
  pluginPackageLifecycleHeads,
  pluginPackageLifecycleReceipts,
  pluginPackageLifecycleTasks,
  pluginPackageAutomationDispositionEvents,
  pluginPackageAutomationPublications,
  pluginPackageAutomationPublicationHeads,
  pluginPackageWorkflowAdmissions,
  pluginPackageWorkflowAdmissionSteps,
  pluginPackageWorkflowTaskAttemptAdmissions,
  projectToolDefinitionSnapshots,
  projectToolDefinitionSnapshotSources,
  pluginPackageTaskOwnerships,
  pluginPackageTaskReconciliations,
  pluginPackageTaskReconciliationItems,
  pluginPackageAdmissionReceipts,
  taskDefinitions,
  taskDefinitionRevisions,
  triggers,
  triggerRevisions,
  localTriggerSchedules,
  localProjectRoleBindings,
  localSecurityAuditEvents,
  localProjectAdministrationMutations,
  localSecurityAuditCompactions,
  toolExecutionTraceAnchors,
  toolExecutionAuditReceipts,
  toolExecutionStartBarriers,
  toolInvocationInputArtifacts,
  toolInvocationPreviewArtifacts,
  toolExecutionStartArtifactBindings,
  toolExecutionCompletions,
  toolExecutionFailureCompletions,
  toolResultKeyCatalogGenerations,
  toolExecutionResultKeyBindings,
  toolExecutionResultRekeyOverlays,
  toolExecutionResultRekeyHeads,
  toolResultKeyRetirementReceipts,
  legacyAdoptions,
  legacyDataDirectoryAdoptions,
  legacyDataDirectoryAdoptionSecrets,
  localIdentitySubjects,
  localApiCredentials,
  localApiCredentialPepperBindings,
  localIdentityAdministrationMutations,
  localApiCredentialAdministrationMutations,
  localApiCredentialDeliveryAcknowledgements,
  localOwnerPepperKeys,
  localOwnerPepperActivations,
  localIdentityProvisionings,
  localOwnerBootstrapChallenges,
  localOwnerDeliveryAcknowledgements,
  localOwnerDeliveryAcknowledgementGc,
  localOwnerCredentialRecoveries,
  localOwnerPepperMaterialGc,
});

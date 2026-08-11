import {
  DataTypes,
  ForeignKeyConstraintError,
  Model,
  ModelStatic,
  Op,
  Sequelize,
  Transaction,
  TimeoutError,
  UniqueConstraintError,
  ValidationError,
} from 'sequelize';
import type {
  RunAttemptRecord,
  RunAttemptStatus,
  RunEventRecord,
  RunRecord,
} from '../../domain/run';
import {
  assertRunRetryPolicyRecord,
  type RunRetryPolicyRecord,
} from '../../domain/runRetryPolicy';
import {
  DuplicateIdempotencyKeyError,
  DuplicateRunAttemptError,
  DuplicateRunEventError,
  RunEventPayloadTooLargeError,
  RunRepositoryBusyError,
  RunRepositoryConstraintError,
  RunRepositoryError,
  RunRepositoryOperationError,
} from '../../domain/repositoryErrors';
import {
  MAX_CANCELLATION_RECOVERY_PAGE_SIZE,
  MAX_RUN_EVENT_PAGE_SIZE,
  MAX_RUN_EVENT_PAYLOAD_BYTES,
} from '../../ports/runRepository';
import type {
  RunRepository,
  RunRepositoryReader,
  RunRepositoryTransaction,
} from '../../ports/runRepository';
import type {
  ActiveLegacyShadowRunResult,
  LegacyShadowRunLocator,
} from '../../ports/legacyShadowRunLocator';
import { MAX_LEGACY_SHADOW_LOOKUP_CANDIDATES } from '../../ports/legacyShadowRunLocator';
import {
  RUN_ATTEMPT_TABLE,
  RUN_EVENT_TABLE,
  RUN_TABLE,
} from '../../../migrations/0002-run-schema';
import { RUN_RETRY_POLICY_TABLE } from '../../../migrations/0011-run-retry-policy';

type Nullable<T> = T | null;

interface RunRow {
  id: string;
  projectId: string;
  taskId: string;
  taskRevision: string;
  taskName: Nullable<string>;
  taskSnapshotRef: Nullable<string>;
  legacyCronId: Nullable<number>;
  parentRunId: Nullable<string>;
  retryOfRunId: Nullable<string>;
  triggerId: Nullable<string>;
  triggerType: string;
  executionOrigin: string;
  executionOwner: string;
  triggeredBy: Nullable<string>;
  requestId: Nullable<string>;
  scheduledForMs: Nullable<number>;
  status: string;
  version: number;
  eventSequence: number;
  priority: number;
  idempotencyKey: Nullable<string>;
  inputRef: Nullable<string>;
  outputRef: Nullable<string>;
  createdAtMs: number;
  queuedAtMs: Nullable<number>;
  startedAtMs: Nullable<number>;
  finishedAtMs: Nullable<number>;
  cancelRequestedAtMs: Nullable<number>;
  cancelReason: Nullable<string>;
  errorCode: Nullable<string>;
  errorSummary: Nullable<string>;
}

interface RunAttemptRow {
  id: string;
  runId: string;
  stepRunId: Nullable<string>;
  attempt: number;
  status: string;
  executorType: string;
  workerId: Nullable<string>;
  executorHandle: Nullable<string>;
  pid: Nullable<number>;
  logArtifactId: Nullable<string>;
  leaseToken: Nullable<string>;
  leaseExpiresAtMs: Nullable<number>;
  deadlineAtMs: Nullable<number>;
  callbackTokenHash: Nullable<string>;
  callbackSequence: number;
  createdAtMs: number;
  startedAtMs: Nullable<number>;
  finishedAtMs: Nullable<number>;
  exitCode: Nullable<number>;
  errorCode: Nullable<string>;
  errorSummary: Nullable<string>;
}

interface RunEventRow {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  dedupeKey: Nullable<string>;
  actorType: string;
  actorId: Nullable<string>;
  attemptId: Nullable<string>;
  stepRunId: Nullable<string>;
  payload: unknown;
  createdAtMs: number;
}

interface RunRetryPolicyRow {
  runId: string;
  maxAttempts: number;
  retryOnLost: boolean;
  safety: string;
  backoffBaseMs: number;
  backoffMaxMs: number;
  nextAttemptAtMs: Nullable<number>;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

interface RunInstance extends Model<RunRow, RunRow>, RunRow {}
interface RunAttemptInstance
  extends Model<RunAttemptRow, RunAttemptRow>,
    RunAttemptRow {}
interface RunEventInstance
  extends Model<RunEventRow, RunEventRow>,
    RunEventRow {}
interface RunRetryPolicyInstance
  extends Model<RunRetryPolicyRow, RunRetryPolicyRow>,
    RunRetryPolicyRow {}

export interface LegacyRunModels {
  run: ModelStatic<RunInstance>;
  attempt: ModelStatic<RunAttemptInstance>;
  event: ModelStatic<RunEventInstance>;
  retryPolicy: ModelStatic<RunRetryPolicyInstance>;
}

function defineLegacyRunModels(database: Sequelize): LegacyRunModels {
  const run = database.define<RunInstance>(
    'Ql3LegacyRun',
    {
      id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
      projectId: {
        field: 'project_id',
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      taskId: {
        field: 'task_id',
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      taskRevision: {
        field: 'task_revision',
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      taskName: {
        field: 'task_name',
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      taskSnapshotRef: {
        field: 'task_snapshot_ref',
        type: DataTypes.STRING(512),
        allowNull: true,
      },
      legacyCronId: {
        field: 'legacy_cron_id',
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      parentRunId: {
        field: 'parent_run_id',
        type: DataTypes.STRING(36),
        allowNull: true,
      },
      retryOfRunId: {
        field: 'retry_of_run_id',
        type: DataTypes.STRING(36),
        allowNull: true,
      },
      triggerId: {
        field: 'trigger_id',
        type: DataTypes.STRING(36),
        allowNull: true,
      },
      triggerType: {
        field: 'trigger_type',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      executionOrigin: {
        field: 'execution_origin',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      executionOwner: {
        field: 'execution_owner',
        type: DataTypes.STRING(16),
        allowNull: false,
      },
      triggeredBy: {
        field: 'triggered_by',
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      requestId: {
        field: 'request_id',
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      scheduledForMs: {
        field: 'scheduled_for_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      status: { type: DataTypes.STRING(32), allowNull: false },
      version: { type: DataTypes.INTEGER, allowNull: false },
      eventSequence: {
        field: 'event_sequence',
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      priority: { type: DataTypes.INTEGER, allowNull: false },
      idempotencyKey: {
        field: 'idempotency_key',
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      inputRef: {
        field: 'input_ref',
        type: DataTypes.STRING(512),
        allowNull: true,
      },
      outputRef: {
        field: 'output_ref',
        type: DataTypes.STRING(512),
        allowNull: true,
      },
      createdAtMs: {
        field: 'created_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      queuedAtMs: {
        field: 'queued_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      startedAtMs: {
        field: 'started_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      finishedAtMs: {
        field: 'finished_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      cancelRequestedAtMs: {
        field: 'cancel_requested_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      cancelReason: {
        field: 'cancel_reason',
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      errorCode: {
        field: 'error_code',
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      errorSummary: {
        field: 'error_summary',
        type: DataTypes.STRING(1024),
        allowNull: true,
      },
    },
    { tableName: RUN_TABLE, timestamps: false },
  );

  const attempt = database.define<RunAttemptInstance>(
    'Ql3LegacyRunAttempt',
    {
      id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
      runId: {
        field: 'run_id',
        type: DataTypes.STRING(36),
        allowNull: false,
      },
      stepRunId: {
        field: 'step_run_id',
        type: DataTypes.STRING(36),
        allowNull: true,
      },
      attempt: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.STRING(32), allowNull: false },
      executorType: {
        field: 'executor_type',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      workerId: {
        field: 'worker_id',
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      executorHandle: {
        field: 'executor_handle',
        type: DataTypes.TEXT,
        allowNull: true,
      },
      pid: { type: DataTypes.INTEGER, allowNull: true },
      logArtifactId: {
        field: 'log_artifact_id',
        type: DataTypes.STRING(36),
        allowNull: true,
      },
      leaseToken: {
        field: 'lease_token',
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      leaseExpiresAtMs: {
        field: 'lease_expires_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      deadlineAtMs: {
        field: 'deadline_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      callbackTokenHash: {
        field: 'callback_token_hash',
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      callbackSequence: {
        field: 'callback_sequence',
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      createdAtMs: {
        field: 'created_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      startedAtMs: {
        field: 'started_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      finishedAtMs: {
        field: 'finished_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      exitCode: {
        field: 'exit_code',
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      errorCode: {
        field: 'error_code',
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      errorSummary: {
        field: 'error_summary',
        type: DataTypes.STRING(1024),
        allowNull: true,
      },
    },
    { tableName: RUN_ATTEMPT_TABLE, timestamps: false },
  );

  const event = database.define<RunEventInstance>(
    'Ql3LegacyRunEvent',
    {
      id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
      runId: {
        field: 'run_id',
        type: DataTypes.STRING(36),
        allowNull: false,
      },
      sequence: { type: DataTypes.INTEGER, allowNull: false },
      type: { type: DataTypes.STRING(128), allowNull: false },
      dedupeKey: {
        field: 'dedupe_key',
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      actorType: {
        field: 'actor_type',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      actorId: {
        field: 'actor_id',
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      attemptId: {
        field: 'attempt_id',
        type: DataTypes.STRING(36),
        allowNull: true,
      },
      stepRunId: {
        field: 'step_run_id',
        type: DataTypes.STRING(36),
        allowNull: true,
      },
      payload: { type: DataTypes.JSON, allowNull: false },
      createdAtMs: {
        field: 'created_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    { tableName: RUN_EVENT_TABLE, timestamps: false },
  );

  const retryPolicy = database.define<RunRetryPolicyInstance>(
    'Ql3LegacyRunRetryPolicy',
    {
      runId: {
        field: 'run_id',
        type: DataTypes.STRING(36),
        allowNull: false,
        primaryKey: true,
      },
      maxAttempts: {
        field: 'max_attempts',
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      retryOnLost: {
        field: 'retry_on_lost',
        type: DataTypes.BOOLEAN,
        allowNull: false,
      },
      safety: { type: DataTypes.STRING(16), allowNull: false },
      backoffBaseMs: {
        field: 'backoff_base_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      backoffMaxMs: {
        field: 'backoff_max_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      nextAttemptAtMs: {
        field: 'next_attempt_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      version: { type: DataTypes.INTEGER, allowNull: false },
      createdAtMs: {
        field: 'created_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      updatedAtMs: {
        field: 'updated_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    { tableName: RUN_RETRY_POLICY_TABLE, timestamps: false },
  );

  return { run, attempt, event, retryPolicy };
}

function nullable<T>(value: T | undefined): Nullable<T> {
  return value === undefined ? null : value;
}

function runToRow(run: RunRecord): RunRow {
  return {
    id: run.id,
    projectId: run.projectId,
    taskId: run.taskId,
    taskRevision: run.taskRevision,
    taskName: nullable(run.taskName),
    taskSnapshotRef: nullable(run.taskSnapshotRef),
    legacyCronId: nullable(run.legacyCronId),
    parentRunId: nullable(run.parentRunId),
    retryOfRunId: nullable(run.retryOfRunId),
    triggerId: nullable(run.triggerId),
    triggerType: run.triggerType,
    executionOrigin: run.executionOrigin,
    executionOwner: run.executionOwner,
    triggeredBy: nullable(run.triggeredBy),
    requestId: nullable(run.requestId),
    scheduledForMs: nullable(run.scheduledForMs),
    status: run.status,
    version: run.version,
    eventSequence: run.eventSequence,
    priority: run.priority,
    idempotencyKey: nullable(run.idempotencyKey),
    inputRef: nullable(run.inputRef),
    outputRef: nullable(run.outputRef),
    createdAtMs: run.createdAtMs,
    queuedAtMs: nullable(run.queuedAtMs),
    startedAtMs: nullable(run.startedAtMs),
    finishedAtMs: nullable(run.finishedAtMs),
    cancelRequestedAtMs: nullable(run.cancelRequestedAtMs),
    cancelReason: nullable(run.cancelReason),
    errorCode: nullable(run.errorCode),
    errorSummary: nullable(run.errorSummary),
  };
}

function rowToRun(row: RunRow): RunRecord {
  const run: RunRecord = {
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    taskRevision: row.taskRevision,
    triggerType: row.triggerType,
    executionOrigin: row.executionOrigin as RunRecord['executionOrigin'],
    executionOwner: row.executionOwner as RunRecord['executionOwner'],
    status: row.status as RunRecord['status'],
    version: row.version,
    eventSequence: row.eventSequence,
    priority: row.priority,
    createdAtMs: row.createdAtMs,
  };

  if (row.taskName !== null) run.taskName = row.taskName;
  if (row.taskSnapshotRef !== null) run.taskSnapshotRef = row.taskSnapshotRef;
  if (row.legacyCronId !== null) run.legacyCronId = row.legacyCronId;
  if (row.parentRunId !== null) run.parentRunId = row.parentRunId;
  if (row.retryOfRunId !== null) run.retryOfRunId = row.retryOfRunId;
  if (row.triggerId !== null) run.triggerId = row.triggerId;
  if (row.triggeredBy !== null) run.triggeredBy = row.triggeredBy;
  if (row.requestId !== null) run.requestId = row.requestId;
  if (row.scheduledForMs !== null) run.scheduledForMs = row.scheduledForMs;
  if (row.idempotencyKey !== null) run.idempotencyKey = row.idempotencyKey;
  if (row.inputRef !== null) run.inputRef = row.inputRef;
  if (row.outputRef !== null) run.outputRef = row.outputRef;
  if (row.queuedAtMs !== null) run.queuedAtMs = row.queuedAtMs;
  if (row.startedAtMs !== null) run.startedAtMs = row.startedAtMs;
  if (row.finishedAtMs !== null) run.finishedAtMs = row.finishedAtMs;
  if (row.cancelRequestedAtMs !== null) {
    run.cancelRequestedAtMs = row.cancelRequestedAtMs;
  }
  if (row.cancelReason !== null) {
    run.cancelReason = row.cancelReason as RunRecord['cancelReason'];
  }
  if (row.errorCode !== null) run.errorCode = row.errorCode;
  if (row.errorSummary !== null) run.errorSummary = row.errorSummary;

  return run;
}

function attemptToRow(attempt: RunAttemptRecord): RunAttemptRow {
  return {
    id: attempt.id,
    runId: attempt.runId,
    stepRunId: nullable(attempt.stepRunId),
    attempt: attempt.attempt,
    status: attempt.status,
    executorType: attempt.executorType,
    workerId: nullable(attempt.workerId),
    executorHandle: nullable(attempt.executorHandle),
    pid: nullable(attempt.pid),
    logArtifactId: nullable(attempt.logArtifactId),
    leaseToken: nullable(attempt.leaseToken),
    leaseExpiresAtMs: nullable(attempt.leaseExpiresAtMs),
    deadlineAtMs: nullable(attempt.deadlineAtMs),
    callbackTokenHash: nullable(attempt.callbackTokenHash),
    callbackSequence: attempt.callbackSequence,
    createdAtMs: attempt.createdAtMs,
    startedAtMs: nullable(attempt.startedAtMs),
    finishedAtMs: nullable(attempt.finishedAtMs),
    exitCode: nullable(attempt.exitCode),
    errorCode: nullable(attempt.errorCode),
    errorSummary: nullable(attempt.errorSummary),
  };
}

function rowToAttempt(row: RunAttemptRow): RunAttemptRecord {
  const attempt: RunAttemptRecord = {
    id: row.id,
    runId: row.runId,
    attempt: row.attempt,
    status: row.status as RunAttemptRecord['status'],
    executorType: row.executorType,
    callbackSequence: row.callbackSequence,
    createdAtMs: row.createdAtMs,
  };

  if (row.stepRunId !== null) attempt.stepRunId = row.stepRunId;
  if (row.workerId !== null) attempt.workerId = row.workerId;
  if (row.executorHandle !== null) attempt.executorHandle = row.executorHandle;
  if (row.pid !== null) attempt.pid = row.pid;
  if (row.logArtifactId !== null) attempt.logArtifactId = row.logArtifactId;
  if (row.leaseToken !== null) attempt.leaseToken = row.leaseToken;
  if (row.leaseExpiresAtMs !== null)
    attempt.leaseExpiresAtMs = row.leaseExpiresAtMs;
  if (row.deadlineAtMs !== null) attempt.deadlineAtMs = row.deadlineAtMs;
  if (row.callbackTokenHash !== null)
    attempt.callbackTokenHash = row.callbackTokenHash;
  if (row.startedAtMs !== null) attempt.startedAtMs = row.startedAtMs;
  if (row.finishedAtMs !== null) attempt.finishedAtMs = row.finishedAtMs;
  if (row.exitCode !== null) attempt.exitCode = row.exitCode;
  if (row.errorCode !== null) attempt.errorCode = row.errorCode;
  if (row.errorSummary !== null) attempt.errorSummary = row.errorSummary;

  return attempt;
}

function retryPolicyToRow(policy: RunRetryPolicyRecord): RunRetryPolicyRow {
  assertRunRetryPolicyRecord(policy);
  return {
    runId: policy.runId,
    maxAttempts: policy.maxAttempts,
    retryOnLost: policy.retryOnLost,
    safety: policy.safety,
    backoffBaseMs: policy.backoffBaseMs,
    backoffMaxMs: policy.backoffMaxMs,
    nextAttemptAtMs: nullable(policy.nextAttemptAtMs),
    version: policy.version,
    createdAtMs: policy.createdAtMs,
    updatedAtMs: policy.updatedAtMs,
  };
}

function rowToRetryPolicy(row: RunRetryPolicyRow): RunRetryPolicyRecord {
  const policy: RunRetryPolicyRecord = {
    runId: row.runId,
    maxAttempts: row.maxAttempts,
    retryOnLost: Boolean(row.retryOnLost),
    safety: row.safety as RunRetryPolicyRecord['safety'],
    backoffBaseMs: Number(row.backoffBaseMs),
    backoffMaxMs: Number(row.backoffMaxMs),
    version: row.version,
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
    ...(row.nextAttemptAtMs === null
      ? {}
      : { nextAttemptAtMs: Number(row.nextAttemptAtMs) }),
  };
  assertRunRetryPolicyRecord(policy);
  return policy;
}

function eventToRow(event: RunEventRecord): RunEventRow {
  return {
    id: event.id,
    runId: event.runId,
    sequence: event.sequence,
    type: event.type,
    dedupeKey: nullable(event.dedupeKey),
    actorType: event.actorType,
    actorId: nullable(event.actorId),
    attemptId: nullable(event.attemptId),
    stepRunId: nullable(event.stepRunId),
    payload: event.payload,
    createdAtMs: event.createdAtMs,
  };
}

function normalizePayload(payload: unknown): Readonly<Record<string, unknown>> {
  const value = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunRepositoryConstraintError(
      'RunEvent payload is not a JSON object',
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function rowToEvent(row: RunEventRow): RunEventRecord {
  const event: RunEventRecord = {
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    type: row.type,
    actorType: row.actorType as RunEventRecord['actorType'],
    payload: normalizePayload(row.payload),
    createdAtMs: row.createdAtMs,
  };

  if (row.dedupeKey !== null) event.dedupeKey = row.dedupeKey;
  if (row.actorId !== null) event.actorId = row.actorId;
  if (row.attemptId !== null) event.attemptId = row.attemptId;
  if (row.stepRunId !== null) event.stepRunId = row.stepRunId;

  return event;
}

function assertEventPayloadSize(event: RunEventRecord): void {
  const bytes = Buffer.byteLength(JSON.stringify(event.payload), 'utf8');
  if (bytes > MAX_RUN_EVENT_PAYLOAD_BYTES) {
    throw new RunEventPayloadTooLargeError(bytes, MAX_RUN_EVENT_PAYLOAD_BYTES);
  }
}

function isIdempotencyKeyViolation(error: UniqueConstraintError): boolean {
  const fields = new Set<string>();
  if (Array.isArray(error.fields)) {
    error.fields.forEach((field) => fields.add(field));
  } else if (error.fields) {
    Object.keys(error.fields).forEach((field) => fields.add(field));
  }
  error.errors.forEach((item) => {
    if (item.path) fields.add(item.path);
  });
  return fields.has('idempotencyKey') || fields.has('idempotency_key');
}

function mapRepositoryWriteError(error: unknown): RunRepositoryError {
  if (error instanceof TimeoutError) {
    return new RunRepositoryBusyError(error);
  }
  if (
    error instanceof ForeignKeyConstraintError ||
    error instanceof ValidationError
  ) {
    return new RunRepositoryConstraintError(error.message, error);
  }
  return new RunRepositoryOperationError(error);
}

class LegacySequelizeRunReader implements RunRepositoryReader {
  constructor(
    protected readonly models: LegacyRunModels,
    protected readonly sequelizeTransaction?: Transaction,
  ) {}

  async findRunById(runId: string): Promise<RunRecord | null> {
    const row = (await this.models.run.findByPk(runId, {
      raw: true,
      transaction: this.sequelizeTransaction,
    })) as unknown as RunRow | null;
    return row ? rowToRun(row) : null;
  }

  async findAttemptById(attemptId: string): Promise<RunAttemptRecord | null> {
    const row = (await this.models.attempt.findByPk(attemptId, {
      raw: true,
      transaction: this.sequelizeTransaction,
    })) as unknown as RunAttemptRow | null;
    return row ? rowToAttempt(row) : null;
  }

  async findLatestAttemptByRunId(
    runId: string,
  ): Promise<RunAttemptRecord | null> {
    const row = (await this.models.attempt.findOne({
      where: { runId },
      order: [
        ['attempt', 'DESC'],
        ['id', 'DESC'],
      ],
      raw: true,
      transaction: this.sequelizeTransaction,
    })) as unknown as RunAttemptRow | null;
    return row ? rowToAttempt(row) : null;
  }

  async findRetryPolicyByRunId(
    runId: string,
  ): Promise<RunRetryPolicyRecord | null> {
    const row = (await this.models.retryPolicy.findByPk(runId, {
      raw: true,
      transaction: this.sequelizeTransaction,
    })) as unknown as RunRetryPolicyRow | null;
    return row ? rowToRetryPolicy(row) : null;
  }

  async listEvents(
    runId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<RunEventRecord[]> {
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError('afterSequence must be a non-negative integer');
    }
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_RUN_EVENT_PAGE_SIZE
    ) {
      throw new RangeError(
        'limit must be between 1 and MAX_RUN_EVENT_PAGE_SIZE',
      );
    }

    const rows = (await this.models.event.findAll({
      where: {
        runId,
        sequence: { [Op.gt]: afterSequence },
      },
      order: [
        ['sequence', 'ASC'],
        ['id', 'ASC'],
      ],
      limit,
      raw: true,
      transaction: this.sequelizeTransaction,
    })) as unknown as RunEventRow[];

    return rows.map(rowToEvent);
  }

  async listCancellationRequested(
    options: { beforeMs?: number; limit?: number } = {},
  ): Promise<RunRecord[]> {
    const beforeMs = options.beforeMs;
    const limit = options.limit ?? 100;
    if (
      beforeMs !== undefined &&
      (!Number.isSafeInteger(beforeMs) || beforeMs < 0)
    ) {
      throw new RangeError('beforeMs must be a non-negative safe integer');
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_CANCELLATION_RECOVERY_PAGE_SIZE
    ) {
      throw new RangeError(
        'limit must be between 1 and MAX_CANCELLATION_RECOVERY_PAGE_SIZE',
      );
    }

    const rows = (await this.models.run.findAll({
      where: {
        status: {
          [Op.notIn]: ['succeeded', 'failed', 'cancelled', 'timed_out'],
        },
        cancelRequestedAtMs: {
          [Op.ne]: null,
          ...(beforeMs === undefined ? {} : { [Op.lte]: beforeMs }),
        },
      },
      order: [
        ['cancelRequestedAtMs', 'ASC'],
        ['id', 'ASC'],
      ],
      limit,
      raw: true,
      transaction: this.sequelizeTransaction,
    })) as unknown as RunRow[];
    return rows.map(rowToRun);
  }
}

export class LegacySequelizeRunTransaction
  extends LegacySequelizeRunReader
  implements RunRepositoryTransaction
{
  constructor(models: LegacyRunModels, transaction: Transaction) {
    super(models, transaction);
  }

  async insertRun(run: RunRecord): Promise<void> {
    try {
      await this.models.run.create(runToRow(run), {
        transaction: this.sequelizeTransaction,
      });
    } catch (error) {
      if (
        error instanceof UniqueConstraintError &&
        run.idempotencyKey &&
        isIdempotencyKeyViolation(error)
      ) {
        throw new DuplicateIdempotencyKeyError(
          run.projectId,
          run.idempotencyKey,
        );
      }
      throw mapRepositoryWriteError(error);
    }
  }

  async insertAttempt(attempt: RunAttemptRecord): Promise<void> {
    try {
      await this.models.attempt.create(attemptToRow(attempt), {
        transaction: this.sequelizeTransaction,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new DuplicateRunAttemptError(attempt.runId, attempt.attempt);
      }
      throw mapRepositoryWriteError(error);
    }
  }

  async insertRetryPolicy(policy: RunRetryPolicyRecord): Promise<void> {
    try {
      await this.models.retryPolicy.create(retryPolicyToRow(policy), {
        transaction: this.sequelizeTransaction,
      });
    } catch (error) {
      throw mapRepositoryWriteError(error);
    }
  }

  async compareAndSetRun(
    run: RunRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    if (run.version !== expectedVersion + 1) {
      throw new RunRepositoryConstraintError(
        'A compare-and-set Run write must increment version exactly once',
      );
    }

    const { id: _id, ...values } = runToRow(run);
    try {
      const [affectedRows] = await this.models.run.update(values, {
        where: { id: run.id, version: expectedVersion },
        transaction: this.sequelizeTransaction,
      });
      return affectedRows === 1;
    } catch (error) {
      throw mapRepositoryWriteError(error);
    }
  }

  async compareAndSetAttempt(
    attempt: RunAttemptRecord,
    expected: {
      status: RunAttemptStatus;
      callbackSequence: number;
    },
  ): Promise<boolean> {
    const { id: _id, ...values } = attemptToRow(attempt);
    try {
      const [affectedRows] = await this.models.attempt.update(values, {
        where: {
          id: attempt.id,
          status: expected.status,
          callbackSequence: expected.callbackSequence,
        },
        transaction: this.sequelizeTransaction,
      });
      return affectedRows === 1;
    } catch (error) {
      throw mapRepositoryWriteError(error);
    }
  }

  async compareAndSetRetryPolicy(
    policy: RunRetryPolicyRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    if (policy.version !== expectedVersion + 1) {
      throw new RunRepositoryConstraintError(
        'A compare-and-set retry policy write must increment version exactly once',
      );
    }
    const { runId: _runId, ...values } = retryPolicyToRow(policy);
    try {
      const [affectedRows] = await this.models.retryPolicy.update(values, {
        where: { runId: policy.runId, version: expectedVersion },
        transaction: this.sequelizeTransaction,
      });
      return affectedRows === 1;
    } catch (error) {
      throw mapRepositoryWriteError(error);
    }
  }

  async appendEvent(event: RunEventRecord): Promise<void> {
    assertEventPayloadSize(event);
    try {
      await this.models.event.create(eventToRow(event), {
        transaction: this.sequelizeTransaction,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new DuplicateRunEventError(event.runId, event.dedupeKey);
      }
      throw mapRepositoryWriteError(error);
    }
  }
}

export class LegacySequelizeRunRepository
  extends LegacySequelizeRunReader
  implements RunRepository, LegacyShadowRunLocator
{
  private readonly database: Sequelize;

  constructor(database: Sequelize) {
    const models = defineLegacyRunModels(database);
    super(models);
    this.database = database;
  }

  async listActiveByLegacyCron({
    legacyCronId,
    origins,
    limit = MAX_LEGACY_SHADOW_LOOKUP_CANDIDATES,
  }: {
    legacyCronId: number;
    origins: readonly RunRecord['executionOrigin'][];
    limit?: number;
  }): Promise<ActiveLegacyShadowRunResult> {
    if (!Number.isSafeInteger(legacyCronId) || legacyCronId < 1) {
      throw new RangeError('legacyCronId must be a positive safe integer');
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_LEGACY_SHADOW_LOOKUP_CANDIDATES
    ) {
      throw new RangeError(
        'limit must be between 1 and MAX_LEGACY_SHADOW_LOOKUP_CANDIDATES',
      );
    }
    if (origins.length === 0) {
      return { candidates: [], truncated: false };
    }

    const runRows = (await this.models.run.findAll({
      where: {
        legacyCronId,
        executionOwner: 'legacy',
        executionOrigin: { [Op.in]: [...new Set(origins)] },
        status: {
          [Op.notIn]: ['succeeded', 'failed', 'cancelled', 'timed_out'],
        },
      },
      order: [
        ['createdAtMs', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: limit + 1,
      raw: true,
    })) as unknown as RunRow[];
    const truncated = runRows.length > limit;
    const boundedRuns = runRows.slice(0, limit);
    if (boundedRuns.length === 0) {
      return { candidates: [], truncated };
    }

    const attemptRows = (await this.models.attempt.findAll({
      where: {
        runId: { [Op.in]: boundedRuns.map((run) => run.id) },
        status: {
          [Op.notIn]: ['succeeded', 'failed', 'cancelled', 'timed_out', 'lost'],
        },
      },
      order: [
        ['attempt', 'DESC'],
        ['createdAtMs', 'DESC'],
        ['id', 'DESC'],
      ],
      raw: true,
    })) as unknown as RunAttemptRow[];
    const attemptByRun = new Map<string, RunAttemptRow>();
    for (const attempt of attemptRows) {
      if (!attemptByRun.has(attempt.runId)) {
        attemptByRun.set(attempt.runId, attempt);
      }
    }

    return {
      candidates: boundedRuns.flatMap((run) => {
        const attempt = attemptByRun.get(run.id);
        if (!attempt) return [];
        return [
          {
            runId: run.id,
            attemptId: attempt.id,
            origin: run.executionOrigin as RunRecord['executionOrigin'],
            runStatus: run.status as RunRecord['status'],
            attemptStatus: attempt.status as RunAttemptStatus,
            ...(attempt.pid === null ? {} : { pid: attempt.pid }),
            ...(attempt.logArtifactId === null
              ? {}
              : { logArtifactId: attempt.logArtifactId }),
            createdAtMs: run.createdAtMs,
          },
        ];
      }),
      truncated,
    };
  }

  async transaction<T>(
    work: (transaction: RunRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(
      { type: Transaction.TYPES.IMMEDIATE },
      async (transaction) =>
        work(new LegacySequelizeRunTransaction(this.models, transaction)),
    );
  }
}

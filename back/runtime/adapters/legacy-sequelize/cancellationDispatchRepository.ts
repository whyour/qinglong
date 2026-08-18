import { createHash } from 'crypto';
import {
  DataTypes,
  Model,
  ModelStatic,
  Sequelize,
  Transaction,
  UniqueConstraintError,
} from 'sequelize';
import {
  RUN_EVENT_TABLE,
  RUN_TABLE,
  RUN_ATTEMPT_TABLE,
} from '../../../migrations/0002-run-schema';
import { RUN_CANCELLATION_DISPATCH_TABLE } from '../../../migrations/0005-run-cancellation-dispatch';
import {
  CANCELLATION_DISPATCH_RESULTS,
  CANCELLATION_DISPATCH_STATUSES,
  type CancellationDispatchRecord,
  type CancellationDispatchResult,
  type CancellationDispatchStatus,
} from '../../domain/cancellationDispatch';
import {
  CancellationDispatchBindingConflictError,
  CancellationDispatchFenceRejectedError,
  CancellationDispatchRepositoryError,
  InvalidCancellationDispatchCommandError,
} from '../../domain/cancellationDispatchErrors';
import type { RunEventRecord, RunStatus } from '../../domain/run';
import type {
  CancellationDispatchRepository,
  ClaimCancellationDispatchCommand,
  ClaimCancellationDispatchResult,
  RecordCancellationDispatchResult,
  RecordCancellationDispatchResultCommand,
} from '../../ports/cancellationDispatchRepository';

const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'created',
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'retry_wait',
  'lost',
];
const ACTIVE_ATTEMPT_STATUSES = ['claimed', 'starting', 'running'] as const;
const RETRYABLE_RESULTS: readonly CancellationDispatchResult[] = [
  'controller_missing',
  'handle_missing',
  'dispatch_error',
];
const BLOCKING_RESULTS: readonly CancellationDispatchResult[] = [
  'identity_mismatch',
  'pid_mismatch',
  'unsupported',
  'invalid',
];
const MAX_LEASE_DURATION_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60_000;

export interface LegacySequelizeCancellationDispatchRepositoryOptions {
  clock?: () => number;
}

function digestLeaseToken(value: string): string {
  return createHash('sha256')
    .update('qinglong.cancellation-dispatch-lease.v1\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

interface CancellationDispatchRow {
  runId: string;
  attemptId: string;
  status: string;
  version: number;
  dispatchCount: number;
  nextAttemptAtMs: number | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAtMs: number | null;
  lastResult: string | null;
  lastDispatchedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

interface CancellationDispatchRunRow {
  id: string;
  executionOwner: string;
  status: string;
  version: number;
  eventSequence: number;
  cancelRequestedAtMs: number | null;
}

interface CancellationDispatchAttemptRow {
  id: string;
  runId: string;
  status: string;
}

interface CancellationDispatchEventRow {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  dedupeKey: string;
  actorType: string;
  actorId: string;
  attemptId: string;
  payload: Readonly<Record<string, unknown>>;
  createdAtMs: number;
}

interface CancellationDispatchInstance
  extends Model<CancellationDispatchRow, CancellationDispatchRow>,
    CancellationDispatchRow {}
interface CancellationDispatchRunInstance
  extends Model<CancellationDispatchRunRow, CancellationDispatchRunRow>,
    CancellationDispatchRunRow {}
interface CancellationDispatchAttemptInstance
  extends Model<CancellationDispatchAttemptRow, CancellationDispatchAttemptRow>,
    CancellationDispatchAttemptRow {}
interface CancellationDispatchEventInstance
  extends Model<CancellationDispatchEventRow, CancellationDispatchEventRow>,
    CancellationDispatchEventRow {}

function defineDispatchModel(
  database: Sequelize,
): ModelStatic<CancellationDispatchInstance> {
  return database.define<CancellationDispatchInstance>(
    'Ql3CancellationDispatch',
    {
      runId: { field: 'run_id', type: DataTypes.STRING(36), primaryKey: true },
      attemptId: {
        field: 'attempt_id',
        type: DataTypes.STRING(36),
        allowNull: false,
      },
      status: { type: DataTypes.STRING(32), allowNull: false },
      version: { type: DataTypes.INTEGER, allowNull: false },
      dispatchCount: {
        field: 'dispatch_count',
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      nextAttemptAtMs: {
        field: 'next_attempt_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      leaseOwner: {
        field: 'lease_owner',
        type: DataTypes.STRING(128),
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
      lastResult: {
        field: 'last_result',
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      lastDispatchedAtMs: {
        field: 'last_dispatched_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
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
    {
      tableName: RUN_CANCELLATION_DISPATCH_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

function defineRunModel(
  database: Sequelize,
): ModelStatic<CancellationDispatchRunInstance> {
  return database.define<CancellationDispatchRunInstance>(
    'Ql3CancellationDispatchRun',
    {
      id: { type: DataTypes.STRING(36), primaryKey: true },
      executionOwner: {
        field: 'execution_owner',
        type: DataTypes.STRING(16),
        allowNull: false,
      },
      status: { type: DataTypes.STRING(32), allowNull: false },
      version: { type: DataTypes.INTEGER, allowNull: false },
      eventSequence: {
        field: 'event_sequence',
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      cancelRequestedAtMs: {
        field: 'cancel_requested_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
    },
    { tableName: RUN_TABLE, timestamps: false, freezeTableName: true },
  );
}

function defineAttemptModel(
  database: Sequelize,
): ModelStatic<CancellationDispatchAttemptInstance> {
  return database.define<CancellationDispatchAttemptInstance>(
    'Ql3CancellationDispatchAttempt',
    {
      id: { type: DataTypes.STRING(36), primaryKey: true },
      runId: { field: 'run_id', type: DataTypes.STRING(36), allowNull: false },
      status: { type: DataTypes.STRING(32), allowNull: false },
    },
    { tableName: RUN_ATTEMPT_TABLE, timestamps: false, freezeTableName: true },
  );
}

function defineEventModel(
  database: Sequelize,
): ModelStatic<CancellationDispatchEventInstance> {
  return database.define<CancellationDispatchEventInstance>(
    'Ql3CancellationDispatchEvent',
    {
      id: { type: DataTypes.STRING(36), primaryKey: true },
      runId: { field: 'run_id', type: DataTypes.STRING(36), allowNull: false },
      sequence: { type: DataTypes.INTEGER, allowNull: false },
      type: { type: DataTypes.STRING(128), allowNull: false },
      dedupeKey: {
        field: 'dedupe_key',
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      actorType: {
        field: 'actor_type',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      actorId: {
        field: 'actor_id',
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      attemptId: {
        field: 'attempt_id',
        type: DataTypes.STRING(36),
        allowNull: false,
      },
      payload: { type: DataTypes.JSON, allowNull: false },
      createdAtMs: {
        field: 'created_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    { tableName: RUN_EVENT_TABLE, timestamps: false, freezeTableName: true },
  );
}

function assertId(name: string, value: string, maxLength = 36): void {
  if (!value || value.length > maxLength) {
    throw new InvalidCancellationDispatchCommandError(
      `${name} must be between 1 and ${maxLength} characters`,
    );
  }
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidCancellationDispatchCommandError(
      `${name} must be a non-negative safe integer`,
    );
  }
}

function assertClaim(command: ClaimCancellationDispatchCommand): void {
  assertId('runId', command.runId);
  assertId('attemptId', command.attemptId);
  assertId('owner', command.owner, 128);
  assertId('leaseToken', command.leaseToken, 128);
  assertTimestamp('requestedAtMs', command.requestedAtMs);
  if (
    !Number.isSafeInteger(command.leaseDurationMs) ||
    command.leaseDurationMs < 1 ||
    command.leaseDurationMs > MAX_LEASE_DURATION_MS
  ) {
    throw new InvalidCancellationDispatchCommandError(
      `leaseDurationMs must be between 1 and ${MAX_LEASE_DURATION_MS}`,
    );
  }
}

function assertRecordResult(
  command: RecordCancellationDispatchResultCommand,
): void {
  assertId('runId', command.runId);
  assertId('attemptId', command.attemptId);
  assertId('owner', command.owner, 128);
  assertId('leaseToken', command.leaseToken, 128);
  assertId('eventId', command.eventId);
  if (
    !Number.isSafeInteger(command.expectedVersion) ||
    command.expectedVersion < 1
  ) {
    throw new InvalidCancellationDispatchCommandError(
      'expectedVersion must be a positive safe integer',
    );
  }
  if (!CANCELLATION_DISPATCH_RESULTS.includes(command.result)) {
    throw new InvalidCancellationDispatchCommandError(
      'result is not supported',
    );
  }
  if (RETRYABLE_RESULTS.includes(command.result)) {
    if (
      command.retryDelayMs === undefined ||
      !Number.isSafeInteger(command.retryDelayMs) ||
      command.retryDelayMs < 1 ||
      command.retryDelayMs > MAX_RETRY_DELAY_MS
    ) {
      throw new InvalidCancellationDispatchCommandError(
        `retryable results require retryDelayMs between 1 and ${MAX_RETRY_DELAY_MS}`,
      );
    }
  } else if (command.retryDelayMs !== undefined) {
    throw new InvalidCancellationDispatchCommandError(
      'terminal results must not include retryDelayMs',
    );
  }
}

function rowToDispatch(
  row: CancellationDispatchRow,
): CancellationDispatchRecord {
  if (
    !CANCELLATION_DISPATCH_STATUSES.includes(
      row.status as CancellationDispatchStatus,
    )
  ) {
    throw new CancellationDispatchRepositoryError(
      new Error(`Unsupported cancellation dispatch status: ${row.status}`),
    );
  }
  if (
    row.lastResult !== null &&
    !CANCELLATION_DISPATCH_RESULTS.includes(
      row.lastResult as CancellationDispatchResult,
    )
  ) {
    throw new CancellationDispatchRepositoryError(
      new Error(`Unsupported cancellation dispatch result: ${row.lastResult}`),
    );
  }
  for (const [name, value] of [
    ['version', row.version],
    ['dispatchCount', row.dispatchCount],
    ['createdAtMs', row.createdAtMs],
    ['updatedAtMs', row.updatedAtMs],
    ['nextAttemptAtMs', row.nextAttemptAtMs],
    ['leaseExpiresAtMs', row.leaseExpiresAtMs],
    ['lastDispatchedAtMs', row.lastDispatchedAtMs],
  ] as const) {
    if (
      value !== null &&
      (!Number.isSafeInteger(Number(value)) || Number(value) < 0)
    ) {
      throw new CancellationDispatchRepositoryError(
        new Error(`Invalid cancellation dispatch ${name}`),
      );
    }
  }
  const status = row.status as CancellationDispatchStatus;
  const hasCompleteLease =
    row.leaseOwner !== null &&
    row.leaseToken !== null &&
    row.leaseExpiresAtMs !== null;
  const hasAnyLease =
    row.leaseOwner !== null ||
    row.leaseToken !== null ||
    row.leaseExpiresAtMs !== null;
  if (
    (status === 'leased' && !hasCompleteLease) ||
    (status !== 'leased' && hasAnyLease) ||
    ((status === 'pending' || status === 'retry_wait') &&
      row.nextAttemptAtMs === null) ||
    ((status === 'dispatched' || status === 'blocked' || status === 'leased') &&
      row.nextAttemptAtMs !== null) ||
    ((status === 'dispatched' || status === 'blocked') &&
      row.lastResult === null)
  ) {
    throw new CancellationDispatchRepositoryError(
      new Error('Cancellation dispatch lease/status fields are inconsistent'),
    );
  }
  return {
    runId: row.runId,
    attemptId: row.attemptId,
    status,
    version: Number(row.version),
    dispatchCount: Number(row.dispatchCount),
    createdAtMs: Number(row.createdAtMs),
    updatedAtMs: Number(row.updatedAtMs),
    ...(row.nextAttemptAtMs === null
      ? {}
      : { nextAttemptAtMs: Number(row.nextAttemptAtMs) }),
    ...(row.leaseOwner === null ? {} : { leaseOwner: row.leaseOwner }),
    ...(row.leaseToken === null
      ? {}
      : { leaseTokenDigest: digestLeaseToken(row.leaseToken) }),
    ...(row.leaseExpiresAtMs === null
      ? {}
      : { leaseExpiresAtMs: Number(row.leaseExpiresAtMs) }),
    ...(row.lastResult === null
      ? {}
      : { lastResult: row.lastResult as CancellationDispatchResult }),
    ...(row.lastDispatchedAtMs === null
      ? {}
      : { lastDispatchedAtMs: Number(row.lastDispatchedAtMs) }),
  };
}

function resultState(result: CancellationDispatchResult): {
  status: CancellationDispatchStatus;
  eventType: string;
} {
  if (RETRYABLE_RESULTS.includes(result)) {
    return { status: 'retry_wait', eventType: 'run.cancel_dispatch_failed' };
  }
  if (BLOCKING_RESULTS.includes(result)) {
    return { status: 'blocked', eventType: 'run.cancel_dispatch_blocked' };
  }
  return { status: 'dispatched', eventType: 'run.cancel_dispatched' };
}

function withoutScheduleAndLease(
  dispatch: CancellationDispatchRecord,
): Omit<
  CancellationDispatchRecord,
  | 'nextAttemptAtMs'
  | 'leaseOwner'
  | 'leaseTokenDigest'
  | 'leaseExpiresAtMs'
> {
  const {
    nextAttemptAtMs: _nextAttemptAtMs,
    leaseOwner: _leaseOwner,
    leaseTokenDigest: _leaseTokenDigest,
    leaseExpiresAtMs: _leaseExpiresAtMs,
    ...rest
  } = dispatch;
  return rest;
}

export class LegacySequelizeCancellationDispatchRepository
  implements CancellationDispatchRepository
{
  private readonly dispatch: ModelStatic<CancellationDispatchInstance>;
  private readonly run: ModelStatic<CancellationDispatchRunInstance>;
  private readonly attempt: ModelStatic<CancellationDispatchAttemptInstance>;
  private readonly event: ModelStatic<CancellationDispatchEventInstance>;
  private readonly clock: () => number;

  constructor(
    private readonly database: Sequelize,
    options: LegacySequelizeCancellationDispatchRepositoryOptions = {},
  ) {
    this.dispatch = defineDispatchModel(database);
    this.run = defineRunModel(database);
    this.attempt = defineAttemptModel(database);
    this.event = defineEventModel(database);
    this.clock = options.clock ?? Date.now;
  }

  async findByRunId(runId: string): Promise<CancellationDispatchRecord | null> {
    assertId('runId', runId);
    const row = (await this.dispatch.findByPk(runId, {
      raw: true,
    })) as unknown as CancellationDispatchRow | null;
    return row === null ? null : rowToDispatch(row);
  }

  async claim(
    command: ClaimCancellationDispatchCommand,
  ): Promise<ClaimCancellationDispatchResult> {
    assertClaim(command);
    return this.database.transaction(
      { type: Transaction.TYPES.IMMEDIATE },
      async (transaction) => {
        const nowMs = this.now();
        const [run, attempt] = await Promise.all([
          this.run.findByPk(command.runId, { raw: true, transaction }),
          this.attempt.findByPk(command.attemptId, { raw: true, transaction }),
        ]);
        const runRow = run as unknown as CancellationDispatchRunRow | null;
        const attemptRow =
          attempt as unknown as CancellationDispatchAttemptRow | null;
        if (
          runRow === null ||
          attemptRow === null ||
          runRow.executionOwner !== 'runtime' ||
          !ACTIVE_RUN_STATUSES.includes(runRow.status as RunStatus) ||
          runRow.cancelRequestedAtMs === null ||
          Number(runRow.cancelRequestedAtMs) !== command.requestedAtMs ||
          attemptRow.runId !== command.runId ||
          !ACTIVE_ATTEMPT_STATUSES.includes(
            attemptRow.status as (typeof ACTIVE_ATTEMPT_STATUSES)[number],
          )
        ) {
          return { status: 'not_eligible' as const };
        }

        let row = (await this.dispatch.findByPk(command.runId, {
          raw: true,
          transaction,
        })) as unknown as CancellationDispatchRow | null;
        if (row === null) {
          try {
            const created = await this.dispatch.create(
              {
                runId: command.runId,
                attemptId: command.attemptId,
                status: 'pending',
                version: 0,
                dispatchCount: 0,
                nextAttemptAtMs: command.requestedAtMs,
                leaseOwner: null,
                leaseToken: null,
                leaseExpiresAtMs: null,
                lastResult: null,
                lastDispatchedAtMs: null,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
              },
              { transaction },
            );
            row = created.get({ plain: true }) as CancellationDispatchRow;
          } catch (error) {
            if (error instanceof UniqueConstraintError) {
              throw new CancellationDispatchRepositoryError(error);
            }
            throw error;
          }
        }
        if (row.attemptId !== command.attemptId) {
          throw new CancellationDispatchBindingConflictError(
            command.runId,
            command.attemptId,
          );
        }
        const dispatch = rowToDispatch(row);
        if (dispatch.status === 'dispatched' || dispatch.status === 'blocked') {
          return { status: dispatch.status, dispatch };
        }
        if (
          dispatch.status === 'leased' &&
          dispatch.leaseExpiresAtMs !== undefined &&
          dispatch.leaseExpiresAtMs > nowMs
        ) {
          return { status: 'leased', dispatch };
        }
        if (
          dispatch.status !== 'leased' &&
          dispatch.nextAttemptAtMs !== undefined &&
          dispatch.nextAttemptAtMs > nowMs
        ) {
          return { status: 'not_due', dispatch };
        }

        const nextVersion = dispatch.version + 1;
        const nextCount = dispatch.dispatchCount + 1;
        const leaseExpiresAtMs = nowMs + command.leaseDurationMs;
        if (!Number.isSafeInteger(leaseExpiresAtMs)) {
          throw new CancellationDispatchRepositoryError(
            new Error('Cancellation dispatch lease expiry overflowed'),
          );
        }
        const [affected] = await this.dispatch.update(
          {
            status: 'leased',
            version: nextVersion,
            dispatchCount: nextCount,
            nextAttemptAtMs: null,
            leaseOwner: command.owner,
            leaseToken: command.leaseToken,
            leaseExpiresAtMs,
            updatedAtMs: nowMs,
          },
          {
            where: { runId: command.runId, version: dispatch.version },
            transaction,
          },
        );
        if (affected !== 1) {
          throw new CancellationDispatchFenceRejectedError(command.runId);
        }
        return {
          status: 'claimed',
          leaseToken: command.leaseToken,
          dispatch: {
            ...withoutScheduleAndLease(dispatch),
            status: 'leased',
            version: nextVersion,
            dispatchCount: nextCount,
            leaseOwner: command.owner,
            leaseTokenDigest: digestLeaseToken(command.leaseToken),
            leaseExpiresAtMs,
            updatedAtMs: nowMs,
          },
        };
      },
    );
  }

  async recordResult(
    command: RecordCancellationDispatchResultCommand,
  ): Promise<RecordCancellationDispatchResult> {
    assertRecordResult(command);
    return this.database.transaction(
      { type: Transaction.TYPES.IMMEDIATE },
      async (transaction) => {
        const atMs = this.now();
        const row = (await this.dispatch.findByPk(command.runId, {
          raw: true,
          transaction,
        })) as unknown as CancellationDispatchRow | null;
        if (
          row === null ||
          row.attemptId !== command.attemptId ||
          row.status !== 'leased' ||
          row.version !== command.expectedVersion ||
          row.leaseOwner !== command.owner ||
          row.leaseToken !== command.leaseToken
        ) {
          throw new CancellationDispatchFenceRejectedError(command.runId);
        }
        const run = (await this.run.findByPk(command.runId, {
          raw: true,
          transaction,
        })) as unknown as CancellationDispatchRunRow | null;
        if (run === null) {
          throw new CancellationDispatchRepositoryError(
            new Error('Run disappeared while recording cancellation result'),
          );
        }
        const state = resultState(command.result);
        const controllerInvoked = ![
          'controller_missing',
          'handle_missing',
        ].includes(command.result);
        const nextVersion = row.version + 1;
        const nextSequence = Number(run.eventSequence) + 1;
        const nextAttemptAtMs =
          command.retryDelayMs === undefined
            ? undefined
            : atMs + command.retryDelayMs;
        if (
          nextAttemptAtMs !== undefined &&
          !Number.isSafeInteger(nextAttemptAtMs)
        ) {
          throw new CancellationDispatchRepositoryError(
            new Error('Cancellation dispatch retry deadline overflowed'),
          );
        }
        const [runAffected] = await this.run.update(
          { version: Number(run.version) + 1, eventSequence: nextSequence },
          { where: { id: command.runId, version: run.version }, transaction },
        );
        if (runAffected !== 1) {
          throw new CancellationDispatchFenceRejectedError(command.runId);
        }
        const [dispatchAffected] = await this.dispatch.update(
          {
            status: state.status,
            version: nextVersion,
            nextAttemptAtMs: nextAttemptAtMs ?? null,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtMs: null,
            lastResult: command.result,
            lastDispatchedAtMs: controllerInvoked
              ? atMs
              : row.lastDispatchedAtMs,
            updatedAtMs: atMs,
          },
          {
            where: {
              runId: command.runId,
              attemptId: command.attemptId,
              status: 'leased',
              version: command.expectedVersion,
              leaseOwner: command.owner,
              leaseToken: command.leaseToken,
            },
            transaction,
          },
        );
        if (dispatchAffected !== 1) {
          throw new CancellationDispatchFenceRejectedError(command.runId);
        }
        const event: RunEventRecord = {
          id: command.eventId,
          runId: command.runId,
          sequence: nextSequence,
          type: state.eventType,
          dedupeKey: `cancel-dispatch:${command.attemptId}:${row.dispatchCount}`,
          actorType: 'worker',
          actorId: command.owner,
          attemptId: command.attemptId,
          payload: {
            attempt_id: command.attemptId,
            dispatch_count: row.dispatchCount,
            result: command.result,
          },
          createdAtMs: atMs,
        };
        await this.event.create(
          {
            id: event.id,
            runId: event.runId,
            sequence: event.sequence,
            type: event.type,
            dedupeKey: event.dedupeKey!,
            actorType: event.actorType,
            actorId: event.actorId!,
            attemptId: event.attemptId!,
            payload: event.payload,
            createdAtMs: event.createdAtMs,
          },
          { transaction },
        );
        return {
          dispatch: {
            ...withoutScheduleAndLease(rowToDispatch(row)),
            status: state.status,
            version: nextVersion,
            ...(nextAttemptAtMs === undefined
              ? {}
              : { nextAttemptAtMs }),
            lastResult: command.result,
            ...(controllerInvoked
              ? { lastDispatchedAtMs: atMs }
              : row.lastDispatchedAtMs === null
              ? {}
              : { lastDispatchedAtMs: Number(row.lastDispatchedAtMs) }),
            updatedAtMs: atMs,
          },
          event,
        };
      },
    );
  }

  private now(): number {
    const nowMs = this.clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new CancellationDispatchRepositoryError(
        new Error('Cancellation dispatch repository clock is invalid'),
      );
    }
    return nowMs;
  }
}

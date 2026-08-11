import {
  DataTypes,
  Model,
  ModelStatic,
  Op,
  Sequelize,
  Transaction,
  UniqueConstraintError,
} from 'sequelize';
import { RUN_DISPATCH_LEASE_TABLE } from '../../../migrations/0009-run-dispatch-lease';
import { WORKER_REGISTRY_TABLE } from '../../../migrations/0008-worker-registry';
import type { RunEventRecord, RunRecord } from '../../domain/run';
import {
  RUN_DISPATCH_LEASE_STATUSES,
  RUN_DISPATCH_RELEASE_REASONS,
  RunDispatchLeaseFenceRejectedError,
  assertRunDispatchId,
  assertRunDispatchLeaseDuration,
  assertRunDispatchLeaseToken,
  assertRunDispatchLeaseVersion,
  assertRunDispatchWorkerFence,
  runDispatchLeaseExpiration,
  type RunDispatchLeaseRecord,
  type RunDispatchLeaseStatus,
  type RunDispatchReleaseReason,
} from '../../domain/runDispatchLease';
import { reserveRunEvent, transitionRun } from '../../domain/runStateMachine';
import type {
  ClaimRunDispatchLeaseCommand,
  ClaimRunDispatchLeaseResult,
  CompleteWithRunDispatchLeaseCommand,
  CompleteWithRunDispatchLeaseResult,
  ExpireRunDispatchLeaseCommand,
  ExpireRunDispatchLeaseResult,
  ReleaseRunDispatchLeaseCommand,
  ReleaseRunDispatchLeaseResult,
  RenewRunDispatchLeaseCommand,
  RunDispatchLeaseRepository,
  UseRunDispatchLeaseCommand,
  UseRunDispatchLeaseResult,
} from '../../ports/runDispatchLeaseRepository';
import type { RunRepositoryTransaction } from '../../ports/runRepository';
import {
  LegacySequelizeRunRepository,
  LegacySequelizeRunTransaction,
} from './runRepository';

interface RunDispatchLeaseRow {
  attemptId: string;
  runId: string;
  status: string;
  version: number;
  leaseGeneration: number;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseToken: string;
  acquiredAtMs: number;
  renewedAtMs: number;
  expiresAtMs: number;
  releasedAtMs: number | null;
  releaseReason: string | null;
  completedAtMs: number | null;
  updatedAtMs: number;
}

interface RunDispatchLeaseInstance
  extends Model<RunDispatchLeaseRow, RunDispatchLeaseRow>,
    RunDispatchLeaseRow {}

interface WorkerLeaseRow {
  id: string;
  sessionId: string;
  generation: number;
  status: string;
  maxConcurrentRuns: number;
  availableSlots: number;
  leaseExpiresAtMs: number;
}

interface WorkerLeaseInstance
  extends Model<WorkerLeaseRow, WorkerLeaseRow>,
    WorkerLeaseRow {}

function defineLeaseModel(
  database: Sequelize,
): ModelStatic<RunDispatchLeaseInstance> {
  return database.define<RunDispatchLeaseInstance>(
    'Ql3RunDispatchLease',
    {
      attemptId: {
        field: 'attempt_id',
        type: DataTypes.STRING(36),
        primaryKey: true,
      },
      runId: { field: 'run_id', type: DataTypes.STRING(36), allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false },
      version: { type: DataTypes.INTEGER, allowNull: false },
      leaseGeneration: {
        field: 'lease_generation',
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      workerId: {
        field: 'worker_id',
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      workerSessionId: {
        field: 'worker_session_id',
        type: DataTypes.STRING(36),
        allowNull: false,
      },
      workerGeneration: {
        field: 'worker_generation',
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      leaseToken: {
        field: 'lease_token',
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      acquiredAtMs: {
        field: 'acquired_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      renewedAtMs: {
        field: 'renewed_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      expiresAtMs: {
        field: 'expires_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      releasedAtMs: {
        field: 'released_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      releaseReason: {
        field: 'release_reason',
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      completedAtMs: {
        field: 'completed_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      updatedAtMs: {
        field: 'updated_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    { tableName: RUN_DISPATCH_LEASE_TABLE, timestamps: false },
  );
}

function defineWorkerModel(
  database: Sequelize,
): ModelStatic<WorkerLeaseInstance> {
  return database.define<WorkerLeaseInstance>(
    'Ql3RunDispatchLeaseWorker',
    {
      id: { type: DataTypes.STRING(128), primaryKey: true },
      sessionId: {
        field: 'session_id',
        type: DataTypes.STRING(36),
        allowNull: false,
      },
      generation: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false },
      maxConcurrentRuns: {
        field: 'max_concurrent_runs',
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      availableSlots: {
        field: 'available_slots',
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      leaseExpiresAtMs: {
        field: 'lease_expires_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    { tableName: WORKER_REGISTRY_TABLE, timestamps: false },
  );
}

function timestamp(name: string, value: number): number {
  const normalized = Number(value);
  assertRunDispatchLeaseVersion(name, normalized);
  return normalized;
}

function rowToLease(row: RunDispatchLeaseRow): RunDispatchLeaseRecord {
  assertRunDispatchId('attemptId', row.attemptId);
  assertRunDispatchId('runId', row.runId);
  if (
    !RUN_DISPATCH_LEASE_STATUSES.includes(row.status as RunDispatchLeaseStatus)
  ) {
    throw new TypeError(
      `Run dispatch lease ${row.attemptId} has invalid status`,
    );
  }
  assertRunDispatchLeaseVersion('version', Number(row.version));
  assertRunDispatchLeaseVersion(
    'leaseGeneration',
    Number(row.leaseGeneration),
    true,
  );
  assertRunDispatchWorkerFence({
    workerId: row.workerId,
    workerSessionId: row.workerSessionId,
    workerGeneration: Number(row.workerGeneration),
  });
  assertRunDispatchLeaseToken(row.leaseToken);
  const acquiredAtMs = timestamp('acquiredAtMs', row.acquiredAtMs);
  const renewedAtMs = timestamp('renewedAtMs', row.renewedAtMs);
  const expiresAtMs = timestamp('expiresAtMs', row.expiresAtMs);
  const updatedAtMs = timestamp('updatedAtMs', row.updatedAtMs);
  if (
    renewedAtMs < acquiredAtMs ||
    expiresAtMs <= renewedAtMs ||
    updatedAtMs < acquiredAtMs
  ) {
    throw new TypeError(
      `Run dispatch lease ${row.attemptId} timestamps are corrupt`,
    );
  }
  const base: RunDispatchLeaseRecord = {
    attemptId: row.attemptId,
    runId: row.runId,
    status: row.status as RunDispatchLeaseStatus,
    version: Number(row.version),
    leaseGeneration: Number(row.leaseGeneration),
    workerId: row.workerId,
    workerSessionId: row.workerSessionId,
    workerGeneration: Number(row.workerGeneration),
    leaseToken: row.leaseToken,
    acquiredAtMs,
    renewedAtMs,
    expiresAtMs,
    updatedAtMs,
  };
  if (row.status === 'leased') {
    if (
      row.releasedAtMs !== null ||
      row.releaseReason !== null ||
      row.completedAtMs !== null
    ) {
      throw new TypeError(
        `Run dispatch lease ${row.attemptId} state is corrupt`,
      );
    }
    return base;
  }
  if (row.status === 'released') {
    if (
      row.releasedAtMs === null ||
      row.completedAtMs !== null ||
      !RUN_DISPATCH_RELEASE_REASONS.includes(
        row.releaseReason as RunDispatchReleaseReason,
      )
    ) {
      throw new TypeError(
        `Run dispatch lease ${row.attemptId} release is corrupt`,
      );
    }
    return {
      ...base,
      releasedAtMs: timestamp('releasedAtMs', row.releasedAtMs),
      releaseReason: row.releaseReason as RunDispatchReleaseReason,
    };
  }
  if (
    row.completedAtMs === null ||
    row.releasedAtMs !== null ||
    row.releaseReason !== null
  ) {
    throw new TypeError(
      `Run dispatch lease ${row.attemptId} completion is corrupt`,
    );
  }
  return {
    ...base,
    completedAtMs: timestamp('completedAtMs', row.completedAtMs),
  };
}

function assertClaim(command: ClaimRunDispatchLeaseCommand): void {
  assertRunDispatchId('runId', command.runId);
  assertRunDispatchId('attemptId', command.attemptId);
  assertRunDispatchId('eventId', command.eventId);
  assertRunDispatchWorkerFence(command);
  assertRunDispatchLeaseToken(command.leaseToken);
  assertRunDispatchLeaseVersion('nowMs', command.nowMs);
  assertRunDispatchLeaseDuration(command.leaseDurationMs);
}

function assertFence(command: {
  attemptId: string;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseGeneration: number;
  leaseToken: string;
  expectedVersion: number;
}): void {
  assertRunDispatchId('attemptId', command.attemptId);
  assertRunDispatchWorkerFence(command);
  assertRunDispatchLeaseVersion(
    'leaseGeneration',
    command.leaseGeneration,
    true,
  );
  assertRunDispatchLeaseToken(command.leaseToken);
  assertRunDispatchLeaseVersion('expectedVersion', command.expectedVersion);
}

function sameFence(
  lease: RunDispatchLeaseRecord,
  command: {
    workerId: string;
    workerSessionId: string;
    workerGeneration: number;
    leaseGeneration: number;
    leaseToken: string;
  },
): boolean {
  return (
    lease.workerId === command.workerId &&
    lease.workerSessionId === command.workerSessionId &&
    lease.workerGeneration === command.workerGeneration &&
    lease.leaseGeneration === command.leaseGeneration &&
    lease.leaseToken === command.leaseToken
  );
}

function fenceReason(
  lease: RunDispatchLeaseRecord | null,
  command: {
    workerId: string;
    workerSessionId: string;
    workerGeneration: number;
    leaseGeneration: number;
    leaseToken: string;
    expectedVersion: number;
  },
): RunDispatchLeaseFenceRejectedError['reason'] | undefined {
  if (!lease) return 'missing';
  if (lease.workerId !== command.workerId) return 'worker_mismatch';
  if (lease.workerSessionId !== command.workerSessionId) {
    return 'worker_session_mismatch';
  }
  if (lease.workerGeneration !== command.workerGeneration) {
    return 'worker_generation_mismatch';
  }
  if (lease.leaseGeneration !== command.leaseGeneration) {
    return 'lease_generation_mismatch';
  }
  if (lease.leaseToken !== command.leaseToken) return 'lease_token_mismatch';
  if (lease.version !== command.expectedVersion) return 'version_mismatch';
  if (lease.status !== 'leased') return 'not_leased';
  return undefined;
}

function workerIsCurrent(
  worker: WorkerLeaseRow | null,
  command: {
    workerId: string;
    workerSessionId: string;
    workerGeneration: number;
  },
  nowMs: number,
  allowDraining: boolean,
): worker is WorkerLeaseRow {
  return Boolean(
    worker &&
      worker.id === command.workerId &&
      worker.sessionId === command.workerSessionId &&
      Number(worker.generation) === command.workerGeneration &&
      (worker.status === 'online' ||
        (allowDraining && worker.status === 'draining')) &&
      Number(worker.leaseExpiresAtMs) > nowMs,
  );
}

function retryableSqliteError(error: unknown): boolean {
  if (error instanceof UniqueConstraintError) return true;
  if (!error || typeof error !== 'object') return false;
  for (const candidate of [
    error,
    'original' in error ? error.original : undefined,
    'parent' in error ? error.parent : undefined,
  ]) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      'code' in candidate &&
      candidate.code === 'SQLITE_BUSY'
    ) {
      return true;
    }
  }
  return false;
}

function delay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
}

export class LegacySequelizeRunDispatchLeaseRepository
  extends LegacySequelizeRunRepository
  implements RunDispatchLeaseRepository
{
  private readonly lease: ModelStatic<RunDispatchLeaseInstance>;
  private readonly worker: ModelStatic<WorkerLeaseInstance>;

  constructor(private readonly leaseDatabase: Sequelize) {
    super(leaseDatabase);
    if (leaseDatabase.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Legacy Run dispatch lease adapter is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
    this.lease = defineLeaseModel(leaseDatabase);
    this.worker = defineWorkerModel(leaseDatabase);
  }

  async findByAttemptId(
    attemptId: string,
  ): Promise<RunDispatchLeaseRecord | null> {
    assertRunDispatchId('attemptId', attemptId);
    const row = (await this.lease.findByPk(attemptId, {
      raw: true,
    })) as unknown as RunDispatchLeaseRow | null;
    return row ? rowToLease(row) : null;
  }

  async claim(
    command: ClaimRunDispatchLeaseCommand,
  ): Promise<ClaimRunDispatchLeaseResult> {
    assertClaim(command);
    for (let retry = 0; retry < 5; retry += 1) {
      try {
        return await this.transactionImmediate(async (transaction) => {
          const runTransaction = new LegacySequelizeRunTransaction(
            this.models,
            transaction,
          );
          const [run, attempt, workerRow, leaseRow] = await Promise.all([
            runTransaction.findRunById(command.runId),
            runTransaction.findAttemptById(command.attemptId),
            this.worker.findByPk(command.workerId, { raw: true, transaction }),
            this.lease.findByPk(command.attemptId, { raw: true, transaction }),
          ]);
          const worker = workerRow as unknown as WorkerLeaseRow | null;
          const persistedLease =
            leaseRow as unknown as RunDispatchLeaseRow | null;
          if (!workerIsCurrent(worker, command, command.nowMs, true)) {
            return { status: 'worker_unavailable' as const };
          }
          const eligible =
            run &&
            attempt &&
            attempt.runId === run.id &&
            run.executionOwner === 'runtime' &&
            run.cancelRequestedAtMs === undefined &&
            attempt.status === 'claimed' &&
            (run.status === 'queued' || run.status === 'dispatching');
          if (!eligible || !run || !attempt) {
            return { status: 'not_eligible' as const };
          }
          const current = persistedLease ? rowToLease(persistedLease) : null;
          if (current && current.runId !== command.runId) {
            throw new RunDispatchLeaseFenceRejectedError(
              command.attemptId,
              'run_mismatch',
            );
          }
          if (
            current?.status === 'leased' &&
            current.expiresAtMs > command.nowMs
          ) {
            if (
              current.workerId === command.workerId &&
              current.workerSessionId === command.workerSessionId &&
              current.workerGeneration === command.workerGeneration &&
              current.leaseToken === command.leaseToken
            ) {
              return { status: 'idempotent' as const, lease: current };
            }
            return { status: 'leased' as const, lease: current };
          }
          if (current?.status === 'completed') {
            return { status: 'not_eligible' as const };
          }
          if (worker.status !== 'online' || Number(worker.availableSlots) < 1) {
            return { status: 'worker_unavailable' as const };
          }
          if (
            command.nowMs < run.createdAtMs ||
            (current && command.nowMs < current.updatedAtMs)
          ) {
            throw new TypeError(
              'Run dispatch claim time cannot move backwards',
            );
          }
          const activeCount = await this.lease.count({
            where: {
              workerId: command.workerId,
              workerSessionId: command.workerSessionId,
              workerGeneration: command.workerGeneration,
              status: 'leased',
              expiresAtMs: { [Op.gt]: command.nowMs },
              attemptId: { [Op.ne]: command.attemptId },
            },
            transaction,
          });
          if (activeCount >= Number(worker.maxConcurrentRuns)) {
            return { status: 'capacity_exhausted' as const };
          }

          const leaseGeneration = (current?.leaseGeneration ?? 0) + 1;
          const version = current ? current.version + 1 : 0;
          const expiresAtMs = runDispatchLeaseExpiration(
            command.nowMs,
            command.leaseDurationMs,
          );
          const nextRunAndEvent = this.claimEvent(
            run,
            command,
            leaseGeneration,
            current,
          );
          if (
            !(await runTransaction.compareAndSetRun(
              nextRunAndEvent.run,
              run.version,
            ))
          ) {
            throw new RunDispatchLeaseFenceRejectedError(
              command.attemptId,
              'version_mismatch',
            );
          }

          const values: RunDispatchLeaseRow = {
            attemptId: command.attemptId,
            runId: command.runId,
            status: 'leased',
            version,
            leaseGeneration,
            workerId: command.workerId,
            workerSessionId: command.workerSessionId,
            workerGeneration: command.workerGeneration,
            leaseToken: command.leaseToken,
            acquiredAtMs: command.nowMs,
            renewedAtMs: command.nowMs,
            expiresAtMs,
            releasedAtMs: null,
            releaseReason: null,
            completedAtMs: null,
            updatedAtMs: command.nowMs,
          };
          if (!current) {
            await this.lease.create(values, { transaction });
          } else {
            const [affected] = await this.lease.update(values, {
              where: {
                attemptId: command.attemptId,
                version: current.version,
              },
              transaction,
            });
            if (affected !== 1) {
              throw new RunDispatchLeaseFenceRejectedError(
                command.attemptId,
                'version_mismatch',
              );
            }
          }
          await runTransaction.appendEvent(nextRunAndEvent.event);
          return {
            status: 'claimed' as const,
            lease: rowToLease(values),
            event: nextRunAndEvent.event,
          };
        });
      } catch (error) {
        if (retryableSqliteError(error) && retry < 4) {
          await delay(retry);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Run dispatch claim retry budget exhausted');
  }

  async renew(
    command: RenewRunDispatchLeaseCommand,
  ): Promise<RunDispatchLeaseRecord> {
    assertFence(command);
    assertRunDispatchLeaseVersion('nowMs', command.nowMs);
    assertRunDispatchLeaseDuration(command.leaseDurationMs);
    return this.transactionImmediate(async (transaction) => {
      const [leaseRow, workerRow] = await Promise.all([
        this.lease.findByPk(command.attemptId, { raw: true, transaction }),
        this.worker.findByPk(command.workerId, { raw: true, transaction }),
      ]);
      const current = leaseRow
        ? rowToLease(leaseRow as unknown as RunDispatchLeaseRow)
        : null;
      const reason = fenceReason(current, command);
      if (reason) {
        throw new RunDispatchLeaseFenceRejectedError(command.attemptId, reason);
      }
      if (!current || current.expiresAtMs <= command.nowMs) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'lease_expired',
        );
      }
      if (command.nowMs < current.renewedAtMs) {
        throw new TypeError('Run dispatch renewal time cannot move backwards');
      }
      if (
        !workerIsCurrent(
          workerRow as unknown as WorkerLeaseRow | null,
          command,
          command.nowMs,
          true,
        )
      ) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'worker_unavailable',
        );
      }
      const expiresAtMs = runDispatchLeaseExpiration(
        command.nowMs,
        command.leaseDurationMs,
      );
      const [affected] = await this.lease.update(
        {
          version: current.version + 1,
          renewedAtMs: command.nowMs,
          expiresAtMs,
          updatedAtMs: command.nowMs,
        },
        {
          where: {
            attemptId: command.attemptId,
            status: 'leased',
            version: command.expectedVersion,
            leaseGeneration: command.leaseGeneration,
            workerId: command.workerId,
            workerSessionId: command.workerSessionId,
            workerGeneration: command.workerGeneration,
            leaseToken: command.leaseToken,
          },
          transaction,
        },
      );
      if (affected !== 1) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'version_mismatch',
        );
      }
      return {
        ...current,
        version: current.version + 1,
        renewedAtMs: command.nowMs,
        expiresAtMs,
        updatedAtMs: command.nowMs,
      };
    });
  }

  async release(
    command: ReleaseRunDispatchLeaseCommand,
  ): Promise<ReleaseRunDispatchLeaseResult> {
    assertFence(command);
    assertRunDispatchId('runId', command.runId);
    assertRunDispatchId('eventId', command.eventId);
    assertRunDispatchLeaseVersion('nowMs', command.nowMs);
    if (!RUN_DISPATCH_RELEASE_REASONS.includes(command.reason)) {
      throw new TypeError('Run dispatch release reason is invalid');
    }
    return this.transactionImmediate(async (transaction) => {
      const runTransaction = new LegacySequelizeRunTransaction(
        this.models,
        transaction,
      );
      const [leaseRow, run, attempt] = await Promise.all([
        this.lease.findByPk(command.attemptId, { raw: true, transaction }),
        runTransaction.findRunById(command.runId),
        runTransaction.findAttemptById(command.attemptId),
      ]);
      const current = leaseRow
        ? rowToLease(leaseRow as unknown as RunDispatchLeaseRow)
        : null;
      if (current && current.runId !== command.runId) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'run_mismatch',
        );
      }
      if (
        current?.status === 'released' &&
        sameFence(current, command) &&
        current.version === command.expectedVersion + 1 &&
        current.releaseReason === command.reason
      ) {
        return { lease: current };
      }
      const reason = fenceReason(current, command);
      if (reason) {
        throw new RunDispatchLeaseFenceRejectedError(command.attemptId, reason);
      }
      if (!current || current.expiresAtMs <= command.nowMs) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'lease_expired',
        );
      }
      if (command.nowMs < current.updatedAtMs) {
        throw new TypeError('Run dispatch release time cannot move backwards');
      }
      if (!run || !attempt || attempt.runId !== run.id) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'missing',
        );
      }

      let event: RunEventRecord | undefined;
      if (run.status === 'dispatching') {
        const reserved = reserveRunEvent(run, run.version);
        const nextRun = reserved.run;
        if (!(await runTransaction.compareAndSetRun(nextRun, run.version))) {
          throw new RunDispatchLeaseFenceRejectedError(
            command.attemptId,
            'version_mismatch',
          );
        }
        event = {
          id: command.eventId,
          runId: run.id,
          sequence: reserved.sequence,
          type: 'run.dispatch_released',
          dedupeKey: `run-dispatch:${command.attemptId}:${current.leaseGeneration}:released`,
          actorType: 'worker',
          actorId: command.workerId,
          attemptId: command.attemptId,
          payload: {
            attempt_id: command.attemptId,
            lease_generation: current.leaseGeneration,
            reason: command.reason,
          },
          createdAtMs: command.nowMs,
        };
      }
      const [affected] = await this.lease.update(
        {
          status: 'released',
          version: current.version + 1,
          releasedAtMs: command.nowMs,
          releaseReason: command.reason,
          updatedAtMs: command.nowMs,
        },
        {
          where: {
            attemptId: command.attemptId,
            status: 'leased',
            version: command.expectedVersion,
            leaseGeneration: command.leaseGeneration,
            workerId: command.workerId,
            workerSessionId: command.workerSessionId,
            workerGeneration: command.workerGeneration,
            leaseToken: command.leaseToken,
          },
          transaction,
        },
      );
      if (affected !== 1) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'version_mismatch',
        );
      }
      if (event) await runTransaction.appendEvent(event);
      return {
        lease: {
          ...current,
          status: 'released',
          version: current.version + 1,
          releasedAtMs: command.nowMs,
          releaseReason: command.reason,
          updatedAtMs: command.nowMs,
        },
        ...(event ? { event } : {}),
      };
    });
  }

  async completeWithLease<T>(
    command: CompleteWithRunDispatchLeaseCommand,
    work: (
      transaction: RunRepositoryTransaction,
      lease: RunDispatchLeaseRecord,
    ) => Promise<T>,
  ): Promise<CompleteWithRunDispatchLeaseResult<T>> {
    assertFence(command);
    assertRunDispatchId('runId', command.runId);
    assertRunDispatchLeaseVersion('completedAtMs', command.completedAtMs);
    return this.transactionImmediate(async (transaction) => {
      const [leaseRow, workerRow] = await Promise.all([
        this.lease.findByPk(command.attemptId, { raw: true, transaction }),
        this.worker.findByPk(command.workerId, { raw: true, transaction }),
      ]);
      const current = leaseRow
        ? rowToLease(leaseRow as unknown as RunDispatchLeaseRow)
        : null;
      if (current && current.runId !== command.runId) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'run_mismatch',
        );
      }
      const completedReplay = Boolean(
        current?.status === 'completed' &&
          sameFence(current, command) &&
          current.version === command.expectedVersion + 1,
      );
      if (!completedReplay) {
        const reason = fenceReason(current, command);
        if (reason) {
          throw new RunDispatchLeaseFenceRejectedError(
            command.attemptId,
            reason,
          );
        }
        if (!current || current.expiresAtMs <= command.completedAtMs) {
          throw new RunDispatchLeaseFenceRejectedError(
            command.attemptId,
            'lease_expired',
          );
        }
      }
      if (!current) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'missing',
        );
      }
      if (!completedReplay && command.completedAtMs < current.updatedAtMs) {
        throw new TypeError(
          'Run dispatch completion time cannot move backwards',
        );
      }
      if (
        !completedReplay &&
        !workerIsCurrent(
          workerRow as unknown as WorkerLeaseRow | null,
          command,
          command.completedAtMs,
          true,
        )
      ) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'worker_unavailable',
        );
      }
      const runTransaction = new LegacySequelizeRunTransaction(
        this.models,
        transaction,
      );
      const value = await work(runTransaction, current);
      if (completedReplay) return { value, lease: current };
      const [affected] = await this.lease.update(
        {
          status: 'completed',
          version: current.version + 1,
          completedAtMs: command.completedAtMs,
          updatedAtMs: command.completedAtMs,
        },
        {
          where: {
            attemptId: command.attemptId,
            status: 'leased',
            version: command.expectedVersion,
            leaseGeneration: command.leaseGeneration,
            workerId: command.workerId,
            workerSessionId: command.workerSessionId,
            workerGeneration: command.workerGeneration,
            leaseToken: command.leaseToken,
          },
          transaction,
        },
      );
      if (affected !== 1) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'version_mismatch',
        );
      }
      return {
        value,
        lease: {
          ...current,
          status: 'completed',
          version: current.version + 1,
          completedAtMs: command.completedAtMs,
          updatedAtMs: command.completedAtMs,
        },
      };
    });
  }

  async expireWithLease<T>(
    command: ExpireRunDispatchLeaseCommand,
    work: (
      transaction: RunRepositoryTransaction,
      lease: RunDispatchLeaseRecord,
    ) => Promise<T>,
  ): Promise<ExpireRunDispatchLeaseResult<T>> {
    assertRunDispatchId('runId', command.runId);
    assertRunDispatchId('attemptId', command.attemptId);
    assertRunDispatchLeaseVersion('observedAtMs', command.observedAtMs);
    return this.transactionImmediate(async (transaction) => {
      const leaseRow = await this.lease.findByPk(command.attemptId, {
        raw: true,
        transaction,
      });
      const current = leaseRow
        ? rowToLease(leaseRow as unknown as RunDispatchLeaseRow)
        : null;
      if (!current) return { status: 'not_found' as const };
      if (current.runId !== command.runId) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'run_mismatch',
        );
      }
      if (
        current.status === 'released' &&
        current.releaseReason === 'lease_expired'
      ) {
        return { status: 'already_expired' as const, lease: current };
      }
      if (current.status !== 'leased') {
        return {
          status: 'not_eligible' as const,
          lease: current,
        };
      }
      if (current.expiresAtMs > command.observedAtMs) {
        return { status: 'not_due' as const, lease: current };
      }

      const runTransaction = new LegacySequelizeRunTransaction(
        this.models,
        transaction,
      );
      const value = await work(runTransaction, current);
      const [affected] = await this.lease.update(
        {
          status: 'released',
          version: current.version + 1,
          releasedAtMs: command.observedAtMs,
          releaseReason: 'lease_expired',
          updatedAtMs: command.observedAtMs,
        },
        {
          where: {
            attemptId: command.attemptId,
            status: 'leased',
            version: current.version,
            leaseGeneration: current.leaseGeneration,
            workerId: current.workerId,
            workerSessionId: current.workerSessionId,
            workerGeneration: current.workerGeneration,
            leaseToken: current.leaseToken,
          },
          transaction,
        },
      );
      if (affected !== 1) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'version_mismatch',
        );
      }
      return {
        status: 'expired' as const,
        value,
        lease: {
          ...current,
          status: 'released',
          version: current.version + 1,
          releasedAtMs: command.observedAtMs,
          releaseReason: 'lease_expired',
          updatedAtMs: command.observedAtMs,
        },
      };
    });
  }

  async withLease<T>(
    command: UseRunDispatchLeaseCommand,
    work: (
      transaction: RunRepositoryTransaction,
      lease: RunDispatchLeaseRecord,
    ) => Promise<T>,
  ): Promise<UseRunDispatchLeaseResult<T>> {
    assertFence(command);
    assertRunDispatchId('runId', command.runId);
    assertRunDispatchLeaseVersion('observedAtMs', command.observedAtMs);
    return this.transactionImmediate(async (transaction) => {
      const [leaseRow, workerRow] = await Promise.all([
        this.lease.findByPk(command.attemptId, { raw: true, transaction }),
        this.worker.findByPk(command.workerId, { raw: true, transaction }),
      ]);
      const current = leaseRow
        ? rowToLease(leaseRow as unknown as RunDispatchLeaseRow)
        : null;
      if (current && current.runId !== command.runId) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'run_mismatch',
        );
      }
      const reason = fenceReason(current, command);
      if (reason) {
        throw new RunDispatchLeaseFenceRejectedError(command.attemptId, reason);
      }
      if (!current || current.expiresAtMs <= command.observedAtMs) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'lease_expired',
        );
      }
      if (command.observedAtMs < current.updatedAtMs) {
        throw new TypeError(
          'Run dispatch observation time cannot move backwards',
        );
      }
      if (
        !workerIsCurrent(
          workerRow as unknown as WorkerLeaseRow | null,
          command,
          command.observedAtMs,
          true,
        )
      ) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'worker_unavailable',
        );
      }
      const runTransaction = new LegacySequelizeRunTransaction(
        this.models,
        transaction,
      );
      return {
        value: await work(runTransaction, current),
        lease: current,
      };
    });
  }

  private claimEvent(
    run: RunRecord,
    command: ClaimRunDispatchLeaseCommand,
    leaseGeneration: number,
    previous: RunDispatchLeaseRecord | null,
  ): { run: RunRecord; event: RunEventRecord } {
    if (run.status === 'queued') {
      const decision = transitionRun(run, {
        to: 'dispatching',
        expectedVersion: run.version,
        atMs: command.nowMs,
      });
      return {
        run: decision.run,
        event: {
          id: command.eventId,
          runId: run.id,
          sequence: decision.event.sequence,
          type: decision.event.type,
          dedupeKey: `run-dispatch:${command.attemptId}:${leaseGeneration}:claimed`,
          actorType: 'worker',
          actorId: command.workerId,
          attemptId: command.attemptId,
          payload: {
            ...decision.event.payload,
            attempt_id: command.attemptId,
            lease_generation: leaseGeneration,
          },
          createdAtMs: command.nowMs,
        },
      };
    }
    const reserved = reserveRunEvent(run, run.version);
    return {
      run: reserved.run,
      event: {
        id: command.eventId,
        runId: run.id,
        sequence: reserved.sequence,
        type: 'run.dispatch_reclaimed',
        dedupeKey: `run-dispatch:${command.attemptId}:${leaseGeneration}:claimed`,
        actorType: 'worker',
        actorId: command.workerId,
        attemptId: command.attemptId,
        payload: {
          attempt_id: command.attemptId,
          lease_generation: leaseGeneration,
          previous_state:
            previous?.status === 'leased' ? 'expired' : 'released',
        },
        createdAtMs: command.nowMs,
      },
    };
  }

  private transactionImmediate<T>(
    work: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.leaseDatabase.transaction(
      { type: Transaction.TYPES.IMMEDIATE },
      work,
    );
  }
}

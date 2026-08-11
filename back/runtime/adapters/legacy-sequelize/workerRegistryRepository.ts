import {
  DataTypes,
  Model,
  ModelStatic,
  Op,
  Sequelize,
  Transaction,
  UniqueConstraintError,
} from 'sequelize';
import { WORKER_REGISTRY_TABLE } from '../../../migrations/0008-worker-registry';
import {
  WORKER_STATUSES,
  WorkerFenceRejectedError,
  WorkerSessionConflictError,
  assertWorkerConcurrency,
  assertWorkerId,
  assertWorkerSessionId,
  hashWorkerCapabilities,
  parseWorkerCapabilities,
  type WorkerRecord,
  type WorkerStatus,
} from '../../domain/worker';
import {
  MAX_AVAILABLE_WORKER_PAGE_SIZE,
  type AvailableWorkerPage,
  type HeartbeatWorkerSessionCommand,
  type RegisterWorkerSessionCommand,
  type RegisterWorkerSessionResult,
  type TransitionWorkerSessionCommand,
  type WorkerRegistryRepository,
} from '../../ports/workerRegistryRepository';

interface WorkerRow {
  id: string;
  sessionId: string;
  generation: number;
  status: string;
  version: number;
  capabilitiesJson: string;
  capabilitiesHash: string;
  maxConcurrentRuns: number;
  availableSlots: number;
  registeredAtMs: number;
  lastHeartbeatAtMs: number;
  leaseExpiresAtMs: number;
  updatedAtMs: number;
}

interface WorkerInstance extends Model<WorkerRow, WorkerRow>, WorkerRow {}

function defineWorkerModel(database: Sequelize): ModelStatic<WorkerInstance> {
  return database.define<WorkerInstance>(
    'Ql3WorkerRegistry',
    {
      id: { type: DataTypes.STRING(128), primaryKey: true },
      sessionId: {
        field: 'session_id',
        type: DataTypes.STRING(36),
        allowNull: false,
      },
      generation: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false },
      version: { type: DataTypes.INTEGER, allowNull: false },
      capabilitiesJson: {
        field: 'capabilities_json',
        type: DataTypes.TEXT,
        allowNull: false,
      },
      capabilitiesHash: {
        field: 'capabilities_hash',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
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
      registeredAtMs: {
        field: 'registered_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      lastHeartbeatAtMs: {
        field: 'last_heartbeat_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      leaseExpiresAtMs: {
        field: 'lease_expires_at_ms',
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
      tableName: WORKER_REGISTRY_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

function nonNegativeTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertCapabilities(
  capabilitiesJson: string,
  capabilitiesHash: string,
): void {
  parseWorkerCapabilities(capabilitiesJson);
  if (
    !/^[0-9a-f]{64}$/.test(capabilitiesHash) ||
    hashWorkerCapabilities(capabilitiesJson) !== capabilitiesHash
  ) {
    throw new TypeError('capabilitiesHash does not match capabilitiesJson');
  }
}

function toRecord(row: WorkerRow): WorkerRecord {
  if (!WORKER_STATUSES.includes(row.status as WorkerStatus)) {
    throw new Error(`Worker ${row.id} has an invalid status`);
  }
  assertWorkerId(row.id);
  assertWorkerSessionId(row.sessionId);
  positiveInteger(Number(row.generation), 'generation');
  nonNegativeTimestamp(Number(row.version), 'version');
  assertCapabilities(row.capabilitiesJson, row.capabilitiesHash);
  assertWorkerConcurrency(
    Number(row.maxConcurrentRuns),
    Number(row.availableSlots),
  );
  for (const [name, value] of [
    ['registeredAtMs', row.registeredAtMs],
    ['lastHeartbeatAtMs', row.lastHeartbeatAtMs],
    ['leaseExpiresAtMs', row.leaseExpiresAtMs],
    ['updatedAtMs', row.updatedAtMs],
  ] as const) {
    nonNegativeTimestamp(Number(value), name);
  }
  if (
    Number(row.lastHeartbeatAtMs) < Number(row.registeredAtMs) ||
    Number(row.leaseExpiresAtMs) <= Number(row.lastHeartbeatAtMs) ||
    Number(row.updatedAtMs) < Number(row.lastHeartbeatAtMs)
  ) {
    throw new Error(`Worker ${row.id} timestamps are corrupt`);
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    generation: Number(row.generation),
    status: row.status as WorkerStatus,
    version: Number(row.version),
    capabilities: parseWorkerCapabilities(row.capabilitiesJson),
    capabilitiesHash: row.capabilitiesHash,
    maxConcurrentRuns: Number(row.maxConcurrentRuns),
    availableSlots: Number(row.availableSlots),
    registeredAtMs: Number(row.registeredAtMs),
    lastHeartbeatAtMs: Number(row.lastHeartbeatAtMs),
    leaseExpiresAtMs: Number(row.leaseExpiresAtMs),
    updatedAtMs: Number(row.updatedAtMs),
  };
}

function assertRegister(command: RegisterWorkerSessionCommand): void {
  assertWorkerId(command.workerId);
  assertWorkerSessionId(command.sessionId);
  assertCapabilities(command.capabilitiesJson, command.capabilitiesHash);
  assertWorkerConcurrency(command.maxConcurrentRuns, command.availableSlots);
  nonNegativeTimestamp(command.registeredAtMs, 'registeredAtMs');
  nonNegativeTimestamp(command.leaseExpiresAtMs, 'leaseExpiresAtMs');
  if (command.leaseExpiresAtMs <= command.registeredAtMs) {
    throw new RangeError('leaseExpiresAtMs must be after registeredAtMs');
  }
}

function assertHeartbeat(command: HeartbeatWorkerSessionCommand): void {
  assertWorkerId(command.workerId);
  assertWorkerSessionId(command.sessionId);
  positiveInteger(command.generation, 'generation');
  nonNegativeTimestamp(command.expectedVersion, 'expectedVersion');
  nonNegativeTimestamp(command.availableSlots, 'availableSlots');
  nonNegativeTimestamp(command.heartbeatAtMs, 'heartbeatAtMs');
  nonNegativeTimestamp(command.leaseExpiresAtMs, 'leaseExpiresAtMs');
  if (command.leaseExpiresAtMs <= command.heartbeatAtMs) {
    throw new RangeError('leaseExpiresAtMs must be after heartbeatAtMs');
  }
}

function assertTransition(command: TransitionWorkerSessionCommand): void {
  assertWorkerId(command.workerId);
  assertWorkerSessionId(command.sessionId);
  positiveInteger(command.generation, 'generation');
  nonNegativeTimestamp(command.expectedVersion, 'expectedVersion');
  nonNegativeTimestamp(command.transitionedAtMs, 'transitionedAtMs');
  if (command.status !== 'draining' && command.status !== 'offline') {
    throw new TypeError('Worker transition status is invalid');
  }
}

function fenceReason(
  row: WorkerRow | null,
  command: {
    workerId: string;
    sessionId: string;
    generation: number;
    expectedVersion: number;
  },
): WorkerFenceRejectedError['reason'] | undefined {
  if (!row) return 'missing';
  if (row.sessionId !== command.sessionId) return 'session_mismatch';
  if (Number(row.generation) !== command.generation) {
    return 'generation_mismatch';
  }
  if (Number(row.version) !== command.expectedVersion) {
    return 'version_mismatch';
  }
  if (row.status === 'offline') return 'offline';
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  for (const candidate of [
    error,
    'original' in error ? error.original : undefined,
    'parent' in error ? error.parent : undefined,
  ]) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      'code' in candidate &&
      typeof candidate.code === 'string'
    ) {
      return candidate.code;
    }
  }
  return undefined;
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
}

export class LegacySequelizeWorkerRegistryRepository
  implements WorkerRegistryRepository
{
  private readonly worker: ModelStatic<WorkerInstance>;

  constructor(private readonly database: Sequelize) {
    this.worker = defineWorkerModel(database);
  }

  async findById(workerId: string): Promise<WorkerRecord | null> {
    assertWorkerId(workerId);
    const row = (await this.worker.findByPk(workerId, {
      raw: true,
    })) as unknown as WorkerRow | null;
    return row ? toRecord(row) : null;
  }

  async register(
    command: RegisterWorkerSessionCommand,
  ): Promise<RegisterWorkerSessionResult> {
    assertRegister(command);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.database.transaction(
          this.database.getDialect() === 'sqlite'
            ? { type: Transaction.TYPES.IMMEDIATE }
            : {},
          async (transaction) => {
            const current = await this.worker.findByPk(command.workerId, {
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            if (!current) {
              const created = await this.worker.create(
                {
                  id: command.workerId,
                  sessionId: command.sessionId,
                  generation: 1,
                  status: 'online',
                  version: 0,
                  capabilitiesJson: command.capabilitiesJson,
                  capabilitiesHash: command.capabilitiesHash,
                  maxConcurrentRuns: command.maxConcurrentRuns,
                  availableSlots: command.availableSlots,
                  registeredAtMs: command.registeredAtMs,
                  lastHeartbeatAtMs: command.registeredAtMs,
                  leaseExpiresAtMs: command.leaseExpiresAtMs,
                  updatedAtMs: command.registeredAtMs,
                },
                { transaction },
              );
              return {
                worker: toRecord(created.get()),
                replacedSession: false,
              };
            }

            const row = current.get();
            if (row.sessionId === command.sessionId) {
              if (
                row.capabilitiesHash !== command.capabilitiesHash ||
                Number(row.maxConcurrentRuns) !== command.maxConcurrentRuns ||
                Number(row.availableSlots) !== command.availableSlots
              ) {
                throw new WorkerSessionConflictError(command.workerId);
              }
              if (Number(row.leaseExpiresAtMs) <= command.registeredAtMs) {
                throw new WorkerFenceRejectedError(
                  command.workerId,
                  'lease_expired',
                );
              }
              return { worker: toRecord(row), replacedSession: false };
            }

            const next: Partial<WorkerRow> = {
              sessionId: command.sessionId,
              generation: Number(row.generation) + 1,
              status: 'online',
              version: Number(row.version) + 1,
              capabilitiesJson: command.capabilitiesJson,
              capabilitiesHash: command.capabilitiesHash,
              maxConcurrentRuns: command.maxConcurrentRuns,
              availableSlots: command.availableSlots,
              registeredAtMs: command.registeredAtMs,
              lastHeartbeatAtMs: command.registeredAtMs,
              leaseExpiresAtMs: command.leaseExpiresAtMs,
              updatedAtMs: command.registeredAtMs,
            };
            await current.update(next, { transaction });
            return {
              worker: toRecord(current.get()),
              replacedSession: true,
            };
          },
        );
      } catch (error) {
        if (
          (error instanceof UniqueConstraintError ||
            errorCode(error) === 'SQLITE_BUSY') &&
          attempt < 4
        ) {
          await retryDelay(attempt);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Worker registration retry budget exhausted');
  }

  async heartbeat(
    command: HeartbeatWorkerSessionCommand,
  ): Promise<WorkerRecord> {
    assertHeartbeat(command);
    return this.database.transaction(async (transaction) => {
      const current = await this.worker.findByPk(command.workerId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const row = current?.get() ?? null;
      const reason = fenceReason(row, command);
      if (reason) throw new WorkerFenceRejectedError(command.workerId, reason);
      if (!current || !row) {
        throw new WorkerFenceRejectedError(command.workerId, 'missing');
      }
      if (Number(row.leaseExpiresAtMs) <= command.heartbeatAtMs) {
        throw new WorkerFenceRejectedError(command.workerId, 'lease_expired');
      }
      if (command.heartbeatAtMs < Number(row.lastHeartbeatAtMs)) {
        throw new RangeError('heartbeatAtMs must not move backwards');
      }
      assertWorkerConcurrency(
        Number(row.maxConcurrentRuns),
        command.availableSlots,
      );
      await current.update(
        {
          version: Number(row.version) + 1,
          availableSlots:
            row.status === 'draining' ? 0 : command.availableSlots,
          lastHeartbeatAtMs: command.heartbeatAtMs,
          leaseExpiresAtMs: command.leaseExpiresAtMs,
          updatedAtMs: command.heartbeatAtMs,
        },
        { transaction },
      );
      return toRecord(current.get());
    });
  }

  async transition(
    command: TransitionWorkerSessionCommand,
  ): Promise<WorkerRecord> {
    assertTransition(command);
    return this.database.transaction(async (transaction) => {
      const current = await this.worker.findByPk(command.workerId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const row = current?.get() ?? null;
      if (
        row &&
        row.sessionId === command.sessionId &&
        Number(row.generation) === command.generation &&
        row.status === command.status &&
        Number(row.version) === command.expectedVersion + 1 &&
        Number(row.updatedAtMs) === command.transitionedAtMs
      ) {
        return toRecord(row);
      }
      const reason = fenceReason(row, command);
      if (reason) throw new WorkerFenceRejectedError(command.workerId, reason);
      if (!current || !row) {
        throw new WorkerFenceRejectedError(command.workerId, 'missing');
      }
      if (
        command.status === 'draining' &&
        Number(row.leaseExpiresAtMs) <= command.transitionedAtMs
      ) {
        throw new WorkerFenceRejectedError(command.workerId, 'lease_expired');
      }
      if (command.transitionedAtMs < Number(row.lastHeartbeatAtMs)) {
        throw new RangeError('transitionedAtMs must not move backwards');
      }
      await current.update(
        {
          status: command.status,
          version: Number(row.version) + 1,
          availableSlots: 0,
          updatedAtMs: command.transitionedAtMs,
        },
        { transaction },
      );
      return toRecord(current.get());
    });
  }

  async listAvailable({
    observedAtMs,
    afterWorkerId,
    limit = 32,
  }: {
    observedAtMs: number;
    afterWorkerId?: string;
    limit?: number;
  }): Promise<AvailableWorkerPage> {
    nonNegativeTimestamp(observedAtMs, 'observedAtMs');
    if (afterWorkerId !== undefined) assertWorkerId(afterWorkerId);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_AVAILABLE_WORKER_PAGE_SIZE
    ) {
      throw new RangeError(
        'limit must be between 1 and MAX_AVAILABLE_WORKER_PAGE_SIZE',
      );
    }
    const rows = (await this.worker.findAll({
      where: {
        status: 'online',
        availableSlots: { [Op.gt]: 0 },
        leaseExpiresAtMs: { [Op.gt]: observedAtMs },
        ...(afterWorkerId === undefined
          ? {}
          : { id: { [Op.gt]: afterWorkerId } }),
      },
      order: [['id', 'ASC']],
      limit: limit + 1,
      raw: true,
    })) as unknown as WorkerRow[];
    const truncated = rows.length > limit;
    const bounded = rows.slice(0, limit).map(toRecord);
    return {
      workers: bounded,
      truncated,
      ...(bounded.length === 0
        ? {}
        : { nextCursor: bounded[bounded.length - 1].id }),
    };
  }
}

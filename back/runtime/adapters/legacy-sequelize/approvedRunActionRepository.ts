import {
  QueryTypes,
  Sequelize,
  Transaction,
  type Transaction as SequelizeTransaction,
} from 'sequelize';
import { APPROVED_RUN_ACTION_RECEIPT_TABLE } from '../../../migrations/0023-approved-run-action-receipts';
import { APPROVED_ACTION_DISPATCH_EXECUTION_TABLE } from '../../../migrations/0021-approved-action-dispatch-executions';
import {
  APPROVED_RUN_ACTION_TYPE,
  APPROVED_RUN_RECEIPT_RESULT_CODE,
  ApprovedRunActionBindingConflictError,
  ApprovedRunActionRepositoryError,
  InvalidApprovedRunActionError,
  digestApprovedRunCreationPlan,
  digestApprovedRunCreationReceipt,
  normalizeApprovedRunCreationPlan,
  normalizeApprovedRunCreationReceipt,
  type ApprovedRunCreationReceipt,
} from '../../domain/approvedRunAction';
import {
  normalizeApprovedActionDispatchExecutionRecord,
  type ApprovedActionDispatchExecutionSnapshot,
} from '../../domain/approvedActionDispatchExecution';
import { normalizeApprovedActionDispatchRecord } from '../../domain/approvalRequest';
import { DuplicateIdempotencyKeyError } from '../../domain/repositoryErrors';
import type { RunRecord } from '../../domain/run';
import {
  PrimaryRunCreator,
  type PrimaryRunIdFactory,
} from '../../application/primaryRunCreator';
import type {
  ApprovedRunActionRepository,
  ApprovedRunReference,
  CreateApprovedRunCommand,
} from '../../ports/approvedRunActionRepository';
import type { RunRepositoryTransaction } from '../../ports/runRepository';
import {
  LegacySequelizeRunRepository,
  LegacySequelizeRunTransaction,
} from './runRepository';

interface ApprovedRunReceiptRow {
  schema_version: number;
  dispatch_id: string;
  approval_request_id: string;
  project_id: string;
  action_type: string;
  action_digest: string;
  execution_attempt: number;
  execution_version: number;
  started_at_ms: number;
  idempotency_key: string;
  outcome: string;
  result_code: string;
  resource_type: string;
  resource_id: string;
  finished_at_ms: number;
  evidence_digest: string;
  created_at_ms: number;
}

interface ReceiptBinding {
  snapshot: Readonly<ApprovedActionDispatchExecutionSnapshot>;
  clock: () => number;
}

interface ExecutionFenceRow {
  project_id: string;
  status: string;
  version: number;
  attempt_count: number;
  lease_owner: string | null;
  lease_token: string | null;
  started_at_ms: number | null;
}

function rowToReceipt(
  row: ApprovedRunReceiptRow,
): Readonly<ApprovedRunCreationReceipt> {
  return normalizeApprovedRunCreationReceipt({
    schemaVersion: row.schema_version as 1,
    dispatchId: row.dispatch_id,
    approvalRequestId: row.approval_request_id,
    projectId: row.project_id,
    actionType: row.action_type as typeof APPROVED_RUN_ACTION_TYPE,
    actionDigest: row.action_digest,
    executionAttempt: row.execution_attempt,
    executionVersion: row.execution_version,
    startedAtMs: row.started_at_ms,
    idempotencyKey: row.idempotency_key,
    outcome: row.outcome as 'succeeded',
    resultCode: row.result_code as typeof APPROVED_RUN_RECEIPT_RESULT_CODE,
    resourceType: row.resource_type as 'run',
    resourceId: row.resource_id,
    finishedAtMs: row.finished_at_ms,
    evidenceDigest: row.evidence_digest,
    createdAtMs: row.created_at_ms,
  });
}

function normalizeSnapshot(
  snapshot: Readonly<ApprovedActionDispatchExecutionSnapshot>,
): Readonly<ApprovedActionDispatchExecutionSnapshot> {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new InvalidApprovedRunActionError('execution snapshot is invalid');
  }
  const dispatch = normalizeApprovedActionDispatchRecord(snapshot.dispatch);
  const execution = normalizeApprovedActionDispatchExecutionRecord(
    snapshot.execution,
  );
  if (
    execution.dispatchId !== dispatch.id ||
    execution.projectId !== dispatch.projectId ||
    execution.status !== 'executing' ||
    execution.startedAtMs === null
  ) {
    throw new ApprovedRunActionBindingConflictError();
  }
  return Object.freeze({ dispatch, execution });
}

function receiptMatches(
  receipt: Readonly<ApprovedRunCreationReceipt>,
  snapshot: Readonly<ApprovedActionDispatchExecutionSnapshot>,
): boolean {
  return (
    receipt.dispatchId === snapshot.dispatch.id &&
    receipt.approvalRequestId === snapshot.dispatch.approvalRequestId &&
    receipt.projectId === snapshot.dispatch.projectId &&
    receipt.actionType === snapshot.dispatch.action.actionType &&
    receipt.actionDigest === snapshot.dispatch.action.actionDigest &&
    receipt.executionAttempt === snapshot.execution.attemptCount &&
    receipt.startedAtMs === snapshot.execution.startedAtMs &&
    receipt.idempotencyKey === snapshot.dispatch.id
  );
}

class AtomicApprovedRunRepository extends LegacySequelizeRunRepository {
  constructor(
    private readonly approvedDatabase: Sequelize,
    private readonly binding: Readonly<ReceiptBinding>,
  ) {
    super(approvedDatabase);
  }

  override async transaction<T>(
    work: (transaction: RunRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    return this.approvedDatabase.transaction(
      { type: Transaction.TYPES.IMMEDIATE },
      async (transaction) => {
        const executionVersion = await this.requireCurrentExecutionFence(
          transaction,
        );
        const result = await work(
          new LegacySequelizeRunTransaction(this.models, transaction),
        );
        const run = this.requireCreatedRun(result);
        await this.insertReceipt(run, executionVersion, transaction);
        return result;
      },
    );
  }

  private async requireCurrentExecutionFence(
    transaction: SequelizeTransaction,
  ): Promise<number> {
    const { dispatch, execution } = this.binding.snapshot;
    const rows = await this.approvedDatabase.query<ExecutionFenceRow>(
      `SELECT project_id, status, version, attempt_count, lease_owner,
              lease_token, started_at_ms
         FROM "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
        WHERE dispatch_id = :dispatchId
        LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: { dispatchId: dispatch.id },
        transaction,
      },
    );
    const current = rows[0];
    if (
      rows.length !== 1 ||
      current.project_id !== dispatch.projectId ||
      current.status !== 'executing' ||
      current.version < execution.version ||
      current.attempt_count !== execution.attemptCount ||
      current.lease_owner !== execution.leaseOwner ||
      current.lease_token !== execution.leaseToken ||
      current.started_at_ms !== execution.startedAtMs
    ) {
      throw new ApprovedRunActionBindingConflictError();
    }
    return current.version;
  }

  private requireCreatedRun(value: unknown): Readonly<RunRecord> {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !('projectId' in value) ||
      value.projectId !== this.binding.snapshot.dispatch.projectId ||
      !('idempotencyKey' in value) ||
      value.idempotencyKey !== this.binding.snapshot.dispatch.id ||
      !('requestId' in value) ||
      value.requestId !== this.binding.snapshot.dispatch.approvalRequestId ||
      !('status' in value) ||
      value.status !== 'queued'
    ) {
      throw new ApprovedRunActionBindingConflictError();
    }
    return value as Readonly<RunRecord>;
  }

  private async insertReceipt(
    run: Readonly<RunRecord>,
    executionVersion: number,
    transaction: SequelizeTransaction,
  ): Promise<void> {
    const { dispatch, execution } = this.binding.snapshot;
    const finishedAtMs = this.nowAtOrAfter(execution.startedAtMs!);
    const unsigned: Omit<ApprovedRunCreationReceipt, 'evidenceDigest'> = {
      schemaVersion: 1,
      dispatchId: dispatch.id,
      approvalRequestId: dispatch.approvalRequestId,
      projectId: dispatch.projectId,
      actionType: APPROVED_RUN_ACTION_TYPE,
      actionDigest: dispatch.action.actionDigest,
      executionAttempt: execution.attemptCount,
      executionVersion,
      startedAtMs: execution.startedAtMs!,
      idempotencyKey: dispatch.id,
      outcome: 'succeeded',
      resultCode: APPROVED_RUN_RECEIPT_RESULT_CODE,
      resourceType: 'run',
      resourceId: run.id,
      finishedAtMs,
      createdAtMs: finishedAtMs,
    };
    const receipt = normalizeApprovedRunCreationReceipt({
      ...unsigned,
      evidenceDigest: digestApprovedRunCreationReceipt(unsigned),
    });
    await this.approvedDatabase.query(
      `INSERT INTO "${APPROVED_RUN_ACTION_RECEIPT_TABLE}"
        (dispatch_id, approval_request_id, project_id, schema_version,
         action_type, action_digest, execution_attempt, execution_version,
         started_at_ms, idempotency_key, outcome, result_code, resource_type,
         resource_id, finished_at_ms, evidence_digest, created_at_ms)
       VALUES
        (:dispatchId, :approvalRequestId, :projectId, :schemaVersion,
         :actionType, :actionDigest, :executionAttempt, :executionVersion,
         :startedAtMs, :idempotencyKey, :outcome, :resultCode, :resourceType,
         :resourceId, :finishedAtMs, :evidenceDigest, :createdAtMs)`,
      { replacements: receipt, transaction },
    );
  }

  private nowAtOrAfter(minimum: number): number {
    const nowMs = this.binding.clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < minimum) {
      throw new RangeError('clock must not precede the action start barrier');
    }
    return nowMs;
  }
}

export interface LegacySequelizeApprovedRunActionRepositoryOptions {
  clock?: () => number;
  createId?: PrimaryRunIdFactory;
}

export class LegacySequelizeApprovedRunActionRepository
  implements ApprovedRunActionRepository
{
  private readonly runs: LegacySequelizeRunRepository;
  private readonly clock: () => number;
  private readonly createId?: PrimaryRunIdFactory;

  constructor(
    private readonly database: Sequelize,
    options: LegacySequelizeApprovedRunActionRepositoryOptions = {},
  ) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Approved Run action repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
    this.runs = new LegacySequelizeRunRepository(database);
    this.clock = options.clock ?? Date.now;
    this.createId = options.createId;
  }

  async create(
    command: Readonly<CreateApprovedRunCommand>,
  ): Promise<Readonly<ApprovedRunReference>> {
    try {
      const snapshot = normalizeSnapshot(command.snapshot);
      const plan = normalizeApprovedRunCreationPlan(command.plan);
      this.assertPlanBinding(snapshot, plan);
      const replay = await this.findReplay(snapshot);
      if (replay) return replay;

      const atomic = new AtomicApprovedRunRepository(this.database, {
        snapshot,
        clock: this.clock,
      });
      const creator = new PrimaryRunCreator(atomic, this.createId);
      try {
        return await creator.create(
          {
            projectId: plan.projectId,
            taskId: plan.taskId,
            taskRevision: plan.taskRevision,
            ...(plan.taskName === undefined ? {} : { taskName: plan.taskName }),
            ...(plan.taskSnapshotRef === undefined
              ? {}
              : { taskSnapshotRef: plan.taskSnapshotRef }),
            triggerType: 'approved_action',
            executionOrigin: 'system',
            triggeredBy: `approved-action:${snapshot.dispatch.id}`,
            requestId: snapshot.dispatch.approvalRequestId,
            priority: plan.priority,
            idempotencyKey: snapshot.dispatch.id,
            ...(plan.inputRef === undefined ? {} : { inputRef: plan.inputRef }),
            acceptedAtMs: snapshot.execution.startedAtMs!,
            actor: { type: 'system', id: 'approved-action-dispatcher' },
          },
          plan.executorType,
        );
      } catch (error) {
        if (!(error instanceof DuplicateIdempotencyKeyError)) throw error;
        const raced = await this.findReplay(snapshot);
        if (raced) return raced;
        throw new ApprovedRunActionBindingConflictError();
      }
    } catch (error) {
      if (
        error instanceof ApprovedRunActionBindingConflictError ||
        error instanceof InvalidApprovedRunActionError ||
        error instanceof RangeError ||
        error instanceof TypeError
      ) {
        throw error;
      }
      throw new ApprovedRunActionRepositoryError();
    }
  }

  private assertPlanBinding(
    snapshot: Readonly<ApprovedActionDispatchExecutionSnapshot>,
    plan: Readonly<ReturnType<typeof normalizeApprovedRunCreationPlan>>,
  ): void {
    if (
      snapshot.dispatch.action.actionType !== APPROVED_RUN_ACTION_TYPE ||
      snapshot.dispatch.action.actionRef !== plan.actionRef ||
      snapshot.dispatch.projectId !== plan.projectId ||
      snapshot.dispatch.action.actionDigest !==
        digestApprovedRunCreationPlan(plan)
    ) {
      throw new ApprovedRunActionBindingConflictError();
    }
  }

  private async findReplay(
    snapshot: Readonly<ApprovedActionDispatchExecutionSnapshot>,
  ): Promise<Readonly<ApprovedRunReference> | null> {
    const rows = await this.database.query<ApprovedRunReceiptRow>(
      `SELECT schema_version, dispatch_id, approval_request_id, project_id,
              action_type, action_digest, execution_attempt, execution_version,
              started_at_ms, idempotency_key, outcome, result_code,
              resource_type, resource_id, finished_at_ms, evidence_digest,
              created_at_ms
         FROM "${APPROVED_RUN_ACTION_RECEIPT_TABLE}"
        WHERE dispatch_id = :dispatchId
        LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: { dispatchId: snapshot.dispatch.id },
      },
    );
    if (rows.length > 1) throw new ApprovedRunActionBindingConflictError();
    if (rows.length === 0) {
      const collisions = await this.database.query<{ id: string }>(
        `SELECT id FROM "Runs"
          WHERE project_id = :projectId AND idempotency_key = :idempotencyKey
          LIMIT 1`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            projectId: snapshot.dispatch.projectId,
            idempotencyKey: snapshot.dispatch.id,
          },
        },
      );
      if (collisions.length > 0) {
        throw new ApprovedRunActionBindingConflictError();
      }
      return null;
    }
    const receipt = rowToReceipt(rows[0]);
    if (!receiptMatches(receipt, snapshot)) {
      throw new ApprovedRunActionBindingConflictError();
    }
    const run = await this.runs.findRunById(receipt.resourceId);
    const attempt = await this.runs.findLatestAttemptByRunId(
      receipt.resourceId,
    );
    if (
      !run ||
      !attempt ||
      run.projectId !== receipt.projectId ||
      run.idempotencyKey !== receipt.idempotencyKey ||
      run.requestId !== receipt.approvalRequestId ||
      run.executionOwner !== 'runtime' ||
      run.executionOrigin !== 'system' ||
      run.triggerType !== 'approved_action'
    ) {
      throw new ApprovedRunActionBindingConflictError();
    }
    return Object.freeze({ run, attempt });
  }
}

import {
  DataTypes,
  Model,
  ModelStatic,
  QueryTypes,
  Sequelize,
  Transaction,
  UniqueConstraintError,
} from 'sequelize';
import {
  APPROVAL_REQUEST_TABLE,
  APPROVED_ACTION_DISPATCH_TABLE,
} from '../../../migrations/0020-approval-requests';
import { APPROVED_ACTION_DISPATCH_EXECUTION_TABLE } from '../../../migrations/0021-approved-action-dispatch-executions';
import { DEFAULT_APPROVED_ACTION_MAX_ATTEMPTS } from '../../domain/approvedActionDispatchExecution';
import {
  ApprovalMutationConflictError,
  ApprovalPolicyFenceConflictError,
  ApprovalRequestExpiredError,
  ApprovalRequestNotFoundError,
  ApprovalRequestStateConflictError,
  ApprovalRequestVersionConflictError,
  ApprovalUnavailableError,
  InvalidApprovalValueError,
  normalizeApprovalActionBinding,
  normalizeApprovalPolicyFence,
  normalizeApprovalRequestRecord,
  normalizeApprovedActionDispatchRecord,
  sameApprovalAction,
  sameApprovalSubject,
  type ApprovalRequestRecord,
  type ApprovedActionDispatchRecord,
} from '../../domain/approvalRequest';
import {
  normalizePolicySubject,
  type ProjectPolicyFence,
} from '../../domain/projectPolicy';
import type {
  ApprovalRequestRepository,
  ConsumeApprovalRequestCommand,
  ConsumeApprovalRequestResult,
  CreateApprovalRequestCommand,
  CreateApprovalRequestResult,
  DecideApprovalRequestCommand,
  DecideApprovalRequestResult,
} from '../../ports/approvalRequestRepository';
import {
  PROJECT_ROLE_BINDING_TABLE,
  PROJECT_TABLE,
} from '../../../migrations/0017-project-policy';

const RETRY_ATTEMPTS = 5;

interface ApprovalRequestRow {
  id: string;
  projectId: string;
  version: number;
  state: string;
  permission: string;
  actionType: string;
  actionRef: string;
  actionDigest: string;
  previewDigest: string;
  risk: string;
  requestedByType: string;
  requestedById: string;
  requestedAtMs: number | string;
  expiresAtMs: number | string;
  decisionId: string | null;
  decision: string | null;
  decisionReasonCode: string | null;
  decidedByType: string | null;
  decidedById: string | null;
  decidedAtMs: number | string | null;
  consumptionId: string | null;
  dispatchId: string | null;
  consumedByType: string | null;
  consumedById: string | null;
  consumedAtMs: number | string | null;
}

interface ApprovalRequestInstance
  extends Model<ApprovalRequestRow, ApprovalRequestRow>,
    ApprovalRequestRow {}

interface ApprovedActionDispatchRow {
  id: string;
  approvalRequestId: string;
  approvalRequestVersion: number;
  projectId: string;
  state: string;
  permission: string;
  actionType: string;
  actionRef: string;
  actionDigest: string;
  previewDigest: string;
  requestedByType: string;
  requestedById: string;
  consumedByType: string;
  consumedById: string;
  createdAtMs: number | string;
}

interface ApprovedActionDispatchInstance
  extends Model<ApprovedActionDispatchRow, ApprovedActionDispatchRow>,
    ApprovedActionDispatchRow {}

interface PolicyFenceRow {
  project_version: number | string;
  binding_version: number | string | null;
}

function defineApprovalRequestModel(
  database: Sequelize,
): ModelStatic<ApprovalRequestInstance> {
  return database.define<ApprovalRequestInstance>(
    'Ql3ApprovalRequest',
    {
      id: { type: DataTypes.STRING(64), allowNull: false, primaryKey: true },
      projectId: {
        field: 'project_id',
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      version: { type: DataTypes.INTEGER, allowNull: false },
      state: { type: DataTypes.STRING(16), allowNull: false },
      permission: { type: DataTypes.STRING(255), allowNull: false },
      actionType: {
        field: 'action_type',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      actionRef: {
        field: 'action_ref',
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      actionDigest: {
        field: 'action_digest',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      previewDigest: {
        field: 'preview_digest',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      risk: { type: DataTypes.STRING(16), allowNull: false },
      requestedByType: {
        field: 'requested_by_type',
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      requestedById: {
        field: 'requested_by_id',
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      requestedAtMs: {
        field: 'requested_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      expiresAtMs: {
        field: 'expires_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      decisionId: {
        field: 'decision_id',
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      decision: { type: DataTypes.STRING(16), allowNull: true },
      decisionReasonCode: {
        field: 'decision_reason_code',
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      decidedByType: {
        field: 'decided_by_type',
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      decidedById: {
        field: 'decided_by_id',
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      decidedAtMs: {
        field: 'decided_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      consumptionId: {
        field: 'consumption_id',
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      dispatchId: {
        field: 'dispatch_id',
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      consumedByType: {
        field: 'consumed_by_type',
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      consumedById: {
        field: 'consumed_by_id',
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      consumedAtMs: {
        field: 'consumed_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
    },
    {
      tableName: APPROVAL_REQUEST_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

function defineApprovedActionDispatchModel(
  database: Sequelize,
): ModelStatic<ApprovedActionDispatchInstance> {
  return database.define<ApprovedActionDispatchInstance>(
    'Ql3ApprovedActionDispatch',
    {
      id: { type: DataTypes.STRING(64), allowNull: false, primaryKey: true },
      approvalRequestId: {
        field: 'approval_request_id',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      approvalRequestVersion: {
        field: 'approval_request_version',
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      projectId: {
        field: 'project_id',
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      state: { type: DataTypes.STRING(16), allowNull: false },
      permission: { type: DataTypes.STRING(255), allowNull: false },
      actionType: {
        field: 'action_type',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      actionRef: {
        field: 'action_ref',
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      actionDigest: {
        field: 'action_digest',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      previewDigest: {
        field: 'preview_digest',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      requestedByType: {
        field: 'requested_by_type',
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      requestedById: {
        field: 'requested_by_id',
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      consumedByType: {
        field: 'consumed_by_type',
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      consumedById: {
        field: 'consumed_by_id',
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      createdAtMs: {
        field: 'created_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    {
      tableName: APPROVED_ACTION_DISPATCH_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

function rowToRequest(
  row: ApprovalRequestRow,
): Readonly<ApprovalRequestRecord> {
  try {
    return normalizeApprovalRequestRecord({
      id: row.id,
      projectId: row.projectId,
      version: Number(row.version),
      state: row.state as ApprovalRequestRecord['state'],
      action: {
        permission:
          row.permission as ApprovalRequestRecord['action']['permission'],
        actionType: row.actionType,
        actionRef: row.actionRef,
        actionDigest: row.actionDigest,
        previewDigest: row.previewDigest,
      },
      risk: row.risk as ApprovalRequestRecord['risk'],
      requestedBy: {
        type: row.requestedByType as ApprovalRequestRecord['requestedBy']['type'],
        id: row.requestedById,
      },
      requestedAtMs: Number(row.requestedAtMs),
      expiresAtMs: Number(row.expiresAtMs),
      decisionId: row.decisionId,
      decision: row.decision as ApprovalRequestRecord['decision'],
      decisionReasonCode: row.decisionReasonCode,
      decidedBy:
        row.decidedByType === null || row.decidedById === null
          ? null
          : {
              type: row.decidedByType as NonNullable<
                ApprovalRequestRecord['decidedBy']
              >['type'],
              id: row.decidedById,
            },
      decidedAtMs: row.decidedAtMs === null ? null : Number(row.decidedAtMs),
      consumptionId: row.consumptionId,
      dispatchId: row.dispatchId,
      consumedBy:
        row.consumedByType === null || row.consumedById === null
          ? null
          : {
              type: row.consumedByType as NonNullable<
                ApprovalRequestRecord['consumedBy']
              >['type'],
              id: row.consumedById,
            },
      consumedAtMs: row.consumedAtMs === null ? null : Number(row.consumedAtMs),
    });
  } catch {
    throw new ApprovalUnavailableError();
  }
}

function requestToRow(
  request: Readonly<ApprovalRequestRecord>,
): ApprovalRequestRow {
  return {
    id: request.id,
    projectId: request.projectId,
    version: request.version,
    state: request.state,
    permission: request.action.permission,
    actionType: request.action.actionType,
    actionRef: request.action.actionRef,
    actionDigest: request.action.actionDigest,
    previewDigest: request.action.previewDigest,
    risk: request.risk,
    requestedByType: request.requestedBy.type,
    requestedById: request.requestedBy.id,
    requestedAtMs: request.requestedAtMs,
    expiresAtMs: request.expiresAtMs,
    decisionId: request.decisionId,
    decision: request.decision,
    decisionReasonCode: request.decisionReasonCode,
    decidedByType: request.decidedBy?.type ?? null,
    decidedById: request.decidedBy?.id ?? null,
    decidedAtMs: request.decidedAtMs,
    consumptionId: request.consumptionId,
    dispatchId: request.dispatchId,
    consumedByType: request.consumedBy?.type ?? null,
    consumedById: request.consumedBy?.id ?? null,
    consumedAtMs: request.consumedAtMs,
  };
}

function rowToDispatch(
  row: ApprovedActionDispatchRow,
): Readonly<ApprovedActionDispatchRecord> {
  try {
    return normalizeApprovedActionDispatchRecord({
      id: row.id,
      approvalRequestId: row.approvalRequestId,
      approvalRequestVersion: Number(row.approvalRequestVersion),
      projectId: row.projectId,
      state: row.state as ApprovedActionDispatchRecord['state'],
      action: {
        permission:
          row.permission as ApprovedActionDispatchRecord['action']['permission'],
        actionType: row.actionType,
        actionRef: row.actionRef,
        actionDigest: row.actionDigest,
        previewDigest: row.previewDigest,
      },
      requestedBy: {
        type: row.requestedByType as ApprovedActionDispatchRecord['requestedBy']['type'],
        id: row.requestedById,
      },
      consumedBy: {
        type: row.consumedByType as ApprovedActionDispatchRecord['consumedBy']['type'],
        id: row.consumedById,
      },
      createdAtMs: Number(row.createdAtMs),
    });
  } catch {
    throw new ApprovalUnavailableError();
  }
}

function dispatchToRow(
  dispatch: Readonly<ApprovedActionDispatchRecord>,
): ApprovedActionDispatchRow {
  return {
    id: dispatch.id,
    approvalRequestId: dispatch.approvalRequestId,
    approvalRequestVersion: dispatch.approvalRequestVersion,
    projectId: dispatch.projectId,
    state: dispatch.state,
    permission: dispatch.action.permission,
    actionType: dispatch.action.actionType,
    actionRef: dispatch.action.actionRef,
    actionDigest: dispatch.action.actionDigest,
    previewDigest: dispatch.action.previewDigest,
    requestedByType: dispatch.requestedBy.type,
    requestedById: dispatch.requestedBy.id,
    consumedByType: dispatch.consumedBy.type,
    consumedById: dispatch.consumedBy.id,
    createdAtMs: dispatch.createdAtMs,
  };
}

function sameRequestCreation(
  left: Readonly<ApprovalRequestRecord>,
  right: Readonly<ApprovalRequestRecord>,
): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    sameApprovalAction(left.action, right.action) &&
    left.risk === right.risk &&
    sameApprovalSubject(left.requestedBy, right.requestedBy) &&
    left.requestedAtMs === right.requestedAtMs &&
    left.expiresAtMs === right.expiresAtMs
  );
}

function sameDispatch(
  left: Readonly<ApprovedActionDispatchRecord>,
  right: Readonly<ApprovedActionDispatchRecord>,
): boolean {
  return (
    left.id === right.id &&
    left.approvalRequestId === right.approvalRequestId &&
    left.approvalRequestVersion === right.approvalRequestVersion &&
    left.projectId === right.projectId &&
    left.state === right.state &&
    sameApprovalAction(left.action, right.action) &&
    sameApprovalSubject(left.requestedBy, right.requestedBy) &&
    sameApprovalSubject(left.consumedBy, right.consumedBy) &&
    left.createdAtMs === right.createdAtMs
  );
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

function isApprovalError(error: unknown): boolean {
  return (
    error instanceof ApprovalMutationConflictError ||
    error instanceof InvalidApprovalValueError ||
    error instanceof ApprovalPolicyFenceConflictError ||
    error instanceof ApprovalRequestExpiredError ||
    error instanceof ApprovalRequestNotFoundError ||
    error instanceof ApprovalRequestStateConflictError ||
    error instanceof ApprovalRequestVersionConflictError ||
    error instanceof ApprovalUnavailableError
  );
}

export class LegacySequelizeApprovalRequestRepository
  implements ApprovalRequestRepository
{
  private readonly requests: ModelStatic<ApprovalRequestInstance>;
  private readonly dispatches: ModelStatic<ApprovedActionDispatchInstance>;

  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Approval request repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
    this.requests = defineApprovalRequestModel(database);
    this.dispatches = defineApprovedActionDispatchModel(database);
  }

  async findById(id: string): Promise<Readonly<ApprovalRequestRecord> | null> {
    const row = await this.requests.findByPk(id, { raw: true });
    return row ? rowToRequest(row) : null;
  }

  private async assertFence(
    projectId: string,
    subject: Readonly<ApprovalRequestRecord['requestedBy']>,
    requestedFence: Readonly<ProjectPolicyFence>,
    transaction: Transaction,
  ): Promise<void> {
    const normalizedSubject = normalizePolicySubject(subject);
    const fence = normalizeApprovalPolicyFence(requestedFence);
    const rows = await this.database.query<PolicyFenceRow>(
      `SELECT project.version AS project_version,
              (SELECT MAX(binding.version)
                 FROM "${PROJECT_ROLE_BINDING_TABLE}" AS binding
                WHERE binding.project_id = project.id
                  AND binding.subject_type = :subjectType
                  AND binding.subject_id = :subjectId) AS binding_version
         FROM "${PROJECT_TABLE}" AS project
        WHERE project.id = :projectId
        LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          projectId,
          subjectType: normalizedSubject.type,
          subjectId: normalizedSubject.id,
        },
        transaction,
      },
    );
    if (rows.length !== 1) throw new ApprovalPolicyFenceConflictError();
    const currentProjectVersion = Number(rows[0].project_version);
    const currentBindingVersion =
      rows[0].binding_version === null ? null : Number(rows[0].binding_version);
    if (
      currentProjectVersion !== fence.projectVersion ||
      currentBindingVersion !== fence.bindingVersion
    ) {
      throw new ApprovalPolicyFenceConflictError();
    }
  }

  private async findDecisionReplay(
    decisionId: string,
    transaction: Transaction,
  ): Promise<Readonly<ApprovalRequestRecord> | null> {
    const row = await this.requests.findOne({
      where: { decisionId },
      raw: true,
      transaction,
    });
    return row ? rowToRequest(row) : null;
  }

  private async findConsumptionReplay(
    consumptionId: string,
    transaction: Transaction,
  ): Promise<{
    request: Readonly<ApprovalRequestRecord>;
    dispatch: Readonly<ApprovedActionDispatchRecord>;
  } | null> {
    const row = await this.requests.findOne({
      where: { consumptionId },
      raw: true,
      transaction,
    });
    if (!row) return null;
    const request = rowToRequest(row);
    if (!request.dispatchId) throw new ApprovalUnavailableError();
    const dispatchRow = await this.dispatches.findByPk(request.dispatchId, {
      raw: true,
      transaction,
    });
    if (!dispatchRow) throw new ApprovalUnavailableError();
    const executionRows = await this.database.query<{
      dispatch_id: string;
      project_id: string;
    }>(
      `SELECT dispatch_id, project_id
         FROM "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
        WHERE dispatch_id = :dispatchId
        LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: { dispatchId: request.dispatchId },
        transaction,
      },
    );
    if (
      executionRows.length !== 1 ||
      executionRows[0].project_id !== request.projectId
    ) {
      throw new ApprovalUnavailableError();
    }
    return { request, dispatch: rowToDispatch(dispatchRow) };
  }

  async create(
    command: CreateApprovalRequestCommand,
  ): Promise<CreateApprovalRequestResult> {
    const request = normalizeApprovalRequestRecord(command.request);
    const fence = normalizeApprovalPolicyFence(command.authorizationFence);
    if (request.state !== 'pending' || request.version !== 1) {
      throw new ApprovalRequestStateConflictError();
    }
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.transaction(
          { type: Transaction.TYPES.IMMEDIATE },
          async (transaction) => {
            const existing = await this.requests.findByPk(request.id, {
              raw: true,
              transaction,
            });
            if (existing) {
              const previous = rowToRequest(existing);
              if (!sameRequestCreation(previous, request)) {
                throw new ApprovalMutationConflictError();
              }
              return { status: 'existing', request: previous };
            }
            await this.assertFence(
              request.projectId,
              request.requestedBy,
              fence,
              transaction,
            );
            await this.requests.create(requestToRow(request), { transaction });
            return { status: 'created', request };
          },
        );
      } catch (error) {
        if (isApprovalError(error)) throw error;
        if (
          (error instanceof UniqueConstraintError ||
            errorCode(error) === 'SQLITE_BUSY') &&
          attempt < RETRY_ATTEMPTS - 1
        ) {
          await retryDelay(attempt);
          continue;
        }
        throw new ApprovalUnavailableError();
      }
    }
    throw new ApprovalUnavailableError();
  }

  async decide(
    command: DecideApprovalRequestCommand,
  ): Promise<DecideApprovalRequestResult> {
    const decidedBy = normalizePolicySubject(command.decidedBy);
    const fence = normalizeApprovalPolicyFence(command.authorizationFence);
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.transaction(
          { type: Transaction.TYPES.IMMEDIATE },
          async (transaction) => {
            const replay = await this.findDecisionReplay(
              command.decisionId,
              transaction,
            );
            if (replay) {
              if (
                replay.id !== command.requestId ||
                command.expectedVersion !== 1 ||
                replay.decisionId !== command.decisionId ||
                replay.decision !== command.decision ||
                replay.decisionReasonCode !== command.reasonCode ||
                !replay.decidedBy ||
                !sameApprovalSubject(replay.decidedBy, decidedBy) ||
                replay.decidedAtMs !== command.decidedAtMs
              ) {
                throw new ApprovalMutationConflictError();
              }
              return { status: 'existing', request: replay };
            }
            const row = await this.requests.findByPk(command.requestId, {
              raw: true,
              transaction,
            });
            if (!row) throw new ApprovalRequestNotFoundError();
            const current = rowToRequest(row);
            if (command.decidedAtMs >= current.expiresAtMs) {
              throw new ApprovalRequestExpiredError();
            }
            if (current.version !== command.expectedVersion) {
              throw new ApprovalRequestVersionConflictError();
            }
            if (current.state !== 'pending') {
              throw new ApprovalRequestStateConflictError();
            }
            await this.assertFence(
              current.projectId,
              decidedBy,
              fence,
              transaction,
            );
            const decided = normalizeApprovalRequestRecord({
              ...current,
              version: 2,
              state: command.decision,
              decisionId: command.decisionId,
              decision: command.decision,
              decisionReasonCode: command.reasonCode,
              decidedBy,
              decidedAtMs: command.decidedAtMs,
            });
            const [updated] = await this.requests.update(
              requestToRow(decided),
              {
                where: {
                  id: current.id,
                  version: command.expectedVersion,
                  state: 'pending',
                },
                transaction,
              },
            );
            if (updated !== 1) {
              throw new ApprovalRequestVersionConflictError();
            }
            return { status: 'decided', request: decided };
          },
        );
      } catch (error) {
        if (isApprovalError(error)) throw error;
        if (
          (error instanceof UniqueConstraintError ||
            errorCode(error) === 'SQLITE_BUSY') &&
          attempt < RETRY_ATTEMPTS - 1
        ) {
          await retryDelay(attempt);
          continue;
        }
        throw new ApprovalUnavailableError();
      }
    }
    throw new ApprovalUnavailableError();
  }

  async consume(
    command: ConsumeApprovalRequestCommand,
  ): Promise<ConsumeApprovalRequestResult> {
    const action = normalizeApprovalActionBinding(command.action);
    const requestedBy = normalizePolicySubject(command.requestedBy);
    const consumedBy = normalizePolicySubject(command.consumedBy);
    const fence = normalizeApprovalPolicyFence(command.authorizationFence);
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.transaction(
          { type: Transaction.TYPES.IMMEDIATE },
          async (transaction) => {
            const replay = await this.findConsumptionReplay(
              command.consumptionId,
              transaction,
            );
            if (replay) {
              const expectedDispatch = normalizeApprovedActionDispatchRecord({
                id: command.dispatchId,
                approvalRequestId: command.requestId,
                approvalRequestVersion: 3,
                projectId: replay.request.projectId,
                state: 'pending',
                action,
                requestedBy,
                consumedBy,
                createdAtMs: command.consumedAtMs,
              });
              if (
                command.expectedVersion !== 2 ||
                replay.request.id !== command.requestId ||
                replay.request.consumptionId !== command.consumptionId ||
                !sameDispatch(replay.dispatch, expectedDispatch)
              ) {
                throw new ApprovalMutationConflictError();
              }
              return {
                status: 'existing',
                request: replay.request,
                dispatch: replay.dispatch,
              };
            }
            const row = await this.requests.findByPk(command.requestId, {
              raw: true,
              transaction,
            });
            if (!row) throw new ApprovalRequestNotFoundError();
            const current = rowToRequest(row);
            if (command.consumedAtMs >= current.expiresAtMs) {
              throw new ApprovalRequestExpiredError();
            }
            if (current.version !== command.expectedVersion) {
              throw new ApprovalRequestVersionConflictError();
            }
            if (current.state !== 'approved') {
              throw new ApprovalRequestStateConflictError();
            }
            if (
              !sameApprovalAction(current.action, action) ||
              !sameApprovalSubject(current.requestedBy, requestedBy)
            ) {
              throw new ApprovalMutationConflictError();
            }
            await this.assertFence(
              current.projectId,
              requestedBy,
              fence,
              transaction,
            );
            const dispatch = normalizeApprovedActionDispatchRecord({
              id: command.dispatchId,
              approvalRequestId: current.id,
              approvalRequestVersion: 3,
              projectId: current.projectId,
              state: 'pending',
              action,
              requestedBy,
              consumedBy,
              createdAtMs: command.consumedAtMs,
            });
            const dispatchCollision = await this.dispatches.findByPk(
              dispatch.id,
              { raw: true, transaction },
            );
            if (dispatchCollision) throw new ApprovalMutationConflictError();
            await this.dispatches.create(dispatchToRow(dispatch), {
              transaction,
            });
            await this.database.query(
              `INSERT INTO "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
                (dispatch_id, project_id, status, version, attempt_count,
                 max_attempts, eligible_at_ms, next_attempt_at_ms,
                 lease_owner, lease_token, lease_expires_at_ms, started_at_ms,
                 last_result_code, completed_at_ms, created_at_ms, updated_at_ms)
               VALUES
                (:dispatchId, :projectId, 'pending', 0, 0, :maxAttempts,
                 :createdAtMs, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 :createdAtMs, :createdAtMs)`,
              {
                replacements: {
                  dispatchId: dispatch.id,
                  projectId: dispatch.projectId,
                  maxAttempts: DEFAULT_APPROVED_ACTION_MAX_ATTEMPTS,
                  createdAtMs: dispatch.createdAtMs,
                },
                transaction,
              },
            );
            const consumed = normalizeApprovalRequestRecord({
              ...current,
              version: 3,
              state: 'consumed',
              consumptionId: command.consumptionId,
              dispatchId: command.dispatchId,
              consumedBy,
              consumedAtMs: command.consumedAtMs,
            });
            const [updated] = await this.requests.update(
              requestToRow(consumed),
              {
                where: {
                  id: current.id,
                  version: command.expectedVersion,
                  state: 'approved',
                },
                transaction,
              },
            );
            if (updated !== 1) {
              throw new ApprovalRequestVersionConflictError();
            }
            return { status: 'consumed', request: consumed, dispatch };
          },
        );
      } catch (error) {
        if (isApprovalError(error)) throw error;
        if (
          (error instanceof UniqueConstraintError ||
            errorCode(error) === 'SQLITE_BUSY') &&
          attempt < RETRY_ATTEMPTS - 1
        ) {
          await retryDelay(attempt);
          continue;
        }
        throw new ApprovalUnavailableError();
      }
    }
    throw new ApprovalUnavailableError();
  }
}

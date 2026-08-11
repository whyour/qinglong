import { QueryTypes, Sequelize } from 'sequelize';
import { APPROVED_RUN_ACTION_RECEIPT_TABLE } from '../../../migrations/0023-approved-run-action-receipts';
import {
  APPROVED_RUN_ACTION_TYPE,
  APPROVED_RUN_RECEIPT_RESULT_CODE,
  InvalidApprovedRunActionError,
  normalizeApprovedRunCreationReceipt,
  type ApprovedRunCreationReceipt,
} from '../../domain/approvedRunAction';
import type {
  ApprovedActionRecoveryEvidence,
  ApprovedActionRecoveryEvidenceContext,
  ApprovedActionRecoveryEvidenceProvider,
} from '../../ports/approvedActionRecoveryEvidenceProvider';
import { LegacySequelizeRunRepository } from './runRepository';

interface ReceiptRow {
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

function normalizeRow(row: ReceiptRow): Readonly<ApprovedRunCreationReceipt> {
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

const CONFLICT: ApprovedActionRecoveryEvidence = Object.freeze({
  finding: 'conflict',
  resultCode: 'approved_run_receipt_conflict',
});

export class LegacySequelizeApprovedRunRecoveryEvidenceProvider
  implements ApprovedActionRecoveryEvidenceProvider
{
  readonly actionType = APPROVED_RUN_ACTION_TYPE;
  readonly capability = 'automatic' as const;
  private readonly runs: LegacySequelizeRunRepository;

  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Approved Run recovery provider is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
    this.runs = new LegacySequelizeRunRepository(database);
  }

  async inspect(
    context: Readonly<ApprovedActionRecoveryEvidenceContext>,
  ): Promise<ApprovedActionRecoveryEvidence> {
    const snapshot = context.snapshot;
    const dispatch = snapshot.action.dispatch;
    const execution = snapshot.action.execution;
    if (
      dispatch.action.actionType !== this.actionType ||
      context.idempotencyKey !== dispatch.id ||
      execution.dispatchId !== dispatch.id ||
      execution.projectId !== dispatch.projectId ||
      execution.startedAtMs === null
    ) {
      return CONFLICT;
    }
    const rows = await this.database.query<ReceiptRow>(
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
        replacements: { dispatchId: dispatch.id },
      },
    );
    if (rows.length > 1) return CONFLICT;
    if (rows.length === 0) {
      const collisions = await this.database.query<{ id: string }>(
        `SELECT id FROM "Runs"
          WHERE project_id = :projectId AND idempotency_key = :idempotencyKey
          LIMIT 1`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            projectId: dispatch.projectId,
            idempotencyKey: dispatch.id,
          },
        },
      );
      return collisions.length === 0
        ? {
            finding: 'missing',
            resultCode: 'approved_run_receipt_missing',
          }
        : CONFLICT;
    }

    let receipt: Readonly<ApprovedRunCreationReceipt>;
    try {
      receipt = normalizeRow(rows[0]);
    } catch (error) {
      if (error instanceof InvalidApprovedRunActionError) return CONFLICT;
      throw error;
    }
    if (
      receipt.dispatchId !== dispatch.id ||
      receipt.approvalRequestId !== dispatch.approvalRequestId ||
      receipt.projectId !== dispatch.projectId ||
      receipt.actionType !== dispatch.action.actionType ||
      receipt.actionDigest !== dispatch.action.actionDigest ||
      receipt.executionAttempt !== execution.attemptCount ||
      receipt.executionVersion > execution.version ||
      receipt.startedAtMs !== execution.startedAtMs ||
      receipt.idempotencyKey !== context.idempotencyKey
    ) {
      return CONFLICT;
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
      return CONFLICT;
    }
    return {
      finding: 'verified_succeeded',
      resultCode: 'approved_run_receipt_verified',
      evidenceDigest: receipt.evidenceDigest,
    };
  }
}

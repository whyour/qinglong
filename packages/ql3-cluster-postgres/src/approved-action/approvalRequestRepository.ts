import type {
  PostgresClient,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  ApprovalMutationConflictError,
  ApprovalPolicyFenceConflictError,
  ApprovalRequestNotFoundError,
  ApprovalRequestStateConflictError,
  ApprovalUnavailableError,
  approvalRequestDigest,
  approvedActionDispatchDigest,
  consumeApprovalRequest,
  decideApprovalRequest,
  normalizeApprovalRequestRecord,
  normalizeApprovedActionDispatchRecord,
  type ApprovalRequestRecord,
  type ApprovalRequestRepository,
  type ApprovedActionDispatchRecord,
  type ConsumeDurableApprovalRequestCommand,
  type ConsumeDurableApprovalRequestResult,
  type CreateApprovalRequestCommand,
  type CreateApprovalRequestResult,
  type DecideApprovalRequestResult,
  type DecideDurableApprovalRequestCommand,
} from '@qinglong/runtime-core/approved-action';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredBoolean,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../repository/definitionRepositorySupport';
import {
  findPostgresApprovedActionExecution,
  insertPostgresApprovedActionExecutionBaseline,
} from './approvedActionExecutionRepository';
import { createApprovedActionExecution } from '@qinglong/runtime-core/approved-action-execution';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function unavailable(): ApprovalUnavailableError {
  return new ApprovalUnavailableError();
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return postgresRequiredString(value, unavailable);
}

function nullableInteger(value: unknown): number | null {
  if (value === null) return null;
  return postgresRequiredInteger(value, unavailable);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseRequest(row: Row): Readonly<ApprovalRequestRecord> {
  try {
    const request = normalizeApprovalRequestRecord(
      postgresRequiredJsonObject(
        row.requestJson,
        unavailable,
      ) as unknown as ApprovalRequestRecord,
    );
    if (
      approvalRequestDigest(request) !==
      postgresRequiredString(row.requestDigest, unavailable)
    ) {
      throw unavailable();
    }
    return request;
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    throw unavailable();
  }
}

function parseDispatch(row: Row): Readonly<ApprovedActionDispatchRecord> {
  try {
    const dispatch = normalizeApprovedActionDispatchRecord(
      postgresRequiredJsonObject(
        row.dispatchJson,
        unavailable,
      ) as unknown as ApprovedActionDispatchRecord,
    );
    if (
      approvedActionDispatchDigest(dispatch) !==
      postgresRequiredString(row.dispatchDigest, unavailable)
    ) {
      throw unavailable();
    }
    return dispatch;
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    throw unavailable();
  }
}

function parseAudit(row: Row): Readonly<SecurityAuditRecord> {
  try {
    const subjectType = nullableString(row.subjectType);
    const subjectId = nullableString(row.subjectId);
    const fenceProjectVersion = nullableInteger(row.fenceProjectVersion);
    const reasons = row.reasonsJson;
    if (!Array.isArray(reasons)) throw unavailable();
    return normalizeSecurityAuditRecord({
      eventId: postgresRequiredString(row.eventId, unavailable),
      requestId: postgresRequiredString(row.requestId, unavailable),
      operationId: postgresRequiredString(row.operationId, unavailable),
      projectId: nullableString(row.projectId),
      subject:
        subjectType === null || subjectId === null
          ? null
          : {
              type: subjectType as SecuritySubject['type'],
              id: subjectId,
            },
      authenticationId: nullableString(row.authenticationId),
      outcome: postgresRequiredString(
        row.outcome,
        unavailable,
      ) as SecurityAuditRecord['outcome'],
      reasons: reasons as readonly string[],
      fence:
        fenceProjectVersion === null
          ? null
          : {
              projectVersion: fenceProjectVersion,
              bindingVersion: nullableInteger(row.fenceBindingVersion),
            },
      occurredAtMs: postgresRequiredInteger(row.occurredAtMs, unavailable),
    });
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    throw unavailable();
  }
}

function mappedError(error: unknown): Error {
  if (
    error instanceof ApprovalMutationConflictError ||
    error instanceof ApprovalPolicyFenceConflictError ||
    error instanceof ApprovalRequestNotFoundError ||
    error instanceof ApprovalRequestStateConflictError ||
    error instanceof ApprovalUnavailableError ||
    (error instanceof Error &&
      error.name.startsWith('Approval') &&
      'code' in error)
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new ApprovalMutationConflictError();
  }
  return new ApprovalUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

function auditMatches(
  audit: Readonly<SecurityAuditRecord>,
  expected: Readonly<{
    operationId: string;
    projectId: string;
    subject: Readonly<SecuritySubject>;
    authenticationId?: string;
    outcome: SecurityAuditRecord['outcome'];
    fence: Readonly<SecurityPolicyFence>;
  }>,
): boolean {
  return (
    audit.operationId === expected.operationId &&
    audit.projectId === expected.projectId &&
    audit.subject?.type === expected.subject.type &&
    audit.subject.id === expected.subject.id &&
    (expected.authenticationId === undefined ||
      audit.authenticationId === expected.authenticationId) &&
    audit.outcome === expected.outcome &&
    audit.fence?.projectVersion === expected.fence.projectVersion &&
    audit.fence.bindingVersion === expected.fence.bindingVersion
  );
}

async function requestById(
  queryable: Queryable,
  id: string,
): Promise<Readonly<ApprovalRequestRecord> | null> {
  const result = await queryable.query<Row>(
    `SELECT request_json AS "requestJson",
            request_digest AS "requestDigest"
     FROM "ql3"."approval_requests"
     WHERE request_id = $1
     LIMIT 2`,
    [id],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseRequest(result.rows[0]!);
}

async function dispatchById(
  queryable: Queryable,
  id: string,
): Promise<Readonly<ApprovedActionDispatchRecord> | null> {
  const result = await queryable.query<Row>(
    `SELECT dispatch_json AS "dispatchJson",
            dispatch_digest AS "dispatchDigest"
     FROM "ql3"."approved_action_dispatches"
     WHERE dispatch_id = $1
     LIMIT 2`,
    [id],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseDispatch(result.rows[0]!);
}

async function auditById(
  queryable: Queryable,
  id: string,
): Promise<Readonly<SecurityAuditRecord> | null> {
  const result = await queryable.query<Row>(
    `SELECT event_id AS "eventId", request_id AS "requestId",
            operation_id AS "operationId", project_id AS "projectId",
            subject_type AS "subjectType", subject_id AS "subjectId",
            authentication_id AS "authenticationId", outcome AS "outcome",
            reasons AS "reasonsJson",
            project_version AS "fenceProjectVersion",
            binding_version AS "fenceBindingVersion",
            occurred_at_ms AS "occurredAtMs"
     FROM "ql3"."security_audit_events"
     WHERE event_id = $1
     LIMIT 2`,
    [id],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseAudit(result.rows[0]!);
}

async function assertFence(
  client: PostgresClient,
  projectId: string,
  subject: Readonly<SecuritySubject>,
  fence: Readonly<SecurityPolicyFence>,
): Promise<void> {
  const result = await client.query<Row>(
    `SELECT "ql3"."lock_approval_policy_fence"(
       $1::varchar, $2::varchar, $3::varchar, $4::integer, $5::integer
     ) AS "matches"`,
    [
      projectId,
      subject.type,
      subject.id,
      fence.projectVersion,
      fence.bindingVersion,
    ],
  );
  if (
    result.rows.length !== 1 ||
    !postgresRequiredBoolean(result.rows[0]!.matches, unavailable)
  ) {
    throw new ApprovalPolicyFenceConflictError();
  }
}

async function insertAudit(
  client: PostgresClient,
  value: SecurityAuditRecord,
): Promise<void> {
  const audit = normalizeSecurityAuditRecord(value);
  const result = await client.query(
    `INSERT INTO "ql3"."security_audit_events" (
       event_id, request_id, operation_id, project_id, subject_type,
       subject_id, authentication_id, outcome, reasons,
       project_version, binding_version, occurred_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12
     )`,
    [
      audit.eventId,
      audit.requestId,
      audit.operationId,
      audit.projectId,
      audit.subject?.type ?? null,
      audit.subject?.id ?? null,
      audit.authenticationId,
      audit.outcome,
      JSON.stringify(audit.reasons),
      audit.fence?.projectVersion ?? null,
      audit.fence?.bindingVersion ?? null,
      audit.occurredAtMs,
    ],
  );
  if (result.rowCount !== 1) throw unavailable();
}

async function insertRequest(
  client: PostgresClient,
  request: Readonly<ApprovalRequestRecord>,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO "ql3"."approval_requests" (
       request_id, project_id, version, state, action_type, action_ref,
       action_digest, preview_digest, requested_by_type, requested_by_id,
       decision_id, consumption_id, dispatch_id, expires_at_ms, request_json,
       request_digest, updated_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15::jsonb, $16, $17
     )`,
    [
      request.id,
      request.projectId,
      request.version,
      request.state,
      request.action.actionType,
      request.action.actionRef,
      request.action.actionDigest,
      request.action.previewDigest,
      request.requestedBy.type,
      request.requestedBy.id,
      request.decisionId,
      request.consumptionId,
      request.dispatchId,
      request.expiresAtMs,
      JSON.stringify(request),
      approvalRequestDigest(request),
      request.consumedAtMs ?? request.decidedAtMs ?? request.requestedAtMs,
    ],
  );
  if (result.rowCount !== 1) throw unavailable();
}

async function updateRequest(
  client: PostgresClient,
  request: Readonly<ApprovalRequestRecord>,
  expectedVersion: number,
): Promise<void> {
  const result = await client.query(
    `UPDATE "ql3"."approval_requests"
     SET version = $1, state = $2, decision_id = $3, consumption_id = $4,
         dispatch_id = $5, request_json = $6::jsonb, request_digest = $7,
         updated_at_ms = $8
     WHERE request_id = $9 AND version = $10`,
    [
      request.version,
      request.state,
      request.decisionId,
      request.consumptionId,
      request.dispatchId,
      JSON.stringify(request),
      approvalRequestDigest(request),
      request.consumedAtMs ?? request.decidedAtMs ?? request.requestedAtMs,
      request.id,
      expectedVersion,
    ],
  );
  if (result.rowCount !== 1) throw new ApprovalRequestStateConflictError();
}

async function insertDispatch(
  client: PostgresClient,
  dispatch: Readonly<ApprovedActionDispatchRecord>,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO "ql3"."approved_action_dispatches" (
       dispatch_id, approval_request_id, project_id, action_type, action_ref,
       action_digest, preview_digest, dispatch_json, dispatch_digest,
       created_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10
     )`,
    [
      dispatch.id,
      dispatch.approvalRequestId,
      dispatch.projectId,
      dispatch.action.actionType,
      dispatch.action.actionRef,
      dispatch.action.actionDigest,
      dispatch.action.previewDigest,
      JSON.stringify(dispatch),
      approvedActionDispatchDigest(dispatch),
      dispatch.createdAtMs,
    ],
  );
  if (result.rowCount !== 1) throw unavailable();
}

/** Administration-only PostgreSQL Approval/Approved Action authority. */
export class PostgresApprovalRequestRepository
  implements ApprovalRequestRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL Approval pool is invalid');
    }
  }

  async #transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw mappedError(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const result = await work(client);
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          state &&
          POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) &&
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        throw mappedError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }

  async findById(
    id: string,
  ): Promise<Readonly<ApprovalRequestRecord> | null> {
    if (typeof id !== 'string' || !IDENTIFIER_PATTERN.test(id)) {
      throw new TypeError('Approval request lookup identity is invalid');
    }
    try {
      return await requestById(this.pool, id);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async findDispatchById(
    id: string,
  ): Promise<Readonly<ApprovedActionDispatchRecord> | null> {
    if (typeof id !== 'string' || !IDENTIFIER_PATTERN.test(id)) {
      throw new TypeError('Approved action dispatch identity is invalid');
    }
    try {
      return await dispatchById(this.pool, id);
    } catch (error) {
      throw mappedError(error);
    }
  }

  create(
    command: CreateApprovalRequestCommand,
  ): Promise<CreateApprovalRequestResult> {
    const request = normalizeApprovalRequestRecord(command.request);
    const audit = normalizeSecurityAuditRecord(command.audit);
    if (
      request.state !== 'pending' ||
      request.version !== 1 ||
      !auditMatches(audit, {
        operationId: 'approval.request',
        projectId: request.projectId,
        subject: request.requestedBy,
        outcome: 'approval_required',
        fence: request.requestFence,
      })
    ) {
      throw new ApprovalMutationConflictError();
    }
    return this.#transaction(async (client) => {
      const existing = await requestById(client, request.id);
      if (existing) {
        const storedAudit = await auditById(client, audit.eventId);
        if (
          !same(existing, request) ||
          !storedAudit ||
          !same(storedAudit, audit)
        ) {
          throw new ApprovalMutationConflictError();
        }
        return Object.freeze({ status: 'existing' as const, request });
      }
      await assertFence(
        client,
        request.projectId,
        request.requestedBy,
        request.requestFence,
      );
      await insertRequest(client, request);
      await insertAudit(client, audit);
      return Object.freeze({ status: 'created' as const, request });
    });
  }

  decide(
    command: DecideDurableApprovalRequestCommand,
  ): Promise<DecideApprovalRequestResult> {
    const audit = normalizeSecurityAuditRecord(command.audit);
    return this.#transaction(async (client) => {
      const current = await requestById(client, command.requestId);
      if (!current) throw new ApprovalRequestNotFoundError();
      const request = decideApprovalRequest(current, {
        expectedVersion: command.expectedVersion,
        decisionId: command.decisionId,
        decision: command.decision,
        reasonCode: command.reasonCode,
        principal: command.principal,
        decidedAtMs: command.decidedAtMs,
        authorizationFence: command.authorizationFence,
      });
      if (
        !auditMatches(audit, {
          operationId: 'approval.decide',
          projectId: request.projectId,
          subject: command.principal.subject,
          authenticationId: command.principal.authenticationId,
          outcome: 'allowed',
          fence: command.authorizationFence,
        })
      ) {
        throw new ApprovalMutationConflictError();
      }
      if (current.version === 2 && current.decisionId === command.decisionId) {
        const storedAudit = await auditById(client, audit.eventId);
        if (!storedAudit || !same(storedAudit, audit)) {
          throw new ApprovalMutationConflictError();
        }
        return Object.freeze({ status: 'existing' as const, request });
      }
      await assertFence(
        client,
        request.projectId,
        command.principal.subject,
        command.authorizationFence,
      );
      await updateRequest(client, request, command.expectedVersion);
      await insertAudit(client, audit);
      return Object.freeze({ status: 'decided' as const, request });
    });
  }

  consume(
    command: ConsumeDurableApprovalRequestCommand,
  ): Promise<ConsumeDurableApprovalRequestResult> {
    const audit = normalizeSecurityAuditRecord(command.audit);
    return this.#transaction(async (client) => {
      const current = await requestById(client, command.requestId);
      if (!current) throw new ApprovalRequestNotFoundError();
      const result = consumeApprovalRequest(current, {
        expectedVersion: command.expectedVersion,
        consumptionId: command.consumptionId,
        dispatchId: command.dispatchId,
        action: command.action,
        requestedBy: command.requestedBy,
        consumedBy: command.consumedBy,
        consumedAtMs: command.consumedAtMs,
        authorizationFence: command.authorizationFence,
      });
      if (
        !auditMatches(audit, {
          operationId: 'approval.consume',
          projectId: result.request.projectId,
          subject: command.consumedBy,
          outcome: 'allowed',
          fence: command.authorizationFence,
        })
      ) {
        throw new ApprovalMutationConflictError();
      }
      if (
        current.version === 3 &&
        current.consumptionId === command.consumptionId
      ) {
        const storedAudit = await auditById(client, audit.eventId);
        const dispatch = await dispatchById(client, result.dispatch.id);
        const execution = await findPostgresApprovedActionExecution(
          client,
          result.dispatch.id,
        );
        if (
          !storedAudit ||
          !same(storedAudit, audit) ||
          !dispatch ||
          !same(dispatch, result.dispatch) ||
          !execution ||
          !same(execution, createApprovedActionExecution(result.dispatch))
        ) {
          throw new ApprovalMutationConflictError();
        }
        return Object.freeze({
          status: 'existing' as const,
          request: result.request,
          dispatch: result.dispatch,
        });
      }
      await assertFence(
        client,
        result.request.projectId,
        command.requestedBy,
        command.authorizationFence,
      );
      await insertDispatch(client, result.dispatch);
      await insertPostgresApprovedActionExecutionBaseline(
        client,
        result.dispatch,
      );
      await updateRequest(client, result.request, command.expectedVersion);
      await insertAudit(client, audit);
      return Object.freeze({
        status: 'consumed' as const,
        request: result.request,
        dispatch: result.dispatch,
      });
    });
  }
}

import type { DatabaseSync } from 'node:sqlite';

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
  normalizeApprovedActionFence,
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
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import {
  findLocalApprovedActionExecution,
  insertLocalApprovedActionExecutionBaseline,
} from './approvedActionExecutionRepository';
import { createApprovedActionExecution } from '@qinglong/runtime-core/approved-action-execution';

type Row = Record<string, unknown>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new ApprovalUnavailableError();
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') {
    throw new ApprovalUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) throw new ApprovalUnavailableError();
  return value as number;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new ApprovalUnavailableError();
  }
  return value as number | null;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseRequest(row: Row): Readonly<ApprovalRequestRecord> {
  try {
    const request = normalizeApprovalRequestRecord(
      JSON.parse(text(row, 'requestJson')) as ApprovalRequestRecord,
    );
    if (approvalRequestDigest(request) !== text(row, 'requestDigest')) {
      throw new ApprovalUnavailableError();
    }
    return request;
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    throw new ApprovalUnavailableError();
  }
}

function parseDispatch(row: Row): Readonly<ApprovedActionDispatchRecord> {
  try {
    const dispatch = normalizeApprovedActionDispatchRecord(
      JSON.parse(text(row, 'dispatchJson')) as ApprovedActionDispatchRecord,
    );
    if (
      approvedActionDispatchDigest(dispatch) !== text(row, 'dispatchDigest')
    ) {
      throw new ApprovalUnavailableError();
    }
    return dispatch;
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    throw new ApprovalUnavailableError();
  }
}

function parseAudit(row: Row): Readonly<SecurityAuditRecord> {
  try {
    const subjectType = nullableText(row, 'subjectType');
    const subjectId = nullableText(row, 'subjectId');
    const fenceProjectVersion = nullableInteger(row, 'fenceProjectVersion');
    return normalizeSecurityAuditRecord({
      eventId: text(row, 'eventId'),
      requestId: text(row, 'requestId'),
      operationId: text(row, 'operationId'),
      projectId: nullableText(row, 'projectId'),
      subject:
        subjectType === null || subjectId === null
          ? null
          : {
              type: subjectType as SecuritySubject['type'],
              id: subjectId,
            },
      authenticationId: nullableText(row, 'authenticationId'),
      outcome: text(row, 'outcome') as SecurityAuditRecord['outcome'],
      reasons: JSON.parse(text(row, 'reasonsJson')) as readonly string[],
      fence:
        fenceProjectVersion === null
          ? null
          : {
              projectVersion: fenceProjectVersion,
              bindingVersion: nullableInteger(row, 'fenceBindingVersion'),
            },
      occurredAtMs: integer(row, 'occurredAtMs'),
    });
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    throw new ApprovalUnavailableError();
  }
}

function storageError(error: unknown): Error {
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
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  ) {
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

export class LocalSqliteApprovalRequestRepository
  implements ApprovalRequestRepository
{
  readonly #authority: LocalSqliteOperationAuthority;
  readonly #client: DatabaseSync;
  readonly #confirmMutation: () => void;

  constructor(
    authority: LocalSqliteOperationAuthority | DatabaseSync,
    confirmMutation: () => void = () => undefined,
  ) {
    if (typeof confirmMutation !== 'function') {
      throw new TypeError('Local Approval mutation guard is invalid');
    }
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.#client = this.#authority.client;
    this.#confirmMutation = confirmMutation;
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    return this.#authority.enqueue(
      async () => {
        try {
          return await work();
        } catch (error) {
          throw storageError(error);
        }
      },
      () => new ApprovalUnavailableError(),
    );
  }

  #request(id: string): Readonly<ApprovalRequestRecord> | null {
    const row = this.#client
      .prepare(
        `SELECT "request_json" AS "requestJson",
                "request_digest" AS "requestDigest"
         FROM "QingLong3ApprovalRequests"
         WHERE "request_id" = ?`,
      )
      .get(id) as Row | undefined;
    return row ? parseRequest(row) : null;
  }

  #dispatch(id: string): Readonly<ApprovedActionDispatchRecord> | null {
    const row = this.#client
      .prepare(
        `SELECT "dispatch_json" AS "dispatchJson",
                "dispatch_digest" AS "dispatchDigest"
         FROM "QingLong3ApprovedActionDispatches"
         WHERE "dispatch_id" = ?`,
      )
      .get(id) as Row | undefined;
    return row ? parseDispatch(row) : null;
  }

  #audit(id: string): Readonly<SecurityAuditRecord> | null {
    const row = this.#client
      .prepare(
        `SELECT "event_id" AS "eventId", "request_id" AS "requestId",
                "operation_id" AS "operationId", "project_id" AS "projectId",
                "subject_type" AS "subjectType", "subject_id" AS "subjectId",
                "authentication_id" AS "authenticationId",
                "outcome" AS "outcome", "reasons_json" AS "reasonsJson",
                "fence_project_version" AS "fenceProjectVersion",
                "fence_binding_version" AS "fenceBindingVersion",
                "occurred_at_ms" AS "occurredAtMs"
         FROM "QingLong3SecurityAuditEvents"
         WHERE "event_id" = ?`,
      )
      .get(id) as Row | undefined;
    return row ? parseAudit(row) : null;
  }

  #assertFence(
    projectId: string,
    subject: Readonly<SecuritySubject>,
    expectedValue: Readonly<SecurityPolicyFence>,
  ): void {
    const expected = normalizeApprovedActionFence(expectedValue);
    const row = this.#client
      .prepare(
        `SELECT project."status" AS "status",
                project."version" AS "projectVersion",
                (
                  SELECT max(binding."version")
                  FROM "QingLong3ProjectRoleBindings" AS binding
                  WHERE binding."project_id" = project."id"
                    AND binding."subject_type" = ?
                    AND binding."subject_id" = ?
                ) AS "bindingVersion"
         FROM "QingLong3Projects" AS project
         WHERE project."id" = ?`,
      )
      .get(subject.type, subject.id, projectId) as Row | undefined;
    if (
      !row ||
      row.status !== 'active' ||
      integer(row, 'projectVersion') !== expected.projectVersion ||
      nullableInteger(row, 'bindingVersion') !== expected.bindingVersion
    ) {
      throw new ApprovalPolicyFenceConflictError();
    }
  }

  #insertAudit(value: SecurityAuditRecord): void {
    const audit = normalizeSecurityAuditRecord(value);
    this.#client
      .prepare(
        `INSERT INTO "QingLong3SecurityAuditEvents" (
           "event_id", "request_id", "operation_id", "project_id",
           "subject_type", "subject_id", "authentication_id", "outcome",
           "reasons_json", "fence_project_version",
           "fence_binding_version", "occurred_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
  }

  #insertRequest(request: Readonly<ApprovalRequestRecord>): void {
    this.#client
      .prepare(
        `INSERT INTO "QingLong3ApprovalRequests" (
           "request_id", "project_id", "version", "state", "action_type",
           "action_ref", "action_digest", "preview_digest",
           "requested_by_type", "requested_by_id", "decision_id",
           "consumption_id", "dispatch_id", "expires_at_ms", "request_json",
           "request_digest", "updated_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
  }

  #updateRequest(
    request: Readonly<ApprovalRequestRecord>,
    expectedVersion: number,
  ): void {
    const update = this.#client
      .prepare(
        `UPDATE "QingLong3ApprovalRequests"
         SET "version" = ?, "state" = ?, "decision_id" = ?,
             "consumption_id" = ?, "dispatch_id" = ?, "request_json" = ?,
             "request_digest" = ?, "updated_at_ms" = ?
         WHERE "request_id" = ? AND "version" = ?`,
      )
      .run(
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
      );
    if (update.changes !== 1) {
      throw new ApprovalRequestStateConflictError();
    }
  }

  #insertDispatch(dispatch: Readonly<ApprovedActionDispatchRecord>): void {
    this.#client
      .prepare(
        `INSERT INTO "QingLong3ApprovedActionDispatches" (
           "dispatch_id", "approval_request_id", "project_id", "action_type",
           "action_ref", "action_digest", "preview_digest", "dispatch_json",
           "dispatch_digest", "created_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
  }

  findById(id: string): Promise<Readonly<ApprovalRequestRecord> | null> {
    if (typeof id !== 'string' || !IDENTIFIER_PATTERN.test(id)) {
      throw new TypeError('Approval request lookup identity is invalid');
    }
    return this.#enqueue(() => this.#request(id));
  }

  findDispatchById(
    id: string,
  ): Promise<Readonly<ApprovedActionDispatchRecord> | null> {
    if (typeof id !== 'string' || !IDENTIFIER_PATTERN.test(id)) {
      throw new TypeError('Approved action dispatch identity is invalid');
    }
    return this.#enqueue(() => this.#dispatch(id));
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
    return this.#enqueue(() => {
      this.#client.exec('BEGIN IMMEDIATE');
      try {
        this.#confirmMutation();
        const existing = this.#request(request.id);
        if (existing) {
          const storedAudit = this.#audit(audit.eventId);
          if (
            !same(existing, request) ||
            !storedAudit ||
            !same(storedAudit, audit)
          ) {
            throw new ApprovalMutationConflictError();
          }
          this.#client.exec('COMMIT');
          return Object.freeze({ status: 'existing' as const, request });
        }
        this.#assertFence(
          request.projectId,
          request.requestedBy,
          request.requestFence,
        );
        this.#insertRequest(request);
        this.#insertAudit(audit);
        this.#client.exec('COMMIT');
        return Object.freeze({ status: 'created' as const, request });
      } catch (error) {
        if (this.#client.isTransaction) this.#client.exec('ROLLBACK');
        throw error;
      }
    });
  }

  decide(
    command: DecideDurableApprovalRequestCommand,
  ): Promise<DecideApprovalRequestResult> {
    const audit = normalizeSecurityAuditRecord(command.audit);
    return this.#enqueue(() => {
      this.#client.exec('BEGIN IMMEDIATE');
      try {
        this.#confirmMutation();
        const current = this.#request(command.requestId);
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
          const storedAudit = this.#audit(audit.eventId);
          if (!storedAudit || !same(storedAudit, audit)) {
            throw new ApprovalMutationConflictError();
          }
          this.#client.exec('COMMIT');
          return Object.freeze({
            status: 'existing' as const,
            request,
          });
        }
        this.#assertFence(
          request.projectId,
          command.principal.subject,
          command.authorizationFence,
        );
        this.#updateRequest(request, command.expectedVersion);
        this.#insertAudit(audit);
        this.#client.exec('COMMIT');
        return Object.freeze({ status: 'decided' as const, request });
      } catch (error) {
        if (this.#client.isTransaction) this.#client.exec('ROLLBACK');
        throw error;
      }
    });
  }

  consume(
    command: ConsumeDurableApprovalRequestCommand,
  ): Promise<ConsumeDurableApprovalRequestResult> {
    const audit = normalizeSecurityAuditRecord(command.audit);
    return this.#enqueue(() => {
      this.#client.exec('BEGIN IMMEDIATE');
      try {
        this.#confirmMutation();
        const current = this.#request(command.requestId);
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
          const storedAudit = this.#audit(audit.eventId);
          const dispatch = this.#dispatch(result.dispatch.id);
          const execution = findLocalApprovedActionExecution(
            this.#client,
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
          this.#client.exec('COMMIT');
          return Object.freeze({
            status: 'existing' as const,
            request: result.request,
            dispatch: result.dispatch,
          });
        }
        this.#assertFence(
          result.request.projectId,
          command.requestedBy,
          command.authorizationFence,
        );
        this.#insertDispatch(result.dispatch);
        insertLocalApprovedActionExecutionBaseline(
          this.#client,
          result.dispatch,
        );
        this.#updateRequest(result.request, command.expectedVersion);
        this.#insertAudit(audit);
        this.#client.exec('COMMIT');
        return Object.freeze({
          status: 'consumed' as const,
          request: result.request,
          dispatch: result.dispatch,
        });
      } catch (error) {
        if (this.#client.isTransaction) this.#client.exec('ROLLBACK');
        throw error;
      }
    });
  }
}

import type { DatabaseSync } from 'node:sqlite';

import {
  ApprovalPolicyFenceConflictError,
  approvedActionDispatchDigest,
  normalizeApprovedActionDispatchRecord,
  normalizeApprovedActionFence,
  type ApprovedActionDispatchRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  PluginPackageAdmissionBindingConflictError,
  PluginPackageAdmissionReceiptConflictError,
  assertPluginPackageAdmissionReplay,
  bindPluginPackageAdmission,
  normalizePluginPackageAdmissionReceipt,
  normalizePluginPackageAdmissionRequest,
  type PluginPackageAdmissionReceipt,
  type PluginPackageAdmissionRepository,
  type PluginPackageAdmissionRequest,
  type PluginPackageAdmissionResult,
} from '@qinglong/runtime-core/plugin-package-admission';
import {
  InvalidPluginPackageInstallError,
  PluginPackageInstallMutationConflictError,
  PluginPackageInstallTransitionConflictError,
  PluginPackageInstallUnavailableError,
  assertPluginPackageInstallInventoryPageSize,
  assertPluginPackageInstallRecoveryPageSize,
  normalizePluginPackageInstallCreate,
  normalizePluginPackageInstallInventoryCursor,
  normalizePluginPackageInstallRecord,
  normalizePluginPackageInstallRecoveryCursor,
  normalizePluginPackageLock,
  pluginPackageInstallCommit,
  pluginPackageInstallCreate,
  type PluginPackageInstallCommit,
  type PluginPackageInstallCreate,
  type PluginPackageInstallInventoryItem,
  type PluginPackageInstallInventoryPage,
  type PluginPackageInstallInventoryRepository,
  type PluginPackageInstallRecord,
  type PluginPackageInstallRecoveryPage,
  type PluginPackageInstallRepository,
  type PluginPackageLock,
} from '@qinglong/runtime-core/plugin-package-install';
import {
  normalizePluginPackageQuarantineEvent,
  normalizePluginPackageWithdrawalReceipt,
  type PluginPackageQuarantineEvent,
  type PluginPackageWithdrawalReceipt,
} from '@qinglong/runtime-core/plugin-package-quarantine';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';

import { findLocalApprovedActionExecution } from '../approved-action/approvedActionExecutionRepository';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { findLocalPluginPackageInstallProposal } from './pluginPackageProposalRepository';

type Row = Record<string, unknown>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const RECORD_SELECT = `
  install."record_json" AS "recordJson"
`;
const LOCK_SELECT = `
  install."lock_json" AS "lockJson"
`;
const INVENTORY_SELECT = `
  ${RECORD_SELECT},
  quarantine."event_json" AS "quarantineEventJson",
  withdrawal."receipt_json" AS "withdrawalReceiptJson"
`;

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidPluginPackageInstallError(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    throw new InvalidPluginPackageInstallError(
      `${label} must contain enumerable data properties`,
    );
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidPluginPackageInstallError(`${label} shape is invalid`);
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new PluginPackageInstallUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) {
    throw new PluginPackageInstallUnavailableError();
  }
  return value as number;
}

function databaseNowMs(client: DatabaseSync): number {
  const row = client
    .prepare(`SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS "nowMs"`)
    .get() as Row;
  return integer(row, 'nowMs');
}

function parseRecord(row: Row): Readonly<PluginPackageInstallRecord> {
  try {
    return normalizePluginPackageInstallRecord(
      JSON.parse(text(row, 'recordJson')) as PluginPackageInstallRecord,
    );
  } catch (error) {
    if (error instanceof PluginPackageInstallUnavailableError) throw error;
    throw new PluginPackageInstallUnavailableError();
  }
}

function parseLock(row: Row): Readonly<PluginPackageLock> {
  try {
    return normalizePluginPackageLock(
      JSON.parse(text(row, 'lockJson')) as PluginPackageLock,
    );
  } catch (error) {
    if (error instanceof PluginPackageInstallUnavailableError) throw error;
    throw new PluginPackageInstallUnavailableError();
  }
}

function parseInventoryItem(
  row: Row,
): Readonly<PluginPackageInstallInventoryItem> {
  const record = parseRecord(row);
  const eventJson = nullableText(row, 'quarantineEventJson');
  const receiptJson = nullableText(row, 'withdrawalReceiptJson');
  if (eventJson === null && receiptJson === null) {
    return Object.freeze({ record, quarantine: null });
  }
  if (eventJson === null || receiptJson === null) {
    throw new PluginPackageInstallUnavailableError();
  }
  try {
    const event = normalizePluginPackageQuarantineEvent(
      JSON.parse(eventJson) as PluginPackageQuarantineEvent,
    );
    const receipt = normalizePluginPackageWithdrawalReceipt(
      JSON.parse(receiptJson) as PluginPackageWithdrawalReceipt,
    );
    if (
      event.target.projectId !== record.projectId ||
      event.target.packageName !== record.packageName ||
      event.target.installationId !== record.installationId ||
      event.target.lockDigest !== record.lockDigest ||
      event.target.installRecordDigest !== record.recordDigest ||
      receipt.eventDigest !== event.eventDigest ||
      receipt.target.installRecordDigest !== record.recordDigest
    ) {
      throw new PluginPackageInstallUnavailableError();
    }
    return Object.freeze({
      record,
      quarantine: Object.freeze({
        eventDigest: event.eventDigest,
        reasonCode: event.reasonCode,
        authorizationMode: event.authorizationMode,
        occurredAtMs: event.occurredAtMs,
        capabilityStatus: receipt.capability.status,
        receiptDigest: receipt.receiptDigest,
        committedAtMs: receipt.committedAtMs,
      }),
    });
  } catch (error) {
    if (error instanceof PluginPackageInstallUnavailableError) throw error;
    throw new PluginPackageInstallUnavailableError();
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
      throw new PluginPackageInstallUnavailableError();
    }
    return dispatch;
  } catch (error) {
    if (error instanceof PluginPackageInstallUnavailableError) throw error;
    throw new PluginPackageInstallUnavailableError();
  }
}

function parseReceipt(row: Row): Readonly<PluginPackageAdmissionReceipt> {
  try {
    const receipt = normalizePluginPackageAdmissionReceipt(
      JSON.parse(text(row, 'receiptJson')) as PluginPackageAdmissionReceipt,
    );
    if (receipt.receiptDigest !== text(row, 'receiptDigest')) {
      throw new PluginPackageInstallUnavailableError();
    }
    return receipt;
  } catch (error) {
    if (error instanceof PluginPackageInstallUnavailableError) throw error;
    throw new PluginPackageInstallUnavailableError();
  }
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') {
    throw new PluginPackageInstallUnavailableError();
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new PluginPackageInstallUnavailableError();
  }
  return value as number | null;
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
    if (error instanceof PluginPackageInstallUnavailableError) throw error;
    throw new PluginPackageInstallUnavailableError();
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function storageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageInstallError ||
    error instanceof PluginPackageInstallMutationConflictError ||
    error instanceof PluginPackageInstallTransitionConflictError ||
    error instanceof PluginPackageInstallUnavailableError ||
    error instanceof PluginPackageAdmissionBindingConflictError ||
    error instanceof PluginPackageAdmissionReceiptConflictError ||
    error instanceof ApprovalPolicyFenceConflictError
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
    return new PluginPackageInstallTransitionConflictError();
  }
  return new PluginPackageInstallUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

function normalizeCreateCommand(
  value: PluginPackageInstallCreate,
): Readonly<PluginPackageInstallCreate> {
  return normalizePluginPackageInstallCreate(value);
}

function normalizeCommitCommand(
  value: PluginPackageInstallCommit,
): Readonly<PluginPackageInstallCommit> {
  const command = dataRecord(value, 'commit command');
  exactKeys(
    command,
    [
      'installationId',
      'expectedVersion',
      'expectedRecordDigest',
      'mutationId',
      'mutationDigest',
      'record',
    ],
    'commit command',
  );
  const record = normalizePluginPackageInstallRecord(value.record);
  if (
    value.installationId !== record.installationId ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 1 ||
    value.expectedVersion >= record.version ||
    typeof value.expectedRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.expectedRecordDigest) ||
    value.mutationId !== record.lastMutationId ||
    value.mutationDigest !== record.lastMutationDigest
  ) {
    throw new InvalidPluginPackageInstallError('commit command is invalid');
  }
  return Object.freeze({
    installationId: record.installationId,
    expectedVersion: value.expectedVersion,
    expectedRecordDigest: value.expectedRecordDigest,
    mutationId: record.lastMutationId,
    mutationDigest: record.lastMutationDigest,
    record,
  });
}

export class LocalSqlitePluginPackageInstallRepository
  implements
    PluginPackageAdmissionRepository,
    PluginPackageInstallRepository,
    PluginPackageInstallInventoryRepository
{
  readonly #authority: LocalSqliteOperationAuthority;
  readonly #client: DatabaseSync;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.#client = this.#authority.client;
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
      () => new PluginPackageInstallUnavailableError(),
    );
  }

  #recordByInstallation(
    installationId: string,
  ): Readonly<PluginPackageInstallRecord> | null {
    const row = this.#client
      .prepare(
        `SELECT ${RECORD_SELECT}
         FROM "QingLong3PluginPackageInstalls" AS install
         WHERE install."installation_id" = ?`,
      )
      .get(installationId) as Row | undefined;
    return row ? parseRecord(row) : null;
  }

  #headRecord(
    projectId: string,
    packageName: string,
  ): Readonly<PluginPackageInstallRecord> | null {
    const row = this.#client
      .prepare(
        `SELECT ${RECORD_SELECT}
         FROM "QingLong3PluginPackageInstallHeads" AS head
         JOIN "QingLong3PluginPackageInstalls" AS install
           ON install."installation_id" = head."installation_id"
         WHERE head."project_id" = ? AND head."package_name" = ?`,
      )
      .get(projectId, packageName) as Row | undefined;
    return row ? parseRecord(row) : null;
  }

  #mutation(
    installationId: string,
    mutationId: string,
  ):
    | Readonly<{
        mutationDigest: string;
        resultingRecordDigest: string;
      }>
    | undefined {
    const row = this.#client
      .prepare(
        `SELECT "mutation_digest" AS "mutationDigest",
                "resulting_record_digest" AS "resultingRecordDigest"
         FROM "QingLong3PluginPackageInstallMutations"
         WHERE "installation_id" = ? AND "mutation_id" = ?`,
      )
      .get(installationId, mutationId) as Row | undefined;
    if (!row) return undefined;
    return Object.freeze({
      mutationDigest: text(row, 'mutationDigest'),
      resultingRecordDigest: text(row, 'resultingRecordDigest'),
    });
  }

  #insertRecord(
    lock: Readonly<PluginPackageLock>,
    record: Readonly<PluginPackageInstallRecord>,
  ): void {
    this.#client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageInstalls" (
           "installation_id", "project_id", "package_name", "package_version",
           "operation", "lock_digest", "target_generation",
           "previous_active_lock_digest", "active_lock_digest", "state",
           "version", "last_mutation_id", "last_mutation_digest",
           "lock_json", "record_json", "record_digest",
           "created_at_ms", "updated_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.installationId,
        record.projectId,
        record.packageName,
        record.packageVersion,
        record.operation,
        record.lockDigest,
        record.targetGeneration,
        record.previousActiveLockDigest,
        record.activeLockDigest,
        record.state,
        record.version,
        record.lastMutationId,
        record.lastMutationDigest,
        JSON.stringify(lock),
        JSON.stringify(record),
        record.recordDigest,
        record.createdAtMs,
        record.updatedAtMs,
      );
  }

  #insertMutation(
    record: Readonly<PluginPackageInstallRecord>,
    mutationDigest = record.lastMutationDigest,
  ): void {
    this.#client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageInstallMutations" (
           "installation_id", "mutation_id", "mutation_digest",
           "resulting_record_digest", "occurred_at_ms"
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.installationId,
        record.lastMutationId,
        mutationDigest,
        record.recordDigest,
        record.updatedAtMs,
      );
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

  #admissionReceipt(
    dispatchId: string,
  ): Readonly<PluginPackageAdmissionReceipt> | null {
    const row = this.#client
      .prepare(
        `SELECT "receipt_json" AS "receiptJson",
                "receipt_digest" AS "receiptDigest"
         FROM "QingLong3PluginPackageAdmissionReceipts"
         WHERE "dispatch_id" = ?`,
      )
      .get(dispatchId) as Row | undefined;
    return row ? parseReceipt(row) : null;
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

  #insertAdmissionReceipt(
    receipt: Readonly<PluginPackageAdmissionReceipt>,
  ): void {
    this.#client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageAdmissionReceipts" (
           "dispatch_id", "dispatch_digest", "approval_request_id",
           "action_ref", "project_id", "package_name", "installation_id",
           "lock_digest", "record_digest", "mutation_id", "mutation_digest",
           "audit_event_id", "admitted_at_ms", "receipt_json",
           "receipt_digest"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.dispatchId,
        receipt.dispatchDigest,
        receipt.approvalRequestId,
        receipt.actionRef,
        receipt.projectId,
        receipt.packageName,
        receipt.installationId,
        receipt.lockDigest,
        receipt.recordDigest,
        receipt.mutationId,
        receipt.mutationDigest,
        receipt.auditEventId,
        receipt.admittedAtMs,
        JSON.stringify(receipt),
        receipt.receiptDigest,
      );
  }

  find(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageInstallRecord> | null> {
    if (
      typeof projectId !== 'string' ||
      !IDENTIFIER_PATTERN.test(projectId) ||
      typeof packageName !== 'string' ||
      !PACKAGE_NAME_PATTERN.test(packageName)
    ) {
      throw new InvalidPluginPackageInstallError(
        'repository lookup identity is invalid',
      );
    }
    return this.#enqueue(() => this.#headRecord(projectId, packageName));
  }

  findCurrent(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageInstallInventoryItem> | null> {
    if (
      typeof projectId !== 'string' ||
      !IDENTIFIER_PATTERN.test(projectId) ||
      typeof packageName !== 'string' ||
      !PACKAGE_NAME_PATTERN.test(packageName)
    ) {
      throw new InvalidPluginPackageInstallError(
        'inventory lookup identity is invalid',
      );
    }
    return this.#enqueue(() => {
      const row = this.#client
        .prepare(
          `SELECT ${INVENTORY_SELECT}
           FROM "QingLong3PluginPackageInstallHeads" AS head
           JOIN "QingLong3PluginPackageInstalls" AS install
             ON install."installation_id" = head."installation_id"
           LEFT JOIN "QingLong3PluginPackageQuarantineEvents" AS quarantine
             ON quarantine."project_id" = install."project_id"
            AND quarantine."package_name" = install."package_name"
            AND quarantine."installation_id" = install."installation_id"
            AND quarantine."lock_digest" = install."lock_digest"
            AND quarantine."install_record_digest" = install."record_digest"
           LEFT JOIN "QingLong3PluginPackageWithdrawalReceipts" AS withdrawal
             ON withdrawal."event_digest" = quarantine."event_digest"
           WHERE head."project_id" = ? AND head."package_name" = ?`,
        )
        .get(projectId, packageName) as Row | undefined;
      return row ? parseInventoryItem(row) : null;
    });
  }

  listCurrentPage(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: Readonly<{ packageName: string }>;
  }): Promise<Readonly<PluginPackageInstallInventoryPage>> {
    const value = dataRecord(options, 'inventory page options');
    const keys = Object.keys(value);
    if (
      !keys.includes('projectId') ||
      !keys.includes('limit') ||
      keys.some((key) => !['after', 'limit', 'projectId'].includes(key)) ||
      typeof options.projectId !== 'string' ||
      !IDENTIFIER_PATTERN.test(options.projectId)
    ) {
      throw new InvalidPluginPackageInstallError(
        'inventory page options are invalid',
      );
    }
    assertPluginPackageInstallInventoryPageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizePluginPackageInstallInventoryCursor(options.after);
    return this.#enqueue(() => {
      const rows = this.#client
        .prepare(
          `SELECT ${INVENTORY_SELECT}
           FROM "QingLong3PluginPackageInstallHeads" AS head
           JOIN "QingLong3PluginPackageInstalls" AS install
             ON install."installation_id" = head."installation_id"
           LEFT JOIN "QingLong3PluginPackageQuarantineEvents" AS quarantine
             ON quarantine."project_id" = install."project_id"
            AND quarantine."package_name" = install."package_name"
            AND quarantine."installation_id" = install."installation_id"
            AND quarantine."lock_digest" = install."lock_digest"
            AND quarantine."install_record_digest" = install."record_digest"
           LEFT JOIN "QingLong3PluginPackageWithdrawalReceipts" AS withdrawal
             ON withdrawal."event_digest" = quarantine."event_digest"
           WHERE head."project_id" = ?
             AND head."package_name" > ?
           ORDER BY head."package_name"
           LIMIT ?`,
        )
        .all(
          options.projectId,
          after?.packageName ?? '',
          options.limit + 1,
        ) as Row[];
      const truncated = rows.length > options.limit;
      const items = Object.freeze(
        rows.slice(0, options.limit).map(parseInventoryItem),
      );
      const last = items.at(-1);
      return Object.freeze({
        items,
        truncated,
        ...(truncated && last
          ? {
              next: Object.freeze({
                packageName: last.record.packageName,
              }),
            }
          : {}),
      });
    });
  }

  findLock(lockDigest: string): Promise<Readonly<PluginPackageLock> | null> {
    if (typeof lockDigest !== 'string' || !DIGEST_PATTERN.test(lockDigest)) {
      throw new InvalidPluginPackageInstallError(
        'repository lock digest is invalid',
      );
    }
    return this.#enqueue(() => {
      const rows = this.#client
        .prepare(
          `SELECT ${LOCK_SELECT}
           FROM "QingLong3PluginPackageInstalls" AS install
           WHERE install."lock_digest" = ?
           LIMIT 2`,
        )
        .all(lockDigest) as Row[];
      if (rows.length === 0) return null;
      if (rows.length !== 1) {
        throw new PluginPackageInstallUnavailableError();
      }
      const lock = parseLock(rows[0]!);
      if (lock.lockDigest !== lockDigest) {
        throw new PluginPackageInstallUnavailableError();
      }
      return lock;
    });
  }

  findAdmissionReceipt(
    dispatchId: string,
  ): Promise<Readonly<PluginPackageAdmissionReceipt> | null> {
    if (
      typeof dispatchId !== 'string' ||
      !IDENTIFIER_PATTERN.test(dispatchId)
    ) {
      throw new InvalidPluginPackageInstallError(
        'admission receipt lookup identity is invalid',
      );
    }
    return this.#enqueue(() => this.#admissionReceipt(dispatchId));
  }

  admit(
    value: PluginPackageAdmissionRequest,
  ): Promise<Readonly<PluginPackageAdmissionResult>> {
    const request = normalizePluginPackageAdmissionRequest(value);
    return this.#enqueue(() => {
      this.#client.exec('BEGIN IMMEDIATE');
      try {
        const dispatch = this.#dispatch(request.lock.approval.dispatchId);
        if (!dispatch) {
          throw new PluginPackageAdmissionBindingConflictError();
        }
        const proposal = findLocalPluginPackageInstallProposal(
          this.#client,
          dispatch.action.actionRef,
        );
        if (!proposal) {
          throw new PluginPackageAdmissionBindingConflictError();
        }
        const existingReceipt = this.#admissionReceipt(dispatch.id);
        if (existingReceipt) {
          const record = this.#recordByInstallation(
            existingReceipt.installationId,
          );
          const audit = this.#audit(existingReceipt.auditEventId);
          if (!record || !audit || !same(audit, request.audit)) {
            throw new PluginPackageAdmissionReceiptConflictError();
          }
          assertPluginPackageAdmissionReplay(
            dispatch,
            proposal,
            request,
            existingReceipt,
            record,
          );
          this.#client.exec('COMMIT');
          return Object.freeze({
            status: 'existing' as const,
            record,
            receipt: existingReceipt,
          });
        }
        if (this.#recordByInstallation(request.installationId)) {
          throw new PluginPackageAdmissionReceiptConflictError();
        }
        const previous = this.#headRecord(
          request.lock.projectId,
          request.lock.packageName,
        );
        const execution = findLocalApprovedActionExecution(
          this.#client,
          dispatch.id,
        );
        if (!execution) {
          throw new PluginPackageAdmissionBindingConflictError();
        }
        const observedAtMs = databaseNowMs(this.#client);
        const bound = bindPluginPackageAdmission(
          dispatch,
          proposal,
          execution,
          request,
          previous,
          observedAtMs,
        );
        this.#assertFence(
          dispatch.projectId,
          dispatch.requestedBy,
          dispatch.approvalFence,
        );
        this.#insertRecord(bound.create.lock, bound.create.record);
        this.#insertMutation(bound.create.record, bound.create.mutationDigest);
        if (previous === null) {
          this.#client
            .prepare(
              `INSERT INTO "QingLong3PluginPackageInstallHeads" (
                 "project_id", "package_name", "installation_id"
               ) VALUES (?, ?, ?)`,
            )
            .run(
              bound.create.record.projectId,
              bound.create.record.packageName,
              bound.create.record.installationId,
            );
        } else {
          const update = this.#client
            .prepare(
              `UPDATE "QingLong3PluginPackageInstallHeads"
               SET "installation_id" = ?
               WHERE "project_id" = ? AND "package_name" = ?
                 AND "installation_id" = ?`,
            )
            .run(
              bound.create.record.installationId,
              bound.create.record.projectId,
              bound.create.record.packageName,
              previous.installationId,
            );
          if (update.changes !== 1) {
            throw new PluginPackageInstallTransitionConflictError();
          }
        }
        this.#insertAudit(request.audit);
        this.#insertAdmissionReceipt(bound.receipt);
        this.#client.exec('COMMIT');
        return Object.freeze({
          status: 'admitted' as const,
          record: bound.create.record,
          receipt: bound.receipt,
        });
      } catch (error) {
        if (this.#client.isTransaction) this.#client.exec('ROLLBACK');
        throw error;
      }
    });
  }

  create(value: Readonly<PluginPackageInstallCreate>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      record: Readonly<PluginPackageInstallRecord>;
    }>
  > {
    const command = normalizeCreateCommand(value);
    return this.#enqueue(() => {
      this.#client.exec('BEGIN IMMEDIATE');
      try {
        const replay = this.#mutation(
          command.installationId,
          command.mutationId,
        );
        if (replay) {
          if (
            replay.mutationDigest !== command.mutationDigest ||
            replay.resultingRecordDigest !== command.record.recordDigest
          ) {
            throw new PluginPackageInstallMutationConflictError();
          }
          const current = this.#recordByInstallation(command.installationId);
          if (!current) throw new PluginPackageInstallUnavailableError();
          this.#client.exec('COMMIT');
          return Object.freeze({
            status: 'existing' as const,
            record: current,
          });
        }
        if (this.#recordByInstallation(command.installationId)) {
          throw new PluginPackageInstallTransitionConflictError();
        }
        const project = this.#client
          .prepare(
            `SELECT "status" AS "status"
             FROM "QingLong3Projects" WHERE "id" = ?`,
          )
          .get(command.record.projectId) as Row | undefined;
        if (project?.status !== 'active') {
          throw new PluginPackageInstallTransitionConflictError();
        }
        const previous = this.#headRecord(
          command.record.projectId,
          command.record.packageName,
        );
        const canonical = pluginPackageInstallCreate(
          command.lock,
          command.record,
          previous,
        );
        if (!same(canonical, command)) {
          throw new PluginPackageInstallTransitionConflictError();
        }

        this.#insertRecord(command.lock, command.record);
        this.#insertMutation(command.record, command.mutationDigest);
        if (previous === null) {
          this.#client
            .prepare(
              `INSERT INTO "QingLong3PluginPackageInstallHeads" (
                 "project_id", "package_name", "installation_id"
               ) VALUES (?, ?, ?)`,
            )
            .run(
              command.record.projectId,
              command.record.packageName,
              command.record.installationId,
            );
        } else {
          const update = this.#client
            .prepare(
              `UPDATE "QingLong3PluginPackageInstallHeads"
               SET "installation_id" = ?
               WHERE "project_id" = ? AND "package_name" = ?
                 AND "installation_id" = ?`,
            )
            .run(
              command.record.installationId,
              command.record.projectId,
              command.record.packageName,
              previous.installationId,
            );
          if (update.changes !== 1) {
            throw new PluginPackageInstallTransitionConflictError();
          }
        }
        this.#client.exec('COMMIT');
        return Object.freeze({
          status: 'created' as const,
          record: command.record,
        });
      } catch (error) {
        if (this.#client.isTransaction) this.#client.exec('ROLLBACK');
        throw error;
      }
    });
  }

  commit(value: Readonly<PluginPackageInstallCommit>): Promise<
    Readonly<{
      status: 'committed' | 'existing';
      record: Readonly<PluginPackageInstallRecord>;
    }>
  > {
    const command = normalizeCommitCommand(value);
    return this.#enqueue(() => {
      this.#client.exec('BEGIN IMMEDIATE');
      try {
        const replay = this.#mutation(
          command.installationId,
          command.mutationId,
        );
        if (replay) {
          if (
            replay.mutationDigest !== command.mutationDigest ||
            replay.resultingRecordDigest !== command.record.recordDigest
          ) {
            throw new PluginPackageInstallMutationConflictError();
          }
          const current = this.#recordByInstallation(command.installationId);
          if (!current) throw new PluginPackageInstallUnavailableError();
          this.#client.exec('COMMIT');
          return Object.freeze({
            status: 'existing' as const,
            record: current,
          });
        }
        const current = this.#recordByInstallation(command.installationId);
        if (!current) {
          throw new PluginPackageInstallTransitionConflictError();
        }
        const head = this.#headRecord(current.projectId, current.packageName);
        if (!head || head.installationId !== current.installationId) {
          throw new PluginPackageInstallTransitionConflictError();
        }
        const canonical = pluginPackageInstallCommit(current, command.record);
        if (
          current.version !== command.expectedVersion ||
          current.recordDigest !== command.expectedRecordDigest ||
          !same(canonical, command)
        ) {
          throw new PluginPackageInstallTransitionConflictError();
        }
        const record = command.record;
        const update = this.#client
          .prepare(
            `UPDATE "QingLong3PluginPackageInstalls"
             SET "package_version" = ?, "operation" = ?, "lock_digest" = ?,
                 "target_generation" = ?, "previous_active_lock_digest" = ?,
                 "active_lock_digest" = ?, "state" = ?, "version" = ?,
                 "last_mutation_id" = ?, "last_mutation_digest" = ?,
                 "record_json" = ?, "record_digest" = ?, "updated_at_ms" = ?
             WHERE "installation_id" = ? AND "version" = ?
               AND "record_digest" = ?`,
          )
          .run(
            record.packageVersion,
            record.operation,
            record.lockDigest,
            record.targetGeneration,
            record.previousActiveLockDigest,
            record.activeLockDigest,
            record.state,
            record.version,
            record.lastMutationId,
            record.lastMutationDigest,
            JSON.stringify(record),
            record.recordDigest,
            record.updatedAtMs,
            record.installationId,
            command.expectedVersion,
            command.expectedRecordDigest,
          );
        if (update.changes !== 1) {
          throw new PluginPackageInstallTransitionConflictError();
        }
        this.#insertMutation(record);
        this.#client.exec('COMMIT');
        return Object.freeze({
          status: 'committed' as const,
          record,
        });
      } catch (error) {
        if (this.#client.isTransaction) this.#client.exec('ROLLBACK');
        throw error;
      }
    });
  }

  listRecoveryPage(options: {
    readonly limit: number;
    readonly after?: Readonly<{
      packageName: string;
      installationId: string;
    }>;
  }): Promise<Readonly<PluginPackageInstallRecoveryPage>> {
    const value = dataRecord(options, 'recovery page options');
    const keys = Object.keys(value);
    if (
      !keys.includes('limit') ||
      keys.some((key) => !['after', 'limit'].includes(key))
    ) {
      throw new InvalidPluginPackageInstallError(
        'recovery page options shape is invalid',
      );
    }
    assertPluginPackageInstallRecoveryPageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizePluginPackageInstallRecoveryCursor(options.after);
    return this.#enqueue(() => {
      const rows = this.#client
        .prepare(
          `SELECT ${RECORD_SELECT}
           FROM "QingLong3PluginPackageInstallHeads" AS head
           JOIN "QingLong3PluginPackageInstalls" AS install
             ON install."installation_id" = head."installation_id"
           WHERE install."state" IN ('queued','staged','activating')
             AND NOT EXISTS (
               SELECT 1
               FROM "QingLong3PluginPackageQuarantineEvents" AS quarantine
               WHERE quarantine."project_id" = install."project_id"
                 AND quarantine."package_name" = install."package_name"
                 AND quarantine."installation_id" =
                   install."installation_id"
                 AND quarantine."lock_digest" = install."lock_digest"
             )
             AND (
               install."package_name" > ? OR
               (install."package_name" = ? AND install."installation_id" > ?)
             )
           ORDER BY install."package_name", install."installation_id"
           LIMIT ?`,
        )
        .all(
          after?.packageName ?? '',
          after?.packageName ?? '',
          after?.installationId ?? '',
          options.limit + 1,
        ) as Row[];
      const truncated = rows.length > options.limit;
      const records = Object.freeze(
        rows.slice(0, options.limit).map(parseRecord),
      );
      const last = records.at(-1);
      return Object.freeze({
        records,
        truncated,
        ...(truncated && last
          ? {
              next: Object.freeze({
                packageName: last.packageName,
                installationId: last.installationId,
              }),
            }
          : {}),
      });
    });
  }
}

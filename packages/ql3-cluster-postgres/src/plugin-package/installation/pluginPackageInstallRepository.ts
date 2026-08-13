// PostgreSQL admission, install commit, inventory and recovery authority.
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  ApprovalPolicyFenceConflictError,
  approvedActionDispatchDigest,
  normalizeApprovedActionDispatchRecord,
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

import { findPostgresApprovedActionExecution } from '../../approved-action/approvedActionExecutionRepository';
import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../../repository/definitionRepositorySupport';
import { findPostgresPluginPackageInstallProposal } from './pluginPackageProposalRepository';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const RECORD_SELECT = 'install.record_json AS "recordJson"';
const LOCK_SELECT = 'install.lock_json AS "lockJson"';
const INVENTORY_SELECT = `${RECORD_SELECT},
  quarantine.event_json AS "quarantineEventJson",
  withdrawal.receipt_json AS "withdrawalReceiptJson"`;

function unavailable(): PluginPackageInstallUnavailableError {
  return new PluginPackageInstallUnavailableError();
}

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

function parseRecord(row: Row): Readonly<PluginPackageInstallRecord> {
  try {
    return normalizePluginPackageInstallRecord(
      postgresRequiredJsonObject(
        row.recordJson,
        unavailable,
      ) as unknown as PluginPackageInstallRecord,
    );
  } catch (error) {
    if (error instanceof PluginPackageInstallUnavailableError) throw error;
    throw unavailable();
  }
}

function parseLock(row: Row): Readonly<PluginPackageLock> {
  try {
    return normalizePluginPackageLock(
      postgresRequiredJsonObject(
        row.lockJson,
        unavailable,
      ) as unknown as PluginPackageLock,
    );
  } catch (error) {
    if (error instanceof PluginPackageInstallUnavailableError) throw error;
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
    if (error instanceof PluginPackageInstallUnavailableError) throw error;
    throw unavailable();
  }
}

function parseReceipt(row: Row): Readonly<PluginPackageAdmissionReceipt> {
  try {
    const receipt = normalizePluginPackageAdmissionReceipt(
      postgresRequiredJsonObject(
        row.receiptJson,
        unavailable,
      ) as unknown as PluginPackageAdmissionReceipt,
    );
    if (
      receipt.receiptDigest !==
      postgresRequiredString(row.receiptDigest, unavailable)
    ) {
      throw unavailable();
    }
    return receipt;
  } catch (error) {
    if (error instanceof PluginPackageInstallUnavailableError) throw error;
    throw unavailable();
  }
}

function parseInventoryItem(
  row: Row,
): Readonly<PluginPackageInstallInventoryItem> {
  const record = parseRecord(row);
  if (row.quarantineEventJson === null && row.withdrawalReceiptJson === null) {
    return Object.freeze({ record, quarantine: null });
  }
  if (row.quarantineEventJson === null || row.withdrawalReceiptJson === null) {
    throw unavailable();
  }
  try {
    const event = normalizePluginPackageQuarantineEvent(
      postgresRequiredJsonObject(
        row.quarantineEventJson,
        unavailable,
      ) as unknown as PluginPackageQuarantineEvent,
    );
    const receipt = normalizePluginPackageWithdrawalReceipt(
      postgresRequiredJsonObject(
        row.withdrawalReceiptJson,
        unavailable,
      ) as unknown as PluginPackageWithdrawalReceipt,
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
      throw unavailable();
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
    throw unavailable();
  }
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return postgresRequiredString(value, unavailable);
}

function nullableInteger(value: unknown): number | null {
  if (value === null) return null;
  return postgresRequiredInteger(value, unavailable);
}

async function databaseNowMs(queryable: Queryable): Promise<number> {
  const result = await queryable.query<{ nowMs: unknown }>(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       AS "nowMs"`,
  );
  if (result.rows.length !== 1) throw unavailable();
  return postgresRequiredInteger(result.rows[0]?.nowMs, unavailable);
}

function parseAudit(row: Row): Readonly<SecurityAuditRecord> {
  try {
    const subjectType = nullableString(row.subjectType);
    const subjectId = nullableString(row.subjectId);
    const projectVersion = nullableInteger(row.projectVersion);
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
      reasons: row.reasons as readonly string[],
      fence:
        projectVersion === null
          ? null
          : {
              projectVersion,
              bindingVersion: nullableInteger(row.bindingVersion),
            },
      occurredAtMs: postgresRequiredInteger(row.occurredAtMs, unavailable),
    });
  } catch (error) {
    if (error instanceof PluginPackageInstallUnavailableError) throw error;
    throw unavailable();
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mappedError(error: unknown): Error {
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
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackageInstallTransitionConflictError();
  }
  return new PluginPackageInstallUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
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

async function recordByInstallation(
  queryable: Queryable,
  installationId: string,
): Promise<Readonly<PluginPackageInstallRecord> | null> {
  const result = await queryable.query<Row>(
    `SELECT ${RECORD_SELECT}
     FROM "ql3"."plugin_package_installs" AS install
     WHERE install.installation_id = $1
     LIMIT 2`,
    [installationId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseRecord(result.rows[0]!);
}

async function headRecord(
  queryable: Queryable,
  projectId: string,
  packageName: string,
  forUpdate = false,
): Promise<Readonly<PluginPackageInstallRecord> | null> {
  const result = await queryable.query<Row>(
    `SELECT ${RECORD_SELECT}
     FROM "ql3"."plugin_package_install_heads" AS head
     JOIN "ql3"."plugin_package_installs" AS install
       ON install.installation_id = head.installation_id
     WHERE head.project_id = $1 AND head.package_name = $2
     LIMIT 2
     ${forUpdate ? 'FOR UPDATE OF head, install' : ''}`,
    [projectId, packageName],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseRecord(result.rows[0]!);
}

async function mutation(
  queryable: Queryable,
  installationId: string,
  mutationId: string,
): Promise<
  | Readonly<{
      mutationDigest: string;
      resultingRecordDigest: string;
    }>
  | undefined
> {
  const result = await queryable.query<Row>(
    `SELECT mutation_digest AS "mutationDigest",
            resulting_record_digest AS "resultingRecordDigest"
     FROM "ql3"."plugin_package_install_mutations"
     WHERE installation_id = $1 AND mutation_id = $2
     LIMIT 2`,
    [installationId, mutationId],
  );
  if (result.rows.length === 0) return undefined;
  if (result.rows.length !== 1) throw unavailable();
  return Object.freeze({
    mutationDigest: postgresRequiredString(
      result.rows[0]!.mutationDigest,
      unavailable,
    ),
    resultingRecordDigest: postgresRequiredString(
      result.rows[0]!.resultingRecordDigest,
      unavailable,
    ),
  });
}

async function insertRecord(
  client: PostgresClient,
  lock: Readonly<PluginPackageLock>,
  record: Readonly<PluginPackageInstallRecord>,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO "ql3"."plugin_package_installs" (
       installation_id, project_id, package_name, package_version,
       operation, lock_digest, target_generation,
       previous_active_lock_digest, active_lock_digest, state, version,
       last_mutation_id, last_mutation_digest, lock_json, record_json,
       record_digest, created_at_ms, updated_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14::jsonb, $15::jsonb, $16, $17, $18
     )`,
    [
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
    ],
  );
  if (result.rowCount !== 1) throw unavailable();
}

async function insertMutation(
  client: PostgresClient,
  record: Readonly<PluginPackageInstallRecord>,
  mutationDigest = record.lastMutationDigest,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO "ql3"."plugin_package_install_mutations" (
       installation_id, mutation_id, mutation_digest,
       resulting_record_digest, occurred_at_ms
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      record.installationId,
      record.lastMutationId,
      mutationDigest,
      record.recordDigest,
      record.updatedAtMs,
    ],
  );
  if (result.rowCount !== 1) throw unavailable();
}

async function dispatchById(
  queryable: Queryable,
  dispatchId: string,
): Promise<Readonly<ApprovedActionDispatchRecord> | null> {
  const result = await queryable.query<Row>(
    `SELECT dispatch_json AS "dispatchJson",
            dispatch_digest AS "dispatchDigest"
     FROM "ql3"."approved_action_dispatches"
     WHERE dispatch_id = $1
     LIMIT 2`,
    [dispatchId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseDispatch(result.rows[0]!);
}

async function admissionReceiptByDispatch(
  queryable: Queryable,
  dispatchId: string,
): Promise<Readonly<PluginPackageAdmissionReceipt> | null> {
  const result = await queryable.query<Row>(
    `SELECT receipt_json AS "receiptJson",
            receipt_digest AS "receiptDigest"
     FROM "ql3"."plugin_package_admission_receipts"
     WHERE dispatch_id = $1
     LIMIT 2`,
    [dispatchId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseReceipt(result.rows[0]!);
}

async function auditById(
  queryable: Queryable,
  eventId: string,
): Promise<Readonly<SecurityAuditRecord> | null> {
  const result = await queryable.query<Row>(
    `SELECT event_id::text AS "eventId", request_id AS "requestId",
            operation_id AS "operationId", project_id AS "projectId",
            subject_type AS "subjectType", subject_id AS "subjectId",
            authentication_id AS "authenticationId", outcome,
            reasons, project_version AS "projectVersion",
            binding_version AS "bindingVersion",
            occurred_at_ms AS "occurredAtMs"
     FROM "ql3"."security_audit_events"
     WHERE event_id = $1::uuid
     LIMIT 2`,
    [eventId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseAudit(result.rows[0]!);
}

async function assertApprovalFence(
  client: PostgresClient,
  projectId: string,
  subject: Readonly<SecuritySubject>,
  fence: Readonly<SecurityPolicyFence>,
): Promise<void> {
  const result = await client.query<{ active: unknown }>(
    `SELECT "ql3"."lock_approval_policy_fence"(
       $1::varchar, $2::varchar, $3::varchar, $4::integer, $5::integer
     ) AS active`,
    [
      projectId,
      subject.type,
      subject.id,
      fence.projectVersion,
      fence.bindingVersion,
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.active !== true) {
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
       subject_id, authentication_id, outcome, reasons, project_version,
       binding_version, occurred_at_ms
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12
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

async function insertAdmissionReceipt(
  client: PostgresClient,
  receipt: Readonly<PluginPackageAdmissionReceipt>,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO "ql3"."plugin_package_admission_receipts" (
       dispatch_id, dispatch_digest, approval_request_id, action_ref,
       project_id, package_name, installation_id, lock_digest,
       record_digest, mutation_id, mutation_digest, audit_event_id,
       admitted_at_ms, receipt_json, receipt_digest
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid,
       $13, $14::jsonb, $15
     )`,
    [
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
    ],
  );
  if (result.rowCount !== 1) throw unavailable();
}

/**
 * Read-only PostgreSQL Plugin Package installation inventory adapter.
 *
 * This is exported only through the package-manager entrypoint so management
 * composition cannot acquire install mutation or admission authority merely to
 * serve inventory queries.
 */
export class PostgresPluginPackageInstallInventoryReader
  implements PluginPackageInstallInventoryRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError(
        'PostgreSQL Plugin Package install inventory pool is invalid',
      );
    }
  }

  async findCurrent(
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
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${INVENTORY_SELECT}
         FROM "ql3"."plugin_package_install_heads" AS head
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = head.installation_id
         LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
           ON quarantine.project_id = install.project_id
          AND quarantine.package_name = install.package_name
          AND quarantine.installation_id = install.installation_id
          AND quarantine.lock_digest = install.lock_digest
          AND quarantine.install_record_digest = install.record_digest
         LEFT JOIN "ql3"."plugin_package_withdrawal_receipts" AS withdrawal
           ON withdrawal.event_digest = quarantine.event_digest
         WHERE head.project_id = $1 AND head.package_name = $2
         LIMIT 2`,
        [projectId, packageName],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw unavailable();
      return parseInventoryItem(result.rows[0]!);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async listCurrentPage(options: {
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
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${INVENTORY_SELECT}
         FROM "ql3"."plugin_package_install_heads" AS head
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = head.installation_id
         LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
           ON quarantine.project_id = install.project_id
          AND quarantine.package_name = install.package_name
          AND quarantine.installation_id = install.installation_id
          AND quarantine.lock_digest = install.lock_digest
          AND quarantine.install_record_digest = install.record_digest
         LEFT JOIN "ql3"."plugin_package_withdrawal_receipts" AS withdrawal
           ON withdrawal.event_digest = quarantine.event_digest
         WHERE head.project_id = $1
           AND head.package_name > $2
         ORDER BY head.package_name
         LIMIT $3`,
        [options.projectId, after?.packageName ?? '', options.limit + 1],
      );
      const truncated = result.rows.length > options.limit;
      const items = Object.freeze(
        result.rows.slice(0, options.limit).map(parseInventoryItem),
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
    } catch (error) {
      throw mappedError(error);
    }
  }
}

/**
 * Administration-only PostgreSQL Plugin Package installation authority.
 * Production composition remains intentionally absent.
 */
export class PostgresPluginPackageInstallRepository
  implements
    PluginPackageAdmissionRepository,
    PluginPackageInstallRepository,
    PluginPackageInstallInventoryRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL Plugin Package install pool is invalid');
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

  async find(
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
    try {
      return await headRecord(this.pool, projectId, packageName);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async findCurrent(
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
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${INVENTORY_SELECT}
         FROM "ql3"."plugin_package_install_heads" AS head
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = head.installation_id
         LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
           ON quarantine.project_id = install.project_id
          AND quarantine.package_name = install.package_name
          AND quarantine.installation_id = install.installation_id
          AND quarantine.lock_digest = install.lock_digest
          AND quarantine.install_record_digest = install.record_digest
         LEFT JOIN "ql3"."plugin_package_withdrawal_receipts" AS withdrawal
           ON withdrawal.event_digest = quarantine.event_digest
         WHERE head.project_id = $1 AND head.package_name = $2
         LIMIT 2`,
        [projectId, packageName],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw unavailable();
      return parseInventoryItem(result.rows[0]!);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async listCurrentPage(options: {
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
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${INVENTORY_SELECT}
         FROM "ql3"."plugin_package_install_heads" AS head
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = head.installation_id
         LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
           ON quarantine.project_id = install.project_id
          AND quarantine.package_name = install.package_name
          AND quarantine.installation_id = install.installation_id
          AND quarantine.lock_digest = install.lock_digest
          AND quarantine.install_record_digest = install.record_digest
         LEFT JOIN "ql3"."plugin_package_withdrawal_receipts" AS withdrawal
           ON withdrawal.event_digest = quarantine.event_digest
         WHERE head.project_id = $1
           AND head.package_name > $2
         ORDER BY head.package_name
         LIMIT $3`,
        [options.projectId, after?.packageName ?? '', options.limit + 1],
      );
      const truncated = result.rows.length > options.limit;
      const items = Object.freeze(
        result.rows.slice(0, options.limit).map(parseInventoryItem),
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
    } catch (error) {
      throw mappedError(error);
    }
  }

  async findLock(
    lockDigest: string,
  ): Promise<Readonly<PluginPackageLock> | null> {
    if (typeof lockDigest !== 'string' || !DIGEST_PATTERN.test(lockDigest)) {
      throw new InvalidPluginPackageInstallError(
        'repository lock digest is invalid',
      );
    }
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${LOCK_SELECT}
         FROM "ql3"."plugin_package_installs" AS install
         WHERE install.lock_digest = $1
         LIMIT 2`,
        [lockDigest],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw unavailable();
      const lock = parseLock(result.rows[0]!);
      if (lock.lockDigest !== lockDigest) throw unavailable();
      return lock;
    } catch (error) {
      throw mappedError(error);
    }
  }

  async findAdmissionReceipt(
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
    try {
      return await admissionReceiptByDispatch(this.pool, dispatchId);
    } catch (error) {
      throw mappedError(error);
    }
  }

  admit(
    value: PluginPackageAdmissionRequest,
  ): Promise<Readonly<PluginPackageAdmissionResult>> {
    const request = normalizePluginPackageAdmissionRequest(value);
    return this.#transaction(async (client) => {
      const dispatch = await dispatchById(
        client,
        request.lock.approval.dispatchId,
      );
      if (!dispatch) {
        throw new PluginPackageAdmissionBindingConflictError();
      }
      const proposal = await findPostgresPluginPackageInstallProposal(
        client,
        dispatch.action.actionRef,
      );
      if (!proposal) {
        throw new PluginPackageAdmissionBindingConflictError();
      }
      const existingReceipt = await admissionReceiptByDispatch(
        client,
        dispatch.id,
      );
      if (existingReceipt) {
        const record = await recordByInstallation(
          client,
          existingReceipt.installationId,
        );
        const audit = await auditById(client, existingReceipt.auditEventId);
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
        return Object.freeze({
          status: 'existing' as const,
          record,
          receipt: existingReceipt,
        });
      }
      if (await recordByInstallation(client, request.installationId)) {
        throw new PluginPackageAdmissionReceiptConflictError();
      }
      await assertApprovalFence(
        client,
        dispatch.projectId,
        dispatch.requestedBy,
        dispatch.approvalFence,
      );
      const project = await client.query<{ active: unknown }>(
        `SELECT "ql3"."lock_active_plugin_package_project"($1) AS active`,
        [request.lock.projectId],
      );
      if (project.rows.length !== 1 || project.rows[0]?.active !== true) {
        throw new PluginPackageInstallTransitionConflictError();
      }
      const previous = await headRecord(
        client,
        request.lock.projectId,
        request.lock.packageName,
        true,
      );
      const execution = await findPostgresApprovedActionExecution(
        client,
        dispatch.id,
      );
      if (!execution) {
        throw new PluginPackageAdmissionBindingConflictError();
      }
      const observedAtMs = await databaseNowMs(client);
      const bound = bindPluginPackageAdmission(
        dispatch,
        proposal,
        execution,
        request,
        previous,
        observedAtMs,
      );
      await insertRecord(client, bound.create.lock, bound.create.record);
      await insertMutation(
        client,
        bound.create.record,
        bound.create.mutationDigest,
      );
      if (previous === null) {
        const inserted = await client.query(
          `INSERT INTO "ql3"."plugin_package_install_heads" (
             project_id, package_name, installation_id
           ) VALUES ($1, $2, $3)`,
          [
            bound.create.record.projectId,
            bound.create.record.packageName,
            bound.create.record.installationId,
          ],
        );
        if (inserted.rowCount !== 1) throw unavailable();
      } else {
        const updated = await client.query(
          `UPDATE "ql3"."plugin_package_install_heads"
           SET installation_id = $1
           WHERE project_id = $2 AND package_name = $3
             AND installation_id = $4`,
          [
            bound.create.record.installationId,
            bound.create.record.projectId,
            bound.create.record.packageName,
            previous.installationId,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new PluginPackageInstallTransitionConflictError();
        }
      }
      await insertAudit(client, request.audit);
      await insertAdmissionReceipt(client, bound.receipt);
      return Object.freeze({
        status: 'admitted' as const,
        record: bound.create.record,
        receipt: bound.receipt,
      });
    });
  }

  create(value: Readonly<PluginPackageInstallCreate>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      record: Readonly<PluginPackageInstallRecord>;
    }>
  > {
    const command = normalizePluginPackageInstallCreate(value);
    return this.#transaction(async (client) => {
      const replay = await mutation(
        client,
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
        const current = await recordByInstallation(
          client,
          command.installationId,
        );
        if (!current) throw unavailable();
        return Object.freeze({
          status: 'existing' as const,
          record: current,
        });
      }
      if (await recordByInstallation(client, command.installationId)) {
        throw new PluginPackageInstallTransitionConflictError();
      }
      const project = await client.query<{ active: unknown }>(
        `SELECT "ql3"."lock_active_plugin_package_project"($1) AS active`,
        [command.record.projectId],
      );
      if (project.rows.length !== 1 || project.rows[0]?.active !== true) {
        throw new PluginPackageInstallTransitionConflictError();
      }
      const previous = await headRecord(
        client,
        command.record.projectId,
        command.record.packageName,
        true,
      );
      const canonical = pluginPackageInstallCreate(
        command.lock,
        command.record,
        previous,
      );
      if (!same(canonical, command)) {
        throw new PluginPackageInstallTransitionConflictError();
      }

      await insertRecord(client, command.lock, command.record);
      await insertMutation(client, command.record, command.mutationDigest);
      if (previous === null) {
        const inserted = await client.query(
          `INSERT INTO "ql3"."plugin_package_install_heads" (
             project_id, package_name, installation_id
           ) VALUES ($1, $2, $3)`,
          [
            command.record.projectId,
            command.record.packageName,
            command.record.installationId,
          ],
        );
        if (inserted.rowCount !== 1) throw unavailable();
      } else {
        const updated = await client.query(
          `UPDATE "ql3"."plugin_package_install_heads"
           SET installation_id = $1
           WHERE project_id = $2 AND package_name = $3
             AND installation_id = $4`,
          [
            command.record.installationId,
            command.record.projectId,
            command.record.packageName,
            previous.installationId,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new PluginPackageInstallTransitionConflictError();
        }
      }
      return Object.freeze({
        status: 'created' as const,
        record: command.record,
      });
    });
  }

  commit(value: Readonly<PluginPackageInstallCommit>): Promise<
    Readonly<{
      status: 'committed' | 'existing';
      record: Readonly<PluginPackageInstallRecord>;
    }>
  > {
    const command = normalizeCommitCommand(value);
    return this.#transaction(async (client) => {
      const replay = await mutation(
        client,
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
        const current = await recordByInstallation(
          client,
          command.installationId,
        );
        if (!current) throw unavailable();
        return Object.freeze({
          status: 'existing' as const,
          record: current,
        });
      }
      const current = await recordByInstallation(
        client,
        command.installationId,
      );
      if (!current) {
        throw new PluginPackageInstallTransitionConflictError();
      }
      const head = await headRecord(
        client,
        current.projectId,
        current.packageName,
        true,
      );
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
      const updated = await client.query(
        `UPDATE "ql3"."plugin_package_installs"
         SET package_version = $1, operation = $2, lock_digest = $3,
             target_generation = $4, previous_active_lock_digest = $5,
             active_lock_digest = $6, state = $7, version = $8,
             last_mutation_id = $9, last_mutation_digest = $10,
             record_json = $11::jsonb, record_digest = $12,
             updated_at_ms = $13
         WHERE installation_id = $14 AND version = $15
           AND record_digest = $16`,
        [
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
        ],
      );
      if (updated.rowCount !== 1) {
        throw new PluginPackageInstallTransitionConflictError();
      }
      await insertMutation(client, record);
      return Object.freeze({
        status: 'committed' as const,
        record,
      });
    });
  }

  async listRecoveryPage(options: {
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
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${RECORD_SELECT}
         FROM "ql3"."plugin_package_install_heads" AS head
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = head.installation_id
         WHERE install.state IN ('queued', 'staged', 'activating')
           AND (
             install.state <> 'staged' OR
             install.previous_active_lock_digest IS NULL OR
             NOT (
               EXISTS (
                 SELECT 1
                   FROM "ql3"."plugin_package_admission_receipts" AS admission
                   JOIN "ql3"."plugin_package_install_proposals" AS proposal
                     ON proposal.action_ref = admission.action_ref
                  WHERE admission.installation_id = install.installation_id
                    AND jsonb_array_length(
                      proposal.proposal_json #> '{actionInput,manifest,spec,permissions,secrets}'
                    ) > 0
               ) OR
               EXISTS (
                 SELECT 1
                   FROM "ql3"."plugin_package_installs" AS previous
                   JOIN "ql3"."plugin_package_secret_bindings" AS binding
                     ON binding.installation_id = previous.installation_id
                  WHERE previous.project_id = install.project_id
                    AND previous.package_name = install.package_name
                    AND previous.lock_digest = install.previous_active_lock_digest
               )
             ) OR
             EXISTS (
               SELECT 1
                 FROM "ql3"."plugin_package_secret_binding_transition_receipts"
                      AS receipt
                WHERE receipt.project_id = install.project_id
                  AND receipt.package_name = install.package_name
                  AND receipt.installation_id = install.installation_id
                  AND receipt.lock_digest = install.lock_digest
                  AND receipt.generation = install.target_generation
                  AND receipt.manifest_digest = install.lock_json ->> 'manifestDigest'
                  AND receipt.previous_active_lock_digest =
                      install.previous_active_lock_digest
             )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM "ql3"."plugin_package_quarantine_events" AS quarantine
             WHERE quarantine.project_id = install.project_id
               AND quarantine.package_name = install.package_name
               AND quarantine.installation_id = install.installation_id
               AND quarantine.lock_digest = install.lock_digest
           )
           AND (
             install.package_name > $1 OR
             (
               install.package_name = $1
               AND install.installation_id > $2
             )
           )
         ORDER BY install.package_name, install.installation_id
         LIMIT $3`,
        [
          after?.packageName ?? '',
          after?.installationId ?? '',
          options.limit + 1,
        ],
      );
      const truncated = result.rows.length > options.limit;
      const records = Object.freeze(
        result.rows.slice(0, options.limit).map(parseRecord),
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
    } catch (error) {
      throw mappedError(error);
    }
  }
}

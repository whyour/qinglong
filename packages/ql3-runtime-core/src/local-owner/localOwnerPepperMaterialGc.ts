import { createHash } from 'node:crypto';
import { assertApiCredentialPepperKeyId } from '../security/identity-credential/apiCredential';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '../security/audit/securityAudit';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;

export const MIN_LOCAL_OWNER_PEPPER_ACK_RETENTION_MS = 7 * DAY_MS;
export const MIN_LOCAL_OWNER_PEPPER_AUDIT_RETENTION_MS = 30 * DAY_MS;
export const MIN_LOCAL_OWNER_PEPPER_BACKUP_RETENTION_MS = 30 * DAY_MS;
export const MAX_LOCAL_OWNER_PEPPER_RETENTION_MS = 10 * 365 * DAY_MS;

export interface LocalOwnerPepperMaterialGcRetentionPolicy {
  readonly version: 1;
  readonly acknowledgementRetentionMs: number;
  readonly auditRetentionMs: number;
  readonly backupRetentionMs: number;
}

export type LocalOwnerPepperMaterialGcState = 'prepared' | 'completed';

export interface LocalOwnerPepperMaterialGcRecord {
  readonly prepareMutationId: string;
  readonly prepareRequestId: string;
  readonly pepperKeyId: string;
  readonly materialDigest: string;
  readonly backupMaterialDigest: string;
  readonly activePepperKeyId: string;
  readonly activeGeneration: number;
  readonly activeMaterialDigest: string;
  readonly retentionPolicy: Readonly<LocalOwnerPepperMaterialGcRetentionPolicy>;
  readonly retentionPolicyDigest: string;
  readonly referencesInspectedAtMs: number;
  readonly retentionEligibleAtMs: number;
  readonly preparedAtMs: number;
  readonly state: LocalOwnerPepperMaterialGcState;
  readonly completeMutationId?: string;
  readonly completeRequestId?: string;
  readonly destructionProofDigest?: string;
  readonly completedAtMs?: number;
}

export interface PrepareLocalOwnerPepperMaterialGcCommand {
  readonly mutationId: string;
  readonly requestId: string;
  readonly pepperKeyId: string;
  readonly expectedMaterialDigest: string;
  readonly expectedBackupMaterialDigest: string;
  readonly expectedActivePepperKeyId: string;
  readonly expectedActiveGeneration: number;
  readonly expectedActiveMaterialDigest: string;
  readonly retentionPolicy: LocalOwnerPepperMaterialGcRetentionPolicy;
  readonly preparedAtMs: number;
  readonly audit: SecurityAuditRecord;
}

export interface CompleteLocalOwnerPepperMaterialGcCommand {
  readonly prepareMutationId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly destructionProofDigest: string;
  readonly completedAtMs: number;
  readonly audit: SecurityAuditRecord;
}

export interface LocalOwnerPepperMaterialGcResult {
  readonly status: 'inserted' | 'existing';
  readonly record: Readonly<LocalOwnerPepperMaterialGcRecord>;
}

export interface LocalOwnerPepperMaterialGcRepository {
  resolve(
    prepareMutationId: string,
  ): Promise<Readonly<LocalOwnerPepperMaterialGcRecord> | null>;
  prepare(
    command: PrepareLocalOwnerPepperMaterialGcCommand,
  ): Promise<LocalOwnerPepperMaterialGcResult>;
  complete(
    command: CompleteLocalOwnerPepperMaterialGcCommand,
  ): Promise<LocalOwnerPepperMaterialGcResult>;
}

export class InvalidLocalOwnerPepperMaterialGcValueError extends TypeError {
  constructor(message: string) {
    super(`Local Owner pepper material GC value is invalid: ${message}`);
    this.name = 'InvalidLocalOwnerPepperMaterialGcValueError';
  }
}

export class LocalOwnerPepperMaterialGcMutationConflictError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_MATERIAL_GC_MUTATION_CONFLICT';

  constructor() {
    super(
      'Local Owner pepper material GC mutation conflicts with previous use',
    );
    this.name = 'LocalOwnerPepperMaterialGcMutationConflictError';
  }
}

export class LocalOwnerPepperMaterialGcInProgressError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_MATERIAL_GC_IN_PROGRESS';

  constructor() {
    super('A Local Owner pepper material GC is already in progress');
    this.name = 'LocalOwnerPepperMaterialGcInProgressError';
  }
}

export class LocalOwnerPepperMaterialGcReferenceConflictError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_MATERIAL_GC_REFERENCE_CONFLICT';

  constructor() {
    super('Local Owner pepper material still has runtime references');
    this.name = 'LocalOwnerPepperMaterialGcReferenceConflictError';
  }
}

export class LocalOwnerPepperMaterialGcRetentionPendingError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_MATERIAL_GC_RETENTION_PENDING';

  constructor(readonly eligibleAtMs: number) {
    super('Local Owner pepper material retention period has not elapsed');
    this.name = 'LocalOwnerPepperMaterialGcRetentionPendingError';
  }
}

export class LocalOwnerPepperMaterialGcRepositoryUnavailableError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_MATERIAL_GC_REPOSITORY_UNAVAILABLE';

  constructor() {
    super('Local Owner pepper material GC repository is unavailable');
    this.name = 'LocalOwnerPepperMaterialGcRepositoryUnavailableError';
  }
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      'object shape is invalid',
    );
  }
}

function mutationId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      `${field} is invalid`,
    );
  }
  return value;
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      'requestId is invalid',
    );
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      `${field} is invalid`,
    );
  }
  return value;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      `${field} is invalid`,
    );
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      `${field} is invalid`,
    );
  }
  return value;
}

function retention(
  value: unknown,
): Readonly<LocalOwnerPepperMaterialGcRetentionPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      'retentionPolicy is invalid',
    );
  }
  exactKeys(value, [
    'version',
    'acknowledgementRetentionMs',
    'auditRetentionMs',
    'backupRetentionMs',
  ]);
  const policy = value as Record<string, unknown>;
  const acknowledgementRetentionMs = positiveInteger(
    policy.acknowledgementRetentionMs,
    'acknowledgementRetentionMs',
  );
  const auditRetentionMs = positiveInteger(
    policy.auditRetentionMs,
    'auditRetentionMs',
  );
  const backupRetentionMs = positiveInteger(
    policy.backupRetentionMs,
    'backupRetentionMs',
  );
  if (
    policy.version !== 1 ||
    acknowledgementRetentionMs < MIN_LOCAL_OWNER_PEPPER_ACK_RETENTION_MS ||
    auditRetentionMs < MIN_LOCAL_OWNER_PEPPER_AUDIT_RETENTION_MS ||
    backupRetentionMs < MIN_LOCAL_OWNER_PEPPER_BACKUP_RETENTION_MS ||
    acknowledgementRetentionMs > MAX_LOCAL_OWNER_PEPPER_RETENTION_MS ||
    auditRetentionMs > MAX_LOCAL_OWNER_PEPPER_RETENTION_MS ||
    backupRetentionMs > MAX_LOCAL_OWNER_PEPPER_RETENTION_MS
  ) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      'retentionPolicy is outside the reviewed bounds',
    );
  }
  return Object.freeze({
    version: 1 as const,
    acknowledgementRetentionMs,
    auditRetentionMs,
    backupRetentionMs,
  });
}

function audit(
  value: SecurityAuditRecord,
  mutation: string,
  request: string,
  operation: 'prepare' | 'complete',
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  const normalized = normalizeSecurityAuditRecord(value);
  if (
    normalized.eventId !== mutation ||
    normalized.requestId !== request ||
    normalized.operationId !== `owner.pepper.material_gc.${operation}` ||
    normalized.projectId !== null ||
    normalized.subject === null ||
    normalized.subject.type !== 'system' ||
    normalized.subject.id !== 'owner-pepper-gc' ||
    normalized.authenticationId !== 'local-owner-console' ||
    normalized.outcome !== 'allowed' ||
    normalized.reasons.length !== 1 ||
    normalized.reasons[0] !== 'pepper_material_gc' ||
    normalized.fence !== null ||
    normalized.occurredAtMs !== occurredAtMs
  ) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      'audit is not bound to the GC mutation',
    );
  }
  return normalized;
}

export function localOwnerPepperMaterialGcRetentionPolicyDigest(
  value: LocalOwnerPepperMaterialGcRetentionPolicy,
): string {
  const policy = retention(value);
  return createHash('sha256')
    .update('qinglong.local-owner-pepper-material-gc-policy.v1\0', 'utf8')
    .update(String(policy.acknowledgementRetentionMs), 'utf8')
    .update('\0', 'utf8')
    .update(String(policy.auditRetentionMs), 'utf8')
    .update('\0', 'utf8')
    .update(String(policy.backupRetentionMs), 'utf8')
    .digest('hex');
}

export function normalizePrepareLocalOwnerPepperMaterialGcCommand(
  value: PrepareLocalOwnerPepperMaterialGcCommand,
): Readonly<PrepareLocalOwnerPepperMaterialGcCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      'prepare command is invalid',
    );
  }
  exactKeys(value, [
    'mutationId',
    'requestId',
    'pepperKeyId',
    'expectedMaterialDigest',
    'expectedBackupMaterialDigest',
    'expectedActivePepperKeyId',
    'expectedActiveGeneration',
    'expectedActiveMaterialDigest',
    'retentionPolicy',
    'preparedAtMs',
    'audit',
  ]);
  const normalizedMutationId = mutationId(value.mutationId, 'mutationId');
  const normalizedRequestId = requestId(value.requestId);
  const normalizedPepperKeyId = value.pepperKeyId;
  const normalizedActivePepperKeyId = value.expectedActivePepperKeyId;
  try {
    assertApiCredentialPepperKeyId(normalizedPepperKeyId);
    assertApiCredentialPepperKeyId(normalizedActivePepperKeyId);
  } catch {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      'pepper key identity is invalid',
    );
  }
  if (normalizedPepperKeyId === normalizedActivePepperKeyId) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      'retired and active pepper keys must differ',
    );
  }
  const preparedAtMs = timestamp(value.preparedAtMs, 'preparedAtMs');
  return Object.freeze({
    mutationId: normalizedMutationId,
    requestId: normalizedRequestId,
    pepperKeyId: normalizedPepperKeyId,
    expectedMaterialDigest: digest(
      value.expectedMaterialDigest,
      'expectedMaterialDigest',
    ),
    expectedBackupMaterialDigest: digest(
      value.expectedBackupMaterialDigest,
      'expectedBackupMaterialDigest',
    ),
    expectedActivePepperKeyId: normalizedActivePepperKeyId,
    expectedActiveGeneration: positiveInteger(
      value.expectedActiveGeneration,
      'expectedActiveGeneration',
    ),
    expectedActiveMaterialDigest: digest(
      value.expectedActiveMaterialDigest,
      'expectedActiveMaterialDigest',
    ),
    retentionPolicy: retention(value.retentionPolicy),
    preparedAtMs,
    audit: audit(
      value.audit,
      normalizedMutationId,
      normalizedRequestId,
      'prepare',
      preparedAtMs,
    ),
  });
}

export function normalizeCompleteLocalOwnerPepperMaterialGcCommand(
  value: CompleteLocalOwnerPepperMaterialGcCommand,
): Readonly<CompleteLocalOwnerPepperMaterialGcCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      'complete command is invalid',
    );
  }
  exactKeys(value, [
    'prepareMutationId',
    'mutationId',
    'requestId',
    'destructionProofDigest',
    'completedAtMs',
    'audit',
  ]);
  const prepareMutationId = mutationId(
    value.prepareMutationId,
    'prepareMutationId',
  );
  const normalizedMutationId = mutationId(value.mutationId, 'mutationId');
  if (prepareMutationId === normalizedMutationId) {
    throw new InvalidLocalOwnerPepperMaterialGcValueError(
      'completion mutation must be distinct',
    );
  }
  const normalizedRequestId = requestId(value.requestId);
  const completedAtMs = timestamp(value.completedAtMs, 'completedAtMs');
  return Object.freeze({
    prepareMutationId,
    mutationId: normalizedMutationId,
    requestId: normalizedRequestId,
    destructionProofDigest: digest(
      value.destructionProofDigest,
      'destructionProofDigest',
    ),
    completedAtMs,
    audit: audit(
      value.audit,
      normalizedMutationId,
      normalizedRequestId,
      'complete',
      completedAtMs,
    ),
  });
}

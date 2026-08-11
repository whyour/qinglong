import {
  REVOKED_API_CREDENTIAL_DIGEST,
  type ApiCredentialMutationRecord,
} from '../security/identity-credential/apiCredentialAdministration';
import {
  assertApiCredentialId,
  normalizeApiCredentialRecord,
  type ApiCredentialRecord,
} from '../security/identity-credential/apiCredential';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '../security/audit/securityAudit';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_VERSION = 2_147_483_647;

export type LocalOwnerCredentialRecoveryState =
  | 'issued'
  | 'acknowledged'
  | 'completed';

export interface LocalOwnerCredentialRecoveryRecord {
  readonly issueMutationId: string;
  readonly issueRequestId: string;
  readonly subjectId: string;
  readonly previousCredentialId: string;
  readonly previousCredentialVersion: number;
  readonly replacementCredential: Readonly<ApiCredentialRecord>;
  readonly state: LocalOwnerCredentialRecoveryState;
  readonly issuedAtMs: number;
  readonly deliveryDigest?: string;
  readonly acknowledgedAtMs?: number;
  readonly completeMutationId?: string;
  readonly completeRequestId?: string;
  readonly revokedCredentialVersion?: number;
  readonly completedAtMs?: number;
}

export interface IssueLocalOwnerCredentialRecoveryCommand {
  readonly mutationId: string;
  readonly requestId: string;
  readonly previousCredentialId: string;
  readonly expectedPreviousVersion: number;
  readonly replacementCredential: ApiCredentialRecord;
  readonly mutation: ApiCredentialMutationRecord;
  readonly audit: SecurityAuditRecord;
}

export interface AcknowledgeLocalOwnerCredentialRecoveryCommand {
  readonly issueMutationId: string;
  readonly requestId: string;
  readonly credentialId: string;
  readonly factDigest: string;
  readonly deliveryDigest: string;
  readonly acknowledgedAtMs: number;
}

export interface CompleteLocalOwnerCredentialRecoveryCommand {
  readonly issueMutationId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly expectedPreviousVersion: number;
  readonly revokedCredential: ApiCredentialRecord;
  readonly mutation: ApiCredentialMutationRecord;
  readonly audit: SecurityAuditRecord;
}

export interface LocalOwnerCredentialRecoveryResult {
  readonly status: 'inserted' | 'existing';
  readonly recovery: Readonly<LocalOwnerCredentialRecoveryRecord>;
}

export interface LocalOwnerCredentialRecoveryRepository {
  resolve(
    issueMutationId: string,
  ): Promise<Readonly<LocalOwnerCredentialRecoveryRecord> | null>;
  issue(
    command: IssueLocalOwnerCredentialRecoveryCommand,
  ): Promise<LocalOwnerCredentialRecoveryResult>;
  acknowledge(
    command: AcknowledgeLocalOwnerCredentialRecoveryCommand,
  ): Promise<LocalOwnerCredentialRecoveryResult>;
  complete(
    command: CompleteLocalOwnerCredentialRecoveryCommand,
  ): Promise<LocalOwnerCredentialRecoveryResult>;
}

export class InvalidLocalOwnerCredentialRecoveryValueError extends TypeError {
  constructor(message: string) {
    super(`Local Owner credential recovery value is invalid: ${message}`);
    this.name = 'InvalidLocalOwnerCredentialRecoveryValueError';
  }
}

export class LocalOwnerCredentialRecoveryMutationConflictError extends Error {
  readonly code = 'LOCAL_OWNER_CREDENTIAL_RECOVERY_MUTATION_CONFLICT';

  constructor() {
    super(
      'Local Owner credential recovery mutation conflicts with previous use',
    );
    this.name = 'LocalOwnerCredentialRecoveryMutationConflictError';
  }
}

export class LocalOwnerCredentialRecoveryInProgressError extends Error {
  readonly code = 'LOCAL_OWNER_CREDENTIAL_RECOVERY_IN_PROGRESS';

  constructor() {
    super('A Local Owner credential recovery is already in progress');
    this.name = 'LocalOwnerCredentialRecoveryInProgressError';
  }
}

export class LocalOwnerCredentialRecoveryNotAcknowledgedError extends Error {
  readonly code = 'LOCAL_OWNER_CREDENTIAL_RECOVERY_NOT_ACKNOWLEDGED';

  constructor() {
    super('Replacement credential delivery has not been acknowledged');
    this.name = 'LocalOwnerCredentialRecoveryNotAcknowledgedError';
  }
}

export class LocalOwnerCredentialRecoveryCredentialUnavailableError extends Error {
  readonly code = 'LOCAL_OWNER_CREDENTIAL_RECOVERY_CREDENTIAL_UNAVAILABLE';

  constructor() {
    super('Local Owner credential is unavailable for recovery');
    this.name = 'LocalOwnerCredentialRecoveryCredentialUnavailableError';
  }
}

export class LocalOwnerCredentialRecoveryRepositoryUnavailableError extends Error {
  readonly code = 'LOCAL_OWNER_CREDENTIAL_RECOVERY_REPOSITORY_UNAVAILABLE';

  constructor() {
    super('Local Owner credential recovery repository is unavailable');
    this.name = 'LocalOwnerCredentialRecoveryRepositoryUnavailableError';
  }
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'object shape is invalid',
    );
  }
}

function mutationId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      `${field} is invalid`,
    );
  }
  return value;
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'requestId is invalid',
    );
  }
  return value;
}

function version(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_VERSION
  ) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      `${field} is invalid`,
    );
  }
  return value;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      `${field} is invalid`,
    );
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      `${field} is invalid`,
    );
  }
  return value;
}

function normalizedMutation(
  value: ApiCredentialMutationRecord,
  operation: 'issue' | 'revoke',
  credential: Readonly<ApiCredentialRecord>,
  expectedPreviousVersion: number,
): Readonly<ApiCredentialMutationRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'mutation is invalid',
    );
  }
  exactKeys(value, [
    'mutationId',
    'operation',
    'credentialId',
    'credentialVersion',
    'expectedPreviousVersion',
    'changedBy',
    'createdAtMs',
  ]);
  mutationId(value.mutationId, 'mutation.mutationId');
  if (
    value.operation !== operation ||
    value.credentialId !== credential.credentialId ||
    value.credentialVersion !== credential.version ||
    value.expectedPreviousVersion !== expectedPreviousVersion ||
    value.createdAtMs !== credential.createdAtMs ||
    value.changedBy.type !== 'system' ||
    value.changedBy.id !== 'owner-credential-recovery'
  ) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'mutation semantic is invalid',
    );
  }
  return Object.freeze({
    ...value,
    changedBy: Object.freeze({ ...value.changedBy }),
  });
}

function normalizedAudit(
  value: SecurityAuditRecord,
  mutation: Readonly<ApiCredentialMutationRecord>,
  request: string,
): Readonly<SecurityAuditRecord> {
  const audit = normalizeSecurityAuditRecord(value);
  if (
    audit.eventId !== mutation.mutationId ||
    audit.requestId !== request ||
    audit.operationId !== `credential.${mutation.operation}` ||
    audit.projectId !== null ||
    audit.subject?.type !== 'system' ||
    audit.subject.id !== 'owner-credential-recovery' ||
    audit.authenticationId !== 'local-owner-console' ||
    audit.outcome !== 'allowed' ||
    audit.reasons.length !== 1 ||
    audit.reasons[0] !== 'credential_recovery' ||
    audit.fence !== null ||
    audit.occurredAtMs !== mutation.createdAtMs
  ) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'audit semantic is invalid',
    );
  }
  return audit;
}

export function normalizeIssueLocalOwnerCredentialRecoveryCommand(
  value: IssueLocalOwnerCredentialRecoveryCommand,
): Readonly<IssueLocalOwnerCredentialRecoveryCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'command is invalid',
    );
  }
  exactKeys(value, [
    'mutationId',
    'requestId',
    'previousCredentialId',
    'expectedPreviousVersion',
    'replacementCredential',
    'mutation',
    'audit',
  ]);
  const issueMutationId = mutationId(value.mutationId, 'mutationId');
  const issueRequestId = requestId(value.requestId);
  try {
    assertApiCredentialId(value.previousCredentialId);
  } catch {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'previousCredentialId is invalid',
    );
  }
  const expectedPreviousVersion = version(
    value.expectedPreviousVersion,
    'expectedPreviousVersion',
  );
  const replacementCredential = normalizeApiCredentialRecord(
    value.replacementCredential,
  );
  if (
    replacementCredential.credentialId === value.previousCredentialId ||
    replacementCredential.version !== 1 ||
    replacementCredential.state !== 'active' ||
    replacementCredential.subject.type !== 'user' ||
    replacementCredential.subjectStatus !== 'active'
  ) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'replacement credential is invalid',
    );
  }
  const mutation = normalizedMutation(
    value.mutation,
    'issue',
    replacementCredential,
    0,
  );
  if (mutation.mutationId !== issueMutationId) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'issue mutation identity is invalid',
    );
  }
  return Object.freeze({
    mutationId: issueMutationId,
    requestId: issueRequestId,
    previousCredentialId: value.previousCredentialId,
    expectedPreviousVersion,
    replacementCredential,
    mutation,
    audit: normalizedAudit(value.audit, mutation, issueRequestId),
  });
}

export function normalizeAcknowledgeLocalOwnerCredentialRecoveryCommand(
  value: AcknowledgeLocalOwnerCredentialRecoveryCommand,
): Readonly<AcknowledgeLocalOwnerCredentialRecoveryCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'command is invalid',
    );
  }
  exactKeys(value, [
    'issueMutationId',
    'requestId',
    'credentialId',
    'factDigest',
    'deliveryDigest',
    'acknowledgedAtMs',
  ]);
  const issueMutationId = mutationId(value.issueMutationId, 'issueMutationId');
  const normalizedRequestId = requestId(value.requestId);
  try {
    assertApiCredentialId(value.credentialId);
  } catch {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'credentialId is invalid',
    );
  }
  return Object.freeze({
    issueMutationId,
    requestId: normalizedRequestId,
    credentialId: value.credentialId,
    factDigest: digest(value.factDigest, 'factDigest'),
    deliveryDigest: digest(value.deliveryDigest, 'deliveryDigest'),
    acknowledgedAtMs: timestamp(value.acknowledgedAtMs, 'acknowledgedAtMs'),
  });
}

export function normalizeCompleteLocalOwnerCredentialRecoveryCommand(
  value: CompleteLocalOwnerCredentialRecoveryCommand,
): Readonly<CompleteLocalOwnerCredentialRecoveryCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'command is invalid',
    );
  }
  exactKeys(value, [
    'issueMutationId',
    'mutationId',
    'requestId',
    'expectedPreviousVersion',
    'revokedCredential',
    'mutation',
    'audit',
  ]);
  const issueMutationId = mutationId(value.issueMutationId, 'issueMutationId');
  const completeMutationId = mutationId(value.mutationId, 'mutationId');
  if (completeMutationId === issueMutationId) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'completion mutation must be distinct',
    );
  }
  const completeRequestId = requestId(value.requestId);
  const expectedPreviousVersion = version(
    value.expectedPreviousVersion,
    'expectedPreviousVersion',
  );
  const revokedCredential = normalizeApiCredentialRecord(
    value.revokedCredential,
  );
  if (
    revokedCredential.state !== 'revoked' ||
    revokedCredential.version !== expectedPreviousVersion + 1 ||
    revokedCredential.subject.type !== 'user' ||
    revokedCredential.secretDigest !== REVOKED_API_CREDENTIAL_DIGEST ||
    revokedCredential.notBeforeAtMs !== revokedCredential.createdAtMs ||
    revokedCredential.expiresAtMs !== revokedCredential.createdAtMs + 1
  ) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'revoked credential is invalid',
    );
  }
  const mutation = normalizedMutation(
    value.mutation,
    'revoke',
    revokedCredential,
    expectedPreviousVersion,
  );
  if (mutation.mutationId !== completeMutationId) {
    throw new InvalidLocalOwnerCredentialRecoveryValueError(
      'completion mutation identity is invalid',
    );
  }
  return Object.freeze({
    issueMutationId,
    mutationId: completeMutationId,
    requestId: completeRequestId,
    expectedPreviousVersion,
    revokedCredential,
    mutation,
    audit: normalizedAudit(value.audit, mutation, completeRequestId),
  });
}

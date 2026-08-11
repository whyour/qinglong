import {
  normalizeApiCredentialRecord,
  type ApiCredentialRecord,
} from './apiCredential';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '../audit/securityAudit';
import type { SecuritySubject } from '../security';

export const API_CREDENTIAL_ADMINISTRATION_OPERATIONS = [
  'issue',
  'rotate',
  'revoke',
] as const;
export const REVOKED_API_CREDENTIAL_DIGEST = '0'.repeat(64);

export type ApiCredentialAdministrationOperation =
  (typeof API_CREDENTIAL_ADMINISTRATION_OPERATIONS)[number];

export interface ApiCredentialMutationRecord {
  readonly mutationId: string;
  readonly operation: ApiCredentialAdministrationOperation;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly expectedPreviousVersion: number;
  readonly changedBy: SecuritySubject;
  readonly createdAtMs: number;
}

export interface AppendApiCredentialCommand {
  readonly expectedCurrentVersion: number;
  readonly credential: ApiCredentialRecord;
  readonly mutation: ApiCredentialMutationRecord;
  readonly audit: SecurityAuditRecord;
}

export interface AppendApiCredentialResult {
  readonly status: 'inserted' | 'existing';
  readonly credential: Readonly<ApiCredentialRecord>;
  readonly mutation: Readonly<ApiCredentialMutationRecord>;
}

export interface ResolvedApiCredentialMutation {
  readonly credential: Readonly<ApiCredentialRecord>;
  readonly mutation: Readonly<ApiCredentialMutationRecord>;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface ApiCredentialAdministrationRepository {
  resolveMutation(
    mutationId: string,
  ): Promise<ResolvedApiCredentialMutation | null>;
  append(
    command: AppendApiCredentialCommand,
  ): Promise<AppendApiCredentialResult>;
}

export class InvalidApiCredentialAdministrationValueError extends TypeError {
  constructor(message: string) {
    super(`API credential administration value is invalid: ${message}`);
    this.name = 'InvalidApiCredentialAdministrationValueError';
  }
}

export class ApiCredentialAdministrationSubjectNotFoundError extends Error {
  readonly code = 'API_CREDENTIAL_ADMINISTRATION_SUBJECT_NOT_FOUND';

  constructor() {
    super('API credential administration subject was not found');
    this.name = 'ApiCredentialAdministrationSubjectNotFoundError';
  }
}

export class ApiCredentialAdministrationVersionConflictError extends Error {
  readonly code = 'API_CREDENTIAL_ADMINISTRATION_VERSION_CONFLICT';

  constructor() {
    super('API credential administration version conflict');
    this.name = 'ApiCredentialAdministrationVersionConflictError';
  }
}

export class ApiCredentialAdministrationMutationConflictError extends Error {
  readonly code = 'API_CREDENTIAL_ADMINISTRATION_MUTATION_CONFLICT';

  constructor() {
    super('API credential administration mutation conflict');
    this.name = 'ApiCredentialAdministrationMutationConflictError';
  }
}

export class ApiCredentialAdministrationUnavailableError extends Error {
  readonly code = 'API_CREDENTIAL_ADMINISTRATION_UNAVAILABLE';

  constructor() {
    super('API credential administration storage is unavailable');
    this.name = 'ApiCredentialAdministrationUnavailableError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBJECT_ID_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_VERSION = 2_147_483_647;

export function normalizeApiCredentialAdministrationMutationId(
  value: string,
): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidApiCredentialAdministrationValueError(
      'mutationId is invalid',
    );
  }
  return value;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidApiCredentialAdministrationValueError(
      `${name} shape is invalid`,
    );
  }
}

function version(name: string, value: number, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > MAX_VERSION
  ) {
    throw new InvalidApiCredentialAdministrationValueError(
      `${name} is invalid`,
    );
  }
  return value;
}

function changedBy(value: SecuritySubject): Readonly<SecuritySubject> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApiCredentialAdministrationValueError(
      'changedBy is invalid',
    );
  }
  exactKeys(value, ['type', 'id'], 'changedBy');
  if (
    (value.type !== 'user' && value.type !== 'system') ||
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    value.id.length > 255 ||
    SUBJECT_ID_CONTROL_PATTERN.test(value.id)
  ) {
    throw new InvalidApiCredentialAdministrationValueError(
      'changedBy is invalid',
    );
  }
  return Object.freeze({ type: value.type, id: value.id });
}

export function normalizeAppendApiCredentialCommand(
  value: AppendApiCredentialCommand,
): Readonly<AppendApiCredentialCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApiCredentialAdministrationValueError(
      'command must be an object',
    );
  }
  exactKeys(
    value,
    ['expectedCurrentVersion', 'credential', 'mutation', 'audit'],
    'command',
  );
  const expectedCurrentVersion = version(
    'expectedCurrentVersion',
    value.expectedCurrentVersion,
    true,
  );
  const credential = normalizeApiCredentialRecord(value.credential);
  const mutation = value.mutation;
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
    throw new InvalidApiCredentialAdministrationValueError(
      'mutation must be an object',
    );
  }
  exactKeys(
    mutation,
    [
      'mutationId',
      'operation',
      'credentialId',
      'credentialVersion',
      'expectedPreviousVersion',
      'changedBy',
      'createdAtMs',
    ],
    'mutation',
  );
  normalizeApiCredentialAdministrationMutationId(mutation.mutationId);
  if (!API_CREDENTIAL_ADMINISTRATION_OPERATIONS.includes(mutation.operation)) {
    throw new InvalidApiCredentialAdministrationValueError(
      'operation is invalid',
    );
  }
  const credentialVersion = version(
    'credentialVersion',
    mutation.credentialVersion,
  );
  const expectedPreviousVersion = version(
    'expectedPreviousVersion',
    mutation.expectedPreviousVersion,
    true,
  );
  const actor = changedBy(mutation.changedBy);
  if (
    expectedPreviousVersion !== expectedCurrentVersion ||
    credentialVersion !== expectedCurrentVersion + 1 ||
    credential.credentialId !== mutation.credentialId ||
    credential.version !== credentialVersion ||
    credential.createdAtMs !== mutation.createdAtMs ||
    !Number.isSafeInteger(mutation.createdAtMs) ||
    mutation.createdAtMs < 0 ||
    (mutation.operation === 'issue' &&
      (expectedCurrentVersion !== 0 || credential.state !== 'active')) ||
    (mutation.operation === 'rotate' &&
      (expectedCurrentVersion < 1 || credential.state !== 'active')) ||
    (mutation.operation === 'revoke' &&
      (expectedCurrentVersion < 1 ||
        credential.state !== 'revoked' ||
        credential.secretDigest !== REVOKED_API_CREDENTIAL_DIGEST ||
        credential.notBeforeAtMs !== credential.createdAtMs ||
        credential.expiresAtMs !== credential.createdAtMs + 1))
  ) {
    throw new InvalidApiCredentialAdministrationValueError(
      'credential transition is invalid',
    );
  }
  const audit = normalizeSecurityAuditRecord(value.audit);
  if (
    audit.eventId !== mutation.mutationId ||
    audit.operationId !== `credential.${mutation.operation}` ||
    audit.subject?.type !== actor.type ||
    audit.subject.id !== actor.id ||
    audit.outcome !== 'allowed' ||
    audit.reasons.length !== 1 ||
    audit.reasons[0] !== 'credential_admin' ||
    audit.fence !== null ||
    audit.occurredAtMs !== mutation.createdAtMs
  ) {
    throw new InvalidApiCredentialAdministrationValueError('audit is invalid');
  }
  return Object.freeze({
    expectedCurrentVersion,
    credential,
    mutation: Object.freeze({
      mutationId: mutation.mutationId,
      operation: mutation.operation,
      credentialId: mutation.credentialId,
      credentialVersion,
      expectedPreviousVersion,
      changedBy: actor,
      createdAtMs: mutation.createdAtMs,
    }),
    audit,
  });
}

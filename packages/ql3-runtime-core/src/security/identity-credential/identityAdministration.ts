import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '../audit/securityAudit';
import { SECURITY_SUBJECT_TYPES, type SecuritySubject } from '../security';

export const IDENTITY_SUBJECT_STATES = ['active', 'disabled'] as const;
export const IDENTITY_ADMINISTRATION_OPERATIONS = [
  'register',
  'enable',
  'disable',
] as const;

export type IdentitySubjectState = (typeof IDENTITY_SUBJECT_STATES)[number];
export type IdentityAdministrationOperation =
  (typeof IDENTITY_ADMINISTRATION_OPERATIONS)[number];

export interface IdentitySubjectRecord {
  readonly subject: SecuritySubject;
  readonly status: IdentitySubjectState;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface IdentitySubjectMutationRecord {
  readonly mutationId: string;
  readonly operation: IdentityAdministrationOperation;
  readonly subject: SecuritySubject;
  readonly subjectVersion: number;
  readonly expectedPreviousVersion: number;
  readonly status: IdentitySubjectState;
  readonly changedBy: SecuritySubject;
  readonly createdAtMs: number;
}

export interface AppendIdentitySubjectCommand {
  readonly expectedCurrentVersion: number;
  readonly mutation: IdentitySubjectMutationRecord;
  readonly audit: SecurityAuditRecord;
}

export interface AppendIdentitySubjectResult {
  readonly status: 'inserted' | 'existing';
  readonly identity: Readonly<IdentitySubjectRecord>;
  readonly mutation: Readonly<IdentitySubjectMutationRecord>;
}

export interface ResolvedIdentitySubjectMutation {
  readonly identity: Readonly<IdentitySubjectRecord>;
  readonly mutation: Readonly<IdentitySubjectMutationRecord>;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface IdentityAdministrationRepository {
  resolve(
    subject: SecuritySubject,
  ): Promise<Readonly<IdentitySubjectRecord> | null>;
  resolveMutation(
    mutationId: string,
  ): Promise<ResolvedIdentitySubjectMutation | null>;
  append(
    command: AppendIdentitySubjectCommand,
  ): Promise<AppendIdentitySubjectResult>;
}

export class InvalidIdentityAdministrationValueError extends TypeError {
  constructor(message: string) {
    super(`Identity administration value is invalid: ${message}`);
    this.name = 'InvalidIdentityAdministrationValueError';
  }
}

export class IdentityAdministrationVersionConflictError extends Error {
  readonly code = 'IDENTITY_ADMINISTRATION_VERSION_CONFLICT';

  constructor() {
    super('Identity administration version conflict');
    this.name = 'IdentityAdministrationVersionConflictError';
  }
}

export class IdentityAdministrationMutationConflictError extends Error {
  readonly code = 'IDENTITY_ADMINISTRATION_MUTATION_CONFLICT';

  constructor() {
    super('Identity administration mutation conflict');
    this.name = 'IdentityAdministrationMutationConflictError';
  }
}

export class IdentityAdministrationUnavailableError extends Error {
  readonly code = 'IDENTITY_ADMINISTRATION_UNAVAILABLE';

  constructor() {
    super('Identity administration storage is unavailable');
    this.name = 'IdentityAdministrationUnavailableError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBJECT_ID_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_VERSION = 2_147_483_647;

export function normalizeIdentityAdministrationMutationId(
  value: string,
): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidIdentityAdministrationValueError('mutationId is invalid');
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
    throw new InvalidIdentityAdministrationValueError(
      `${name} shape is invalid`,
    );
  }
}

function subject(
  name: string,
  value: SecuritySubject,
  adminActor = false,
): Readonly<SecuritySubject> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidIdentityAdministrationValueError(`${name} is invalid`);
  }
  exactKeys(value, ['type', 'id'], name);
  if (
    !SECURITY_SUBJECT_TYPES.includes(value.type) ||
    (adminActor && value.type !== 'user' && value.type !== 'system') ||
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    value.id.length > 255 ||
    SUBJECT_ID_CONTROL_PATTERN.test(value.id)
  ) {
    throw new InvalidIdentityAdministrationValueError(`${name} is invalid`);
  }
  return Object.freeze({ type: value.type, id: value.id });
}

export function normalizeIdentityAdministrationSubject(
  value: SecuritySubject,
): Readonly<SecuritySubject> {
  return subject('identity subject', value);
}

function version(name: string, value: number, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > MAX_VERSION
  ) {
    throw new InvalidIdentityAdministrationValueError(`${name} is invalid`);
  }
  return value;
}

export function normalizeIdentitySubjectRecord(
  value: IdentitySubjectRecord,
): Readonly<IdentitySubjectRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidIdentityAdministrationValueError(
      'identity must be an object',
    );
  }
  exactKeys(
    value,
    ['subject', 'status', 'version', 'createdAtMs', 'updatedAtMs'],
    'identity',
  );
  const normalizedSubject = subject('identity subject', value.subject);
  if (!IDENTITY_SUBJECT_STATES.includes(value.status)) {
    throw new InvalidIdentityAdministrationValueError('status is invalid');
  }
  const normalizedVersion = version('version', value.version);
  if (
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs
  ) {
    throw new InvalidIdentityAdministrationValueError(
      'identity lifetime is invalid',
    );
  }
  return Object.freeze({
    subject: normalizedSubject,
    status: value.status,
    version: normalizedVersion,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
  });
}

export function normalizeAppendIdentitySubjectCommand(
  value: AppendIdentitySubjectCommand,
): Readonly<AppendIdentitySubjectCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidIdentityAdministrationValueError(
      'command must be an object',
    );
  }
  exactKeys(value, ['expectedCurrentVersion', 'mutation', 'audit'], 'command');
  const expectedCurrentVersion = version(
    'expectedCurrentVersion',
    value.expectedCurrentVersion,
    true,
  );
  const mutation = value.mutation;
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
    throw new InvalidIdentityAdministrationValueError(
      'mutation must be an object',
    );
  }
  exactKeys(
    mutation,
    [
      'mutationId',
      'operation',
      'subject',
      'subjectVersion',
      'expectedPreviousVersion',
      'status',
      'changedBy',
      'createdAtMs',
    ],
    'mutation',
  );
  normalizeIdentityAdministrationMutationId(mutation.mutationId);
  if (!IDENTITY_ADMINISTRATION_OPERATIONS.includes(mutation.operation)) {
    throw new InvalidIdentityAdministrationValueError('operation is invalid');
  }
  const normalizedSubject = subject('mutation subject', mutation.subject);
  const changedBy = subject('changedBy', mutation.changedBy, true);
  const subjectVersion = version('subjectVersion', mutation.subjectVersion);
  const expectedPreviousVersion = version(
    'expectedPreviousVersion',
    mutation.expectedPreviousVersion,
    true,
  );
  if (
    expectedPreviousVersion !== expectedCurrentVersion ||
    subjectVersion !== expectedCurrentVersion + 1 ||
    !IDENTITY_SUBJECT_STATES.includes(mutation.status) ||
    !Number.isSafeInteger(mutation.createdAtMs) ||
    mutation.createdAtMs < 0 ||
    (mutation.operation === 'register' &&
      (expectedCurrentVersion !== 0 || mutation.status !== 'active')) ||
    (mutation.operation === 'enable' &&
      (expectedCurrentVersion < 1 || mutation.status !== 'active')) ||
    (mutation.operation === 'disable' &&
      (expectedCurrentVersion < 1 || mutation.status !== 'disabled'))
  ) {
    throw new InvalidIdentityAdministrationValueError(
      'mutation transition is invalid',
    );
  }
  const audit = normalizeSecurityAuditRecord(value.audit);
  if (
    audit.eventId !== mutation.mutationId ||
    audit.operationId !== `identity.${mutation.operation}` ||
    audit.subject?.type !== changedBy.type ||
    audit.subject.id !== changedBy.id ||
    audit.outcome !== 'allowed' ||
    audit.reasons.length !== 1 ||
    audit.reasons[0] !== 'identity_admin' ||
    audit.fence !== null ||
    audit.occurredAtMs !== mutation.createdAtMs
  ) {
    throw new InvalidIdentityAdministrationValueError('audit is invalid');
  }
  return Object.freeze({
    expectedCurrentVersion,
    mutation: Object.freeze({
      mutationId: mutation.mutationId,
      operation: mutation.operation,
      subject: normalizedSubject,
      subjectVersion,
      expectedPreviousVersion,
      status: mutation.status,
      changedBy,
      createdAtMs: mutation.createdAtMs,
    }),
    audit,
  });
}

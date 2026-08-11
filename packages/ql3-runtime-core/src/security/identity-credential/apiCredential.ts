import { SECURITY_SUBJECT_TYPES, type SecuritySubject } from '../security';

export const API_CREDENTIAL_STATES = ['active', 'revoked'] as const;
export const API_CREDENTIAL_SUBJECT_TYPES = [
  'user',
  'api_app',
  'mcp_client',
  'agent',
] as const;
export const API_CREDENTIAL_SUBJECT_STATUSES = ['active', 'disabled'] as const;

export type ApiCredentialState = (typeof API_CREDENTIAL_STATES)[number];
export type ApiCredentialSubjectType =
  (typeof API_CREDENTIAL_SUBJECT_TYPES)[number];
export type ApiCredentialSubjectStatus =
  (typeof API_CREDENTIAL_SUBJECT_STATUSES)[number];

export interface ApiCredentialRecord {
  readonly credentialId: string;
  readonly version: number;
  readonly pepperKeyId: string;
  readonly state: ApiCredentialState;
  readonly subject: SecuritySubject;
  readonly subjectStatus: ApiCredentialSubjectStatus;
  readonly secretDigest: string;
  readonly createdAtMs: number;
  readonly notBeforeAtMs: number;
  readonly expiresAtMs: number;
}

export interface ApiCredentialRepository {
  resolve(credentialId: string): Promise<Readonly<ApiCredentialRecord> | null>;
}

export class InvalidApiCredentialValueError extends TypeError {
  constructor(message: string) {
    super(`API credential value is invalid: ${message}`);
    this.name = 'InvalidApiCredentialValueError';
  }
}

export class ApiCredentialUnavailableError extends Error {
  readonly code = 'API_CREDENTIAL_UNAVAILABLE';

  constructor() {
    super('API credential storage is unavailable');
    this.name = 'ApiCredentialUnavailableError';
  }
}

const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PEPPER_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SUBJECT_ID_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SECRET_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_VERSION = 2_147_483_647;

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
    throw new InvalidApiCredentialValueError(`${name} shape is invalid`);
  }
}

function timestamp(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidApiCredentialValueError(`${name} is invalid`);
  }
  return value;
}

export function assertApiCredentialId(value: string): void {
  if (typeof value !== 'string' || !CREDENTIAL_ID_PATTERN.test(value)) {
    throw new InvalidApiCredentialValueError('credentialId is invalid');
  }
}

export const LEGACY_API_CREDENTIAL_PEPPER_KEY_ID = 'legacy-v1';

export function assertApiCredentialPepperKeyId(value: string): void {
  if (typeof value !== 'string' || !PEPPER_KEY_ID_PATTERN.test(value)) {
    throw new InvalidApiCredentialValueError('pepperKeyId is invalid');
  }
}

export function normalizeApiCredentialRecord(
  value: ApiCredentialRecord,
): Readonly<ApiCredentialRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApiCredentialValueError('record must be an object');
  }
  exactKeys(
    value,
    [
      'credentialId',
      'version',
      'pepperKeyId',
      'state',
      'subject',
      'subjectStatus',
      'secretDigest',
      'createdAtMs',
      'notBeforeAtMs',
      'expiresAtMs',
    ],
    'record',
  );
  assertApiCredentialId(value.credentialId);
  assertApiCredentialPepperKeyId(value.pepperKeyId);
  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    value.version > MAX_VERSION
  ) {
    throw new InvalidApiCredentialValueError('version is invalid');
  }
  if (!API_CREDENTIAL_STATES.includes(value.state)) {
    throw new InvalidApiCredentialValueError('state is invalid');
  }
  if (
    !value.subject ||
    typeof value.subject !== 'object' ||
    Array.isArray(value.subject)
  ) {
    throw new InvalidApiCredentialValueError('subject is invalid');
  }
  exactKeys(value.subject, ['type', 'id'], 'subject');
  if (
    !SECURITY_SUBJECT_TYPES.includes(value.subject.type) ||
    !API_CREDENTIAL_SUBJECT_TYPES.includes(
      value.subject.type as ApiCredentialSubjectType,
    ) ||
    typeof value.subject.id !== 'string' ||
    value.subject.id.length < 1 ||
    value.subject.id.length > 255 ||
    SUBJECT_ID_CONTROL_PATTERN.test(value.subject.id)
  ) {
    throw new InvalidApiCredentialValueError('subject is invalid');
  }
  if (!API_CREDENTIAL_SUBJECT_STATUSES.includes(value.subjectStatus)) {
    throw new InvalidApiCredentialValueError('subjectStatus is invalid');
  }
  if (!SECRET_DIGEST_PATTERN.test(value.secretDigest)) {
    throw new InvalidApiCredentialValueError('secretDigest is invalid');
  }
  const createdAtMs = timestamp('createdAtMs', value.createdAtMs);
  const notBeforeAtMs = timestamp('notBeforeAtMs', value.notBeforeAtMs);
  const expiresAtMs = timestamp('expiresAtMs', value.expiresAtMs);
  if (notBeforeAtMs < createdAtMs || expiresAtMs <= notBeforeAtMs) {
    throw new InvalidApiCredentialValueError('lifetime is invalid');
  }
  return Object.freeze({
    credentialId: value.credentialId,
    version: value.version,
    pepperKeyId: value.pepperKeyId,
    state: value.state,
    subject: Object.freeze({
      type: value.subject.type,
      id: value.subject.id,
    }),
    subjectStatus: value.subjectStatus,
    secretDigest: value.secretDigest,
    createdAtMs,
    notBeforeAtMs,
    expiresAtMs,
  });
}

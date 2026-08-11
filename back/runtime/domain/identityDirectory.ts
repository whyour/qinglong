import {
  InvalidProjectPolicyValueError,
  normalizePolicySubject,
  type PolicySubject,
} from './projectPolicy';

export const IDENTITY_SUBJECT_STATUSES = ['active', 'disabled'] as const;
export const IDENTITY_AUTHENTICATION_BINDING_STATES = [
  'active',
  'revoked',
] as const;

export const LEGACY_PANEL_IDENTITY_PROVIDER = 'legacy_panel';
export const LEGACY_PANEL_PROVIDER_SUBJECT = 'singleton';
export const LEGACY_PRIMARY_USER_SUBJECT_ID = 'usr_legacy_primary';

export type IdentitySubjectStatus = (typeof IDENTITY_SUBJECT_STATUSES)[number];
export type IdentityAuthenticationBindingState =
  (typeof IDENTITY_AUTHENTICATION_BINDING_STATES)[number];

export interface IdentitySubjectRecord {
  subject: PolicySubject;
  status: IdentitySubjectStatus;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface IdentityAuthenticationBindingRecord {
  provider: string;
  providerSubject: string;
  version: number;
  state: IdentityAuthenticationBindingState;
  subjectId: string;
  createdAtMs: number;
}

export const MAX_IDENTITY_DIRECTORY_VERSION = 2_147_483_647;
export const MAX_IDENTITY_PROVIDER_LENGTH = 64;
export const MAX_IDENTITY_PROVIDER_SUBJECT_LENGTH = 128;

const IDENTITY_PROVIDER_PATTERN = /^[a-z][a-z0-9_:-]*$/;
const IDENTITY_PROVIDER_SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export class InvalidIdentityDirectoryValueError extends TypeError {
  constructor(message: string) {
    super(`Identity directory value is invalid: ${message}`);
    this.name = 'InvalidIdentityDirectoryValueError';
  }
}

export class IdentityDirectoryUnavailableError extends Error {
  readonly code = 'IDENTITY_DIRECTORY_UNAVAILABLE';

  constructor() {
    super('Identity directory is unavailable');
    this.name = 'IdentityDirectoryUnavailableError';
  }
}

function assertExactKeys(
  name: string,
  value: object,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidIdentityDirectoryValueError(`${name} shape is invalid`);
  }
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidIdentityDirectoryValueError(`${name} is invalid`);
  }
}

function assertVersion(name: string, value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_IDENTITY_DIRECTORY_VERSION
  ) {
    throw new InvalidIdentityDirectoryValueError(`${name} is invalid`);
  }
}

export function assertIdentityProvider(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_IDENTITY_PROVIDER_LENGTH ||
    !IDENTITY_PROVIDER_PATTERN.test(value)
  ) {
    throw new InvalidIdentityDirectoryValueError('provider is invalid');
  }
}

export function assertIdentityProviderSubject(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_IDENTITY_PROVIDER_SUBJECT_LENGTH ||
    !IDENTITY_PROVIDER_SUBJECT_PATTERN.test(value)
  ) {
    throw new InvalidIdentityDirectoryValueError('providerSubject is invalid');
  }
}

export function normalizeIdentitySubjectRecord(
  value: IdentitySubjectRecord,
): Readonly<IdentitySubjectRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidIdentityDirectoryValueError(
      'identity subject must be an object',
    );
  }
  assertExactKeys('identity subject', value, [
    'subject',
    'status',
    'version',
    'createdAtMs',
    'updatedAtMs',
  ]);
  let subject: Readonly<PolicySubject>;
  try {
    subject = normalizePolicySubject(value.subject);
  } catch (error) {
    if (error instanceof InvalidProjectPolicyValueError) {
      throw new InvalidIdentityDirectoryValueError('subject is invalid');
    }
    throw error;
  }
  if (!IDENTITY_SUBJECT_STATUSES.includes(value.status)) {
    throw new InvalidIdentityDirectoryValueError('subject status is invalid');
  }
  assertVersion('subject version', value.version);
  assertTimestamp('subject createdAtMs', value.createdAtMs);
  assertTimestamp('subject updatedAtMs', value.updatedAtMs);
  if (value.updatedAtMs < value.createdAtMs) {
    throw new InvalidIdentityDirectoryValueError(
      'subject timestamps are invalid',
    );
  }
  return Object.freeze({
    subject,
    status: value.status,
    version: value.version,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
  });
}

export function normalizeIdentityAuthenticationBindingRecord(
  value: IdentityAuthenticationBindingRecord,
): Readonly<IdentityAuthenticationBindingRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidIdentityDirectoryValueError(
      'authentication binding must be an object',
    );
  }
  assertExactKeys('authentication binding', value, [
    'provider',
    'providerSubject',
    'version',
    'state',
    'subjectId',
    'createdAtMs',
  ]);
  assertIdentityProvider(value.provider);
  assertIdentityProviderSubject(value.providerSubject);
  assertVersion('authentication binding version', value.version);
  if (!IDENTITY_AUTHENTICATION_BINDING_STATES.includes(value.state)) {
    throw new InvalidIdentityDirectoryValueError(
      'authentication binding state is invalid',
    );
  }
  try {
    normalizePolicySubject({ type: 'user', id: value.subjectId });
  } catch (error) {
    if (error instanceof InvalidProjectPolicyValueError) {
      throw new InvalidIdentityDirectoryValueError('subjectId is invalid');
    }
    throw error;
  }
  assertTimestamp('authentication binding createdAtMs', value.createdAtMs);
  return Object.freeze({ ...value });
}

import {
  InvalidProjectPolicyValueError,
  normalizePolicySubject,
  type PolicySubject,
} from './projectPolicy';

export const AUTHENTICATION_ASSURANCE_LEVELS = [
  'single_factor',
  'multi_factor',
  'service',
  'hardware',
  'local_console',
] as const;

export type AuthenticationAssurance =
  (typeof AUTHENTICATION_ASSURANCE_LEVELS)[number];

export interface AuthenticatedPrincipal {
  subject: PolicySubject;
  authenticationId: string;
  authenticatedAtMs: number;
  expiresAtMs: number;
  assurance: AuthenticationAssurance;
}

export const MAX_AUTHENTICATION_ID_LENGTH = 128;

const AUTHENTICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidProjectPolicyValueError(`${name} is invalid`);
  }
}

export function normalizeAuthenticatedPrincipal(
  value: AuthenticatedPrincipal,
): Readonly<AuthenticatedPrincipal> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectPolicyValueError(
      'authenticated principal must be an object',
    );
  }
  const keys = Object.keys(value).sort();
  const expected = [
    'assurance',
    'authenticatedAtMs',
    'authenticationId',
    'expiresAtMs',
    'subject',
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new InvalidProjectPolicyValueError(
      'authenticated principal shape is invalid',
    );
  }
  const subject = normalizePolicySubject(value.subject);
  if (
    typeof value.authenticationId !== 'string' ||
    value.authenticationId.length < 1 ||
    value.authenticationId.length > MAX_AUTHENTICATION_ID_LENGTH ||
    !AUTHENTICATION_ID_PATTERN.test(value.authenticationId)
  ) {
    throw new InvalidProjectPolicyValueError('authenticationId is invalid');
  }
  assertTimestamp('authenticatedAtMs', value.authenticatedAtMs);
  assertTimestamp('expiresAtMs', value.expiresAtMs);
  if (value.expiresAtMs <= value.authenticatedAtMs) {
    throw new InvalidProjectPolicyValueError(
      'authenticated principal lifetime is invalid',
    );
  }
  if (!AUTHENTICATION_ASSURANCE_LEVELS.includes(value.assurance)) {
    throw new InvalidProjectPolicyValueError(
      'authentication assurance is invalid',
    );
  }
  return Object.freeze({
    subject,
    authenticationId: value.authenticationId,
    authenticatedAtMs: value.authenticatedAtMs,
    expiresAtMs: value.expiresAtMs,
    assurance: value.assurance,
  });
}

export function assertAuthenticatedPrincipalActive(
  principal: Readonly<AuthenticatedPrincipal>,
  nowMs: number,
): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new InvalidProjectPolicyValueError('current time is invalid');
  }
  if (principal.authenticatedAtMs > nowMs || principal.expiresAtMs <= nowMs) {
    throw new AuthenticatedPrincipalExpiredError();
  }
}

export class AuthenticatedPrincipalExpiredError extends Error {
  readonly code = 'AUTHENTICATED_PRINCIPAL_EXPIRED';

  constructor() {
    super('Authenticated principal is not active');
    this.name = 'AuthenticatedPrincipalExpiredError';
  }
}

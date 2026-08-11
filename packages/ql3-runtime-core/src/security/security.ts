export const SECURITY_SUBJECT_TYPES = [
  'user',
  'api_app',
  'mcp_client',
  'agent',
  'system',
  'worker',
] as const;
export const SECURITY_AUTHENTICATION_ASSURANCES = [
  'single_factor',
  'multi_factor',
  'service',
  'hardware',
  'local_console',
] as const;
export const SECURITY_POLICY_EFFECTS = [
  'allow',
  'deny',
  'require_approval',
] as const;

export type SecuritySubjectType = (typeof SECURITY_SUBJECT_TYPES)[number];
export type SecurityAuthenticationAssurance =
  (typeof SECURITY_AUTHENTICATION_ASSURANCES)[number];
export type SecurityPolicyEffect = (typeof SECURITY_POLICY_EFFECTS)[number];

export interface SecuritySubject {
  readonly type: SecuritySubjectType;
  readonly id: string;
}

export interface SecurityPrincipal {
  readonly subject: SecuritySubject;
  readonly authenticationId: string;
  readonly authenticatedAtMs: number;
  readonly expiresAtMs: number;
  readonly assurance: SecurityAuthenticationAssurance;
}

export interface SecurityPolicyFence {
  readonly projectVersion: number;
  readonly bindingVersion: number | null;
}

export interface SecurityPolicyDecision {
  readonly effect: SecurityPolicyEffect;
  readonly reasons: readonly string[];
  readonly fence: SecurityPolicyFence | null;
}

export class InvalidSecurityContractError extends TypeError {
  constructor(message: string) {
    super(`Security contract is invalid: ${message}`);
    this.name = 'InvalidSecurityContractError';
  }
}

const AUTHENTICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUBJECT_ID_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function exactKeys(
  value: object,
  expected: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new InvalidSecurityContractError(`${name} shape is invalid`);
  }
}

function positiveVersion(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidSecurityContractError(`${name} is invalid`);
  }
  return value;
}

export function normalizeSecurityPrincipal(
  value: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new InvalidSecurityContractError('current time is invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidSecurityContractError('principal must be an object');
  }
  exactKeys(
    value,
    [
      'subject',
      'authenticationId',
      'authenticatedAtMs',
      'expiresAtMs',
      'assurance',
    ],
    'principal',
  );
  const subject = value.subject;
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) {
    throw new InvalidSecurityContractError('subject must be an object');
  }
  exactKeys(subject, ['type', 'id'], 'subject');
  if (!SECURITY_SUBJECT_TYPES.includes(subject.type)) {
    throw new InvalidSecurityContractError('subject type is invalid');
  }
  if (
    typeof subject.id !== 'string' ||
    subject.id.length < 1 ||
    subject.id.length > 255 ||
    SUBJECT_ID_CONTROL_PATTERN.test(subject.id)
  ) {
    throw new InvalidSecurityContractError('subject id is invalid');
  }
  if (!AUTHENTICATION_ID_PATTERN.test(value.authenticationId)) {
    throw new InvalidSecurityContractError('authentication id is invalid');
  }
  if (
    !Number.isSafeInteger(value.authenticatedAtMs) ||
    value.authenticatedAtMs < 0 ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= value.authenticatedAtMs ||
    value.authenticatedAtMs > nowMs ||
    value.expiresAtMs <= nowMs
  ) {
    throw new InvalidSecurityContractError('principal lifetime is inactive');
  }
  if (!SECURITY_AUTHENTICATION_ASSURANCES.includes(value.assurance)) {
    throw new InvalidSecurityContractError(
      'authentication assurance is invalid',
    );
  }
  return Object.freeze({
    subject: Object.freeze({ type: subject.type, id: subject.id }),
    authenticationId: value.authenticationId,
    authenticatedAtMs: value.authenticatedAtMs,
    expiresAtMs: value.expiresAtMs,
    assurance: value.assurance,
  });
}

export function normalizeSecurityPolicyDecision(
  value: SecurityPolicyDecision,
): Readonly<SecurityPolicyDecision> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidSecurityContractError('policy decision must be an object');
  }
  exactKeys(value, ['effect', 'reasons', 'fence'], 'policy decision');
  if (!SECURITY_POLICY_EFFECTS.includes(value.effect)) {
    throw new InvalidSecurityContractError('policy effect is invalid');
  }
  if (
    !Array.isArray(value.reasons) ||
    value.reasons.length < 1 ||
    value.reasons.length > 8 ||
    value.reasons.some(
      (reason) => typeof reason !== 'string' || !REASON_PATTERN.test(reason),
    )
  ) {
    throw new InvalidSecurityContractError('policy reasons are invalid');
  }
  let fence: Readonly<SecurityPolicyFence> | null = null;
  if (value.fence !== null) {
    if (
      !value.fence ||
      typeof value.fence !== 'object' ||
      Array.isArray(value.fence)
    ) {
      throw new InvalidSecurityContractError('policy fence is invalid');
    }
    exactKeys(
      value.fence,
      ['projectVersion', 'bindingVersion'],
      'policy fence',
    );
    fence = Object.freeze({
      projectVersion: positiveVersion(
        'policy project version',
        value.fence.projectVersion,
      ),
      bindingVersion:
        value.fence.bindingVersion === null
          ? null
          : positiveVersion(
              'policy binding version',
              value.fence.bindingVersion,
            ),
    });
  }
  return Object.freeze({
    effect: value.effect,
    reasons: Object.freeze([...value.reasons]),
    fence,
  });
}

import type { SecurityPolicyFence, SecuritySubject } from '../security';
import { SECURITY_SUBJECT_TYPES } from '../security';

export const SECURITY_AUDIT_OUTCOMES = [
  'authentication_rejected',
  'authentication_unavailable',
  'authorization_unavailable',
  'denied',
  'approval_required',
  'allowed',
] as const;

export type SecurityAuditOutcome = (typeof SECURITY_AUDIT_OUTCOMES)[number];

export interface SecurityAuditRecord {
  readonly eventId: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly projectId: string | null;
  readonly subject: SecuritySubject | null;
  readonly authenticationId: string | null;
  readonly outcome: SecurityAuditOutcome;
  readonly reasons: readonly string[];
  readonly fence: SecurityPolicyFence | null;
  readonly occurredAtMs: number;
}

export interface SecurityAuditSink {
  record(record: SecurityAuditRecord): void | Promise<void>;
}

export class InvalidSecurityAuditValueError extends TypeError {
  constructor(message: string) {
    super(`Security audit value is invalid: ${message}`);
    this.name = 'InvalidSecurityAuditValueError';
  }
}

export class SecurityAuditUnavailableError extends Error {
  readonly code = 'SECURITY_AUDIT_UNAVAILABLE';

  constructor() {
    super('Security audit storage is unavailable');
    this.name = 'SecurityAuditUnavailableError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUTHENTICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SUBJECT_ID_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

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
    throw new InvalidSecurityAuditValueError(`${name} shape is invalid`);
  }
}

function normalizeSubject(
  value: SecuritySubject | null,
): Readonly<SecuritySubject> | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidSecurityAuditValueError('subject is invalid');
  }
  exactKeys(value, ['type', 'id'], 'subject');
  if (
    !SECURITY_SUBJECT_TYPES.includes(value.type) ||
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    value.id.length > 255 ||
    SUBJECT_ID_CONTROL_PATTERN.test(value.id)
  ) {
    throw new InvalidSecurityAuditValueError('subject is invalid');
  }
  return Object.freeze({ type: value.type, id: value.id });
}

function normalizeFence(
  value: SecurityPolicyFence | null,
): Readonly<SecurityPolicyFence> | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidSecurityAuditValueError('fence is invalid');
  }
  exactKeys(value, ['projectVersion', 'bindingVersion'], 'fence');
  if (
    !Number.isSafeInteger(value.projectVersion) ||
    value.projectVersion < 1 ||
    (value.bindingVersion !== null &&
      (!Number.isSafeInteger(value.bindingVersion) || value.bindingVersion < 1))
  ) {
    throw new InvalidSecurityAuditValueError('fence is invalid');
  }
  return Object.freeze({
    projectVersion: value.projectVersion,
    bindingVersion: value.bindingVersion,
  });
}

export function normalizeSecurityAuditRecord(
  value: SecurityAuditRecord,
): Readonly<SecurityAuditRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidSecurityAuditValueError('record must be an object');
  }
  exactKeys(
    value,
    [
      'eventId',
      'requestId',
      'operationId',
      'projectId',
      'subject',
      'authenticationId',
      'outcome',
      'reasons',
      'fence',
      'occurredAtMs',
    ],
    'record',
  );
  if (!UUID_PATTERN.test(value.eventId)) {
    throw new InvalidSecurityAuditValueError('eventId is invalid');
  }
  if (!REQUEST_ID_PATTERN.test(value.requestId)) {
    throw new InvalidSecurityAuditValueError('requestId is invalid');
  }
  if (!OPERATION_PATTERN.test(value.operationId)) {
    throw new InvalidSecurityAuditValueError('operationId is invalid');
  }
  if (value.projectId !== null && !PROJECT_PATTERN.test(value.projectId)) {
    throw new InvalidSecurityAuditValueError('projectId is invalid');
  }
  const subject = normalizeSubject(value.subject);
  if (
    (value.authenticationId === null) !== (subject === null) ||
    (value.authenticationId !== null &&
      !AUTHENTICATION_ID_PATTERN.test(value.authenticationId))
  ) {
    throw new InvalidSecurityAuditValueError('authenticationId is invalid');
  }
  if (!SECURITY_AUDIT_OUTCOMES.includes(value.outcome)) {
    throw new InvalidSecurityAuditValueError('outcome is invalid');
  }
  const preAuthentication =
    value.outcome === 'authentication_rejected' ||
    value.outcome === 'authentication_unavailable';
  if (preAuthentication !== (subject === null)) {
    throw new InvalidSecurityAuditValueError('outcome identity is invalid');
  }
  if (
    !Array.isArray(value.reasons) ||
    value.reasons.length < 1 ||
    value.reasons.length > 8 ||
    value.reasons.some(
      (reason) => typeof reason !== 'string' || !REASON_PATTERN.test(reason),
    )
  ) {
    throw new InvalidSecurityAuditValueError('reasons are invalid');
  }
  const fence = normalizeFence(value.fence);
  if (!Number.isSafeInteger(value.occurredAtMs) || value.occurredAtMs < 0) {
    throw new InvalidSecurityAuditValueError('occurredAtMs is invalid');
  }
  return Object.freeze({
    eventId: value.eventId,
    requestId: value.requestId,
    operationId: value.operationId,
    projectId: value.projectId,
    subject,
    authenticationId: value.authenticationId,
    outcome: value.outcome,
    reasons: Object.freeze([...value.reasons]),
    fence,
    occurredAtMs: value.occurredAtMs,
  });
}

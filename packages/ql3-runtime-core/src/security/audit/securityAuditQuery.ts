import {
  SECURITY_AUDIT_OUTCOMES,
  type SecurityAuditOutcome,
  type SecurityAuditRecord,
} from './securityAudit';
import { SECURITY_SUBJECT_TYPES, type SecuritySubject } from '../security';

export const MAX_SECURITY_AUDIT_QUERY_PAGE_SIZE = 200;

export interface SecurityAuditQueryCursor {
  readonly occurredAtMs: number;
  readonly eventId: string;
}

export interface SecurityAuditQueryFilter {
  readonly projectId?: string;
  readonly subject?: SecuritySubject;
  readonly outcome?: SecurityAuditOutcome;
}

export interface SecurityAuditQuery {
  readonly limit: number;
  readonly before?: SecurityAuditQueryCursor;
  readonly filter: SecurityAuditQueryFilter;
}

export interface SecurityAuditQueryPage {
  readonly records: readonly Readonly<SecurityAuditRecord>[];
  readonly nextCursor: Readonly<SecurityAuditQueryCursor> | null;
}

export interface SecurityAuditQueryRepository {
  list(query: SecurityAuditQuery): Promise<SecurityAuditQueryPage>;
}

export class InvalidSecurityAuditQueryError extends TypeError {
  constructor(message: string) {
    super(`Security audit query is invalid: ${message}`);
    this.name = 'InvalidSecurityAuditQueryError';
  }
}

export class SecurityAuditQueryUnavailableError extends Error {
  readonly code = 'SECURITY_AUDIT_QUERY_UNAVAILABLE';

  constructor() {
    super('Security audit query is unavailable');
    this.name = 'SecurityAuditQueryUnavailableError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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
    throw new InvalidSecurityAuditQueryError(`${name} shape is invalid`);
  }
}

export function normalizeSecurityAuditQuery(
  value: SecurityAuditQuery,
): Readonly<SecurityAuditQuery> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidSecurityAuditQueryError('query must be an object');
  }
  const topKeys = ['limit', 'filter'];
  if (value.before !== undefined) topKeys.push('before');
  exactKeys(value, topKeys, 'query');
  if (
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_SECURITY_AUDIT_QUERY_PAGE_SIZE
  ) {
    throw new InvalidSecurityAuditQueryError('limit is invalid');
  }
  let before: Readonly<SecurityAuditQueryCursor> | undefined;
  if (value.before !== undefined) {
    if (
      !value.before ||
      typeof value.before !== 'object' ||
      Array.isArray(value.before)
    ) {
      throw new InvalidSecurityAuditQueryError('before is invalid');
    }
    exactKeys(value.before, ['occurredAtMs', 'eventId'], 'before');
    if (
      !Number.isSafeInteger(value.before.occurredAtMs) ||
      value.before.occurredAtMs < 0 ||
      !UUID_PATTERN.test(value.before.eventId)
    ) {
      throw new InvalidSecurityAuditQueryError('before is invalid');
    }
    before = Object.freeze({ ...value.before });
  }
  if (
    !value.filter ||
    typeof value.filter !== 'object' ||
    Array.isArray(value.filter)
  ) {
    throw new InvalidSecurityAuditQueryError('filter is invalid');
  }
  const filterKeys = Object.keys(value.filter);
  if (
    filterKeys.some((key) => !['projectId', 'subject', 'outcome'].includes(key))
  ) {
    throw new InvalidSecurityAuditQueryError('filter shape is invalid');
  }
  const filter: {
    projectId?: string;
    subject?: Readonly<SecuritySubject>;
    outcome?: SecurityAuditOutcome;
  } = {};
  if (value.filter.projectId !== undefined) {
    if (!PROJECT_PATTERN.test(value.filter.projectId)) {
      throw new InvalidSecurityAuditQueryError('projectId is invalid');
    }
    filter.projectId = value.filter.projectId;
  }
  if (value.filter.subject !== undefined) {
    const candidate = value.filter.subject;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      throw new InvalidSecurityAuditQueryError('subject is invalid');
    }
    exactKeys(candidate, ['type', 'id'], 'subject');
    if (
      !SECURITY_SUBJECT_TYPES.includes(candidate.type) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length < 1 ||
      candidate.id.length > 255 ||
      SUBJECT_ID_CONTROL_PATTERN.test(candidate.id)
    ) {
      throw new InvalidSecurityAuditQueryError('subject is invalid');
    }
    filter.subject = Object.freeze({ type: candidate.type, id: candidate.id });
  }
  if (value.filter.outcome !== undefined) {
    if (!SECURITY_AUDIT_OUTCOMES.includes(value.filter.outcome)) {
      throw new InvalidSecurityAuditQueryError('outcome is invalid');
    }
    filter.outcome = value.filter.outcome;
  }
  return Object.freeze({
    limit: value.limit,
    ...(before ? { before } : {}),
    filter: Object.freeze(filter),
  });
}

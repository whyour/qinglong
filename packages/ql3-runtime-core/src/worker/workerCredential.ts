import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '../security/audit/securityAudit';
import type { SecuritySubject } from '../security/security';

export const WORKER_CREDENTIAL_STATES = ['active', 'revoked'] as const;
export type WorkerCredentialState = (typeof WORKER_CREDENTIAL_STATES)[number];

export interface WorkerCredentialRecord {
  readonly credentialId: string;
  readonly version: number;
  readonly state: WorkerCredentialState;
  readonly workerId: string;
  readonly secretDigest: string;
  readonly createdAtMs: number;
  readonly notBeforeAtMs: number;
  readonly expiresAtMs: number;
}

export interface WorkerCredentialRepository {
  resolve(credentialId: string): Promise<WorkerCredentialRecord | null>;
}

export type WorkerCredentialAdministrationOperation =
  | 'issue'
  | 'rotate'
  | 'revoke';

export interface WorkerCredentialMutationRecord {
  readonly mutationId: string;
  readonly operation: WorkerCredentialAdministrationOperation;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly expectedPreviousVersion: number;
  readonly changedBy: SecuritySubject;
  readonly createdAtMs: number;
}

export interface AppendWorkerCredentialCommand {
  readonly expectedCurrentVersion: number;
  readonly credential: WorkerCredentialRecord;
  readonly mutation: WorkerCredentialMutationRecord;
  readonly audit: SecurityAuditRecord;
}

export interface AppendWorkerCredentialResult {
  readonly status: 'created' | 'existing';
  readonly credential: Readonly<WorkerCredentialRecord>;
  readonly mutation: Readonly<WorkerCredentialMutationRecord>;
}

export interface ResolvedWorkerCredentialMutation {
  readonly credential: Readonly<WorkerCredentialRecord>;
  readonly mutation: Readonly<WorkerCredentialMutationRecord>;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface WorkerCredentialAdministrationRepository {
  resolveMutation(
    mutationId: string,
  ): Promise<ResolvedWorkerCredentialMutation | null>;
  append(
    command: AppendWorkerCredentialCommand,
  ): Promise<AppendWorkerCredentialResult>;
}

export class WorkerCredentialUnavailableError extends Error {
  readonly code = 'WORKER_CREDENTIAL_UNAVAILABLE';
  constructor() {
    super('Worker credential storage is unavailable');
    this.name = 'WorkerCredentialUnavailableError';
  }
}

export class WorkerCredentialMutationConflictError extends Error {
  readonly code = 'WORKER_CREDENTIAL_MUTATION_CONFLICT';
  constructor() {
    super('Worker credential mutation conflicts with an existing fact');
    this.name = 'WorkerCredentialMutationConflictError';
  }
}

export class WorkerCredentialVersionConflictError extends Error {
  readonly code = 'WORKER_CREDENTIAL_VERSION_CONFLICT';
  constructor() {
    super('Worker credential version fence was rejected');
    this.name = 'WorkerCredentialVersionConflictError';
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exact(value: object, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${name} shape is invalid`);
  }
}

function safeTime(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} is invalid`);
  }
  return value;
}

export function normalizeWorkerCredentialId(value: string): string {
  if (typeof value !== 'string' || !CREDENTIAL_ID.test(value)) {
    throw new TypeError('Worker credential ID is invalid');
  }
  return value;
}

export function normalizeWorkerCredentialRecord(
  value: WorkerCredentialRecord,
): Readonly<WorkerCredentialRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential record is invalid');
  }
  exact(
    value,
    [
      'credentialId',
      'version',
      'state',
      'workerId',
      'secretDigest',
      'createdAtMs',
      'notBeforeAtMs',
      'expiresAtMs',
    ],
    'Worker credential record',
  );
  normalizeWorkerCredentialId(value.credentialId);
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw new RangeError('Worker credential version is invalid');
  }
  if (!WORKER_CREDENTIAL_STATES.includes(value.state)) {
    throw new TypeError('Worker credential state is invalid');
  }
  if (!SAFE_ID.test(value.workerId)) {
    throw new TypeError('Worker credential worker ID is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(value.secretDigest)) {
    throw new TypeError('Worker credential digest is invalid');
  }
  const createdAtMs = safeTime('Worker credential createdAtMs', value.createdAtMs);
  const notBeforeAtMs = safeTime(
    'Worker credential notBeforeAtMs',
    value.notBeforeAtMs,
  );
  const expiresAtMs = safeTime(
    'Worker credential expiresAtMs',
    value.expiresAtMs,
  );
  if (expiresAtMs <= Math.max(createdAtMs, notBeforeAtMs)) {
    throw new RangeError('Worker credential lifetime is invalid');
  }
  return Object.freeze({ ...value });
}

export function normalizeWorkerCredentialMutationId(value: string): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new TypeError('Worker credential mutation ID is invalid');
  }
  return value;
}

export function normalizeAppendWorkerCredentialCommand(
  value: AppendWorkerCredentialCommand,
): Readonly<AppendWorkerCredentialCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential append command is invalid');
  }
  exact(
    value,
    ['expectedCurrentVersion', 'credential', 'mutation', 'audit'],
    'Worker credential append command',
  );
  const credential = normalizeWorkerCredentialRecord(value.credential);
  const mutation = value.mutation;
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
    throw new TypeError('Worker credential mutation is invalid');
  }
  exact(
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
    'Worker credential mutation',
  );
  normalizeWorkerCredentialMutationId(mutation.mutationId);
  if (!['issue', 'rotate', 'revoke'].includes(mutation.operation)) {
    throw new TypeError('Worker credential mutation operation is invalid');
  }
  if (
    !Number.isSafeInteger(value.expectedCurrentVersion) ||
    value.expectedCurrentVersion < 0 ||
    mutation.expectedPreviousVersion !== value.expectedCurrentVersion ||
    mutation.credentialVersion !== value.expectedCurrentVersion + 1 ||
    mutation.credentialId !== credential.credentialId ||
    mutation.createdAtMs !== credential.createdAtMs ||
    credential.state !== (mutation.operation === 'revoke' ? 'revoked' : 'active')
  ) {
    throw new RangeError('Worker credential mutation fence is invalid');
  }
  if (
    !mutation.changedBy ||
    typeof mutation.changedBy !== 'object' ||
    Array.isArray(mutation.changedBy)
  ) {
    throw new TypeError('Worker credential mutation actor is invalid');
  }
  exact(mutation.changedBy, ['type', 'id'], 'Worker credential mutation actor');
  if (!['user', 'system'].includes(mutation.changedBy.type)) {
    throw new TypeError('Worker credential mutation actor is invalid');
  }
  const audit = normalizeSecurityAuditRecord(value.audit);
  if (
    audit.eventId !== mutation.mutationId ||
    audit.occurredAtMs !== mutation.createdAtMs ||
    audit.operationId !== `worker_credential.${mutation.operation}` ||
    audit.projectId !== null ||
    audit.subject?.type !== mutation.changedBy.type ||
    audit.subject.id !== mutation.changedBy.id ||
    audit.outcome !== 'allowed' ||
    audit.reasons.length !== 1 ||
    audit.reasons[0] !== 'worker_credential_admin' ||
    audit.fence !== null
  ) {
    throw new TypeError('Worker credential mutation audit is invalid');
  }
  return Object.freeze({
    expectedCurrentVersion: value.expectedCurrentVersion,
    credential,
    mutation: Object.freeze({
      ...mutation,
      changedBy: Object.freeze({ ...mutation.changedBy }),
    }),
    audit,
  });
}

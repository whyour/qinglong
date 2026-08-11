import { createHash } from 'node:crypto';

import type { SecurityPolicyFence, SecuritySubject } from '../security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from './securityAudit';
import type { SecurityAuditQueryCursor } from './securityAuditQuery';

export const MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_LOCAL_SECURITY_AUDIT_RETENTION_MS =
  10 * 365 * 24 * 60 * 60 * 1_000;
export const MAX_EDGE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE = 64;
export const MAX_STANDALONE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE = 512;
export const MAX_LOCAL_SECURITY_AUDIT_COMPACTION_PAYLOAD_BYTES =
  16 * 1024 * 1024;

export interface LocalSecurityAuditRetentionAuthorization {
  readonly authorityProjectId: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
}

export interface LocalSecurityAuditCompactionRecord {
  readonly mutationId: string;
  readonly requestId: string;
  readonly authorityProjectId: string;
  readonly retentionMs: number;
  readonly eligibleBeforeMs: number;
  readonly batchLimit: number;
  readonly deletedCount: number;
  readonly deletedPayloadBytes: number;
  readonly first: Readonly<SecurityAuditQueryCursor> | null;
  readonly last: Readonly<SecurityAuditQueryCursor> | null;
  readonly recordsDigest: string;
  readonly createdAtMs: number;
}

export interface CompactAuthorizedLocalSecurityAuditCommand {
  readonly mutationId: string;
  readonly requestId: string;
  readonly retentionMs: number;
  readonly eligibleBeforeMs: number;
  readonly limit: number;
  readonly authorization: LocalSecurityAuditRetentionAuthorization;
  readonly audit: SecurityAuditRecord;
}

export interface CompactAuthorizedLocalSecurityAuditResult {
  readonly status: 'inserted' | 'existing';
  readonly record: Readonly<LocalSecurityAuditCompactionRecord>;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface LocalSecurityAuditRetentionRepository
  extends SecurityAuditSink {
  resolveCompaction(
    mutationId: string,
  ): Promise<Readonly<LocalSecurityAuditCompactionRecord> | null>;
  compactAuthorized(
    command: CompactAuthorizedLocalSecurityAuditCommand,
  ): Promise<CompactAuthorizedLocalSecurityAuditResult>;
}

export class InvalidLocalSecurityAuditRetentionValueError extends TypeError {
  constructor(message: string) {
    super(`Local security audit retention value is invalid: ${message}`);
    this.name = 'InvalidLocalSecurityAuditRetentionValueError';
  }
}

export class LocalSecurityAuditRetentionAuthorizationFenceConflictError extends Error {
  readonly code = 'LOCAL_SECURITY_AUDIT_RETENTION_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super('Local security audit retention authorization fence changed');
    this.name = 'LocalSecurityAuditRetentionAuthorizationFenceConflictError';
  }
}

export class LocalSecurityAuditCompactionMutationConflictError extends Error {
  readonly code = 'LOCAL_SECURITY_AUDIT_COMPACTION_MUTATION_CONFLICT';

  constructor() {
    super('Local security audit compaction mutation conflicts');
    this.name = 'LocalSecurityAuditCompactionMutationConflictError';
  }
}

export class LocalSecurityAuditRetentionUnavailableError extends Error {
  readonly code = 'LOCAL_SECURITY_AUDIT_RETENTION_UNAVAILABLE';

  constructor() {
    super('Local security audit retention is unavailable');
    this.name = 'LocalSecurityAuditRetentionUnavailableError';
  }
}

export function localSecurityAuditCompactionPayload(
  records: readonly Readonly<SecurityAuditRecord>[],
): Readonly<{ recordsDigest: string; payloadBytes: number }> {
  if (!Array.isArray(records)) {
    throw new InvalidLocalSecurityAuditRetentionValueError(
      'records must be an array',
    );
  }
  let normalized: Readonly<SecurityAuditRecord>[];
  try {
    normalized = records.map((record) => normalizeSecurityAuditRecord(record));
  } catch {
    throw new InvalidLocalSecurityAuditRetentionValueError(
      'records contain an invalid audit value',
    );
  }
  const payload = JSON.stringify(normalized);
  const payloadBytes =
    normalized.length === 0 ? 0 : Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_LOCAL_SECURITY_AUDIT_COMPACTION_PAYLOAD_BYTES) {
    throw new InvalidLocalSecurityAuditRetentionValueError(
      'records exceed the payload limit',
    );
  }
  return Object.freeze({
    recordsDigest: createHash('sha256')
      .update('qinglong.local-security-audit-compaction.records.v1\0', 'utf8')
      .update(payload, 'utf8')
      .digest('hex'),
    payloadBytes,
  });
}

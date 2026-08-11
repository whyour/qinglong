import { createHash } from 'node:crypto';
import {
  assertLocalOwnerBootstrapMutationId,
  assertLocalOwnerBootstrapRequestId,
} from './localOwnerBootstrap';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '../security/audit/securityAudit';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;

export const MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS = 30 * DAY_MS;
export const MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS = 30 * DAY_MS;
export const MAX_LOCAL_OWNER_ACKNOWLEDGEMENT_RETENTION_MS = 10 * 365 * DAY_MS;

export interface LocalOwnerDeliveryAcknowledgementGcRetentionPolicy {
  readonly version: 1;
  readonly replayRetentionMs: number;
  readonly auditRetentionMs: number;
}

export interface LocalOwnerDeliveryBridgeClearEvidence {
  readonly kind: 'credential' | 'challenge';
  readonly acknowledgementMutationId: string;
  readonly inspectedAtMs: number;
  readonly evidenceDigest: string;
}

export interface CompactLocalOwnerDeliveryAcknowledgementCommand {
  readonly mutationId: string;
  readonly requestId: string;
  readonly acknowledgementMutationId: string;
  readonly expectedKind: 'credential' | 'challenge';
  readonly expectedDeliveryDigest: string;
  readonly bridgeClearEvidence: LocalOwnerDeliveryBridgeClearEvidence;
  readonly retentionPolicy: LocalOwnerDeliveryAcknowledgementGcRetentionPolicy;
  readonly compactedAtMs: number;
  readonly audit: SecurityAuditRecord;
}

export interface LocalOwnerDeliveryAcknowledgementGcRecord {
  readonly mutationId: string;
  readonly requestId: string;
  readonly acknowledgementMutationId: string;
  readonly acknowledgementKind: 'credential' | 'challenge';
  readonly deliveryDigest: string;
  readonly acknowledgedAtMs: number;
  readonly acknowledgementSemanticDigest: string;
  readonly bridgeClearEvidenceDigest: string;
  readonly retentionPolicy: Readonly<LocalOwnerDeliveryAcknowledgementGcRetentionPolicy>;
  readonly retentionPolicyDigest: string;
  readonly retentionEligibleAtMs: number;
  readonly compactedAtMs: number;
}

export interface LocalOwnerDeliveryAcknowledgementGcResult {
  readonly status: 'inserted' | 'existing';
  readonly record: Readonly<LocalOwnerDeliveryAcknowledgementGcRecord>;
}

export interface LocalOwnerDeliveryAcknowledgementGcRepository {
  resolveByAcknowledgement(
    acknowledgementMutationId: string,
  ): Promise<Readonly<LocalOwnerDeliveryAcknowledgementGcRecord> | null>;
  compact(
    command: CompactLocalOwnerDeliveryAcknowledgementCommand,
  ): Promise<Readonly<LocalOwnerDeliveryAcknowledgementGcResult>>;
}

export class InvalidLocalOwnerDeliveryAcknowledgementGcValueError extends TypeError {
  constructor(message: string) {
    super(
      `Local Owner delivery acknowledgement GC value is invalid: ${message}`,
    );
    this.name = 'InvalidLocalOwnerDeliveryAcknowledgementGcValueError';
  }
}

export class LocalOwnerDeliveryAcknowledgementGcMutationConflictError extends Error {
  readonly code = 'LOCAL_OWNER_DELIVERY_ACKNOWLEDGEMENT_GC_MUTATION_CONFLICT';

  constructor() {
    super('Local Owner delivery acknowledgement GC mutation conflicts');
    this.name = 'LocalOwnerDeliveryAcknowledgementGcMutationConflictError';
  }
}

export class LocalOwnerDeliveryAcknowledgementGcRetentionPendingError extends Error {
  readonly code = 'LOCAL_OWNER_DELIVERY_ACKNOWLEDGEMENT_GC_RETENTION_PENDING';

  constructor(readonly eligibleAtMs: number) {
    super('Local Owner delivery acknowledgement retention has not elapsed');
    this.name = 'LocalOwnerDeliveryAcknowledgementGcRetentionPendingError';
  }
}

export class LocalOwnerDeliveryAcknowledgementGcReferenceConflictError extends Error {
  readonly code = 'LOCAL_OWNER_DELIVERY_ACKNOWLEDGEMENT_GC_REFERENCE_CONFLICT';

  constructor() {
    super('Local Owner delivery acknowledgement source is still active');
    this.name = 'LocalOwnerDeliveryAcknowledgementGcReferenceConflictError';
  }
}

export class LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError extends Error {
  readonly code =
    'LOCAL_OWNER_DELIVERY_ACKNOWLEDGEMENT_GC_REPOSITORY_UNAVAILABLE';

  constructor() {
    super('Local Owner delivery acknowledgement GC repository is unavailable');
    this.name = 'LocalOwnerDeliveryAcknowledgementGcRepositoryUnavailableError';
  }
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      'object shape is invalid',
    );
  }
}

function mutationId(value: unknown, field: string): string {
  try {
    assertLocalOwnerBootstrapMutationId(value as string);
  } catch {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      `${field} is invalid`,
    );
  }
  return value as string;
}

function requestId(value: unknown): string {
  try {
    assertLocalOwnerBootstrapRequestId(value as string);
  } catch {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      'requestId is invalid',
    );
  }
  return value as string;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      `${field} is invalid`,
    );
  }
  return value;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      `${field} is invalid`,
    );
  }
  return value;
}

function retention(
  value: unknown,
): Readonly<LocalOwnerDeliveryAcknowledgementGcRetentionPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      'retentionPolicy is invalid',
    );
  }
  exactKeys(value, ['version', 'replayRetentionMs', 'auditRetentionMs']);
  const policy = value as Record<string, unknown>;
  const replayRetentionMs = timestamp(
    policy.replayRetentionMs,
    'replayRetentionMs',
  );
  const auditRetentionMs = timestamp(
    policy.auditRetentionMs,
    'auditRetentionMs',
  );
  if (
    policy.version !== 1 ||
    replayRetentionMs < MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS ||
    auditRetentionMs < MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS ||
    replayRetentionMs > MAX_LOCAL_OWNER_ACKNOWLEDGEMENT_RETENTION_MS ||
    auditRetentionMs > MAX_LOCAL_OWNER_ACKNOWLEDGEMENT_RETENTION_MS
  ) {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      'retentionPolicy is outside the reviewed bounds',
    );
  }
  return Object.freeze({
    version: 1 as const,
    replayRetentionMs,
    auditRetentionMs,
  });
}

function bridgeEvidence(
  value: LocalOwnerDeliveryBridgeClearEvidence,
): Readonly<LocalOwnerDeliveryBridgeClearEvidence> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      'bridgeClearEvidence is invalid',
    );
  }
  exactKeys(value, [
    'kind',
    'acknowledgementMutationId',
    'inspectedAtMs',
    'evidenceDigest',
  ]);
  if (value.kind !== 'credential' && value.kind !== 'challenge') {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      'bridge kind is invalid',
    );
  }
  return Object.freeze({
    kind: value.kind,
    acknowledgementMutationId: mutationId(
      value.acknowledgementMutationId,
      'acknowledgementMutationId',
    ),
    inspectedAtMs: timestamp(value.inspectedAtMs, 'inspectedAtMs'),
    evidenceDigest: digest(value.evidenceDigest, 'evidenceDigest'),
  });
}

function audit(
  value: SecurityAuditRecord,
  mutation: string,
  request: string,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  const normalized = normalizeSecurityAuditRecord(value);
  if (
    normalized.eventId !== mutation ||
    normalized.requestId !== request ||
    normalized.operationId !== 'owner.delivery_acknowledgement.gc' ||
    normalized.projectId !== null ||
    normalized.subject?.type !== 'system' ||
    normalized.subject.id !== 'owner-acknowledgement-gc' ||
    normalized.authenticationId !== 'local-owner-console' ||
    normalized.outcome !== 'allowed' ||
    normalized.reasons.length !== 1 ||
    normalized.reasons[0] !== 'delivery_acknowledgement_gc' ||
    normalized.fence !== null ||
    normalized.occurredAtMs !== occurredAtMs
  ) {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      'audit is not bound to the GC mutation',
    );
  }
  return normalized;
}

export function localOwnerDeliveryAcknowledgementGcRetentionPolicyDigest(
  value: LocalOwnerDeliveryAcknowledgementGcRetentionPolicy,
): string {
  const policy = retention(value);
  return createHash('sha256')
    .update('qinglong.local-owner-delivery-acknowledgement-gc-policy.v1\0')
    .update(String(policy.replayRetentionMs), 'utf8')
    .update('\0', 'utf8')
    .update(String(policy.auditRetentionMs), 'utf8')
    .digest('hex');
}

export function normalizeCompactLocalOwnerDeliveryAcknowledgementCommand(
  value: CompactLocalOwnerDeliveryAcknowledgementCommand,
): Readonly<CompactLocalOwnerDeliveryAcknowledgementCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      'compact command is invalid',
    );
  }
  exactKeys(value, [
    'mutationId',
    'requestId',
    'acknowledgementMutationId',
    'expectedKind',
    'expectedDeliveryDigest',
    'bridgeClearEvidence',
    'retentionPolicy',
    'compactedAtMs',
    'audit',
  ]);
  const normalizedMutationId = mutationId(value.mutationId, 'mutationId');
  const normalizedAcknowledgementMutationId = mutationId(
    value.acknowledgementMutationId,
    'acknowledgementMutationId',
  );
  const normalizedRequestId = requestId(value.requestId);
  const normalizedBridge = bridgeEvidence(value.bridgeClearEvidence);
  const compactedAtMs = timestamp(value.compactedAtMs, 'compactedAtMs');
  if (
    normalizedMutationId === normalizedAcknowledgementMutationId ||
    (value.expectedKind !== 'credential' &&
      value.expectedKind !== 'challenge') ||
    normalizedBridge.kind !== value.expectedKind ||
    normalizedBridge.acknowledgementMutationId !==
      normalizedAcknowledgementMutationId ||
    normalizedBridge.inspectedAtMs !== compactedAtMs
  ) {
    throw new InvalidLocalOwnerDeliveryAcknowledgementGcValueError(
      'GC identity binding is invalid',
    );
  }
  return Object.freeze({
    mutationId: normalizedMutationId,
    requestId: normalizedRequestId,
    acknowledgementMutationId: normalizedAcknowledgementMutationId,
    expectedKind: value.expectedKind,
    expectedDeliveryDigest: digest(
      value.expectedDeliveryDigest,
      'expectedDeliveryDigest',
    ),
    bridgeClearEvidence: normalizedBridge,
    retentionPolicy: retention(value.retentionPolicy),
    compactedAtMs,
    audit: audit(
      value.audit,
      normalizedMutationId,
      normalizedRequestId,
      compactedAtMs,
    ),
  });
}

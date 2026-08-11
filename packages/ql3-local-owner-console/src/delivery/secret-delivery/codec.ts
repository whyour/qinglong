import type { LocalOwnerBootstrapSecretDeliveryRecord } from './ceremonyContracts';
import {
  assertLocalOwnerBootstrapChallengeId,
  assertLocalOwnerBootstrapMutationId,
  assertLocalOwnerBootstrapRequestId,
  normalizeLocalOwnerSecretDeliveryAcknowledgementRecord,
  type LocalOwnerSecretDeliveryAcknowledgementRecord,
} from '@qinglong/runtime-core/local-owner-bootstrap';
import { assertProjectPolicyProjectId } from '@qinglong/runtime-core/project-policy';
import {
  LocalOwnerSecretDeliveryError,
  type ClaimLocalOwnerFromDeliveriesRequest,
} from './contracts';

export const MAX_DIRECTORY_ENTRIES = 64;
export const MAX_RECORD_BYTES = 4 * 1024;
export const RECORD_NAME_PATTERN =
  /^(credential|challenge)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(pending|ready)\.json$/;
export const TEMP_NAME_PATTERN =
  /^\.(credential|challenge)-([0-9a-f-]{36})\.[0-9a-f-]{36}\.tmp$/;
export const ACKNOWLEDGEMENT_NAME_PATTERN =
  /^(credential|challenge)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.acknowledged\.json$/;

export interface DeliveryFile {
  readonly record: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>;
  readonly device: bigint;
  readonly inode: bigint;
  readonly digest: string;
}

export interface CredentialAcknowledgementRecord {
  readonly state: 'acknowledged';
  readonly kind: 'credential';
  readonly mutationId: string;
  readonly requestId: string;
  readonly subjectId: string;
  readonly credentialId: string;
  readonly factDigest: string;
  readonly ttlMs: number;
  readonly deliveryDigest: string;
  readonly acknowledgedAtMs: number;
}

export interface ChallengeAcknowledgementRecord {
  readonly state: 'acknowledged';
  readonly kind: 'challenge';
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly challengeId: string;
  readonly factDigest: string;
  readonly ttlMs: number;
  readonly deliveryDigest: string;
  readonly acknowledgedAtMs: number;
}

export type AcknowledgementRecord =
  | CredentialAcknowledgementRecord
  | ChallengeAcknowledgementRecord;

export function isMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export function recordName(
  record: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>,
  state: 'pending' | 'ready',
): string {
  return `${record.kind}-${record.mutationId}.${state}.json`;
}

export function sameRecord(
  left: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>,
  right: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameRequestSemantic(
  left: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>,
  right: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>,
): boolean {
  return (
    left.kind === right.kind &&
    left.mutationId === right.mutationId &&
    left.requestId === right.requestId &&
    left.ttlMs === right.ttlMs &&
    (left.kind !== 'challenge' ||
      (right.kind === 'challenge' && left.projectId === right.projectId))
  );
}

export function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

export function deliveryClaimRequest(
  value: ClaimLocalOwnerFromDeliveriesRequest,
): Readonly<ClaimLocalOwnerFromDeliveriesRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'projectId',
      'mutationId',
      'requestId',
      'credentialMutationId',
      'challengeMutationId',
    ])
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'delivery claim request shape is invalid',
    );
  }
  try {
    assertProjectPolicyProjectId(value.projectId);
    assertLocalOwnerBootstrapMutationId(value.mutationId);
    assertLocalOwnerBootstrapRequestId(value.requestId);
    assertLocalOwnerBootstrapMutationId(value.credentialMutationId);
    assertLocalOwnerBootstrapMutationId(value.challengeMutationId);
  } catch (error) {
    throw new LocalOwnerSecretDeliveryError(
      'delivery claim request value is invalid',
      error,
    );
  }
  if (
    value.mutationId === value.credentialMutationId ||
    value.mutationId === value.challengeMutationId ||
    value.credentialMutationId === value.challengeMutationId
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'delivery claim mutations must be distinct',
    );
  }
  return Object.freeze({ ...value });
}

export function acknowledgementName(
  kind: 'credential' | 'challenge',
  mutationId: string,
): string {
  return `${kind}-${mutationId}.acknowledged.json`;
}

export function sameAcknowledgementSemantic(
  left: Readonly<AcknowledgementRecord>,
  right: Readonly<AcknowledgementRecord>,
): boolean {
  return (
    left.state === right.state &&
    left.kind === right.kind &&
    left.mutationId === right.mutationId &&
    left.requestId === right.requestId &&
    left.factDigest === right.factDigest &&
    left.ttlMs === right.ttlMs &&
    left.deliveryDigest === right.deliveryDigest &&
    (left.kind === 'credential'
      ? right.kind === 'credential' &&
        left.subjectId === right.subjectId &&
        left.credentialId === right.credentialId
      : right.kind === 'challenge' &&
        left.projectId === right.projectId &&
        left.challengeId === right.challengeId)
  );
}

export function persistentAcknowledgement(
  acknowledgement: Readonly<AcknowledgementRecord>,
): Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord> {
  const { state: _state, ...record } = acknowledgement;
  return normalizeLocalOwnerSecretDeliveryAcknowledgementRecord(record);
}

export function fileAcknowledgement(
  acknowledgement: Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord>,
): Readonly<AcknowledgementRecord> {
  return normalizeAcknowledgement({
    state: 'acknowledged',
    ...acknowledgement,
  });
}

export function normalizeAcknowledgement(raw: unknown): AcknowledgementRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LocalOwnerSecretDeliveryError('acknowledgement is invalid');
  }
  const value = raw as AcknowledgementRecord;
  try {
    assertLocalOwnerBootstrapMutationId(value.mutationId);
    assertLocalOwnerBootstrapRequestId(value.requestId);
  } catch (error) {
    throw new LocalOwnerSecretDeliveryError(
      'acknowledgement mutation is invalid',
      error,
    );
  }
  if (
    value.state !== 'acknowledged' ||
    !/^[0-9a-f]{64}$/.test(value.factDigest) ||
    !/^[0-9a-f]{64}$/.test(value.deliveryDigest) ||
    !Number.isSafeInteger(value.ttlMs) ||
    value.ttlMs < 1 ||
    !Number.isSafeInteger(value.acknowledgedAtMs) ||
    value.acknowledgedAtMs < 0
  ) {
    throw new LocalOwnerSecretDeliveryError('acknowledgement is invalid');
  }
  if (value.kind === 'credential') {
    if (
      !exactKeys(value, [
        'state',
        'kind',
        'mutationId',
        'requestId',
        'subjectId',
        'credentialId',
        'factDigest',
        'ttlMs',
        'deliveryDigest',
        'acknowledgedAtMs',
      ]) ||
      !/^usr_[A-Za-z0-9_-]{22}$/.test(value.subjectId) ||
      !/^own_[A-Za-z0-9_-]{22}$/.test(value.credentialId)
    ) {
      throw new LocalOwnerSecretDeliveryError(
        'credential acknowledgement is invalid',
      );
    }
    return Object.freeze({ ...value });
  }
  if (
    value.kind !== 'challenge' ||
    !exactKeys(value, [
      'state',
      'kind',
      'projectId',
      'mutationId',
      'requestId',
      'challengeId',
      'factDigest',
      'ttlMs',
      'deliveryDigest',
      'acknowledgedAtMs',
    ])
  ) {
    throw new LocalOwnerSecretDeliveryError(
      'challenge acknowledgement is invalid',
    );
  }
  try {
    assertProjectPolicyProjectId(value.projectId);
    assertLocalOwnerBootstrapChallengeId(value.challengeId);
  } catch (error) {
    throw new LocalOwnerSecretDeliveryError(
      'challenge acknowledgement is invalid',
      error,
    );
  }
  return Object.freeze({ ...value });
}

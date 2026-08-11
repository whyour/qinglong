import { createHash } from 'node:crypto';

import {
  PluginPackagePublisherTrustRegistry,
  type PluginPackagePublisherKeyDefinition,
} from '@qinglong/runtime-core/plugin-package-bundle';

import {
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_INTENT_SCHEMA,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_RECEIPT_SCHEMA,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_PROPOSAL_SCHEMA,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_RECEIPT_SCHEMA,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA,
  LocalPluginPackagePublisherTrustConfigurationError,
  type LocalPluginPackagePublisherKeyRevocationReceipt,
  type LocalPluginPackagePublisherTrustDocument,
} from './contracts';

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const MUTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface TrustSnapshot {
  readonly schema: typeof LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA;
  readonly generation: number;
  readonly previousSnapshotDigest: string | null;
  readonly previousTrustDigest: string | null;
  readonly trustDigest: string;
  readonly mutationId: string;
  readonly occurredAtMs: number;
  readonly mode: 'provision' | 'rotate' | 'retire' | 'revoke';
  readonly trust: Readonly<LocalPluginPackagePublisherTrustDocument>;
  readonly snapshotDigest: string;
}

export interface RetirementIntent {
  readonly schema: typeof LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_INTENT_SCHEMA;
  readonly publisher: string;
  readonly keyId: string;
  readonly expectedGeneration: number;
  readonly previousTrustDigest: string;
  readonly mutationId: string;
  readonly occurredAtMs: number;
  readonly intentDigest: string;
}

export interface RetirementReceipt {
  readonly schema: typeof LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_RECEIPT_SCHEMA;
  readonly publisher: string;
  readonly keyId: string;
  readonly expectedGeneration: number;
  readonly mutationId: string;
  readonly intentDigest: string;
  readonly catalogEntryCount: number;
  readonly bundleCount: number;
  readonly matchingEntryCount: 0;
  readonly unresolvedTransactions: 0;
  readonly occurredAtMs: number;
  readonly receiptDigest: string;
}

export interface RevocationProposal {
  readonly schema: typeof LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_PROPOSAL_SCHEMA;
  readonly publisher: string;
  readonly keyId: string;
  readonly expectedGeneration: number;
  readonly previousTrustDigest: string;
  readonly mutationId: string;
  readonly occurredAtMs: number;
  readonly proposerSubjectId: string;
  readonly catalogEntryCount: number;
  readonly bundleCount: number;
  readonly matchingEntryCount: number;
  readonly unresolvedTransactions: number;
  readonly impactedLockDigests: readonly string[];
  readonly impactDigest: string;
  readonly proposalDigest: string;
}

export interface RevocationReceipt
  extends LocalPluginPackagePublisherKeyRevocationReceipt {
  readonly schema: typeof LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_RECEIPT_SCHEMA;
  readonly publisher: string;
  readonly keyId: string;
  readonly expectedGeneration: number;
  readonly mutationId: string;
  readonly proposalDigest: string;
  readonly proposerSubjectId: string;
  readonly confirmerSubjectId: string;
  readonly authorizationMode: 'dual_control' | 'break_glass';
  readonly reasonCode: 'suspected_key_compromise' | 'confirmed_key_compromise';
  readonly confirmedAtMs: number;
  readonly impactDigest: string;
  readonly impactedLockDigests: readonly string[];
  readonly receiptDigest: string;
}

export function activeKeyCount(
  trust: Readonly<LocalPluginPackagePublisherTrustDocument> | undefined,
  observedAtMs: number,
): number {
  return (
    trust?.keys.filter(
      (key) => key.notBeforeMs <= observedAtMs && observedAtMs < key.notAfterMs,
    ).length ?? 0
  );
}

export function keyMap(
  trust: Readonly<LocalPluginPackagePublisherTrustDocument>,
): ReadonlyMap<string, Readonly<PluginPackagePublisherKeyDefinition>> {
  return new Map(
    trust.keys.map((key) => [`${key.publisher}\0${key.keyId}`, key]),
  );
}

export function sameSnapshot(
  left: Readonly<TrustSnapshot>,
  right: Readonly<TrustSnapshot>,
): boolean {
  return left.snapshotDigest === right.snapshotDigest;
}

export function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      `${label} must be an object`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      `${label} must contain enumerable data properties`,
    );
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

export function integer(value: unknown, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      `${label} is invalid`,
    );
  }
  return value as number;
}

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalKey(
  value: unknown,
): Readonly<PluginPackagePublisherKeyDefinition> {
  const key = dataRecord(value, 'publisher key');
  exactKeys(
    key,
    ['keyId', 'notAfterMs', 'notBeforeMs', 'publicKeyPem', 'publisher'],
    'publisher key',
  );
  return Object.freeze({
    publisher: key.publisher as string,
    keyId: key.keyId as string,
    publicKeyPem: key.publicKeyPem as string,
    notBeforeMs: key.notBeforeMs as number,
    notAfterMs: key.notAfterMs as number,
  });
}

export function normalizeLocalPluginPackagePublisherTrustDocument(
  value: unknown,
): Readonly<LocalPluginPackagePublisherTrustDocument> {
  const document = dataRecord(value, 'publisher trust');
  exactKeys(document, ['keys', 'schema'], 'publisher trust');
  if (
    document.schema !== LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA ||
    !Array.isArray(document.keys)
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher trust shape is invalid',
    );
  }
  const keys = document.keys.map(canonicalKey);
  if (keys.length > 0) {
    try {
      new PluginPackagePublisherTrustRegistry(keys);
    } catch (error) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'publisher trust keys are invalid',
        error,
      );
    }
  }
  keys.sort((left, right) =>
    `${left.publisher}\0${left.keyId}`.localeCompare(
      `${right.publisher}\0${right.keyId}`,
    ),
  );
  return Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
    keys: Object.freeze(keys),
  });
}

export function createLocalPluginPackagePublisherTrustRegistry(
  value: unknown,
): PluginPackagePublisherTrustRegistry {
  const trust = normalizeLocalPluginPackagePublisherTrustDocument(value);
  return new PluginPackagePublisherTrustRegistry(trust.keys);
}

export function canonicalTrust(
  trust: Readonly<LocalPluginPackagePublisherTrustDocument>,
): string {
  return `${JSON.stringify(trust)}\n`;
}

export function boundedIdentity(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 256 ||
    value.includes('\0')
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      `${label} is invalid`,
    );
  }
  return value;
}

export function retirementIdentityDigest(publisher: string, keyId: string): string {
  return digest(`${publisher}\0${keyId}`);
}

export function retirementIntentMaterial(
  value: Omit<RetirementIntent, 'intentDigest'>,
): string {
  return JSON.stringify(value);
}

export function retirementReceiptMaterial(
  value: Omit<RetirementReceipt, 'receiptDigest'>,
): string {
  return JSON.stringify(value);
}

export function normalizeRetirementIntent(value: unknown): Readonly<RetirementIntent> {
  const intent = dataRecord(value, 'publisher key retirement intent');
  exactKeys(
    intent,
    [
      'expectedGeneration',
      'intentDigest',
      'keyId',
      'mutationId',
      'occurredAtMs',
      'previousTrustDigest',
      'publisher',
      'schema',
    ],
    'publisher key retirement intent',
  );
  const publisher = boundedIdentity(intent.publisher, 'retirement publisher');
  const keyId = boundedIdentity(intent.keyId, 'retirement keyId');
  const expectedGeneration = integer(
    intent.expectedGeneration,
    1,
    'retirement expectedGeneration',
  );
  const occurredAtMs = integer(
    intent.occurredAtMs,
    0,
    'retirement occurredAtMs',
  );
  if (
    intent.schema !==
      LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_INTENT_SCHEMA ||
    typeof intent.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(intent.mutationId) ||
    typeof intent.previousTrustDigest !== 'string' ||
    !DIGEST_PATTERN.test(intent.previousTrustDigest) ||
    typeof intent.intentDigest !== 'string' ||
    !DIGEST_PATTERN.test(intent.intentDigest)
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key retirement intent fields are invalid',
    );
  }
  const material = Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_INTENT_SCHEMA,
    publisher,
    keyId,
    expectedGeneration,
    previousTrustDigest: intent.previousTrustDigest,
    mutationId: intent.mutationId,
    occurredAtMs,
  });
  if (digest(retirementIntentMaterial(material)) !== intent.intentDigest) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key retirement intent digest is invalid',
    );
  }
  return Object.freeze({ ...material, intentDigest: intent.intentDigest });
}

export function normalizeRetirementReceipt(
  value: unknown,
): Readonly<RetirementReceipt> {
  const receipt = dataRecord(value, 'publisher key retirement receipt');
  exactKeys(
    receipt,
    [
      'bundleCount',
      'catalogEntryCount',
      'expectedGeneration',
      'intentDigest',
      'keyId',
      'matchingEntryCount',
      'mutationId',
      'occurredAtMs',
      'publisher',
      'receiptDigest',
      'schema',
      'unresolvedTransactions',
    ],
    'publisher key retirement receipt',
  );
  const publisher = boundedIdentity(receipt.publisher, 'retirement publisher');
  const keyId = boundedIdentity(receipt.keyId, 'retirement keyId');
  const expectedGeneration = integer(
    receipt.expectedGeneration,
    1,
    'retirement expectedGeneration',
  );
  const occurredAtMs = integer(
    receipt.occurredAtMs,
    0,
    'retirement occurredAtMs',
  );
  const catalogEntryCount = integer(
    receipt.catalogEntryCount,
    0,
    'retirement catalogEntryCount',
  );
  const bundleCount = integer(receipt.bundleCount, 0, 'retirement bundleCount');
  if (
    receipt.schema !==
      LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_RECEIPT_SCHEMA ||
    typeof receipt.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(receipt.mutationId) ||
    typeof receipt.intentDigest !== 'string' ||
    !DIGEST_PATTERN.test(receipt.intentDigest) ||
    receipt.matchingEntryCount !== 0 ||
    receipt.unresolvedTransactions !== 0 ||
    typeof receipt.receiptDigest !== 'string' ||
    !DIGEST_PATTERN.test(receipt.receiptDigest)
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key retirement receipt fields are invalid',
    );
  }
  const material = Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_RECEIPT_SCHEMA,
    publisher,
    keyId,
    expectedGeneration,
    mutationId: receipt.mutationId,
    intentDigest: receipt.intentDigest,
    catalogEntryCount,
    bundleCount,
    matchingEntryCount: 0 as const,
    unresolvedTransactions: 0 as const,
    occurredAtMs,
  });
  if (digest(retirementReceiptMaterial(material)) !== receipt.receiptDigest) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key retirement receipt digest is invalid',
    );
  }
  return Object.freeze({ ...material, receiptDigest: receipt.receiptDigest });
}

export function lockDigests(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      `${label} is invalid`,
    );
  }
  const normalized = value.map((candidate) => {
    if (typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate)) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        `${label} is invalid`,
      );
    }
    return candidate;
  });
  const sorted = [...normalized].sort();
  if (
    new Set(sorted).size !== sorted.length ||
    normalized.some((candidate, index) => candidate !== sorted[index])
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      `${label} must be unique and sorted`,
    );
  }
  return Object.freeze(sorted);
}

export function localPluginPackagePublisherKeyRevocationImpactDigest(
  value: Readonly<{
    publisher: string;
    keyId: string;
    catalogEntryCount: number;
    bundleCount: number;
    matchingEntryCount: number;
    unresolvedTransactions: number;
    impactedLockDigests: readonly string[];
  }>,
): string {
  const publisher = boundedIdentity(value.publisher, 'impact publisher');
  const keyId = boundedIdentity(value.keyId, 'impact keyId');
  const catalogEntryCount = integer(
    value.catalogEntryCount,
    0,
    'impact catalogEntryCount',
  );
  const bundleCount = integer(value.bundleCount, 0, 'impact bundleCount');
  const matchingEntryCount = integer(
    value.matchingEntryCount,
    0,
    'impact matchingEntryCount',
  );
  const unresolvedTransactions = integer(
    value.unresolvedTransactions,
    0,
    'impact unresolvedTransactions',
  );
  const impactedLockDigests = lockDigests(
    value.impactedLockDigests,
    'impact lock digests',
  );
  if (
    matchingEntryCount !== impactedLockDigests.length ||
    catalogEntryCount < matchingEntryCount
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'revocation impact counts are invalid',
    );
  }
  return digest(
    JSON.stringify({
      publisher,
      keyId,
      catalogEntryCount,
      bundleCount,
      matchingEntryCount,
      unresolvedTransactions,
      impactedLockDigests,
    }),
  );
}

export function revocationProposalMaterial(
  value: Omit<RevocationProposal, 'proposalDigest'>,
): string {
  return JSON.stringify(value);
}

export function revocationReceiptMaterial(
  value: Omit<RevocationReceipt, 'receiptDigest'>,
): string {
  return JSON.stringify(value);
}

export function normalizeRevocationProposal(
  value: unknown,
): Readonly<RevocationProposal> {
  const proposal = dataRecord(value, 'publisher key revocation proposal');
  exactKeys(
    proposal,
    [
      'bundleCount',
      'catalogEntryCount',
      'expectedGeneration',
      'impactDigest',
      'impactedLockDigests',
      'keyId',
      'matchingEntryCount',
      'mutationId',
      'occurredAtMs',
      'previousTrustDigest',
      'proposalDigest',
      'proposerSubjectId',
      'publisher',
      'schema',
      'unresolvedTransactions',
    ],
    'publisher key revocation proposal',
  );
  const publisher = boundedIdentity(proposal.publisher, 'revocation publisher');
  const keyId = boundedIdentity(proposal.keyId, 'revocation keyId');
  const proposerSubjectId = boundedIdentity(
    proposal.proposerSubjectId,
    'revocation proposer subject',
  );
  const expectedGeneration = integer(
    proposal.expectedGeneration,
    1,
    'revocation expectedGeneration',
  );
  const occurredAtMs = integer(
    proposal.occurredAtMs,
    0,
    'revocation occurredAtMs',
  );
  const catalogEntryCount = integer(
    proposal.catalogEntryCount,
    0,
    'revocation catalogEntryCount',
  );
  const bundleCount = integer(
    proposal.bundleCount,
    0,
    'revocation bundleCount',
  );
  const matchingEntryCount = integer(
    proposal.matchingEntryCount,
    0,
    'revocation matchingEntryCount',
  );
  const unresolvedTransactions = integer(
    proposal.unresolvedTransactions,
    0,
    'revocation unresolvedTransactions',
  );
  const impactedLockDigests = lockDigests(
    proposal.impactedLockDigests,
    'revocation impacted lock digests',
  );
  if (
    proposal.schema !==
      LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_PROPOSAL_SCHEMA ||
    typeof proposal.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(proposal.mutationId) ||
    typeof proposal.previousTrustDigest !== 'string' ||
    !DIGEST_PATTERN.test(proposal.previousTrustDigest) ||
    typeof proposal.impactDigest !== 'string' ||
    !DIGEST_PATTERN.test(proposal.impactDigest) ||
    typeof proposal.proposalDigest !== 'string' ||
    !DIGEST_PATTERN.test(proposal.proposalDigest) ||
    localPluginPackagePublisherKeyRevocationImpactDigest({
      publisher,
      keyId,
      catalogEntryCount,
      bundleCount,
      matchingEntryCount,
      unresolvedTransactions,
      impactedLockDigests,
    }) !== proposal.impactDigest
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key revocation proposal fields are invalid',
    );
  }
  const material = Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_PROPOSAL_SCHEMA,
    publisher,
    keyId,
    expectedGeneration,
    previousTrustDigest: proposal.previousTrustDigest,
    mutationId: proposal.mutationId,
    occurredAtMs,
    proposerSubjectId,
    catalogEntryCount,
    bundleCount,
    matchingEntryCount,
    unresolvedTransactions,
    impactedLockDigests,
    impactDigest: proposal.impactDigest,
  });
  if (
    digest(revocationProposalMaterial(material)) !== proposal.proposalDigest
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key revocation proposal digest is invalid',
    );
  }
  return Object.freeze({
    ...material,
    proposalDigest: proposal.proposalDigest,
  });
}

export function normalizeRevocationReceipt(
  value: unknown,
): Readonly<RevocationReceipt> {
  const receipt = dataRecord(value, 'publisher key revocation receipt');
  exactKeys(
    receipt,
    [
      'authorizationMode',
      'confirmedAtMs',
      'confirmerSubjectId',
      'expectedGeneration',
      'impactDigest',
      'impactedLockDigests',
      'keyId',
      'mutationId',
      'proposalDigest',
      'proposerSubjectId',
      'publisher',
      'reasonCode',
      'receiptDigest',
      'schema',
    ],
    'publisher key revocation receipt',
  );
  const publisher = boundedIdentity(receipt.publisher, 'revocation publisher');
  const keyId = boundedIdentity(receipt.keyId, 'revocation keyId');
  const proposerSubjectId = boundedIdentity(
    receipt.proposerSubjectId,
    'revocation proposer subject',
  );
  const confirmerSubjectId = boundedIdentity(
    receipt.confirmerSubjectId,
    'revocation confirmer subject',
  );
  const expectedGeneration = integer(
    receipt.expectedGeneration,
    1,
    'revocation expectedGeneration',
  );
  const confirmedAtMs = integer(
    receipt.confirmedAtMs,
    0,
    'revocation confirmedAtMs',
  );
  const impactedLockDigests = lockDigests(
    receipt.impactedLockDigests,
    'revocation impacted lock digests',
  );
  if (
    receipt.schema !==
      LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_RECEIPT_SCHEMA ||
    typeof receipt.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(receipt.mutationId) ||
    typeof receipt.proposalDigest !== 'string' ||
    !DIGEST_PATTERN.test(receipt.proposalDigest) ||
    typeof receipt.impactDigest !== 'string' ||
    !DIGEST_PATTERN.test(receipt.impactDigest) ||
    (receipt.authorizationMode !== 'dual_control' &&
      receipt.authorizationMode !== 'break_glass') ||
    (receipt.authorizationMode === 'dual_control' &&
      proposerSubjectId === confirmerSubjectId) ||
    (receipt.reasonCode !== 'suspected_key_compromise' &&
      receipt.reasonCode !== 'confirmed_key_compromise') ||
    typeof receipt.receiptDigest !== 'string' ||
    !DIGEST_PATTERN.test(receipt.receiptDigest)
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key revocation receipt fields are invalid',
    );
  }
  const material = Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_RECEIPT_SCHEMA,
    publisher,
    keyId,
    expectedGeneration,
    mutationId: receipt.mutationId,
    proposalDigest: receipt.proposalDigest,
    proposerSubjectId,
    confirmerSubjectId,
    authorizationMode: receipt.authorizationMode,
    reasonCode: receipt.reasonCode,
    confirmedAtMs,
    impactDigest: receipt.impactDigest,
    impactedLockDigests,
  });
  if (digest(revocationReceiptMaterial(material)) !== receipt.receiptDigest) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key revocation receipt digest is invalid',
    );
  }
  return Object.freeze({ ...material, receiptDigest: receipt.receiptDigest });
}

export function snapshotMaterial(
  value: Omit<TrustSnapshot, 'snapshotDigest'>,
): string {
  return JSON.stringify(value);
}

export function normalizeSnapshot(value: unknown): Readonly<TrustSnapshot> {
  const snapshot = dataRecord(value, 'publisher trust snapshot');
  exactKeys(
    snapshot,
    [
      'generation',
      'mode',
      'mutationId',
      'occurredAtMs',
      'previousSnapshotDigest',
      'previousTrustDigest',
      'schema',
      'snapshotDigest',
      'trust',
      'trustDigest',
    ],
    'publisher trust snapshot',
  );
  const generation = integer(snapshot.generation, 1, 'snapshot generation');
  const occurredAtMs = integer(
    snapshot.occurredAtMs,
    0,
    'snapshot occurredAtMs',
  );
  if (
    snapshot.schema !== LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA ||
    (snapshot.mode !== 'provision' &&
      snapshot.mode !== 'rotate' &&
      snapshot.mode !== 'retire' &&
      snapshot.mode !== 'revoke') ||
    typeof snapshot.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(snapshot.mutationId) ||
    (snapshot.previousSnapshotDigest !== null &&
      (typeof snapshot.previousSnapshotDigest !== 'string' ||
        !DIGEST_PATTERN.test(snapshot.previousSnapshotDigest))) ||
    (snapshot.previousTrustDigest !== null &&
      (typeof snapshot.previousTrustDigest !== 'string' ||
        !DIGEST_PATTERN.test(snapshot.previousTrustDigest))) ||
    typeof snapshot.trustDigest !== 'string' ||
    !DIGEST_PATTERN.test(snapshot.trustDigest) ||
    typeof snapshot.snapshotDigest !== 'string' ||
    !DIGEST_PATTERN.test(snapshot.snapshotDigest)
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher trust snapshot fields are invalid',
    );
  }
  const trust = normalizeLocalPluginPackagePublisherTrustDocument(
    snapshot.trust,
  );
  if (digest(canonicalTrust(trust)) !== snapshot.trustDigest) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher trust snapshot trust digest is invalid',
    );
  }
  const material = Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA,
    generation,
    previousSnapshotDigest: snapshot.previousSnapshotDigest,
    previousTrustDigest: snapshot.previousTrustDigest,
    trustDigest: snapshot.trustDigest,
    mutationId: snapshot.mutationId,
    occurredAtMs,
    mode: snapshot.mode,
    trust,
  });
  if (digest(snapshotMaterial(material)) !== snapshot.snapshotDigest) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher trust snapshot digest is invalid',
    );
  }
  return Object.freeze({
    ...material,
    snapshotDigest: snapshot.snapshotDigest,
  });
}

export function snapshotName(generation: number): string {
  return `${String(generation).padStart(20, '0')}.json`;
}

export function createSnapshot(
  mode: 'provision' | 'rotate' | 'retire' | 'revoke',
  expectedGeneration: number,
  mutationId: string,
  occurredAtMs: number,
  trust: Readonly<LocalPluginPackagePublisherTrustDocument>,
  previous: Readonly<TrustSnapshot> | undefined,
): Readonly<TrustSnapshot> {
  const material = Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA,
    generation: expectedGeneration + 1,
    previousSnapshotDigest: previous?.snapshotDigest ?? null,
    previousTrustDigest: previous?.trustDigest ?? null,
    trustDigest: digest(canonicalTrust(trust)),
    mutationId,
    occurredAtMs,
    mode,
    trust,
  });
  return Object.freeze({
    ...material,
    snapshotDigest: digest(snapshotMaterial(material)),
  });
}

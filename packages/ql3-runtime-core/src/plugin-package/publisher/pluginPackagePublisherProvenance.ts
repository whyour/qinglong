import { createHash } from 'node:crypto';

import type { PluginPackagePublisherSignatureEvidence } from '../pluginPackageBundle';
import {
  SECURITY_SUBJECT_TYPES,
  type SecuritySubject,
} from '../../security/security';

export const PLUGIN_PACKAGE_PUBLISHER_PROVENANCE_SCHEMA =
  'qinglong/plugin-package-publisher-provenance@v1' as const;
export const PLUGIN_PACKAGE_PUBLISHER_REVOCATION_RECEIPT_SCHEMA =
  'qinglong/plugin-package-publisher-key-revocation-receipt@v1' as const;
export const PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_SCHEMA =
  'qinglong/plugin-package-publisher-key-revocation-impact@v1' as const;
export const MAX_PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_ITEMS = 4096;

export interface PluginPackagePublisherProvenance {
  readonly schema: typeof PLUGIN_PACKAGE_PUBLISHER_PROVENANCE_SCHEMA;
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
  readonly lockDigest: string;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly contentDigest: string;
  readonly stageEvidenceDigest: string;
  readonly publisher: string;
  readonly keyId: string;
  readonly signatureDigest: string;
  readonly keyNotBeforeMs: number;
  readonly keyNotAfterMs: number;
  readonly verifiedAtMs: number;
  readonly provenanceDigest: string;
}

export interface CreatePluginPackagePublisherProvenanceInput {
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
  readonly lockDigest: string;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly contentDigest: string;
  readonly stageEvidenceDigest: string;
  readonly signature: Readonly<PluginPackagePublisherSignatureEvidence>;
}

export type PluginPackagePublisherRevocationAuthorizationMode =
  | 'dual_control'
  | 'break_glass';
export type PluginPackagePublisherRevocationReason =
  | 'suspected_key_compromise'
  | 'confirmed_key_compromise';

export interface PluginPackagePublisherRevocationReceipt {
  readonly schema: typeof PLUGIN_PACKAGE_PUBLISHER_REVOCATION_RECEIPT_SCHEMA;
  readonly mutationId: string;
  readonly publisher: string;
  readonly keyId: string;
  readonly previousTrustDigest: string;
  readonly currentTrustDigest: string;
  readonly proposer: Readonly<SecuritySubject>;
  readonly confirmer: Readonly<SecuritySubject>;
  readonly authorizationMode: PluginPackagePublisherRevocationAuthorizationMode;
  readonly reasonCode: PluginPackagePublisherRevocationReason;
  readonly revokedAtMs: number;
  readonly receiptDigest: string;
}

export type CreatePluginPackagePublisherRevocationReceiptInput = Omit<
  PluginPackagePublisherRevocationReceipt,
  'receiptDigest' | 'schema'
>;

export interface PluginPackagePublisherRevocationImpactItem {
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
  readonly lockDigest: string;
  readonly provenanceDigest: string;
}

export interface PluginPackagePublisherRevocationImpact {
  readonly schema: typeof PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_SCHEMA;
  readonly revocationReceiptDigest: string;
  readonly items: readonly Readonly<PluginPackagePublisherRevocationImpactItem>[];
  readonly generatedAtMs: number;
  readonly impactDigest: string;
}

export type CreatePluginPackagePublisherRevocationImpactInput = Omit<
  PluginPackagePublisherRevocationImpact,
  'impactDigest' | 'schema'
>;

export class InvalidPluginPackagePublisherProvenanceError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_PROVENANCE_INVALID';

  constructor(message: string) {
    super(`Plugin Package publisher provenance is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePublisherProvenanceError';
  }
}

export class PluginPackagePublisherProvenanceConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_PROVENANCE_CONFLICT';

  constructor(message: string) {
    super(`Plugin Package publisher provenance conflicts with durable state: ${message}`);
    this.name = 'PluginPackagePublisherProvenanceConflictError';
  }
}

export class PluginPackagePublisherProvenanceUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_PROVENANCE_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package publisher provenance is unavailable', options);
    this.name = 'PluginPackagePublisherProvenanceUnavailableError';
  }
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PUBLISHER_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SUBJECT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PROVENANCE_DIGEST_DOMAIN =
  'qinglong/plugin-package-publisher-provenance-digest@v1\0';
const REVOCATION_RECEIPT_DIGEST_DOMAIN =
  'qinglong/plugin-package-publisher-key-revocation-receipt-digest@v1\0';
const REVOCATION_IMPACT_DIGEST_DOMAIN =
  'qinglong/plugin-package-publisher-key-revocation-impact-digest@v1\0';

function invalid(message: string): never {
  throw new InvalidPluginPackagePublisherProvenanceError(message);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
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
    return invalid(`${label} must contain enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const canonical = [...expected].sort();
  if (
    actual.some((key) => typeof key !== 'string') ||
    actual.length !== canonical.length ||
    actual
      .map(String)
      .sort()
      .some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function projectId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    value.includes('\0')
  ) {
    return invalid('projectId is invalid');
  }
  return value;
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME_PATTERN.test(value)) {
    return invalid('packageName is invalid');
  }
  return value;
}

function publisher(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 253 ||
    !PUBLISHER_PATTERN.test(value)
  ) {
    return invalid('publisher is invalid');
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function subject(
  value: SecuritySubject,
  label: string,
): Readonly<SecuritySubject> {
  const record = dataRecord(value, label);
  exactKeys(record, ['id', 'type'], label);
  if (
    typeof value.type !== 'string' ||
    !SECURITY_SUBJECT_TYPES.includes(
      value.type as (typeof SECURITY_SUBJECT_TYPES)[number],
    ) ||
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    Buffer.byteLength(value.id, 'utf8') > 255 ||
    SUBJECT_CONTROL_PATTERN.test(value.id)
  ) {
    return invalid(`${label} is invalid`);
  }
  return Object.freeze({
    type: value.type as (typeof SECURITY_SUBJECT_TYPES)[number],
    id: value.id,
  });
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function provenanceFields(
  value: Omit<PluginPackagePublisherProvenance, 'provenanceDigest'>,
): object {
  return {
    schema: value.schema,
    projectId: value.projectId,
    packageName: value.packageName,
    installationId: value.installationId,
    lockDigest: value.lockDigest,
    artifactDigest: value.artifactDigest,
    manifestDigest: value.manifestDigest,
    contentDigest: value.contentDigest,
    stageEvidenceDigest: value.stageEvidenceDigest,
    publisher: value.publisher,
    keyId: value.keyId,
    signatureDigest: value.signatureDigest,
    keyNotBeforeMs: value.keyNotBeforeMs,
    keyNotAfterMs: value.keyNotAfterMs,
    verifiedAtMs: value.verifiedAtMs,
  };
}

export function pluginPackagePublisherProvenanceDigest(
  value: Omit<PluginPackagePublisherProvenance, 'provenanceDigest'>,
): string {
  return createHash('sha256')
    .update(PROVENANCE_DIGEST_DOMAIN)
    .update(JSON.stringify(provenanceFields(value)))
    .digest('hex');
}

export function normalizePluginPackagePublisherProvenance(
  value: PluginPackagePublisherProvenance,
): Readonly<PluginPackagePublisherProvenance> {
  const record = dataRecord(value, 'provenance');
  exactKeys(
    record,
    [
      'artifactDigest',
      'contentDigest',
      'installationId',
      'keyId',
      'keyNotAfterMs',
      'keyNotBeforeMs',
      'lockDigest',
      'manifestDigest',
      'packageName',
      'projectId',
      'provenanceDigest',
      'publisher',
      'schema',
      'signatureDigest',
      'stageEvidenceDigest',
      'verifiedAtMs',
    ],
    'provenance',
  );
  if (value.schema !== PLUGIN_PACKAGE_PUBLISHER_PROVENANCE_SCHEMA) {
    return invalid('provenance schema is invalid');
  }
  const keyNotBeforeMs = timestamp(value.keyNotBeforeMs, 'keyNotBeforeMs');
  const keyNotAfterMs = timestamp(value.keyNotAfterMs, 'keyNotAfterMs');
  const verifiedAtMs = timestamp(value.verifiedAtMs, 'verifiedAtMs');
  if (
    keyNotAfterMs <= keyNotBeforeMs ||
    verifiedAtMs < keyNotBeforeMs ||
    verifiedAtMs >= keyNotAfterMs
  ) {
    return invalid('signature verification time is outside key validity');
  }
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_PUBLISHER_PROVENANCE_SCHEMA,
    projectId: projectId(value.projectId),
    packageName: packageName(value.packageName),
    installationId: identifier(value.installationId, 'installationId'),
    lockDigest: digest(value.lockDigest, 'lockDigest'),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    manifestDigest: digest(value.manifestDigest, 'manifestDigest'),
    contentDigest: digest(value.contentDigest, 'contentDigest'),
    stageEvidenceDigest: digest(
      value.stageEvidenceDigest,
      'stageEvidenceDigest',
    ),
    publisher: publisher(value.publisher),
    keyId: identifier(value.keyId, 'keyId'),
    signatureDigest: digest(value.signatureDigest, 'signatureDigest'),
    keyNotBeforeMs,
    keyNotAfterMs,
    verifiedAtMs,
  });
  const provenanceDigest = pluginPackagePublisherProvenanceDigest(normalized);
  if (value.provenanceDigest !== provenanceDigest) {
    return invalid('provenanceDigest does not match provenance');
  }
  return Object.freeze({ ...normalized, provenanceDigest });
}

export function createPluginPackagePublisherProvenance(
  input: CreatePluginPackagePublisherProvenanceInput,
): Readonly<PluginPackagePublisherProvenance> {
  const value = dataRecord(input, 'provenance input');
  exactKeys(
    value,
    [
      'artifactDigest',
      'contentDigest',
      'installationId',
      'lockDigest',
      'manifestDigest',
      'packageName',
      'projectId',
      'signature',
      'stageEvidenceDigest',
    ],
    'provenance input',
  );
  const signature = dataRecord(input.signature, 'signature evidence');
  exactKeys(
    signature,
    [
      'keyId',
      'keyNotAfterMs',
      'keyNotBeforeMs',
      'publisher',
      'signatureDigest',
      'verifiedAtMs',
    ],
    'signature evidence',
  );
  const unsigned: Omit<
    PluginPackagePublisherProvenance,
    'provenanceDigest'
  > = {
    schema: PLUGIN_PACKAGE_PUBLISHER_PROVENANCE_SCHEMA,
    projectId: projectId(input.projectId),
    packageName: packageName(input.packageName),
    installationId: identifier(input.installationId, 'installationId'),
    lockDigest: digest(input.lockDigest, 'lockDigest'),
    artifactDigest: digest(input.artifactDigest, 'artifactDigest'),
    manifestDigest: digest(input.manifestDigest, 'manifestDigest'),
    contentDigest: digest(input.contentDigest, 'contentDigest'),
    stageEvidenceDigest: digest(
      input.stageEvidenceDigest,
      'stageEvidenceDigest',
    ),
    publisher: publisher(input.signature.publisher),
    keyId: identifier(input.signature.keyId, 'keyId'),
    signatureDigest: digest(
      input.signature.signatureDigest,
      'signatureDigest',
    ),
    keyNotBeforeMs: timestamp(
      input.signature.keyNotBeforeMs,
      'keyNotBeforeMs',
    ),
    keyNotAfterMs: timestamp(
      input.signature.keyNotAfterMs,
      'keyNotAfterMs',
    ),
    verifiedAtMs: timestamp(input.signature.verifiedAtMs, 'verifiedAtMs'),
  };
  return normalizePluginPackagePublisherProvenance({
    ...unsigned,
    provenanceDigest: pluginPackagePublisherProvenanceDigest(unsigned),
  });
}

function revocationReceiptFields(
  value: Omit<PluginPackagePublisherRevocationReceipt, 'receiptDigest'>,
): object {
  return {
    schema: value.schema,
    mutationId: value.mutationId,
    publisher: value.publisher,
    keyId: value.keyId,
    previousTrustDigest: value.previousTrustDigest,
    currentTrustDigest: value.currentTrustDigest,
    proposer: value.proposer,
    confirmer: value.confirmer,
    authorizationMode: value.authorizationMode,
    reasonCode: value.reasonCode,
    revokedAtMs: value.revokedAtMs,
  };
}

export function pluginPackagePublisherRevocationReceiptDigest(
  value: Omit<PluginPackagePublisherRevocationReceipt, 'receiptDigest'>,
): string {
  return createHash('sha256')
    .update(REVOCATION_RECEIPT_DIGEST_DOMAIN)
    .update(JSON.stringify(revocationReceiptFields(value)))
    .digest('hex');
}

export function normalizePluginPackagePublisherRevocationReceipt(
  value: PluginPackagePublisherRevocationReceipt,
): Readonly<PluginPackagePublisherRevocationReceipt> {
  const record = dataRecord(value, 'revocation receipt');
  exactKeys(
    record,
    [
      'authorizationMode',
      'confirmer',
      'currentTrustDigest',
      'keyId',
      'mutationId',
      'previousTrustDigest',
      'proposer',
      'publisher',
      'reasonCode',
      'receiptDigest',
      'revokedAtMs',
      'schema',
    ],
    'revocation receipt',
  );
  if (
    value.schema !== PLUGIN_PACKAGE_PUBLISHER_REVOCATION_RECEIPT_SCHEMA ||
    (value.authorizationMode !== 'dual_control' &&
      value.authorizationMode !== 'break_glass') ||
    (value.reasonCode !== 'suspected_key_compromise' &&
      value.reasonCode !== 'confirmed_key_compromise')
  ) {
    return invalid('revocation receipt classification is invalid');
  }
  const proposer = subject(value.proposer, 'proposer');
  const confirmer = subject(value.confirmer, 'confirmer');
  if (
    value.authorizationMode === 'dual_control' &&
    sameSubject(proposer, confirmer)
  ) {
    return invalid('dual-control requires distinct subjects');
  }
  const previousTrustDigest = digest(
    value.previousTrustDigest,
    'previousTrustDigest',
  );
  const currentTrustDigest = digest(
    value.currentTrustDigest,
    'currentTrustDigest',
  );
  if (previousTrustDigest === currentTrustDigest) {
    return invalid('revocation must change the publisher trust digest');
  }
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_PUBLISHER_REVOCATION_RECEIPT_SCHEMA,
    mutationId: identifier(value.mutationId, 'mutationId'),
    publisher: publisher(value.publisher),
    keyId: identifier(value.keyId, 'keyId'),
    previousTrustDigest,
    currentTrustDigest,
    proposer,
    confirmer,
    authorizationMode: value.authorizationMode,
    reasonCode: value.reasonCode,
    revokedAtMs: timestamp(value.revokedAtMs, 'revokedAtMs'),
  });
  const receiptDigest =
    pluginPackagePublisherRevocationReceiptDigest(normalized);
  if (value.receiptDigest !== receiptDigest) {
    return invalid('receiptDigest does not match revocation receipt');
  }
  return Object.freeze({ ...normalized, receiptDigest });
}

export function createPluginPackagePublisherRevocationReceipt(
  input: CreatePluginPackagePublisherRevocationReceiptInput,
): Readonly<PluginPackagePublisherRevocationReceipt> {
  const value = dataRecord(input, 'revocation receipt input');
  exactKeys(
    value,
    [
      'authorizationMode',
      'confirmer',
      'currentTrustDigest',
      'keyId',
      'mutationId',
      'previousTrustDigest',
      'proposer',
      'publisher',
      'reasonCode',
      'revokedAtMs',
    ],
    'revocation receipt input',
  );
  const unsigned: Omit<
    PluginPackagePublisherRevocationReceipt,
    'receiptDigest'
  > = {
    schema: PLUGIN_PACKAGE_PUBLISHER_REVOCATION_RECEIPT_SCHEMA,
    mutationId: input.mutationId,
    publisher: input.publisher,
    keyId: input.keyId,
    previousTrustDigest: input.previousTrustDigest,
    currentTrustDigest: input.currentTrustDigest,
    proposer: input.proposer,
    confirmer: input.confirmer,
    authorizationMode: input.authorizationMode,
    reasonCode: input.reasonCode,
    revokedAtMs: input.revokedAtMs,
  };
  return normalizePluginPackagePublisherRevocationReceipt({
    ...unsigned,
    receiptDigest: pluginPackagePublisherRevocationReceiptDigest(unsigned),
  });
}

function compareImpactItems(
  left: Readonly<PluginPackagePublisherRevocationImpactItem>,
  right: Readonly<PluginPackagePublisherRevocationImpactItem>,
): number {
  return (
    Buffer.compare(
      Buffer.from(left.projectId, 'utf8'),
      Buffer.from(right.projectId, 'utf8'),
    ) ||
    Buffer.compare(
      Buffer.from(left.packageName, 'utf8'),
      Buffer.from(right.packageName, 'utf8'),
    ) ||
    Buffer.compare(
      Buffer.from(left.installationId, 'utf8'),
      Buffer.from(right.installationId, 'utf8'),
    ) ||
    left.lockDigest.localeCompare(right.lockDigest)
  );
}

function normalizeImpactItem(
  value: PluginPackagePublisherRevocationImpactItem,
): Readonly<PluginPackagePublisherRevocationImpactItem> {
  const record = dataRecord(value, 'impact item');
  exactKeys(
    record,
    [
      'installationId',
      'lockDigest',
      'packageName',
      'projectId',
      'provenanceDigest',
    ],
    'impact item',
  );
  return Object.freeze({
    projectId: projectId(value.projectId),
    packageName: packageName(value.packageName),
    installationId: identifier(value.installationId, 'installationId'),
    lockDigest: digest(value.lockDigest, 'lockDigest'),
    provenanceDigest: digest(value.provenanceDigest, 'provenanceDigest'),
  });
}

function impactFields(
  value: Omit<PluginPackagePublisherRevocationImpact, 'impactDigest'>,
): object {
  return {
    schema: value.schema,
    revocationReceiptDigest: value.revocationReceiptDigest,
    items: value.items,
    generatedAtMs: value.generatedAtMs,
  };
}

export function pluginPackagePublisherRevocationImpactDigest(
  value: Omit<PluginPackagePublisherRevocationImpact, 'impactDigest'>,
): string {
  return createHash('sha256')
    .update(REVOCATION_IMPACT_DIGEST_DOMAIN)
    .update(JSON.stringify(impactFields(value)))
    .digest('hex');
}

export function normalizePluginPackagePublisherRevocationImpact(
  value: PluginPackagePublisherRevocationImpact,
): Readonly<PluginPackagePublisherRevocationImpact> {
  const record = dataRecord(value, 'revocation impact');
  exactKeys(
    record,
    [
      'generatedAtMs',
      'impactDigest',
      'items',
      'revocationReceiptDigest',
      'schema',
    ],
    'revocation impact',
  );
  if (
    value.schema !== PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_SCHEMA ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_ITEMS ||
    Object.keys(value.items).some((key, index) => key !== String(index))
  ) {
    return invalid('revocation impact schema or items are invalid');
  }
  const items = Object.freeze(value.items.map(normalizeImpactItem));
  if (
    items.some(
      (item, index) =>
        index > 0 && compareImpactItems(items[index - 1]!, item) >= 0,
    ) ||
    new Set(items.map((item) => item.provenanceDigest)).size !== items.length ||
    new Set(items.map((item) => item.installationId)).size !== items.length
  ) {
    return invalid('revocation impact items must be unique and sorted');
  }
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_SCHEMA,
    revocationReceiptDigest: digest(
      value.revocationReceiptDigest,
      'revocationReceiptDigest',
    ),
    items,
    generatedAtMs: timestamp(value.generatedAtMs, 'generatedAtMs'),
  });
  const impactDigest =
    pluginPackagePublisherRevocationImpactDigest(normalized);
  if (value.impactDigest !== impactDigest) {
    return invalid('impactDigest does not match revocation impact');
  }
  return Object.freeze({ ...normalized, impactDigest });
}

export function createPluginPackagePublisherRevocationImpact(
  input: CreatePluginPackagePublisherRevocationImpactInput,
): Readonly<PluginPackagePublisherRevocationImpact> {
  const value = dataRecord(input, 'revocation impact input');
  exactKeys(
    value,
    ['generatedAtMs', 'items', 'revocationReceiptDigest'],
    'revocation impact input',
  );
  if (
    !Array.isArray(input.items) ||
    input.items.length >
      MAX_PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_ITEMS ||
    Object.keys(input.items).some((key, index) => key !== String(index))
  ) {
    return invalid('revocation impact items are invalid');
  }
  const items = Object.freeze(
    input.items.map(normalizeImpactItem).sort(compareImpactItems),
  );
  const unsigned: Omit<
    PluginPackagePublisherRevocationImpact,
    'impactDigest'
  > = {
    schema: PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_SCHEMA,
    revocationReceiptDigest: input.revocationReceiptDigest,
    items,
    generatedAtMs: input.generatedAtMs,
  };
  return normalizePluginPackagePublisherRevocationImpact({
    ...unsigned,
    impactDigest: pluginPackagePublisherRevocationImpactDigest(unsigned),
  });
}

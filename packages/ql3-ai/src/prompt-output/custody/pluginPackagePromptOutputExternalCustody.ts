import { Buffer } from 'node:buffer';
import {
  createHash,
  createPublicKey,
  KeyObject,
  verify as verifySignature,
  type KeyLike,
} from 'node:crypto';

import {
  normalizePluginPackagePromptOutputArtifact,
  openPluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifact,
} from '../pluginPackagePromptOutputArtifact';
import { pluginPackagePromptOutputKeyRotationMaterialProof } from '../key-management/pluginPackagePromptOutputKeyRotation';

export const PLUGIN_PACKAGE_PROMPT_OUTPUT_CUSTODY_RECEIPT_SCHEMA =
  'qinglong/plugin-package-prompt-output-external-custody-receipt@v1' as const;
export const PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PROOF_SCHEMA =
  'qinglong/plugin-package-prompt-output-external-recovery-proof@v1' as const;
export const MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_WRAPPED_MATERIAL_BYTES =
  64 * 1024;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const RECEIPT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-external-custody-receipt-digest@v1\0',
  'utf8',
);
const SIGNING_KEY_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-external-custody-signing-key-digest@v1\0',
  'utf8',
);
const RECOVERY_PROOF_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-external-recovery-proof-digest@v1\0',
  'utf8',
);

export interface PluginPackagePromptOutputExternalCustodyReceipt {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_CUSTODY_RECEIPT_SCHEMA;
  readonly custodyId: string;
  readonly keyId: string;
  readonly materialProof: string;
  readonly sourceGeneration: number;
  readonly sourceCatalogDigest: string;
  readonly wrappingProvider: string;
  readonly wrappingKeyRefDigest: string;
  readonly wrappedMaterialDigest: string;
  readonly wrappedMaterialBytes: number;
  readonly createdAtMs: number;
  readonly signingKeyDigest: string;
  readonly receiptDigest: string;
  readonly signature: string;
}

export interface PluginPackagePromptOutputDurableKeyFact {
  readonly keyId: string;
  readonly materialProof: string;
  readonly catalogDigest: string;
}

export interface PluginPackagePromptOutputExternalRecoveryProof {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PROOF_SCHEMA;
  readonly recoveryId: string;
  readonly requestId: string;
  readonly custodyId: string;
  readonly custodyReceiptDigest: string;
  readonly keyId: string;
  readonly materialProof: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly contentDigest: string;
  readonly outputBytes: number;
  readonly verifiedAtMs: number;
  readonly proofDigest: string;
}

export class InvalidPluginPackagePromptOutputExternalCustodyError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_INVALID';

  constructor(message: string) {
    super(`Prompt output external custody is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePromptOutputExternalCustodyError';
  }
}

export class PluginPackagePromptOutputExternalCustodyUntrustedError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_UNTRUSTED';

  constructor() {
    super('Prompt output external custody receipt is untrusted');
    this.name = 'PluginPackagePromptOutputExternalCustodyUntrustedError';
  }
}

export class PluginPackagePromptOutputExternalRecoveryUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_RECOVERY_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Prompt output external recovery is unavailable', options);
    this.name = 'PluginPackagePromptOutputExternalRecoveryUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidPluginPackagePromptOutputExternalCustodyError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function patterned(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  return patterned(value, DIGEST_PATTERN, label);
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${label} is invalid`);
  }
  return value as number;
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid('source generation is invalid');
  }
  return value as number;
}

function byteLength(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_WRAPPED_MATERIAL_BYTES
  ) {
    invalid('wrapped material byte length is invalid');
  }
  return value as number;
}

function hash(domain: Buffer, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function publicEd25519Key(value: KeyLike | KeyObject): KeyObject {
  try {
    const key =
      value instanceof KeyObject && value.type === 'public'
        ? value
        : createPublicKey(value);
    if (key.asymmetricKeyType !== 'ed25519') invalid('signing key is invalid');
    return key;
  } catch (cause) {
    if (cause instanceof InvalidPluginPackagePromptOutputExternalCustodyError) {
      throw cause;
    }
    return invalid('signing key is invalid');
  }
}

export function pluginPackagePromptOutputCustodySigningKeyDigest(
  value: KeyLike | KeyObject,
): string {
  const key = publicEd25519Key(value);
  const spki = key.export({ format: 'der', type: 'spki' });
  try {
    return createHash('sha256')
      .update(SIGNING_KEY_DIGEST_DOMAIN)
      .update(spki)
      .digest('hex');
  } finally {
    spki.fill(0);
  }
}

function receiptUnsigned(
  value: Readonly<PluginPackagePromptOutputExternalCustodyReceipt>,
): Omit<
  PluginPackagePromptOutputExternalCustodyReceipt,
  'receiptDigest' | 'signature'
> {
  return Object.freeze({
    schema: value.schema,
    custodyId: value.custodyId,
    keyId: value.keyId,
    materialProof: value.materialProof,
    sourceGeneration: value.sourceGeneration,
    sourceCatalogDigest: value.sourceCatalogDigest,
    wrappingProvider: value.wrappingProvider,
    wrappingKeyRefDigest: value.wrappingKeyRefDigest,
    wrappedMaterialDigest: value.wrappedMaterialDigest,
    wrappedMaterialBytes: value.wrappedMaterialBytes,
    createdAtMs: value.createdAtMs,
    signingKeyDigest: value.signingKeyDigest,
  });
}

function normalizeSignature(value: unknown): string {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    invalid('signature is invalid');
  }
  const bytes = Buffer.from(value, 'base64url');
  try {
    if (bytes.length !== 64 || bytes.toString('base64url') !== value) {
      invalid('signature is invalid');
    }
    return value;
  } finally {
    bytes.fill(0);
  }
}

export function normalizePluginPackagePromptOutputExternalCustodyReceipt(
  value: PluginPackagePromptOutputExternalCustodyReceipt,
): Readonly<PluginPackagePromptOutputExternalCustodyReceipt> {
  const candidate = record(value, 'custody receipt');
  exactKeys(
    candidate,
    [
      'createdAtMs',
      'custodyId',
      'keyId',
      'materialProof',
      'receiptDigest',
      'schema',
      'signature',
      'signingKeyDigest',
      'sourceCatalogDigest',
      'sourceGeneration',
      'wrappedMaterialBytes',
      'wrappedMaterialDigest',
      'wrappingKeyRefDigest',
      'wrappingProvider',
    ],
    'custody receipt',
  );
  if (
    candidate.schema !== PLUGIN_PACKAGE_PROMPT_OUTPUT_CUSTODY_RECEIPT_SCHEMA
  ) {
    invalid('custody receipt schema is invalid');
  }
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_CUSTODY_RECEIPT_SCHEMA,
    custodyId: patterned(candidate.custodyId, ID_PATTERN, 'custody id'),
    keyId: patterned(candidate.keyId, KEY_ID_PATTERN, 'key id'),
    materialProof: digest(candidate.materialProof, 'material proof'),
    sourceGeneration: generation(candidate.sourceGeneration),
    sourceCatalogDigest: digest(
      candidate.sourceCatalogDigest,
      'source catalog digest',
    ),
    wrappingProvider: patterned(
      candidate.wrappingProvider,
      PROVIDER_PATTERN,
      'wrapping provider',
    ),
    wrappingKeyRefDigest: digest(
      candidate.wrappingKeyRefDigest,
      'wrapping key reference digest',
    ),
    wrappedMaterialDigest: digest(
      candidate.wrappedMaterialDigest,
      'wrapped material digest',
    ),
    wrappedMaterialBytes: byteLength(candidate.wrappedMaterialBytes),
    createdAtMs: timestamp(candidate.createdAtMs, 'creation time'),
    signingKeyDigest: digest(candidate.signingKeyDigest, 'signing key digest'),
    receiptDigest: digest(candidate.receiptDigest, 'receipt digest'),
    signature: normalizeSignature(candidate.signature),
  });
  if (
    normalized.receiptDigest !==
    hash(RECEIPT_DIGEST_DOMAIN, receiptUnsigned(normalized))
  ) {
    invalid('receipt digest is invalid');
  }
  return normalized;
}

export function createPluginPackagePromptOutputExternalCustodyReceipt(
  value: Readonly<{
    custodyId: string;
    keyId: string;
    materialProof: string;
    sourceGeneration: number;
    sourceCatalogDigest: string;
    wrappingProvider: string;
    wrappingKeyRefDigest: string;
    wrappedMaterialDigest: string;
    wrappedMaterialBytes: number;
    createdAtMs: number;
  }>,
  signer: Readonly<{
    publicKey: KeyLike | KeyObject;
    sign(digest: Uint8Array): Uint8Array;
  }>,
): Readonly<PluginPackagePromptOutputExternalCustodyReceipt> {
  if (!signer || typeof signer.sign !== 'function') {
    invalid('custody signer is invalid');
  }
  const signingKeyDigest = pluginPackagePromptOutputCustodySigningKeyDigest(
    signer.publicKey,
  );
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_CUSTODY_RECEIPT_SCHEMA,
    custodyId: patterned(value?.custodyId, ID_PATTERN, 'custody id'),
    keyId: patterned(value?.keyId, KEY_ID_PATTERN, 'key id'),
    materialProof: digest(value?.materialProof, 'material proof'),
    sourceGeneration: generation(value?.sourceGeneration),
    sourceCatalogDigest: digest(
      value?.sourceCatalogDigest,
      'source catalog digest',
    ),
    wrappingProvider: patterned(
      value?.wrappingProvider,
      PROVIDER_PATTERN,
      'wrapping provider',
    ),
    wrappingKeyRefDigest: digest(
      value?.wrappingKeyRefDigest,
      'wrapping key reference digest',
    ),
    wrappedMaterialDigest: digest(
      value?.wrappedMaterialDigest,
      'wrapped material digest',
    ),
    wrappedMaterialBytes: byteLength(value?.wrappedMaterialBytes),
    createdAtMs: timestamp(value?.createdAtMs, 'creation time'),
    signingKeyDigest,
  });
  const receiptDigest = hash(RECEIPT_DIGEST_DOMAIN, unsigned);
  const message = Buffer.from(receiptDigest, 'hex');
  let signature: Buffer | undefined;
  try {
    signature = Buffer.from(signer.sign(message));
    const receipt = normalizePluginPackagePromptOutputExternalCustodyReceipt({
      ...unsigned,
      receiptDigest,
      signature: signature.toString('base64url'),
    });
    return verifyPluginPackagePromptOutputExternalCustodyReceipt(
      receipt,
      signer.publicKey,
    );
  } finally {
    message.fill(0);
    signature?.fill(0);
  }
}

export function verifyPluginPackagePromptOutputExternalCustodyReceipt(
  value: PluginPackagePromptOutputExternalCustodyReceipt,
  trustedPublicKey: KeyLike | KeyObject,
): Readonly<PluginPackagePromptOutputExternalCustodyReceipt> {
  const receipt =
    normalizePluginPackagePromptOutputExternalCustodyReceipt(value);
  const key = publicEd25519Key(trustedPublicKey);
  if (
    pluginPackagePromptOutputCustodySigningKeyDigest(key) !==
    receipt.signingKeyDigest
  ) {
    throw new PluginPackagePromptOutputExternalCustodyUntrustedError();
  }
  const message = Buffer.from(receipt.receiptDigest, 'hex');
  const signature = Buffer.from(receipt.signature, 'base64url');
  try {
    if (!verifySignature(null, message, key, signature)) {
      throw new PluginPackagePromptOutputExternalCustodyUntrustedError();
    }
    return receipt;
  } finally {
    message.fill(0);
    signature.fill(0);
  }
}

export function verifyPluginPackagePromptOutputWrappedBackup(
  value: PluginPackagePromptOutputExternalCustodyReceipt,
  trustedPublicKey: KeyLike | KeyObject,
  wrappedMaterial: Uint8Array,
): Readonly<{
  custodyId: string;
  keyId: string;
  receiptDigest: string;
  wrappedMaterialDigest: string;
  wrappedMaterialBytes: number;
}> {
  const receipt = verifyPluginPackagePromptOutputExternalCustodyReceipt(
    value,
    trustedPublicKey,
  );
  if (
    !(wrappedMaterial instanceof Uint8Array) ||
    wrappedMaterial.byteLength !== receipt.wrappedMaterialBytes
  ) {
    throw new PluginPackagePromptOutputExternalCustodyUntrustedError();
  }
  const owned = Buffer.from(wrappedMaterial);
  try {
    if (
      createHash('sha256').update(owned).digest('hex') !==
      receipt.wrappedMaterialDigest
    ) {
      throw new PluginPackagePromptOutputExternalCustodyUntrustedError();
    }
    return Object.freeze({
      custodyId: receipt.custodyId,
      keyId: receipt.keyId,
      receiptDigest: receipt.receiptDigest,
      wrappedMaterialDigest: receipt.wrappedMaterialDigest,
      wrappedMaterialBytes: receipt.wrappedMaterialBytes,
    });
  } finally {
    owned.fill(0);
  }
}

function normalizeDurableKeyFact(
  value: Readonly<PluginPackagePromptOutputDurableKeyFact>,
): Readonly<PluginPackagePromptOutputDurableKeyFact> {
  const candidate = record(value, 'durable key fact');
  exactKeys(
    candidate,
    ['catalogDigest', 'keyId', 'materialProof'],
    'durable key fact',
  );
  return Object.freeze({
    keyId: patterned(candidate.keyId, KEY_ID_PATTERN, 'key id'),
    materialProof: digest(candidate.materialProof, 'material proof'),
    catalogDigest: digest(candidate.catalogDigest, 'catalog digest'),
  });
}

export function verifyPluginPackagePromptOutputRecoveredMaterial(
  value: Readonly<{
    recoveryId: string;
    requestId: string;
    receipt: PluginPackagePromptOutputExternalCustodyReceipt;
    trustedPublicKey: KeyLike | KeyObject;
    durableKeyFact: Readonly<PluginPackagePromptOutputDurableKeyFact>;
    material: Uint8Array;
    artifact: PluginPackagePromptOutputArtifact;
    verifiedAtMs: number;
  }>,
): Readonly<PluginPackagePromptOutputExternalRecoveryProof> {
  const recoveryId = patterned(value?.recoveryId, ID_PATTERN, 'recovery id');
  const requestId = patterned(value?.requestId, ID_PATTERN, 'request id');
  const verifiedAtMs = timestamp(value?.verifiedAtMs, 'verification time');
  const receipt = verifyPluginPackagePromptOutputExternalCustodyReceipt(
    value?.receipt,
    value?.trustedPublicKey,
  );
  const durableKeyFact = normalizeDurableKeyFact(value?.durableKeyFact);
  const artifact = normalizePluginPackagePromptOutputArtifact(value?.artifact);
  if (
    receipt.keyId !== durableKeyFact.keyId ||
    receipt.materialProof !== durableKeyFact.materialProof ||
    receipt.sourceCatalogDigest !== durableKeyFact.catalogDigest ||
    artifact.keyId !== receipt.keyId ||
    !(value?.material instanceof Uint8Array) ||
    value.material.byteLength !== 32
  ) {
    throw new PluginPackagePromptOutputExternalCustodyUntrustedError();
  }
  const material = Buffer.from(value.material);
  try {
    if (
      pluginPackagePromptOutputKeyRotationMaterialProof(
        receipt.keyId,
        material,
      ) !== receipt.materialProof
    ) {
      throw new PluginPackagePromptOutputExternalCustodyUntrustedError();
    }
    try {
      openPluginPackagePromptOutputArtifact(artifact, material);
    } catch (cause) {
      throw new PluginPackagePromptOutputExternalRecoveryUnavailableError({
        cause,
      });
    }
    const unsigned = Object.freeze({
      schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PROOF_SCHEMA,
      recoveryId,
      requestId,
      custodyId: receipt.custodyId,
      custodyReceiptDigest: receipt.receiptDigest,
      keyId: receipt.keyId,
      materialProof: receipt.materialProof,
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
      contentDigest: artifact.contentDigest,
      outputBytes: artifact.outputBytes,
      verifiedAtMs,
    });
    return Object.freeze({
      ...unsigned,
      proofDigest: hash(RECOVERY_PROOF_DIGEST_DOMAIN, unsigned),
    });
  } finally {
    material.fill(0);
  }
}

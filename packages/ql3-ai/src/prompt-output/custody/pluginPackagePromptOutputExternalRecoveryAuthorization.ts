import { Buffer } from 'node:buffer';
import {
  createHash,
  createPublicKey,
  KeyObject,
  verify as verifySignature,
  type KeyLike,
} from 'node:crypto';

import type { PluginPackagePromptOutputArtifact } from '../pluginPackagePromptOutputArtifact';
import {
  verifyPluginPackagePromptOutputRecoveredMaterial,
  verifyPluginPackagePromptOutputWrappedBackup,
  type PluginPackagePromptOutputDurableKeyFact,
  type PluginPackagePromptOutputExternalCustodyReceipt,
} from './pluginPackagePromptOutputExternalCustody';

export const PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHORIZATION_SCHEMA =
  'qinglong/plugin-package-prompt-output-external-recovery-authorization@v1' as const;
export const PLUGIN_PACKAGE_PROMPT_OUTPUT_AUTHORIZED_RECOVERY_PROOF_SCHEMA =
  'qinglong/plugin-package-prompt-output-authorized-external-recovery-proof@v1' as const;
export const PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PERMISSION =
  'artifact.read' as const;
export const PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PURPOSE =
  'lost-key-recovery-verification' as const;
export const MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHORIZATION_LIFETIME_MS =
  15 * 60 * 1000;
export const MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHENTICATION_AGE_MS =
  5 * 60 * 1000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNING_KEY_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-recovery-approval-signing-key-digest@v1\0',
  'utf8',
);
const AUTHORIZATION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-external-recovery-authorization-digest@v1\0',
  'utf8',
);
const AUTHORIZED_PROOF_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-authorized-external-recovery-proof-digest@v1\0',
  'utf8',
);

export interface PluginPackagePromptOutputRecoveryIdentity {
  readonly userId: string;
  readonly authenticationId: string;
  readonly authenticatedAtMs: number;
}

export interface PluginPackagePromptOutputRecoveryApproval
  extends PluginPackagePromptOutputRecoveryIdentity {
  readonly approvedAtMs: number;
  readonly signingKeyDigest: string;
  readonly signature: string;
}

export interface PluginPackagePromptOutputExternalRecoveryAuthorization {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHORIZATION_SCHEMA;
  readonly recoveryId: string;
  readonly requestId: string;
  readonly custodyId: string;
  readonly custodyReceiptDigest: string;
  readonly keyId: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly permission: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PERMISSION;
  readonly purpose: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PURPOSE;
  readonly policyDigest: string;
  readonly requestedBy: Readonly<PluginPackagePromptOutputRecoveryIdentity>;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  readonly approvals: readonly [
    Readonly<PluginPackagePromptOutputRecoveryApproval>,
    Readonly<PluginPackagePromptOutputRecoveryApproval>,
  ];
  readonly authorizationDigest: string;
}

export interface PluginPackagePromptOutputAuthorizedExternalRecoveryProof {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_AUTHORIZED_RECOVERY_PROOF_SCHEMA;
  readonly recoveryId: string;
  readonly requestId: string;
  readonly authorizationDigest: string;
  readonly custodyId: string;
  readonly custodyReceiptDigest: string;
  readonly wrappedMaterialDigest: string;
  readonly keyId: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly recoveryProofDigest: string;
  readonly verifiedAtMs: number;
  readonly proofDigest: string;
}

export class InvalidPluginPackagePromptOutputRecoveryAuthorizationError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHORIZATION_INVALID';

  constructor(message: string) {
    super(`Prompt output recovery authorization is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePromptOutputRecoveryAuthorizationError';
  }
}

export class PluginPackagePromptOutputRecoveryAuthorizationUntrustedError extends Error {
  readonly code =
    'PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHORIZATION_UNTRUSTED';

  constructor() {
    super('Prompt output recovery authorization is untrusted');
    this.name = 'PluginPackagePromptOutputRecoveryAuthorizationUntrustedError';
  }
}

function invalid(message: string): never {
  throw new InvalidPluginPackagePromptOutputRecoveryAuthorizationError(message);
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

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${label} is invalid`);
  }
  return value as number;
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
    if (
      cause instanceof
      InvalidPluginPackagePromptOutputRecoveryAuthorizationError
    ) {
      throw cause;
    }
    return invalid('signing key is invalid');
  }
}

export function pluginPackagePromptOutputRecoveryApprovalSigningKeyDigest(
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

function hash(domain: Buffer, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function normalizeIdentity(
  value: PluginPackagePromptOutputRecoveryIdentity,
  label: string,
): Readonly<PluginPackagePromptOutputRecoveryIdentity> {
  const candidate = record(value, label);
  exactKeys(
    candidate,
    ['authenticatedAtMs', 'authenticationId', 'userId'],
    label,
  );
  return Object.freeze({
    userId: id(candidate.userId, `${label} user id`),
    authenticationId: id(
      candidate.authenticationId,
      `${label} authentication id`,
    ),
    authenticatedAtMs: timestamp(
      candidate.authenticatedAtMs,
      `${label} authentication time`,
    ),
  });
}

function normalizeSignature(value: unknown): string {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    invalid('approval signature is invalid');
  }
  const bytes = Buffer.from(value, 'base64url');
  try {
    if (bytes.byteLength !== 64 || bytes.toString('base64url') !== value) {
      invalid('approval signature is invalid');
    }
    return value;
  } finally {
    bytes.fill(0);
  }
}

function normalizeApproval(
  value: PluginPackagePromptOutputRecoveryApproval,
): Readonly<PluginPackagePromptOutputRecoveryApproval> {
  const candidate = record(value, 'recovery approval');
  exactKeys(
    candidate,
    [
      'approvedAtMs',
      'authenticatedAtMs',
      'authenticationId',
      'signature',
      'signingKeyDigest',
      'userId',
    ],
    'recovery approval',
  );
  const identity = normalizeIdentity(
    {
      userId: candidate.userId as string,
      authenticationId: candidate.authenticationId as string,
      authenticatedAtMs: candidate.authenticatedAtMs as number,
    },
    'recovery approver',
  );
  return Object.freeze({
    ...identity,
    approvedAtMs: timestamp(candidate.approvedAtMs, 'approval time'),
    signingKeyDigest: digest(
      candidate.signingKeyDigest,
      'approval signing key digest',
    ),
    signature: normalizeSignature(candidate.signature),
  });
}

function approvalBinding(
  value: Readonly<PluginPackagePromptOutputRecoveryApproval>,
) {
  return Object.freeze({
    userId: value.userId,
    authenticationId: value.authenticationId,
    authenticatedAtMs: value.authenticatedAtMs,
    approvedAtMs: value.approvedAtMs,
    signingKeyDigest: value.signingKeyDigest,
  });
}

function authorizationUnsigned(
  value: Readonly<PluginPackagePromptOutputExternalRecoveryAuthorization>,
) {
  return Object.freeze({
    schema: value.schema,
    recoveryId: value.recoveryId,
    requestId: value.requestId,
    custodyId: value.custodyId,
    custodyReceiptDigest: value.custodyReceiptDigest,
    keyId: value.keyId,
    artifactId: value.artifactId,
    artifactDigest: value.artifactDigest,
    permission: value.permission,
    purpose: value.purpose,
    policyDigest: value.policyDigest,
    requestedBy: value.requestedBy,
    requestedAtMs: value.requestedAtMs,
    expiresAtMs: value.expiresAtMs,
    approvals: value.approvals.map(approvalBinding),
  });
}

function assertAuthorizationTimeline(
  value: Readonly<PluginPackagePromptOutputExternalRecoveryAuthorization>,
): void {
  if (
    value.requestedBy.authenticatedAtMs > value.requestedAtMs ||
    value.requestedAtMs - value.requestedBy.authenticatedAtMs >
      MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHENTICATION_AGE_MS ||
    value.expiresAtMs <= value.requestedAtMs ||
    value.expiresAtMs - value.requestedAtMs >
      MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHORIZATION_LIFETIME_MS
  ) {
    invalid('authorization timeline is invalid');
  }
  for (const approval of value.approvals) {
    if (
      approval.authenticatedAtMs > approval.approvedAtMs ||
      approval.approvedAtMs - approval.authenticatedAtMs >
        MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHENTICATION_AGE_MS ||
      approval.approvedAtMs < value.requestedAtMs ||
      approval.approvedAtMs > value.expiresAtMs
    ) {
      invalid('approval timeline is invalid');
    }
  }
}

export function normalizePluginPackagePromptOutputExternalRecoveryAuthorization(
  value: PluginPackagePromptOutputExternalRecoveryAuthorization,
): Readonly<PluginPackagePromptOutputExternalRecoveryAuthorization> {
  const candidate = record(value, 'recovery authorization');
  exactKeys(
    candidate,
    [
      'approvals',
      'artifactDigest',
      'artifactId',
      'authorizationDigest',
      'custodyId',
      'custodyReceiptDigest',
      'expiresAtMs',
      'keyId',
      'permission',
      'policyDigest',
      'purpose',
      'recoveryId',
      'requestId',
      'requestedAtMs',
      'requestedBy',
      'schema',
    ],
    'recovery authorization',
  );
  if (
    candidate.schema !==
      PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHORIZATION_SCHEMA ||
    candidate.permission !== PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PERMISSION ||
    candidate.purpose !== PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PURPOSE ||
    !Array.isArray(candidate.approvals) ||
    candidate.approvals.length !== 2
  ) {
    invalid('recovery authorization value is invalid');
  }
  const approvals = candidate.approvals.map((approval) =>
    normalizeApproval(approval as PluginPackagePromptOutputRecoveryApproval),
  ) as unknown as readonly [
    Readonly<PluginPackagePromptOutputRecoveryApproval>,
    Readonly<PluginPackagePromptOutputRecoveryApproval>,
  ];
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHORIZATION_SCHEMA,
    recoveryId: id(candidate.recoveryId, 'recovery id'),
    requestId: id(candidate.requestId, 'request id'),
    custodyId: id(candidate.custodyId, 'custody id'),
    custodyReceiptDigest: digest(
      candidate.custodyReceiptDigest,
      'custody receipt digest',
    ),
    keyId: id(candidate.keyId, 'key id'),
    artifactId: id(candidate.artifactId, 'artifact id'),
    artifactDigest: digest(candidate.artifactDigest, 'artifact digest'),
    permission: PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PERMISSION,
    purpose: PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PURPOSE,
    policyDigest: digest(candidate.policyDigest, 'policy digest'),
    requestedBy: normalizeIdentity(
      candidate.requestedBy as PluginPackagePromptOutputRecoveryIdentity,
      'recovery requester',
    ),
    requestedAtMs: timestamp(candidate.requestedAtMs, 'request time'),
    expiresAtMs: timestamp(candidate.expiresAtMs, 'expiry time'),
    approvals,
    authorizationDigest: digest(
      candidate.authorizationDigest,
      'authorization digest',
    ),
  });
  const [left, right] = normalized.approvals;
  if (
    left.userId >= right.userId ||
    left.userId === normalized.requestedBy.userId ||
    right.userId === normalized.requestedBy.userId ||
    left.authenticationId === right.authenticationId ||
    left.authenticationId === normalized.requestedBy.authenticationId ||
    right.authenticationId === normalized.requestedBy.authenticationId ||
    left.signingKeyDigest === right.signingKeyDigest
  ) {
    invalid('approval separation of duty is invalid');
  }
  assertAuthorizationTimeline(normalized);
  if (
    normalized.authorizationDigest !==
    hash(AUTHORIZATION_DIGEST_DOMAIN, authorizationUnsigned(normalized))
  ) {
    invalid('authorization digest is invalid');
  }
  return normalized;
}

export interface PluginPackagePromptOutputRecoveryApprovalSigner
  extends PluginPackagePromptOutputRecoveryIdentity {
  readonly approvedAtMs: number;
  readonly publicKey: KeyLike | KeyObject;
  sign(digest: Uint8Array): Uint8Array;
}

export function createPluginPackagePromptOutputExternalRecoveryAuthorization(
  value: Readonly<{
    recoveryId: string;
    requestId: string;
    custodyId: string;
    custodyReceiptDigest: string;
    keyId: string;
    artifactId: string;
    artifactDigest: string;
    policyDigest: string;
    requestedBy: PluginPackagePromptOutputRecoveryIdentity;
    requestedAtMs: number;
    expiresAtMs: number;
  }>,
  signerValues: readonly PluginPackagePromptOutputRecoveryApprovalSigner[],
): Readonly<PluginPackagePromptOutputExternalRecoveryAuthorization> {
  if (!Array.isArray(signerValues) || signerValues.length !== 2) {
    invalid('exactly two approval signers are required');
  }
  const signers = signerValues
    .map((signer) => {
      if (!signer || typeof signer.sign !== 'function') {
        return invalid('approval signer is invalid');
      }
      const identity = normalizeIdentity(
        {
          userId: signer.userId,
          authenticationId: signer.authenticationId,
          authenticatedAtMs: signer.authenticatedAtMs,
        },
        'recovery approver',
      );
      return Object.freeze({
        ...identity,
        approvedAtMs: timestamp(signer.approvedAtMs, 'approval time'),
        signingKeyDigest:
          pluginPackagePromptOutputRecoveryApprovalSigningKeyDigest(
            signer.publicKey,
          ),
        publicKey: signer.publicKey,
        sign: signer.sign,
      });
    })
    .sort((left, right) => left.userId.localeCompare(right.userId));
  const unsignedApprovals = signers.map((signer) =>
    Object.freeze({
      userId: signer.userId,
      authenticationId: signer.authenticationId,
      authenticatedAtMs: signer.authenticatedAtMs,
      approvedAtMs: signer.approvedAtMs,
      signingKeyDigest: signer.signingKeyDigest,
      signature: Buffer.alloc(64).toString('base64url'),
    }),
  ) as unknown as readonly [
    PluginPackagePromptOutputRecoveryApproval,
    PluginPackagePromptOutputRecoveryApproval,
  ];
  const skeleton = {
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_AUTHORIZATION_SCHEMA,
    recoveryId: id(value?.recoveryId, 'recovery id'),
    requestId: id(value?.requestId, 'request id'),
    custodyId: id(value?.custodyId, 'custody id'),
    custodyReceiptDigest: digest(
      value?.custodyReceiptDigest,
      'custody receipt digest',
    ),
    keyId: id(value?.keyId, 'key id'),
    artifactId: id(value?.artifactId, 'artifact id'),
    artifactDigest: digest(value?.artifactDigest, 'artifact digest'),
    permission: PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PERMISSION,
    purpose: PLUGIN_PACKAGE_PROMPT_OUTPUT_RECOVERY_PURPOSE,
    policyDigest: digest(value?.policyDigest, 'policy digest'),
    requestedBy: normalizeIdentity(value?.requestedBy, 'recovery requester'),
    requestedAtMs: timestamp(value?.requestedAtMs, 'request time'),
    expiresAtMs: timestamp(value?.expiresAtMs, 'expiry time'),
    approvals: unsignedApprovals,
  };
  const authorizationDigest = hash(
    AUTHORIZATION_DIGEST_DOMAIN,
    authorizationUnsigned({
      ...skeleton,
      authorizationDigest: '0'.repeat(64),
    }),
  );
  const message = Buffer.from(authorizationDigest, 'hex');
  const signatures: Buffer[] = [];
  try {
    const approvals = signers.map((signer, index) => {
      const signature = Buffer.from(signer.sign(message));
      signatures.push(signature);
      return Object.freeze({
        ...unsignedApprovals[index]!,
        signature: signature.toString('base64url'),
      });
    }) as unknown as readonly [
      PluginPackagePromptOutputRecoveryApproval,
      PluginPackagePromptOutputRecoveryApproval,
    ];
    return normalizePluginPackagePromptOutputExternalRecoveryAuthorization({
      ...skeleton,
      approvals,
      authorizationDigest,
    });
  } finally {
    message.fill(0);
    signatures.forEach((signature) => signature.fill(0));
  }
}

export function verifyPluginPackagePromptOutputExternalRecoveryAuthorization(
  value: PluginPackagePromptOutputExternalRecoveryAuthorization,
  trustedApprovers: readonly Readonly<{
    userId: string;
    publicKey: KeyLike | KeyObject;
  }>[],
  verifiedAtMsValue: number,
): Readonly<PluginPackagePromptOutputExternalRecoveryAuthorization> {
  const authorization =
    normalizePluginPackagePromptOutputExternalRecoveryAuthorization(value);
  const verifiedAtMs = timestamp(verifiedAtMsValue, 'verification time');
  if (
    !Array.isArray(trustedApprovers) ||
    trustedApprovers.length !== 2 ||
    verifiedAtMs <
      Math.max(...authorization.approvals.map((v) => v.approvedAtMs)) ||
    verifiedAtMs > authorization.expiresAtMs
  ) {
    throw new PluginPackagePromptOutputRecoveryAuthorizationUntrustedError();
  }
  const trusted = new Map<string, KeyObject>();
  for (const candidate of trustedApprovers) {
    const userId = id(candidate?.userId, 'trusted approver user id');
    if (trusted.has(userId)) {
      throw new PluginPackagePromptOutputRecoveryAuthorizationUntrustedError();
    }
    trusted.set(userId, publicEd25519Key(candidate?.publicKey));
  }
  const message = Buffer.from(authorization.authorizationDigest, 'hex');
  try {
    for (const approval of authorization.approvals) {
      const key = trusted.get(approval.userId);
      const signature = Buffer.from(approval.signature, 'base64url');
      try {
        if (
          !key ||
          pluginPackagePromptOutputRecoveryApprovalSigningKeyDigest(key) !==
            approval.signingKeyDigest ||
          !verifySignature(null, message, key, signature)
        ) {
          throw new PluginPackagePromptOutputRecoveryAuthorizationUntrustedError();
        }
      } finally {
        signature.fill(0);
      }
    }
    return authorization;
  } finally {
    message.fill(0);
  }
}

export function verifyAuthorizedPluginPackagePromptOutputRecoveredMaterial(
  value: Readonly<{
    authorization: PluginPackagePromptOutputExternalRecoveryAuthorization;
    trustedApprovers: readonly Readonly<{
      userId: string;
      publicKey: KeyLike | KeyObject;
    }>[];
    receipt: PluginPackagePromptOutputExternalCustodyReceipt;
    trustedCustodyPublicKey: KeyLike | KeyObject;
    wrappedMaterial: Uint8Array;
    durableKeyFact: Readonly<PluginPackagePromptOutputDurableKeyFact>;
    material: Uint8Array;
    artifact: PluginPackagePromptOutputArtifact;
    verifiedAtMs: number;
  }>,
): Readonly<PluginPackagePromptOutputAuthorizedExternalRecoveryProof> {
  const authorization =
    verifyPluginPackagePromptOutputExternalRecoveryAuthorization(
      value?.authorization,
      value?.trustedApprovers,
      value?.verifiedAtMs,
    );
  const backup = verifyPluginPackagePromptOutputWrappedBackup(
    value?.receipt,
    value?.trustedCustodyPublicKey,
    value?.wrappedMaterial,
  );
  if (
    authorization.custodyId !== backup.custodyId ||
    authorization.custodyReceiptDigest !== backup.receiptDigest ||
    authorization.keyId !== backup.keyId ||
    authorization.artifactId !== value?.artifact?.artifactId ||
    authorization.artifactDigest !== value?.artifact?.artifactDigest
  ) {
    throw new PluginPackagePromptOutputRecoveryAuthorizationUntrustedError();
  }
  const recovery = verifyPluginPackagePromptOutputRecoveredMaterial({
    recoveryId: authorization.recoveryId,
    requestId: authorization.requestId,
    receipt: value.receipt,
    trustedPublicKey: value.trustedCustodyPublicKey,
    durableKeyFact: value.durableKeyFact,
    material: value.material,
    artifact: value.artifact,
    verifiedAtMs: value.verifiedAtMs,
  });
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_AUTHORIZED_RECOVERY_PROOF_SCHEMA,
    recoveryId: recovery.recoveryId,
    requestId: recovery.requestId,
    authorizationDigest: authorization.authorizationDigest,
    custodyId: recovery.custodyId,
    custodyReceiptDigest: recovery.custodyReceiptDigest,
    wrappedMaterialDigest: backup.wrappedMaterialDigest,
    keyId: recovery.keyId,
    artifactId: recovery.artifactId,
    artifactDigest: recovery.artifactDigest,
    recoveryProofDigest: recovery.proofDigest,
    verifiedAtMs: recovery.verifiedAtMs,
  });
  return Object.freeze({
    ...unsigned,
    proofDigest: hash(AUTHORIZED_PROOF_DIGEST_DOMAIN, unsigned),
  });
}

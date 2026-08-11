import { Buffer } from 'node:buffer';
// Custody bundles are transport evidence, separate from encryption and storage.
import { createHash, type KeyLike, type KeyObject } from 'node:crypto';

import {
  InvalidPluginPackagePromptOutputExternalCustodyError,
  PluginPackagePromptOutputExternalCustodyUntrustedError,
  verifyPluginPackagePromptOutputExternalCustodyReceipt,
  verifyPluginPackagePromptOutputWrappedBackup,
  type PluginPackagePromptOutputExternalCustodyReceipt,
} from './pluginPackagePromptOutputExternalCustody';

export const PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_BUNDLE_SCHEMA =
  'qinglong/plugin-package-prompt-output-external-custody-bundle@v1' as const;

const BUNDLE_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-external-custody-bundle-digest@v1\0',
  'utf8',
);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface PluginPackagePromptOutputExternalCustodyBundle {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_BUNDLE_SCHEMA;
  readonly receipt: PluginPackagePromptOutputExternalCustodyReceipt;
  readonly wrappedMaterial: string;
  readonly bundleDigest: string;
}

export interface OpenPluginPackagePromptOutputExternalCustodyBundle {
  readonly receipt: Readonly<PluginPackagePromptOutputExternalCustodyReceipt>;
  readonly wrappedMaterial: Buffer;
  readonly bundleDigest: string;
}

function invalid(message: string): never {
  throw new InvalidPluginPackagePromptOutputExternalCustodyError(message);
}

function exactBundle(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalid('custody bundle must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expected = [
    'bundleDigest',
    'receipt',
    'schema',
    'wrappedMaterial',
  ].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    invalid('custody bundle shape is invalid');
  }
  return candidate;
}

function unsignedBundle(
  receipt: Readonly<PluginPackagePromptOutputExternalCustodyReceipt>,
): Readonly<{
  schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_BUNDLE_SCHEMA;
  custodyId: string;
  receiptDigest: string;
  wrappedMaterialDigest: string;
  wrappedMaterialBytes: number;
}> {
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_BUNDLE_SCHEMA,
    custodyId: receipt.custodyId,
    receiptDigest: receipt.receiptDigest,
    wrappedMaterialDigest: receipt.wrappedMaterialDigest,
    wrappedMaterialBytes: receipt.wrappedMaterialBytes,
  });
}

function bundleDigest(
  receipt: Readonly<PluginPackagePromptOutputExternalCustodyReceipt>,
): string {
  return createHash('sha256')
    .update(BUNDLE_DIGEST_DOMAIN)
    .update(JSON.stringify(unsignedBundle(receipt)))
    .digest('hex');
}

export function createPluginPackagePromptOutputExternalCustodyBundle(
  receiptValue: PluginPackagePromptOutputExternalCustodyReceipt,
  trustedPublicKey: KeyLike | KeyObject,
  wrappedMaterialValue: Uint8Array,
): Readonly<PluginPackagePromptOutputExternalCustodyBundle> {
  const receipt = verifyPluginPackagePromptOutputExternalCustodyReceipt(
    receiptValue,
    trustedPublicKey,
  );
  verifyPluginPackagePromptOutputWrappedBackup(
    receipt,
    trustedPublicKey,
    wrappedMaterialValue,
  );
  const wrappedMaterial = Buffer.from(wrappedMaterialValue);
  try {
    return Object.freeze({
      schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_BUNDLE_SCHEMA,
      receipt,
      wrappedMaterial: wrappedMaterial.toString('base64url'),
      bundleDigest: bundleDigest(receipt),
    });
  } finally {
    wrappedMaterial.fill(0);
  }
}

export function openPluginPackagePromptOutputExternalCustodyBundle(
  value: PluginPackagePromptOutputExternalCustodyBundle,
  trustedPublicKey: KeyLike | KeyObject,
): Readonly<OpenPluginPackagePromptOutputExternalCustodyBundle> {
  const candidate = exactBundle(value);
  if (
    candidate.schema !==
      PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_BUNDLE_SCHEMA ||
    typeof candidate.wrappedMaterial !== 'string' ||
    !BASE64URL_PATTERN.test(candidate.wrappedMaterial) ||
    typeof candidate.bundleDigest !== 'string' ||
    !DIGEST_PATTERN.test(candidate.bundleDigest)
  ) {
    invalid('custody bundle value is invalid');
  }
  const receipt = verifyPluginPackagePromptOutputExternalCustodyReceipt(
    candidate.receipt as PluginPackagePromptOutputExternalCustodyReceipt,
    trustedPublicKey,
  );
  const wrappedMaterial = Buffer.from(candidate.wrappedMaterial, 'base64url');
  try {
    if (
      wrappedMaterial.toString('base64url') !== candidate.wrappedMaterial ||
      candidate.bundleDigest !== bundleDigest(receipt)
    ) {
      throw new PluginPackagePromptOutputExternalCustodyUntrustedError();
    }
    verifyPluginPackagePromptOutputWrappedBackup(
      receipt,
      trustedPublicKey,
      wrappedMaterial,
    );
    return Object.freeze({
      receipt,
      wrappedMaterial,
      bundleDigest: candidate.bundleDigest,
    });
  } catch (cause) {
    wrappedMaterial.fill(0);
    throw cause;
  }
}

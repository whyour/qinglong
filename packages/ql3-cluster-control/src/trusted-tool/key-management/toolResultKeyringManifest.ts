import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { toolResultKeyMaterialProof } from '@qinglong/runtime-core/tool-result-key-catalog';

export const CLUSTER_TOOL_RESULT_KEYRING_MANIFEST_SCHEMA =
  'qinglong/cluster-tool-result-projected-keyring@v1' as const;
export const MAX_CLUSTER_TOOL_RESULT_KEYRING_BYTES = 64 * 1024;
export const MAX_CLUSTER_TOOL_RESULT_PROJECTED_KEYS = 16;

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROJECTION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/cluster-tool-result-projected-keyring-digest@v1\0',
  'utf8',
);

export interface ClusterToolResultKeyringManifest {
  readonly schema: typeof CLUSTER_TOOL_RESULT_KEYRING_MANIFEST_SCHEMA;
  readonly keys: Readonly<Record<string, string>>;
}

export interface ClusterToolResultKeyringSummary {
  readonly schemaVersion: 1;
  readonly keyIds: readonly string[];
  readonly materialProofs: Readonly<Record<string, string>>;
  readonly projectionDigest: string;
}

export class InvalidClusterToolResultKeyringManifestError extends TypeError {
  readonly code = 'QL3_CLUSTER_TOOL_RESULT_KEYRING_MANIFEST_INVALID';

  constructor() {
    super('Cluster Tool result keyring manifest is invalid');
    this.name = 'InvalidClusterToolResultKeyringManifestError';
  }
}

function invalid(): never {
  throw new InvalidClusterToolResultKeyringManifestError();
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function normalizedEntries(
  value: unknown,
): readonly (readonly [string, string])[] {
  const keys = dataRecord(value);
  const entries = Object.entries(keys).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    entries.length < 1 ||
    entries.length > MAX_CLUSTER_TOOL_RESULT_PROJECTED_KEYS
  ) {
    return invalid();
  }
  const normalized: (readonly [string, string])[] = [];
  for (const [keyId, encoded] of entries) {
    let material: Buffer | undefined;
    try {
      if (
        !KEY_ID_PATTERN.test(keyId) ||
        typeof encoded !== 'string' ||
        !BASE64URL_PATTERN.test(encoded)
      ) {
        return invalid();
      }
      material = Buffer.from(encoded, 'base64url');
      if (
        material.byteLength !== 32 ||
        material.toString('base64url') !== encoded
      ) {
        return invalid();
      }
      normalized.push(Object.freeze([keyId, encoded] as const));
    } finally {
      material?.fill(0);
    }
  }
  return Object.freeze(normalized);
}

export function normalizeClusterToolResultKeyringManifest(
  value: unknown,
): Readonly<ClusterToolResultKeyringManifest> {
  const manifest = dataRecord(value);
  if (
    !exactKeys(manifest, ['keys', 'schema']) ||
    manifest.schema !== CLUSTER_TOOL_RESULT_KEYRING_MANIFEST_SCHEMA
  ) {
    return invalid();
  }
  return Object.freeze({
    schema: CLUSTER_TOOL_RESULT_KEYRING_MANIFEST_SCHEMA,
    keys: Object.freeze(Object.fromEntries(normalizedEntries(manifest.keys))),
  });
}

export function parseClusterToolResultKeyringManifest(
  bytes: Buffer,
): Readonly<ClusterToolResultKeyringManifest> {
  try {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > MAX_CLUSTER_TOOL_RESULT_KEYRING_BYTES
    ) {
      return invalid();
    }
    return normalizeClusterToolResultKeyringManifest(
      JSON.parse(bytes.toString('utf8')),
    );
  } catch (error) {
    if (error instanceof InvalidClusterToolResultKeyringManifestError) {
      throw error;
    }
    return invalid();
  }
}

export function canonicalClusterToolResultKeyringManifest(
  value: ClusterToolResultKeyringManifest,
): Buffer {
  const manifest = normalizeClusterToolResultKeyringManifest(value);
  return Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
}

export function resolveClusterToolResultKeyringMaterial(
  value: ClusterToolResultKeyringManifest,
  keyId: string,
): Readonly<{ keyId: string; key: Uint8Array }> | null {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId))
    return invalid();
  const manifest = normalizeClusterToolResultKeyringManifest(value);
  const encoded = manifest.keys[keyId];
  if (encoded === undefined) return null;
  const key = Buffer.from(encoded, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== encoded) {
    key.fill(0);
    return invalid();
  }
  return Object.freeze({ keyId, key });
}

export function summarizeClusterToolResultKeyringManifest(
  value: ClusterToolResultKeyringManifest,
): Readonly<ClusterToolResultKeyringSummary> {
  const manifest = normalizeClusterToolResultKeyringManifest(value);
  const keyIds = Object.keys(manifest.keys).sort();
  const materialProofs: Record<string, string> = Object.create(null);
  for (const keyId of keyIds) {
    const material = resolveClusterToolResultKeyringMaterial(manifest, keyId)!;
    try {
      materialProofs[keyId] = toolResultKeyMaterialProof(keyId, material.key);
    } finally {
      material.key.fill(0);
    }
  }
  const canonicalProofs = Object.freeze({ ...materialProofs });
  return Object.freeze({
    schemaVersion: 1 as const,
    keyIds: Object.freeze(keyIds),
    materialProofs: canonicalProofs,
    projectionDigest: createHash('sha256')
      .update(PROJECTION_DIGEST_DOMAIN)
      .update(
        JSON.stringify({
          schema: manifest.schema,
          materialProofs: canonicalProofs,
        }),
      )
      .digest('hex'),
  });
}

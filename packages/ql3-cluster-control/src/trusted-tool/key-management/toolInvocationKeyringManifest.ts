import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const CLUSTER_TOOL_INVOCATION_KEYRING_MANIFEST_SCHEMA =
  'qinglong/cluster-tool-invocation-projected-keyring@v1' as const;
export const MAX_CLUSTER_TOOL_INVOCATION_KEYRING_BYTES = 64 * 1024;
export const MAX_CLUSTER_TOOL_INVOCATION_PROJECTED_KEYS = 16;

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROJECTION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/cluster-tool-invocation-projected-keyring-digest@v1\0',
  'utf8',
);

export interface ClusterToolInvocationKeyringManifest {
  readonly schema: typeof CLUSTER_TOOL_INVOCATION_KEYRING_MANIFEST_SCHEMA;
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
}

export interface ClusterToolInvocationKeyringSummary {
  readonly schemaVersion: 1;
  readonly activeKeyId: string;
  readonly keyIds: readonly string[];
  readonly projectionDigest: string;
}

export class InvalidClusterToolInvocationKeyringManifestError extends TypeError {
  readonly code = 'QL3_CLUSTER_TOOL_INVOCATION_KEYRING_MANIFEST_INVALID';

  constructor() {
    super('Cluster Tool invocation keyring manifest is invalid');
    this.name = 'InvalidClusterToolInvocationKeyringManifestError';
  }
}

function invalid(): never {
  throw new InvalidClusterToolInvocationKeyringManifestError();
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

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

export function normalizeClusterToolInvocationKeyringManifest(
  value: unknown,
): Readonly<ClusterToolInvocationKeyringManifest> {
  const manifest = dataRecord(value);
  if (
    !exactKeys(manifest, ['activeKeyId', 'keys', 'schema']) ||
    manifest.schema !== CLUSTER_TOOL_INVOCATION_KEYRING_MANIFEST_SCHEMA ||
    typeof manifest.activeKeyId !== 'string' ||
    !KEY_ID_PATTERN.test(manifest.activeKeyId)
  ) {
    return invalid();
  }
  const keys = dataRecord(manifest.keys);
  const entries = Object.entries(keys).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    entries.length < 1 ||
    entries.length > MAX_CLUSTER_TOOL_INVOCATION_PROJECTED_KEYS
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
  const normalizedKeys = Object.freeze(Object.fromEntries(normalized));
  if (normalizedKeys[manifest.activeKeyId] === undefined) return invalid();
  return Object.freeze({
    schema: CLUSTER_TOOL_INVOCATION_KEYRING_MANIFEST_SCHEMA,
    activeKeyId: manifest.activeKeyId,
    keys: normalizedKeys,
  });
}

export function parseClusterToolInvocationKeyringManifest(
  bytes: Buffer,
): Readonly<ClusterToolInvocationKeyringManifest> {
  try {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > MAX_CLUSTER_TOOL_INVOCATION_KEYRING_BYTES
    ) {
      return invalid();
    }
    return normalizeClusterToolInvocationKeyringManifest(
      JSON.parse(bytes.toString('utf8')),
    );
  } catch (error) {
    if (error instanceof InvalidClusterToolInvocationKeyringManifestError) {
      throw error;
    }
    return invalid();
  }
}

export function canonicalClusterToolInvocationKeyringManifest(
  value: ClusterToolInvocationKeyringManifest,
): Buffer {
  const manifest = normalizeClusterToolInvocationKeyringManifest(value);
  return Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
}

export function resolveClusterToolInvocationKeyringMaterial(
  value: ClusterToolInvocationKeyringManifest,
  keyId: string,
): Readonly<{ keyId: string; key: Uint8Array }> | null {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    return invalid();
  }
  const manifest = normalizeClusterToolInvocationKeyringManifest(value);
  const encoded = manifest.keys[keyId];
  if (encoded === undefined) return null;
  const key = Buffer.from(encoded, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== encoded) {
    key.fill(0);
    return invalid();
  }
  return Object.freeze({ keyId, key });
}

export function summarizeClusterToolInvocationKeyringManifest(
  value: ClusterToolInvocationKeyringManifest,
): Readonly<ClusterToolInvocationKeyringSummary> {
  const manifest = normalizeClusterToolInvocationKeyringManifest(value);
  const keyIds = Object.freeze(Object.keys(manifest.keys).sort());
  return Object.freeze({
    schemaVersion: 1 as const,
    activeKeyId: manifest.activeKeyId,
    keyIds,
    projectionDigest: createHash('sha256')
      .update(PROJECTION_DIGEST_DOMAIN)
      .update(JSON.stringify(manifest))
      .digest('hex'),
  });
}

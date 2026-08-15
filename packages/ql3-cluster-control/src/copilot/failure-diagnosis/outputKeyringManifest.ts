import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_MANIFEST_SCHEMA =
  'qinglong/copilot-failure-diagnosis-output-projected-keyring@v1' as const;
export const MAX_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_BYTES =
  64 * 1024;
export const MAX_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_PROJECTED_KEYS = 16;

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROJECTION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-output-projected-keyring-digest@v1\0',
  'utf8',
);

export interface ClusterCopilotFailureDiagnosisOutputKeyringManifest {
  readonly schema: typeof CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_MANIFEST_SCHEMA;
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
}

export interface ClusterCopilotFailureDiagnosisOutputKeyringSummary {
  readonly schemaVersion: 1;
  readonly activeKeyId: string;
  readonly keyIds: readonly string[];
  readonly projectionDigest: string;
}

export interface ClusterCopilotFailureDiagnosisOutputKeyMaterial {
  readonly keyId: string;
  readonly key: Uint8Array;
}

export class InvalidClusterCopilotFailureDiagnosisOutputKeyringManifestError extends TypeError {
  readonly code =
    'QL3_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_MANIFEST_INVALID';

  constructor() {
    super('Cluster Copilot failure diagnosis output keyring manifest is invalid');
    this.name =
      'InvalidClusterCopilotFailureDiagnosisOutputKeyringManifestError';
  }
}

function invalid(): never {
  throw new InvalidClusterCopilotFailureDiagnosisOutputKeyringManifestError();
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

export function normalizeClusterCopilotFailureDiagnosisOutputKeyringManifest(
  value: unknown,
): Readonly<ClusterCopilotFailureDiagnosisOutputKeyringManifest> {
  const manifest = dataRecord(value);
  if (
    !exactKeys(manifest, ['activeKeyId', 'keys', 'schema']) ||
    manifest.schema !==
      CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_MANIFEST_SCHEMA ||
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
    entries.length >
      MAX_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_PROJECTED_KEYS
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
    schema:
      CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_MANIFEST_SCHEMA,
    activeKeyId: manifest.activeKeyId,
    keys: normalizedKeys,
  });
}

export function parseClusterCopilotFailureDiagnosisOutputKeyringManifest(
  bytes: Buffer,
): Readonly<ClusterCopilotFailureDiagnosisOutputKeyringManifest> {
  try {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.byteLength < 1 ||
      bytes.byteLength >
        MAX_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_BYTES
    ) {
      return invalid();
    }
    return normalizeClusterCopilotFailureDiagnosisOutputKeyringManifest(
      JSON.parse(bytes.toString('utf8')),
    );
  } catch (error) {
    if (
      error instanceof
      InvalidClusterCopilotFailureDiagnosisOutputKeyringManifestError
    ) {
      throw error;
    }
    return invalid();
  }
}

export function canonicalClusterCopilotFailureDiagnosisOutputKeyringManifest(
  value: ClusterCopilotFailureDiagnosisOutputKeyringManifest,
): Buffer {
  const manifest =
    normalizeClusterCopilotFailureDiagnosisOutputKeyringManifest(value);
  return Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
}

export function resolveClusterCopilotFailureDiagnosisOutputKeyringMaterial(
  value: ClusterCopilotFailureDiagnosisOutputKeyringManifest,
  keyId: string,
): Readonly<ClusterCopilotFailureDiagnosisOutputKeyMaterial> | null {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    return invalid();
  }
  const manifest =
    normalizeClusterCopilotFailureDiagnosisOutputKeyringManifest(value);
  const encoded = manifest.keys[keyId];
  if (encoded === undefined) return null;
  const key = Buffer.from(encoded, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== encoded) {
    key.fill(0);
    return invalid();
  }
  return Object.freeze({ keyId, key });
}

export function summarizeClusterCopilotFailureDiagnosisOutputKeyringManifest(
  value: ClusterCopilotFailureDiagnosisOutputKeyringManifest,
): Readonly<ClusterCopilotFailureDiagnosisOutputKeyringSummary> {
  const manifest =
    normalizeClusterCopilotFailureDiagnosisOutputKeyringManifest(value);
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

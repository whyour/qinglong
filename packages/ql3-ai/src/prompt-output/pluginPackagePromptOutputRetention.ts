import { createHash } from 'node:crypto';

// Retention remains a core lifecycle contract shared by local and cluster storage.

import {
  normalizePluginPackagePromptOutputArtifactReference,
  normalizePluginPackagePromptOutputArtifactRetentionPolicy,
  pluginPackagePromptOutputArtifactRetentionPolicyDigest,
  type PluginPackagePromptOutputArtifactReference,
  type PluginPackagePromptOutputArtifactRetentionPolicy,
} from './pluginPackagePromptOutputArtifact';

export const PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_SCHEMA =
  'qinglong/plugin-package-prompt-output-artifact-tombstone@v1' as const;
export const MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_GC_CANDIDATES = 128;
export const MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_RETENTION_POLICIES = 128;

export interface PluginPackagePromptOutputArtifactTombstone {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_SCHEMA;
  readonly reference: Readonly<PluginPackagePromptOutputArtifactReference>;
  readonly tombstonedAtMs: number;
  readonly tombstoneDigest: string;
}

export interface PluginPackagePromptOutputRetentionPolicyResolver {
  resolve(
    request: Readonly<{
      projectId: string;
      revision: string;
    }>,
  ): Promise<Readonly<PluginPackagePromptOutputArtifactRetentionPolicy> | null>;
}

export interface PluginPackagePromptOutputRetentionPolicyCatalog {
  readonly schemaVersion: 1;
  readonly policies: readonly Readonly<{
    readonly projectId: string;
    readonly policy: Readonly<PluginPackagePromptOutputArtifactRetentionPolicy>;
    readonly policyDigest: string;
  }>[];
}

export interface PluginPackagePromptOutputArtifactGarbageCollector {
  collect(): Promise<
    Readonly<{
      scanned: number;
      tombstoned: number;
      skipped: number;
      hasMore: boolean;
    }>
  >;
}

export class InvalidPluginPackagePromptOutputTombstoneError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_INVALID';

  constructor(message: string) {
    super(`Prompt output Artifact tombstone is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePromptOutputTombstoneError';
  }
}

export class InvalidPluginPackagePromptOutputRetentionPolicyCatalogError extends TypeError {
  readonly code =
    'PLUGIN_PACKAGE_PROMPT_OUTPUT_RETENTION_POLICY_CATALOG_INVALID';

  constructor(message: string) {
    super(`Prompt output retention policy catalog is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePromptOutputRetentionPolicyCatalogError';
  }
}

const DIGEST = /^[0-9a-f]{64}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TOMBSTONE_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-artifact-tombstone-digest@v1\0',
  'utf8',
);

function tombstoneDigest(
  value: Readonly<{
    schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_SCHEMA;
    reference: Readonly<PluginPackagePromptOutputArtifactReference>;
    tombstonedAtMs: number;
  }>,
): string {
  return createHash('sha256')
    .update(TOMBSTONE_DIGEST_DOMAIN)
    .update(JSON.stringify(value))
    .digest('hex');
}

export function createPluginPackagePromptOutputArtifactTombstone(
  referenceValue: PluginPackagePromptOutputArtifactReference,
  tombstonedAtMs: number,
): Readonly<PluginPackagePromptOutputArtifactTombstone> {
  const reference =
    normalizePluginPackagePromptOutputArtifactReference(referenceValue);
  if (!Number.isSafeInteger(tombstonedAtMs) || tombstonedAtMs < 0) {
    throw new InvalidPluginPackagePromptOutputTombstoneError(
      'tombstone time is invalid',
    );
  }
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_SCHEMA,
    reference,
    tombstonedAtMs,
  });
  return Object.freeze({
    ...unsigned,
    tombstoneDigest: tombstoneDigest(unsigned),
  });
}

export function normalizePluginPackagePromptOutputArtifactTombstone(
  value: PluginPackagePromptOutputArtifactTombstone,
): Readonly<PluginPackagePromptOutputArtifactTombstone> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      'reference\0schema\0tombstoneDigest\0tombstonedAtMs' ||
    value.schema !== PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_SCHEMA ||
    !Number.isSafeInteger(value.tombstonedAtMs) ||
    value.tombstonedAtMs < 0 ||
    typeof value.tombstoneDigest !== 'string' ||
    !DIGEST.test(value.tombstoneDigest)
  ) {
    throw new InvalidPluginPackagePromptOutputTombstoneError(
      'shape is invalid',
    );
  }
  const normalized = createPluginPackagePromptOutputArtifactTombstone(
    value.reference,
    value.tombstonedAtMs,
  );
  if (normalized.tombstoneDigest !== value.tombstoneDigest) {
    throw new InvalidPluginPackagePromptOutputTombstoneError(
      'digest is invalid',
    );
  }
  return normalized;
}

export function exactPluginPackagePromptOutputRetentionPolicy(
  value: PluginPackagePromptOutputArtifactRetentionPolicy,
  expected: Readonly<PluginPackagePromptOutputArtifactRetentionPolicy>,
  expectedDigest: string,
): boolean {
  try {
    const normalized =
      normalizePluginPackagePromptOutputArtifactRetentionPolicy(value);
    return (
      normalized.revision === expected.revision &&
      normalized.retentionMs === expected.retentionMs &&
      pluginPackagePromptOutputArtifactRetentionPolicyDigest(normalized) ===
        expectedDigest
    );
  } catch {
    return false;
  }
}

/**
 * Builds a bounded immutable resolver from operator/Owner-owned durable
 * configuration. A policy is addressed by Project and revision; its digest is
 * repeated in the catalog so a rewritten revision fails before any GC write.
 */
export function createPluginPackagePromptOutputRetentionPolicyCatalogResolver(
  value: PluginPackagePromptOutputRetentionPolicyCatalog,
): PluginPackagePromptOutputRetentionPolicyResolver {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== 'policies\0schemaVersion' ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.policies) ||
    value.policies.length < 1 ||
    value.policies.length > MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_RETENTION_POLICIES
  ) {
    throw new InvalidPluginPackagePromptOutputRetentionPolicyCatalogError(
      'shape or policy count is invalid',
    );
  }
  const entries = new Map<
    string,
    Readonly<PluginPackagePromptOutputArtifactRetentionPolicy>
  >();
  for (const candidate of value.policies) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join('\0') !==
        'policy\0policyDigest\0projectId' ||
      typeof candidate.projectId !== 'string' ||
      !IDENTITY.test(candidate.projectId) ||
      typeof candidate.policyDigest !== 'string' ||
      !DIGEST.test(candidate.policyDigest)
    ) {
      throw new InvalidPluginPackagePromptOutputRetentionPolicyCatalogError(
        'policy entry is invalid',
      );
    }
    let policy: Readonly<PluginPackagePromptOutputArtifactRetentionPolicy>;
    try {
      policy = normalizePluginPackagePromptOutputArtifactRetentionPolicy(
        candidate.policy,
      );
    } catch (cause) {
      throw new InvalidPluginPackagePromptOutputRetentionPolicyCatalogError(
        cause instanceof Error ? cause.message : 'policy is invalid',
      );
    }
    if (
      pluginPackagePromptOutputArtifactRetentionPolicyDigest(policy) !==
      candidate.policyDigest
    ) {
      throw new InvalidPluginPackagePromptOutputRetentionPolicyCatalogError(
        'policy digest is invalid',
      );
    }
    const key = `${candidate.projectId}\0${policy.revision}`;
    if (entries.has(key)) {
      throw new InvalidPluginPackagePromptOutputRetentionPolicyCatalogError(
        'duplicate Project revision is invalid',
      );
    }
    entries.set(key, policy);
  }
  return Object.freeze({
    async resolve(request: Readonly<{ projectId: string; revision: string }>) {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(request).sort().join('\0') !== 'projectId\0revision' ||
        typeof request.projectId !== 'string' ||
        !IDENTITY.test(request.projectId) ||
        typeof request.revision !== 'string' ||
        !IDENTITY.test(request.revision)
      ) {
        throw new InvalidPluginPackagePromptOutputRetentionPolicyCatalogError(
          'lookup is invalid',
        );
      }
      return entries.get(`${request.projectId}\0${request.revision}`) ?? null;
    },
  });
}

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { PluginPackagePromptOutputArtifactKeyMaterial } from '../pluginPackagePromptOutputArtifact';
import {
  InvalidPluginPackagePromptOutputKeyRetirementError,
  PluginPackagePromptOutputKeyRetirementConflictError,
  PluginPackagePromptOutputKeyRetirementUnavailableError,
  normalizePluginPackagePromptOutputKeyRetirementPreparation,
  normalizePluginPackagePromptOutputKeyRetirementRequest,
  pluginPackagePromptOutputKeyRetirementAbsenceProof,
  type PluginPackagePromptOutputKeyMaterialState,
  type PluginPackagePromptOutputKeyRetirementPreparation,
} from './pluginPackagePromptOutputKeyRetirement';

export const PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA =
  'qinglong/plugin-package-prompt-output-file-keyring@v1' as const;
export const MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_BYTES = 256 * 1024;
export const MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_KEYS = 16;
export const MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_RETIREMENTS = 64;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CATALOG_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-key-catalog-digest@v1\0',
  'utf8',
);
const MATERIAL_PROOF_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-key-material-proof@v1\0',
  'utf8',
);

export interface PluginPackagePromptOutputKeyringRetirementRecord {
  readonly preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
  readonly retiredCatalogDigest: string;
  readonly absenceProof: string;
}

export interface PluginPackagePromptOutputKeyringManifest {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA;
  readonly generation: number;
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly retirements: Readonly<
    Record<string, PluginPackagePromptOutputKeyringRetirementRecord>
  >;
}

export interface PluginPackagePromptOutputKeyringSummary {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly activeKeyId: string;
  readonly keyIds: readonly string[];
  readonly retiredKeyIds: readonly string[];
  readonly catalogDigest: string;
}

export interface PluginPackagePromptOutputKeyringRetirementMutation {
  readonly changed: boolean;
  readonly manifest: Readonly<PluginPackagePromptOutputKeyringManifest>;
  readonly state: Readonly<{
    state: 'absent';
    keyId: string;
    catalogDigest: string;
    absenceProof: string;
  }>;
}

export interface PluginPackagePromptOutputKeyringRotationMutation {
  readonly changed: boolean;
  readonly manifest: Readonly<PluginPackagePromptOutputKeyringManifest>;
  readonly state: Readonly<{
    generation: number;
    previousActiveKeyId: string;
    activeKeyId: string;
    catalogDigest: string;
    materialProof: string;
  }>;
}

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputKeyRetirementUnavailableError {
  return new PluginPackagePromptOutputKeyRetirementUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

export function normalizePluginPackagePromptOutputKeyringKeyId(
  value: unknown,
): string {
  try {
    return normalizePluginPackagePromptOutputKeyRetirementRequest({
      keyId: value,
      retirementId: 'keyring-manifest-probe',
      requestId: 'keyring-manifest-probe',
      mutationId: 'keyring-manifest-probe',
    }).keyId;
  } catch (cause) {
    throw new InvalidPluginPackagePromptOutputKeyRetirementError(
      cause instanceof Error ? cause.message : 'keyId is invalid',
    );
  }
}

export function normalizePluginPackagePromptOutputKeyringDigest(
  value: unknown,
  label: string,
): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidPluginPackagePromptOutputKeyRetirementError(
      `${label} is invalid`,
    );
  }
  return value;
}

export function pluginPackagePromptOutputKeyringMaterialProof(
  keyIdValue: string,
  encoded: string,
): string {
  const normalizedKeyId =
    normalizePluginPackagePromptOutputKeyringKeyId(keyIdValue);
  let material: Buffer | undefined;
  try {
    material = Buffer.from(encoded, 'base64url');
    if (
      !BASE64URL_PATTERN.test(encoded) ||
      material.length !== 32 ||
      material.toString('base64url') !== encoded
    ) {
      throw unavailable();
    }
    return createHash('sha256')
      .update(MATERIAL_PROOF_DOMAIN)
      .update(normalizedKeyId)
      .update('\0')
      .update(material)
      .digest('hex');
  } finally {
    material?.fill(0);
  }
}

export function pluginPackagePromptOutputKeyringCatalogDigest(
  manifest: Readonly<PluginPackagePromptOutputKeyringManifest>,
): string {
  const keys = Object.entries(manifest.keys)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([id, encoded]) =>
        [
          id,
          pluginPackagePromptOutputKeyringMaterialProof(id, encoded),
        ] as const,
    );
  return createHash('sha256')
    .update(CATALOG_DIGEST_DOMAIN)
    .update(
      JSON.stringify({
        schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA,
        generation: manifest.generation,
        activeKeyId: manifest.activeKeyId,
        keys,
      }),
    )
    .digest('hex');
}

export function canonicalPluginPackagePromptOutputKeyringManifest(
  manifest: Readonly<PluginPackagePromptOutputKeyringManifest>,
): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA,
      generation: manifest.generation,
      activeKeyId: manifest.activeKeyId,
      keys: Object.fromEntries(
        Object.entries(manifest.keys).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      retirements: Object.fromEntries(
        Object.entries(manifest.retirements).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    })}\n`,
    'utf8',
  );
}

export function parsePluginPackagePromptOutputKeyringManifest(
  bytes: Buffer,
): Readonly<PluginPackagePromptOutputKeyringManifest> {
  try {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length < 1 ||
      bytes.length > MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_BYTES
    ) {
      throw unavailable();
    }
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !exactKeys(parsed, [
        'activeKeyId',
        'generation',
        'keys',
        'retirements',
        'schema',
      ])
    ) {
      throw unavailable();
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.schema !==
        PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA ||
      !Number.isSafeInteger(candidate.generation) ||
      (candidate.generation as number) < 1 ||
      !candidate.keys ||
      typeof candidate.keys !== 'object' ||
      Array.isArray(candidate.keys) ||
      !candidate.retirements ||
      typeof candidate.retirements !== 'object' ||
      Array.isArray(candidate.retirements)
    ) {
      throw unavailable();
    }
    const activeKeyId = normalizePluginPackagePromptOutputKeyringKeyId(
      candidate.activeKeyId,
    );
    const keyEntries = Object.entries(
      candidate.keys as Record<string, unknown>,
    );
    const retirementEntries = Object.entries(
      candidate.retirements as Record<string, unknown>,
    );
    if (
      keyEntries.length < 1 ||
      keyEntries.length > MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_KEYS ||
      retirementEntries.length >
        MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_RETIREMENTS
    ) {
      throw unavailable();
    }
    const keys: Record<string, string> = Object.create(null);
    for (const [candidateKeyId, encoded] of keyEntries) {
      const normalizedKeyId =
        normalizePluginPackagePromptOutputKeyringKeyId(candidateKeyId);
      if (typeof encoded !== 'string' || keys[normalizedKeyId]) {
        throw unavailable();
      }
      pluginPackagePromptOutputKeyringMaterialProof(normalizedKeyId, encoded);
      keys[normalizedKeyId] = encoded;
    }
    if (!keys[activeKeyId]) throw unavailable();
    const retirements: Record<
      string,
      PluginPackagePromptOutputKeyringRetirementRecord
    > = Object.create(null);
    for (const [candidateKeyId, value] of retirementEntries) {
      const normalizedKeyId =
        normalizePluginPackagePromptOutputKeyringKeyId(candidateKeyId);
      if (
        keys[normalizedKeyId] ||
        retirements[normalizedKeyId] ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !exactKeys(value, [
          'absenceProof',
          'preparation',
          'retiredCatalogDigest',
        ])
      ) {
        throw unavailable();
      }
      const record = value as Record<string, unknown>;
      const preparation =
        normalizePluginPackagePromptOutputKeyRetirementPreparation(
          record.preparation as PluginPackagePromptOutputKeyRetirementPreparation,
        );
      const retiredCatalogDigest =
        normalizePluginPackagePromptOutputKeyringDigest(
          record.retiredCatalogDigest,
          'retiredCatalogDigest',
        );
      const absenceProof = normalizePluginPackagePromptOutputKeyringDigest(
        record.absenceProof,
        'absenceProof',
      );
      if (
        preparation.keyId !== normalizedKeyId ||
        absenceProof !==
          pluginPackagePromptOutputKeyRetirementAbsenceProof(
            preparation,
            retiredCatalogDigest,
          )
      ) {
        throw unavailable();
      }
      retirements[normalizedKeyId] = Object.freeze({
        preparation,
        retiredCatalogDigest,
        absenceProof,
      });
    }
    return Object.freeze({
      schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA,
      generation: candidate.generation as number,
      activeKeyId,
      keys: Object.freeze(keys),
      retirements: Object.freeze(retirements),
    });
  } catch (cause) {
    throw cause instanceof
      PluginPackagePromptOutputKeyRetirementUnavailableError
      ? cause
      : unavailable(cause);
  }
}

export function summarizePluginPackagePromptOutputKeyringManifest(
  manifest: Readonly<PluginPackagePromptOutputKeyringManifest>,
): Readonly<PluginPackagePromptOutputKeyringSummary> {
  return Object.freeze({
    schemaVersion: 1 as const,
    generation: manifest.generation,
    activeKeyId: manifest.activeKeyId,
    keyIds: Object.freeze(Object.keys(manifest.keys).sort()),
    retiredKeyIds: Object.freeze(Object.keys(manifest.retirements).sort()),
    catalogDigest: pluginPackagePromptOutputKeyringCatalogDigest(manifest),
  });
}

export function resolvePluginPackagePromptOutputKeyringMaterial(
  manifest: Readonly<PluginPackagePromptOutputKeyringManifest>,
  candidateKeyId: string,
): PluginPackagePromptOutputArtifactKeyMaterial | null {
  const normalizedKeyId =
    normalizePluginPackagePromptOutputKeyringKeyId(candidateKeyId);
  const encoded = manifest.keys[normalizedKeyId];
  return encoded
    ? Object.freeze({
        keyId: normalizedKeyId,
        key: Uint8Array.from(Buffer.from(encoded, 'base64url')),
      })
    : null;
}

export function inspectPluginPackagePromptOutputKeyringManifest(
  manifest: Readonly<PluginPackagePromptOutputKeyringManifest>,
  candidateKeyId: string,
): PluginPackagePromptOutputKeyMaterialState {
  const normalizedKeyId =
    normalizePluginPackagePromptOutputKeyringKeyId(candidateKeyId);
  const encoded = manifest.keys[normalizedKeyId];
  if (encoded) {
    return Object.freeze({
      state:
        normalizedKeyId === manifest.activeKeyId
          ? ('active' as const)
          : ('inactive' as const),
      keyId: normalizedKeyId,
      catalogDigest: pluginPackagePromptOutputKeyringCatalogDigest(manifest),
      materialProof: pluginPackagePromptOutputKeyringMaterialProof(
        normalizedKeyId,
        encoded,
      ),
    });
  }
  const retirement = manifest.retirements[normalizedKeyId];
  if (!retirement) throw unavailable();
  return Object.freeze({
    state: 'absent' as const,
    keyId: normalizedKeyId,
    catalogDigest: retirement.retiredCatalogDigest,
    absenceProof: retirement.absenceProof,
  });
}

/**
 * Adds one externally staged 32-byte key and makes it active while retaining
 * every prior key for historical decryption. Replaying the same staged
 * material against the exact derived successor is a no-op; every other winner
 * conflicts. The caller owns and must wipe its staged material.
 */
export function rotatePluginPackagePromptOutputKeyringManifest(
  manifest: Readonly<PluginPackagePromptOutputKeyringManifest>,
  request: Readonly<{
    expectedActiveKeyId: string;
    expectedCatalogDigest: string;
    newKeyId: string;
    material: Uint8Array;
  }>,
): Readonly<PluginPackagePromptOutputKeyringRotationMutation> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new InvalidPluginPackagePromptOutputKeyRetirementError(
      'keyring rotation request is invalid',
    );
  }
  const expectedActiveKeyId = normalizePluginPackagePromptOutputKeyringKeyId(
    request.expectedActiveKeyId,
  );
  const expectedCatalogDigest = normalizePluginPackagePromptOutputKeyringDigest(
    request.expectedCatalogDigest,
    'expectedCatalogDigest',
  );
  const newKeyId = normalizePluginPackagePromptOutputKeyringKeyId(
    request.newKeyId,
  );
  if (
    newKeyId === expectedActiveKeyId ||
    !(request.material instanceof Uint8Array) ||
    request.material.byteLength !== 32
  ) {
    throw new InvalidPluginPackagePromptOutputKeyRetirementError(
      'keyring rotation material is invalid',
    );
  }
  const material = Buffer.from(request.material);
  try {
    const encoded = material.toString('base64url');
    const materialProof = pluginPackagePromptOutputKeyringMaterialProof(
      newKeyId,
      encoded,
    );
    const currentCatalogDigest =
      pluginPackagePromptOutputKeyringCatalogDigest(manifest);
    if (
      manifest.activeKeyId === expectedActiveKeyId &&
      currentCatalogDigest === expectedCatalogDigest
    ) {
      if (
        manifest.keys[newKeyId] !== undefined ||
        manifest.retirements[newKeyId] !== undefined ||
        Object.keys(manifest.keys).length >=
          MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_KEYS ||
        manifest.generation >= Number.MAX_SAFE_INTEGER
      ) {
        throw new PluginPackagePromptOutputKeyRetirementConflictError();
      }
      const next: PluginPackagePromptOutputKeyringManifest = Object.freeze({
        ...manifest,
        generation: manifest.generation + 1,
        activeKeyId: newKeyId,
        keys: Object.freeze({ ...manifest.keys, [newKeyId]: encoded }),
      });
      return Object.freeze({
        changed: true,
        manifest: next,
        state: Object.freeze({
          generation: next.generation,
          previousActiveKeyId: expectedActiveKeyId,
          activeKeyId: newKeyId,
          catalogDigest: pluginPackagePromptOutputKeyringCatalogDigest(next),
          materialProof,
        }),
      });
    }

    const existing = manifest.keys[newKeyId];
    if (
      manifest.activeKeyId !== newKeyId ||
      existing === undefined ||
      pluginPackagePromptOutputKeyringMaterialProof(newKeyId, existing) !==
        materialProof ||
      manifest.generation <= 1
    ) {
      throw new PluginPackagePromptOutputKeyRetirementConflictError();
    }
    const priorKeys = { ...manifest.keys };
    delete priorKeys[newKeyId];
    const prior: PluginPackagePromptOutputKeyringManifest = Object.freeze({
      ...manifest,
      generation: manifest.generation - 1,
      activeKeyId: expectedActiveKeyId,
      keys: Object.freeze(priorKeys),
    });
    if (
      prior.keys[expectedActiveKeyId] === undefined ||
      pluginPackagePromptOutputKeyringCatalogDigest(prior) !==
        expectedCatalogDigest
    ) {
      throw new PluginPackagePromptOutputKeyRetirementConflictError();
    }
    return Object.freeze({
      changed: false,
      manifest,
      state: Object.freeze({
        generation: manifest.generation,
        previousActiveKeyId: expectedActiveKeyId,
        activeKeyId: newKeyId,
        catalogDigest: currentCatalogDigest,
        materialProof,
      }),
    });
  } finally {
    material.fill(0);
  }
}

export function retirePluginPackagePromptOutputKeyringManifest(
  manifest: Readonly<PluginPackagePromptOutputKeyringManifest>,
  preparationValue: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>,
): Readonly<PluginPackagePromptOutputKeyringRetirementMutation> {
  const preparation =
    normalizePluginPackagePromptOutputKeyRetirementPreparation(
      preparationValue,
    );
  const prior = manifest.retirements[preparation.keyId];
  if (prior) {
    if (JSON.stringify(prior.preparation) !== JSON.stringify(preparation)) {
      throw new PluginPackagePromptOutputKeyRetirementConflictError();
    }
    return Object.freeze({
      changed: false,
      manifest,
      state: Object.freeze({
        state: 'absent' as const,
        keyId: preparation.keyId,
        catalogDigest: prior.retiredCatalogDigest,
        absenceProof: prior.absenceProof,
      }),
    });
  }
  const encoded = manifest.keys[preparation.keyId];
  if (
    !encoded ||
    manifest.activeKeyId === preparation.keyId ||
    pluginPackagePromptOutputKeyringCatalogDigest(manifest) !==
      preparation.catalogDigest ||
    pluginPackagePromptOutputKeyringMaterialProof(
      preparation.keyId,
      encoded,
    ) !== preparation.materialProof
  ) {
    throw new PluginPackagePromptOutputKeyRetirementConflictError();
  }
  if (
    Object.keys(manifest.retirements).length >=
    MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_RETIREMENTS
  ) {
    throw new PluginPackagePromptOutputKeyRetirementConflictError();
  }
  const keys = { ...manifest.keys };
  delete keys[preparation.keyId];
  const withoutRetirement: PluginPackagePromptOutputKeyringManifest =
    Object.freeze({
      ...manifest,
      generation: manifest.generation + 1,
      keys: Object.freeze(keys),
    });
  const retiredCatalogDigest =
    pluginPackagePromptOutputKeyringCatalogDigest(withoutRetirement);
  const absenceProof = pluginPackagePromptOutputKeyRetirementAbsenceProof(
    preparation,
    retiredCatalogDigest,
  );
  const next: PluginPackagePromptOutputKeyringManifest = Object.freeze({
    ...withoutRetirement,
    retirements: Object.freeze({
      ...manifest.retirements,
      [preparation.keyId]: Object.freeze({
        preparation,
        retiredCatalogDigest,
        absenceProof,
      }),
    }),
  });
  return Object.freeze({
    changed: true,
    manifest: next,
    state: Object.freeze({
      state: 'absent' as const,
      keyId: preparation.keyId,
      catalogDigest: retiredCatalogDigest,
      absenceProof,
    }),
  });
}

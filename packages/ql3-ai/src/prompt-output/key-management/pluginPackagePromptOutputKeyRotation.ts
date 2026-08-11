import { Buffer } from 'node:buffer';
// Key rotation coordinates manifests and retirement without owning persistence.
import { createHash } from 'node:crypto';

import { pluginPackagePromptOutputKeyringMaterialProof } from './pluginPackagePromptOutputKeyringManifest';
import {
  InvalidPluginPackagePromptOutputKeyRetirementError,
  PluginPackagePromptOutputKeyRetirementConflictError,
  PluginPackagePromptOutputKeyRetirementUnavailableError,
} from './pluginPackagePromptOutputKeyRetirement';

export const PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_PREPARATION_SCHEMA =
  'qinglong/plugin-package-prompt-output-key-rotation-preparation@v1' as const;
export const PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_COMPLETION_SCHEMA =
  'qinglong/plugin-package-prompt-output-key-rotation-completion@v1' as const;

const PREPARATION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-key-rotation-preparation-digest@v1\0',
  'utf8',
);
const COMPLETION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-key-rotation-completion-digest@v1\0',
  'utf8',
);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface PluginPackagePromptOutputKeyRotationRequest {
  readonly rotationId: string;
  readonly requestId: string;
  readonly mutationId: string;
  readonly expectedSecretUid: string;
  readonly expectedActiveKeyId: string;
  readonly expectedCatalogDigest: string;
  readonly newKeyId: string;
}

export interface PluginPackagePromptOutputKeyRotationPreparation
  extends PluginPackagePromptOutputKeyRotationRequest {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_PREPARATION_SCHEMA;
  readonly materialProof: string;
  readonly preparedAtMs: number;
  readonly preparationDigest: string;
}

export interface PluginPackagePromptOutputKeyRotationCompletion {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_COMPLETION_SCHEMA;
  readonly rotationId: string;
  readonly requestId: string;
  readonly mutationId: string;
  readonly preparationDigest: string;
  readonly generation: number;
  readonly previousActiveKeyId: string;
  readonly activeKeyId: string;
  readonly catalogDigest: string;
  readonly materialProof: string;
  readonly completedAtMs: number;
  readonly completionDigest: string;
}

export interface PluginPackagePromptOutputKeyRotationRecord {
  readonly preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>;
  readonly completion: Readonly<PluginPackagePromptOutputKeyRotationCompletion> | null;
}

export interface PluginPackagePromptOutputKeyRotationState {
  readonly generation: number;
  readonly previousActiveKeyId: string;
  readonly activeKeyId: string;
  readonly catalogDigest: string;
  readonly materialProof: string;
}

export interface PluginPackagePromptOutputKeyRotationRepository {
  find(
    rotationId: string,
  ): Promise<Readonly<PluginPackagePromptOutputKeyRotationRecord> | null>;
  prepare(
    command: Readonly<{
      request: Readonly<PluginPackagePromptOutputKeyRotationRequest>;
      materialProof: string;
    }>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>;
    }>
  >;
  complete(
    command: Readonly<{
      preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>;
      state: Readonly<PluginPackagePromptOutputKeyRotationState>;
    }>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      completion: Readonly<PluginPackagePromptOutputKeyRotationCompletion>;
    }>
  >;
}

export interface PluginPackagePromptOutputKeyRotationMaterialAuthority {
  rotate(
    command: Readonly<{
      expectedActiveKeyId: string;
      expectedCatalogDigest: string;
      newKeyId: string;
      material: Uint8Array;
    }>,
  ): Promise<Readonly<PluginPackagePromptOutputKeyRotationState>>;
}

export class InvalidPluginPackagePromptOutputKeyRotationError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_INVALID';

  constructor(message: string) {
    super(`Prompt output key rotation is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePromptOutputKeyRotationError';
  }
}

export class PluginPackagePromptOutputKeyRotationConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_CONFLICT';

  constructor() {
    super('Prompt output key rotation conflicts with durable state');
    this.name = 'PluginPackagePromptOutputKeyRotationConflictError';
  }
}

export class PluginPackagePromptOutputKeyRotationUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Prompt output key rotation is unavailable', options);
    this.name = 'PluginPackagePromptOutputKeyRotationUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidPluginPackagePromptOutputKeyRotationError(message);
}

function conflict(): never {
  throw new PluginPackagePromptOutputKeyRotationConflictError();
}

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputKeyRotationUnavailableError {
  return new PluginPackagePromptOutputKeyRotationUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const allowed = new Set(expected);
  if (
    actual.length !== expected.length ||
    actual.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    expected.some((key) => !actual.includes(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function patterned(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 2) {
    return invalid('generation is invalid');
  }
  return value as number;
}

function hash(domain: Buffer, value: object): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

export function normalizePluginPackagePromptOutputKeyRotationRequest(
  value: unknown,
): Readonly<PluginPackagePromptOutputKeyRotationRequest> {
  const candidate = record(value, 'request');
  exactKeys(
    candidate,
    [
      'rotationId',
      'requestId',
      'mutationId',
      'expectedSecretUid',
      'expectedActiveKeyId',
      'expectedCatalogDigest',
      'newKeyId',
    ],
    'request',
  );
  const expectedActiveKeyId = patterned(
    candidate.expectedActiveKeyId,
    KEY_ID_PATTERN,
    'expectedActiveKeyId',
  );
  const newKeyId = patterned(candidate.newKeyId, KEY_ID_PATTERN, 'newKeyId');
  if (expectedActiveKeyId === newKeyId) invalid('newKeyId must be new');
  return Object.freeze({
    rotationId: patterned(candidate.rotationId, ID_PATTERN, 'rotationId'),
    requestId: patterned(candidate.requestId, ID_PATTERN, 'requestId'),
    mutationId: patterned(candidate.mutationId, ID_PATTERN, 'mutationId'),
    expectedSecretUid: patterned(
      candidate.expectedSecretUid,
      UID_PATTERN,
      'expectedSecretUid',
    ),
    expectedActiveKeyId,
    expectedCatalogDigest: patterned(
      candidate.expectedCatalogDigest,
      DIGEST_PATTERN,
      'expectedCatalogDigest',
    ),
    newKeyId,
  });
}

export function pluginPackagePromptOutputKeyRotationMaterialProof(
  newKeyId: string,
  materialValue: Uint8Array,
): string {
  if (
    !(materialValue instanceof Uint8Array) ||
    materialValue.byteLength !== 32
  ) {
    return invalid('material must be exactly 32 bytes');
  }
  const material = Buffer.from(materialValue);
  try {
    return pluginPackagePromptOutputKeyringMaterialProof(
      patterned(newKeyId, KEY_ID_PATTERN, 'newKeyId'),
      material.toString('base64url'),
    );
  } catch (cause) {
    throw cause instanceof InvalidPluginPackagePromptOutputKeyRotationError
      ? cause
      : unavailable(cause);
  } finally {
    material.fill(0);
  }
}

function preparationValue(
  value: Readonly<{
    request: Readonly<PluginPackagePromptOutputKeyRotationRequest>;
    materialProof: string;
    preparedAtMs: number;
  }>,
): Omit<PluginPackagePromptOutputKeyRotationPreparation, 'preparationDigest'> {
  const request = normalizePluginPackagePromptOutputKeyRotationRequest(
    value.request,
  );
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_PREPARATION_SCHEMA,
    ...request,
    materialProof: patterned(
      value.materialProof,
      DIGEST_PATTERN,
      'materialProof',
    ),
    preparedAtMs: timestamp(value.preparedAtMs, 'preparedAtMs'),
  });
}

export function createPluginPackagePromptOutputKeyRotationPreparation(
  value: Readonly<{
    request: Readonly<PluginPackagePromptOutputKeyRotationRequest>;
    materialProof: string;
    preparedAtMs: number;
  }>,
): Readonly<PluginPackagePromptOutputKeyRotationPreparation> {
  const preparation = preparationValue(value);
  return Object.freeze({
    ...preparation,
    preparationDigest: hash(PREPARATION_DIGEST_DOMAIN, preparation),
  });
}

export function normalizePluginPackagePromptOutputKeyRotationPreparation(
  value: PluginPackagePromptOutputKeyRotationPreparation,
): Readonly<PluginPackagePromptOutputKeyRotationPreparation> {
  const candidate = record(value, 'preparation');
  exactKeys(
    candidate,
    [
      'schema',
      'rotationId',
      'requestId',
      'mutationId',
      'expectedSecretUid',
      'expectedActiveKeyId',
      'expectedCatalogDigest',
      'newKeyId',
      'materialProof',
      'preparedAtMs',
      'preparationDigest',
    ],
    'preparation',
  );
  if (
    candidate.schema !==
    PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_PREPARATION_SCHEMA
  ) {
    invalid('preparation schema is invalid');
  }
  const normalized = createPluginPackagePromptOutputKeyRotationPreparation({
    request: {
      rotationId: candidate.rotationId as string,
      requestId: candidate.requestId as string,
      mutationId: candidate.mutationId as string,
      expectedSecretUid: candidate.expectedSecretUid as string,
      expectedActiveKeyId: candidate.expectedActiveKeyId as string,
      expectedCatalogDigest: candidate.expectedCatalogDigest as string,
      newKeyId: candidate.newKeyId as string,
    },
    materialProof: candidate.materialProof as string,
    preparedAtMs: candidate.preparedAtMs as number,
  });
  if (normalized.preparationDigest !== candidate.preparationDigest) {
    invalid('preparation digest is invalid');
  }
  return normalized;
}

function normalizedState(
  value: Readonly<PluginPackagePromptOutputKeyRotationState>,
  preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>,
): Readonly<PluginPackagePromptOutputKeyRotationState> {
  const candidate = record(value, 'rotation state');
  exactKeys(
    candidate,
    [
      'generation',
      'previousActiveKeyId',
      'activeKeyId',
      'catalogDigest',
      'materialProof',
    ],
    'rotation state',
  );
  const state = Object.freeze({
    generation: generation(candidate.generation),
    previousActiveKeyId: patterned(
      candidate.previousActiveKeyId,
      KEY_ID_PATTERN,
      'previousActiveKeyId',
    ),
    activeKeyId: patterned(
      candidate.activeKeyId,
      KEY_ID_PATTERN,
      'activeKeyId',
    ),
    catalogDigest: patterned(
      candidate.catalogDigest,
      DIGEST_PATTERN,
      'catalogDigest',
    ),
    materialProof: patterned(
      candidate.materialProof,
      DIGEST_PATTERN,
      'materialProof',
    ),
  });
  if (
    state.previousActiveKeyId !== preparation.expectedActiveKeyId ||
    state.activeKeyId !== preparation.newKeyId ||
    state.materialProof !== preparation.materialProof
  ) {
    conflict();
  }
  return state;
}

function completionValue(
  value: Readonly<{
    preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>;
    state: Readonly<PluginPackagePromptOutputKeyRotationState>;
    completedAtMs: number;
  }>,
): Omit<PluginPackagePromptOutputKeyRotationCompletion, 'completionDigest'> {
  const preparation = normalizePluginPackagePromptOutputKeyRotationPreparation(
    value.preparation,
  );
  const state = normalizedState(value.state, preparation);
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_COMPLETION_SCHEMA,
    rotationId: preparation.rotationId,
    requestId: preparation.requestId,
    mutationId: preparation.mutationId,
    preparationDigest: preparation.preparationDigest,
    ...state,
    completedAtMs: timestamp(value.completedAtMs, 'completedAtMs'),
  });
}

export function createPluginPackagePromptOutputKeyRotationCompletion(
  value: Readonly<{
    preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>;
    state: Readonly<PluginPackagePromptOutputKeyRotationState>;
    completedAtMs: number;
  }>,
): Readonly<PluginPackagePromptOutputKeyRotationCompletion> {
  const completion = completionValue(value);
  return Object.freeze({
    ...completion,
    completionDigest: hash(COMPLETION_DIGEST_DOMAIN, completion),
  });
}

export function normalizePluginPackagePromptOutputKeyRotationCompletion(
  value: PluginPackagePromptOutputKeyRotationCompletion,
): Readonly<PluginPackagePromptOutputKeyRotationCompletion> {
  const candidate = record(value, 'completion');
  exactKeys(
    candidate,
    [
      'schema',
      'rotationId',
      'requestId',
      'mutationId',
      'preparationDigest',
      'generation',
      'previousActiveKeyId',
      'activeKeyId',
      'catalogDigest',
      'materialProof',
      'completedAtMs',
      'completionDigest',
    ],
    'completion',
  );
  if (
    candidate.schema !==
    PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_COMPLETION_SCHEMA
  ) {
    invalid('completion schema is invalid');
  }
  const completion = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_COMPLETION_SCHEMA,
    rotationId: patterned(candidate.rotationId, ID_PATTERN, 'rotationId'),
    requestId: patterned(candidate.requestId, ID_PATTERN, 'requestId'),
    mutationId: patterned(candidate.mutationId, ID_PATTERN, 'mutationId'),
    preparationDigest: patterned(
      candidate.preparationDigest,
      DIGEST_PATTERN,
      'preparationDigest',
    ),
    generation: generation(candidate.generation),
    previousActiveKeyId: patterned(
      candidate.previousActiveKeyId,
      KEY_ID_PATTERN,
      'previousActiveKeyId',
    ),
    activeKeyId: patterned(
      candidate.activeKeyId,
      KEY_ID_PATTERN,
      'activeKeyId',
    ),
    catalogDigest: patterned(
      candidate.catalogDigest,
      DIGEST_PATTERN,
      'catalogDigest',
    ),
    materialProof: patterned(
      candidate.materialProof,
      DIGEST_PATTERN,
      'materialProof',
    ),
    completedAtMs: timestamp(candidate.completedAtMs, 'completedAtMs'),
  });
  const normalized = Object.freeze({
    ...completion,
    completionDigest: hash(COMPLETION_DIGEST_DOMAIN, completion),
  });
  if (normalized.completionDigest !== candidate.completionDigest) {
    invalid('completion digest is invalid');
  }
  return normalized;
}

function exactPreparation(
  preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>,
  request: Readonly<PluginPackagePromptOutputKeyRotationRequest>,
  materialProof: string,
): boolean {
  return (
    preparation.rotationId === request.rotationId &&
    preparation.requestId === request.requestId &&
    preparation.mutationId === request.mutationId &&
    preparation.expectedSecretUid === request.expectedSecretUid &&
    preparation.expectedActiveKeyId === request.expectedActiveKeyId &&
    preparation.expectedCatalogDigest === request.expectedCatalogDigest &&
    preparation.newKeyId === request.newKeyId &&
    preparation.materialProof === materialProof
  );
}

export class PluginPackagePromptOutputKeyRotationCoordinator {
  readonly #repository: PluginPackagePromptOutputKeyRotationRepository;
  readonly #materials: PluginPackagePromptOutputKeyRotationMaterialAuthority;

  constructor(
    options: Readonly<{
      repository: PluginPackagePromptOutputKeyRotationRepository;
      materials: PluginPackagePromptOutputKeyRotationMaterialAuthority;
    }>,
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !options.repository ||
      typeof options.repository.find !== 'function' ||
      typeof options.repository.prepare !== 'function' ||
      typeof options.repository.complete !== 'function' ||
      !options.materials ||
      typeof options.materials.rotate !== 'function'
    ) {
      throw unavailable();
    }
    this.#repository = options.repository;
    this.#materials = options.materials;
  }

  async rotate(
    value: Readonly<{
      request: Readonly<PluginPackagePromptOutputKeyRotationRequest>;
      material: Uint8Array;
    }>,
  ): Promise<
    Readonly<{
      status: 'completed' | 'existing';
      preparation: Readonly<PluginPackagePromptOutputKeyRotationPreparation>;
      completion: Readonly<PluginPackagePromptOutputKeyRotationCompletion>;
    }>
  > {
    const request = normalizePluginPackagePromptOutputKeyRotationRequest(
      value?.request,
    );
    const materialProof = pluginPackagePromptOutputKeyRotationMaterialProof(
      request.newKeyId,
      value?.material,
    );
    try {
      let durable = await this.#repository.find(request.rotationId);
      if (durable) {
        const preparation =
          normalizePluginPackagePromptOutputKeyRotationPreparation(
            durable.preparation,
          );
        if (!exactPreparation(preparation, request, materialProof)) conflict();
        if (durable.completion) {
          const completion =
            normalizePluginPackagePromptOutputKeyRotationCompletion(
              durable.completion,
            );
          if (completion.preparationDigest !== preparation.preparationDigest) {
            conflict();
          }
          return Object.freeze({
            status: 'existing' as const,
            preparation,
            completion,
          });
        }
      } else {
        const prepared = await this.#repository.prepare({
          request,
          materialProof,
        });
        durable = Object.freeze({
          preparation: prepared.preparation,
          completion: null,
        });
      }

      const preparation =
        normalizePluginPackagePromptOutputKeyRotationPreparation(
          durable.preparation,
        );
      if (!exactPreparation(preparation, request, materialProof)) conflict();
      const state = normalizedState(
        await this.#materials.rotate({
          expectedActiveKeyId: preparation.expectedActiveKeyId,
          expectedCatalogDigest: preparation.expectedCatalogDigest,
          newKeyId: preparation.newKeyId,
          material: value.material,
        }),
        preparation,
      );
      const completed = await this.#repository.complete({ preparation, state });
      return Object.freeze({
        status:
          completed.status === 'created'
            ? ('completed' as const)
            : ('existing' as const),
        preparation,
        completion: completed.completion,
      });
    } catch (cause) {
      if (
        cause instanceof InvalidPluginPackagePromptOutputKeyRotationError ||
        cause instanceof PluginPackagePromptOutputKeyRotationConflictError ||
        cause instanceof PluginPackagePromptOutputKeyRotationUnavailableError
      ) {
        throw cause;
      }
      if (
        cause instanceof PluginPackagePromptOutputKeyRetirementConflictError
      ) {
        throw new PluginPackagePromptOutputKeyRotationConflictError();
      }
      if (cause instanceof InvalidPluginPackagePromptOutputKeyRetirementError) {
        throw new InvalidPluginPackagePromptOutputKeyRotationError(
          'material authority rejected the command',
        );
      }
      if (
        cause instanceof PluginPackagePromptOutputKeyRetirementUnavailableError
      ) {
        throw unavailable(cause);
      }
      throw unavailable(cause);
    }
  }
}

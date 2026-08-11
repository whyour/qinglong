import { Buffer } from 'node:buffer';
// Key-management contracts are independent from storage implementations.
import { createHash } from 'node:crypto';

export const PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_PREPARATION_SCHEMA =
  'qinglong/plugin-package-prompt-output-key-retirement-preparation@v1' as const;
export const PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_COMPLETION_SCHEMA =
  'qinglong/plugin-package-prompt-output-key-retirement-completion@v1' as const;

const PREPARATION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-key-retirement-preparation-digest@v1\0',
  'utf8',
);
const COMPLETION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-key-retirement-completion-digest@v1\0',
  'utf8',
);
const ABSENCE_PROOF_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-key-retirement-absence-proof@v1\0',
  'utf8',
);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface PluginPackagePromptOutputKeyRetirementPreparation {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_PREPARATION_SCHEMA;
  readonly keyId: string;
  readonly retirementId: string;
  readonly requestId: string;
  readonly mutationId: string;
  readonly catalogDigest: string;
  readonly materialProof: string;
  readonly preparedAtMs: number;
  readonly preparationDigest: string;
}

export interface PluginPackagePromptOutputKeyRetirementCompletion {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_COMPLETION_SCHEMA;
  readonly keyId: string;
  readonly retirementId: string;
  readonly requestId: string;
  readonly mutationId: string;
  readonly preparationDigest: string;
  readonly retiredCatalogDigest: string;
  readonly absenceProof: string;
  readonly completedAtMs: number;
  readonly completionDigest: string;
}

export interface PluginPackagePromptOutputKeyRetirementRecord {
  readonly preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
  readonly completion: Readonly<PluginPackagePromptOutputKeyRetirementCompletion> | null;
}

export interface PluginPackagePromptOutputKeyRetirementRepository {
  find(
    keyId: string,
  ): Promise<Readonly<PluginPackagePromptOutputKeyRetirementRecord> | null>;
  prepare(
    command: Readonly<{
      keyId: string;
      retirementId: string;
      requestId: string;
      mutationId: string;
      catalogDigest: string;
      materialProof: string;
    }>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
    }>
  >;
  complete(
    command: Readonly<{
      preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
      retiredCatalogDigest: string;
      absenceProof: string;
    }>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      completion: Readonly<PluginPackagePromptOutputKeyRetirementCompletion>;
    }>
  >;
}

export type PluginPackagePromptOutputKeyMaterialState =
  | Readonly<{
      state: 'active' | 'inactive';
      keyId: string;
      catalogDigest: string;
      materialProof: string;
    }>
  | Readonly<{
      state: 'absent';
      keyId: string;
      catalogDigest: string;
      absenceProof: string;
    }>;

export interface PluginPackagePromptOutputKeyRetirementMaterialAuthority {
  inspect(keyId: string): Promise<PluginPackagePromptOutputKeyMaterialState>;
  retire(
    command: Readonly<{
      preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
    }>,
  ): Promise<
    Extract<PluginPackagePromptOutputKeyMaterialState, { state: 'absent' }>
  >;
}

export class InvalidPluginPackagePromptOutputKeyRetirementError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_INVALID';

  constructor(message: string) {
    super(`Prompt output key retirement is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePromptOutputKeyRetirementError';
  }
}

export class PluginPackagePromptOutputKeyRetirementConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_CONFLICT';

  constructor() {
    super('Prompt output key retirement conflicts with durable state');
    this.name = 'PluginPackagePromptOutputKeyRetirementConflictError';
  }
}

export class PluginPackagePromptOutputKeyRetirementUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Prompt output key retirement is unavailable', options);
    this.name = 'PluginPackagePromptOutputKeyRetirementUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidPluginPackagePromptOutputKeyRetirementError(message);
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
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(expected);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    expected.some((key) => !keys.includes(key))
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

function hash(domain: Buffer, value: object): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function preparationValue(
  value: Readonly<{
    keyId: string;
    retirementId: string;
    requestId: string;
    mutationId: string;
    catalogDigest: string;
    materialProof: string;
    preparedAtMs: number;
  }>,
): Omit<
  PluginPackagePromptOutputKeyRetirementPreparation,
  'preparationDigest'
> {
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_PREPARATION_SCHEMA,
    keyId: patterned(value.keyId, KEY_ID_PATTERN, 'keyId'),
    retirementId: patterned(value.retirementId, ID_PATTERN, 'retirementId'),
    requestId: patterned(value.requestId, ID_PATTERN, 'requestId'),
    mutationId: patterned(value.mutationId, ID_PATTERN, 'mutationId'),
    catalogDigest: patterned(
      value.catalogDigest,
      DIGEST_PATTERN,
      'catalogDigest',
    ),
    materialProof: patterned(
      value.materialProof,
      DIGEST_PATTERN,
      'materialProof',
    ),
    preparedAtMs: timestamp(value.preparedAtMs, 'preparedAtMs'),
  });
}

export function createPluginPackagePromptOutputKeyRetirementPreparation(
  value: Readonly<{
    keyId: string;
    retirementId: string;
    requestId: string;
    mutationId: string;
    catalogDigest: string;
    materialProof: string;
    preparedAtMs: number;
  }>,
): Readonly<PluginPackagePromptOutputKeyRetirementPreparation> {
  const prepared = preparationValue(value);
  return Object.freeze({
    ...prepared,
    preparationDigest: hash(PREPARATION_DIGEST_DOMAIN, prepared),
  });
}

export function normalizePluginPackagePromptOutputKeyRetirementPreparation(
  value: PluginPackagePromptOutputKeyRetirementPreparation,
): Readonly<PluginPackagePromptOutputKeyRetirementPreparation> {
  const candidate = record(value, 'preparation');
  exactKeys(
    candidate,
    [
      'schema',
      'keyId',
      'retirementId',
      'requestId',
      'mutationId',
      'catalogDigest',
      'materialProof',
      'preparedAtMs',
      'preparationDigest',
    ],
    'preparation',
  );
  if (
    candidate.schema !==
    PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_PREPARATION_SCHEMA
  ) {
    invalid('preparation schema is invalid');
  }
  const normalized = createPluginPackagePromptOutputKeyRetirementPreparation({
    keyId: candidate.keyId as string,
    retirementId: candidate.retirementId as string,
    requestId: candidate.requestId as string,
    mutationId: candidate.mutationId as string,
    catalogDigest: candidate.catalogDigest as string,
    materialProof: candidate.materialProof as string,
    preparedAtMs: candidate.preparedAtMs as number,
  });
  if (normalized.preparationDigest !== candidate.preparationDigest) {
    invalid('preparation digest is invalid');
  }
  return normalized;
}

function completionValue(
  value: Readonly<{
    preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
    retiredCatalogDigest: string;
    absenceProof: string;
    completedAtMs: number;
  }>,
): Omit<PluginPackagePromptOutputKeyRetirementCompletion, 'completionDigest'> {
  const preparation =
    normalizePluginPackagePromptOutputKeyRetirementPreparation(
      value.preparation,
    );
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_COMPLETION_SCHEMA,
    keyId: preparation.keyId,
    retirementId: preparation.retirementId,
    requestId: preparation.requestId,
    mutationId: preparation.mutationId,
    preparationDigest: preparation.preparationDigest,
    retiredCatalogDigest: patterned(
      value.retiredCatalogDigest,
      DIGEST_PATTERN,
      'retiredCatalogDigest',
    ),
    absenceProof: patterned(value.absenceProof, DIGEST_PATTERN, 'absenceProof'),
    completedAtMs: timestamp(value.completedAtMs, 'completedAtMs'),
  });
}

export function createPluginPackagePromptOutputKeyRetirementCompletion(
  value: Readonly<{
    preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
    retiredCatalogDigest: string;
    absenceProof: string;
    completedAtMs: number;
  }>,
): Readonly<PluginPackagePromptOutputKeyRetirementCompletion> {
  const completed = completionValue(value);
  return Object.freeze({
    ...completed,
    completionDigest: hash(COMPLETION_DIGEST_DOMAIN, completed),
  });
}

export function pluginPackagePromptOutputKeyRetirementAbsenceProof(
  preparationValue: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>,
  retiredCatalogDigestValue: string,
): string {
  const preparation =
    normalizePluginPackagePromptOutputKeyRetirementPreparation(
      preparationValue,
    );
  const retiredCatalogDigest = patterned(
    retiredCatalogDigestValue,
    DIGEST_PATTERN,
    'retiredCatalogDigest',
  );
  return hash(ABSENCE_PROOF_DOMAIN, {
    keyId: preparation.keyId,
    retirementId: preparation.retirementId,
    preparationDigest: preparation.preparationDigest,
    retiredCatalogDigest,
  });
}

export function normalizePluginPackagePromptOutputKeyRetirementCompletion(
  value: PluginPackagePromptOutputKeyRetirementCompletion,
): Readonly<PluginPackagePromptOutputKeyRetirementCompletion> {
  const candidate = record(value, 'completion');
  exactKeys(
    candidate,
    [
      'schema',
      'keyId',
      'retirementId',
      'requestId',
      'mutationId',
      'preparationDigest',
      'retiredCatalogDigest',
      'absenceProof',
      'completedAtMs',
      'completionDigest',
    ],
    'completion',
  );
  if (
    candidate.schema !==
    PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_COMPLETION_SCHEMA
  ) {
    invalid('completion schema is invalid');
  }
  const preparation = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_PREPARATION_SCHEMA,
    keyId: candidate.keyId,
    retirementId: candidate.retirementId,
    requestId: candidate.requestId,
    mutationId: candidate.mutationId,
    catalogDigest: '0'.repeat(64),
    materialProof: '0'.repeat(64),
    preparedAtMs: 0,
    preparationDigest: candidate.preparationDigest,
  }) as PluginPackagePromptOutputKeyRetirementPreparation;
  patterned(candidate.keyId, KEY_ID_PATTERN, 'keyId');
  patterned(candidate.retirementId, ID_PATTERN, 'retirementId');
  patterned(candidate.requestId, ID_PATTERN, 'requestId');
  patterned(candidate.mutationId, ID_PATTERN, 'mutationId');
  patterned(candidate.preparationDigest, DIGEST_PATTERN, 'preparationDigest');
  const completed = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_COMPLETION_SCHEMA,
    keyId: preparation.keyId,
    retirementId: preparation.retirementId,
    requestId: preparation.requestId,
    mutationId: preparation.mutationId,
    preparationDigest: preparation.preparationDigest,
    retiredCatalogDigest: patterned(
      candidate.retiredCatalogDigest,
      DIGEST_PATTERN,
      'retiredCatalogDigest',
    ),
    absenceProof: patterned(
      candidate.absenceProof,
      DIGEST_PATTERN,
      'absenceProof',
    ),
    completedAtMs: timestamp(candidate.completedAtMs, 'completedAtMs'),
  });
  const normalized = Object.freeze({
    ...completed,
    completionDigest: hash(COMPLETION_DIGEST_DOMAIN, completed),
  });
  if (normalized.completionDigest !== candidate.completionDigest) {
    invalid('completion digest is invalid');
  }
  return normalized;
}

function normalizeMaterialState(
  value: PluginPackagePromptOutputKeyMaterialState,
  expectedKeyId: string,
): PluginPackagePromptOutputKeyMaterialState {
  const candidate = record(value, 'material state');
  if (candidate.state === 'active' || candidate.state === 'inactive') {
    exactKeys(
      candidate,
      ['state', 'keyId', 'catalogDigest', 'materialProof'],
      'material state',
    );
    const normalized = Object.freeze({
      state: candidate.state,
      keyId: patterned(candidate.keyId, KEY_ID_PATTERN, 'material keyId'),
      catalogDigest: patterned(
        candidate.catalogDigest,
        DIGEST_PATTERN,
        'material catalogDigest',
      ),
      materialProof: patterned(
        candidate.materialProof,
        DIGEST_PATTERN,
        'materialProof',
      ),
    });
    if (normalized.keyId !== expectedKeyId) invalid('material keyId drifted');
    return normalized;
  }
  if (candidate.state === 'absent') {
    exactKeys(
      candidate,
      ['state', 'keyId', 'catalogDigest', 'absenceProof'],
      'material state',
    );
    const normalized = Object.freeze({
      state: 'absent' as const,
      keyId: patterned(candidate.keyId, KEY_ID_PATTERN, 'material keyId'),
      catalogDigest: patterned(
        candidate.catalogDigest,
        DIGEST_PATTERN,
        'material catalogDigest',
      ),
      absenceProof: patterned(
        candidate.absenceProof,
        DIGEST_PATTERN,
        'absenceProof',
      ),
    });
    if (normalized.keyId !== expectedKeyId) invalid('material keyId drifted');
    return normalized;
  }
  return invalid('material state is invalid');
}

export function normalizePluginPackagePromptOutputKeyRetirementRequest(
  value: unknown,
): Readonly<{
  keyId: string;
  retirementId: string;
  requestId: string;
  mutationId: string;
}> {
  const candidate = record(value, 'request');
  exactKeys(
    candidate,
    ['keyId', 'retirementId', 'requestId', 'mutationId'],
    'request',
  );
  return Object.freeze({
    keyId: patterned(candidate.keyId, KEY_ID_PATTERN, 'keyId'),
    retirementId: patterned(candidate.retirementId, ID_PATTERN, 'retirementId'),
    requestId: patterned(candidate.requestId, ID_PATTERN, 'requestId'),
    mutationId: patterned(candidate.mutationId, ID_PATTERN, 'mutationId'),
  });
}

function exactRequest(
  preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>,
  value: Readonly<{
    keyId: string;
    retirementId: string;
    requestId: string;
    mutationId: string;
  }>,
): boolean {
  return (
    preparation.keyId === value.keyId &&
    preparation.retirementId === value.retirementId &&
    preparation.requestId === value.requestId &&
    preparation.mutationId === value.mutationId
  );
}

function conflict(): never {
  throw new PluginPackagePromptOutputKeyRetirementConflictError();
}

export class PluginPackagePromptOutputKeyRetirementCoordinator {
  readonly #repository: PluginPackagePromptOutputKeyRetirementRepository;
  readonly #materials: PluginPackagePromptOutputKeyRetirementMaterialAuthority;

  constructor(
    options: Readonly<{
      repository: PluginPackagePromptOutputKeyRetirementRepository;
      materials: PluginPackagePromptOutputKeyRetirementMaterialAuthority;
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
      typeof options.materials.inspect !== 'function' ||
      typeof options.materials.retire !== 'function'
    ) {
      throw new PluginPackagePromptOutputKeyRetirementUnavailableError();
    }
    this.#repository = options.repository;
    this.#materials = options.materials;
  }

  async retire(
    value: Readonly<{
      keyId: string;
      retirementId: string;
      requestId: string;
      mutationId: string;
    }>,
  ): Promise<
    Readonly<{
      status: 'completed' | 'existing';
      preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
      completion: Readonly<PluginPackagePromptOutputKeyRetirementCompletion>;
    }>
  > {
    const command =
      normalizePluginPackagePromptOutputKeyRetirementRequest(value);
    try {
      let durable = await this.#repository.find(command.keyId);
      if (durable) {
        const preparation =
          normalizePluginPackagePromptOutputKeyRetirementPreparation(
            durable.preparation,
          );
        if (!exactRequest(preparation, command)) conflict();
        if (durable.completion) {
          const completion =
            normalizePluginPackagePromptOutputKeyRetirementCompletion(
              durable.completion,
            );
          const material = normalizeMaterialState(
            await this.#materials.inspect(command.keyId),
            command.keyId,
          );
          if (
            material.state !== 'absent' ||
            completion.preparationDigest !== preparation.preparationDigest ||
            completion.retiredCatalogDigest !== material.catalogDigest ||
            completion.absenceProof !== material.absenceProof ||
            completion.absenceProof !==
              pluginPackagePromptOutputKeyRetirementAbsenceProof(
                preparation,
                material.catalogDigest,
              )
          ) {
            conflict();
          }
          return Object.freeze({
            status: 'existing' as const,
            preparation,
            completion,
          });
        }
      }

      let preparation = durable?.preparation;
      if (!preparation) {
        const material = normalizeMaterialState(
          await this.#materials.inspect(command.keyId),
          command.keyId,
        );
        if (material.state !== 'inactive') conflict();
        const prepared = await this.#repository.prepare({
          ...command,
          catalogDigest: material.catalogDigest,
          materialProof: material.materialProof,
        });
        preparation =
          normalizePluginPackagePromptOutputKeyRetirementPreparation(
            prepared.preparation,
          );
        if (!exactRequest(preparation, command)) conflict();
      } else {
        preparation =
          normalizePluginPackagePromptOutputKeyRetirementPreparation(
            preparation,
          );
      }

      let material = normalizeMaterialState(
        await this.#materials.inspect(command.keyId),
        command.keyId,
      );
      if (material.state === 'active') conflict();
      if (material.state === 'inactive') {
        if (
          material.catalogDigest !== preparation.catalogDigest ||
          material.materialProof !== preparation.materialProof
        ) {
          conflict();
        }
        material = normalizeMaterialState(
          await this.#materials.retire({
            preparation,
          }),
          command.keyId,
        );
      }
      if (material.state !== 'absent') conflict();
      if (
        material.absenceProof !==
        pluginPackagePromptOutputKeyRetirementAbsenceProof(
          preparation,
          material.catalogDigest,
        )
      ) {
        conflict();
      }
      const completed = await this.#repository.complete({
        preparation,
        retiredCatalogDigest: material.catalogDigest,
        absenceProof: material.absenceProof,
      });
      return Object.freeze({
        status: completed.status === 'created' ? 'completed' : 'existing',
        preparation,
        completion: normalizePluginPackagePromptOutputKeyRetirementCompletion(
          completed.completion,
        ),
      });
    } catch (cause) {
      if (
        cause instanceof InvalidPluginPackagePromptOutputKeyRetirementError ||
        cause instanceof PluginPackagePromptOutputKeyRetirementConflictError ||
        cause instanceof PluginPackagePromptOutputKeyRetirementUnavailableError
      ) {
        throw cause;
      }
      throw new PluginPackagePromptOutputKeyRetirementUnavailableError({
        cause,
      });
    }
  }
}

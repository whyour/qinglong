import { assertApiCredentialPepperKeyId } from '../security/identity-credential/apiCredential';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_VERSION = 2_147_483_647;

export const MAX_LOCAL_OWNER_PEPPER_KEYS = 8;

export type LocalOwnerPepperKeyState =
  | 'recovery_required'
  | 'staged'
  | 'active'
  | 'retired';

export interface LocalOwnerPepperKeyRecord {
  readonly pepperKeyId: string;
  readonly materialDigest?: string;
  readonly backupDigest?: string;
  readonly state: LocalOwnerPepperKeyState;
  readonly version: number;
  readonly registerMutationId?: string;
  readonly activateMutationId?: string;
  readonly retireMutationId?: string;
  readonly registeredAtMs: number;
  readonly activatedAtMs?: number;
  readonly retiredAtMs?: number;
}

export interface LocalOwnerPepperActivationRecord {
  readonly generation: number;
  readonly mutationId: string;
  readonly expectedGeneration: number;
  readonly previousPepperKeyId?: string;
  readonly activePepperKeyId: string;
  readonly materialDigest: string;
  readonly backupDigest: string;
  readonly activatedAtMs: number;
}

export interface RegisterLocalOwnerPepperKeyCommand {
  readonly mutationId: string;
  readonly pepperKeyId: string;
  readonly materialDigest: string;
  readonly backupDigest: string;
  readonly registeredAtMs: number;
}

export interface RegisterLocalOwnerPepperKeyResult {
  readonly status: 'inserted' | 'existing';
  readonly key: Readonly<LocalOwnerPepperKeyRecord>;
}

export interface ActivateLocalOwnerPepperKeyCommand {
  readonly mutationId: string;
  readonly pepperKeyId: string;
  readonly expectedGeneration: number;
  readonly expectedActivePepperKeyId?: string;
  readonly activatedAtMs: number;
}

export interface ActivateLocalOwnerPepperKeyResult {
  readonly status: 'inserted' | 'existing';
  readonly activation: Readonly<LocalOwnerPepperActivationRecord>;
}

export interface LocalOwnerPepperReferenceSummary {
  readonly pepperKeyId: string;
  readonly inspectedAtMs: number;
  readonly currentCredentialReferences: number;
  readonly inFlightRecoveryReferences: number;
  readonly historicalCredentialReferences: number;
  readonly runtimeReferencesClear: boolean;
}

export interface LocalOwnerPepperRepository {
  resolveKey(
    pepperKeyId: string,
  ): Promise<Readonly<LocalOwnerPepperKeyRecord> | null>;
  resolveActive(): Promise<Readonly<LocalOwnerPepperActivationRecord> | null>;
  register(
    command: RegisterLocalOwnerPepperKeyCommand,
  ): Promise<RegisterLocalOwnerPepperKeyResult>;
  activate(
    command: ActivateLocalOwnerPepperKeyCommand,
  ): Promise<ActivateLocalOwnerPepperKeyResult>;
}

export interface LocalOwnerPepperReferenceRepository
  extends LocalOwnerPepperRepository {
  inspectReferences(
    pepperKeyId: string,
    inspectedAtMs: number,
  ): Promise<Readonly<LocalOwnerPepperReferenceSummary>>;
}

export class InvalidLocalOwnerPepperValueError extends TypeError {
  constructor(message: string) {
    super(`Local Owner pepper value is invalid: ${message}`);
    this.name = 'InvalidLocalOwnerPepperValueError';
  }
}

export class LocalOwnerPepperMutationConflictError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_MUTATION_CONFLICT';

  constructor() {
    super('Local Owner pepper mutation conflicts with previous use');
    this.name = 'LocalOwnerPepperMutationConflictError';
  }
}

export class LocalOwnerPepperGenerationConflictError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_GENERATION_CONFLICT';

  constructor() {
    super('Local Owner active pepper generation changed');
    this.name = 'LocalOwnerPepperGenerationConflictError';
  }
}

export class LocalOwnerPepperKeyNotActivatableError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_KEY_NOT_ACTIVATABLE';

  constructor() {
    super('Local Owner pepper key is not staged for activation');
    this.name = 'LocalOwnerPepperKeyNotActivatableError';
  }
}

export class LocalOwnerPepperCatalogFullError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_CATALOG_FULL';

  constructor() {
    super('Local Owner pepper catalog reached its hard key limit');
    this.name = 'LocalOwnerPepperCatalogFullError';
  }
}

export class LocalOwnerPepperRepositoryUnavailableError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_REPOSITORY_UNAVAILABLE';

  constructor() {
    super('Local Owner pepper repository is unavailable');
    this.name = 'LocalOwnerPepperRepositoryUnavailableError';
  }
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidLocalOwnerPepperValueError('object shape is invalid');
  }
}

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidLocalOwnerPepperValueError(`${field} is invalid`);
  }
}

function assertMutationId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new InvalidLocalOwnerPepperValueError('mutationId is invalid');
  }
}

function assertInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum = MAX_VERSION,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new InvalidLocalOwnerPepperValueError(`${field} is invalid`);
  }
}

export function normalizeRegisterLocalOwnerPepperKeyCommand(
  value: RegisterLocalOwnerPepperKeyCommand,
): Readonly<RegisterLocalOwnerPepperKeyCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerPepperValueError('command is invalid');
  }
  exactKeys(value, [
    'backupDigest',
    'materialDigest',
    'mutationId',
    'pepperKeyId',
    'registeredAtMs',
  ]);
  assertMutationId(value.mutationId);
  try {
    assertApiCredentialPepperKeyId(value.pepperKeyId);
  } catch {
    throw new InvalidLocalOwnerPepperValueError('pepperKeyId is invalid');
  }
  assertDigest(value.materialDigest, 'materialDigest');
  assertDigest(value.backupDigest, 'backupDigest');
  assertInteger(
    value.registeredAtMs,
    'registeredAtMs',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  return Object.freeze({ ...value });
}

export function normalizeActivateLocalOwnerPepperKeyCommand(
  value: ActivateLocalOwnerPepperKeyCommand,
): Readonly<ActivateLocalOwnerPepperKeyCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerPepperValueError('command is invalid');
  }
  exactKeys(value, [
    'activatedAtMs',
    'expectedGeneration',
    ...(value.expectedActivePepperKeyId === undefined
      ? []
      : ['expectedActivePepperKeyId']),
    'mutationId',
    'pepperKeyId',
  ]);
  assertMutationId(value.mutationId);
  try {
    assertApiCredentialPepperKeyId(value.pepperKeyId);
    if (value.expectedActivePepperKeyId !== undefined) {
      assertApiCredentialPepperKeyId(value.expectedActivePepperKeyId);
    }
  } catch {
    throw new InvalidLocalOwnerPepperValueError(
      'pepper key identity is invalid',
    );
  }
  assertInteger(value.expectedGeneration, 'expectedGeneration', 0);
  assertInteger(
    value.activatedAtMs,
    'activatedAtMs',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  return Object.freeze({ ...value });
}

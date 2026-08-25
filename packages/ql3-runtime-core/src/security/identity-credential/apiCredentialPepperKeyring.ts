import { assertApiCredentialPepperKeyId } from './apiCredential';
import { assertApiCredentialPepper } from './apiCredentialToken';

export const MAX_API_CREDENTIAL_PEPPER_KEYS = 2;

export interface ApiCredentialPepperKey {
  readonly pepperKeyId: string;
  readonly pepper: string;
}

export interface ApiCredentialPepperKeyring {
  readonly schemaVersion: 1;
  readonly activePepperKeyId: string;
  readonly keys: readonly Readonly<ApiCredentialPepperKey>[];
}

export class ApiCredentialPepperKeyringConfigurationError extends TypeError {
  constructor(message: string) {
    super(`API credential pepper keyring is invalid: ${message}`);
    this.name = 'ApiCredentialPepperKeyringConfigurationError';
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiCredentialPepperKeyringConfigurationError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ApiCredentialPepperKeyringConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

function normalizeKey(value: unknown): Readonly<ApiCredentialPepperKey> {
  exactObject(value, ['pepper', 'pepperKeyId'], 'key');
  try {
    assertApiCredentialPepperKeyId(value.pepperKeyId as string);
    assertApiCredentialPepper(value.pepper as string);
  } catch {
    throw new ApiCredentialPepperKeyringConfigurationError(
      'key material is invalid',
    );
  }
  return Object.freeze({
    pepperKeyId: value.pepperKeyId as string,
    pepper: value.pepper as string,
  });
}

export function normalizeApiCredentialPepperKeyring(
  value: unknown,
): Readonly<ApiCredentialPepperKeyring> {
  exactObject(
    value,
    ['activePepperKeyId', 'keys', 'schemaVersion'],
    'keyring',
  );
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.keys) ||
    value.keys.length < 1 ||
    value.keys.length > MAX_API_CREDENTIAL_PEPPER_KEYS
  ) {
    throw new ApiCredentialPepperKeyringConfigurationError(
      'version or key count is invalid',
    );
  }
  let activePepperKeyId: string;
  try {
    assertApiCredentialPepperKeyId(value.activePepperKeyId as string);
    activePepperKeyId = value.activePepperKeyId as string;
  } catch {
    throw new ApiCredentialPepperKeyringConfigurationError(
      'activePepperKeyId is invalid',
    );
  }
  const keys = value.keys.map(normalizeKey);
  const keyIds = new Set(keys.map((key) => key.pepperKeyId));
  if (keyIds.size !== keys.length || !keyIds.has(activePepperKeyId)) {
    throw new ApiCredentialPepperKeyringConfigurationError(
      'keys must be unique and contain the active key',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    activePepperKeyId,
    keys: Object.freeze(keys),
  });
}

export function createSingletonApiCredentialPepperKeyring(
  pepper: string,
  pepperKeyId: string,
): Readonly<ApiCredentialPepperKeyring> {
  return normalizeApiCredentialPepperKeyring({
    schemaVersion: 1,
    activePepperKeyId: pepperKeyId,
    keys: [{ pepperKeyId, pepper }],
  });
}

export function resolveApiCredentialPepperKey(
  keyring: Readonly<ApiCredentialPepperKeyring>,
  pepperKeyId: string,
): Readonly<ApiCredentialPepperKey> | null {
  const normalized = normalizeApiCredentialPepperKeyring(keyring);
  try {
    assertApiCredentialPepperKeyId(pepperKeyId);
  } catch {
    throw new ApiCredentialPepperKeyringConfigurationError(
      'pepperKeyId is invalid',
    );
  }
  return (
    normalized.keys.find((key) => key.pepperKeyId === pepperKeyId) ?? null
  );
}

export function activeApiCredentialPepperKey(
  keyring: Readonly<ApiCredentialPepperKeyring>,
): Readonly<ApiCredentialPepperKey> {
  const normalized = normalizeApiCredentialPepperKeyring(keyring);
  return resolveApiCredentialPepperKey(
    normalized,
    normalized.activePepperKeyId,
  )!;
}

import { assertApiCredentialPepperKeyId } from './apiCredential';

export const MAX_API_CREDENTIAL_PEPPER_REFERENCES = 64;

export interface ApiCredentialPepperReferenceInspection {
  readonly pepperKeyId: string;
  readonly observedAtMs: number;
  readonly credentialIds: readonly string[];
  readonly hasMore: boolean;
}

export interface ApiCredentialPepperReferenceRepository {
  inspect(
    pepperKeyId: string,
    limit?: number,
  ): Promise<Readonly<ApiCredentialPepperReferenceInspection>>;
}

export class ApiCredentialPepperReferenceUnavailableError extends Error {
  readonly code = 'API_CREDENTIAL_PEPPER_REFERENCE_UNAVAILABLE';

  constructor() {
    super('API credential pepper references are unavailable');
    this.name = 'ApiCredentialPepperReferenceUnavailableError';
  }
}

export function normalizeApiCredentialPepperReferenceLimit(
  value: number | undefined,
): number {
  const resolved = value ?? MAX_API_CREDENTIAL_PEPPER_REFERENCES;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_API_CREDENTIAL_PEPPER_REFERENCES
  ) {
    throw new TypeError('API credential pepper reference limit is invalid');
  }
  return resolved;
}

export function normalizeApiCredentialPepperReferenceKeyId(
  value: string,
): string {
  assertApiCredentialPepperKeyId(value);
  return value;
}

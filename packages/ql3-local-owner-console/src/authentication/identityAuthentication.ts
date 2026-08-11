import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ApiCredentialUnavailableError,
  LEGACY_API_CREDENTIAL_PEPPER_KEY_ID,
  assertApiCredentialPepperKeyId,
  normalizeApiCredentialRecord,
  type ApiCredentialRepository,
} from '@qinglong/runtime-core/api-credential';
import {
  apiCredentialSecretDigest,
  assertApiCredentialPepper,
} from '@qinglong/runtime-core/api-credential-token';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';

const TOKEN_PATTERN =
  /^ql3c_([A-Za-z0-9][A-Za-z0-9._:-]{0,63})_([A-Za-z0-9_-]{43})$/;
const DEFAULT_PRINCIPAL_TTL_MS = 60_000;
const MAX_PRINCIPAL_TTL_MS = 300_000;

export interface LocalIdentityAuthenticator {
  authenticate(token: string): Promise<Readonly<SecurityPrincipal> | null>;
  authenticateCredential(
    token: string,
  ): Promise<Readonly<LocalIdentityAuthentication> | null>;
}

export interface LocalIdentityAuthentication {
  readonly principal: Readonly<SecurityPrincipal>;
  readonly credentialId: string;
  readonly credentialVersion: number;
}

export interface LocalIdentityAuthenticatorOptions {
  readonly principalTtlMs?: number;
  readonly pepperKeyId?: string;
  readonly now?: () => number;
}

export interface LocalIdentityPepperKeyMaterial {
  readonly pepperKeyId: string;
  readonly pepper: string;
}

export interface LocalIdentityPepperKeyProvider {
  resolve(
    pepperKeyId: string,
  ):
    | Readonly<LocalIdentityPepperKeyMaterial>
    | null
    | Promise<Readonly<LocalIdentityPepperKeyMaterial> | null>;
}

export interface LocalIdentityKeyringAuthenticatorOptions {
  readonly principalTtlMs?: number;
  readonly now?: () => number;
}

export class LocalIdentityAuthenticationConfigurationError extends TypeError {
  constructor(message: string) {
    super(`Local identity authentication configuration is invalid: ${message}`);
    this.name = 'LocalIdentityAuthenticationConfigurationError';
  }
}

export class LocalIdentityAuthenticationUnavailableError extends Error {
  readonly code = 'LOCAL_IDENTITY_AUTHENTICATION_UNAVAILABLE';

  constructor() {
    super('Local identity authentication is unavailable');
    this.name = 'LocalIdentityAuthenticationUnavailableError';
  }
}

function ttl(value: number | undefined): number {
  const resolved = value ?? DEFAULT_PRINCIPAL_TTL_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1_000 ||
    resolved > MAX_PRINCIPAL_TTL_MS
  ) {
    throw new LocalIdentityAuthenticationConfigurationError(
      'principalTtlMs is invalid',
    );
  }
  return resolved;
}

export function createLocalIdentityAuthenticator(
  repository: ApiCredentialRepository,
  pepper: string,
  options: LocalIdentityAuthenticatorOptions = {},
): LocalIdentityAuthenticator {
  if (!repository || typeof repository.resolve !== 'function') {
    throw new LocalIdentityAuthenticationConfigurationError(
      'repository is invalid',
    );
  }
  try {
    assertApiCredentialPepper(pepper);
  } catch {
    throw new LocalIdentityAuthenticationConfigurationError(
      'pepper is invalid',
    );
  }
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'principalTtlMs' && key !== 'pepperKeyId' && key !== 'now',
    ) ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new LocalIdentityAuthenticationConfigurationError(
      'options are invalid',
    );
  }
  const pepperKeyId =
    options.pepperKeyId ?? LEGACY_API_CREDENTIAL_PEPPER_KEY_ID;
  try {
    assertApiCredentialPepperKeyId(pepperKeyId);
  } catch {
    throw new LocalIdentityAuthenticationConfigurationError(
      'pepperKeyId is invalid',
    );
  }
  const principalTtlMs = ttl(options.principalTtlMs);
  const now = options.now ?? Date.now;

  return createResolvedLocalIdentityAuthenticator(
    repository,
    async (credentialPepperKeyId) => {
      if (credentialPepperKeyId !== pepperKeyId) {
        throw new LocalIdentityAuthenticationUnavailableError();
      }
      return pepper;
    },
    principalTtlMs,
    now,
  );
}

export function createLocalIdentityKeyringAuthenticator(
  repository: ApiCredentialRepository,
  pepperRepository: Pick<LocalOwnerPepperRepository, 'resolveKey'>,
  pepperProvider: LocalIdentityPepperKeyProvider,
  options: LocalIdentityKeyringAuthenticatorOptions = {},
): LocalIdentityAuthenticator {
  if (!repository || typeof repository.resolve !== 'function') {
    throw new LocalIdentityAuthenticationConfigurationError(
      'repository is invalid',
    );
  }
  if (!pepperRepository || typeof pepperRepository.resolveKey !== 'function') {
    throw new LocalIdentityAuthenticationConfigurationError(
      'pepperRepository is invalid',
    );
  }
  if (!pepperProvider || typeof pepperProvider.resolve !== 'function') {
    throw new LocalIdentityAuthenticationConfigurationError(
      'pepperProvider is invalid',
    );
  }
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) => key !== 'principalTtlMs' && key !== 'now',
    ) ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new LocalIdentityAuthenticationConfigurationError(
      'options are invalid',
    );
  }
  const principalTtlMs = ttl(options.principalTtlMs);
  const now = options.now ?? Date.now;

  return createResolvedLocalIdentityAuthenticator(
    repository,
    async (pepperKeyId) => {
      let key;
      try {
        key = await pepperRepository.resolveKey(pepperKeyId);
      } catch {
        throw new LocalIdentityAuthenticationUnavailableError();
      }
      if (
        !key ||
        (key.state !== 'active' && key.state !== 'retired') ||
        !key.materialDigest
      ) {
        throw new LocalIdentityAuthenticationUnavailableError();
      }
      let material;
      try {
        material = await pepperProvider.resolve(pepperKeyId);
      } catch {
        throw new LocalIdentityAuthenticationUnavailableError();
      }
      if (!material || material.pepperKeyId !== pepperKeyId) {
        throw new LocalIdentityAuthenticationUnavailableError();
      }
      try {
        assertApiCredentialPepper(material.pepper);
      } catch {
        throw new LocalIdentityAuthenticationUnavailableError();
      }
      const materialDigest = createHash('sha256')
        .update('qinglong.local-owner-pepper.summary.v1\0', 'utf8')
        .update(material.pepper, 'utf8')
        .digest('hex');
      if (materialDigest !== key.materialDigest) {
        throw new LocalIdentityAuthenticationUnavailableError();
      }
      return material.pepper;
    },
    principalTtlMs,
    now,
  );
}

function createResolvedLocalIdentityAuthenticator(
  repository: ApiCredentialRepository,
  resolvePepper: (pepperKeyId: string) => Promise<string>,
  principalTtlMs: number,
  now: () => number,
): LocalIdentityAuthenticator {
  const authenticateCredential = async (
    token: string,
  ): Promise<Readonly<LocalIdentityAuthentication> | null> => {
    if (typeof token !== 'string' || token.length > 256) return null;
    const match = TOKEN_PATTERN.exec(token);
    if (!match) return null;
    const credentialId = match[1]!;
    const secret = match[2]!;
    let candidate;
    try {
      candidate = await repository.resolve(credentialId);
    } catch (error) {
      if (error instanceof ApiCredentialUnavailableError) {
        throw new LocalIdentityAuthenticationUnavailableError();
      }
      throw new LocalIdentityAuthenticationUnavailableError();
    }
    if (!candidate) return null;
    let credential;
    try {
      credential = normalizeApiCredentialRecord(candidate);
    } catch {
      throw new LocalIdentityAuthenticationUnavailableError();
    }
    let pepper: string;
    try {
      pepper = await resolvePepper(credential.pepperKeyId);
    } catch {
      throw new LocalIdentityAuthenticationUnavailableError();
    }
    let presented: Buffer | undefined;
    let stored: Buffer | undefined;
    try {
      presented = Buffer.from(
        apiCredentialSecretDigest(pepper, credentialId, secret),
        'hex',
      );
      stored = Buffer.from(credential.secretDigest, 'hex');
      if (
        presented.byteLength !== 32 ||
        stored.byteLength !== 32 ||
        !timingSafeEqual(presented, stored)
      ) {
        return null;
      }
    } catch {
      return null;
    } finally {
      presented?.fill(0);
      stored?.fill(0);
    }
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new LocalIdentityAuthenticationUnavailableError();
    }
    if (
      credential.state !== 'active' ||
      credential.subjectStatus !== 'active' ||
      credential.notBeforeAtMs > nowMs ||
      credential.expiresAtMs <= nowMs
    ) {
      return null;
    }
    try {
      const principal = normalizeSecurityPrincipal(
        {
          subject: credential.subject,
          authenticationId: `local_credential:${credential.credentialId}:${credential.version}`,
          authenticatedAtMs: nowMs,
          expiresAtMs: Math.min(credential.expiresAtMs, nowMs + principalTtlMs),
          assurance:
            credential.subject.type === 'user' ? 'single_factor' : 'service',
        },
        nowMs,
      );
      return Object.freeze({
        principal,
        credentialId: credential.credentialId,
        credentialVersion: credential.version,
      });
    } catch {
      throw new LocalIdentityAuthenticationUnavailableError();
    }
  };

  return Object.freeze({
    async authenticate(token: string) {
      return (await authenticateCredential(token))?.principal ?? null;
    },
    authenticateCredential,
  });
}

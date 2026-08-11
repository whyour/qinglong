import {
  createLocalIdentityKeyringAuthenticator,
  LocalIdentityAuthenticationUnavailableError,
} from '@qinglong/local-owner-console/identity-authentication';
import {
  LocalOwnerPepperKeyringFileProvider,
  type LocalOwnerPepperKeyMaterial,
} from '@qinglong/local-owner-console/pepper-custody';
import {
  normalizeApiCredentialRecord,
  type ApiCredentialRecord,
} from '@qinglong/runtime-core/api-credential';
import type { LocalOwnerPepperKeyRecord } from '@qinglong/runtime-core/local-owner-pepper';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';
import type { LocalApplicationProductSurfaceAuthority } from '@qinglong/local-application';

const AUTHORIZATION_PATTERN =
  /^Bearer (ql3c_[A-Za-z0-9][A-Za-z0-9._:-]{0,63}_[A-Za-z0-9_-]{43})$/;

export interface AuthenticatedLocalApiRequest {
  readonly principal: Readonly<SecurityPrincipal>;
  confirm(): Promise<void>;
}

export interface LocalApiCredentialAuthenticator {
  authenticate(
    authorization: string | null,
  ): Promise<Readonly<AuthenticatedLocalApiRequest> | null>;
}

export interface LocalApiCredentialAuthenticatorOptions {
  readonly now?: () => number;
}

interface CredentialFence {
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly pepperKeyId: string;
  readonly materialDigest: string;
  readonly subjectType: ApiCredentialRecord['subject']['type'];
  readonly subjectId: string;
  readonly secretDigest: string;
  readonly notBeforeAtMs: number;
  readonly expiresAtMs: number;
}

export class LocalApiCredentialAuthenticationConfigurationError extends TypeError {
  readonly code = 'QL3_LOCAL_API_AUTHENTICATION_CONFIG_INVALID';

  constructor(message: string) {
    super(`Local API credential authentication is invalid: ${message}`);
    this.name = 'LocalApiCredentialAuthenticationConfigurationError';
  }
}

export class LocalApiCredentialAuthenticationUnavailableError extends Error {
  readonly code = 'QL3_LOCAL_API_AUTHENTICATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Local API credential authentication is unavailable', options);
    this.name = 'LocalApiCredentialAuthenticationUnavailableError';
  }
}

function validKey(
  value: Readonly<LocalOwnerPepperKeyRecord> | null,
): value is Readonly<LocalOwnerPepperKeyRecord> & {
  readonly materialDigest: string;
} {
  return Boolean(
    value &&
      (value.state === 'active' || value.state === 'retired') &&
      value.materialDigest,
  );
}

function validMaterial(
  value: Readonly<LocalOwnerPepperKeyMaterial> | null,
  pepperKeyId: string,
  materialDigest: string,
): value is Readonly<LocalOwnerPepperKeyMaterial> {
  return Boolean(
    value &&
      value.pepperKeyId === pepperKeyId &&
      value.summary.digest === materialDigest,
  );
}

async function loadFence(
  authority: Readonly<LocalApplicationProductSurfaceAuthority>,
  provider: LocalOwnerPepperKeyringFileProvider,
  credentialId: string,
  credentialVersion: number,
): Promise<Readonly<CredentialFence>> {
  try {
    const candidate = await authority.apiCredentials.resolve(credentialId);
    if (!candidate) throw new Error('credential is unavailable');
    const credential = normalizeApiCredentialRecord(candidate);
    const key = await authority.ownerPepper.resolveKey(credential.pepperKeyId);
    const material = provider.resolve(credential.pepperKeyId);
    if (
      credential.version !== credentialVersion ||
      credential.state !== 'active' ||
      credential.subjectStatus !== 'active' ||
      !validKey(key) ||
      !validMaterial(
        material,
        credential.pepperKeyId,
        key.materialDigest,
      )
    ) {
      throw new Error('credential fence is unavailable');
    }
    return Object.freeze({
      credentialId: credential.credentialId,
      credentialVersion: credential.version,
      pepperKeyId: credential.pepperKeyId,
      materialDigest: key.materialDigest,
      subjectType: credential.subject.type,
      subjectId: credential.subject.id,
      secretDigest: credential.secretDigest,
      notBeforeAtMs: credential.notBeforeAtMs,
      expiresAtMs: credential.expiresAtMs,
    });
  } catch (error) {
    throw new LocalApiCredentialAuthenticationUnavailableError({
      cause: error,
    });
  }
}

function sameFence(left: CredentialFence, right: CredentialFence): boolean {
  return (
    left.credentialId === right.credentialId &&
    left.credentialVersion === right.credentialVersion &&
    left.pepperKeyId === right.pepperKeyId &&
    left.materialDigest === right.materialDigest &&
    left.subjectType === right.subjectType &&
    left.subjectId === right.subjectId &&
    left.secretDigest === right.secretDigest &&
    left.notBeforeAtMs === right.notBeforeAtMs &&
    left.expiresAtMs === right.expiresAtMs
  );
}

export function createLocalApiCredentialAuthenticator(
  authority: Readonly<LocalApplicationProductSurfaceAuthority>,
  provider: LocalOwnerPepperKeyringFileProvider,
  options: LocalApiCredentialAuthenticatorOptions = {},
): Readonly<LocalApiCredentialAuthenticator> {
  if (
    !authority ||
    typeof authority !== 'object' ||
    Array.isArray(authority) ||
    typeof authority.apiCredentials?.resolve !== 'function' ||
    typeof authority.ownerPepper?.resolveKey !== 'function' ||
    !provider ||
    typeof provider.resolve !== 'function' ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'now') ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new LocalApiCredentialAuthenticationConfigurationError(
      'authority, provider or options are invalid',
    );
  }
  const identity = createLocalIdentityKeyringAuthenticator(
    authority.apiCredentials,
    authority.ownerPepper,
    provider,
    {
      principalTtlMs: 60_000,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );

  return Object.freeze({
    async authenticate(authorization: string | null) {
      if (typeof authorization !== 'string' || authorization.length > 320) {
        return null;
      }
      const match = AUTHORIZATION_PATTERN.exec(authorization);
      if (!match) return null;
      const token = match[1]!;
      try {
        const authentication = await identity.authenticateCredential(token);
        if (!authentication) return null;
        const fence = await loadFence(
          authority,
          provider,
          authentication.credentialId,
          authentication.credentialVersion,
        );
        if (
          authentication.principal.subject.type !== fence.subjectType ||
          authentication.principal.subject.id !== fence.subjectId
        ) {
          throw new LocalApiCredentialAuthenticationUnavailableError();
        }
        return Object.freeze({
          principal: authentication.principal,
          async confirm() {
            try {
              const currentAuthentication =
                await identity.authenticateCredential(token);
              if (
                !currentAuthentication ||
                currentAuthentication.credentialId !== fence.credentialId ||
                currentAuthentication.credentialVersion !==
                  fence.credentialVersion ||
                currentAuthentication.principal.subject.type !==
                  fence.subjectType ||
                currentAuthentication.principal.subject.id !== fence.subjectId
              ) {
                throw new Error('credential authentication changed');
              }
              const currentFence = await loadFence(
                authority,
                provider,
                fence.credentialId,
                fence.credentialVersion,
              );
              if (!sameFence(fence, currentFence)) {
                throw new Error('credential authority changed');
              }
            } catch (error) {
              if (
                error instanceof LocalApiCredentialAuthenticationUnavailableError
              ) {
                throw error;
              }
              throw new LocalApiCredentialAuthenticationUnavailableError({
                cause: error,
              });
            }
          },
        });
      } catch (error) {
        if (
          error instanceof LocalApiCredentialAuthenticationUnavailableError
        ) {
          throw error;
        }
        if (error instanceof LocalIdentityAuthenticationUnavailableError) {
          throw new LocalApiCredentialAuthenticationUnavailableError({
            cause: error,
          });
        }
        throw new LocalApiCredentialAuthenticationUnavailableError({
          cause: error,
        });
      }
    },
  });
}

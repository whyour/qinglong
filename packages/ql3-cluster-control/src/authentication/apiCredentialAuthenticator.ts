// Authentication owns credential verification and bounded Principal issuance.
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ApiCredentialUnavailableError,
  LEGACY_API_CREDENTIAL_PEPPER_KEY_ID,
  assertApiCredentialPepperKeyId,
  normalizeApiCredentialRecord,
  type ApiCredentialRepository,
} from '@qinglong/runtime-core/api-credential';
import {
  activeApiCredentialPepperKey,
  createSingletonApiCredentialPepperKeyring,
  normalizeApiCredentialPepperKeyring,
  resolveApiCredentialPepperKey,
  type ApiCredentialPepperKeyring,
} from '@qinglong/runtime-core/api-credential-pepper-keyring';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import type { ClusterControlAdmissionMetadata } from '../transport/httpSurface';
import type { ClusterControlRequestAuthenticator } from '../transport/admissionPipeline';

export const CLUSTER_CONTROL_API_CREDENTIAL_LIMITS = Object.freeze({
  principalTtlMs: 60_000,
  maxPrincipalTtlMs: 300_000,
  secretBytes: 32,
});

export class ClusterControlApiCredentialConfigurationError extends TypeError {
  constructor(message: string) {
    super(
      `Cluster-control API credential configuration is invalid: ${message}`,
    );
    this.name = 'ClusterControlApiCredentialConfigurationError';
  }
}

export class ClusterControlApiCredentialUnavailableError extends Error {
  readonly code = 'CLUSTER_CONTROL_API_CREDENTIAL_UNAVAILABLE';

  constructor() {
    super('Cluster-control API credential authentication is unavailable');
    this.name = 'ClusterControlApiCredentialUnavailableError';
  }
}

export interface ClusterControlApiCredentialAuthenticatorOptions {
  readonly principalTtlMs?: number;
  readonly pepperKeyId?: string;
  readonly now?: () => number;
}

const AUTHORIZATION_PATTERN =
  /^Bearer ql3c_([A-Za-z0-9][A-Za-z0-9._:-]{0,63})_([A-Za-z0-9_-]{43})$/;
const PEPPER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_DOMAIN = Buffer.from('qinglong-api-credential-v1\0', 'utf8');

function decodeSecret(name: string, value: string): Buffer {
  if (typeof value !== 'string' || !PEPPER_PATTERN.test(value)) {
    throw new ClusterControlApiCredentialConfigurationError(
      `${name} must be canonical base64url for 32 bytes`,
    );
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength !== CLUSTER_CONTROL_API_CREDENTIAL_LIMITS.secretBytes ||
    decoded.toString('base64url') !== value
  ) {
    throw new ClusterControlApiCredentialConfigurationError(
      `${name} must be canonical base64url for 32 bytes`,
    );
  }
  return decoded;
}

export function assertClusterControlApiCredentialPepper(value: string): void {
  const decoded = decodeSecret('pepper', value);
  decoded.fill(0);
}

function principalTtl(value: number | undefined): number {
  const resolved =
    value ?? CLUSTER_CONTROL_API_CREDENTIAL_LIMITS.principalTtlMs;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1_000 ||
    resolved > CLUSTER_CONTROL_API_CREDENTIAL_LIMITS.maxPrincipalTtlMs
  ) {
    throw new ClusterControlApiCredentialConfigurationError(
      'principalTtlMs is invalid',
    );
  }
  return resolved;
}

function digest(pepper: Buffer, credentialId: string, secret: Buffer): Buffer {
  return createHmac('sha256', pepper)
    .update(DIGEST_DOMAIN)
    .update(credentialId, 'utf8')
    .update('\0', 'utf8')
    .update(secret)
    .digest();
}

export function apiCredentialSecretDigest(
  pepperBase64Url: string,
  credentialId: string,
  secretBase64Url: string,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(credentialId)) {
    throw new ClusterControlApiCredentialConfigurationError(
      'credentialId is invalid',
    );
  }
  const pepper = decodeSecret('pepper', pepperBase64Url);
  const secret = decodeSecret('secret', secretBase64Url);
  let result: Buffer | undefined;
  try {
    result = digest(pepper, credentialId, secret);
    return result.toString('hex');
  } finally {
    result?.fill(0);
    pepper.fill(0);
    secret.fill(0);
  }
}

function parseAuthorization(
  metadata: ClusterControlAdmissionMetadata,
): { readonly credentialId: string; readonly secret: Buffer } | null {
  const value = metadata.headers.authorization;
  if (typeof value !== 'string') return null;
  const match = AUTHORIZATION_PATTERN.exec(value);
  if (!match) return null;
  let secret: Buffer;
  try {
    secret = decodeSecret('bearer secret', match[2]!);
  } catch {
    return null;
  }
  return Object.freeze({ credentialId: match[1]!, secret });
}

export function createClusterControlApiCredentialAuthenticator(
  repository: ApiCredentialRepository,
  pepperKeyringValue: Readonly<ApiCredentialPepperKeyring> | string,
  options: ClusterControlApiCredentialAuthenticatorOptions = {},
): ClusterControlRequestAuthenticator {
  if (!repository || typeof repository.resolve !== 'function') {
    throw new ClusterControlApiCredentialConfigurationError(
      'repository is invalid',
    );
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new ClusterControlApiCredentialConfigurationError(
      'options are invalid',
    );
  }
  const keys = Object.keys(options);
  if (
    keys.some(
      (key) =>
        key !== 'principalTtlMs' && key !== 'pepperKeyId' && key !== 'now',
    )
  ) {
    throw new ClusterControlApiCredentialConfigurationError(
      'options shape is invalid',
    );
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new ClusterControlApiCredentialConfigurationError('now is invalid');
  }
  let pepperKeyring: Readonly<ApiCredentialPepperKeyring>;
  try {
    if (typeof pepperKeyringValue === 'string') {
      const pepperKeyId =
        options.pepperKeyId ?? LEGACY_API_CREDENTIAL_PEPPER_KEY_ID;
      assertApiCredentialPepperKeyId(pepperKeyId);
      pepperKeyring = createSingletonApiCredentialPepperKeyring(
        pepperKeyringValue,
        pepperKeyId,
      );
    } else {
      if (options.pepperKeyId !== undefined) throw new TypeError();
      pepperKeyring = normalizeApiCredentialPepperKeyring(pepperKeyringValue);
    }
  } catch {
    throw new ClusterControlApiCredentialConfigurationError(
      'pepper keyring is invalid',
    );
  }
  const ttlMs = principalTtl(options.principalTtlMs);
  const now = options.now ?? Date.now;

  return Object.freeze({
    async authenticate(
      metadata: ClusterControlAdmissionMetadata,
    ): Promise<Readonly<SecurityPrincipal> | null> {
      const parsed = parseAuthorization(metadata);
      if (!parsed) return null;
      let candidate;
      try {
        candidate = await repository.resolve(parsed.credentialId);
      } catch (error) {
        parsed.secret.fill(0);
        if (error instanceof ApiCredentialUnavailableError) {
          throw new ClusterControlApiCredentialUnavailableError();
        }
        throw new ClusterControlApiCredentialUnavailableError();
      }
      if (metadata.signal.aborted) {
        parsed.secret.fill(0);
        throw new ClusterControlApiCredentialUnavailableError();
      }
      let record;
      try {
        record = candidate ? normalizeApiCredentialRecord(candidate) : null;
      } catch {
        parsed.secret.fill(0);
        throw new ClusterControlApiCredentialUnavailableError();
      }
      const key = record
        ? resolveApiCredentialPepperKey(pepperKeyring, record.pepperKeyId)
        : activeApiCredentialPepperKey(pepperKeyring);
      if (!key) {
        parsed.secret.fill(0);
        throw new ClusterControlApiCredentialUnavailableError();
      }
      const pepper = decodeSecret('pepper', key.pepper);
      const presentedDigest = digest(
        pepper,
        parsed.credentialId,
        parsed.secret,
      );
      pepper.fill(0);
      parsed.secret.fill(0);
      const storedDigest = record
        ? Buffer.from(record.secretDigest, 'hex')
        : Buffer.alloc(32);
      const matches = timingSafeEqual(presentedDigest, storedDigest);
      presentedDigest.fill(0);
      storedDigest.fill(0);
      if (!record || !matches) return null;
      const nowMs = now();
      if (
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0 ||
        record.state !== 'active' ||
        record.subjectStatus !== 'active' ||
        record.notBeforeAtMs > nowMs ||
        record.expiresAtMs <= nowMs
      ) {
        return null;
      }
      const expiresAtMs = Math.min(record.expiresAtMs, nowMs + ttlMs);
      try {
        return normalizeSecurityPrincipal(
          {
            subject: record.subject,
            authenticationId: `api_credential:${record.credentialId}:${record.version}`,
            authenticatedAtMs: nowMs,
            expiresAtMs,
            assurance:
              record.subject.type === 'user' ? 'single_factor' : 'service',
          },
          nowMs,
        );
      } catch {
        throw new ClusterControlApiCredentialUnavailableError();
      }
    },
  });
}

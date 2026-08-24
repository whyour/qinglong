/** Shared authenticated identity assertion boundary for cluster management planes. */
import {
  constants,
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

import {
  normalizeSecurityPrincipal,
  type SecurityAuthenticationAssurance,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';

const ASSERTION_ALGORITHMS = ['EdDSA', 'ES256', 'RS256'] as const;
const MAX_KEYS = 8;
const MAX_ASSURANCE_MAPPINGS = 8;
const MAX_AMR_VALUES = 8;
const MIN_ASSERTION_BYTES = 512;
const MAX_ASSERTION_BYTES = 16 * 1024;
const DEFAULT_ASSERTION_BYTES = 8 * 1024;
const MIN_LIFETIME_MS = 30_000;
const MAX_LIFETIME_MS = 15 * 60_000;
const DEFAULT_LIFETIME_MS = 5 * 60_000;
const MAX_AUTHENTICATION_AGE_MS = 15 * 60_000;
const DEFAULT_AUTHENTICATION_AGE_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 60_000;
const DEFAULT_CLOCK_SKEW_MS = 5_000;
const TOKEN_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSERTION_TYPE_PATTERN = /^ql3-[a-z0-9]+(?:-[a-z0-9]+)*\+jwt$/;
const ASSERTION_PURPOSE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

type AssertionAlgorithm = (typeof ASSERTION_ALGORITHMS)[number];
type AssertionAssurance = Extract<
  SecurityAuthenticationAssurance,
  'multi_factor' | 'hardware'
>;

export interface ClusterPluginPackageIdentityAssertionAssuranceMapping {
  readonly acr: string;
  readonly assurance: AssertionAssurance;
  readonly requiredAmr: readonly string[];
}

export interface ClusterManagementIdentityAssertionProfile {
  readonly type: string;
  readonly purpose: string;
}

export const CLUSTER_PLUGIN_PACKAGE_MANAGEMENT_IDENTITY_ASSERTION_PROFILE =
  Object.freeze({
    type: 'ql3-plugin-package-management+jwt',
    purpose: 'plugin-package-management',
  });

export const CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_IDENTITY_ASSERTION_PROFILE =
  Object.freeze({
    type: 'ql3-worker-credential-management+jwt',
    purpose: 'worker-credential-management',
  });

export const CLUSTER_AUTOMATION_MANAGEMENT_IDENTITY_ASSERTION_PROFILE =
  Object.freeze({
    type: 'ql3-automation-management+jwt',
    purpose: 'automation-management',
  });

export const CLUSTER_APPROVAL_MANAGEMENT_IDENTITY_ASSERTION_PROFILE =
  Object.freeze({
    type: 'ql3-approval-management+jwt',
    purpose: 'approval-management',
  });

export const CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_ASSERTION_PROFILE =
  Object.freeze({
    type: 'ql3-model-provider-credential-management+jwt',
    purpose: 'model-provider-credential-management',
  });

export const CLUSTER_RUN_MANAGEMENT_IDENTITY_ASSERTION_PROFILE = Object.freeze({
  type: 'ql3-run-management+jwt',
  purpose: 'run-management',
});

export const CLUSTER_SECURITY_ADMINISTRATION_IDENTITY_ASSERTION_PROFILE =
  Object.freeze({
    type: 'ql3-security-administration+jwt',
    purpose: 'security-administration',
  });

export interface ClusterPluginPackageIdentityAssertionVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly keys: readonly Readonly<Record<string, unknown>>[];
  readonly assuranceMappings: readonly ClusterPluginPackageIdentityAssertionAssuranceMapping[];
  readonly assertionProfile?: Readonly<ClusterManagementIdentityAssertionProfile>;
  readonly maxAssertionBytes?: number;
  readonly maxLifetimeMs?: number;
  readonly maxAuthenticationAgeMs?: number;
  readonly clockSkewMs?: number;
  readonly now?: () => number;
}

export interface ClusterPluginPackageIdentityAssertionAuthentication {
  authenticate(): Promise<Readonly<SecurityPrincipal>>;
}

export interface ClusterPluginPackageIdentityAssertionVerifier {
  verify(assertion: unknown): Readonly<SecurityPrincipal>;
  bind(
    assertion: unknown,
  ): Readonly<ClusterPluginPackageIdentityAssertionAuthentication>;
}

export class ClusterPluginPackageIdentityAssertionConfigurationError extends TypeError {
  readonly code =
    'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(
      `Cluster Plugin Package identity assertion configuration is invalid: ${message}`,
    );
    this.name = 'ClusterPluginPackageIdentityAssertionConfigurationError';
  }
}

export class ClusterPluginPackageIdentityAssertionAuthenticationError extends Error {
  readonly code = 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID';

  constructor() {
    super('Cluster Plugin Package identity assertion is invalid');
    this.name = 'ClusterPluginPackageIdentityAssertionAuthenticationError';
  }
}

interface ReviewedAssertionKey {
  readonly kid: string;
  readonly algorithm: AssertionAlgorithm;
  readonly key: KeyObject;
}

interface ReviewedAssuranceMapping {
  readonly assurance: AssertionAssurance;
  readonly requiredAmr: ReadonlySet<string>;
}

function configurationFailure(
  message: string,
): ClusterPluginPackageIdentityAssertionConfigurationError {
  return new ClusterPluginPackageIdentityAssertionConfigurationError(message);
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationFailure(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw configurationFailure(`${label} shape is invalid`);
  }
}

function reviewedAssertionProfile(
  value: unknown,
): Readonly<ClusterManagementIdentityAssertionProfile> {
  exactObject(value, ['type', 'purpose'], 'assertion profile');
  if (
    typeof value.type !== 'string' ||
    value.type.length > 128 ||
    !ASSERTION_TYPE_PATTERN.test(value.type) ||
    typeof value.purpose !== 'string' ||
    value.purpose.length > 96 ||
    !ASSERTION_PURPOSE_PATTERN.test(value.purpose)
  ) {
    throw configurationFailure('assertion profile is invalid');
  }
  return Object.freeze({ type: value.type, purpose: value.purpose });
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw configurationFailure(`${label} is invalid`);
  }
  return candidate;
}

function reviewedIssuer(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    CONTROL_PATTERN.test(value)
  ) {
    throw configurationFailure('issuer is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationFailure('issuer is invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.toString() !== value
  ) {
    throw configurationFailure('issuer must be one canonical HTTPS URL');
  }
  return value;
}

function reviewedTokenValue(
  value: unknown,
  label: string,
  maximumLength = 128,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumLength ||
    CONTROL_PATTERN.test(value)
  ) {
    throw configurationFailure(`${label} is invalid`);
  }
  return value;
}

function reviewedJwkComponent(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
  label: string,
): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw configurationFailure(`${label} is invalid`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.length < minimumBytes ||
    bytes.length > maximumBytes ||
    bytes.toString('base64url') !== value
  ) {
    throw configurationFailure(`${label} is invalid`);
  }
}

function reviewedJwk(
  value: unknown,
  seenKids: Set<string>,
): Readonly<ReviewedAssertionKey> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationFailure('key must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const algorithm = candidate.alg;
  if (
    typeof algorithm !== 'string' ||
    !ASSERTION_ALGORITHMS.includes(algorithm as AssertionAlgorithm)
  ) {
    throw configurationFailure('key algorithm is invalid');
  }
  const reviewedAlgorithm = algorithm as AssertionAlgorithm;
  const expectedKeys =
    reviewedAlgorithm === 'RS256'
      ? ['alg', 'e', 'kid', 'kty', 'n', 'use']
      : reviewedAlgorithm === 'ES256'
      ? ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']
      : ['alg', 'crv', 'kid', 'kty', 'use', 'x'];
  exactObject(candidate, expectedKeys, 'key');
  const kid = candidate.kid;
  if (
    typeof kid !== 'string' ||
    !TOKEN_VALUE_PATTERN.test(kid) ||
    seenKids.has(kid)
  ) {
    throw configurationFailure('key id is invalid or duplicated');
  }
  if (candidate.use !== 'sig') {
    throw configurationFailure('key use must be sig');
  }
  if (
    (reviewedAlgorithm === 'RS256' && candidate.kty !== 'RSA') ||
    (reviewedAlgorithm === 'ES256' &&
      (candidate.kty !== 'EC' || candidate.crv !== 'P-256')) ||
    (reviewedAlgorithm === 'EdDSA' &&
      (candidate.kty !== 'OKP' || candidate.crv !== 'Ed25519'))
  ) {
    throw configurationFailure('key type does not match its algorithm');
  }
  for (const name of expectedKeys) {
    if (
      ['alg', 'kid', 'kty', 'use', 'crv'].includes(name) ||
      (typeof candidate[name] === 'string' &&
        BASE64URL_PATTERN.test(candidate[name] as string))
    ) {
      continue;
    }
    throw configurationFailure(`key ${name} is invalid`);
  }
  if (reviewedAlgorithm === 'RS256') {
    reviewedJwkComponent(candidate.n, 256, 512, 'RSA modulus');
    reviewedJwkComponent(candidate.e, 3, 4, 'RSA exponent');
  } else if (reviewedAlgorithm === 'ES256') {
    reviewedJwkComponent(candidate.x, 32, 32, 'EC x coordinate');
    reviewedJwkComponent(candidate.y, 32, 32, 'EC y coordinate');
  } else {
    reviewedJwkComponent(candidate.x, 32, 32, 'Ed25519 public key');
  }
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: candidate,
      format: 'jwk',
    });
  } catch {
    throw configurationFailure('key material is invalid');
  }
  if (
    reviewedAlgorithm === 'RS256' &&
    (key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) > 4096 ||
      key.asymmetricKeyDetails?.publicExponent !== 65_537n)
  ) {
    throw configurationFailure('RSA key strength is invalid');
  }
  if (
    reviewedAlgorithm === 'ES256' &&
    (key.asymmetricKeyType !== 'ec' ||
      key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
  ) {
    throw configurationFailure('EC key strength is invalid');
  }
  if (reviewedAlgorithm === 'EdDSA' && key.asymmetricKeyType !== 'ed25519') {
    throw configurationFailure('Ed25519 key is invalid');
  }
  seenKids.add(kid);
  return Object.freeze({ kid, algorithm: reviewedAlgorithm, key });
}

function reviewedKeys(
  value: unknown,
): ReadonlyMap<string, Readonly<ReviewedAssertionKey>> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_KEYS) {
    throw configurationFailure('keys must contain between one and eight keys');
  }
  const seenKids = new Set<string>();
  const keys = new Map<string, Readonly<ReviewedAssertionKey>>();
  for (const candidate of value) {
    const reviewed = reviewedJwk(candidate, seenKids);
    keys.set(reviewed.kid, reviewed);
  }
  return keys;
}

function reviewedAssuranceMappings(
  value: unknown,
): ReadonlyMap<string, Readonly<ReviewedAssuranceMapping>> {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_ASSURANCE_MAPPINGS
  ) {
    throw configurationFailure(
      'assurance mappings must contain between one and eight entries',
    );
  }
  const mappings = new Map<string, Readonly<ReviewedAssuranceMapping>>();
  for (const candidate of value) {
    exactObject(candidate, ['acr', 'assurance', 'requiredAmr'], 'mapping');
    const acr = reviewedTokenValue(candidate.acr, 'mapping acr', 256);
    if (
      mappings.has(acr) ||
      (candidate.assurance !== 'multi_factor' &&
        candidate.assurance !== 'hardware') ||
      !Array.isArray(candidate.requiredAmr) ||
      candidate.requiredAmr.length < 1 ||
      candidate.requiredAmr.length > MAX_AMR_VALUES
    ) {
      throw configurationFailure('assurance mapping is invalid');
    }
    const requiredAmr = new Set<string>();
    for (const entry of candidate.requiredAmr) {
      if (
        typeof entry !== 'string' ||
        !TOKEN_VALUE_PATTERN.test(entry) ||
        requiredAmr.has(entry)
      ) {
        throw configurationFailure('mapping AMR is invalid or duplicated');
      }
      requiredAmr.add(entry);
    }
    mappings.set(
      acr,
      Object.freeze({
        assurance: candidate.assurance,
        requiredAmr,
      }),
    );
  }
  return mappings;
}

function canonicalBase64Url(segment: string, maximumBytes: number): Buffer {
  if (
    segment.length < 1 ||
    segment.length > Math.ceil((maximumBytes * 4) / 3) ||
    !BASE64URL_PATTERN.test(segment)
  ) {
    throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
  }
  const decoded = Buffer.from(segment, 'base64url');
  if (
    decoded.length < 1 ||
    decoded.length > maximumBytes ||
    decoded.toString('base64url') !== segment
  ) {
    throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
  }
  return decoded;
}

function jsonObject(
  segment: string,
  maximumBytes: number,
): Record<string, unknown> {
  const bytes = canonicalBase64Url(segment, maximumBytes);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
  }
  return value as Record<string, unknown>;
}

function assertionExactObject(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
  }
}

function numericDate(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    !Number.isSafeInteger((value as number) * 1_000)
  ) {
    throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
  }
  return (value as number) * 1_000;
}

function assertionTokenValue(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumLength ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
  }
  return value;
}

function verifyReviewedSignature(
  algorithm: AssertionAlgorithm,
  key: KeyObject,
  signed: Buffer,
  signature: Buffer,
): boolean {
  switch (algorithm) {
    case 'EdDSA':
      return (
        signature.length === 64 && verifySignature(null, signed, key, signature)
      );
    case 'ES256':
      return (
        signature.length === 64 &&
        verifySignature(
          'sha256',
          signed,
          { key, dsaEncoding: 'ieee-p1363' },
          signature,
        )
      );
    case 'RS256':
      return verifySignature(
        'RSA-SHA256',
        signed,
        { key, padding: constants.RSA_PKCS1_PADDING },
        signature,
      );
  }
}

function authenticationId(issuer: string, jti: string): string {
  return `ql3oidc.${createHash('sha256')
    .update(issuer)
    .update('\0')
    .update(jti)
    .digest('base64url')}`;
}

export function createClusterPluginPackageIdentityAssertionVerifier(
  options: ClusterPluginPackageIdentityAssertionVerifierOptions,
): Readonly<ClusterPluginPackageIdentityAssertionVerifier> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          'issuer',
          'audience',
          'keys',
          'assuranceMappings',
          'assertionProfile',
          'maxAssertionBytes',
          'maxLifetimeMs',
          'maxAuthenticationAgeMs',
          'clockSkewMs',
          'now',
        ].includes(key),
    )
  ) {
    throw configurationFailure('options shape is invalid');
  }
  const issuer = reviewedIssuer(options.issuer);
  const audience = reviewedTokenValue(options.audience, 'audience', 256);
  const assertionProfile = reviewedAssertionProfile(
    options.assertionProfile ??
      CLUSTER_PLUGIN_PACKAGE_MANAGEMENT_IDENTITY_ASSERTION_PROFILE,
  );
  const keys = reviewedKeys(options.keys);
  const assuranceMappings = reviewedAssuranceMappings(
    options.assuranceMappings,
  );
  const maxAssertionBytes = boundedInteger(
    options.maxAssertionBytes,
    DEFAULT_ASSERTION_BYTES,
    MIN_ASSERTION_BYTES,
    MAX_ASSERTION_BYTES,
    'max assertion bytes',
  );
  const maxLifetimeMs = boundedInteger(
    options.maxLifetimeMs,
    DEFAULT_LIFETIME_MS,
    MIN_LIFETIME_MS,
    MAX_LIFETIME_MS,
    'max lifetime',
  );
  const maxAuthenticationAgeMs = boundedInteger(
    options.maxAuthenticationAgeMs,
    DEFAULT_AUTHENTICATION_AGE_MS,
    MIN_LIFETIME_MS,
    MAX_AUTHENTICATION_AGE_MS,
    'max authentication age',
  );
  const clockSkewMs = boundedInteger(
    options.clockSkewMs,
    DEFAULT_CLOCK_SKEW_MS,
    0,
    MAX_CLOCK_SKEW_MS,
    'clock skew',
  );
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw configurationFailure('clock is invalid');
  }
  const now = options.now ?? Date.now;

  const verify = (assertion: unknown): Readonly<SecurityPrincipal> => {
    try {
      if (
        typeof assertion !== 'string' ||
        Buffer.byteLength(assertion, 'utf8') > maxAssertionBytes ||
        CONTROL_PATTERN.test(assertion)
      ) {
        throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
      }
      const segments = assertion.split('.');
      if (segments.length !== 3) {
        throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
      }
      const [protectedSegment, payloadSegment, signatureSegment] = segments;
      if (
        protectedSegment === undefined ||
        payloadSegment === undefined ||
        signatureSegment === undefined
      ) {
        throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
      }
      const header = jsonObject(protectedSegment, 1_024);
      assertionExactObject(header, ['alg', 'kid', 'typ']);
      if (
        header.typ !== assertionProfile.type ||
        typeof header.kid !== 'string' ||
        typeof header.alg !== 'string'
      ) {
        throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
      }
      const reviewedKey = keys.get(header.kid);
      if (!reviewedKey || reviewedKey.algorithm !== header.alg) {
        throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
      }
      const signature = canonicalBase64Url(signatureSegment, 512);
      const signed = Buffer.from(
        `${protectedSegment}.${payloadSegment}`,
        'ascii',
      );
      if (
        !verifyReviewedSignature(
          reviewedKey.algorithm,
          reviewedKey.key,
          signed,
          signature,
        )
      ) {
        throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
      }

      const claims = jsonObject(payloadSegment, 8 * 1_024);
      const claimKeys = [
        'acr',
        'amr',
        'aud',
        'auth_time',
        'exp',
        'iat',
        'iss',
        'jti',
        'ql3_purpose',
        'sub',
      ];
      if (Object.hasOwn(claims, 'nbf')) claimKeys.push('nbf');
      assertionExactObject(claims, claimKeys);
      if (
        claims.iss !== issuer ||
        claims.aud !== audience ||
        claims.ql3_purpose !== assertionProfile.purpose
      ) {
        throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
      }
      const subjectId = assertionTokenValue(claims.sub, 255);
      const jti = assertionTokenValue(claims.jti, 255);
      const issuedAtMs = numericDate(claims.iat);
      const authenticatedAtMs = numericDate(claims.auth_time);
      const expiresAtMs = numericDate(claims.exp);
      const notBeforeAtMs = Object.hasOwn(claims, 'nbf')
        ? numericDate(claims.nbf)
        : issuedAtMs;
      const observedAtMs = now();
      if (
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 0 ||
        authenticatedAtMs > issuedAtMs ||
        issuedAtMs > observedAtMs + clockSkewMs ||
        authenticatedAtMs > observedAtMs ||
        notBeforeAtMs < issuedAtMs ||
        notBeforeAtMs >= expiresAtMs ||
        observedAtMs + clockSkewMs < notBeforeAtMs ||
        expiresAtMs <= observedAtMs ||
        expiresAtMs - issuedAtMs > maxLifetimeMs ||
        observedAtMs - authenticatedAtMs > maxAuthenticationAgeMs
      ) {
        throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
      }
      const acr = assertionTokenValue(claims.acr, 256);
      const mapping = assuranceMappings.get(acr);
      if (
        !mapping ||
        !Array.isArray(claims.amr) ||
        claims.amr.length < 1 ||
        claims.amr.length > MAX_AMR_VALUES
      ) {
        throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
      }
      const amr = new Set<string>();
      for (const entry of claims.amr) {
        if (
          typeof entry !== 'string' ||
          !TOKEN_VALUE_PATTERN.test(entry) ||
          amr.has(entry)
        ) {
          throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
        }
        amr.add(entry);
      }
      if ([...mapping.requiredAmr].some((entry) => !amr.has(entry))) {
        throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
      }
      return normalizeSecurityPrincipal(
        {
          subject: { type: 'user', id: subjectId },
          authenticationId: authenticationId(issuer, jti),
          authenticatedAtMs,
          expiresAtMs,
          assurance: mapping.assurance,
        },
        observedAtMs,
      );
    } catch (error) {
      if (
        error instanceof
        ClusterPluginPackageIdentityAssertionAuthenticationError
      ) {
        throw error;
      }
      throw new ClusterPluginPackageIdentityAssertionAuthenticationError();
    }
  };

  return Object.freeze({
    verify,
    bind(
      assertion: unknown,
    ): Readonly<ClusterPluginPackageIdentityAssertionAuthentication> {
      return Object.freeze({
        async authenticate(): Promise<Readonly<SecurityPrincipal>> {
          return verify(assertion);
        },
      });
    },
  });
}

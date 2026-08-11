// Cluster Control Worker Ingress boundary; keep fail-closed deployment configuration explicit.
import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type {
  DeploymentProfile,
  OpenPostgresDatabase,
} from '@qinglong/runtime-core';
import {
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  loadPostgresConnectionEnvironment,
  loadPostgresCertificateAuthorityFile,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
} from '@qinglong/cluster-postgres/runtime';
import type {
  ClusterControlHttpSurfaceOptions,
  ClusterControlMutualTlsOptions,
} from '../transport/httpSurface';

export type ClusterWorkerIngressEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface DisabledClusterWorkerIngressConfig {
  readonly enabled: false;
  readonly profile: DeploymentProfile;
}

export interface ClusterWorkerArtifactS3Config {
  readonly bucket: string;
  readonly region: string;
  readonly prefix?: string;
  readonly expectedBucketOwner?: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly encryption:
    | Readonly<{ readonly mode: 's3' }>
    | Readonly<{ readonly mode: 'kms'; readonly keyId: string }>;
}

export interface ClusterWorkerMountedSecretConfig {
  readonly provider: 'mounted-files';
  readonly rootDirectory: string;
}

export interface EnabledClusterWorkerIngressConfig {
  readonly enabled: true;
  readonly profile: 'cluster-control';
  readonly http: Omit<ClusterControlHttpSurfaceOptions, 'mutualTls'>;
  readonly transport: Readonly<{
    readonly privateKeyFile: string;
    readonly certificateFile: string;
    readonly clientCertificateAuthorityFile: string;
    readonly clientCertificateRevocationListFile?: string;
  }>;
  readonly database: Readonly<{
    readonly connection: PostgresConnectionOptions;
    readonly pool: PostgresPoolOptions;
  }>;
  readonly security: Readonly<{
    readonly workerCredentialPepper: string;
  }>;
  readonly artifact: Readonly<ClusterWorkerArtifactS3Config>;
  readonly secret?: Readonly<ClusterWorkerMountedSecretConfig>;
}

export type ClusterWorkerIngressConfig =
  | DisabledClusterWorkerIngressConfig
  | EnabledClusterWorkerIngressConfig;

export class ClusterWorkerIngressConfigError extends TypeError {
  constructor(message: string) {
    super(`Worker ingress configuration is invalid: ${message}`);
    this.name = 'ClusterWorkerIngressConfigError';
  }
}

const PROFILES = new Set<DeploymentProfile>([
  'edge',
  'standalone',
  'cluster-control',
  'worker',
]);
const MAX_TLS_FILE_BYTES = 1024 * 1024;

function booleanValue(
  environment: ClusterWorkerIngressEnvironment,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = environment[name];
  if (value === undefined || value === '') return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ClusterWorkerIngressConfigError(`${name} must be true or false`);
}

function integerValue(
  environment: ClusterWorkerIngressEnvironment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[name];
  if (value === undefined || value === '') return defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new ClusterWorkerIngressConfigError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ClusterWorkerIngressConfigError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function boundedValue(
  environment: ClusterWorkerIngressEnvironment,
  name: string,
  maximumLength: number,
  required = false,
): string | undefined {
  const value = environment[name];
  if (value === undefined || value === '') {
    if (required) {
      throw new ClusterWorkerIngressConfigError(`${name} is required`);
    }
    return undefined;
  }
  if (value.length > maximumLength || /[\0\r\n]/.test(value)) {
    throw new ClusterWorkerIngressConfigError(`${name} is invalid`);
  }
  return value;
}

function deploymentProfile(
  environment: ClusterWorkerIngressEnvironment,
): DeploymentProfile {
  const value = environment.QL_DEPLOYMENT_PROFILE ?? 'standalone';
  if (!PROFILES.has(value as DeploymentProfile)) {
    throw new ClusterWorkerIngressConfigError(
      'QL_DEPLOYMENT_PROFILE is invalid',
    );
  }
  return value as DeploymentProfile;
}

function absoluteFile(
  environment: ClusterWorkerIngressEnvironment,
  name: string,
): string {
  const value = boundedValue(environment, name, 4096, true)!;
  if (!isAbsolute(value)) {
    throw new ClusterWorkerIngressConfigError(`${name} must be absolute`);
  }
  return value;
}

function optionalAbsoluteFile(
  environment: ClusterWorkerIngressEnvironment,
  name: string,
): string | undefined {
  const value = boundedValue(environment, name, 4096);
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) {
    throw new ClusterWorkerIngressConfigError(`${name} must be absolute`);
  }
  return value;
}

function workerCredentialPepper(
  environment: ClusterWorkerIngressEnvironment,
): string {
  const value = boundedValue(
    environment,
    'QL3_WORKER_CREDENTIAL_PEPPER',
    64,
    true,
  )!;
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_CREDENTIAL_PEPPER must be canonical base64url for 32 bytes',
    );
  }
  const decoded = Buffer.from(value, 'base64url');
  const canonical =
    decoded.byteLength === 32 && decoded.toString('base64url') === value;
  decoded.fill(0);
  if (!canonical) {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_CREDENTIAL_PEPPER must be canonical base64url for 32 bytes',
    );
  }
  return value;
}

function databaseConnection(
  environment: ClusterWorkerIngressEnvironment,
): PostgresConnectionOptions {
  let connection: PostgresConnectionOptions;
  try {
    connection = loadPostgresConnectionEnvironment(environment, {
      connectionString: 'QL3_POSTGRES_WORKER_INGRESS_URL',
      host: 'QL3_POSTGRES_WORKER_INGRESS_HOST',
      port: 'QL3_POSTGRES_WORKER_INGRESS_PORT',
      database: 'QL3_POSTGRES_WORKER_INGRESS_DATABASE',
      user: 'QL3_POSTGRES_WORKER_INGRESS_USER',
      password: 'QL3_POSTGRES_WORKER_INGRESS_PASSWORD',
    });
  } catch (error) {
    throw new ClusterWorkerIngressConfigError(
      error instanceof Error
        ? error.message
        : 'PostgreSQL Worker ingress connection is invalid',
    );
  }
  const mode =
    environment.QL3_WORKER_INGRESS_POSTGRES_TLS_MODE ?? 'verify-full';
  if (mode !== 'verify-full' && mode !== 'disable') {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_INGRESS_POSTGRES_TLS_MODE must be verify-full or disable',
    );
  }
  if (
    mode === 'disable' &&
    !booleanValue(
      environment,
      'QL3_WORKER_INGRESS_POSTGRES_ALLOW_INSECURE',
      false,
    )
  ) {
    throw new ClusterWorkerIngressConfigError(
      'disabling PostgreSQL TLS requires QL3_WORKER_INGRESS_POSTGRES_ALLOW_INSECURE=true',
    );
  }
  const servername = boundedValue(
    environment,
    'QL3_WORKER_INGRESS_POSTGRES_TLS_SERVERNAME',
    253,
  );
  if (mode === 'verify-full' && !isPostgresTlsDnsServername(servername)) {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_INGRESS_POSTGRES_TLS_SERVERNAME must be an explicit DNS name for verify-full',
    );
  }
  const certificateAuthorityFile = boundedValue(
    environment,
    'QL3_WORKER_INGRESS_POSTGRES_TLS_CA_FILE',
    4096,
  );
  if (mode === 'disable' && certificateAuthorityFile !== undefined) {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_INGRESS_POSTGRES_TLS_CA_FILE cannot be used when TLS is disabled',
    );
  }
  let certificateAuthority: string | undefined;
  if (certificateAuthorityFile !== undefined) {
    try {
      certificateAuthority = loadPostgresCertificateAuthorityFile(
        certificateAuthorityFile,
      );
    } catch {
      throw new ClusterWorkerIngressConfigError(
        'QL3_WORKER_INGRESS_POSTGRES_TLS_CA_FILE must contain a bounded trusted CA bundle',
      );
    }
  }
  return Object.freeze({
    ...connection,
    tls:
      mode === 'disable'
        ? Object.freeze({ mode: 'disable' as const })
        : Object.freeze({
            mode: 'verify-full' as const,
            ...(certificateAuthority === undefined
              ? {}
              : { ca: certificateAuthority }),
            servername: servername!,
          }),
  });
}

function workerArtifactS3(
  environment: ClusterWorkerIngressEnvironment,
): Readonly<ClusterWorkerArtifactS3Config> {
  const bucket = boundedValue(
    environment,
    'QL3_WORKER_ARTIFACT_S3_BUCKET',
    63,
    true,
  )!;
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes('..') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  ) {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_ARTIFACT_S3_BUCKET is invalid',
    );
  }
  const region = boundedValue(
    environment,
    'QL3_WORKER_ARTIFACT_S3_REGION',
    63,
    true,
  )!;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(region)) {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_ARTIFACT_S3_REGION is invalid',
    );
  }
  const prefix = boundedValue(
    environment,
    'QL3_WORKER_ARTIFACT_S3_PREFIX',
    255,
  );
  if (
    prefix !== undefined &&
    (
      !/^[A-Za-z0-9][A-Za-z0-9/_=-]{0,254}$/.test(prefix) ||
      prefix.startsWith('/') ||
      prefix.endsWith('/') ||
      prefix.includes('//') ||
      prefix.split('/').some((segment) => segment === '.' || segment === '..')
    )
  ) {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_ARTIFACT_S3_PREFIX is invalid',
    );
  }
  const expectedBucketOwner = boundedValue(
    environment,
    'QL3_WORKER_ARTIFACT_S3_EXPECTED_BUCKET_OWNER',
    12,
  );
  if (
    expectedBucketOwner !== undefined &&
    !/^\d{12}$/.test(expectedBucketOwner)
  ) {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_ARTIFACT_S3_EXPECTED_BUCKET_OWNER must be 12 digits',
    );
  }
  const endpointValue = boundedValue(
    environment,
    'QL3_WORKER_ARTIFACT_S3_ENDPOINT',
    2048,
  );
  let endpoint: string | undefined;
  if (endpointValue !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(endpointValue);
    } catch {
      throw new ClusterWorkerIngressConfigError(
        'QL3_WORKER_ARTIFACT_S3_ENDPOINT is invalid',
      );
    }
    const allowInsecure = booleanValue(
      environment,
      'QL3_WORKER_ARTIFACT_S3_ALLOW_INSECURE',
      false,
    );
    if (
      (parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && allowInsecure)) ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.pathname !== '/'
    ) {
      throw new ClusterWorkerIngressConfigError(
        'QL3_WORKER_ARTIFACT_S3_ENDPOINT must be an origin URL; HTTP requires explicit insecure opt-in',
      );
    }
    endpoint = parsed.origin;
  }
  const encryptionMode =
    boundedValue(
      environment,
      'QL3_WORKER_ARTIFACT_S3_ENCRYPTION',
      3,
    ) ?? 's3';
  if (encryptionMode !== 's3' && encryptionMode !== 'kms') {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_ARTIFACT_S3_ENCRYPTION must be s3 or kms',
    );
  }
  const keyId = boundedValue(
    environment,
    'QL3_WORKER_ARTIFACT_S3_KMS_KEY_ID',
    2048,
  );
  if (
    (encryptionMode === 'kms' && keyId === undefined) ||
    (encryptionMode === 's3' && keyId !== undefined)
  ) {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_ARTIFACT_S3_KMS_KEY_ID must be present exactly for kms encryption',
    );
  }
  return Object.freeze({
    bucket,
    region,
    ...(prefix === undefined ? {} : { prefix }),
    ...(expectedBucketOwner === undefined
      ? {}
      : { expectedBucketOwner }),
    ...(endpoint === undefined ? {} : { endpoint }),
    forcePathStyle: booleanValue(
      environment,
      'QL3_WORKER_ARTIFACT_S3_FORCE_PATH_STYLE',
      false,
    ),
    encryption:
      encryptionMode === 's3'
        ? Object.freeze({ mode: 's3' as const })
        : Object.freeze({ mode: 'kms' as const, keyId: keyId! }),
  });
}

function workerSecret(
  environment: ClusterWorkerIngressEnvironment,
): Readonly<ClusterWorkerMountedSecretConfig> | undefined {
  const provider = boundedValue(
    environment,
    'QL3_WORKER_SECRET_PROVIDER',
    32,
  );
  if (provider === undefined || provider === 'disabled') return undefined;
  if (provider !== 'mounted-files') {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_SECRET_PROVIDER must be disabled or mounted-files',
    );
  }
  return Object.freeze({
    provider,
    rootDirectory: absoluteFile(
      environment,
      'QL3_WORKER_SECRET_ROOT_DIRECTORY',
    ),
  });
}

/**
 * Applies the Profile gate before reading database, Worker secret or TLS file
 * configuration. Disabled edge/standalone installs therefore remain free of
 * Worker ingress credential and filesystem requirements.
 */
export function loadClusterWorkerIngressConfig(
  environment: ClusterWorkerIngressEnvironment,
): ClusterWorkerIngressConfig {
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment)
  ) {
    throw new ClusterWorkerIngressConfigError('environment must be an object');
  }
  const profile = deploymentProfile(environment);
  const enabled = booleanValue(
    environment,
    'QL3_WORKER_INGRESS_ENABLED',
    false,
  );
  if (!enabled) return Object.freeze({ enabled: false, profile });
  if (profile !== 'cluster-control') {
    throw new ClusterWorkerIngressConfigError(
      'enabled ingress requires QL_DEPLOYMENT_PROFILE=cluster-control',
    );
  }

  const applicationName =
    boundedValue(
      environment,
      'QL3_WORKER_INGRESS_POSTGRES_APPLICATION_NAME',
      63,
    ) ?? 'qinglong-worker-ingress';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/.test(applicationName)) {
    throw new ClusterWorkerIngressConfigError(
      'QL3_WORKER_INGRESS_POSTGRES_APPLICATION_NAME is invalid',
    );
  }
  const host =
    boundedValue(environment, 'QL3_WORKER_INGRESS_HOST', 253) ?? '0.0.0.0';
  const secret = workerSecret(environment);

  return Object.freeze({
    enabled: true,
    profile: 'cluster-control',
    http: Object.freeze({
      host,
      port: integerValue(
        environment,
        'QL3_WORKER_INGRESS_PORT',
        5801,
        1,
        65_535,
      ),
      maxBodyBytes: integerValue(
        environment,
        'QL3_WORKER_INGRESS_MAX_BODY_BYTES',
        64 * 1024,
        1024,
        64 * 1024,
      ),
      maxResponseBytes: integerValue(
        environment,
        'QL3_WORKER_INGRESS_MAX_RESPONSE_BYTES',
        64 * 1024,
        1024,
        64 * 1024,
      ),
      maxInFlightRequests: integerValue(
        environment,
        'QL3_WORKER_INGRESS_MAX_IN_FLIGHT',
        64,
        1,
        256,
      ),
      authenticationRateWindowMs: integerValue(
        environment,
        'QL3_WORKER_INGRESS_AUTH_RATE_WINDOW_MS',
        60_000,
        1_000,
        60 * 60_000,
      ),
      authenticationRatePerPeer: integerValue(
        environment,
        'QL3_WORKER_INGRESS_AUTH_RATE_PER_PEER',
        120,
        1,
        1_000_000,
      ),
      authenticationRateGlobal: integerValue(
        environment,
        'QL3_WORKER_INGRESS_AUTH_RATE_GLOBAL',
        1_200,
        1,
        1_000_000,
      ),
      authenticationRateMaxPeers: integerValue(
        environment,
        'QL3_WORKER_INGRESS_AUTH_RATE_MAX_PEERS',
        4_096,
        1,
        65_536,
      ),
      requestTimeoutMs: integerValue(
        environment,
        'QL3_WORKER_INGRESS_REQUEST_TIMEOUT_MS',
        15_000,
        100,
        120_000,
      ),
      drainTimeoutMs: integerValue(
        environment,
        'QL3_WORKER_INGRESS_DRAIN_TIMEOUT_MS',
        10_000,
        100,
        120_000,
      ),
    }),
    transport: Object.freeze({
      privateKeyFile: absoluteFile(
        environment,
        'QL3_WORKER_INGRESS_TLS_PRIVATE_KEY_FILE',
      ),
      certificateFile: absoluteFile(
        environment,
        'QL3_WORKER_INGRESS_TLS_CERTIFICATE_FILE',
      ),
      clientCertificateAuthorityFile: absoluteFile(
        environment,
        'QL3_WORKER_INGRESS_TLS_CLIENT_CA_FILE',
      ),
      ...(() => {
        const clientCertificateRevocationListFile = optionalAbsoluteFile(
          environment,
          'QL3_WORKER_INGRESS_TLS_CLIENT_CRL_FILE',
        );
        return clientCertificateRevocationListFile === undefined
          ? {}
          : { clientCertificateRevocationListFile };
      })(),
    }),
    database: Object.freeze({
      connection: databaseConnection(environment),
      pool: Object.freeze({
        applicationName,
        maxConnections: integerValue(
          environment,
          'QL3_WORKER_INGRESS_POSTGRES_MAX_CONNECTIONS',
          4,
          1,
          16,
        ),
        connectionTimeoutMs: integerValue(
          environment,
          'QL3_WORKER_INGRESS_POSTGRES_CONNECTION_TIMEOUT_MS',
          5_000,
          100,
          60_000,
        ),
      }),
    }),
    security: Object.freeze({
      workerCredentialPepper: workerCredentialPepper(environment),
    }),
    artifact: workerArtifactS3(environment),
    ...(secret === undefined ? {} : { secret }),
  });
}

async function readTlsFile(
  path: string,
  privateMaterial: boolean,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > MAX_TLS_FILE_BYTES ||
      (privateMaterial && (stat.mode & 0o022) !== 0)
    ) {
      throw new ClusterWorkerIngressConfigError('TLS file metadata is unsafe');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_TLS_FILE_BYTES) {
      bytes.fill(0);
      throw new ClusterWorkerIngressConfigError('TLS file size is unsafe');
    }
    return bytes;
  } catch (error) {
    if (error instanceof ClusterWorkerIngressConfigError) throw error;
    throw new ClusterWorkerIngressConfigError('TLS material is unavailable');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function activeCertificate(
  name: string,
  bytes: Buffer,
  now: number,
): X509Certificate {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(bytes);
  } catch {
    throw new ClusterWorkerIngressConfigError(
      `${name} is not an X.509 certificate`,
    );
  }
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    now < validFrom ||
    now >= validTo
  ) {
    throw new ClusterWorkerIngressConfigError(`${name} is not currently valid`);
  }
  return certificate;
}

function activeCertificateAuthorities(
  bytes: Buffer,
  now: number,
): readonly Buffer[] {
  const pem = bytes.toString('utf8');
  const matches = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (!matches || matches.length < 1 || matches.length > 16) {
    throw new ClusterWorkerIngressConfigError(
      'TLS client certificate authority bundle must contain 1 to 16 PEM certificates',
    );
  }
  const remainder = matches.reduce(
    (value, certificate) => value.replace(certificate, ''),
    pem,
  );
  if (remainder.trim() !== '') {
    throw new ClusterWorkerIngressConfigError(
      'TLS client certificate authority bundle contains unsupported data',
    );
  }
  const authorities: Buffer[] = [];
  try {
    for (const match of matches) {
      const authorityBytes = Buffer.from(`${match}\n`, 'utf8');
      const authority = activeCertificate(
        'TLS client certificate authority',
        authorityBytes,
        now,
      );
      if (!authority.ca) {
        authorityBytes.fill(0);
        throw new ClusterWorkerIngressConfigError(
          'TLS client certificate authority is not a CA',
        );
      }
      authorities.push(authorityBytes);
    }
    return Object.freeze(authorities);
  } catch (error) {
    for (const authority of authorities) authority.fill(0);
    throw error;
  }
}

function certificateRevocationList(bytes: Buffer): Buffer {
  const value = bytes.toString('utf8').trim();
  if (
    !value.startsWith('-----BEGIN X509 CRL-----') ||
    !value.endsWith('-----END X509 CRL-----')
  ) {
    throw new ClusterWorkerIngressConfigError(
      'TLS client certificate revocation list is not a PEM CRL',
    );
  }
  return bytes;
}

function matchingPrivateKey(
  privateKey: KeyObject,
  certificate: X509Certificate,
): boolean {
  const key = createPublicKey(privateKey).export({
    type: 'spki',
    format: 'der',
  });
  const certificateKey = certificate.publicKey.export({
    type: 'spki',
    format: 'der',
  });
  return (
    key.byteLength === certificateKey.byteLength &&
    timingSafeEqual(key, certificateKey)
  );
}

export async function loadClusterWorkerIngressMutualTls(
  config: EnabledClusterWorkerIngressConfig,
  now: number = Date.now(),
): Promise<ClusterControlMutualTlsOptions> {
  if (!config?.enabled || config.profile !== 'cluster-control') {
    throw new ClusterWorkerIngressConfigError(
      'TLS material requires an enabled Worker ingress config',
    );
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new ClusterWorkerIngressConfigError('observation time is invalid');
  }
  const keyBytes = await readTlsFile(config.transport.privateKeyFile, true);
  let certificateBytes: Buffer | undefined;
  let clientAuthorityBundleBytes: Buffer | undefined;
  let certificateRevocationListBytes: Buffer | undefined;
  let clientCertificateAuthorities: readonly Buffer[] = Object.freeze([]);
  try {
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey(keyBytes);
    } catch {
      throw new ClusterWorkerIngressConfigError('TLS private key is invalid');
    }
    certificateBytes = await readTlsFile(
      config.transport.certificateFile,
      false,
    );
    clientAuthorityBundleBytes = await readTlsFile(
      config.transport.clientCertificateAuthorityFile,
      false,
    );
    const certificate = activeCertificate(
      'TLS server certificate',
      certificateBytes,
      now,
    );
    clientCertificateAuthorities = activeCertificateAuthorities(
      clientAuthorityBundleBytes,
      now,
    );
    if (!matchingPrivateKey(privateKey, certificate)) {
      throw new ClusterWorkerIngressConfigError(
        'TLS private key does not match the server certificate',
      );
    }
    if (config.transport.clientCertificateRevocationListFile !== undefined) {
      certificateRevocationListBytes = certificateRevocationList(
        await readTlsFile(
          config.transport.clientCertificateRevocationListFile,
          false,
        ),
      );
    }
    const mutualTls: ClusterControlMutualTlsOptions = Object.freeze({
      privateKey: keyBytes,
      certificateChain: certificateBytes,
      clientCertificateAuthorities,
      ...(certificateRevocationListBytes === undefined
        ? {}
        : {
            certificateRevocationLists: Object.freeze([
              certificateRevocationListBytes,
            ]),
          }),
    });
    clientAuthorityBundleBytes.fill(0);
    return mutualTls;
  } catch (error) {
    keyBytes.fill(0);
    certificateBytes?.fill(0);
    clientAuthorityBundleBytes?.fill(0);
    certificateRevocationListBytes?.fill(0);
    for (const authority of clientCertificateAuthorities) authority.fill(0);
    throw error;
  }
}

export async function createClusterWorkerIngressHttpOptions(
  config: EnabledClusterWorkerIngressConfig,
  now: number = Date.now(),
): Promise<ClusterControlHttpSurfaceOptions> {
  const mutualTls = await loadClusterWorkerIngressMutualTls(config, now);
  return Object.freeze({ ...config.http, mutualTls });
}

export function createClusterWorkerIngressDatabaseOpener(
  config: EnabledClusterWorkerIngressConfig,
  onPoolError: (error: Error) => void,
): OpenPostgresDatabase {
  if (!config?.enabled || config.profile !== 'cluster-control') {
    throw new ClusterWorkerIngressConfigError(
      'database opener requires an enabled Worker ingress config',
    );
  }
  if (typeof onPoolError !== 'function') {
    throw new ClusterWorkerIngressConfigError('onPoolError must be a function');
  }
  return createPostgresDatabaseOpener({
    role: 'worker-ingress',
    connection: config.database.connection,
    pool: config.database.pool,
    onPoolError,
  });
}

// Remote Execution owns direct external Secret custody resolution.
import { Buffer } from 'node:buffer';
import https from 'node:https';
import { isIP } from 'node:net';
import { basename, dirname, isAbsolute, normalize } from 'node:path';
import type { TLSSocket } from 'node:tls';

import {
  MAX_REMOTE_ENVIRONMENT_BUNDLE_VALUE_BYTES,
  MAX_REMOTE_SECRET_DELIVERY_TOTAL_VALUE_BYTES,
  MAX_REMOTE_SECRET_VALUE_BYTES,
  normalizeRemoteWorkerSecretDeliveryAuthority,
  type RemoteWorkerSecretDeliveryAuthority,
  type RemoteWorkerSecretResolution,
  type RemoteWorkerSecretValueProvider,
} from '@qinglong/runtime-core/remote-secret-delivery';
import { secretProjectionFileName } from '@qinglong/runtime-core/secret-projection';

import { PrivateProjectedFileReader } from '../security/privateProjectedFile';

const MAX_CA_BYTES = 1024 * 1024;
const MAX_TOKEN_BYTES = 4096;
const MAX_RESPONSE_BYTES =
  MAX_REMOTE_ENVIRONMENT_BUNDLE_VALUE_BYTES + 16 * 1024;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_/-]{0,511}$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface ClusterVaultKvSecretProviderOptions {
  readonly endpoint: string;
  readonly caFile: string;
  readonly tokenFile: string;
  readonly kvMount: string;
  readonly pathPrefix: string;
  readonly expectedPolicy: string;
  readonly maximumTokenTtlSeconds: number;
  readonly requestTimeoutMs: number;
  readonly maximumConcurrency: number;
  readonly namespace?: string;
}

interface NormalizedClusterVaultKvSecretProviderOptions
  extends ClusterVaultKvSecretProviderOptions {
  readonly endpoint: string;
  readonly caRootDirectory: string;
  readonly caFileName: string;
  readonly tokenRootDirectory: string;
  readonly tokenFileName: string;
}

export interface ClusterVaultKvRequest {
  readonly endpoint: string;
  readonly path: string;
  readonly requestTimeoutMs: number;
  readonly namespace?: string;
}

export type ClusterVaultKvRequester = (
  request: Readonly<ClusterVaultKvRequest>,
  material: Readonly<{ readonly ca: Buffer; readonly token: string }>,
) => Promise<unknown>;

export interface ClusterVaultKvSecretProviderDependencies {
  readonly request?: ClusterVaultKvRequester;
}

export class ClusterVaultKvSecretProviderError extends Error {
  readonly code = 'QL3_CLUSTER_VAULT_KV_SECRET_UNAVAILABLE';

  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'trust_unavailable'
      | 'authentication_unavailable'
      | 'material_unavailable',
    options?: ErrorOptions,
  ) {
    super(`Cluster Vault KV Secret provider failed: ${reason}`, options);
    this.name = 'ClusterVaultKvSecretProviderError';
  }
}

function invalidConfiguration(cause?: unknown): never {
  throw new ClusterVaultKvSecretProviderError('invalid_configuration', {
    cause: cause instanceof Error ? cause : undefined,
  });
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalidConfiguration();
  }
  return value;
}

function safeName(value: unknown): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    return invalidConfiguration();
  }
  return value;
}

function safePrefix(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !PREFIX_PATTERN.test(value) ||
    value.includes('//') ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) {
    return invalidConfiguration();
  }
  return value;
}

function absoluteProjectedFile(value: unknown): Readonly<{
  rootDirectory: string;
  fileName: string;
}> {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    return invalidConfiguration();
  }
  const fileName = basename(value);
  const rootDirectory = dirname(value);
  if (
    !FILE_NAME_PATTERN.test(fileName) ||
    rootDirectory === value ||
    rootDirectory === dirname(rootDirectory)
  ) {
    return invalidConfiguration();
  }
  return Object.freeze({ rootDirectory, fileName });
}

export function normalizeClusterVaultKvSecretProviderOptions(
  value: ClusterVaultKvSecretProviderOptions,
): Readonly<NormalizedClusterVaultKvSecretProviderOptions> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidConfiguration();
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch (cause) {
    return invalidConfiguration(cause);
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    return invalidConfiguration();
  }
  const ca = absoluteProjectedFile(value.caFile);
  const token = absoluteProjectedFile(value.tokenFile);
  const namespace =
    value.namespace === undefined ? undefined : safePrefix(value.namespace);
  return Object.freeze({
    endpoint: endpoint.toString(),
    caFile: value.caFile,
    caRootDirectory: ca.rootDirectory,
    caFileName: ca.fileName,
    tokenFile: value.tokenFile,
    tokenRootDirectory: token.rootDirectory,
    tokenFileName: token.fileName,
    kvMount: safeName(value.kvMount),
    pathPrefix: safePrefix(value.pathPrefix),
    expectedPolicy: safeName(value.expectedPolicy),
    maximumTokenTtlSeconds: boundedInteger(
      value.maximumTokenTtlSeconds,
      30,
      3600,
    ),
    requestTimeoutMs: boundedInteger(value.requestTimeoutMs, 100, 30_000),
    maximumConcurrency: boundedInteger(value.maximumConcurrency, 1, 8),
    ...(namespace === undefined ? {} : { namespace }),
  });
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function canonicalBase64(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length >
      Math.ceil(MAX_REMOTE_ENVIRONMENT_BUNDLE_VALUE_BYTES / 3) * 4 + 4 ||
    !BASE64_PATTERN.test(value)
  ) {
    throw new ClusterVaultKvSecretProviderError('material_unavailable');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    bytes.fill(0);
    throw new ClusterVaultKvSecretProviderError('material_unavailable');
  }
  return bytes;
}

function parseVaultKvValue(
  value: unknown,
  expectedSecretRefDigest: string,
  maximumBytes: number,
): Buffer {
  const envelope = value as {
    readonly data?: {
      readonly data?: unknown;
      readonly metadata?: {
        readonly deletion_time?: unknown;
        readonly destroyed?: unknown;
        readonly version?: unknown;
      };
    };
  };
  const material = envelope?.data?.data as {
    readonly schemaVersion?: unknown;
    readonly secretRefDigest?: unknown;
    readonly encoding?: unknown;
    readonly value?: unknown;
  };
  const metadata = envelope?.data?.metadata;
  if (
    !exactKeys(material, [
      'encoding',
      'schemaVersion',
      'secretRefDigest',
      'value',
    ]) ||
    material.schemaVersion !== 1 ||
    material.secretRefDigest !== expectedSecretRefDigest ||
    material.encoding !== 'base64' ||
    metadata?.destroyed !== false ||
    metadata?.deletion_time !== '' ||
    !Number.isSafeInteger(metadata?.version) ||
    Number(metadata?.version) < 1
  ) {
    throw new ClusterVaultKvSecretProviderError('material_unavailable');
  }
  const bytes = canonicalBase64(material.value);
  if (bytes.byteLength > maximumBytes) {
    bytes.fill(0);
    throw new ClusterVaultKvSecretProviderError('material_unavailable');
  }
  return bytes;
}

function parseToken(bytes: Buffer): string {
  const raw = bytes.toString('utf8');
  const token = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!TOKEN_PATTERN.test(token) || (raw !== token && raw !== `${token}\n`)) {
    throw new ClusterVaultKvSecretProviderError('authentication_unavailable');
  }
  return token;
}

function secretValue(bytes: Buffer): string {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (value.includes('\0')) throw new Error('Secret contains NUL');
    return value;
  } catch (cause) {
    throw new ClusterVaultKvSecretProviderError('material_unavailable', {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}

function validateTokenLookup(
  value: unknown,
  expectedPolicy: string,
  maximumTokenTtlSeconds: number,
): void {
  const data = (value as { readonly data?: Record<string, unknown> })?.data;
  if (
    !data ||
    !Array.isArray(data.policies) ||
    JSON.stringify(data.policies) !== JSON.stringify([expectedPolicy]) ||
    data.orphan !== true ||
    data.renewable !== false ||
    data.type !== 'service' ||
    !Number.isSafeInteger(data.ttl) ||
    Number(data.ttl) < 1 ||
    Number(data.ttl) > maximumTokenTtlSeconds
  ) {
    throw new ClusterVaultKvSecretProviderError('authentication_unavailable');
  }
}

async function requestVaultJson(
  request: Readonly<ClusterVaultKvRequest>,
  material: Readonly<{ readonly ca: Buffer; readonly token: string }>,
): Promise<unknown> {
  const target = new URL(request.path, request.endpoint);
  return new Promise((resolve, reject) => {
    const requestHandle = https.request(
      target,
      {
        method: 'GET',
        ca: material.ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ...(isIP(target.hostname) === 0 ? { servername: target.hostname } : {}),
        headers: {
          accept: 'application/json',
          'x-vault-token': material.token,
          ...(request.namespace === undefined
            ? {}
            : { 'x-vault-namespace': request.namespace }),
        },
      },
      (response) => {
        const socket = response.socket as TLSSocket;
        const peerAuthorized = socket.authorized;
        const tlsProtocol = socket.getProtocol();
        const chunks: Buffer[] = [];
        let length = 0;
        const dispose = () =>
          chunks.splice(0).forEach((chunk) => chunk.fill(0));
        response.on('data', (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > MAX_RESPONSE_BYTES) {
            response.destroy(
              new ClusterVaultKvSecretProviderError('material_unavailable'),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once('error', (cause) => {
          dispose();
          reject(cause);
        });
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          dispose();
          try {
            if (
              response.statusCode !== 200 ||
              peerAuthorized !== true ||
              tlsProtocol !== 'TLSv1.3'
            ) {
              throw new ClusterVaultKvSecretProviderError(
                'material_unavailable',
              );
            }
            resolve(JSON.parse(bytes.toString('utf8')));
          } catch (cause) {
            reject(cause);
          } finally {
            bytes.fill(0);
          }
        });
      },
    );
    requestHandle.setTimeout(request.requestTimeoutMs, () => {
      requestHandle.destroy(
        new ClusterVaultKvSecretProviderError('material_unavailable'),
      );
    });
    requestHandle.once('error', reject);
    requestHandle.end();
  });
}

/**
 * A no-cache, no-watcher Vault KV v2 adapter. Every authorized delivery reads
 * the projected short-lived token again, revalidates its least-privilege
 * policy, and resolves only digest-derived paths over pinned TLS 1.3.
 */
export class ClusterVaultKvSecretProvider
  implements RemoteWorkerSecretValueProvider
{
  readonly #options: Readonly<NormalizedClusterVaultKvSecretProviderOptions>;
  readonly #caReader: PrivateProjectedFileReader;
  readonly #tokenReader: PrivateProjectedFileReader;
  readonly #request: ClusterVaultKvRequester;

  constructor(
    options: ClusterVaultKvSecretProviderOptions,
    dependencies: ClusterVaultKvSecretProviderDependencies = {},
  ) {
    this.#options = normalizeClusterVaultKvSecretProviderOptions(options);
    if (
      !dependencies ||
      typeof dependencies !== 'object' ||
      Array.isArray(dependencies) ||
      (dependencies.request !== undefined &&
        typeof dependencies.request !== 'function')
    ) {
      invalidConfiguration();
    }
    this.#request = dependencies.request ?? requestVaultJson;
    try {
      this.#caReader = new PrivateProjectedFileReader({
        rootDirectory: this.#options.caRootDirectory,
        minimumBytes: 32,
        maximumBytes: MAX_CA_BYTES,
        access: 'read_only_keyring',
      });
      this.#tokenReader = new PrivateProjectedFileReader({
        rootDirectory: this.#options.tokenRootDirectory,
        minimumBytes: 1,
        maximumBytes: MAX_TOKEN_BYTES + 1,
        access: 'private_material',
      });
    } catch (cause) {
      invalidConfiguration(cause);
    }
  }

  async #withCredentials<T>(
    action: (ca: Buffer, token: string) => Promise<T>,
  ): Promise<T> {
    let ca: Buffer | undefined;
    let tokenBytes: Buffer | undefined;
    let token: string | undefined;
    try {
      [ca, tokenBytes] = await Promise.all([
        this.#caReader.read(this.#options.caFileName),
        this.#tokenReader.read(this.#options.tokenFileName),
      ]);
      token = parseToken(tokenBytes);
      return await action(ca, token);
    } catch (cause) {
      if (cause instanceof ClusterVaultKvSecretProviderError) throw cause;
      throw new ClusterVaultKvSecretProviderError('trust_unavailable', {
        cause: cause instanceof Error ? cause : undefined,
      });
    } finally {
      ca?.fill(0);
      tokenBytes?.fill(0);
      token = undefined;
    }
  }

  async #requestJson(
    path: string,
    ca: Buffer,
    token: string,
  ): Promise<unknown> {
    try {
      return await this.#request(
        Object.freeze({
          endpoint: this.#options.endpoint,
          path,
          requestTimeoutMs: this.#options.requestTimeoutMs,
          ...(this.#options.namespace === undefined
            ? {}
            : { namespace: this.#options.namespace }),
        }),
        Object.freeze({ ca, token }),
      );
    } catch (cause) {
      if (cause instanceof ClusterVaultKvSecretProviderError) throw cause;
      throw new ClusterVaultKvSecretProviderError('material_unavailable', {
        cause: cause instanceof Error ? cause : undefined,
      });
    }
  }

  async #authenticate(ca: Buffer, token: string): Promise<void> {
    try {
      const response = await this.#requestJson(
        '/v1/auth/token/lookup-self',
        ca,
        token,
      );
      validateTokenLookup(
        response,
        this.#options.expectedPolicy,
        this.#options.maximumTokenTtlSeconds,
      );
    } catch (cause) {
      if (
        cause instanceof ClusterVaultKvSecretProviderError &&
        cause.reason === 'authentication_unavailable'
      ) {
        throw cause;
      }
      throw new ClusterVaultKvSecretProviderError(
        'authentication_unavailable',
        { cause: cause instanceof Error ? cause : undefined },
      );
    }
  }

  async verify(): Promise<void> {
    await this.#withCredentials(async (ca, token) => {
      await this.#authenticate(ca, token);
    });
  }

  async resolve(
    authority: Readonly<RemoteWorkerSecretDeliveryAuthority>,
  ): Promise<Readonly<RemoteWorkerSecretResolution>> {
    let normalized: Readonly<RemoteWorkerSecretDeliveryAuthority>;
    try {
      normalized = normalizeRemoteWorkerSecretDeliveryAuthority(authority);
    } catch (cause) {
      throw new ClusterVaultKvSecretProviderError('material_unavailable', {
        cause: cause instanceof Error ? cause : undefined,
      });
    }
    return this.#withCredentials(async (ca, token) => {
      await this.#authenticate(ca, token);
      const inputs = [
        ...normalized.secretRefs.map((secretRef) =>
          Object.freeze({
            kind: 'secret' as const,
            secretRef,
            maximumBytes: MAX_REMOTE_SECRET_VALUE_BYTES,
          }),
        ),
        ...normalized.environmentBundleRefs.map((secretRef) =>
          Object.freeze({
            kind: 'environment-bundle' as const,
            secretRef,
            maximumBytes: MAX_REMOTE_ENVIRONMENT_BUNDLE_VALUE_BYTES,
          }),
        ),
      ];
      const buffers: Buffer[] = [];
      try {
        const resolved: Array<
          Readonly<{
            kind: 'secret' | 'environment-bundle';
            secretRef: string;
            value: string;
            byteLength: number;
          }>
        > = [];
        for (
          let offset = 0;
          offset < inputs.length;
          offset += this.#options.maximumConcurrency
        ) {
          const batch = inputs.slice(
            offset,
            offset + this.#options.maximumConcurrency,
          );
          const values = await Promise.all(
            batch.map(async (input) => {
              const digest = secretProjectionFileName(input.secretRef);
              const response = await this.#requestJson(
                `/v1/${encodeURIComponent(
                  this.#options.kvMount,
                )}/data/${this.#options.pathPrefix
                  .split('/')
                  .map(encodeURIComponent)
                  .join('/')}/${digest}`,
                ca,
                token,
              );
              const bytes = parseVaultKvValue(
                response,
                digest,
                input.maximumBytes,
              );
              buffers.push(bytes);
              return Object.freeze({
                kind: input.kind,
                secretRef: input.secretRef,
                value: secretValue(bytes),
                byteLength: bytes.byteLength,
              });
            }),
          );
          resolved.push(...values);
        }
        const values = resolved
          .filter(({ kind }) => kind === 'secret')
          .map(({ secretRef, value }) => Object.freeze({ secretRef, value }));
        const totalBytes = resolved
          .filter(({ kind }) => kind === 'secret')
          .reduce((sum, item) => sum + item.byteLength, 0);
        if (totalBytes > MAX_REMOTE_SECRET_DELIVERY_TOTAL_VALUE_BYTES) {
          throw new ClusterVaultKvSecretProviderError('material_unavailable');
        }
        const environmentBundles = resolved
          .filter(({ kind }) => kind === 'environment-bundle')
          .map(({ secretRef, value }) => Object.freeze({ secretRef, value }));
        let disposed = false;
        return Object.freeze({
          values: Object.freeze(values),
          environmentBundles: Object.freeze(environmentBundles),
          dispose() {
            if (disposed) return;
            disposed = true;
            buffers.splice(0).forEach((bytes) => bytes.fill(0));
          },
        });
      } catch (cause) {
        buffers.splice(0).forEach((bytes) => bytes.fill(0));
        if (cause instanceof ClusterVaultKvSecretProviderError) throw cause;
        throw new ClusterVaultKvSecretProviderError('material_unavailable', {
          cause: cause instanceof Error ? cause : undefined,
        });
      }
    });
  }
}

export async function createClusterVaultKvSecretProvider(
  options: ClusterVaultKvSecretProviderOptions,
): Promise<Readonly<ClusterVaultKvSecretProvider>> {
  const provider = new ClusterVaultKvSecretProvider(options);
  await provider.verify();
  return provider;
}

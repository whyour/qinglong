// Cluster Plugin Package recovery boundary; keep OCI staging authority explicit.
import { createHash } from 'node:crypto';

import {
  PluginPackageActivationConflictError,
  PluginPackageActivationUnavailableError,
  type PluginPackageActivationIntent,
} from '@qinglong/runtime-core/plugin-package-activation';
import {
  MAX_PLUGIN_PACKAGE_MANIFEST_BYTES,
  normalizePluginPackageManifest,
  type PluginPackageManifest,
} from '@qinglong/runtime-core/plugin-package';
import {
  InvalidPluginPackageBundleError,
  InvalidPluginPackagePublisherTrustError,
  PLUGIN_PACKAGE_BUNDLE_MEDIA_TYPE,
  PluginPackageBundleUnavailableError,
  PluginPackagePublisherTrustRegistry,
  UntrustedPluginPackagePublisherError,
  inspectPluginPackageBundle,
  type PluginPackageBundleEntry,
  type PluginPackageBundleInspection,
  type PluginPackageBundleSink,
  type PluginPackagePublisherSignatureEvidence,
  type PluginPackageSignature,
} from '@qinglong/runtime-core/plugin-package-bundle';
import {
  InvalidPluginPackageInstallError,
  PluginPackageInstallUnavailableError,
  normalizePluginPackageLock,
  type PluginPackageLock,
  type PluginPackageStageReceipt,
} from '@qinglong/runtime-core/plugin-package-install';
import {
  normalizePluginPackageStageEvidence,
  type PluginPackageStageEvidence,
  type PluginPackageStageProvider,
} from '@qinglong/runtime-core/plugin-package-installation';
import {
  normalizePluginPackageResourceGeneration,
  type PluginPackageResourceGeneration,
} from '@qinglong/runtime-core/plugin-package-resource-generation';
import {
  MAX_PLUGIN_PACKAGE_MATERIALIZED_RESOURCE_BYTES,
  MAX_PLUGIN_PACKAGE_MATERIALIZED_TOTAL_BYTES,
  type PluginPackageResourceByteReader,
  type PluginPackageResourceByteSource,
  type PluginPackageResourceLockSource,
} from '@qinglong/runtime-core/plugin-package-resource-materialization';

import type { ClusterPluginPackageStageEvidence } from './pluginPackageKubernetesActivation';

export const PLUGIN_PACKAGE_OCI_ARTIFACT_TYPE =
  'application/vnd.qinglong.package.v1' as const;
export const PLUGIN_PACKAGE_OCI_CONFIG_MEDIA_TYPE =
  'application/vnd.qinglong.package.config.v1+json' as const;
export const PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE =
  'application/vnd.qinglong.package.signature.v1' as const;
export const PLUGIN_PACKAGE_OCI_SIGNATURE_CONFIG_MEDIA_TYPE =
  'application/vnd.qinglong.package.signature.v1+json' as const;

const PLUGIN_PACKAGE_OCI_CONFIG_SCHEMA =
  'qinglong/plugin-package-oci-config@v1';
const OCI_IMAGE_MANIFEST_MEDIA_TYPE =
  'application/vnd.oci.image.manifest.v1+json';
const OCI_IMAGE_INDEX_MEDIA_TYPE =
  'application/vnd.oci.image.index.v1+json';
const LOCK_DIGEST_ANNOTATION = 'qinglong.io/plugin-package-lock-digest';
const STAGE_REFERENCE_PREFIX = 'cluster-oci:';
const DIGEST = /^[0-9a-f]{64}$/;
const OCI_DIGEST = /^sha256:([0-9a-f]{64})$/;
const OCI_LOCATOR =
  /^oci:\/\/([^/?#]+)\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@sha256:([0-9a-f]{64})$/;
const REGISTRY =
  /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::([1-9][0-9]{0,4}))?$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const MAX_REFERRERS_BYTES = 256 * 1024;
const MAX_REFERRERS = 32;
const MAX_CACHED_EVIDENCE = 64;

export interface ClusterPluginPackageOciHttpResponse {
  readonly status: number;
  readonly headers: Readonly<{
    get(name: string): string | null;
  }>;
  readonly body: AsyncIterable<Uint8Array> | null;
}

export type ClusterPluginPackageOciFetch = (
  url: string,
  init: Readonly<{
    method: 'GET';
    headers: Readonly<Record<string, string>>;
    redirect: 'error';
    signal: AbortSignal;
  }>,
) => Promise<ClusterPluginPackageOciHttpResponse>;

export interface ClusterPluginPackageRegistryCredentialProvider {
  authorizationFor(registry: string): string | undefined;
}

export interface ClusterPluginPackageOciStageAuthorityOptions {
  readonly allowedRegistries: readonly string[];
  readonly trust: PluginPackagePublisherTrustRegistry;
  readonly credentialProvider?: ClusterPluginPackageRegistryCredentialProvider;
  readonly fetch?: ClusterPluginPackageOciFetch;
  readonly requestTimeoutMs?: number;
}

export interface ClusterPluginPackageStageAuthority
  extends PluginPackageStageProvider {
  publisherEvidence(
    lock: Readonly<PluginPackageLock>,
    stage: Readonly<PluginPackageStageEvidence>,
  ): Promise<Readonly<PluginPackagePublisherSignatureEvidence>>;
  verify(
    lock: Readonly<PluginPackageLock>,
    receipt: Readonly<PluginPackageStageReceipt>,
  ): Promise<void>;
}

interface OciLocation {
  readonly registry: string;
  readonly repository: string;
  readonly manifestDigest: string;
}

interface OciDescriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
  readonly artifactType?: string;
  readonly annotations?: Readonly<Record<string, string>>;
}

interface ResolvedStage {
  readonly stage: Readonly<PluginPackageStageEvidence>;
  readonly publisher: Readonly<PluginPackagePublisherSignatureEvidence>;
}

interface CapturedEntry {
  readonly bytes: number;
  readonly digest: string;
  readonly material: Buffer;
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidPluginPackageInstallError(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    throw new InvalidPluginPackageInstallError(
      `${label} must contain enumerable data properties`,
    );
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    required.some((key) => !actual.includes(key)) ||
    actual.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new InvalidPluginPackageInstallError(`${label} shape is invalid`);
  }
}

function safeInteger(value: unknown, maximum: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw new InvalidPluginPackageInstallError(`${label} is invalid`);
  }
  return value as number;
}

function parseDescriptor(
  value: unknown,
  label: string,
  maximumBytes: number,
  options: Readonly<{
    allowArtifactType?: boolean;
    allowAnnotations?: boolean;
  }> = {},
): Readonly<OciDescriptor> {
  const descriptor = dataRecord(value, label);
  exactKeys(
    descriptor,
    ['mediaType', 'digest', 'size'],
    [
      ...(options.allowArtifactType ? ['artifactType'] : []),
      ...(options.allowAnnotations ? ['annotations'] : []),
    ],
    label,
  );
  if (
    typeof descriptor.mediaType !== 'string' ||
    descriptor.mediaType.length < 1 ||
    descriptor.mediaType.length > 255 ||
    typeof descriptor.digest !== 'string' ||
    !OCI_DIGEST.test(descriptor.digest)
  ) {
    throw new InvalidPluginPackageInstallError(`${label} is invalid`);
  }
  const size = safeInteger(descriptor.size, maximumBytes, `${label} size`);
  let artifactType: string | undefined;
  if (options.allowArtifactType) {
    if (
      descriptor.artifactType !== undefined &&
      (typeof descriptor.artifactType !== 'string' ||
        descriptor.artifactType.length < 1 ||
        descriptor.artifactType.length > 255)
    ) {
      throw new InvalidPluginPackageInstallError(
        `${label} artifact type is invalid`,
      );
    }
    artifactType = descriptor.artifactType as string | undefined;
  }
  let annotations: Readonly<Record<string, string>> | undefined;
  if (options.allowAnnotations && descriptor.annotations !== undefined) {
    const values = dataRecord(descriptor.annotations, `${label} annotations`);
    if (
      Object.keys(values).length > 16 ||
      Object.entries(values).some(
        ([key, candidate]) =>
          key.length < 1 ||
          key.length > 255 ||
          typeof candidate !== 'string' ||
          candidate.length > 1024 ||
          /[\0\r\n]/.test(candidate),
      )
    ) {
      throw new InvalidPluginPackageInstallError(
        `${label} annotations are invalid`,
      );
    }
    annotations = Object.freeze(values as Record<string, string>);
  }
  return Object.freeze({
    mediaType: descriptor.mediaType,
    digest: descriptor.digest,
    size,
    ...(artifactType === undefined ? {} : { artifactType }),
    ...(annotations === undefined ? {} : { annotations }),
  });
}

function parseLocation(
  lock: Readonly<PluginPackageLock>,
  allowedRegistries: ReadonlySet<string>,
): Readonly<OciLocation> {
  if (lock.source.kind !== 'oci') {
    throw new InvalidPluginPackageInstallError(
      'cluster source must be an OCI package',
    );
  }
  const match = OCI_LOCATOR.exec(lock.source.locator);
  if (
    !match ||
    !REGISTRY.test(match[1]!) ||
    !allowedRegistries.has(match[1]!)
  ) {
    throw new InvalidPluginPackageInstallError(
      'OCI source registry is not explicitly allowed',
    );
  }
  return Object.freeze({
    registry: match[1]!,
    repository: match[2]!,
    manifestDigest: match[3]!,
  });
}

function productionFetch(
  url: string,
  init: Parameters<ClusterPluginPackageOciFetch>[1],
): Promise<ClusterPluginPackageOciHttpResponse> {
  return fetch(url, init) as Promise<ClusterPluginPackageOciHttpResponse>;
}

function unavailable(error?: unknown): PluginPackageInstallUnavailableError {
  return new PluginPackageInstallUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

function preserveOciResolutionError(error: unknown): never {
  if (
    error instanceof InvalidPluginPackageInstallError ||
    error instanceof PluginPackageInstallUnavailableError
  ) {
    throw error;
  }
  if (
    error instanceof InvalidPluginPackageBundleError ||
    error instanceof InvalidPluginPackagePublisherTrustError ||
    error instanceof UntrustedPluginPackagePublisherError
  ) {
    throw new InvalidPluginPackageInstallError(
      'OCI package evidence does not match its PackageLock',
    );
  }
  if (error instanceof PluginPackageBundleUnavailableError) {
    throw unavailable(error);
  }
  throw unavailable(error);
}

function contentLength(
  response: ClusterPluginPackageOciHttpResponse,
  maximum: number,
  expected?: number,
): void {
  const value = response.headers.get('content-length');
  if (value === null) return;
  if (!/^\d+$/.test(value)) {
    throw new InvalidPluginPackageInstallError(
      'OCI response content length is invalid',
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > maximum ||
    (expected !== undefined && parsed !== expected)
  ) {
    throw new InvalidPluginPackageInstallError(
      'OCI response content length does not match its descriptor',
    );
  }
}

async function collect(
  body: AsyncIterable<Uint8Array>,
  maximum: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of body) {
    if (!(value instanceof Uint8Array) || value.byteLength < 1) {
      throw new InvalidPluginPackageInstallError(
        'OCI response chunk is invalid',
      );
    }
    bytes += value.byteLength;
    if (bytes > maximum) {
      throw new InvalidPluginPackageInstallError(
        'OCI response exceeds its byte budget',
      );
    }
    chunks.push(Buffer.from(value));
  }
  if (bytes < 1) {
    throw new InvalidPluginPackageInstallError('OCI response is empty');
  }
  return Buffer.concat(chunks, bytes);
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(source);
  } catch {
    throw new InvalidPluginPackageInstallError(`${label} is not valid JSON`);
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceDigest(
  lock: Readonly<PluginPackageLock>,
  inspection: Readonly<PluginPackageBundleInspection>,
): string {
  return createHash('sha256')
    .update('qinglong/plugin-package-cluster-oci-stage@v1\0', 'utf8')
    .update(
      JSON.stringify({
        lockDigest: lock.lockDigest,
        source: lock.source,
        inspection,
      }),
      'utf8',
    )
    .digest('hex');
}

class CapturedOciResourceReader implements PluginPackageResourceByteReader {
  readonly #entries: Map<string, CapturedEntry>;
  #closed = false;

  constructor(entries: Map<string, CapturedEntry>) {
    this.#entries = entries;
  }

  async read(path: string, maximumBytes: number): Promise<Uint8Array> {
    if (
      this.#closed ||
      typeof path !== 'string' ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > MAX_PLUGIN_PACKAGE_MATERIALIZED_RESOURCE_BYTES
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI resource read request is invalid',
      );
    }
    const entry = this.#entries.get(path);
    if (!entry || entry.bytes > maximumBytes) {
      throw new InvalidPluginPackageInstallError(
        'OCI resource read is unknown or exceeds its requested bound',
      );
    }
    this.#entries.delete(path);
    return entry.material;
  }

  close(): void {
    this.#closed = true;
    for (const entry of this.#entries.values()) entry.material.fill(0);
    this.#entries.clear();
  }
}

class BoundedOciResourceSink implements PluginPackageBundleSink {
  readonly #generation: Readonly<PluginPackageResourceGeneration>;
  readonly #expected: ReadonlySet<string>;
  readonly #entries = new Map<string, CapturedEntry>();
  #current:
    | {
        readonly path: string;
        readonly bytes: number;
        readonly chunks: Buffer[];
        readonly hash: ReturnType<typeof createHash>;
        received: number;
      }
    | undefined;
  #resourceBytes = 0;
  #committed = false;

  constructor(generation: Readonly<PluginPackageResourceGeneration>) {
    this.#generation = generation;
    this.#expected = new Set([
      'package.json',
      ...generation.resources.map((resource) => resource.path),
    ]);
  }

  begin(entry: Readonly<{ path: string; bytes: number }>): void {
    const maximum =
      entry.path === 'package.json'
        ? MAX_PLUGIN_PACKAGE_MANIFEST_BYTES
        : MAX_PLUGIN_PACKAGE_MATERIALIZED_RESOURCE_BYTES;
    if (
      this.#current ||
      !this.#expected.has(entry.path) ||
      this.#entries.has(entry.path) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > maximum
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI materialization entry is invalid or duplicated',
      );
    }
    if (entry.path !== 'package.json') {
      this.#resourceBytes += entry.bytes;
      if (
        this.#resourceBytes > MAX_PLUGIN_PACKAGE_MATERIALIZED_TOTAL_BYTES
      ) {
        throw new InvalidPluginPackageInstallError(
          'OCI materialization exceeds its total resource byte budget',
        );
      }
    }
    this.#current = {
      path: entry.path,
      bytes: entry.bytes,
      chunks: [],
      hash: createHash('sha256'),
      received: 0,
    };
  }

  write(value: Uint8Array): void {
    if (
      !this.#current ||
      !(value instanceof Uint8Array) ||
      value.byteLength < 1 ||
      this.#current.received + value.byteLength > this.#current.bytes
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI materialization entry stream is invalid',
      );
    }
    const chunk = Buffer.from(value);
    this.#current.received += chunk.byteLength;
    this.#current.hash.update(chunk);
    this.#current.chunks.push(chunk);
  }

  end(entry: Readonly<PluginPackageBundleEntry>): void {
    const current = this.#current;
    if (
      !current ||
      current.path !== entry.path ||
      current.bytes !== entry.bytes ||
      current.received !== entry.bytes ||
      current.hash.digest('hex') !== entry.digest
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI materialization entry boundary or digest is invalid',
      );
    }
    this.#entries.set(
      entry.path,
      Object.freeze({
        bytes: entry.bytes,
        digest: entry.digest,
        material: Buffer.concat(current.chunks, current.received),
      }),
    );
    this.#current = undefined;
  }

  commit(inspection: Readonly<PluginPackageBundleInspection>): void {
    if (
      this.#current ||
      this.#entries.size !== this.#expected.size ||
      inspection.lockDigest !== this.#generation.lockDigest ||
      inspection.contentDigest !== this.#generation.contentDigest ||
      [...this.#expected].some((path) => !this.#entries.has(path))
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI materialization capture is incomplete or inconsistent',
      );
    }
    this.#committed = true;
  }

  abort(): void {
    for (const chunk of this.#current?.chunks ?? []) chunk.fill(0);
    this.#current = undefined;
    for (const entry of this.#entries.values()) entry.material.fill(0);
    this.#entries.clear();
  }

  reader(): PluginPackageResourceByteReader {
    if (!this.#committed) {
      throw new InvalidPluginPackageInstallError(
        'OCI materialization capture is not committed',
      );
    }
    return new CapturedOciResourceReader(this.#entries);
  }
}

/**
 * Short-lived, allowlisted OCI Distribution resolver. It follows no redirect,
 * reads no ambient registry credentials, accepts only an explicitly injected
 * exact-registry credential provider and retains only a bounded evidence cache;
 * package bytes are verified as one streaming layer.
 */
export class ClusterPluginPackageOciStageAuthority
  implements ClusterPluginPackageStageAuthority
{
  readonly #allowedRegistries: ReadonlySet<string>;
  readonly #trust: PluginPackagePublisherTrustRegistry;
  readonly #credentialProvider:
    | ClusterPluginPackageRegistryCredentialProvider
    | undefined;
  readonly #fetch: ClusterPluginPackageOciFetch;
  readonly #requestTimeoutMs: number;
  readonly #cache = new Map<string, Readonly<ResolvedStage>>();

  constructor(options: ClusterPluginPackageOciStageAuthorityOptions) {
    const value = dataRecord(options, 'OCI stage authority options');
    exactKeys(
      value,
      ['allowedRegistries', 'trust'],
      ['credentialProvider', 'fetch', 'requestTimeoutMs'],
      'OCI stage authority options',
    );
    const credentialProvider = options.credentialProvider;
    if (
      !Array.isArray(options.allowedRegistries) ||
      options.allowedRegistries.length < 1 ||
      options.allowedRegistries.length > 32 ||
      options.allowedRegistries.some(
        (registry) => typeof registry !== 'string' || !REGISTRY.test(registry),
      ) ||
      new Set(options.allowedRegistries).size !==
        options.allowedRegistries.length ||
      !(options.trust instanceof PluginPackagePublisherTrustRegistry) ||
      (credentialProvider !== undefined &&
        (!credentialProvider ||
          typeof credentialProvider !== 'object' ||
          typeof credentialProvider.authorizationFor !== 'function')) ||
      (options.fetch !== undefined && typeof options.fetch !== 'function') ||
      (options.requestTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.requestTimeoutMs) ||
          options.requestTimeoutMs < 1000 ||
          options.requestTimeoutMs > 60_000))
    ) {
      throw new TypeError('Plugin Package OCI stage authority is invalid');
    }
    this.#allowedRegistries = new Set(options.allowedRegistries);
    this.#trust = options.trust;
    this.#credentialProvider = credentialProvider;
    this.#fetch = options.fetch ?? productionFetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async #consume<T>(
    url: string,
    accept: string,
    maximumBytes: number,
    consumer: (body: AsyncIterable<Uint8Array>) => Promise<T>,
    expectedBytes?: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#requestTimeoutMs,
    );
    timeout.unref();
    try {
      let registry: string;
      try {
        const requestTarget = /^https:\/\/([^/?#]+)\/v2\//.exec(url);
        if (
          !requestTarget ||
          !REGISTRY.test(requestTarget[1]!) ||
          !this.#allowedRegistries.has(requestTarget[1]!)
        ) {
          throw new Error('OCI request target is outside the allowlist');
        }
        registry = requestTarget[1]!;
      } catch {
        throw new InvalidPluginPackageInstallError(
          'OCI request target is invalid',
        );
      }
      let authorization: string | undefined;
      try {
        authorization =
          this.#credentialProvider?.authorizationFor(registry);
      } catch (error) {
        throw unavailable(error);
      }
      if (
        authorization !== undefined &&
        (typeof authorization !== 'string' ||
          authorization.length < 8 ||
          authorization.length > 16 * 1024 ||
          !/^(?:Basic [A-Za-z0-9+/]+={0,2}|Bearer [A-Za-z0-9._~+/-]+={0,2})$/.test(
            authorization,
          ))
      ) {
        throw unavailable();
      }
      let response: ClusterPluginPackageOciHttpResponse;
      try {
        response = await this.#fetch(url, {
          method: 'GET',
          headers: Object.freeze({
            accept,
            ...(authorization === undefined ? {} : { authorization }),
          }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (error) {
        throw unavailable(error);
      }
      if (
        !response ||
        response.status !== 200 ||
        !response.headers ||
        typeof response.headers.get !== 'function' ||
        !response.body ||
        typeof response.body[Symbol.asyncIterator] !== 'function'
      ) {
        throw unavailable();
      }
      contentLength(response, maximumBytes, expectedBytes);
      return await consumer(response.body);
    } finally {
      clearTimeout(timeout);
    }
  }

  async #contentAddressedJson(
    url: string,
    accept: string,
    digest: string,
    maximumBytes: number,
    expectedBytes?: number,
  ): Promise<unknown> {
    const bytes = await this.#consume(
      url,
      accept,
      maximumBytes,
      (body) => collect(body, maximumBytes),
      expectedBytes,
    );
    if (
      sha256(bytes) !== digest ||
      (expectedBytes !== undefined && bytes.byteLength !== expectedBytes)
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI content does not match its immutable descriptor',
      );
    }
    return parseJson(bytes, 'OCI content');
  }

  #url(
    location: Readonly<OciLocation>,
    area: 'manifests' | 'blobs' | 'referrers',
    digest: string,
  ): string {
    return `https://${location.registry}/v2/${location.repository}/${area}/sha256:${digest}`;
  }

  async #packageManifest(
    lock: Readonly<PluginPackageLock>,
    location: Readonly<OciLocation>,
  ): Promise<Readonly<{
    manifest: Readonly<PluginPackageManifest>;
    layer: Readonly<OciDescriptor>;
  }>> {
    const value = await this.#contentAddressedJson(
      this.#url(location, 'manifests', location.manifestDigest),
      OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      location.manifestDigest,
      MAX_MANIFEST_BYTES,
    );
    const manifest = dataRecord(value, 'OCI package manifest');
    exactKeys(
      manifest,
      ['schemaVersion', 'mediaType', 'artifactType', 'config', 'layers'],
      ['annotations'],
      'OCI package manifest',
    );
    if (
      manifest.schemaVersion !== 2 ||
      manifest.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE ||
      manifest.artifactType !== PLUGIN_PACKAGE_OCI_ARTIFACT_TYPE ||
      !Array.isArray(manifest.layers) ||
      manifest.layers.length !== 1
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI package manifest is invalid',
      );
    }
    const config = parseDescriptor(
      manifest.config,
      'OCI package config descriptor',
      MAX_CONFIG_BYTES,
    );
    const layer = parseDescriptor(
      manifest.layers[0],
      'OCI package layer descriptor',
      lock.source.artifactBytes,
    );
    if (
      config.mediaType !== PLUGIN_PACKAGE_OCI_CONFIG_MEDIA_TYPE ||
      layer.mediaType !== PLUGIN_PACKAGE_BUNDLE_MEDIA_TYPE ||
      layer.digest !== `sha256:${lock.source.artifactDigest}` ||
      layer.size !== lock.source.artifactBytes
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI package descriptors do not match the PackageLock',
      );
    }
    const configDigest = OCI_DIGEST.exec(config.digest)![1]!;
    const configValue = await this.#contentAddressedJson(
      this.#url(location, 'blobs', configDigest),
      PLUGIN_PACKAGE_OCI_CONFIG_MEDIA_TYPE,
      configDigest,
      MAX_CONFIG_BYTES,
      config.size,
    );
    const metadata = dataRecord(configValue, 'OCI package config');
    exactKeys(
      metadata,
      ['schema', 'manifest'],
      [],
      'OCI package config',
    );
    if (metadata.schema !== PLUGIN_PACKAGE_OCI_CONFIG_SCHEMA) {
      throw new InvalidPluginPackageInstallError(
        'OCI package config schema is unsupported',
      );
    }
    return Object.freeze({
      manifest: normalizePluginPackageManifest(
        metadata.manifest as PluginPackageManifest,
      ),
      layer,
    });
  }

  async #signature(
    lock: Readonly<PluginPackageLock>,
    location: Readonly<OciLocation>,
  ): Promise<Readonly<PluginPackageSignature>> {
    const value = await this.#consume(
      `${this.#url(location, 'referrers', location.manifestDigest)}?artifactType=${encodeURIComponent(
        PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE,
      )}`,
      OCI_IMAGE_INDEX_MEDIA_TYPE,
      MAX_REFERRERS_BYTES,
      async (body) =>
        parseJson(
          await collect(body, MAX_REFERRERS_BYTES),
          'OCI referrers index',
        ),
    );
    const index = dataRecord(value, 'OCI referrers index');
    exactKeys(
      index,
      ['schemaVersion', 'mediaType', 'manifests'],
      ['annotations'],
      'OCI referrers index',
    );
    if (
      index.schemaVersion !== 2 ||
      index.mediaType !== OCI_IMAGE_INDEX_MEDIA_TYPE ||
      !Array.isArray(index.manifests) ||
      index.manifests.length > MAX_REFERRERS
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI referrers index is invalid',
      );
    }
    const matches = index.manifests
      .map((descriptor, indexValue) =>
        parseDescriptor(
          descriptor,
          `OCI signature descriptor ${indexValue}`,
          MAX_MANIFEST_BYTES,
          { allowArtifactType: true, allowAnnotations: true },
        ),
      )
      .filter(
        (descriptor) =>
          descriptor.mediaType === OCI_IMAGE_MANIFEST_MEDIA_TYPE &&
          descriptor.artifactType ===
            PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE &&
          descriptor.annotations?.[LOCK_DIGEST_ANNOTATION] ===
            lock.lockDigest,
      );
    if (matches.length === 0) throw unavailable();
    if (matches.length !== 1) {
      throw new InvalidPluginPackageInstallError(
        'OCI package signature is ambiguous',
      );
    }
    const descriptor = matches[0]!;
    const signatureManifestDigest = OCI_DIGEST.exec(descriptor.digest)![1]!;
    const signatureManifestValue = await this.#contentAddressedJson(
      this.#url(location, 'manifests', signatureManifestDigest),
      OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      signatureManifestDigest,
      MAX_MANIFEST_BYTES,
      descriptor.size,
    );
    const signatureManifest = dataRecord(
      signatureManifestValue,
      'OCI signature manifest',
    );
    exactKeys(
      signatureManifest,
      [
        'schemaVersion',
        'mediaType',
        'artifactType',
        'config',
        'layers',
        'subject',
      ],
      ['annotations'],
      'OCI signature manifest',
    );
    if (
      signatureManifest.schemaVersion !== 2 ||
      signatureManifest.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE ||
      signatureManifest.artifactType !==
        PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE ||
      !Array.isArray(signatureManifest.layers) ||
      signatureManifest.layers.length !== 0
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI signature manifest is invalid',
      );
    }
    const subject = parseDescriptor(
      signatureManifest.subject,
      'OCI signature subject',
      MAX_MANIFEST_BYTES,
    );
    const config = parseDescriptor(
      signatureManifest.config,
      'OCI signature config descriptor',
      MAX_SIGNATURE_BYTES,
    );
    if (
      subject.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE ||
      subject.digest !== `sha256:${location.manifestDigest}` ||
      config.mediaType !== PLUGIN_PACKAGE_OCI_SIGNATURE_CONFIG_MEDIA_TYPE
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI signature is detached from its package',
      );
    }
    const configDigest = OCI_DIGEST.exec(config.digest)![1]!;
    const signatureValue = await this.#contentAddressedJson(
      this.#url(location, 'blobs', configDigest),
      PLUGIN_PACKAGE_OCI_SIGNATURE_CONFIG_MEDIA_TYPE,
      configDigest,
      MAX_SIGNATURE_BYTES,
      config.size,
    );
    return Object.freeze(
      dataRecord(signatureValue, 'OCI package signature'),
    ) as unknown as Readonly<PluginPackageSignature>;
  }

  async #inspect(
    lock: Readonly<PluginPackageLock>,
    sink?: PluginPackageBundleSink,
  ): Promise<Readonly<PluginPackageBundleInspection>> {
    const location = parseLocation(lock, this.#allowedRegistries);
    const [{ manifest, layer }, signature] = await Promise.all([
      this.#packageManifest(lock, location),
      this.#signature(lock, location),
    ]);
    const artifactDigest = OCI_DIGEST.exec(layer.digest)![1]!;
    return this.#consume(
      this.#url(location, 'blobs', artifactDigest),
      PLUGIN_PACKAGE_BUNDLE_MEDIA_TYPE,
      lock.source.artifactBytes,
      (body) =>
        inspectPluginPackageBundle({
          lock,
          manifest,
          signature,
          trust: this.#trust,
          observedAtMs: lock.createdAtMs,
          chunks: body,
          ...(sink === undefined ? {} : { sink }),
        }),
      lock.source.artifactBytes,
    );
  }

  async #resolve(
    lockValue: Readonly<PluginPackageLock>,
  ): Promise<Readonly<ResolvedStage>> {
    const lock = normalizePluginPackageLock(lockValue);
    try {
      const inspection = await this.#inspect(lock);
      const digest = evidenceDigest(lock, inspection);
      const stage = Object.freeze({
        stageRef: `${STAGE_REFERENCE_PREFIX}${lock.lockDigest}`,
        artifactDigest: inspection.artifactDigest,
        manifestDigest: inspection.manifestDigest,
        contentDigest: inspection.contentDigest,
        evidenceDigest: digest,
      });
      return Object.freeze({
        stage,
        publisher: inspection.signature,
      });
    } catch (error) {
      return preserveOciResolutionError(error);
    }
  }

  async openResourceReader(
    lockValue: Readonly<PluginPackageLock>,
    generationValue: Readonly<PluginPackageResourceGeneration>,
  ): Promise<PluginPackageResourceByteReader> {
    const lock = normalizePluginPackageLock(lockValue);
    const generation =
      normalizePluginPackageResourceGeneration(generationValue);
    if (
      generation.lockDigest !== lock.lockDigest ||
      generation.projectId !== lock.projectId ||
      generation.packageName !== lock.packageName ||
      generation.generation !== lock.targetGeneration ||
      generation.previousActiveLockDigest !==
        (lock.previousLockDigest ?? null) ||
      generation.contentDigest !== lock.source.contentDigest ||
      JSON.stringify(generation.resources) !== JSON.stringify(lock.resources)
    ) {
      throw new InvalidPluginPackageInstallError(
        'OCI resource generation does not match its PackageLock',
      );
    }
    const sink = new BoundedOciResourceSink(generation);
    try {
      await this.#inspect(lock, sink);
      return sink.reader();
    } catch (error) {
      sink.abort();
      return preserveOciResolutionError(error);
    }
  }

  #remember(
    lockDigest: string,
    value: Readonly<ResolvedStage>,
  ): Readonly<ResolvedStage> {
    if (this.#cache.has(lockDigest)) this.#cache.delete(lockDigest);
    this.#cache.set(lockDigest, value);
    while (this.#cache.size > MAX_CACHED_EVIDENCE) {
      this.#cache.delete(this.#cache.keys().next().value!);
    }
    return value;
  }

  async stage(
    lockValue: Readonly<PluginPackageLock>,
  ): Promise<Readonly<PluginPackageStageEvidence>> {
    const lock = normalizePluginPackageLock(lockValue);
    const resolved =
      this.#cache.get(lock.lockDigest) ??
      this.#remember(lock.lockDigest, await this.#resolve(lock));
    return resolved.stage;
  }

  async publisherEvidence(
    lockValue: Readonly<PluginPackageLock>,
    stageValue: Readonly<PluginPackageStageEvidence>,
  ): Promise<Readonly<PluginPackagePublisherSignatureEvidence>> {
    const lock = normalizePluginPackageLock(lockValue);
    const stage = normalizePluginPackageStageEvidence(stageValue);
    const resolved =
      this.#cache.get(lock.lockDigest) ??
      this.#remember(lock.lockDigest, await this.#resolve(lock));
    const expected = resolved.stage;
    if (
      stage.stageRef !== expected.stageRef ||
      stage.artifactDigest !== expected.artifactDigest ||
      stage.manifestDigest !== expected.manifestDigest ||
      stage.contentDigest !== expected.contentDigest ||
      stage.evidenceDigest !== expected.evidenceDigest
    ) {
      throw new InvalidPluginPackageInstallError(
        'stage evidence does not match publisher verification',
      );
    }
    return resolved.publisher;
  }

  async verify(
    lockValue: Readonly<PluginPackageLock>,
    receiptValue: Readonly<PluginPackageStageReceipt>,
  ): Promise<void> {
    const lock = normalizePluginPackageLock(lockValue);
    const resolved =
      this.#cache.get(lock.lockDigest) ??
      this.#remember(lock.lockDigest, await this.#resolve(lock));
    const expected = resolved.stage;
    if (
      receiptValue.stageRef !== expected.stageRef ||
      receiptValue.artifactDigest !== expected.artifactDigest ||
      receiptValue.manifestDigest !== expected.manifestDigest ||
      receiptValue.contentDigest !== expected.contentDigest ||
      receiptValue.evidenceDigest !== expected.evidenceDigest
    ) {
      throw new InvalidPluginPackageInstallError(
        'durable OCI stage receipt does not match source evidence',
      );
    }
  }
}

export interface ClusterPluginPackageOciResourceByteSourceOptions {
  readonly authority: ClusterPluginPackageOciStageAuthority;
  readonly lockSource: PluginPackageResourceLockSource;
}

export class ClusterPluginPackageOciResourceByteSource
  implements PluginPackageResourceByteSource
{
  readonly #authority: ClusterPluginPackageOciStageAuthority;
  readonly #lockSource: PluginPackageResourceLockSource;

  constructor(options: ClusterPluginPackageOciResourceByteSourceOptions) {
    const value = dataRecord(options, 'OCI resource source options');
    exactKeys(
      value,
      ['authority', 'lockSource'],
      [],
      'OCI resource source options',
    );
    if (
      !(options.authority instanceof ClusterPluginPackageOciStageAuthority) ||
      !options.lockSource ||
      typeof options.lockSource !== 'object' ||
      typeof options.lockSource.findLock !== 'function'
    ) {
      throw new TypeError('Plugin Package OCI resource source is invalid');
    }
    this.#authority = options.authority;
    this.#lockSource = options.lockSource;
    Object.freeze(this);
  }

  async open(
    generationValue: Readonly<PluginPackageResourceGeneration>,
  ): Promise<PluginPackageResourceByteReader> {
    const generation =
      normalizePluginPackageResourceGeneration(generationValue);
    const lock = await this.#lockSource.findLock(generation.lockDigest);
    if (lock === null) {
      throw new InvalidPluginPackageInstallError(
        'active OCI resource generation lock is missing',
      );
    }
    return this.#authority.openResourceReader(lock, generation);
  }
}

export function clusterPluginPackageActivationEvidence(
  intent: Readonly<PluginPackageActivationIntent>,
): Readonly<ClusterPluginPackageStageEvidence> {
  if (
    !DIGEST.test(intent.lockDigest) ||
    !DIGEST.test(intent.stageReceiptDigest) ||
    !DIGEST.test(intent.stageEvidenceDigest) ||
    !DIGEST.test(intent.contentDigest)
  ) {
    throw new PluginPackageActivationConflictError();
  }
  return Object.freeze({
    lockDigest: intent.lockDigest,
    stageRef: intent.stageRef,
    stageReceiptDigest: intent.stageReceiptDigest,
    stageEvidenceDigest: intent.stageEvidenceDigest,
    contentDigest: intent.contentDigest,
  });
}

export function pluginPackageStageVerificationFailure(error: unknown): never {
  if (error instanceof PluginPackageInstallUnavailableError) {
    throw new PluginPackageActivationUnavailableError({
      cause: error,
    });
  }
  throw new PluginPackageActivationConflictError();
}

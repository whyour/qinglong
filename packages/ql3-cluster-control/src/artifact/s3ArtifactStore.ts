// Artifact owns immutable S3 evidence, checksum validation, and conditional promotion.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ChecksumAlgorithm,
  ChecksumMode,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  MetadataDirective,
  PutObjectCommand,
  S3Client,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import {
  MAX_REMOTE_WORKER_ARTIFACT_BYTES,
  REMOTE_WORKER_ARTIFACT_CONTENT_TYPE,
  normalizeRemoteWorkerArtifactReceipt,
  type RemoteWorkerArtifactReceipt,
} from '@qinglong/runtime-core/remote-worker-completion';
import type {
  ClusterRemoteWorkerArtifactLookup,
  ClusterRemoteWorkerArtifactStorageCommand,
  ClusterRemoteWorkerArtifactStore,
} from '../remote-execution/remoteWorkerCompletionService';

const DEFAULT_PREFIX = 'qinglong/v3/worker-artifacts';
const METADATA_SCHEMA = 'qinglong-remote-worker-artifact-v1';
const TEMPORARY_METADATA_SCHEMA =
  'qinglong-remote-worker-artifact-temporary-v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_=-]{0,254}$/;
const TEMPORARY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type S3SendClient = Pick<S3Client, 'send'>;

export type S3ClusterRemoteWorkerArtifactEncryption =
  | Readonly<{ readonly mode: 's3' }>
  | Readonly<{ readonly mode: 'kms'; readonly keyId: string }>;

export interface S3ClusterRemoteWorkerArtifactStoreDiagnostic {
  readonly operation: 'temporary_object_cleanup';
}

export interface S3ClusterRemoteWorkerArtifactStoreOptions {
  readonly client: S3SendClient;
  readonly bucket: string;
  readonly prefix?: string;
  readonly expectedBucketOwner?: string;
  readonly encryption: S3ClusterRemoteWorkerArtifactEncryption;
  readonly createTemporaryId?: () => string;
  readonly onDiagnostic?: (
    error: unknown,
    context: Readonly<S3ClusterRemoteWorkerArtifactStoreDiagnostic>,
  ) => void | Promise<void>;
}

export interface S3ClusterRemoteWorkerArtifactClientOptions {
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
}

export function createS3ClusterRemoteWorkerArtifactClient(
  options: S3ClusterRemoteWorkerArtifactClientOptions,
): S3Client {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.region) ||
    (options.endpoint !== undefined &&
      typeof options.endpoint !== 'string') ||
    (options.forcePathStyle !== undefined &&
      typeof options.forcePathStyle !== 'boolean')
  ) {
    throw configurationError('client options are invalid');
  }
  return new S3Client({
    region: options.region,
    ...(options.endpoint === undefined
      ? {}
      : { endpoint: options.endpoint }),
    forcePathStyle: options.forcePathStyle ?? false,
  });
}

export class S3ClusterRemoteWorkerArtifactStoreError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'integrity_mismatch',
    options?: ErrorOptions,
  ) {
    super(`S3 Remote Worker Artifact store failed: ${reason}`, options);
    this.name = 'S3ClusterRemoteWorkerArtifactStoreError';
  }
}

interface PreparedOptions {
  readonly client: S3SendClient;
  readonly bucket: string;
  readonly prefix: string;
  readonly expectedBucketOwner?: string;
  readonly encryption: Readonly<{
    readonly ServerSideEncryption: 'AES256' | 'aws:kms';
    readonly SSEKMSKeyId?: string;
  }>;
  readonly createTemporaryId: () => string;
  readonly onDiagnostic?: S3ClusterRemoteWorkerArtifactStoreOptions['onDiagnostic'];
}

type ArtifactAuthority = Readonly<{
  projectId: string;
  runId: string;
  attemptId: string;
  logArtifactId: string;
}>;

type NormalizedStorageCommand = ArtifactAuthority &
  Readonly<{
    byteLength: number;
    truncated?: boolean;
  }>;

const DIAGNOSTIC_CONTEXT = Object.freeze({
  operation: 'temporary_object_cleanup' as const,
});

function configurationError(message: string): TypeError {
  return new TypeError(`S3 Remote Worker Artifact store is invalid: ${message}`);
}

function prepareOptions(
  options: S3ClusterRemoteWorkerArtifactStoreOptions,
): PreparedOptions {
  const allowedKeys = new Set([
    'bucket',
    'client',
    'createTemporaryId',
    'encryption',
    'expectedBucketOwner',
    'onDiagnostic',
    'prefix',
  ]);
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !allowedKeys.has(key)) ||
    typeof options.client?.send !== 'function'
  ) {
    throw configurationError('options are invalid');
  }
  if (
    !BUCKET_PATTERN.test(options.bucket) ||
    options.bucket.includes('..') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(options.bucket)
  ) {
    throw configurationError('bucket is invalid');
  }
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  if (
    !PREFIX_PATTERN.test(prefix) ||
    prefix.startsWith('/') ||
    prefix.endsWith('/') ||
    prefix.includes('//') ||
    prefix.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw configurationError('prefix is invalid');
  }
  if (
    options.expectedBucketOwner !== undefined &&
    !/^\d{12}$/.test(options.expectedBucketOwner)
  ) {
    throw configurationError('expected bucket owner is invalid');
  }
  const encryption = options.encryption;
  if (!encryption || typeof encryption !== 'object' || Array.isArray(encryption)) {
    throw configurationError('encryption is required');
  }
  let preparedEncryption: PreparedOptions['encryption'];
  if (
    encryption.mode === 's3' &&
    Object.keys(encryption).length === 1
  ) {
    preparedEncryption = Object.freeze({
      ServerSideEncryption: ServerSideEncryption.AES256,
    });
  } else if (
    encryption.mode === 'kms' &&
    Object.keys(encryption).length === 2 &&
    typeof encryption.keyId === 'string' &&
    encryption.keyId.length >= 1 &&
    encryption.keyId.length <= 2048 &&
    !/[\u0000-\u001f\u007f]/.test(encryption.keyId)
  ) {
    preparedEncryption = Object.freeze({
      ServerSideEncryption: ServerSideEncryption.aws_kms,
      SSEKMSKeyId: encryption.keyId,
    });
  } else {
    throw configurationError('encryption is invalid');
  }
  if (
    options.createTemporaryId !== undefined &&
    typeof options.createTemporaryId !== 'function'
  ) {
    throw configurationError('temporary ID factory is invalid');
  }
  if (
    options.onDiagnostic !== undefined &&
    typeof options.onDiagnostic !== 'function'
  ) {
    throw configurationError('diagnostic sink is invalid');
  }
  return Object.freeze({
    client: options.client,
    bucket: options.bucket,
    prefix,
    ...(options.expectedBucketOwner === undefined
      ? {}
      : { expectedBucketOwner: options.expectedBucketOwner }),
    encryption: preparedEncryption,
    createTemporaryId: options.createTemporaryId ?? randomUUID,
    ...(options.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: options.onDiagnostic }),
  });
}

function receiptCandidate(
  authority: ArtifactAuthority,
  byteLength: number,
  sha256: string,
  truncated?: boolean,
  status: RemoteWorkerArtifactReceipt['status'] = 'stored',
): Readonly<RemoteWorkerArtifactReceipt> {
  return normalizeRemoteWorkerArtifactReceipt({
    status,
    ...authority,
    byteLength,
    sha256,
    ...(truncated === undefined ? {} : { truncated }),
  });
}

function exactObjectShape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationError(`${name} is invalid`);
  }
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw configurationError(`${name} shape is invalid`);
  }
}

function normalizeStorageCommand(
  command: Readonly<ClusterRemoteWorkerArtifactStorageCommand>,
): NormalizedStorageCommand {
  exactObjectShape(
    command,
    ['attemptId', 'byteLength', 'logArtifactId', 'projectId', 'runId'],
    ['truncated'],
    'storage command',
  );
  const normalized = receiptCandidate(
    command as unknown as ClusterRemoteWorkerArtifactStorageCommand,
    command.byteLength as number,
    '0'.repeat(64),
    command.truncated as boolean | undefined,
  );
  return Object.freeze({
    projectId: normalized.projectId,
    runId: normalized.runId,
    attemptId: normalized.attemptId,
    logArtifactId: normalized.logArtifactId,
    byteLength: normalized.byteLength,
    ...(normalized.truncated === undefined
      ? {}
      : { truncated: normalized.truncated }),
  });
}

function normalizeLookup(
  lookup: Readonly<ClusterRemoteWorkerArtifactLookup>,
): ArtifactAuthority {
  exactObjectShape(
    lookup,
    ['attemptId', 'logArtifactId', 'projectId', 'runId'],
    [],
    'lookup',
  );
  const normalized = receiptCandidate(
    lookup as unknown as ClusterRemoteWorkerArtifactLookup,
    0,
    '0'.repeat(64),
  );
  return Object.freeze({
    projectId: normalized.projectId,
    runId: normalized.runId,
    attemptId: normalized.attemptId,
    logArtifactId: normalized.logArtifactId,
  });
}

function lookupFromCommand(
  command: NormalizedStorageCommand,
): ArtifactAuthority {
  return Object.freeze({
    projectId: command.projectId,
    runId: command.runId,
    attemptId: command.attemptId,
    logArtifactId: command.logArtifactId,
  });
}

function identityDigest(authority: ArtifactAuthority): string {
  return createHash('sha256')
    .update('qinglong/remote-worker-artifact-identity@v1\0', 'utf8')
    .update(authority.projectId, 'utf8')
    .update('\0', 'utf8')
    .update(authority.runId, 'utf8')
    .update('\0', 'utf8')
    .update(authority.attemptId, 'utf8')
    .update('\0', 'utf8')
    .update(authority.logArtifactId, 'utf8')
    .digest('hex');
}

function fieldDigest(domain: string, value: string): string {
  return createHash('sha256')
    .update(`qinglong/remote-worker-artifact-${domain}@v1\0`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function finalObjectKey(prefix: string, authority: ArtifactAuthority): string {
  const digest = identityDigest(authority);
  return `${prefix}/objects/${digest.slice(0, 2)}/${digest}`;
}

function temporaryObjectKey(prefix: string, createId: () => string): string {
  const id = createId();
  if (typeof id !== 'string' || !TEMPORARY_ID_PATTERN.test(id)) {
    throw new S3ClusterRemoteWorkerArtifactStoreError('unavailable');
  }
  return `${prefix}/temporary/${id}`;
}

function temporaryOwnershipDigest(): string {
  const authority = randomBytes(32);
  try {
    return createHash('sha256')
      .update('qinglong/remote-worker-artifact-temporary-owner@v1\0', 'utf8')
      .update(authority)
      .digest('hex');
  } finally {
    authority.fill(0);
  }
}

function finalMetadata(
  command: NormalizedStorageCommand,
  sha256: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    'ql3-schema': METADATA_SCHEMA,
    'ql3-project-sha256': fieldDigest('project', command.projectId),
    'ql3-run-sha256': fieldDigest('run', command.runId),
    'ql3-attempt-sha256': fieldDigest('attempt', command.attemptId),
    'ql3-log-artifact-sha256': fieldDigest(
      'log-artifact',
      command.logArtifactId,
    ),
    'ql3-byte-length': String(command.byteLength),
    'ql3-content-sha256': sha256,
    'ql3-truncated': command.truncated === undefined
      ? 'omitted'
      : String(command.truncated),
  });
}

function canonicalChecksum(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 44) {
    throw new S3ClusterRemoteWorkerArtifactStoreError('integrity_mismatch');
  }
  const decoded = Buffer.from(value, 'base64');
  try {
    if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
      throw new S3ClusterRemoteWorkerArtifactStoreError('integrity_mismatch');
    }
    return decoded.toString('hex');
  } finally {
    decoded.fill(0);
  }
}

function metadataValue(
  metadata: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string {
  const value = metadata?.[name];
  if (typeof value !== 'string') {
    throw new S3ClusterRemoteWorkerArtifactStoreError('integrity_mismatch');
  }
  return value;
}

function parseStoredReceipt(
  authority: ArtifactAuthority,
  output: Readonly<{
    ContentLength?: number | undefined;
    ContentType?: string | undefined;
    ChecksumSHA256?: string | undefined;
    Metadata?: Readonly<Record<string, string | undefined>> | undefined;
  }>,
): Readonly<RemoteWorkerArtifactReceipt> {
  const metadata = output.Metadata;
  const lengthText = metadataValue(metadata, 'ql3-byte-length');
  const byteLength = Number(lengthText);
  const sha256 = metadataValue(metadata, 'ql3-content-sha256');
  const truncatedText = metadataValue(metadata, 'ql3-truncated');
  if (
    metadataValue(metadata, 'ql3-schema') !== METADATA_SCHEMA ||
    metadataValue(metadata, 'ql3-project-sha256') !==
      fieldDigest('project', authority.projectId) ||
    metadataValue(metadata, 'ql3-run-sha256') !==
      fieldDigest('run', authority.runId) ||
    metadataValue(metadata, 'ql3-attempt-sha256') !==
      fieldDigest('attempt', authority.attemptId) ||
    metadataValue(metadata, 'ql3-log-artifact-sha256') !==
      fieldDigest('log-artifact', authority.logArtifactId) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > MAX_REMOTE_WORKER_ARTIFACT_BYTES ||
    lengthText !== String(byteLength) ||
    output.ContentLength !== byteLength ||
    output.ContentType !== REMOTE_WORKER_ARTIFACT_CONTENT_TYPE ||
    !SHA256_PATTERN.test(sha256) ||
    canonicalChecksum(output.ChecksumSHA256) !== sha256 ||
    !['omitted', 'true', 'false'].includes(truncatedText)
  ) {
    throw new S3ClusterRemoteWorkerArtifactStoreError('integrity_mismatch');
  }
  return receiptCandidate(
    authority,
    byteLength,
    sha256,
    truncatedText === 'omitted' ? undefined : truncatedText === 'true',
    'already_stored',
  );
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return value.name === 'NotFound' ||
    value.name === 'NoSuchKey' ||
    value.Code === 'NoSuchKey' ||
    value.$metadata?.httpStatusCode === 404;
}

function requestOptions(signal?: AbortSignal): { abortSignal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { abortSignal: signal };
}

function copySource(bucket: string, key: string): string {
  return [bucket, ...key.split('/')]
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

class ArtifactContentDigest {
  private readonly hash = createHash('sha256');
  private consumedBytes = 0;
  private complete = false;
  private digestValue?: string;

  constructor(
    private readonly content: AsyncIterable<Uint8Array>,
    private readonly expectedBytes: number,
    private readonly signal?: AbortSignal,
  ) {
    if (!content || typeof content[Symbol.asyncIterator] !== 'function') {
      throw new S3ClusterRemoteWorkerArtifactStoreError('unavailable');
    }
  }

  async *stream(): AsyncGenerator<Buffer> {
    if (this.complete || this.consumedBytes !== 0) {
      throw new S3ClusterRemoteWorkerArtifactStoreError('unavailable');
    }
    if (this.signal?.aborted) throw this.signal.reason;
    for await (const chunk of this.content) {
      if (this.signal?.aborted) throw this.signal.reason;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
        throw new S3ClusterRemoteWorkerArtifactStoreError('integrity_mismatch');
      }
      this.consumedBytes += chunk.byteLength;
      if (this.consumedBytes > this.expectedBytes) {
        throw new S3ClusterRemoteWorkerArtifactStoreError('integrity_mismatch');
      }
      this.hash.update(chunk);
      yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (this.consumedBytes !== this.expectedBytes) {
      throw new S3ClusterRemoteWorkerArtifactStoreError('integrity_mismatch');
    }
    if (this.signal?.aborted) throw this.signal.reason;
    this.digestValue = this.hash.digest('hex');
    this.complete = true;
  }

  async consume(): Promise<string> {
    for await (const _chunk of this.stream()) {
      // Hash a replay without allocating or contacting object storage.
    }
    return this.digest();
  }

  digest(): string {
    if (!this.complete || !this.digestValue) {
      throw new S3ClusterRemoteWorkerArtifactStoreError('unavailable');
    }
    return this.digestValue;
  }

  isComplete(): boolean {
    return this.complete;
  }
}

/**
 * Shared immutable S3 adapter. A unique temporary upload is checksummed first,
 * then promoted by one destination-conditional server-side copy. Permanent
 * objects are never overwritten or deleted by this adapter.
 */
export class S3ClusterRemoteWorkerArtifactStore
  implements ClusterRemoteWorkerArtifactStore {
  private readonly options: PreparedOptions;

  constructor(options: S3ClusterRemoteWorkerArtifactStoreOptions) {
    this.options = prepareOptions(options);
  }

  async inspect(
    lookup: Readonly<ClusterRemoteWorkerArtifactLookup>,
    signal?: AbortSignal,
  ): Promise<Readonly<RemoteWorkerArtifactReceipt> | undefined> {
    const authority = normalizeLookup(lookup);
    if (signal?.aborted) throw signal.reason;
    try {
      const output = await this.options.client.send(
        new HeadObjectCommand({
          Bucket: this.options.bucket,
          Key: finalObjectKey(this.options.prefix, authority),
          ChecksumMode: ChecksumMode.ENABLED,
          ...(this.options.expectedBucketOwner === undefined
            ? {}
            : { ExpectedBucketOwner: this.options.expectedBucketOwner }),
        }),
        requestOptions(signal),
      );
      return parseStoredReceipt(authority, output);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error instanceof S3ClusterRemoteWorkerArtifactStoreError) throw error;
      throw new S3ClusterRemoteWorkerArtifactStoreError('unavailable', {
        cause: error,
      });
    }
  }

  async put(
    value: Readonly<ClusterRemoteWorkerArtifactStorageCommand>,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<Readonly<RemoteWorkerArtifactReceipt>> {
    const command = normalizeStorageCommand(value);
    const digest = new ArtifactContentDigest(
      content,
      command.byteLength,
      signal,
    );
    const lookup = lookupFromCommand(command);
    const existing = await this.inspect(lookup, signal);
    if (existing) {
      const incomingSha256 = await digest.consume();
      if (
        existing.byteLength !== command.byteLength ||
        existing.truncated !== command.truncated ||
        existing.sha256 !== incomingSha256
      ) {
        throw new S3ClusterRemoteWorkerArtifactStoreError(
          'integrity_mismatch',
        );
      }
      return existing;
    }

    const temporaryKey = temporaryObjectKey(
      this.options.prefix,
      this.options.createTemporaryId,
    );
    const temporaryOwner = temporaryOwnershipDigest();
    let temporaryOwned = false;
    let result: Readonly<RemoteWorkerArtifactReceipt> | undefined;
    let primaryError: unknown;
    try {
      const body = Readable.from(digest.stream(), { objectMode: false });
      try {
        await this.options.client.send(
          new PutObjectCommand({
            Bucket: this.options.bucket,
            Key: temporaryKey,
            Body: body,
            ContentLength: command.byteLength,
            ContentType: REMOTE_WORKER_ARTIFACT_CONTENT_TYPE,
            ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
            IfNoneMatch: '*',
            Metadata: {
              'ql3-schema': TEMPORARY_METADATA_SCHEMA,
              'ql3-owner-sha256': temporaryOwner,
            },
            ...this.options.encryption,
            ...(this.options.expectedBucketOwner === undefined
              ? {}
              : { ExpectedBucketOwner: this.options.expectedBucketOwner }),
          }),
          requestOptions(signal),
        );
        temporaryOwned = true;
      } catch (error) {
        if (!digest.isComplete()) throw error;
      } finally {
        body.destroy();
      }
      const sha256 = digest.digest();
      await this.assertTemporaryObject(
        temporaryKey,
        temporaryOwner,
        command.byteLength,
        sha256,
        signal,
      );
      temporaryOwned = true;

      let copied = false;
      try {
        await this.options.client.send(
          new CopyObjectCommand({
            Bucket: this.options.bucket,
            Key: finalObjectKey(this.options.prefix, command),
            CopySource: copySource(this.options.bucket, temporaryKey),
            ContentType: REMOTE_WORKER_ARTIFACT_CONTENT_TYPE,
            MetadataDirective: MetadataDirective.REPLACE,
            Metadata: finalMetadata(command, sha256),
            ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
            IfNoneMatch: '*',
            ...this.options.encryption,
            ...(this.options.expectedBucketOwner === undefined
              ? {}
              : {
                  ExpectedBucketOwner: this.options.expectedBucketOwner,
                  CopySourceExpectedBucketOwner:
                    this.options.expectedBucketOwner,
                }),
          }),
          requestOptions(signal),
        );
        copied = true;
      } catch {
        // A 409/412 race or a lost successful response is resolved only by
        // inspecting the immutable destination below.
      }
      const stored = await this.inspect(lookup, signal);
      if (
        !stored ||
        stored.byteLength !== command.byteLength ||
        stored.truncated !== command.truncated ||
        stored.sha256 !== sha256
      ) {
        throw new S3ClusterRemoteWorkerArtifactStoreError(
          'integrity_mismatch',
        );
      }
      result = Object.freeze({
        ...stored,
        status: copied ? 'stored' as const : 'already_stored' as const,
      });
    } catch (error) {
      primaryError = error;
    }

    if (temporaryOwned) {
      try {
        await this.options.client.send(
          new DeleteObjectCommand({
            Bucket: this.options.bucket,
            Key: temporaryKey,
            ...(this.options.expectedBucketOwner === undefined
              ? {}
              : { ExpectedBucketOwner: this.options.expectedBucketOwner }),
          }),
          requestOptions(signal),
        );
      } catch (error) {
        if (primaryError === undefined) {
          try {
            await this.options.onDiagnostic?.(error, DIAGNOSTIC_CONTEXT);
          } catch {
            // Diagnostics cannot reverse a durable immutable promotion.
          }
        }
      }
    }
    if (primaryError !== undefined) {
      if (primaryError instanceof S3ClusterRemoteWorkerArtifactStoreError) {
        throw primaryError;
      }
      throw new S3ClusterRemoteWorkerArtifactStoreError('unavailable', {
        cause: primaryError,
      });
    }
    return result!;
  }

  private async assertTemporaryObject(
    key: string,
    ownerSha256: string,
    byteLength: number,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let output;
    try {
      output = await this.options.client.send(
        new HeadObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          ChecksumMode: ChecksumMode.ENABLED,
          ...(this.options.expectedBucketOwner === undefined
            ? {}
            : { ExpectedBucketOwner: this.options.expectedBucketOwner }),
        }),
        requestOptions(signal),
      );
    } catch (error) {
      throw new S3ClusterRemoteWorkerArtifactStoreError('unavailable', {
        cause: error,
      });
    }
    if (
      output.ContentLength !== byteLength ||
      output.ContentType !== REMOTE_WORKER_ARTIFACT_CONTENT_TYPE ||
      output.Metadata?.['ql3-schema'] !== TEMPORARY_METADATA_SCHEMA ||
      output.Metadata?.['ql3-owner-sha256'] !== ownerSha256 ||
      canonicalChecksum(output.ChecksumSHA256) !== sha256
    ) {
      throw new S3ClusterRemoteWorkerArtifactStoreError(
        'integrity_mismatch',
      );
    }
  }
}

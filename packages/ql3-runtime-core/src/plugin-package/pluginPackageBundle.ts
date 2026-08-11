import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from 'node:crypto';

import {
  MAX_PLUGIN_PACKAGE_CONTENT_ENTRIES,
  MAX_PLUGIN_PACKAGE_MANIFEST_BYTES,
  type PluginPackageManifest,
  normalizePluginPackageManifest,
} from './pluginPackage';
import {
  type PluginPackageLock,
  normalizePluginPackageLock,
  pluginPackageManifestDigest,
  serializePluginPackageManifest,
} from './installation/pluginPackageInstall';

export const PLUGIN_PACKAGE_BUNDLE_MEDIA_TYPE =
  'application/vnd.qinglong.package.v1+tar' as const;
export const PLUGIN_PACKAGE_SIGNATURE_SCHEMA =
  'qinglong/plugin-package-signature@v1' as const;
export const PLUGIN_PACKAGE_SIGNATURE_PAYLOAD_SCHEMA =
  'qinglong/plugin-package-signature-payload@v1' as const;
export const PLUGIN_PACKAGE_CONTENT_TREE_SCHEMA =
  'qinglong/plugin-package-content-tree@v1' as const;
export const MAX_PLUGIN_PACKAGE_BUNDLE_BYTES = 256 * 1024 * 1024;
export const MAX_PLUGIN_PACKAGE_BUNDLE_ENTRY_BYTES = 4 * 1024 * 1024;
export const MAX_PLUGIN_PACKAGE_BUNDLE_CONTENT_BYTES = 64 * 1024 * 1024;
export const MAX_PLUGIN_PACKAGE_BUNDLE_CHUNK_BYTES = 1024 * 1024;
export const MAX_PLUGIN_PACKAGE_PUBLISHER_KEYS = 32;
export const MAX_PLUGIN_PACKAGE_PUBLISHER_KEY_BYTES = 8 * 1024;

const TAR_BLOCK_BYTES = 512;
const TAR_END_BLOCKS = 2;
const PACKAGE_MANIFEST_PATH = 'package.json';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PUBLISHER_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const BASE64URL_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const CONTENT_TREE_DOMAIN = Buffer.from(
  `${PLUGIN_PACKAGE_CONTENT_TREE_SCHEMA}\0`,
  'utf8',
);

export interface PluginPackageContentEntryDescriptor {
  readonly path: string;
  readonly bytes: number;
  readonly digest: string;
}

export interface PluginPackagePublisherKeyDefinition {
  readonly publisher: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}

export interface PluginPackageSignature {
  readonly schema: typeof PLUGIN_PACKAGE_SIGNATURE_SCHEMA;
  readonly publisher: string;
  readonly keyId: string;
  readonly signature: string;
}

export interface PluginPackagePublisherSignatureEvidence {
  readonly publisher: string;
  readonly keyId: string;
  readonly signatureDigest: string;
  readonly keyNotBeforeMs: number;
  readonly keyNotAfterMs: number;
  readonly verifiedAtMs: number;
}

export interface PluginPackageBundleEntry {
  readonly path: string;
  readonly bytes: number;
  readonly digest: string;
}

export interface PluginPackageBundleInspection {
  readonly mediaType: typeof PLUGIN_PACKAGE_BUNDLE_MEDIA_TYPE;
  readonly lockDigest: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactBytes: number;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly contentBytes: number;
  readonly contentDigest: string;
  readonly entries: readonly Readonly<PluginPackageBundleEntry>[];
  readonly signature: Readonly<PluginPackagePublisherSignatureEvidence>;
}

export interface PluginPackageBundleSink {
  begin(entry: Readonly<{ path: string; bytes: number }>): void | Promise<void>;
  write(chunk: Uint8Array): void | Promise<void>;
  end(entry: Readonly<PluginPackageBundleEntry>): void | Promise<void>;
  commit(
    inspection: Readonly<PluginPackageBundleInspection>,
  ): void | Promise<void>;
  abort(): void | Promise<void>;
}

export interface InspectPluginPackageBundleOptions {
  readonly lock: PluginPackageLock;
  readonly manifest: PluginPackageManifest;
  readonly signature: PluginPackageSignature;
  readonly trust: PluginPackagePublisherTrustRegistry;
  readonly observedAtMs: number;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly sink?: PluginPackageBundleSink;
}

export class InvalidPluginPackageBundleError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_BUNDLE_INVALID';

  constructor(message: string) {
    super(`Plugin Package bundle is invalid: ${message}`);
    this.name = 'InvalidPluginPackageBundleError';
  }
}

export class InvalidPluginPackagePublisherTrustError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_TRUST_INVALID';

  constructor(message: string) {
    super(`Plugin Package publisher trust is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePublisherTrustError';
  }
}

export class UntrustedPluginPackagePublisherError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_UNTRUSTED';

  constructor() {
    super('Plugin Package publisher signature is not trusted');
    this.name = 'UntrustedPluginPackagePublisherError';
  }
}

export class PluginPackageBundleUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_BUNDLE_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package bundle inspection is unavailable', options);
    this.name = 'PluginPackageBundleUnavailableError';
  }
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
  ErrorType:
    | typeof InvalidPluginPackageBundleError
    | typeof InvalidPluginPackagePublisherTrustError,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new ErrorType(`${label} shape is invalid`);
  }
}

function exactKeysWithOptional(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  ErrorType:
    | typeof InvalidPluginPackageBundleError
    | typeof InvalidPluginPackagePublisherTrustError,
): void {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !actual.includes(key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw new ErrorType(`${label} shape is invalid`);
  }
}

function record(
  value: unknown,
  label: string,
  ErrorType:
    | typeof InvalidPluginPackageBundleError
    | typeof InvalidPluginPackagePublisherTrustError,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ErrorType(`${label} must be an object`);
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
    throw new ErrorType(`${label} must contain enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

function timestamp(
  value: unknown,
  label: string,
  ErrorType:
    | typeof InvalidPluginPackageBundleError
    | typeof InvalidPluginPackagePublisherTrustError,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ErrorType(`${label} is invalid`);
  }
  return value as number;
}

function digest(
  value: unknown,
  label: string,
  ErrorType:
    | typeof InvalidPluginPackageBundleError
    | typeof InvalidPluginPackagePublisherTrustError,
): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new ErrorType(`${label} is invalid`);
  }
  return value;
}

function boundedEntryBytes(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_PLUGIN_PACKAGE_BUNDLE_ENTRY_BYTES
  ) {
    throw new InvalidPluginPackageBundleError(`${label} is invalid`);
  }
  return value as number;
}

function fourByteUnsigned(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function eightByteUnsigned(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function normalizeEntryDescriptors(
  values: readonly PluginPackageContentEntryDescriptor[],
): readonly Readonly<PluginPackageContentEntryDescriptor>[] {
  if (
    !Array.isArray(values) ||
    values.length > MAX_PLUGIN_PACKAGE_CONTENT_ENTRIES
  ) {
    throw new InvalidPluginPackageBundleError(
      'content entry descriptors are invalid',
    );
  }
  let total = 0;
  let previousPath: string | undefined;
  const normalized = values.map((value, index) => {
    const entry = record(
      value,
      'content entry descriptor',
      InvalidPluginPackageBundleError,
    );
    exactKeys(
      entry,
      ['path', 'bytes', 'digest'],
      'content entry descriptor',
      InvalidPluginPackageBundleError,
    );
    if (
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      Buffer.byteLength(entry.path, 'utf8') > 255 ||
      entry.path === PACKAGE_MANIFEST_PATH ||
      entry.path.startsWith('/') ||
      entry.path.includes('\\') ||
      entry.path.includes('\0') ||
      entry.path
        .split('/')
        .some(
          (segment) => segment === '' || segment === '.' || segment === '..',
        )
    ) {
      throw new InvalidPluginPackageBundleError(
        'content entry path is invalid',
      );
    }
    if (index > 0 && previousPath !== undefined && previousPath >= entry.path) {
      throw new InvalidPluginPackageBundleError(
        'content entry descriptors must be unique and sorted',
      );
    }
    const bytes = boundedEntryBytes(entry.bytes, 'content entry bytes');
    previousPath = entry.path;
    total += bytes;
    if (total > MAX_PLUGIN_PACKAGE_BUNDLE_CONTENT_BYTES) {
      throw new InvalidPluginPackageBundleError(
        'content entries exceed their total byte budget',
      );
    }
    return Object.freeze({
      path: entry.path,
      bytes,
      digest: digest(
        entry.digest,
        'content entry digest',
        InvalidPluginPackageBundleError,
      ),
    });
  });
  return Object.freeze(normalized);
}

export function pluginPackageContentTreeDigest(
  entries: readonly PluginPackageContentEntryDescriptor[],
): string {
  const normalized = normalizeEntryDescriptors(entries);
  const hash = createHash('sha256').update(CONTENT_TREE_DOMAIN);
  hash.update(fourByteUnsigned(normalized.length));
  for (const entry of normalized) {
    const pathBytes = Buffer.from(entry.path, 'utf8');
    hash.update(fourByteUnsigned(pathBytes.byteLength));
    hash.update(pathBytes);
    hash.update(eightByteUnsigned(entry.bytes));
    hash.update(Buffer.from(entry.digest, 'hex'));
  }
  return hash.digest('hex');
}

function normalizePublisher(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 253 ||
    !PUBLISHER_PATTERN.test(value)
  ) {
    throw new InvalidPluginPackagePublisherTrustError(
      'publisher identity is invalid',
    );
  }
  return value;
}

function normalizeKeyId(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    throw new InvalidPluginPackagePublisherTrustError('key id is invalid');
  }
  return value;
}

function normalizeSignature(
  value: PluginPackageSignature,
): Readonly<PluginPackageSignature> {
  const signature = record(
    value,
    'signature',
    InvalidPluginPackagePublisherTrustError,
  );
  exactKeys(
    signature,
    ['schema', 'publisher', 'keyId', 'signature'],
    'signature',
    InvalidPluginPackagePublisherTrustError,
  );
  if (signature.schema !== PLUGIN_PACKAGE_SIGNATURE_SCHEMA) {
    throw new InvalidPluginPackagePublisherTrustError(
      'signature schema is unsupported',
    );
  }
  if (
    typeof signature.signature !== 'string' ||
    !BASE64URL_SIGNATURE_PATTERN.test(signature.signature)
  ) {
    throw new InvalidPluginPackagePublisherTrustError(
      'signature bytes are invalid',
    );
  }
  const bytes = Buffer.from(signature.signature, 'base64url');
  if (
    bytes.byteLength !== 64 ||
    bytes.toString('base64url') !== signature.signature
  ) {
    throw new InvalidPluginPackagePublisherTrustError(
      'signature bytes are not canonical',
    );
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
    publisher: normalizePublisher(signature.publisher),
    keyId: normalizeKeyId(signature.keyId),
    signature: signature.signature,
  });
}

function signaturePayloadObject(
  lock: Readonly<PluginPackageLock>,
  publisher: string,
  keyId: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema: PLUGIN_PACKAGE_SIGNATURE_PAYLOAD_SCHEMA,
    publisher,
    keyId,
    lockDigest: lock.lockDigest,
    packageName: lock.packageName,
    packageVersion: lock.packageVersion,
    artifactDigest: lock.source.artifactDigest,
    artifactBytes: lock.source.artifactBytes,
    manifestDigest: lock.manifestDigest,
    contentDigest: lock.source.contentDigest,
  });
}

export function pluginPackagePublisherSignaturePayload(
  lockValue: PluginPackageLock,
  publisherValue: string,
  keyIdValue: string,
): Buffer {
  const lock = normalizePluginPackageLock(lockValue);
  const publisher = normalizePublisher(publisherValue);
  const keyId = normalizeKeyId(keyIdValue);
  return Buffer.from(
    JSON.stringify(signaturePayloadObject(lock, publisher, keyId)),
    'utf8',
  );
}

interface TrustedPublisherKey {
  readonly definition: Readonly<PluginPackagePublisherKeyDefinition>;
  readonly key: KeyObject;
}

export class PluginPackagePublisherTrustRegistry {
  readonly size: number;
  readonly #keys = new Map<string, TrustedPublisherKey>();

  constructor(definitions: readonly PluginPackagePublisherKeyDefinition[]) {
    if (
      !Array.isArray(definitions) ||
      definitions.length === 0 ||
      definitions.length > MAX_PLUGIN_PACKAGE_PUBLISHER_KEYS
    ) {
      throw new InvalidPluginPackagePublisherTrustError(
        'publisher key definitions are invalid',
      );
    }
    for (const value of definitions) {
      const definition = record(
        value,
        'publisher key definition',
        InvalidPluginPackagePublisherTrustError,
      );
      exactKeys(
        definition,
        ['publisher', 'keyId', 'publicKeyPem', 'notBeforeMs', 'notAfterMs'],
        'publisher key definition',
        InvalidPluginPackagePublisherTrustError,
      );
      const publisher = normalizePublisher(definition.publisher);
      const keyId = normalizeKeyId(definition.keyId);
      const identifier = `${publisher}\0${keyId}`;
      if (this.#keys.has(identifier)) {
        throw new InvalidPluginPackagePublisherTrustError(
          'publisher key is duplicated',
        );
      }
      if (
        typeof definition.publicKeyPem !== 'string' ||
        definition.publicKeyPem.length === 0 ||
        definition.publicKeyPem.includes('\0') ||
        Buffer.byteLength(definition.publicKeyPem, 'utf8') >
          MAX_PLUGIN_PACKAGE_PUBLISHER_KEY_BYTES
      ) {
        throw new InvalidPluginPackagePublisherTrustError(
          'publisher public key is invalid',
        );
      }
      const notBeforeMs = timestamp(
        definition.notBeforeMs,
        'publisher key notBeforeMs',
        InvalidPluginPackagePublisherTrustError,
      );
      const notAfterMs = timestamp(
        definition.notAfterMs,
        'publisher key notAfterMs',
        InvalidPluginPackagePublisherTrustError,
      );
      if (notAfterMs <= notBeforeMs) {
        throw new InvalidPluginPackagePublisherTrustError(
          'publisher key lifetime is invalid',
        );
      }
      let key: KeyObject;
      try {
        key = createPublicKey(definition.publicKeyPem);
      } catch {
        throw new InvalidPluginPackagePublisherTrustError(
          'publisher public key cannot be parsed',
        );
      }
      if (key.asymmetricKeyType !== 'ed25519') {
        throw new InvalidPluginPackagePublisherTrustError(
          'publisher public key must use Ed25519',
        );
      }
      this.#keys.set(
        identifier,
        Object.freeze({
          definition: Object.freeze({
            publisher,
            keyId,
            publicKeyPem: definition.publicKeyPem,
            notBeforeMs,
            notAfterMs,
          }),
          key,
        }),
      );
    }
    this.size = this.#keys.size;
    Object.freeze(this);
  }

  verify(
    lockValue: PluginPackageLock,
    signatureValue: PluginPackageSignature,
    observedAtMsValue: number,
  ): Readonly<PluginPackagePublisherSignatureEvidence> {
    const lock = normalizePluginPackageLock(lockValue);
    const signature = normalizeSignature(signatureValue);
    const observedAtMs = timestamp(
      observedAtMsValue,
      'signature observation time',
      InvalidPluginPackagePublisherTrustError,
    );
    const trusted = this.#keys.get(
      `${signature.publisher}\0${signature.keyId}`,
    );
    if (
      !trusted ||
      observedAtMs < trusted.definition.notBeforeMs ||
      observedAtMs >= trusted.definition.notAfterMs
    ) {
      throw new UntrustedPluginPackagePublisherError();
    }
    const signatureBytes = Buffer.from(signature.signature, 'base64url');
    const payload = pluginPackagePublisherSignaturePayload(
      lock,
      signature.publisher,
      signature.keyId,
    );
    if (!verify(null, payload, trusted.key, signatureBytes)) {
      throw new UntrustedPluginPackagePublisherError();
    }
    return Object.freeze({
      publisher: signature.publisher,
      keyId: signature.keyId,
      signatureDigest: createHash('sha256')
        .update(signatureBytes)
        .digest('hex'),
      keyNotBeforeMs: trusted.definition.notBeforeMs,
      keyNotAfterMs: trusted.definition.notAfterMs,
      verifiedAtMs: observedAtMs,
    });
  }
}

export function verifyPluginPackagePublisherSignature(
  lock: PluginPackageLock,
  signature: PluginPackageSignature,
  trust: PluginPackagePublisherTrustRegistry,
  observedAtMs: number,
): Readonly<PluginPackagePublisherSignatureEvidence> {
  if (!(trust instanceof PluginPackagePublisherTrustRegistry)) {
    throw new InvalidPluginPackagePublisherTrustError(
      'publisher trust registry is invalid',
    );
  }
  return trust.verify(lock, signature, observedAtMs);
}

class ArtifactByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  readonly #expectedBytes: number;
  readonly #hash = createHash('sha256');
  readonly #queue: Buffer[] = [];
  #queueOffset = 0;
  #receivedBytes = 0;
  #ended = false;

  constructor(chunks: AsyncIterable<Uint8Array>, expectedBytes: number) {
    if (
      !chunks ||
      typeof chunks !== 'object' ||
      typeof chunks[Symbol.asyncIterator] !== 'function'
    ) {
      throw new InvalidPluginPackageBundleError(
        'bundle chunks must be an async iterable',
      );
    }
    this.#iterator = chunks[Symbol.asyncIterator]();
    this.#expectedBytes = expectedBytes;
  }

  get receivedBytes(): number {
    return this.#receivedBytes;
  }

  artifactDigest(): string {
    if (!this.#ended || this.bufferedBytes() !== 0) {
      throw new InvalidPluginPackageBundleError(
        'artifact digest requested before exact end',
      );
    }
    return this.#hash.digest('hex');
  }

  private bufferedBytes(): number {
    return this.#queue.reduce(
      (total, chunk, index) =>
        total + chunk.byteLength - (index === 0 ? this.#queueOffset : 0),
      0,
    );
  }

  private async pull(): Promise<boolean> {
    if (this.#ended) return false;
    const next = await this.#iterator.next();
    if (next.done) {
      this.#ended = true;
      return false;
    }
    if (
      !(next.value instanceof Uint8Array) ||
      next.value.byteLength === 0 ||
      next.value.byteLength > MAX_PLUGIN_PACKAGE_BUNDLE_CHUNK_BYTES
    ) {
      throw new InvalidPluginPackageBundleError(
        'bundle chunk is empty, oversized or not bytes',
      );
    }
    const chunk = Buffer.from(next.value);
    this.#receivedBytes += chunk.byteLength;
    if (this.#receivedBytes > this.#expectedBytes) {
      throw new InvalidPluginPackageBundleError(
        'bundle exceeds the locked artifact byte length',
      );
    }
    this.#hash.update(chunk);
    this.#queue.push(chunk);
    return true;
  }

  async readExact(bytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new InvalidPluginPackageBundleError(
        'bundle read length is invalid',
      );
    }
    const output = Buffer.allocUnsafe(bytes);
    let written = 0;
    while (written < bytes) {
      if (this.#queue.length === 0 && !(await this.pull())) {
        throw new InvalidPluginPackageBundleError(
          'bundle ended before its declared archive boundary',
        );
      }
      const current = this.#queue[0]!;
      const available = current.byteLength - this.#queueOffset;
      const consumed = Math.min(available, bytes - written);
      current.copy(
        output,
        written,
        this.#queueOffset,
        this.#queueOffset + consumed,
      );
      written += consumed;
      this.#queueOffset += consumed;
      if (this.#queueOffset === current.byteLength) {
        this.#queue.shift();
        this.#queueOffset = 0;
      }
    }
    return output;
  }

  async finish(): Promise<void> {
    if (this.bufferedBytes() !== 0) {
      throw new InvalidPluginPackageBundleError(
        'bundle contains trailing bytes after the end blocks',
      );
    }
    while (await this.pull()) {
      if (this.bufferedBytes() !== 0) {
        throw new InvalidPluginPackageBundleError(
          'bundle contains trailing bytes after the end blocks',
        );
      }
    }
    if (this.#receivedBytes !== this.#expectedBytes) {
      throw new InvalidPluginPackageBundleError(
        'bundle byte length does not match its PackageLock',
      );
    }
  }

  async close(): Promise<void> {
    await this.#iterator.return?.();
  }
}

function allZero(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0);
}

function fixedAscii(value: Buffer, expected: string, label: string): void {
  if (!value.equals(Buffer.from(expected, 'ascii'))) {
    throw new InvalidPluginPackageBundleError(`tar ${label} is not canonical`);
  }
}

function tarText(value: Buffer, label: string, allowEmpty = false): string {
  const terminator = value.indexOf(0);
  const length = terminator === -1 ? value.byteLength : terminator;
  if (
    (!allowEmpty && length === 0) ||
    (terminator !== -1 && !allZero(value.subarray(terminator)))
  ) {
    throw new InvalidPluginPackageBundleError(`tar ${label} is not canonical`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      value.subarray(0, length),
    );
  } catch {
    throw new InvalidPluginPackageBundleError(
      `tar ${label} is not valid UTF-8`,
    );
  }
}

function tarSize(value: Buffer): number {
  const text = value.toString('ascii');
  if (!/^[0-7]{11}\0$/.test(text)) {
    throw new InvalidPluginPackageBundleError(
      'tar entry size is not canonical octal',
    );
  }
  const size = Number.parseInt(text.slice(0, -1), 8);
  return boundedEntryBytes(size, 'tar entry size');
}

function canonicalTarPath(
  value: string,
): Readonly<{ name: string; prefix: string }> {
  if (Buffer.byteLength(value, 'utf8') <= 100) {
    return Object.freeze({ name: value, prefix: '' });
  }
  const separators = [...value.matchAll(/\//g)]
    .map((match) => match.index)
    .filter((index): index is number => index !== undefined)
    .reverse();
  for (const separator of separators) {
    const prefix = value.slice(0, separator);
    const name = value.slice(separator + 1);
    if (
      Buffer.byteLength(prefix, 'utf8') <= 155 &&
      Buffer.byteLength(name, 'utf8') <= 100
    ) {
      return Object.freeze({ name, prefix });
    }
  }
  throw new InvalidPluginPackageBundleError(
    'tar path cannot use canonical USTAR fields',
  );
}

function tarHeader(header: Buffer): Readonly<{ path: string; bytes: number }> {
  const checksumText = header.subarray(148, 156).toString('ascii');
  if (!/^[0-7]{6}\0 $/.test(checksumText)) {
    throw new InvalidPluginPackageBundleError(
      'tar checksum field is not canonical',
    );
  }
  const expectedChecksum = Number.parseInt(checksumText.slice(0, 6), 8);
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const actualChecksum = checksumHeader.reduce(
    (total, byte) => total + byte,
    0,
  );
  if (actualChecksum !== expectedChecksum) {
    throw new InvalidPluginPackageBundleError(
      'tar header checksum does not match',
    );
  }
  fixedAscii(header.subarray(100, 108), '0000644\0', 'mode');
  fixedAscii(header.subarray(108, 116), '0000000\0', 'uid');
  fixedAscii(header.subarray(116, 124), '0000000\0', 'gid');
  fixedAscii(header.subarray(136, 148), '00000000000\0', 'mtime');
  fixedAscii(header.subarray(156, 157), '0', 'entry type');
  fixedAscii(header.subarray(257, 263), 'ustar\0', 'magic');
  fixedAscii(header.subarray(263, 265), '00', 'version');
  if (
    !allZero(header.subarray(157, 257)) ||
    !allZero(header.subarray(265, 345)) ||
    !allZero(header.subarray(500, 512))
  ) {
    throw new InvalidPluginPackageBundleError(
      'tar header contains unsupported link, owner or device metadata',
    );
  }
  const name = tarText(header.subarray(0, 100), 'name');
  const prefix = tarText(header.subarray(345, 500), 'prefix', true);
  const path = prefix.length === 0 ? name : `${prefix}/${name}`;
  if (
    Buffer.byteLength(path, 'utf8') > 255 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new InvalidPluginPackageBundleError('tar path is unsafe');
  }
  const canonicalPath = canonicalTarPath(path);
  if (name !== canonicalPath.name || prefix !== canonicalPath.prefix) {
    throw new InvalidPluginPackageBundleError(
      'tar path fields are not canonical',
    );
  }
  return Object.freeze({ path, bytes: tarSize(header.subarray(124, 136)) });
}

function manifestContentPaths(
  manifest: Readonly<PluginPackageManifest>,
): readonly string[] {
  const paths = [
    ...manifest.spec.contents.tasks,
    ...manifest.spec.contents.workflows,
    ...manifest.spec.contents.prompts,
    ...manifest.spec.contents.tools,
  ].sort();
  if (new Set(paths).size !== paths.length) {
    throw new InvalidPluginPackageBundleError('manifest content paths overlap');
  }
  return Object.freeze(paths);
}

function preserveInspectionError(error: unknown): never {
  if (
    error instanceof InvalidPluginPackageBundleError ||
    error instanceof InvalidPluginPackagePublisherTrustError ||
    error instanceof UntrustedPluginPackagePublisherError
  ) {
    throw error;
  }
  throw new PluginPackageBundleUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export async function inspectPluginPackageBundle(
  optionsValue: InspectPluginPackageBundleOptions,
): Promise<Readonly<PluginPackageBundleInspection>> {
  const options = record(
    optionsValue,
    'inspection options',
    InvalidPluginPackageBundleError,
  );
  exactKeysWithOptional(
    options,
    ['lock', 'manifest', 'signature', 'trust', 'observedAtMs', 'chunks'],
    ['sink'],
    'inspection options',
    InvalidPluginPackageBundleError,
  );
  const lock = normalizePluginPackageLock(optionsValue.lock);
  if (
    lock.source.artifactBytes < TAR_BLOCK_BYTES * TAR_END_BLOCKS ||
    lock.source.artifactBytes > MAX_PLUGIN_PACKAGE_BUNDLE_BYTES
  ) {
    throw new InvalidPluginPackageBundleError(
      'locked artifact byte length exceeds the bundle budget',
    );
  }
  const manifest = normalizePluginPackageManifest(optionsValue.manifest);
  const canonicalManifest = Buffer.from(
    serializePluginPackageManifest(manifest),
    'utf8',
  );
  if (
    canonicalManifest.byteLength > MAX_PLUGIN_PACKAGE_MANIFEST_BYTES ||
    pluginPackageManifestDigest(manifest) !== lock.manifestDigest ||
    manifest.metadata.name !== lock.packageName ||
    manifest.metadata.version !== lock.packageVersion
  ) {
    throw new InvalidPluginPackageBundleError(
      'manifest does not match its PackageLock',
    );
  }
  if (!(optionsValue.trust instanceof PluginPackagePublisherTrustRegistry)) {
    throw new InvalidPluginPackagePublisherTrustError(
      'publisher trust registry is invalid',
    );
  }
  const observedAtMs = timestamp(
    optionsValue.observedAtMs,
    'inspection time',
    InvalidPluginPackageBundleError,
  );
  const expectedPaths = [
    PACKAGE_MANIFEST_PATH,
    ...manifestContentPaths(manifest),
  ];
  const sink = optionsValue.sink;
  if (
    sink !== undefined &&
    (!sink ||
      typeof sink !== 'object' ||
      typeof sink.begin !== 'function' ||
      typeof sink.write !== 'function' ||
      typeof sink.end !== 'function' ||
      typeof sink.commit !== 'function' ||
      typeof sink.abort !== 'function')
  ) {
    throw new InvalidPluginPackageBundleError('bundle sink is invalid');
  }
  const reader = new ArtifactByteReader(
    optionsValue.chunks,
    lock.source.artifactBytes,
  );
  const entries: PluginPackageBundleEntry[] = [];
  let contentBytes = 0;
  let committed = false;
  try {
    for (const expectedPath of expectedPaths) {
      const header = await reader.readExact(TAR_BLOCK_BYTES);
      if (allZero(header)) {
        throw new InvalidPluginPackageBundleError(
          'tar ended before every manifest content entry',
        );
      }
      const entry = tarHeader(header);
      if (entry.path !== expectedPath) {
        throw new InvalidPluginPackageBundleError(
          'tar entries are missing, extra or not in canonical order',
        );
      }
      if (
        entry.path === PACKAGE_MANIFEST_PATH &&
        entry.bytes !== canonicalManifest.byteLength
      ) {
        throw new InvalidPluginPackageBundleError(
          'tar package manifest byte length is not canonical',
        );
      }
      if (entry.path !== PACKAGE_MANIFEST_PATH) {
        contentBytes += entry.bytes;
        if (contentBytes > MAX_PLUGIN_PACKAGE_BUNDLE_CONTENT_BYTES) {
          throw new InvalidPluginPackageBundleError(
            'tar content exceeds its total byte budget',
          );
        }
      }
      await sink?.begin(entry);
      const entryHash = createHash('sha256');
      let remaining = entry.bytes;
      let manifestOffset = 0;
      while (remaining > 0) {
        const chunk = await reader.readExact(Math.min(remaining, 64 * 1024));
        entryHash.update(chunk);
        if (
          entry.path === PACKAGE_MANIFEST_PATH &&
          !chunk.equals(
            canonicalManifest.subarray(
              manifestOffset,
              manifestOffset + chunk.byteLength,
            ),
          )
        ) {
          throw new InvalidPluginPackageBundleError(
            'tar package manifest is not the canonical locked manifest',
          );
        }
        manifestOffset += chunk.byteLength;
        remaining -= chunk.byteLength;
        await sink?.write(chunk);
      }
      const padding =
        (TAR_BLOCK_BYTES - (entry.bytes % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (padding > 0 && !allZero(await reader.readExact(padding))) {
        throw new InvalidPluginPackageBundleError(
          'tar entry padding is not zero',
        );
      }
      const inspectedEntry = Object.freeze({
        path: entry.path,
        bytes: entry.bytes,
        digest: entryHash.digest('hex'),
      });
      if (
        entry.path === PACKAGE_MANIFEST_PATH &&
        inspectedEntry.digest !== lock.manifestDigest
      ) {
        throw new InvalidPluginPackageBundleError(
          'tar package manifest digest does not match',
        );
      }
      entries.push(inspectedEntry);
      await sink?.end(inspectedEntry);
    }
    for (let index = 0; index < TAR_END_BLOCKS; index += 1) {
      if (!allZero(await reader.readExact(TAR_BLOCK_BYTES))) {
        throw new InvalidPluginPackageBundleError(
          'tar does not end with exactly two zero blocks',
        );
      }
    }
    await reader.finish();
    const artifactDigest = reader.artifactDigest();
    if (artifactDigest !== lock.source.artifactDigest) {
      throw new InvalidPluginPackageBundleError(
        'bundle artifact digest does not match its PackageLock',
      );
    }
    const contentEntries = entries.slice(1);
    const contentDigest = pluginPackageContentTreeDigest(contentEntries);
    if (contentDigest !== lock.source.contentDigest) {
      throw new InvalidPluginPackageBundleError(
        'bundle content tree digest does not match its PackageLock',
      );
    }
    const signature = verifyPluginPackagePublisherSignature(
      lock,
      optionsValue.signature,
      optionsValue.trust,
      observedAtMs,
    );
    const inspection = Object.freeze({
      mediaType: PLUGIN_PACKAGE_BUNDLE_MEDIA_TYPE,
      lockDigest: lock.lockDigest,
      packageName: lock.packageName,
      packageVersion: lock.packageVersion,
      artifactBytes: reader.receivedBytes,
      artifactDigest,
      manifestDigest: lock.manifestDigest,
      contentBytes,
      contentDigest,
      entries: Object.freeze(entries),
      signature,
    });
    await sink?.commit(inspection);
    committed = true;
    return inspection;
  } catch (error) {
    return preserveInspectionError(error);
  } finally {
    await reader.close().catch(() => undefined);
    if (!committed) {
      await Promise.resolve(sink?.abort()).catch(() => undefined);
    }
  }
}

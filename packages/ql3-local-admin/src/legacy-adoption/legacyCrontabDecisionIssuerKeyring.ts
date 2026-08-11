// Legacy Adoption owns the bounded issuer-key lifecycle for reviewed decisions.
import { createHash, randomBytes } from 'node:crypto';
import fs, { constants } from 'node:fs';
import path from 'node:path';
import {
  assertLocalSecretKeyId,
  type LocalSecretKeyMaterial,
  type LocalSecretKeyProvider,
} from '@qinglong/runtime-core/local-secret';

export const MAX_LEGACY_CRONTAB_DECISION_ISSUER_KEYS = 8;

const MAX_PATH_BYTES = 4096;
const MAX_KEYRING_BYTES = 16 * 1024;
const KEY_BYTES = 32;
const KEY_ID_PREFIX = 'qladk-';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

interface DirectoryIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: number;
  readonly mode: number;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: number;
  readonly mode: number;
  readonly size: bigint;
}

interface LegacyCrontabDecisionIssuerKeyringManifest {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-crontab-decision-issuer-keyring';
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
}

interface LoadedManifest {
  readonly manifest: LegacyCrontabDecisionIssuerKeyringManifest;
  readonly identity: FileIdentity;
}

export interface LegacyCrontabDecisionIssuerKeyringSummary {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-crontab-decision-issuer-keyring-summary';
  readonly activeKeyId: string;
  readonly keyIds: readonly string[];
  readonly keyCount: number;
  readonly keyringDigest: string;
}

export interface RotateLegacyCrontabDecisionIssuerKeyringOptions {
  readonly filePath: string;
  readonly expectedActiveKeyId: string;
  readonly expectedKeyringDigest: string;
}

export class LegacyCrontabDecisionIssuerKeyringConfigurationError extends TypeError {
  readonly code =
    'LEGACY_CRONTAB_DECISION_ISSUER_KEYRING_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(
      `Legacy Crontab decision issuer keyring configuration is invalid: ${message}`,
    );
    this.name = 'LegacyCrontabDecisionIssuerKeyringConfigurationError';
  }
}

export class LegacyCrontabDecisionIssuerKeyringUnavailableError extends Error {
  readonly code = 'LEGACY_CRONTAB_DECISION_ISSUER_KEYRING_UNAVAILABLE';

  constructor(readonly cause?: unknown) {
    super('Legacy Crontab decision issuer keyring is unavailable');
    this.name = 'LegacyCrontabDecisionIssuerKeyringUnavailableError';
  }
}

export class LegacyCrontabDecisionIssuerKeyringConflictError extends Error {
  readonly code = 'LEGACY_CRONTAB_DECISION_ISSUER_KEYRING_CONFLICT';

  constructor() {
    super('Legacy Crontab decision issuer keyring state changed');
    this.name = 'LegacyCrontabDecisionIssuerKeyringConflictError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function keyringPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') < 1 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LegacyCrontabDecisionIssuerKeyringConfigurationError(
      'filePath must be normalized, bounded and absolute',
    );
  }
  return value;
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function'
  ) {
    throw new LegacyCrontabDecisionIssuerKeyringConfigurationError(
      'POSIX user identity is unavailable',
    );
  }
  const uid = process.getuid();
  const effectiveUid = process.geteuid();
  if (!Number.isSafeInteger(uid) || uid < 0 || uid !== effectiveUid) {
    throw new LegacyCrontabDecisionIssuerKeyringConfigurationError(
      'real and effective POSIX users must match',
    );
  }
  return uid;
}

function directoryIdentity(filePath: string): DirectoryIdentity {
  const uid = currentUid();
  const directory = path.dirname(filePath);
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError(error);
  }
  const mode = Number(stat.mode) & 0o777;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    mode !== 0o700
  ) {
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
  }
  return Object.freeze({
    path: directory,
    device: stat.dev,
    inode: stat.ino,
    uid,
    mode,
  });
}

function confirmDirectory(expected: DirectoryIdentity): void {
  const current = directoryIdentity(path.join(expected.path, '.identity'));
  if (
    current.path !== expected.path ||
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.uid !== expected.uid ||
    current.mode !== expected.mode
  ) {
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
  }
}

function keyId(value: unknown): string {
  try {
    assertLocalSecretKeyId(value as string);
  } catch {
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
  }
  if (typeof value !== 'string' || !value.startsWith(KEY_ID_PREFIX)) {
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
  }
  return value;
}

function newKeyId(): string {
  return `${KEY_ID_PREFIX}${randomBytes(12).toString('base64url')}`;
}

function parseManifest(
  contents: Buffer,
): LegacyCrontabDecisionIssuerKeyringManifest {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString('utf8'));
  } catch {
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['activeKeyId', 'keys', 'kind', 'schemaVersion'])
  ) {
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.kind !== 'qinglong3-legacy-crontab-decision-issuer-keyring' ||
    !candidate.keys ||
    typeof candidate.keys !== 'object' ||
    Array.isArray(candidate.keys)
  ) {
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
  }
  const entries = Object.entries(candidate.keys as Record<string, unknown>);
  if (
    entries.length < 1 ||
    entries.length > MAX_LEGACY_CRONTAB_DECISION_ISSUER_KEYS
  ) {
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
  }
  const keys: Record<string, string> = Object.create(null);
  for (const [candidateKeyId, encoded] of entries) {
    let decoded: Buffer | undefined;
    try {
      const normalizedKeyId = keyId(candidateKeyId);
      decoded =
        typeof encoded === 'string'
          ? Buffer.from(encoded, 'base64url')
          : Buffer.alloc(0);
      if (
        typeof encoded !== 'string' ||
        !BASE64URL_PATTERN.test(encoded) ||
        decoded.byteLength !== KEY_BYTES ||
        decoded.toString('base64url') !== encoded
      ) {
        throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
      }
      keys[normalizedKeyId] = encoded;
    } finally {
      decoded?.fill(0);
    }
  }
  const activeKeyId = keyId(candidate.activeKeyId);
  if (!keys[activeKeyId]) {
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'qinglong3-legacy-crontab-decision-issuer-keyring',
    activeKeyId,
    keys: Object.freeze(keys),
  });
}

function canonicalManifest(
  manifest: LegacyCrontabDecisionIssuerKeyringManifest,
): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-issuer-keyring',
      activeKeyId: manifest.activeKeyId,
      keys: Object.fromEntries(
        Object.entries(manifest.keys).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    })}\n`,
    'utf8',
  );
}

function summarize(
  manifest: LegacyCrontabDecisionIssuerKeyringManifest,
): Readonly<LegacyCrontabDecisionIssuerKeyringSummary> {
  const canonical = canonicalManifest(manifest);
  try {
    const keyIds = Object.freeze(Object.keys(manifest.keys).sort());
    return Object.freeze({
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-issuer-keyring-summary',
      activeKeyId: manifest.activeKeyId,
      keyIds,
      keyCount: keyIds.length,
      keyringDigest: createHash('sha256')
        .update('qinglong3.legacy-crontab-decision-issuer-keyring.v1\0', 'utf8')
        .update(canonical)
        .digest('hex'),
    });
  } finally {
    canonical.fill(0);
  }
}

function fileIdentity(stat: fs.BigIntStats): FileIdentity {
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    uid: Number(stat.uid),
    mode: Number(stat.mode) & 0o777,
    size: stat.size,
  });
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.size === right.size
  );
}

function loadManifest(
  filePath: string,
  parent: DirectoryIdentity,
): LoadedManifest {
  confirmDirectory(parent);
  const uid = currentUid();
  let descriptor: number | undefined;
  let contents: Buffer | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    const beforeIdentity = fileIdentity(before);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      beforeIdentity.uid !== uid ||
      beforeIdentity.mode !== 0o600 ||
      beforeIdentity.size < 1n ||
      beforeIdentity.size > BigInt(MAX_KEYRING_BYTES)
    ) {
      throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
    }
    descriptor = fs.openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const openedIdentity = fileIdentity(opened);
    if (!opened.isFile() || !sameFileIdentity(beforeIdentity, openedIdentity)) {
      throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
    }
    contents = fs.readFileSync(descriptor);
    if (contents.byteLength !== Number(openedIdentity.size)) {
      throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
    }
    const manifest = parseManifest(contents);
    confirmDirectory(parent);
    return Object.freeze({ manifest, identity: openedIdentity });
  } catch (error) {
    if (error instanceof LegacyCrontabDecisionIssuerKeyringUnavailableError) {
      throw error;
    }
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError(error);
  } finally {
    contents?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeTemporary(filePath: string, contents: Buffer): string {
  const temporaryPath = `${filePath}.tmp-${randomBytes(12).toString('hex')}`;
  const descriptor = fs.openSync(
    temporaryPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return temporaryPath;
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertCurrentFileIdentity(
  filePath: string,
  expected: FileIdentity,
): void {
  let current: fs.BigIntStats;
  try {
    current = fs.lstatSync(filePath, { bigint: true });
  } catch {
    throw new LegacyCrontabDecisionIssuerKeyringConflictError();
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    !sameFileIdentity(expected, fileIdentity(current))
  ) {
    throw new LegacyCrontabDecisionIssuerKeyringConflictError();
  }
}

function material(
  manifest: LegacyCrontabDecisionIssuerKeyringManifest,
  candidateKeyId: string,
): LocalSecretKeyMaterial | null {
  const encoded = manifest.keys[candidateKeyId];
  return encoded
    ? Object.freeze({
        keyId: candidateKeyId,
        key: Uint8Array.from(Buffer.from(encoded, 'base64url')),
      })
    : null;
}

export class LegacyCrontabDecisionIssuerKeyringFileProvider
  implements LocalSecretKeyProvider
{
  private readonly filePath: string;
  private readonly parent: DirectoryIdentity;

  constructor(candidatePath: string) {
    this.filePath = keyringPath(candidatePath);
    this.parent = directoryIdentity(this.filePath);
  }

  async active(): Promise<LocalSecretKeyMaterial> {
    const manifest = loadManifest(this.filePath, this.parent).manifest;
    return material(manifest, manifest.activeKeyId)!;
  }

  async resolve(
    candidateKeyId: string,
  ): Promise<LocalSecretKeyMaterial | null> {
    const normalizedKeyId = keyId(candidateKeyId);
    return material(
      loadManifest(this.filePath, this.parent).manifest,
      normalizedKeyId,
    );
  }

  async inspect(): Promise<
    Readonly<LegacyCrontabDecisionIssuerKeyringSummary>
  > {
    return summarize(loadManifest(this.filePath, this.parent).manifest);
  }
}

export async function provisionLegacyCrontabDecisionIssuerKeyring(
  candidatePath: string,
): Promise<Readonly<LegacyCrontabDecisionIssuerKeyringSummary>> {
  const filePath = keyringPath(candidatePath);
  const parent = directoryIdentity(filePath);
  const generatedKeyId = newKeyId();
  const key = randomBytes(KEY_BYTES);
  const manifest: LegacyCrontabDecisionIssuerKeyringManifest = Object.freeze({
    schemaVersion: 1,
    kind: 'qinglong3-legacy-crontab-decision-issuer-keyring',
    activeKeyId: generatedKeyId,
    keys: Object.freeze({ [generatedKeyId]: key.toString('base64url') }),
  });
  const contents = canonicalManifest(manifest);
  let temporaryPath: string | undefined;
  try {
    confirmDirectory(parent);
    temporaryPath = writeTemporary(filePath, contents);
    fs.linkSync(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
    temporaryPath = undefined;
    syncDirectory(parent.path);
    return summarize(manifest);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      throw new LegacyCrontabDecisionIssuerKeyringConflictError();
    }
    if (error instanceof LegacyCrontabDecisionIssuerKeyringConflictError) {
      throw error;
    }
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError(error);
  } finally {
    key.fill(0);
    contents.fill(0);
    if (temporaryPath) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup of an unpublished private inode.
      }
    }
  }
}

export async function rotateLegacyCrontabDecisionIssuerKeyring(
  options: RotateLegacyCrontabDecisionIssuerKeyringOptions,
): Promise<Readonly<LegacyCrontabDecisionIssuerKeyringSummary>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, [
      'expectedActiveKeyId',
      'expectedKeyringDigest',
      'filePath',
    ]) ||
    typeof options.expectedKeyringDigest !== 'string' ||
    !DIGEST_PATTERN.test(options.expectedKeyringDigest)
  ) {
    throw new LegacyCrontabDecisionIssuerKeyringConfigurationError(
      'rotation options are invalid',
    );
  }
  const filePath = keyringPath(options.filePath);
  const expectedActiveKeyId = keyId(options.expectedActiveKeyId);
  const parent = directoryIdentity(filePath);
  const lockPath = `${filePath}.lock`;
  let lockDescriptor: number | undefined;
  let temporaryPath: string | undefined;
  let key: Buffer | undefined;
  let contents: Buffer | undefined;
  try {
    lockDescriptor = fs.openSync(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.fsyncSync(lockDescriptor);
    const loaded = loadManifest(filePath, parent);
    const currentSummary = summarize(loaded.manifest);
    if (
      currentSummary.activeKeyId !== expectedActiveKeyId ||
      currentSummary.keyringDigest !== options.expectedKeyringDigest
    ) {
      throw new LegacyCrontabDecisionIssuerKeyringConflictError();
    }
    if (
      Object.keys(loaded.manifest.keys).length >=
      MAX_LEGACY_CRONTAB_DECISION_ISSUER_KEYS
    ) {
      throw new LegacyCrontabDecisionIssuerKeyringUnavailableError();
    }
    const nextKeyId = newKeyId();
    key = randomBytes(KEY_BYTES);
    const next: LegacyCrontabDecisionIssuerKeyringManifest = Object.freeze({
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-issuer-keyring',
      activeKeyId: nextKeyId,
      keys: Object.freeze({
        ...loaded.manifest.keys,
        [nextKeyId]: key.toString('base64url'),
      }),
    });
    contents = canonicalManifest(next);
    temporaryPath = writeTemporary(filePath, contents);
    confirmDirectory(parent);
    assertCurrentFileIdentity(filePath, loaded.identity);
    fs.renameSync(temporaryPath, filePath);
    temporaryPath = undefined;
    syncDirectory(parent.path);
    return summarize(next);
  } catch (error) {
    if (
      error instanceof LegacyCrontabDecisionIssuerKeyringConflictError ||
      error instanceof LegacyCrontabDecisionIssuerKeyringConfigurationError ||
      error instanceof LegacyCrontabDecisionIssuerKeyringUnavailableError
    ) {
      throw error;
    }
    throw new LegacyCrontabDecisionIssuerKeyringUnavailableError(error);
  } finally {
    key?.fill(0);
    contents?.fill(0);
    if (temporaryPath) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup of an unpublished private inode.
      }
    }
    if (lockDescriptor !== undefined) {
      fs.closeSync(lockDescriptor);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Best-effort cleanup after releasing our own lock descriptor.
      }
    }
  }
}

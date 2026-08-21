import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertLocalSecretKeyId,
  type LocalSecretKeyMaterial,
  type LocalSecretKeyProvider,
} from '@qinglong/runtime-core/local-secret';

import { LocalDeploymentConfigurationError } from '../../foundation/error';

const KEYRING_KIND = 'qinglong3-local-reconciliation-review-issuer-keyring';
const KEY_ID_PREFIX = 'qlrrk-';
const KEY_BYTES = 32;
const MAX_KEYRING_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 4_096;
export const MAX_LOCAL_RECONCILIATION_REVIEW_ISSUER_KEYS = 8;

interface IssuerKeyRecord {
  readonly generation: number;
  readonly keyId: string;
  readonly material: string;
}

interface IssuerKeyringManifest {
  readonly schemaVersion: 1;
  readonly kind: typeof KEYRING_KIND;
  readonly activeGeneration: number;
  readonly keys: readonly Readonly<IssuerKeyRecord>[];
}

export interface LocalReconciliationReviewIssuerKeyringSummary {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-local-reconciliation-review-issuer-keyring-summary';
  readonly activeGeneration: number;
  readonly activeKeyId: string;
  readonly keyCount: number;
  readonly keyringDigest: string;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation review issuer keyring ${message}`,
    { cause },
  );
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function'
  ) {
    configurationError('requires POSIX identity');
  }
  const uid = process.getuid();
  if (uid !== process.geteuid() || !Number.isSafeInteger(uid) || uid < 0) {
    configurationError('requires stable POSIX identity');
  }
  return uid;
}

function boundedPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    configurationError('path is invalid');
  }
  return value;
}

function assertParent(filePath: string, uid: number): fs.BigIntStats {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(path.dirname(filePath), { bigint: true });
  } catch (error) {
    configurationError('parent is unavailable', error);
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    (Number(stat.mode) & 0o777) !== 0o700 ||
    fs.realpathSync(path.dirname(filePath)) !== path.dirname(filePath)
  ) {
    configurationError('parent must be a canonical current-UID 0700 directory');
  }
  return stat;
}

function exact(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function parseManifest(bytes: Buffer): Readonly<IssuerKeyringManifest> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    configurationError('content is invalid', error);
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exact(value, ['activeGeneration', 'keys', 'kind', 'schemaVersion'])
  ) {
    configurationError('shape is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.kind !== KEYRING_KIND ||
    !Number.isSafeInteger(candidate.activeGeneration) ||
    (candidate.activeGeneration as number) < 1 ||
    !Array.isArray(candidate.keys) ||
    candidate.keys.length < 1 ||
    candidate.keys.length > MAX_LOCAL_RECONCILIATION_REVIEW_ISSUER_KEYS
  ) {
    configurationError('manifest is invalid');
  }
  const keys: IssuerKeyRecord[] = [];
  let previousGeneration = 0;
  for (const raw of candidate.keys) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      !exact(raw, ['generation', 'keyId', 'material'])
    ) {
      configurationError('key record shape is invalid');
    }
    const record = raw as Record<string, unknown>;
    let decoded: Buffer | undefined;
    try {
      assertLocalSecretKeyId(record.keyId as string);
      decoded =
        typeof record.material === 'string'
          ? Buffer.from(record.material, 'base64url')
          : Buffer.alloc(0);
      if (
        !Number.isSafeInteger(record.generation) ||
        (record.generation as number) !== previousGeneration + 1 ||
        typeof record.keyId !== 'string' ||
        !record.keyId.startsWith(KEY_ID_PREFIX) ||
        typeof record.material !== 'string' ||
        decoded.byteLength !== KEY_BYTES ||
        decoded.toString('base64url') !== record.material
      ) {
        configurationError('key record is invalid');
      }
      previousGeneration = record.generation as number;
      keys.push(
        Object.freeze({
          generation: previousGeneration,
          keyId: record.keyId,
          material: record.material,
        }),
      );
    } finally {
      decoded?.fill(0);
    }
  }
  if (candidate.activeGeneration !== previousGeneration) {
    configurationError('active generation is not the immutable tail');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: KEYRING_KIND,
    activeGeneration: previousGeneration,
    keys: Object.freeze(keys),
  });
}

function canonical(manifest: Readonly<IssuerKeyringManifest>): Buffer {
  return Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
}

function identity(stat: fs.BigIntStats): FileIdentity {
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNs: stat.mtimeNs,
    changedAtNs: stat.ctimeNs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs
  );
}

function load(filePath: string): Readonly<{
  manifest: Readonly<IssuerKeyringManifest>;
  identity: FileIdentity;
}> {
  const uid = currentUid();
  const parent = assertParent(filePath, uid);
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      (Number(before.mode) & 0o777) !== 0o600 ||
      before.nlink !== 1n ||
      before.size < 2n ||
      before.size > BigInt(MAX_KEYRING_BYTES)
    ) {
      configurationError('file identity is invalid');
    }
    const expected = identity(before);
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(expected, identity(opened))) {
      configurationError('file changed while opening');
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const currentParent = assertParent(filePath, uid);
    if (
      !sameIdentity(expected, identity(after)) ||
      parent.dev !== currentParent.dev ||
      parent.ino !== currentParent.ino
    ) {
      configurationError('authority changed while reading');
    }
    return Object.freeze({
      manifest: parseManifest(bytes),
      identity: expected,
    });
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('cannot be read', error);
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function summary(
  manifest: Readonly<IssuerKeyringManifest>,
): Readonly<LocalReconciliationReviewIssuerKeyringSummary> {
  const bytes = canonical(manifest);
  try {
    const active = manifest.keys[manifest.keys.length - 1]!;
    return Object.freeze({
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-review-issuer-keyring-summary',
      activeGeneration: manifest.activeGeneration,
      activeKeyId: active.keyId,
      keyCount: manifest.keys.length,
      keyringDigest: createHash('sha256')
        .update('qinglong3.local-reconciliation-review-issuer-keyring.v1\0')
        .update(bytes)
        .digest('hex'),
    });
  } finally {
    bytes.fill(0);
  }
}

function material(record: Readonly<IssuerKeyRecord>): LocalSecretKeyMaterial {
  return Object.freeze({
    keyId: record.keyId,
    key: Uint8Array.from(Buffer.from(record.material, 'base64url')),
  });
}

export class LocalReconciliationReviewIssuerKeyringFileProvider
  implements LocalSecretKeyProvider
{
  private readonly filePath: string;

  constructor(candidatePath: string) {
    this.filePath = boundedPath(candidatePath);
  }

  async active(): Promise<LocalSecretKeyMaterial> {
    const manifest = load(this.filePath).manifest;
    return material(manifest.keys[manifest.keys.length - 1]!);
  }

  async resolve(keyId: string): Promise<LocalSecretKeyMaterial | null> {
    try {
      assertLocalSecretKeyId(keyId);
    } catch (error) {
      configurationError('key id is invalid', error);
    }
    const record = load(this.filePath).manifest.keys.find(
      (candidate) => candidate.keyId === keyId,
    );
    return record ? material(record) : null;
  }

  inspect(): Readonly<LocalReconciliationReviewIssuerKeyringSummary> {
    return summary(load(this.filePath).manifest);
  }
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function ensureLocalReconciliationReviewIssuerKeyring(
  candidatePath: string,
): Readonly<LocalReconciliationReviewIssuerKeyringSummary> {
  const filePath = boundedPath(candidatePath);
  if (fs.existsSync(filePath)) return summary(load(filePath).manifest);
  const uid = currentUid();
  assertParent(filePath, uid);
  const key = randomBytes(KEY_BYTES);
  const keyId = `${KEY_ID_PREFIX}${randomBytes(12).toString('base64url')}`;
  const manifest: Readonly<IssuerKeyringManifest> = Object.freeze({
    schemaVersion: 1,
    kind: KEYRING_KIND,
    activeGeneration: 1,
    keys: Object.freeze([
      Object.freeze({
        generation: 1,
        keyId,
        material: key.toString('base64url'),
      }),
    ]),
  });
  const bytes = canonical(manifest);
  const stage = `${filePath}.ql3-reconciliation-review-stage`;
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(
      stage,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(stage, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    syncDirectory(path.dirname(filePath));
    fs.unlinkSync(stage);
    created = false;
    syncDirectory(path.dirname(filePath));
    return summary(load(filePath).manifest);
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('cannot be provisioned', error);
  } finally {
    key.fill(0);
    bytes.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) {
      try {
        fs.unlinkSync(stage);
      } catch {
        // An unpublished owner-only stage is fail-closed and recoverable.
      }
    }
  }
}

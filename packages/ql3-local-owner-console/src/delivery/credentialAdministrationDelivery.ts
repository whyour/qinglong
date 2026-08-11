import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertApiCredentialId } from '@qinglong/runtime-core/api-credential';
import {
  assertApiCredentialSecret,
  formatApiCredentialToken,
} from '@qinglong/runtime-core/api-credential-token';
import {
  assertProjectPolicyProjectId,
  normalizeProjectPolicySubject,
} from '@qinglong/runtime-core/project-policy';
import type { SecuritySubject } from '@qinglong/runtime-core/security';

const MAX_DIRECTORY_ENTRIES = 64;
const MAX_RECORD_BYTES = 4 * 1024;
const MAX_PRESENTATION_BYTES = 1024;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FILE_NAME_PATTERN =
  /^managed-credential-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(pending|ready)\.json$/;
const TEMP_NAME_PATTERN =
  /^\.managed-credential-([0-9a-f-]{36})\.([0-9a-f-]{36})\.tmp$/;

export interface LocalCredentialAdministrationDeliveryRecord {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-local-managed-credential-delivery';
  readonly mutationId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly subject: SecuritySubject;
  readonly credentialId: string;
  readonly secret: string;
  readonly notBeforeAtMs: number;
  readonly expiresAtMs: number;
}

export interface LocalCredentialAdministrationDeliverySummary {
  readonly mutationId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly subject: Readonly<SecuritySubject>;
  readonly credentialId: string;
  readonly deliveryDigest: string;
  readonly path: string;
}

interface PrivateFile {
  readonly value: unknown;
  readonly device: bigint;
  readonly inode: bigint;
  readonly digest: string;
}

export class LocalCredentialAdministrationDeliveryError extends Error {
  readonly code = 'LOCAL_CREDENTIAL_ADMINISTRATION_DELIVERY_FAILED';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local credential administration delivery failed: ${message}`);
    this.name = 'LocalCredentialAdministrationDeliveryError';
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

function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function uid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    throw new LocalCredentialAdministrationDeliveryError(
      'real and effective POSIX users must match',
    );
  }
  return process.getuid();
}

function normalizeRecord(
  value: LocalCredentialAdministrationDeliveryRecord,
): Readonly<LocalCredentialAdministrationDeliveryRecord> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'mutationId',
      'requestId',
      'projectId',
      'subject',
      'credentialId',
      'secret',
      'notBeforeAtMs',
      'expiresAtMs',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'qinglong3-local-managed-credential-delivery' ||
    !UUID_V4_PATTERN.test(value.mutationId) ||
    !REQUEST_ID_PATTERN.test(value.requestId)
  ) {
    throw new LocalCredentialAdministrationDeliveryError(
      'delivery record shape is invalid',
    );
  }
  let subject: Readonly<SecuritySubject>;
  try {
    assertProjectPolicyProjectId(value.projectId);
    subject = normalizeProjectPolicySubject(value.subject);
    assertApiCredentialId(value.credentialId);
    assertApiCredentialSecret(value.secret);
  } catch (error) {
    throw new LocalCredentialAdministrationDeliveryError(
      'delivery record identity is invalid',
      error,
    );
  }
  if (
    subject.type === 'system' ||
    subject.type === 'worker' ||
    !Number.isSafeInteger(value.notBeforeAtMs) ||
    value.notBeforeAtMs < 0 ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= value.notBeforeAtMs
  ) {
    throw new LocalCredentialAdministrationDeliveryError(
      'delivery record lifetime or subject is invalid',
    );
  }
  return Object.freeze({ ...value, subject });
}

function sameSemantic(
  left: Readonly<LocalCredentialAdministrationDeliveryRecord>,
  right: Readonly<LocalCredentialAdministrationDeliveryRecord>,
): boolean {
  return (
    left.mutationId === right.mutationId &&
    left.requestId === right.requestId &&
    left.projectId === right.projectId &&
    left.subject.type === right.subject.type &&
    left.subject.id === right.subject.id &&
    left.credentialId === right.credentialId &&
    left.expiresAtMs - left.notBeforeAtMs ===
      right.expiresAtMs - right.notBeforeAtMs
  );
}

function sameRecord(
  left: Readonly<LocalCredentialAdministrationDeliveryRecord>,
  right: Readonly<LocalCredentialAdministrationDeliveryRecord>,
): boolean {
  return sameSemantic(left, right) && left.secret === right.secret;
}

function recordDigest(
  record: Readonly<LocalCredentialAdministrationDeliveryRecord>,
): string {
  return createHash('sha256')
    .update('qinglong3.local-managed-credential-delivery.v1\0', 'utf8')
    .update(JSON.stringify(record), 'utf8')
    .digest('hex');
}

function pendingName(mutationId: string): string {
  return `managed-credential-${mutationId}.pending.json`;
}

function readyName(mutationId: string): string {
  return `managed-credential-${mutationId}.ready.json`;
}

function presentation(
  record: Readonly<LocalCredentialAdministrationDeliveryRecord>,
): Readonly<{
  schemaVersion: 1;
  kind: 'qinglong3-local-identity-credential-presentation';
  token: string;
}> {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'qinglong3-local-identity-credential-presentation',
    token: formatApiCredentialToken(record.credentialId, record.secret),
  });
}

function normalizePresentation(value: unknown): Readonly<{
  schemaVersion: 1;
  kind: 'qinglong3-local-identity-credential-presentation';
  token: string;
}> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['schemaVersion', 'kind', 'token'])
  ) {
    throw new LocalCredentialAdministrationDeliveryError(
      'credential presentation is invalid',
    );
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.kind !== 'qinglong3-local-identity-credential-presentation' ||
    typeof candidate.token !== 'string' ||
    candidate.token.length > 256
  ) {
    throw new LocalCredentialAdministrationDeliveryError(
      'credential presentation is invalid',
    );
  }
  return Object.freeze(
    candidate as {
      schemaVersion: 1;
      kind: 'qinglong3-local-identity-credential-presentation';
      token: string;
    },
  );
}

export class FileLocalCredentialAdministrationDelivery {
  private readonly ownerUid: number;
  private readonly device: bigint;
  private readonly inode: bigint;

  constructor(readonly directory: string) {
    if (
      typeof directory !== 'string' ||
      !path.isAbsolute(directory) ||
      path.parse(directory).root === directory ||
      path.normalize(directory) !== directory ||
      directory.includes('\0') ||
      Buffer.byteLength(directory, 'utf8') > 4096
    ) {
      throw new LocalCredentialAdministrationDeliveryError(
        'delivery directory path is invalid',
      );
    }
    this.ownerUid = uid();
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(directory, { bigint: true });
    } catch (error) {
      throw new LocalCredentialAdministrationDeliveryError(
        'delivery directory is unavailable',
        error,
      );
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      Number(stat.uid) !== this.ownerUid ||
      (Number(stat.mode) & 0o777) !== 0o700 ||
      fs.realpathSync(directory) !== directory
    ) {
      throw new LocalCredentialAdministrationDeliveryError(
        'delivery directory must be a canonical current-UID 0700 directory',
      );
    }
    this.device = stat.dev;
    this.inode = stat.ino;
  }

  private verifyDirectory(): void {
    const stat = fs.lstatSync(this.directory, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      Number(stat.uid) !== this.ownerUid ||
      (Number(stat.mode) & 0o777) !== 0o700 ||
      stat.dev !== this.device ||
      stat.ino !== this.inode
    ) {
      throw new LocalCredentialAdministrationDeliveryError(
        'delivery directory identity changed',
      );
    }
  }

  private entries(): readonly string[] {
    this.verifyDirectory();
    const entries = fs.readdirSync(this.directory);
    if (
      entries.length > MAX_DIRECTORY_ENTRIES ||
      entries.some(
        (name) =>
          !FILE_NAME_PATTERN.test(name) && !TEMP_NAME_PATTERN.test(name),
      )
    ) {
      throw new LocalCredentialAdministrationDeliveryError(
        'delivery directory contents are invalid or unbounded',
      );
    }
    return entries;
  }

  private syncDirectory(): void {
    const descriptor = fs.openSync(this.directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private read(name: string, maxBytes: number): PrivateFile {
    this.verifyDirectory();
    const filePath = path.join(this.directory, name);
    let descriptor: number | undefined;
    let material: Buffer | undefined;
    try {
      const before = fs.lstatSync(filePath, { bigint: true });
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        Number(before.uid) !== this.ownerUid ||
        (Number(before.mode) & 0o777) !== 0o600 ||
        before.size < 1n ||
        before.size > BigInt(maxBytes)
      ) {
        throw new LocalCredentialAdministrationDeliveryError(
          'delivery file is not a bounded private regular file',
        );
      }
      descriptor = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        Number(opened.uid) !== this.ownerUid ||
        (Number(opened.mode) & 0o777) !== 0o600
      ) {
        throw new LocalCredentialAdministrationDeliveryError(
          'delivery file identity changed while opening',
        );
      }
      material = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size
      ) {
        throw new LocalCredentialAdministrationDeliveryError(
          'delivery file identity changed while reading',
        );
      }
      const digest = createHash('sha256').update(material).digest('hex');
      return Object.freeze({
        value: JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(material),
        ) as unknown,
        device: opened.dev,
        inode: opened.ino,
        digest,
      });
    } catch (error) {
      if (error instanceof LocalCredentialAdministrationDeliveryError) {
        throw error;
      }
      throw new LocalCredentialAdministrationDeliveryError(
        'delivery file cannot be read',
        error,
      );
    } finally {
      material?.fill(0);
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  private optional(name: string, maxBytes: number): PrivateFile | null {
    try {
      return this.read(name, maxBytes);
    } catch (error) {
      if (
        error instanceof LocalCredentialAdministrationDeliveryError &&
        error.cause &&
        missing(error.cause)
      ) {
        return null;
      }
      throw error;
    }
  }

  private writeExclusive(name: string, value: unknown): PrivateFile {
    if (this.entries().length >= MAX_DIRECTORY_ENTRIES - 1) {
      throw new LocalCredentialAdministrationDeliveryError(
        'delivery directory lacks capacity',
      );
    }
    const temporaryName = `.managed-credential-${name
      .split('.')[0]!
      .slice('managed-credential-'.length)}.${randomUUID()}.tmp`;
    const temporaryPath = path.join(this.directory, temporaryName);
    const targetPath = path.join(this.directory, name);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const serialized = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
        throw new LocalCredentialAdministrationDeliveryError(
          'serialized delivery exceeds its byte budget',
        );
      }
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.linkSync(temporaryPath, targetPath);
      this.syncDirectory();
      return this.read(
        name,
        name.endsWith('.ready.json')
          ? MAX_PRESENTATION_BYTES
          : MAX_RECORD_BYTES,
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        return this.read(
          name,
          name.endsWith('.ready.json')
            ? MAX_PRESENTATION_BYTES
            : MAX_RECORD_BYTES,
        );
      }
      if (error instanceof LocalCredentialAdministrationDeliveryError) {
        throw error;
      }
      throw new LocalCredentialAdministrationDeliveryError(
        'delivery file cannot be published',
        error,
      );
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
        this.syncDirectory();
      } catch (error) {
        if (!missing(error)) {
          // A durable target, if created, remains authoritative.
        }
      }
    }
  }

  prepare(
    candidate: LocalCredentialAdministrationDeliveryRecord,
  ): Readonly<LocalCredentialAdministrationDeliveryRecord> {
    const normalized = normalizeRecord(candidate);
    this.entries();
    const pending = this.optional(
      pendingName(normalized.mutationId),
      MAX_RECORD_BYTES,
    );
    if (pending) {
      const existing = normalizeRecord(
        pending.value as LocalCredentialAdministrationDeliveryRecord,
      );
      if (!sameSemantic(existing, normalized)) {
        throw new LocalCredentialAdministrationDeliveryError(
          'pending delivery conflicts with request',
        );
      }
      return existing;
    }
    if (
      this.optional(readyName(normalized.mutationId), MAX_PRESENTATION_BYTES)
    ) {
      throw new LocalCredentialAdministrationDeliveryError(
        'published presentation is missing its durable pending record',
      );
    }
    const created = this.writeExclusive(
      pendingName(normalized.mutationId),
      normalized,
    );
    const stored = normalizeRecord(
      created.value as LocalCredentialAdministrationDeliveryRecord,
    );
    if (!sameSemantic(stored, normalized)) {
      throw new LocalCredentialAdministrationDeliveryError(
        'concurrent pending delivery conflicts with request',
      );
    }
    return stored;
  }

  digest(prepared: LocalCredentialAdministrationDeliveryRecord): string {
    return recordDigest(normalizeRecord(prepared));
  }

  publish(
    prepared: LocalCredentialAdministrationDeliveryRecord,
    expectedDeliveryDigest: string,
  ): Readonly<LocalCredentialAdministrationDeliverySummary> {
    const normalized = normalizeRecord(prepared);
    if (
      !/^[0-9a-f]{64}$/.test(expectedDeliveryDigest) ||
      recordDigest(normalized) !== expectedDeliveryDigest
    ) {
      throw new LocalCredentialAdministrationDeliveryError(
        'delivery digest is invalid',
      );
    }
    const pending = this.read(
      pendingName(normalized.mutationId),
      MAX_RECORD_BYTES,
    );
    const stored = normalizeRecord(
      pending.value as LocalCredentialAdministrationDeliveryRecord,
    );
    if (!sameRecord(stored, normalized)) {
      throw new LocalCredentialAdministrationDeliveryError(
        'pending delivery changed before publication',
      );
    }
    const expectedPresentation = presentation(stored);
    const ready = this.writeExclusive(
      readyName(stored.mutationId),
      expectedPresentation,
    );
    const published = normalizePresentation(ready.value);
    if (published.token !== expectedPresentation.token) {
      throw new LocalCredentialAdministrationDeliveryError(
        'published credential conflicts with pending delivery',
      );
    }
    return Object.freeze({
      mutationId: stored.mutationId,
      requestId: stored.requestId,
      projectId: stored.projectId,
      subject: stored.subject,
      credentialId: stored.credentialId,
      deliveryDigest: expectedDeliveryDigest,
      path: path.join(this.directory, readyName(stored.mutationId)),
    });
  }

  inspect(
    mutationId: string,
  ): Readonly<LocalCredentialAdministrationDeliverySummary> {
    if (!UUID_V4_PATTERN.test(mutationId)) {
      throw new LocalCredentialAdministrationDeliveryError(
        'mutationId is invalid',
      );
    }
    const pending = normalizeRecord(
      this.read(pendingName(mutationId), MAX_RECORD_BYTES)
        .value as LocalCredentialAdministrationDeliveryRecord,
    );
    const ready = normalizePresentation(
      this.read(readyName(mutationId), MAX_PRESENTATION_BYTES).value,
    );
    if (ready.token !== presentation(pending).token) {
      throw new LocalCredentialAdministrationDeliveryError(
        'published credential conflicts with pending delivery',
      );
    }
    return Object.freeze({
      mutationId,
      requestId: pending.requestId,
      projectId: pending.projectId,
      subject: pending.subject,
      credentialId: pending.credentialId,
      deliveryDigest: recordDigest(pending),
      path: path.join(this.directory, readyName(mutationId)),
    });
  }

  removeAcknowledged(
    mutationId: string,
    expectedDeliveryDigest: string,
  ): 'removed' | 'absent' {
    if (
      !UUID_V4_PATTERN.test(mutationId) ||
      !/^[0-9a-f]{64}$/.test(expectedDeliveryDigest)
    ) {
      throw new LocalCredentialAdministrationDeliveryError(
        'acknowledgement input is invalid',
      );
    }
    this.entries();
    const pendingFile = this.optional(
      pendingName(mutationId),
      MAX_RECORD_BYTES,
    );
    const readyFile = this.optional(
      readyName(mutationId),
      MAX_PRESENTATION_BYTES,
    );
    if (!pendingFile && !readyFile) return 'absent';
    if (!pendingFile && readyFile) {
      throw new LocalCredentialAdministrationDeliveryError(
        'acknowledged delivery is incomplete',
      );
    }
    const pending = normalizeRecord(
      pendingFile!.value as LocalCredentialAdministrationDeliveryRecord,
    );
    if (recordDigest(pending) !== expectedDeliveryDigest) {
      throw new LocalCredentialAdministrationDeliveryError(
        'acknowledged delivery changed before cleanup',
      );
    }
    if (!readyFile) {
      fs.unlinkSync(path.join(this.directory, pendingName(mutationId)));
      this.syncDirectory();
      return 'removed';
    }
    const ready = normalizePresentation(readyFile.value);
    if (ready.token !== presentation(pending).token) {
      throw new LocalCredentialAdministrationDeliveryError(
        'acknowledged delivery changed before cleanup',
      );
    }
    fs.unlinkSync(path.join(this.directory, readyName(mutationId)));
    this.syncDirectory();
    fs.unlinkSync(path.join(this.directory, pendingName(mutationId)));
    this.syncDirectory();
    return 'removed';
  }
}

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeLocalOwnerBootstrapSecretDeliveryRecord,
  type LocalOwnerBootstrapSecretDeliveryAcknowledgement,
  type LocalOwnerBootstrapSecretDeliveryPreparation,
  type LocalOwnerBootstrapSecretDeliveryRecord,
} from './ceremonyContracts';
import { assertLocalOwnerBootstrapMutationId } from '@qinglong/runtime-core/local-owner-bootstrap';
import type { LocalOwnerDeliveryBridgeClearEvidence } from '@qinglong/runtime-core/local-owner-delivery-acknowledgement-gc';
import {
  LocalOwnerSecretDeliveryError,
  type LocalOwnerSecretDeliverySummary,
} from './contracts';
import {
  ACKNOWLEDGEMENT_NAME_PATTERN,
  MAX_DIRECTORY_ENTRIES,
  MAX_RECORD_BYTES,
  RECORD_NAME_PATTERN,
  TEMP_NAME_PATTERN,
  acknowledgementName,
  isMissing,
  normalizeAcknowledgement,
  recordName,
  sameAcknowledgementSemantic,
  sameRecord,
  sameRequestSemantic,
  type AcknowledgementRecord,
  type DeliveryFile,
} from './codec';

export class SecretDeliveryPrivateFilesystemStore {
  private readonly uid: number;
  private readonly device: bigint;
  private readonly inode: bigint;

  constructor(readonly directory: string) {
    if (
      typeof directory !== 'string' ||
      !path.isAbsolute(directory) ||
      path.normalize(directory) !== directory ||
      Buffer.byteLength(directory) < 1 ||
      Buffer.byteLength(directory) > 4096 ||
      directory.includes('\0') ||
      typeof process.getuid !== 'function'
    ) {
      throw new LocalOwnerSecretDeliveryError(
        'directory must be a bounded absolute POSIX path',
      );
    }
    this.uid = process.getuid();
    const stat = fs.lstatSync(directory, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      Number(stat.uid) !== this.uid ||
      (Number(stat.mode) & 0o777) !== 0o700
    ) {
      throw new LocalOwnerSecretDeliveryError(
        'directory must be a private owned real directory',
      );
    }
    this.device = stat.dev;
    this.inode = stat.ino;
  }

  verifyDirectory(): void {
    const stat = fs.lstatSync(this.directory, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      Number(stat.uid) !== this.uid ||
      (Number(stat.mode) & 0o777) !== 0o700 ||
      stat.dev !== this.device ||
      stat.ino !== this.inode
    ) {
      throw new LocalOwnerSecretDeliveryError(
        'directory identity changed during delivery',
      );
    }
  }

  syncDirectory(): void {
    const descriptor = fs.openSync(this.directory, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  entries(): readonly string[] {
    this.verifyDirectory();
    const directory = fs.opendirSync(this.directory);
    const entries: string[] = [];
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        entries.push(entry.name);
        if (entries.length > MAX_DIRECTORY_ENTRIES) {
          throw new LocalOwnerSecretDeliveryError(
            'directory entry budget exceeded',
          );
        }
      }
    } finally {
      directory.closeSync();
    }
    for (const name of entries) {
      if (
        !RECORD_NAME_PATTERN.test(name) &&
        !ACKNOWLEDGEMENT_NAME_PATTERN.test(name) &&
        !TEMP_NAME_PATTERN.test(name)
      ) {
        throw new LocalOwnerSecretDeliveryError(
          'directory contains an unknown entry',
        );
      }
    }
    return Object.freeze(entries);
  }

  inspectBridgeClear(
    kind: 'credential' | 'challenge',
    mutationId: string,
  ): Readonly<LocalOwnerDeliveryBridgeClearEvidence> {
    try {
      assertLocalOwnerBootstrapMutationId(mutationId);
    } catch (error) {
      throw new LocalOwnerSecretDeliveryError('mutationId is invalid', error);
    }
    if (kind !== 'credential' && kind !== 'challenge') {
      throw new LocalOwnerSecretDeliveryError('kind is invalid');
    }
    const entries = new Set(this.entries());
    if (
      entries.has(`${kind}-${mutationId}.pending.json`) ||
      entries.has(`${kind}-${mutationId}.ready.json`) ||
      entries.has(`${kind}-${mutationId}.acknowledged.json`)
    ) {
      throw new LocalOwnerSecretDeliveryError(
        'delivery crash bridge is not clear',
      );
    }
    const inspectedAtMs = Date.now();
    if (!Number.isSafeInteger(inspectedAtMs) || inspectedAtMs < 0) {
      throw new LocalOwnerSecretDeliveryError('trusted clock is invalid');
    }
    const evidenceDigest = createHash('sha256')
      .update('qinglong.local-owner-delivery-bridge-clear.v1\0', 'utf8')
      .update(kind, 'utf8')
      .update('\0', 'utf8')
      .update(mutationId, 'utf8')
      .update('\0', 'utf8')
      .update(this.device.toString(), 'utf8')
      .update('\0', 'utf8')
      .update(this.inode.toString(), 'utf8')
      .update('\0', 'utf8')
      .update(String(inspectedAtMs), 'utf8')
      .digest('hex');
    return Object.freeze({
      kind,
      acknowledgementMutationId: mutationId,
      inspectedAtMs,
      evidenceDigest,
    });
  }

  read(fileName: string): DeliveryFile {
    const match = RECORD_NAME_PATTERN.exec(fileName);
    if (!match) {
      throw new LocalOwnerSecretDeliveryError('record name is invalid');
    }
    const filePath = path.join(this.directory, fileName);
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== this.uid ||
      (Number(before.mode) & 0o777) !== 0o600 ||
      before.size < 1n ||
      before.size > BigInt(MAX_RECORD_BYTES)
    ) {
      throw new LocalOwnerSecretDeliveryError(
        'record must be a bounded private regular file',
      );
    }
    const descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    let material: Buffer | undefined;
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        throw new LocalOwnerSecretDeliveryError(
          'record identity changed while opening',
        );
      }
      material = fs.readFileSync(descriptor);
      const record = normalizeLocalOwnerBootstrapSecretDeliveryRecord(
        JSON.parse(material.toString('utf8')),
      );
      if (record.kind !== match[1] || record.mutationId !== match[2]) {
        throw new LocalOwnerSecretDeliveryError(
          'record content does not match its name',
        );
      }
      return Object.freeze({
        record,
        device: opened.dev,
        inode: opened.ino,
        digest: createHash('sha256')
          .update('qinglong.local-owner-secret-delivery.v1\0', 'utf8')
          .update(material)
          .digest('hex'),
      });
    } catch (error) {
      if (error instanceof LocalOwnerSecretDeliveryError) throw error;
      throw new LocalOwnerSecretDeliveryError('record is invalid', error);
    } finally {
      material?.fill(0);
      fs.closeSync(descriptor);
    }
  }

  optional(fileName: string): DeliveryFile | null {
    try {
      return this.read(fileName);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  readAcknowledgement(fileName: string): Readonly<AcknowledgementRecord> {
    const match = ACKNOWLEDGEMENT_NAME_PATTERN.exec(fileName);
    if (!match) {
      throw new LocalOwnerSecretDeliveryError(
        'acknowledgement name is invalid',
      );
    }
    const filePath = path.join(this.directory, fileName);
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== this.uid ||
      (Number(before.mode) & 0o777) !== 0o600 ||
      before.size < 1n ||
      before.size > BigInt(MAX_RECORD_BYTES)
    ) {
      throw new LocalOwnerSecretDeliveryError(
        'acknowledgement must be a bounded private regular file',
      );
    }
    const descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    let material: Buffer | undefined;
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        throw new LocalOwnerSecretDeliveryError(
          'acknowledgement identity changed while opening',
        );
      }
      material = fs.readFileSync(descriptor);
      const record = normalizeAcknowledgement(
        JSON.parse(material.toString('utf8')),
      );
      if (record.kind !== match[1] || record.mutationId !== match[2]) {
        throw new LocalOwnerSecretDeliveryError(
          'acknowledgement content does not match its name',
        );
      }
      return record;
    } catch (error) {
      if (error instanceof LocalOwnerSecretDeliveryError) throw error;
      throw new LocalOwnerSecretDeliveryError(
        'acknowledgement is invalid',
        error,
      );
    } finally {
      material?.fill(0);
      fs.closeSync(descriptor);
    }
  }

  optionalAcknowledgement(
    fileName: string,
  ): Readonly<AcknowledgementRecord> | null {
    try {
      return this.readAcknowledgement(fileName);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  writeAcknowledgement(
    record: Readonly<AcknowledgementRecord>,
  ): Readonly<AcknowledgementRecord> {
    const fileName = acknowledgementName(record.kind, record.mutationId);
    const targetPath = path.join(this.directory, fileName);
    const temporaryName = `.${record.kind}-${
      record.mutationId
    }.${randomUUID()}.tmp`;
    const temporaryPath = path.join(this.directory, temporaryName);
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
      const serialized = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
        throw new LocalOwnerSecretDeliveryError(
          'acknowledgement exceeds its byte budget',
        );
      }
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      try {
        fs.linkSync(temporaryPath, targetPath);
        this.syncDirectory();
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'EEXIST'
        ) {
          throw error;
        }
      }
      const published = this.readAcknowledgement(fileName);
      if (!sameAcknowledgementSemantic(published, record)) {
        throw new LocalOwnerSecretDeliveryError(
          'acknowledgement conflicts with the published record',
        );
      }
      return published;
    } catch (error) {
      if (error instanceof LocalOwnerSecretDeliveryError) throw error;
      throw new LocalOwnerSecretDeliveryError(
        'cannot publish acknowledgement',
        error,
      );
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
        this.syncDirectory();
      } catch {
        // A published acknowledgement remains authoritative.
      }
    }
  }

  async prepare(
    candidate: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>,
  ): Promise<Readonly<LocalOwnerBootstrapSecretDeliveryPreparation>> {
    const normalized =
      normalizeLocalOwnerBootstrapSecretDeliveryRecord(candidate);
    const pendingName = recordName(normalized, 'pending');
    const readyName = recordName(normalized, 'ready');
    const entries = this.entries();
    const acknowledged = this.optionalAcknowledgement(
      acknowledgementName(normalized.kind, normalized.mutationId),
    );
    if (acknowledged) {
      if (
        acknowledged.requestId !== normalized.requestId ||
        acknowledged.ttlMs !== normalized.ttlMs ||
        (acknowledged.kind === 'challenge' &&
          (normalized.kind !== 'challenge' ||
            acknowledged.projectId !== normalized.projectId))
      ) {
        throw new LocalOwnerSecretDeliveryError(
          'acknowledged mutation semantic conflicts with request',
        );
      }
      return Object.freeze({
        state: 'acknowledged' as const,
        kind: acknowledged.kind,
        ...(acknowledged.kind === 'challenge'
          ? { projectId: acknowledged.projectId }
          : {}),
        mutationId: acknowledged.mutationId,
        requestId: acknowledged.requestId,
        ttlMs: acknowledged.ttlMs,
      }) as Readonly<LocalOwnerBootstrapSecretDeliveryAcknowledgement>;
    }
    const ready = this.optional(readyName);
    if (ready) {
      if (!sameRequestSemantic(ready.record, normalized)) {
        throw new LocalOwnerSecretDeliveryError(
          'published mutation semantic conflicts with request',
        );
      }
      return ready.record;
    }
    const pending = this.optional(pendingName);
    if (pending) {
      if (!sameRequestSemantic(pending.record, normalized)) {
        throw new LocalOwnerSecretDeliveryError(
          'pending mutation semantic conflicts with request',
        );
      }
      return pending.record;
    }
    if (entries.length > MAX_DIRECTORY_ENTRIES - 2) {
      throw new LocalOwnerSecretDeliveryError(
        'directory lacks capacity for an atomic staged record',
      );
    }

    const temporaryName = `.${normalized.kind}-${
      normalized.mutationId
    }.${randomUUID()}.tmp`;
    const temporaryPath = path.join(this.directory, temporaryName);
    const pendingPath = path.join(this.directory, pendingName);
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
      const serialized = `${JSON.stringify(normalized)}\n`;
      if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
        throw new LocalOwnerSecretDeliveryError(
          'serialized record exceeds its byte budget',
        );
      }
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      try {
        fs.linkSync(temporaryPath, pendingPath);
        this.syncDirectory();
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'EEXIST'
        ) {
          throw error;
        }
      }
      const winner = this.read(pendingName);
      if (!sameRequestSemantic(winner.record, normalized)) {
        throw new LocalOwnerSecretDeliveryError(
          'concurrent pending mutation conflicts with request',
        );
      }
      return winner.record;
    } catch (error) {
      if (error instanceof LocalOwnerSecretDeliveryError) throw error;
      throw new LocalOwnerSecretDeliveryError('cannot stage secret', error);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
        this.syncDirectory();
      } catch (error) {
        if (!isMissing(error)) {
          // The durable pending record, if any, remains authoritative.
        }
      }
    }
  }

  async publish(
    prepared: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>,
  ): Promise<void> {
    const normalized =
      normalizeLocalOwnerBootstrapSecretDeliveryRecord(prepared);
    this.verifyDirectory();
    const pendingName = recordName(normalized, 'pending');
    const readyName = recordName(normalized, 'ready');
    const pendingPath = path.join(this.directory, pendingName);
    const readyPath = path.join(this.directory, readyName);
    const pending = this.optional(pendingName);
    const ready = this.optional(readyName);
    if (!pending && !ready) {
      throw new LocalOwnerSecretDeliveryError(
        'neither pending nor published record exists',
      );
    }
    if (pending && !sameRecord(pending.record, normalized)) {
      throw new LocalOwnerSecretDeliveryError(
        'pending record does not match prepared secret',
      );
    }
    if (ready && !sameRecord(ready.record, normalized)) {
      throw new LocalOwnerSecretDeliveryError(
        'published record does not match prepared secret',
      );
    }
    if (!ready) {
      try {
        fs.linkSync(pendingPath, readyPath);
        this.syncDirectory();
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'EEXIST'
        ) {
          throw new LocalOwnerSecretDeliveryError(
            'cannot publish staged secret',
            error,
          );
        }
      }
    }
    const published = this.read(readyName);
    if (!sameRecord(published.record, normalized)) {
      throw new LocalOwnerSecretDeliveryError(
        'published record changed during delivery',
      );
    }
    const currentPending = this.optional(pendingName);
    if (currentPending) {
      if (
        currentPending.device !== published.device ||
        currentPending.inode !== published.inode
      ) {
        throw new LocalOwnerSecretDeliveryError(
          'pending and published records do not share one inode',
        );
      }
      fs.unlinkSync(pendingPath);
      this.syncDirectory();
    }
  }

  inspectReady(
    kind: 'credential' | 'challenge',
    mutationId: string,
  ): Readonly<LocalOwnerSecretDeliverySummary> {
    try {
      assertLocalOwnerBootstrapMutationId(mutationId);
    } catch (error) {
      throw new LocalOwnerSecretDeliveryError('mutationId is invalid', error);
    }
    this.entries();
    const ready = this.read(`${kind}-${mutationId}.ready.json`);
    return Object.freeze({
      kind,
      mutationId,
      requestId: ready.record.requestId,
      deliveryDigest: ready.digest,
      path: path.join(this.directory, `${kind}-${mutationId}.ready.json`),
    });
  }

  readyPath(kind: 'credential' | 'challenge', mutationId: string): string {
    try {
      assertLocalOwnerBootstrapMutationId(mutationId);
    } catch (error) {
      throw new LocalOwnerSecretDeliveryError('mutationId is invalid', error);
    }
    return path.join(this.directory, `${kind}-${mutationId}.ready.json`);
  }
}

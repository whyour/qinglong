import crypto from 'node:crypto';
import fs from 'node:fs';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import type { LocalDeploymentTargetReconciliationDisposition } from './targetStopContract';
import type { LocalDeploymentTargetRunCommand } from './target-run/targetRunContract';
import { cutoverDigest } from './targetEvidence';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UNKNOWN_DIGEST = '0'.repeat(64);
const HASH_BUFFER_BYTES = 64 * 1024;

export interface TargetDataReconciliationEvidence {
  readonly disposition: LocalDeploymentTargetReconciliationDisposition;
  readonly targetMatchesActivation: boolean | null;
  readonly sourceMatchesRecovery: boolean | null;
  readonly targetSidecarsClear: boolean | null;
  readonly sourceSidecarsClear: boolean | null;
  readonly targetFileIdentityDigest: string;
  readonly sourceFileIdentityDigest: string;
  readonly evidenceDigest: string;
}

export interface TargetDataReconciliationInput {
  readonly profile: 'edge' | 'standalone';
  readonly activationPath: string;
  readonly legacySourcePath: string;
  readonly targetDatabasePath: string;
  readonly expectedActivationDigest: string;
}

interface FileEvidence {
  readonly sha256: string;
  readonly identityDigest: string;
  readonly sidecarsClear: boolean;
  readonly pathDigest: string;
  readonly device: string;
  readonly inode: string;
}

function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error('activation must be an object');
  }
  return value as Record<string, unknown>;
}

function textDigest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function fileHash(descriptor: number): string {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) return hash.digest('hex');
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    buffer.fill(0);
  }
}

function sameFileStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sidecarSnapshot(filePath: string): readonly boolean[] {
  return Object.freeze(
    ['-wal', '-shm', '-journal'].map((suffix) =>
      fs.existsSync(`${filePath}${suffix}`),
    ),
  );
}

function fileEvidence(
  filePath: string,
  uid: number,
  label: string,
): Readonly<FileEvidence> {
  const pathStat = fs.lstatSync(filePath, { bigint: true });
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const sidecarsBefore = sidecarSnapshot(filePath);
    if (
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !sameFileStat(pathStat, before) ||
      before.uid !== BigInt(uid) ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      fs.realpathSync(filePath) !== filePath ||
      before.size < 1n ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error(`${label} identity is invalid`);
    }
    const sha256 = fileHash(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const sidecarsAfter = sidecarSnapshot(filePath);
    if (
      !sameFileStat(before, after) ||
      sidecarsBefore.some((value, index) => value !== sidecarsAfter[index])
    ) {
      throw new Error(`${label} changed while evidence was collected`);
    }
    const sidecarsClear = sidecarsAfter.every((value) => !value);
    const pathDigest = textDigest(filePath);
    return Object.freeze({
      sha256,
      sidecarsClear,
      pathDigest,
      device: after.dev.toString(),
      inode: after.ino.toString(),
      identityDigest: cutoverDigest({
        pathDigest,
        device: after.dev.toString(),
        inode: after.ino.toString(),
        bytes: after.size.toString(),
        modifiedAtNs: after.mtimeNs.toString(),
        sha256,
        sidecarsClear,
      }),
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function evidence(
  payload: Omit<TargetDataReconciliationEvidence, 'evidenceDigest'>,
): Readonly<TargetDataReconciliationEvidence> {
  return Object.freeze({ ...payload, evidenceDigest: cutoverDigest(payload) });
}

export function readTargetDataReconciliationEvidence(
  command: Readonly<LocalDeploymentTargetRunCommand>,
  uid: number,
): Readonly<TargetDataReconciliationEvidence> {
  return readTargetDataReconciliationEvidenceForPaths(
    {
      profile: command.request.profile,
      activationPath: command.request.activationPath,
      legacySourcePath: command.request.legacySourcePath,
      targetDatabasePath: command.request.targetDatabasePath,
      expectedActivationDigest: command.request.expectedActivationDigest,
    },
    uid,
  );
}

export function readTargetDataReconciliationEvidenceForPaths(
  input: Readonly<TargetDataReconciliationInput>,
  uid: number,
): Readonly<TargetDataReconciliationEvidence> {
  try {
    const activation = object(
      readPrivateLocalCommandFile(input.activationPath),
    );
    const { activationDigest, ...payload } = activation;
    if (
      activation.schemaVersion !== 1 ||
      activation.kind !== 'qinglong3-local-sqlite-activation' ||
      activation.state !== 'prepared' ||
      activation.profile !== input.profile ||
      activation.sourcePathDigest !== textDigest(input.legacySourcePath) ||
      activation.targetPathDigest !== textDigest(input.targetDatabasePath) ||
      activationDigest !== input.expectedActivationDigest ||
      typeof activationDigest !== 'string' ||
      !DIGEST_PATTERN.test(activationDigest) ||
      typeof activation.targetSha256 !== 'string' ||
      !DIGEST_PATTERN.test(activation.targetSha256) ||
      typeof activation.recoverySha256 !== 'string' ||
      !DIGEST_PATTERN.test(activation.recoverySha256) ||
      typeof activation.targetDevice !== 'string' ||
      typeof activation.targetInode !== 'string' ||
      cutoverDigest(payload) !== activationDigest
    ) {
      throw new Error('activation identity drifted');
    }
    const target = fileEvidence(
      input.targetDatabasePath,
      uid,
      'target database',
    );
    const source = fileEvidence(
      input.legacySourcePath,
      uid,
      'legacy source database',
    );
    if (
      target.pathDigest !== activation.targetPathDigest ||
      target.device !== activation.targetDevice ||
      target.inode !== activation.targetInode
    ) {
      throw new Error('target database stable identity drifted');
    }
    const targetMatchesActivation = target.sha256 === activation.targetSha256;
    const sourceMatchesRecovery = source.sha256 === activation.recoverySha256;
    const disposition =
      !targetMatchesActivation || !target.sidecarsClear
        ? ('reconciliation_required' as const)
        : sourceMatchesRecovery && source.sidecarsClear
        ? ('rollback_candidate' as const)
        : ('manual_review' as const);
    return evidence({
      disposition,
      targetMatchesActivation,
      sourceMatchesRecovery,
      targetSidecarsClear: target.sidecarsClear,
      sourceSidecarsClear: source.sidecarsClear,
      targetFileIdentityDigest: target.identityDigest,
      sourceFileIdentityDigest: source.identityDigest,
    });
  } catch {
    return evidence({
      disposition: 'manual_review',
      targetMatchesActivation: null,
      sourceMatchesRecovery: null,
      targetSidecarsClear: null,
      sourceSidecarsClear: null,
      targetFileIdentityDigest: UNKNOWN_DIGEST,
      sourceFileIdentityDigest: UNKNOWN_DIGEST,
    });
  }
}

export function verifyTargetDataReconciliationEvidence(
  value: unknown,
): Readonly<TargetDataReconciliationEvidence> {
  const candidate = object(value);
  const keys = Object.keys(candidate).sort();
  const expected = [
    'disposition',
    'evidenceDigest',
    'sourceFileIdentityDigest',
    'sourceMatchesRecovery',
    'sourceSidecarsClear',
    'targetFileIdentityDigest',
    'targetMatchesActivation',
    'targetSidecarsClear',
  ].sort();
  const { evidenceDigest, ...payload } = candidate;
  if (
    JSON.stringify(keys) !== JSON.stringify(expected) ||
    (candidate.disposition !== 'rollback_candidate' &&
      candidate.disposition !== 'reconciliation_required' &&
      candidate.disposition !== 'manual_review') ||
    (candidate.targetMatchesActivation !== null &&
      typeof candidate.targetMatchesActivation !== 'boolean') ||
    (candidate.sourceMatchesRecovery !== null &&
      typeof candidate.sourceMatchesRecovery !== 'boolean') ||
    (candidate.targetSidecarsClear !== null &&
      typeof candidate.targetSidecarsClear !== 'boolean') ||
    (candidate.sourceSidecarsClear !== null &&
      typeof candidate.sourceSidecarsClear !== 'boolean') ||
    typeof candidate.targetFileIdentityDigest !== 'string' ||
    !DIGEST_PATTERN.test(candidate.targetFileIdentityDigest) ||
    typeof candidate.sourceFileIdentityDigest !== 'string' ||
    !DIGEST_PATTERN.test(candidate.sourceFileIdentityDigest) ||
    typeof evidenceDigest !== 'string' ||
    !DIGEST_PATTERN.test(evidenceDigest) ||
    cutoverDigest(payload) !== evidenceDigest
  ) {
    throw new Error('target data reconciliation evidence drifted');
  }
  return candidate as unknown as Readonly<TargetDataReconciliationEvidence>;
}

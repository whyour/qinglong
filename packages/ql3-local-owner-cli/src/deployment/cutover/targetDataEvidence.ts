import crypto from 'node:crypto';
import fs from 'node:fs';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import type { LocalDeploymentTargetReconciliationDisposition } from './targetStopContract';
import type { LocalDeploymentTargetRunCommand } from './target-run/targetRunContract';
import {
  adoptedTargetBaselinePath,
  readAdoptedTargetBaseline,
} from './targetBaseline';
import { cutoverDigest, readTargetApplicationBinding } from './targetEvidence';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UNKNOWN_DIGEST = '0'.repeat(64);
const HASH_BUFFER_BYTES = 64 * 1024;

export interface TargetDataReconciliationEvidence {
  readonly disposition: LocalDeploymentTargetReconciliationDisposition;
  readonly targetMatchesActivation: boolean | null;
  readonly sourceMatchesActivation: boolean | null;
  readonly targetSidecarsClear: boolean | null;
  readonly sourceSidecarsClear: boolean | null;
  readonly targetFileIdentityDigest: string;
  readonly sourceFileIdentityDigest: string;
  readonly baselineKind?: 'adopted_target';
  readonly baselineDigest?: string;
  readonly targetMatchesBaseline?: boolean | null;
  readonly evidenceDigest: string;
}

export interface TargetDataReconciliationInput {
  readonly profile: 'edge' | 'standalone';
  readonly activationPath: string;
  readonly legacySourcePath: string;
  readonly targetDatabasePath: string;
  readonly expectedActivationDigest: string;
  readonly adoptedTargetBaseline?: Readonly<{
    baselineDigest: string;
    targetDevice: string;
    targetInode: string;
    targetSha256: string;
  }>;
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

function manualReviewEvidence(): Readonly<TargetDataReconciliationEvidence> {
  return evidence({
    disposition: 'manual_review',
    targetMatchesActivation: null,
    sourceMatchesActivation: null,
    targetSidecarsClear: null,
    sourceSidecarsClear: null,
    targetFileIdentityDigest: UNKNOWN_DIGEST,
    sourceFileIdentityDigest: UNKNOWN_DIGEST,
  });
}

export function readTargetDataReconciliationEvidence(
  command: Readonly<LocalDeploymentTargetRunCommand>,
  uid: number,
): Readonly<TargetDataReconciliationEvidence> {
  try {
    const application = readTargetApplicationBinding(command);
    let adoptedTargetBaseline:
      | TargetDataReconciliationInput['adoptedTargetBaseline']
      | undefined;
    if (application.schema === 'qinglong/local-application-process@v4') {
      const baseline = readAdoptedTargetBaseline(
        adoptedTargetBaselinePath(command.options.deploymentRoot),
      );
      if (
        baseline.preparedAtMs > command.request.requestedAtMs ||
        baseline.profile !== command.request.profile ||
        baseline.instanceId !== command.request.instanceId ||
        baseline.cutoverId !== command.request.cutoverId ||
        baseline.activationDigest !==
          command.request.expectedActivationDigest ||
        baseline.commitmentDigest !==
          command.request.expectedLegacyCommitmentDigest ||
        baseline.applicationConfigDigest !== application.configDigest ||
        baseline.legacyDataApplicationCommitDigest !==
          application.legacyDataApplicationCommitDigest ||
        baseline.legacyDataApplicationReceiptDigest !==
          application.legacyDataApplicationReceiptDigest ||
        baseline.targetPathDigest !==
          textDigest(command.request.targetDatabasePath)
      ) {
        throw new Error('adopted target baseline binding drifted');
      }
      adoptedTargetBaseline = Object.freeze({
        baselineDigest: baseline.baselineDigest,
        targetDevice: baseline.targetDevice,
        targetInode: baseline.targetInode,
        targetSha256: baseline.targetSha256,
      });
    }
    return readTargetDataReconciliationEvidenceForPaths(
      {
        profile: command.request.profile,
        activationPath: command.request.activationPath,
        legacySourcePath: command.request.legacySourcePath,
        targetDatabasePath: command.request.targetDatabasePath,
        expectedActivationDigest: command.request.expectedActivationDigest,
        ...(adoptedTargetBaseline === undefined
          ? {}
          : { adoptedTargetBaseline }),
      },
      uid,
    );
  } catch {
    return manualReviewEvidence();
  }
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
      typeof activation.sourceSha256 !== 'string' ||
      !DIGEST_PATTERN.test(activation.sourceSha256) ||
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
      target.inode !== activation.targetInode ||
      (input.adoptedTargetBaseline !== undefined &&
        (target.device !== input.adoptedTargetBaseline.targetDevice ||
          target.inode !== input.adoptedTargetBaseline.targetInode))
    ) {
      throw new Error('target database stable identity drifted');
    }
    const targetMatchesActivation = target.sha256 === activation.targetSha256;
    const targetMatchesBaseline =
      input.adoptedTargetBaseline === undefined
        ? targetMatchesActivation
        : target.sha256 === input.adoptedTargetBaseline.targetSha256;
    const sourceMatchesActivation = source.sha256 === activation.sourceSha256;
    const disposition =
      !targetMatchesBaseline || !target.sidecarsClear
        ? ('reconciliation_required' as const)
        : sourceMatchesActivation && source.sidecarsClear
        ? ('rollback_candidate' as const)
        : ('manual_review' as const);
    const reconciliationPayload = {
      disposition,
      targetMatchesActivation,
      sourceMatchesActivation,
      targetSidecarsClear: target.sidecarsClear,
      sourceSidecarsClear: source.sidecarsClear,
      targetFileIdentityDigest: target.identityDigest,
      sourceFileIdentityDigest: source.identityDigest,
    };
    return evidence(
      input.adoptedTargetBaseline === undefined
        ? reconciliationPayload
        : {
            ...reconciliationPayload,
            baselineKind: 'adopted_target' as const,
            baselineDigest: input.adoptedTargetBaseline.baselineDigest,
            targetMatchesBaseline,
          },
    );
  } catch {
    return manualReviewEvidence();
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
    'sourceMatchesActivation',
    'sourceSidecarsClear',
    'targetFileIdentityDigest',
    'targetMatchesActivation',
    'targetSidecarsClear',
  ].sort();
  const expectedAdopted = [
    ...expected,
    'baselineDigest',
    'baselineKind',
    'targetMatchesBaseline',
  ].sort();
  const adopted = JSON.stringify(keys) === JSON.stringify(expectedAdopted);
  const { evidenceDigest, ...payload } = candidate;
  if (
    (!adopted && JSON.stringify(keys) !== JSON.stringify(expected)) ||
    (candidate.disposition !== 'rollback_candidate' &&
      candidate.disposition !== 'reconciliation_required' &&
      candidate.disposition !== 'manual_review') ||
    (candidate.targetMatchesActivation !== null &&
      typeof candidate.targetMatchesActivation !== 'boolean') ||
    (candidate.sourceMatchesActivation !== null &&
      typeof candidate.sourceMatchesActivation !== 'boolean') ||
    (candidate.targetSidecarsClear !== null &&
      typeof candidate.targetSidecarsClear !== 'boolean') ||
    (candidate.sourceSidecarsClear !== null &&
      typeof candidate.sourceSidecarsClear !== 'boolean') ||
    (adopted &&
      (candidate.baselineKind !== 'adopted_target' ||
        typeof candidate.baselineDigest !== 'string' ||
        !DIGEST_PATTERN.test(candidate.baselineDigest) ||
        (candidate.targetMatchesBaseline !== null &&
          typeof candidate.targetMatchesBaseline !== 'boolean') ||
        (candidate.disposition === 'rollback_candidate' &&
          (candidate.targetMatchesBaseline !== true ||
            candidate.targetSidecarsClear !== true ||
            candidate.sourceMatchesActivation !== true ||
            candidate.sourceSidecarsClear !== true)) ||
        (candidate.disposition === 'reconciliation_required' &&
          candidate.targetMatchesBaseline !== false &&
          candidate.targetSidecarsClear !== false))) ||
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

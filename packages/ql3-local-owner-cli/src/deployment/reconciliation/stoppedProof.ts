import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { LocalDeploymentConfigurationError } from '../foundation/error';
import {
  adoptedTargetBaselinePath,
  readAdoptedTargetBaseline,
} from '../cutover/targetBaseline';
import { cutoverDigest } from '../cutover/targetEvidence';
import {
  readTargetDataReconciliationEvidenceForPaths,
  verifyTargetDataReconciliationEvidence,
  type TargetDataReconciliationEvidence,
} from '../cutover/targetDataEvidence';
import {
  targetStopPhasePath,
  targetStopSequence,
} from '../cutover/target-run/targetRunJournal';
import { normalizeLocalServiceManagerCutoverRecord } from '../service-manager/serviceCutoverJournal';
import type { LocalReconciliationCapturePrepareCommand } from './contract';

const DOCKER_RECORD_SCHEMA = 'qinglong3-local-cutover-journal-record';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface LocalReconciliationStoppedProof {
  readonly stoppedRecordDigest: string;
  readonly reconciliationEvidenceDigest: string;
  readonly evolvedTargetSha256?: string;
  readonly proofDigest: string;
}

export interface LocalReconciliationStoppedProofOptions {
  readonly expectedEvolvedTargetSha256?: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    configurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError(`${label} shape is invalid`);
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

function stableTargetSha256(filePath: string, uid: number): string {
  let descriptor: number | undefined;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const pathStat = fs.lstatSync(filePath, { bigint: true });
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !sameFileStat(pathStat, before) ||
      before.uid !== BigInt(uid) ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      fs.realpathSync(filePath) !== filePath ||
      before.size < 1n
    ) {
      configurationError('evolved target database identity is invalid');
    }
    const hash = crypto.createHash('sha256');
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileStat(before, after)) {
      configurationError('evolved target database changed while hashing');
    }
    return hash.digest('hex');
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('evolved target database is unavailable');
  } finally {
    buffer.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function serviceManagerStoppedPath(
  command: Readonly<LocalReconciliationCapturePrepareCommand>,
): string {
  return path.join(
    command.options.deploymentRoot,
    'service',
    'cutovers',
    command.request.cutoverId,
    `service-manager-g${String(command.request.generation).padStart(
      2,
      '0',
    )}-stopped.json`,
  );
}

function dockerStoppedEvidence(
  command: Readonly<LocalReconciliationCapturePrepareCommand>,
): Readonly<TargetDataReconciliationEvidence> {
  const recordPath = targetStopPhasePath(
    path.join(
      command.options.deploymentRoot,
      'service',
      'cutovers',
      command.request.cutoverId,
    ),
    command.request.generation,
    'outcome',
  );
  const record = object(
    readPrivateLocalCommandFile(recordPath),
    'docker target stopped record',
  );
  exact(
    record,
    [
      'activationDigest',
      'cutoverId',
      'evidence',
      'generation',
      'instanceId',
      'previousRecordDigest',
      'profile',
      'recordDigest',
      'requestedAtMs',
      'schema',
      'schemaVersion',
      'sequence',
      'state',
    ],
    'docker target stopped record',
  );
  const { recordDigest, ...payload } = record;
  const evidence = object(record.evidence, 'docker target stopped evidence');
  exact(
    evidence,
    [
      'activeRecordDigest',
      'reconciliation',
      'startupReceiptDigest',
      'targetApplicationBindingDigest',
      'targetContainerIdentityDigest',
    ],
    'docker target stopped evidence',
  );
  if (
    record.schema !== DOCKER_RECORD_SCHEMA ||
    record.schemaVersion !== 1 ||
    record.sequence !==
      targetStopSequence(command.request.generation, 'outcome') ||
    record.state !== 'target_stopped' ||
    record.cutoverId !== command.request.cutoverId ||
    record.profile !== command.request.profile ||
    record.instanceId !== command.request.instanceId ||
    record.activationDigest !== command.request.expectedActivationDigest ||
    record.generation !== command.request.generation ||
    recordDigest !== command.request.expectedStoppedRecordDigest ||
    typeof record.previousRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.previousRecordDigest) ||
    !Number.isSafeInteger(record.requestedAtMs) ||
    (record.requestedAtMs as number) < 0 ||
    typeof recordDigest !== 'string' ||
    !DIGEST_PATTERN.test(recordDigest) ||
    cutoverDigest(payload) !== recordDigest
  ) {
    configurationError('docker target stopped record drifted');
  }
  return verifyTargetDataReconciliationEvidence(evidence.reconciliation);
}

function serviceManagerStoppedRecord(
  command: Readonly<LocalReconciliationCapturePrepareCommand>,
): void {
  const record = normalizeLocalServiceManagerCutoverRecord(
    readPrivateLocalCommandFile(serviceManagerStoppedPath(command)),
  );
  if (
    record.state !== 'target_stopped' ||
    record.cutoverId !== command.request.cutoverId ||
    record.profile !== command.request.profile ||
    record.instanceId !== command.request.instanceId ||
    record.activationDigest !== command.request.expectedActivationDigest ||
    record.generation !== command.request.generation ||
    record.recordDigest !== command.request.expectedStoppedRecordDigest ||
    record.action !== 'stop' ||
    record.evidence.shutdownReceiptDigest === null ||
    record.evidence.manualReason !== null
  ) {
    configurationError('service manager target stopped record drifted');
  }
}

export function proveLocalReconciliationStoppedState(
  command: Readonly<LocalReconciliationCapturePrepareCommand>,
  uid: number,
  options: Readonly<LocalReconciliationStoppedProofOptions> = {},
): Readonly<LocalReconciliationStoppedProof> {
  const expectedEvolvedTargetSha256 = options.expectedEvolvedTargetSha256;
  if (
    expectedEvolvedTargetSha256 !== undefined &&
    !DIGEST_PATTERN.test(expectedEvolvedTargetSha256)
  ) {
    configurationError('evolved target snapshot digest is invalid');
  }
  const persisted =
    command.request.stoppedAuthority === 'docker'
      ? dockerStoppedEvidence(command)
      : (serviceManagerStoppedRecord(command), undefined);
  const adoptedTargetBaseline =
    persisted?.baselineKind === 'adopted_target' &&
    persisted.baselineDigest !== undefined
      ? readAdoptedTargetBaselineProjection(command, persisted.baselineDigest)
      : undefined;
  const current = readTargetDataReconciliationEvidenceForPaths(
    {
      profile: command.request.profile,
      activationPath: command.request.activationPath,
      legacySourcePath: command.request.legacySourcePath,
      targetDatabasePath: command.request.targetDatabasePath,
      expectedActivationDigest: command.request.expectedActivationDigest,
      ...(adoptedTargetBaseline === undefined ? {} : { adoptedTargetBaseline }),
    },
    uid,
  );
  const exactStoppedData =
    expectedEvolvedTargetSha256 === undefined &&
    current.disposition === 'reconciliation_required' &&
    (persisted === undefined ||
      persisted.evidenceDigest === current.evidenceDigest);
  let evolvedStoppedData = false;
  if (expectedEvolvedTargetSha256 !== undefined) {
    const currentSha256 = stableTargetSha256(
      command.request.targetDatabasePath,
      uid,
    );
    const confirmed = readTargetDataReconciliationEvidenceForPaths(
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
    evolvedStoppedData =
      current.disposition === 'reconciliation_required' &&
      current.sourceMatchesActivation === true &&
      current.sourceSidecarsClear === true &&
      current.targetSidecarsClear === true &&
      current.targetMatchesActivation === false &&
      (current.baselineKind !== 'adopted_target' ||
        current.targetMatchesBaseline === false) &&
      currentSha256 === expectedEvolvedTargetSha256 &&
      confirmed.evidenceDigest === current.evidenceDigest;
  }
  if (!exactStoppedData && !evolvedStoppedData) {
    configurationError(
      'stopped data does not have exact reconciliation-required evidence',
    );
  }
  const payload = Object.freeze({
    stoppedAuthority: command.request.stoppedAuthority,
    stoppedRecordDigest: command.request.expectedStoppedRecordDigest,
    reconciliationEvidenceDigest: current.evidenceDigest,
    ...(expectedEvolvedTargetSha256 === undefined
      ? {}
      : { evolvedTargetSha256: expectedEvolvedTargetSha256 }),
  });
  return Object.freeze({ ...payload, proofDigest: cutoverDigest(payload) });
}

function readAdoptedTargetBaselineProjection(
  command: Readonly<LocalReconciliationCapturePrepareCommand>,
  expectedBaselineDigest: string,
): Readonly<{
  baselineDigest: string;
  targetDevice: string;
  targetInode: string;
  targetSha256: string;
}> {
  const baseline = readAdoptedTargetBaseline(
    adoptedTargetBaselinePath(command.options.deploymentRoot),
  );
  const targetPathDigest = crypto
    .createHash('sha256')
    .update(command.request.targetDatabasePath, 'utf8')
    .digest('hex');
  if (
    baseline.profile !== command.request.profile ||
    baseline.instanceId !== command.request.instanceId ||
    baseline.cutoverId !== command.request.cutoverId ||
    baseline.activationDigest !== command.request.expectedActivationDigest ||
    baseline.targetPathDigest !== targetPathDigest ||
    baseline.baselineDigest !== expectedBaselineDigest
  ) {
    configurationError(
      'adopted target baseline is detached from stopped evidence',
    );
  }
  return Object.freeze({
    baselineDigest: baseline.baselineDigest,
    targetDevice: baseline.targetDevice,
    targetInode: baseline.targetInode,
    targetSha256: baseline.targetSha256,
  });
}

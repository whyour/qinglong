import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { LocalDeploymentConfigurationError } from '../foundation/error';
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
  readonly proofDigest: string;
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
): Readonly<LocalReconciliationStoppedProof> {
  const persisted =
    command.request.stoppedAuthority === 'docker'
      ? dockerStoppedEvidence(command)
      : (serviceManagerStoppedRecord(command), undefined);
  const current = readTargetDataReconciliationEvidenceForPaths(
    {
      profile: command.request.profile,
      activationPath: command.request.activationPath,
      legacySourcePath: command.request.legacySourcePath,
      targetDatabasePath: command.request.targetDatabasePath,
      expectedActivationDigest: command.request.expectedActivationDigest,
    },
    uid,
  );
  if (
    current.disposition !== 'reconciliation_required' ||
    (persisted !== undefined &&
      persisted.evidenceDigest !== current.evidenceDigest)
  ) {
    configurationError(
      'stopped data does not have exact reconciliation-required evidence',
    );
  }
  const payload = Object.freeze({
    stoppedAuthority: command.request.stoppedAuthority,
    stoppedRecordDigest: command.request.expectedStoppedRecordDigest,
    reconciliationEvidenceDigest: current.evidenceDigest,
  });
  return Object.freeze({ ...payload, proofDigest: cutoverDigest(payload) });
}

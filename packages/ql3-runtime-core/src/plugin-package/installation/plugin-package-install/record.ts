import type { PluginPackagePlanOperation } from '../../pluginPackage';
import { semver } from '../../../versioning/pinnedSemver';

import {
  PLUGIN_PACKAGE_INSTALL_SCHEMA,
  MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
  PLUGIN_PACKAGE_INSTALL_STATES,
  PLUGIN_PACKAGE_INSTALL_FAILURE_REASONS,
  InvalidPluginPackageInstallError,
  PluginPackageInstallTransitionConflictError,
  type PluginPackageInstallState,
  type PluginPackageInstallFailureReason,
  type PluginPackageLock,
  type PluginPackageStageReceipt,
  type PluginPackageActivationReceipt,
  type CreatePluginPackageActivationReceiptInput,
  type PluginPackageInstallFailure,
  type PluginPackageInstallRecord,
  type CreatePluginPackageInstallInput,
} from './contracts';
import {
  PACKAGE_NAME_PATTERN,
  PLAN_OPERATIONS,
  exactKeys,
  installObject,
  identifier,
  boundedText,
  digest,
  timestamp,
  positiveInteger,
  contentDigest,
} from './codec';
import { normalizePluginPackageLock } from './lock';

export function initialMutationDigest(
  lockDigest: string,
  input: Readonly<CreatePluginPackageInstallInput>,
): string {
  return contentDigest({
    type: 'install_created',
    lockDigest,
    installationId: input.installationId,
    mutationId: input.mutationId,
    occurredAtMs: input.occurredAtMs,
  });
}

export function recordWithoutDigest(
  value: Omit<PluginPackageInstallRecord, 'recordDigest'>,
): Omit<PluginPackageInstallRecord, 'recordDigest'> {
  return Object.freeze(value);
}

export function withRecordDigest(
  value: Omit<PluginPackageInstallRecord, 'recordDigest'>,
): Readonly<PluginPackageInstallRecord> {
  const normalized = recordWithoutDigest(value);
  return Object.freeze({
    ...normalized,
    recordDigest: contentDigest(normalized),
  });
}

export function createPluginPackageInstall(
  lockValue: PluginPackageLock,
  input: CreatePluginPackageInstallInput,
): Readonly<PluginPackageInstallRecord> {
  const lock = normalizePluginPackageLock(lockValue);
  const value = installObject(input, 'create input');
  exactKeys(
    value,
    ['installationId', 'mutationId', 'occurredAtMs'],
    [],
    'create input',
    InvalidPluginPackageInstallError,
  );
  const occurredAtMs = timestamp(
    input.occurredAtMs,
    'creation time',
    InvalidPluginPackageInstallError,
  );
  if (
    occurredAtMs < lock.createdAtMs ||
    occurredAtMs >= lock.approval.expiresAtMs
  ) {
    throw new InvalidPluginPackageInstallError(
      'creation time is outside the approved action lifetime',
    );
  }
  const normalizedInput = Object.freeze({
    installationId: identifier(
      input.installationId,
      'installation id',
      InvalidPluginPackageInstallError,
    ),
    mutationId: identifier(
      input.mutationId,
      'mutation id',
      InvalidPluginPackageInstallError,
    ),
    occurredAtMs,
  });
  const previousActiveLockDigest = lock.previousLockDigest ?? null;
  return withRecordDigest({
    schema: PLUGIN_PACKAGE_INSTALL_SCHEMA,
    installationId: normalizedInput.installationId,
    projectId: lock.projectId,
    packageName: lock.packageName,
    packageVersion: lock.packageVersion,
    operation: lock.operation,
    lockDigest: lock.lockDigest,
    targetGeneration: lock.targetGeneration,
    previousActiveLockDigest,
    activeLockDigest: previousActiveLockDigest,
    state: 'queued',
    version: 1,
    lastMutationId: normalizedInput.mutationId,
    lastMutationDigest: initialMutationDigest(lock.lockDigest, normalizedInput),
    stageReceipt: null,
    activationReceipt: null,
    failure: null,
    createdAtMs: occurredAtMs,
    updatedAtMs: occurredAtMs,
  });
}

export function normalizeStageReceipt(
  value: unknown,
): Readonly<PluginPackageStageReceipt> {
  const receipt = installObject(value, 'stage receipt');
  exactKeys(
    receipt,
    [
      'stageRef',
      'artifactDigest',
      'manifestDigest',
      'contentDigest',
      'evidenceDigest',
      'stagedAtMs',
      'receiptDigest',
    ],
    [],
    'stage receipt',
    InvalidPluginPackageInstallError,
  );
  const unsigned = Object.freeze({
    stageRef: identifier(
      receipt.stageRef,
      'stage reference',
      InvalidPluginPackageInstallError,
    ),
    artifactDigest: digest(
      receipt.artifactDigest,
      'staged artifact digest',
      InvalidPluginPackageInstallError,
    ),
    manifestDigest: digest(
      receipt.manifestDigest,
      'staged manifest digest',
      InvalidPluginPackageInstallError,
    ),
    contentDigest: digest(
      receipt.contentDigest,
      'staged content digest',
      InvalidPluginPackageInstallError,
    ),
    evidenceDigest: digest(
      receipt.evidenceDigest,
      'staged evidence digest',
      InvalidPluginPackageInstallError,
    ),
    stagedAtMs: timestamp(
      receipt.stagedAtMs,
      'staged time',
      InvalidPluginPackageInstallError,
    ),
  });
  const receiptDigest = digest(
    receipt.receiptDigest,
    'stage receipt digest',
    InvalidPluginPackageInstallError,
  );
  if (contentDigest(unsigned) !== receiptDigest) {
    throw new InvalidPluginPackageInstallError(
      'stage receipt digest does not match',
    );
  }
  return Object.freeze({ ...unsigned, receiptDigest });
}

export function normalizePluginPackageActivationReceipt(
  value: unknown,
): Readonly<PluginPackageActivationReceipt> {
  const receipt = installObject(value, 'activation receipt');
  exactKeys(
    receipt,
    [
      'activationRef',
      'intentDigest',
      'generation',
      'contentDigest',
      'activatedAtMs',
      'receiptDigest',
    ],
    [],
    'activation receipt',
    InvalidPluginPackageInstallError,
  );
  const unsigned = Object.freeze({
    activationRef: identifier(
      receipt.activationRef,
      'activation reference',
      InvalidPluginPackageInstallError,
    ),
    intentDigest: digest(
      receipt.intentDigest,
      'activation intent digest',
      InvalidPluginPackageInstallError,
    ),
    generation: positiveInteger(
      receipt.generation,
      'activation generation',
      MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
      InvalidPluginPackageInstallError,
    ),
    contentDigest: digest(
      receipt.contentDigest,
      'activated content digest',
      InvalidPluginPackageInstallError,
    ),
    activatedAtMs: timestamp(
      receipt.activatedAtMs,
      'activation time',
      InvalidPluginPackageInstallError,
    ),
  });
  const receiptDigest = digest(
    receipt.receiptDigest,
    'activation receipt digest',
    InvalidPluginPackageInstallError,
  );
  if (contentDigest(unsigned) !== receiptDigest) {
    throw new InvalidPluginPackageInstallError(
      'activation receipt digest does not match',
    );
  }
  return Object.freeze({ ...unsigned, receiptDigest });
}

export function createPluginPackageActivationReceipt(
  value: CreatePluginPackageActivationReceiptInput,
): Readonly<PluginPackageActivationReceipt> {
  const receipt = installObject(value, 'activation receipt input');
  exactKeys(
    receipt,
    [
      'activationRef',
      'intentDigest',
      'generation',
      'contentDigest',
      'activatedAtMs',
    ],
    [],
    'activation receipt input',
    InvalidPluginPackageInstallError,
  );
  const unsigned = Object.freeze({
    activationRef: identifier(
      value.activationRef,
      'activation reference',
      InvalidPluginPackageInstallError,
    ),
    intentDigest: digest(
      value.intentDigest,
      'activation intent digest',
      InvalidPluginPackageInstallError,
    ),
    generation: positiveInteger(
      value.generation,
      'activation generation',
      MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
      InvalidPluginPackageInstallError,
    ),
    contentDigest: digest(
      value.contentDigest,
      'activated content digest',
      InvalidPluginPackageInstallError,
    ),
    activatedAtMs: timestamp(
      value.activatedAtMs,
      'activated time',
      InvalidPluginPackageInstallError,
    ),
  });
  return Object.freeze({
    ...unsigned,
    receiptDigest: contentDigest(unsigned),
  });
}

export function normalizeFailure(
  value: unknown,
): Readonly<PluginPackageInstallFailure> {
  const failure = installObject(value, 'failure');
  exactKeys(
    failure,
    ['reason', 'failedFrom', 'failedAtMs'],
    [],
    'failure',
    InvalidPluginPackageInstallError,
  );
  if (
    !PLUGIN_PACKAGE_INSTALL_FAILURE_REASONS.includes(
      failure.reason as PluginPackageInstallFailureReason,
    ) ||
    !['queued', 'staged', 'activating'].includes(failure.failedFrom as string)
  ) {
    throw new InvalidPluginPackageInstallError('failure vocabulary is invalid');
  }
  return Object.freeze({
    reason: failure.reason as PluginPackageInstallFailureReason,
    failedFrom: failure.failedFrom as PluginPackageInstallFailure['failedFrom'],
    failedAtMs: timestamp(
      failure.failedAtMs,
      'failure time',
      InvalidPluginPackageInstallError,
    ),
  });
}

export function normalizePluginPackageInstallRecord(
  value: PluginPackageInstallRecord,
): Readonly<PluginPackageInstallRecord> {
  const record = installObject(value, 'record');
  exactKeys(
    record,
    [
      'schema',
      'installationId',
      'projectId',
      'packageName',
      'packageVersion',
      'operation',
      'lockDigest',
      'targetGeneration',
      'previousActiveLockDigest',
      'activeLockDigest',
      'state',
      'version',
      'lastMutationId',
      'lastMutationDigest',
      'stageReceipt',
      'activationReceipt',
      'failure',
      'createdAtMs',
      'updatedAtMs',
      'recordDigest',
    ],
    [],
    'record',
    InvalidPluginPackageInstallError,
  );
  if (
    record.schema !== PLUGIN_PACKAGE_INSTALL_SCHEMA ||
    !PLAN_OPERATIONS.includes(record.operation as PluginPackagePlanOperation) ||
    !PLUGIN_PACKAGE_INSTALL_STATES.includes(
      record.state as PluginPackageInstallState,
    )
  ) {
    throw new InvalidPluginPackageInstallError('record vocabulary is invalid');
  }
  const createdAtMs = timestamp(
    record.createdAtMs,
    'creation time',
    InvalidPluginPackageInstallError,
  );
  const updatedAtMs = timestamp(
    record.updatedAtMs,
    'update time',
    InvalidPluginPackageInstallError,
  );
  if (updatedAtMs < createdAtMs) {
    throw new InvalidPluginPackageInstallError('record timestamps are invalid');
  }
  const previousActiveLockDigest =
    record.previousActiveLockDigest === null
      ? null
      : digest(
          record.previousActiveLockDigest,
          'previous active lock digest',
          InvalidPluginPackageInstallError,
        );
  const activeLockDigest =
    record.activeLockDigest === null
      ? null
      : digest(
          record.activeLockDigest,
          'active lock digest',
          InvalidPluginPackageInstallError,
        );
  const state = record.state as PluginPackageInstallState;
  const lockDigest = digest(
    record.lockDigest,
    'lock digest',
    InvalidPluginPackageInstallError,
  );
  const targetGeneration = positiveInteger(
    record.targetGeneration,
    'target generation',
    MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
    InvalidPluginPackageInstallError,
  );
  if (
    (record.operation === 'install' &&
      (targetGeneration !== 1 || previousActiveLockDigest !== null)) ||
    (record.operation !== 'install' &&
      (targetGeneration < 2 || previousActiveLockDigest === null))
  ) {
    throw new InvalidPluginPackageInstallError(
      'record operation does not match its generation',
    );
  }
  if (
    (state === 'active' && activeLockDigest !== lockDigest) ||
    (state !== 'active' && activeLockDigest !== previousActiveLockDigest)
  ) {
    throw new InvalidPluginPackageInstallError(
      'active lock pointer does not match install state',
    );
  }
  const stageReceipt =
    record.stageReceipt === null
      ? null
      : normalizeStageReceipt(record.stageReceipt);
  const activationReceipt =
    record.activationReceipt === null
      ? null
      : normalizePluginPackageActivationReceipt(record.activationReceipt);
  const failure =
    record.failure === null ? null : normalizeFailure(record.failure);
  if (
    ((state === 'queued' || state === 'failed') &&
      state !== 'failed' &&
      stageReceipt !== null) ||
    ((state === 'staged' || state === 'activating' || state === 'active') &&
      stageReceipt === null) ||
    (state === 'active' && activationReceipt === null) ||
    (state !== 'active' && activationReceipt !== null) ||
    (state === 'failed' ? failure === null : failure !== null)
  ) {
    throw new InvalidPluginPackageInstallError(
      'record receipts do not match install state',
    );
  }
  if (
    failure &&
    ((failure.failedFrom === 'queued' && stageReceipt !== null) ||
      (failure.failedFrom !== 'queued' && stageReceipt === null))
  ) {
    throw new InvalidPluginPackageInstallError(
      'failure receipts do not match the failed state',
    );
  }
  const unsigned = recordWithoutDigest({
    schema: PLUGIN_PACKAGE_INSTALL_SCHEMA,
    installationId: identifier(
      record.installationId,
      'installation id',
      InvalidPluginPackageInstallError,
    ),
    projectId: boundedText(
      record.projectId,
      'project id',
      128,
      InvalidPluginPackageInstallError,
    ),
    packageName: boundedText(
      record.packageName,
      'package name',
      64,
      InvalidPluginPackageInstallError,
    ),
    packageVersion: boundedText(
      record.packageVersion,
      'package version',
      128,
      InvalidPluginPackageInstallError,
    ),
    operation: record.operation as PluginPackagePlanOperation,
    lockDigest,
    targetGeneration,
    previousActiveLockDigest,
    activeLockDigest,
    state,
    version: positiveInteger(
      record.version,
      'record version',
      MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
      InvalidPluginPackageInstallError,
    ),
    lastMutationId: identifier(
      record.lastMutationId,
      'last mutation id',
      InvalidPluginPackageInstallError,
    ),
    lastMutationDigest: digest(
      record.lastMutationDigest,
      'last mutation digest',
      InvalidPluginPackageInstallError,
    ),
    stageReceipt,
    activationReceipt,
    failure,
    createdAtMs,
    updatedAtMs,
  });
  if (
    !PACKAGE_NAME_PATTERN.test(unsigned.packageName) ||
    semver().valid(unsigned.packageVersion) !== unsigned.packageVersion
  ) {
    throw new InvalidPluginPackageInstallError(
      'record package identity is invalid',
    );
  }
  const recordDigest = digest(
    record.recordDigest,
    'record digest',
    InvalidPluginPackageInstallError,
  );
  if (contentDigest(unsigned) !== recordDigest) {
    throw new InvalidPluginPackageInstallError('record digest does not match');
  }
  return Object.freeze({ ...unsigned, recordDigest });
}

export function assertRecordMatchesLock(
  record: Readonly<PluginPackageInstallRecord>,
  lock: Readonly<PluginPackageLock>,
): void {
  if (
    record.projectId !== lock.projectId ||
    record.packageName !== lock.packageName ||
    record.packageVersion !== lock.packageVersion ||
    record.operation !== lock.operation ||
    record.lockDigest !== lock.lockDigest ||
    record.targetGeneration !== lock.targetGeneration ||
    record.previousActiveLockDigest !== (lock.previousLockDigest ?? null)
  ) {
    throw new PluginPackageInstallTransitionConflictError();
  }
}

export function assertPluginPackageInstallMatchesLock(
  lockValue: PluginPackageLock,
  recordValue: PluginPackageInstallRecord,
): void {
  const lock = normalizePluginPackageLock(lockValue);
  const record = normalizePluginPackageInstallRecord(recordValue);
  assertRecordMatchesLock(record, lock);
}

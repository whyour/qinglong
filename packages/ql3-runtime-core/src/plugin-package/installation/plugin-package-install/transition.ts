import { createPluginPackageResourceGenerationFromReferences } from '../../pluginPackageResourceGeneration';

import {
  MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
  PLUGIN_PACKAGE_INSTALL_FAILURE_REASONS,
  InvalidPluginPackageInstallError,
  PluginPackageInstallTransitionConflictError,
  PluginPackageInstallMutationConflictError,
  type PluginPackageInstallState,
  type PluginPackageInstallFailureReason,
  type PluginPackageLock,
  type PluginPackageStageReceipt,
  type PluginPackageActivationReceipt,
  type PluginPackageInstallFailure,
  type PluginPackageInstallRecord,
  type PluginPackageInstallEvent,
  type PluginPackageInstallCommit,
} from './contracts';
import {
  exactKeys,
  installObject,
  identifier,
  digest,
  timestamp,
  positiveInteger,
  contentDigest,
} from './codec';
import { normalizePluginPackageLock } from './lock';
import {
  initialMutationDigest,
  withRecordDigest,
  normalizePluginPackageInstallRecord,
  assertRecordMatchesLock,
} from './record';

export function normalizeEvent(
  value: PluginPackageInstallEvent,
): Readonly<PluginPackageInstallEvent> {
  const event = installObject(value, 'event');
  if (
    ![
      'stage_completed',
      'activation_started',
      'activation_committed',
      'failed',
    ].includes(event.type as string)
  ) {
    throw new InvalidPluginPackageInstallError('event type is invalid');
  }
  const common = {
    type: event.type,
    mutationId: identifier(
      event.mutationId,
      'mutation id',
      InvalidPluginPackageInstallError,
    ),
    occurredAtMs: timestamp(
      event.occurredAtMs,
      'event time',
      InvalidPluginPackageInstallError,
    ),
  };
  switch (event.type) {
    case 'stage_completed':
      exactKeys(
        event,
        [
          'type',
          'mutationId',
          'occurredAtMs',
          'stageRef',
          'artifactDigest',
          'manifestDigest',
          'contentDigest',
          'evidenceDigest',
        ],
        [],
        'stage event',
        InvalidPluginPackageInstallError,
      );
      return Object.freeze({
        ...common,
        type: 'stage_completed',
        stageRef: identifier(
          event.stageRef,
          'stage reference',
          InvalidPluginPackageInstallError,
        ),
        artifactDigest: digest(
          event.artifactDigest,
          'staged artifact digest',
          InvalidPluginPackageInstallError,
        ),
        manifestDigest: digest(
          event.manifestDigest,
          'staged manifest digest',
          InvalidPluginPackageInstallError,
        ),
        contentDigest: digest(
          event.contentDigest,
          'staged content digest',
          InvalidPluginPackageInstallError,
        ),
        evidenceDigest: digest(
          event.evidenceDigest,
          'staged evidence digest',
          InvalidPluginPackageInstallError,
        ),
      });
    case 'activation_started':
      exactKeys(
        event,
        ['type', 'mutationId', 'occurredAtMs'],
        [],
        'activation start event',
        InvalidPluginPackageInstallError,
      );
      return Object.freeze({ ...common, type: 'activation_started' });
    case 'activation_committed':
      exactKeys(
        event,
        [
          'type',
          'mutationId',
          'occurredAtMs',
          'activationRef',
          'intentDigest',
          'generation',
          'contentDigest',
        ],
        [],
        'activation commit event',
        InvalidPluginPackageInstallError,
      );
      return Object.freeze({
        ...common,
        type: 'activation_committed',
        activationRef: identifier(
          event.activationRef,
          'activation reference',
          InvalidPluginPackageInstallError,
        ),
        intentDigest: digest(
          event.intentDigest,
          'activation intent digest',
          InvalidPluginPackageInstallError,
        ),
        generation: positiveInteger(
          event.generation,
          'activation generation',
          MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
          InvalidPluginPackageInstallError,
        ),
        contentDigest: digest(
          event.contentDigest,
          'activated content digest',
          InvalidPluginPackageInstallError,
        ),
      });
    case 'failed':
      exactKeys(
        event,
        ['type', 'mutationId', 'occurredAtMs', 'reason'],
        [],
        'failure event',
        InvalidPluginPackageInstallError,
      );
      if (
        !PLUGIN_PACKAGE_INSTALL_FAILURE_REASONS.includes(
          event.reason as PluginPackageInstallFailureReason,
        )
      ) {
        throw new InvalidPluginPackageInstallError('failure reason is invalid');
      }
      return Object.freeze({
        ...common,
        type: 'failed',
        reason: event.reason as PluginPackageInstallFailureReason,
      });
    default:
      throw new InvalidPluginPackageInstallError('event type is invalid');
  }
}

export function eventDigest(event: Readonly<PluginPackageInstallEvent>): string {
  return contentDigest(event);
}

export function makeStageReceipt(
  event: Extract<PluginPackageInstallEvent, { type: 'stage_completed' }>,
): Readonly<PluginPackageStageReceipt> {
  const unsigned = Object.freeze({
    stageRef: event.stageRef,
    artifactDigest: event.artifactDigest,
    manifestDigest: event.manifestDigest,
    contentDigest: event.contentDigest,
    evidenceDigest: event.evidenceDigest,
    stagedAtMs: event.occurredAtMs,
  });
  return Object.freeze({
    ...unsigned,
    receiptDigest: contentDigest(unsigned),
  });
}

export function makeActivationReceipt(
  event: Extract<PluginPackageInstallEvent, { type: 'activation_committed' }>,
): Readonly<PluginPackageActivationReceipt> {
  const unsigned = Object.freeze({
    activationRef: event.activationRef,
    intentDigest: event.intentDigest,
    generation: event.generation,
    contentDigest: event.contentDigest,
    activatedAtMs: event.occurredAtMs,
  });
  return Object.freeze({
    ...unsigned,
    receiptDigest: contentDigest(unsigned),
  });
}

export function activationIntentDigest(
  lock: Readonly<PluginPackageLock>,
  record: Readonly<PluginPackageInstallRecord>,
): string {
  if (record.state !== 'activating' || record.stageReceipt === null) {
    throw new PluginPackageInstallTransitionConflictError();
  }
  const resourceGeneration =
    createPluginPackageResourceGenerationFromReferences({
      installationId: record.installationId,
      projectId: record.projectId,
      packageName: record.packageName,
      lockDigest: lock.lockDigest,
      generation: lock.targetGeneration,
      previousActiveLockDigest: record.previousActiveLockDigest,
      contentDigest: lock.source.contentDigest,
      resources: lock.resources,
    });
  return contentDigest({
    type: 'plugin_package_activation_intent',
    installationId: record.installationId,
    projectId: record.projectId,
    packageName: record.packageName,
    lockDigest: lock.lockDigest,
    targetGeneration: lock.targetGeneration,
    previousActiveLockDigest: record.previousActiveLockDigest,
    stageRef: record.stageReceipt.stageRef,
    stageReceiptDigest: record.stageReceipt.receiptDigest,
    stageEvidenceDigest: record.stageReceipt.evidenceDigest,
    contentDigest: lock.source.contentDigest,
    resourceGenerationDigest: resourceGeneration.generationDigest,
  });
}

export function pluginPackageActivationIntentDigest(
  lockValue: PluginPackageLock,
  recordValue: PluginPackageInstallRecord,
): string {
  const lock = normalizePluginPackageLock(lockValue);
  const record = normalizePluginPackageInstallRecord(recordValue);
  assertRecordMatchesLock(record, lock);
  return activationIntentDigest(lock, record);
}

export function transitionPluginPackageInstall(
  lockValue: PluginPackageLock,
  recordValue: PluginPackageInstallRecord,
  eventValue: PluginPackageInstallEvent,
): Readonly<PluginPackageInstallRecord> {
  const lock = normalizePluginPackageLock(lockValue);
  const record = normalizePluginPackageInstallRecord(recordValue);
  const event = normalizeEvent(eventValue);
  assertRecordMatchesLock(record, lock);
  const mutationDigest = eventDigest(event);
  if (record.lastMutationId === event.mutationId) {
    if (record.lastMutationDigest !== mutationDigest) {
      throw new PluginPackageInstallMutationConflictError();
    }
    return record;
  }
  if (
    event.occurredAtMs < record.updatedAtMs ||
    record.version >= MAX_PLUGIN_PACKAGE_INSTALL_VERSION
  ) {
    throw new PluginPackageInstallTransitionConflictError();
  }
  if (
    event.type === 'stage_completed' &&
    (record.state !== 'queued' ||
      event.artifactDigest !== lock.source.artifactDigest ||
      event.manifestDigest !== lock.manifestDigest ||
      event.contentDigest !== lock.source.contentDigest)
  ) {
    throw new PluginPackageInstallTransitionConflictError();
  }
  if (event.type === 'activation_started' && record.state !== 'staged') {
    throw new PluginPackageInstallTransitionConflictError();
  }
  if (
    event.type === 'activation_committed' &&
    (record.state !== 'activating' ||
      event.intentDigest !== activationIntentDigest(lock, record) ||
      event.generation !== lock.targetGeneration ||
      event.contentDigest !== lock.source.contentDigest)
  ) {
    throw new PluginPackageInstallTransitionConflictError();
  }
  if (
    event.type === 'failed' &&
    !['queued', 'staged', 'activating'].includes(record.state)
  ) {
    throw new PluginPackageInstallTransitionConflictError();
  }

  let state: PluginPackageInstallState;
  let stageReceipt = record.stageReceipt;
  let activationReceipt = record.activationReceipt;
  let failure = record.failure;
  let activeLockDigest = record.activeLockDigest;
  switch (event.type) {
    case 'stage_completed':
      state = 'staged';
      stageReceipt = makeStageReceipt(event);
      break;
    case 'activation_started':
      state = 'activating';
      break;
    case 'activation_committed':
      state = 'active';
      activationReceipt = makeActivationReceipt(event);
      activeLockDigest = lock.lockDigest;
      break;
    case 'failed':
      state = 'failed';
      failure = Object.freeze({
        reason: event.reason,
        failedFrom: record.state as PluginPackageInstallFailure['failedFrom'],
        failedAtMs: event.occurredAtMs,
      });
      break;
  }
  const { recordDigest: _previousRecordDigest, ...recordFields } = record;
  return withRecordDigest({
    ...recordFields,
    state,
    version: record.version + 1,
    lastMutationId: event.mutationId,
    lastMutationDigest: mutationDigest,
    stageReceipt,
    activationReceipt,
    failure,
    activeLockDigest,
    updatedAtMs: event.occurredAtMs,
  });
}

export function pluginPackageInstallCommit(
  previousValue: PluginPackageInstallRecord,
  nextValue: PluginPackageInstallRecord,
): Readonly<PluginPackageInstallCommit> {
  const previous = normalizePluginPackageInstallRecord(previousValue);
  const next = normalizePluginPackageInstallRecord(nextValue);
  const validNextStates: Readonly<
    Record<PluginPackageInstallState, readonly PluginPackageInstallState[]>
  > = {
    queued: ['staged', 'failed'],
    staged: ['activating', 'failed'],
    activating: ['active', 'failed'],
    active: [],
    failed: [],
  };
  if (
    next.installationId !== previous.installationId ||
    next.version !== previous.version + 1 ||
    next.createdAtMs !== previous.createdAtMs ||
    next.projectId !== previous.projectId ||
    next.packageName !== previous.packageName ||
    next.packageVersion !== previous.packageVersion ||
    next.operation !== previous.operation ||
    next.lockDigest !== previous.lockDigest ||
    next.targetGeneration !== previous.targetGeneration ||
    next.previousActiveLockDigest !== previous.previousActiveLockDigest ||
    !validNextStates[previous.state].includes(next.state)
  ) {
    throw new PluginPackageInstallTransitionConflictError();
  }
  return Object.freeze({
    installationId: next.installationId,
    expectedVersion: previous.version,
    expectedRecordDigest: previous.recordDigest,
    mutationId: next.lastMutationId,
    mutationDigest: next.lastMutationDigest,
    record: next,
  });
}

import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import {
  currentIdentity,
  LocalDeploymentConfigurationError,
} from '../foundation/contract';
import {
  runLocalDeploymentDockerCommand,
  validateLocalDeploymentDockerSocket,
  type LocalDeploymentDockerRunner,
} from '../foundation/docker';
import { validatePrivateDirectory } from '../foundation/files';
import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
} from './instanceLineage';
import { readTargetDataReconciliationEvidence } from './targetDataEvidence';
import {
  legacyCommitmentPath,
  parseTargetContainerEvidence,
  readLegacySilenceEvidence,
  readTargetApplicationBinding,
  type LegacySilenceEvidence,
  type TargetApplicationBinding,
} from './targetEvidence';
import {
  targetStopRunCommand,
  normalizeLocalDeploymentTargetStopCommand,
  type LocalDeploymentTargetReconciliationDisposition,
  type LocalDeploymentTargetStopCommand,
  type LocalDeploymentTargetStopResult,
} from './targetStopContract';
import {
  publishTargetRunJournalRecord,
  readTargetRunJournalRecord,
  targetRunJournalRecord,
  targetRunManualEvidence,
  targetRunPhasePath,
  targetRunSequence,
  targetStopPhasePath,
  targetStopSequence,
  verifyTargetRunManualEvidence,
  type TargetRunJournalRecord,
  type TargetRunManualReason,
} from './target-run/targetRunJournal';
import {
  targetStoppedEvidence,
  targetStopRequestEvidence,
  verifyTargetStoppedEvidence,
  verifyTargetStopRequestEvidence,
  type TargetStopActiveEvidence,
} from './targetStopRecordEvidence';
import {
  verifyTargetActiveEvidence,
  verifyTargetRequestEvidence,
} from './target-run/targetRunRecordEvidence';
import type { LocalDeploymentTargetRunCommand } from './target-run/targetRunContract';

export interface LocalDeploymentTargetStopDependencies {
  readonly runDocker?: LocalDeploymentDockerRunner;
  readonly validateSocket?: (socketPath: string, uid: number) => void;
  readonly afterBarrier?: () => void;
}

interface StopContext {
  readonly stopCommand: Readonly<LocalDeploymentTargetStopCommand>;
  readonly command: Readonly<LocalDeploymentTargetRunCommand>;
  readonly journal: string;
  readonly commitment: Readonly<LegacySilenceEvidence>;
  readonly application: Readonly<TargetApplicationBinding>;
  readonly uid: number;
}

interface PriorActive extends TargetStopActiveEvidence {
  readonly record: Readonly<TargetRunJournalRecord>;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(message);
}

function priorActive(context: Readonly<StopContext>): Readonly<PriorActive> {
  const generation = context.command.request.generation;
  const request = readTargetRunJournalRecord(
    targetRunPhasePath(context.journal, generation, 'request'),
    context,
    {
      sequence: targetRunSequence(generation, 'request'),
      generation,
      states: [
        generation === 1
          ? 'target_start_requested'
          : 'target_restart_requested',
      ],
    },
  );
  const requestEvidence = verifyTargetRequestEvidence(context, request);
  const active = readTargetRunJournalRecord(
    targetRunPhasePath(context.journal, generation, 'outcome'),
    context,
    {
      sequence: targetRunSequence(generation, 'outcome'),
      generation,
      states: ['target_active'],
      previousRecordDigest: request.recordDigest,
    },
  );
  const startupReceiptDigest = verifyTargetActiveEvidence(
    context,
    active,
    requestEvidence,
  );
  return Object.freeze({
    record: active,
    activeRecordDigest: active.recordDigest,
    targetContainerIdentityDigest:
      requestEvidence.targetContainerIdentityDigest,
    targetApplicationBindingDigest:
      requestEvidence.targetApplicationBindingDigest,
    startupReceiptDigest,
  });
}

function result(
  context: Readonly<StopContext>,
  status: 'prepared' | 'existing',
  record: Readonly<TargetRunJournalRecord>,
  reconciliation: LocalDeploymentTargetReconciliationDisposition,
): Readonly<LocalDeploymentTargetStopResult> {
  const head = advanceLocalCutoverInstanceHead(
    context.command,
    context.uid,
    record.state as 'target_stopped' | 'manual_required',
    record.generation,
    record.recordDigest,
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: context.stopCommand.operation,
    status,
    state: record.state as 'target_stopped' | 'manual_required',
    cutoverId: context.command.request.cutoverId,
    generation: context.command.request.generation,
    reconciliation,
    recordDigest: record.recordDigest,
    instanceHeadDigest: head.headDigest,
  });
}

function publishManual(
  context: Readonly<StopContext>,
  filePath: string,
  recordSequence: number,
  previousRecordDigest: string,
  reason: TargetRunManualReason,
): Readonly<LocalDeploymentTargetStopResult> {
  const record = targetRunJournalRecord(
    context.command,
    recordSequence,
    'manual_required',
    previousRecordDigest,
    targetRunManualEvidence(reason),
  );
  const status = publishTargetRunJournalRecord(
    context,
    filePath,
    record,
    'target stop manual resolution',
  );
  return result(context, status, record, 'manual_review');
}

function replayTerminal(
  context: Readonly<StopContext>,
  active: Readonly<PriorActive>,
): Readonly<LocalDeploymentTargetStopResult> | undefined {
  const generation = context.command.request.generation;
  const requestPath = targetStopPhasePath(
    context.journal,
    generation,
    'request',
  );
  if (!fs.existsSync(requestPath)) return undefined;
  const request = readTargetRunJournalRecord(requestPath, context, {
    sequence: targetStopSequence(generation, 'request'),
    generation,
    states: ['target_stop_requested', 'manual_required'],
    previousRecordDigest: active.record.recordDigest,
    requestedAtMs: context.command.request.requestedAtMs,
  });
  if (request.state === 'manual_required') {
    verifyTargetRunManualEvidence(request);
    return result(context, 'existing', request, 'manual_review');
  }
  verifyTargetStopRequestEvidence(request, active);
  const outcomePath = targetStopPhasePath(
    context.journal,
    generation,
    'outcome',
  );
  if (!fs.existsSync(outcomePath)) return undefined;
  const outcome = readTargetRunJournalRecord(outcomePath, context, {
    sequence: targetStopSequence(generation, 'outcome'),
    generation,
    states: ['target_stopped', 'manual_required'],
    previousRecordDigest: request.recordDigest,
    requestedAtMs: context.command.request.requestedAtMs,
  });
  if (outcome.state === 'manual_required') {
    verifyTargetRunManualEvidence(outcome);
    return result(context, 'existing', outcome, 'manual_review');
  }
  return result(
    context,
    'existing',
    outcome,
    verifyTargetStoppedEvidence(outcome, active).disposition,
  );
}

function docker(
  context: Readonly<StopContext>,
  runDocker: LocalDeploymentDockerRunner,
  args: readonly string[],
  timeoutMs: number,
): string {
  return runDocker({
    executable: context.command.options.dockerExecutable,
    socketPath: context.command.options.dockerSocketPath,
    args,
    timeoutMs,
  });
}

export function stopLocalDeploymentDockerTarget(
  input: unknown,
  dependencies: LocalDeploymentTargetStopDependencies = {},
): Readonly<LocalDeploymentTargetStopResult> {
  const stopCommand = normalizeLocalDeploymentTargetStopCommand(input);
  const command = targetStopRunCommand(stopCommand);
  const identity = currentIdentity();
  const serviceRoot = path.join(command.options.deploymentRoot, 'service');
  const journal = path.dirname(legacyCommitmentPath(command));
  validatePrivateDirectory(
    command.options.deploymentRoot,
    identity.uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(serviceRoot, identity.uid, 'serviceDescriptorRoot');
  validatePrivateDirectory(journal, identity.uid, 'cutoverJournal');
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    command.request.instanceId,
    identity.uid,
  );
  if (
    head.profile !== command.request.profile ||
    head.cutoverId !== command.request.cutoverId ||
    head.activationDigest !== command.request.expectedActivationDigest ||
    head.generation !== command.request.generation ||
    (head.state !== 'target_active' &&
      head.state !== 'target_stopped' &&
      head.state !== 'manual_required')
  ) {
    configurationError('target stop is not bound to the instance lineage head');
  }
  const commitment = readLegacySilenceEvidence(command);
  const application = readTargetApplicationBinding(command);
  const context = Object.freeze({
    stopCommand,
    command,
    journal,
    commitment,
    application,
    uid: identity.uid,
  });
  const active = priorActive(context);
  const replay = replayTerminal(context, active);
  if (replay !== undefined) return replay;

  const validateSocket =
    dependencies.validateSocket ?? validateLocalDeploymentDockerSocket;
  validateSocket(command.options.dockerSocketPath, identity.uid);
  const runDocker = dependencies.runDocker ?? runLocalDeploymentDockerCommand;
  const generation = command.request.generation;
  const requestPath = targetStopPhasePath(journal, generation, 'request');
  let request: Readonly<TargetRunJournalRecord>;
  if (fs.existsSync(requestPath)) {
    request = readTargetRunJournalRecord(requestPath, context, {
      sequence: targetStopSequence(generation, 'request'),
      generation,
      states: ['target_stop_requested'],
      previousRecordDigest: active.record.recordDigest,
      requestedAtMs: command.request.requestedAtMs,
    });
    verifyTargetStopRequestEvidence(request, active);
  } else {
    try {
      const target = parseTargetContainerEvidence(
        docker(
          context,
          runDocker,
          ['container', 'inspect', command.request.expectedTargetContainerId],
          30_000,
        ),
        command,
        application,
        'active',
      );
      if (
        target.identityDigest !== active.targetContainerIdentityDigest ||
        target.applicationBindingDigest !==
          active.targetApplicationBindingDigest
      ) {
        configurationError('active target identity changed before stop');
      }
    } catch {
      return publishManual(
        context,
        requestPath,
        targetStopSequence(generation, 'request'),
        active.record.recordDigest,
        'target_stop_preflight_unproved',
      );
    }
    request = targetRunJournalRecord(
      command,
      targetStopSequence(generation, 'request'),
      'target_stop_requested',
      active.record.recordDigest,
      targetStopRequestEvidence(active),
    );
    publishTargetRunJournalRecord(
      context,
      requestPath,
      request,
      'target stop barrier',
    );
    dependencies.afterBarrier?.();
  }

  try {
    docker(
      context,
      runDocker,
      [
        'container',
        'update',
        '--restart',
        'no',
        command.request.expectedTargetContainerId,
      ],
      30_000,
    );
  } catch {
    // Stop is convergent; the exact inspection below is authoritative.
  }
  try {
    docker(
      context,
      runDocker,
      [
        'container',
        'stop',
        '--time',
        '30',
        command.request.expectedTargetContainerId,
      ],
      45_000,
    );
  } catch {
    // A lost stop response is resolved by the exact inspection below.
  }
  const outcomePath = targetStopPhasePath(journal, generation, 'outcome');
  let target;
  try {
    target = parseTargetContainerEvidence(
      docker(
        context,
        runDocker,
        ['container', 'inspect', command.request.expectedTargetContainerId],
        30_000,
      ),
      command,
      application,
      'stopped',
    );
    if (
      target.identityDigest !== active.targetContainerIdentityDigest ||
      target.applicationBindingDigest !== active.targetApplicationBindingDigest
    ) {
      configurationError('stopped target identity changed');
    }
  } catch {
    return publishManual(
      context,
      outcomePath,
      targetStopSequence(generation, 'outcome'),
      request.recordDigest,
      'target_stop_result_unproved',
    );
  }
  const reconciliation = readTargetDataReconciliationEvidence(
    command,
    identity.uid,
  );
  const outcome = targetRunJournalRecord(
    command,
    targetStopSequence(generation, 'outcome'),
    'target_stopped',
    request.recordDigest,
    targetStoppedEvidence(active, reconciliation),
  );
  publishTargetRunJournalRecord(
    context,
    outcomePath,
    outcome,
    'target stopped commitment',
  );
  return result(context, 'prepared', outcome, reconciliation.disposition);
}

export function stopLocalDeploymentDockerTargetCommandFile(
  filePath: string,
): Readonly<LocalDeploymentTargetStopResult> {
  return stopLocalDeploymentDockerTarget(readPrivateLocalCommandFile(filePath));
}

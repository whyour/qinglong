import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import {
  currentIdentity,
  LocalDeploymentConfigurationError,
} from '../../foundation/contract';
import {
  runLocalDeploymentDockerCommand,
  validateLocalDeploymentDockerSocket,
  type LocalDeploymentDockerRunner,
} from '../../foundation/docker';
import { validatePrivateDirectory } from '../../foundation/files';
import {
  legacyCommitmentPath,
  parseStoppedLegacyEvidence,
  parseTargetContainerEvidence,
  readLegacySilenceEvidence,
  readTargetApplicationBinding,
  readTargetStartupReceipt,
  verifyTargetRunActivation,
  type LegacySilenceEvidence,
  type TargetApplicationBinding,
  type TargetContainerEvidence,
} from '../targetEvidence';
import {
  normalizeLocalDeploymentTargetRunCommand,
  type LocalDeploymentTargetRunCommand,
  type LocalDeploymentTargetRunResult,
} from './targetRunContract';
import {
  publishTargetRunJournalRecord as publishRecord,
  readTargetRunJournalRecord as readRecord,
  targetRunJournalRecord as journalRecord,
  targetRunManualEvidence as manualEvidence,
  targetRunPhasePath as phasePath,
  targetRunSequence as sequence,
  verifyTargetRunManualEvidence as verifyManualEvidence,
  type TargetRunJournalRecord,
  type TargetRunManualReason as ManualReason,
} from './targetRunJournal';
import {
  targetActiveEvidence as activeEvidence,
  targetRequestEvidence as requestEvidence,
  verifyTargetActiveEvidence as verifyActiveEvidence,
  verifyTargetRequestEvidence as verifyRequestEvidence,
} from './targetRunRecordEvidence';
import {
  advanceLocalCutoverInstanceHead,
  assertLocalCutoverTargetHead,
} from '../instanceLineage';

export interface LocalDeploymentTargetRunDependencies {
  readonly runDocker?: LocalDeploymentDockerRunner;
  readonly validateSocket?: (socketPath: string, uid: number) => void;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

interface RunContext {
  readonly command: Readonly<LocalDeploymentTargetRunCommand>;
  readonly journal: string;
  readonly commitment: Readonly<LegacySilenceEvidence>;
  readonly application: Readonly<TargetApplicationBinding>;
  readonly uid: number;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
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

function result(
  context: Readonly<RunContext>,
  status: 'prepared' | 'existing',
  record: Readonly<TargetRunJournalRecord>,
): Readonly<LocalDeploymentTargetRunResult> {
  advanceLocalCutoverInstanceHead(
    context.command,
    context.uid,
    record.state as 'target_active' | 'manual_required',
    record.generation,
    record.recordDigest,
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: context.command.operation,
    status,
    state: record.state as 'target_active' | 'manual_required',
    cutoverId: context.command.request.cutoverId,
    generation: context.command.request.generation,
    recordDigest: record.recordDigest,
  });
}

function publishManual(
  context: Readonly<RunContext>,
  filePath: string,
  recordSequence: number,
  previousRecordDigest: string,
  reason: ManualReason,
): Readonly<LocalDeploymentTargetRunResult> {
  const record = journalRecord(
    context.command,
    recordSequence,
    'manual_required',
    previousRecordDigest,
    manualEvidence(reason),
  );
  const status = publishRecord(
    context,
    filePath,
    record,
    'target cutover manual resolution',
  );
  return result(context, status, record);
}

function docker(
  command: Readonly<LocalDeploymentTargetRunCommand>,
  runDocker: LocalDeploymentDockerRunner,
  args: readonly string[],
  timeoutMs = 30_000,
): string {
  return runDocker({
    executable: command.options.dockerExecutable,
    socketPath: command.options.dockerSocketPath,
    args,
    timeoutMs,
  });
}

function inspectContainer(
  command: Readonly<LocalDeploymentTargetRunCommand>,
  runDocker: LocalDeploymentDockerRunner,
  containerId: string,
): string {
  return docker(command, runDocker, ['container', 'inspect', containerId]);
}

function readPriorActive(
  context: Readonly<RunContext>,
): Readonly<{ startupReceiptDigest: string; recordDigest: string }> {
  const generation = context.command.request.generation - 1;
  const request = readRecord(
    phasePath(context.journal, generation, 'request'),
    context,
    {
      sequence: sequence(generation, 'request'),
      generation,
      states: [
        generation === 1
          ? 'target_start_requested'
          : 'target_restart_requested',
      ],
    },
  );
  const requestEvidence = verifyRequestEvidence(
    {
      ...context,
      command: Object.freeze({
        ...context.command,
        operation:
          generation === 1
            ? ('local.deployment.cutover.target-start' as const)
            : ('local.deployment.cutover.target-restart' as const),
        request: Object.freeze({ ...context.command.request, generation }),
      }),
    },
    request,
  );
  const active = readRecord(
    phasePath(context.journal, generation, 'outcome'),
    context,
    {
      sequence: sequence(generation, 'outcome'),
      generation,
      states: ['target_active'],
      previousRecordDigest: request.recordDigest,
    },
  );
  const startupReceiptDigest = verifyActiveEvidence(
    {
      ...context,
      command: Object.freeze({
        ...context.command,
        operation:
          generation === 1
            ? ('local.deployment.cutover.target-start' as const)
            : ('local.deployment.cutover.target-restart' as const),
        request: Object.freeze({ ...context.command.request, generation }),
      }),
    },
    active,
    requestEvidence,
  );
  return Object.freeze({
    startupReceiptDigest,
    recordDigest: active.recordDigest,
  });
}

async function observeActiveTarget(
  context: Readonly<RunContext>,
  runDocker: LocalDeploymentDockerRunner,
  request: ReturnType<typeof verifyRequestEvidence>,
  now: () => number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<
  | Readonly<{
      target: Readonly<TargetContainerEvidence>;
      startupReceiptDigest: string;
    }>
  | undefined
> {
  const timeoutMs =
    context.command.request.profile === 'edge' ? 30_000 : 60_000;
  const maximumAttempts =
    context.command.request.profile === 'edge' ? 120 : 240;
  const deadline = now() + timeoutMs;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const target = parseTargetContainerEvidence(
        inspectContainer(
          context.command,
          runDocker,
          context.command.request.expectedTargetContainerId,
        ),
        context.command,
        context.application,
        'active',
      );
      const receipt = readTargetStartupReceipt(context.command);
      if (
        target.identityDigest === request.targetContainerIdentityDigest &&
        target.applicationBindingDigest ===
          request.targetApplicationBindingDigest &&
        receipt !== null &&
        receipt.digest !== request.previousStartupReceiptDigest
      ) {
        return Object.freeze({
          target,
          startupReceiptDigest: receipt.digest,
        });
      }
    } catch {
      // The bounded inspection-only window resolves all unknown start results.
    }
    if (now() >= deadline) return undefined;
    await wait(250);
  }
  return undefined;
}

function replayCurrentTerminal(
  context: Readonly<RunContext>,
  previousRecordDigest: string,
): Readonly<LocalDeploymentTargetRunResult> | undefined {
  const generation = context.command.request.generation;
  const requestPath = phasePath(context.journal, generation, 'request');
  if (!fs.existsSync(requestPath)) return undefined;
  const request = readRecord(requestPath, context, {
    sequence: sequence(generation, 'request'),
    generation,
    states: [
      generation === 1 ? 'target_start_requested' : 'target_restart_requested',
      'manual_required',
    ],
    previousRecordDigest,
    requestedAtMs: context.command.request.requestedAtMs,
  });
  if (request.state === 'manual_required') {
    verifyManualEvidence(request);
    return result(context, 'existing', request);
  }
  const requestBinding = verifyRequestEvidence(context, request);
  const outcomePath = phasePath(context.journal, generation, 'outcome');
  if (!fs.existsSync(outcomePath)) return undefined;
  const outcome = readRecord(outcomePath, context, {
    sequence: sequence(generation, 'outcome'),
    generation,
    states: ['target_active', 'manual_required'],
    previousRecordDigest: request.recordDigest,
    requestedAtMs: context.command.request.requestedAtMs,
  });
  if (outcome.state === 'manual_required') verifyManualEvidence(outcome);
  else verifyActiveEvidence(context, outcome, requestBinding);
  return result(context, 'existing', outcome);
}

function restartRecheckPrefix(
  context: Readonly<RunContext>,
  previousActiveDigest: string,
):
  | Readonly<{
      reverified: Readonly<TargetRunJournalRecord>;
      terminal?: Readonly<LocalDeploymentTargetRunResult>;
    }>
  | undefined {
  const generation = context.command.request.generation;
  const recheckPath = phasePath(context.journal, generation, 'recheck');
  if (!fs.existsSync(recheckPath)) return undefined;
  const recheck = readRecord(recheckPath, context, {
    sequence: sequence(generation, 'recheck'),
    generation,
    states: ['legacy_recheck_requested'],
    previousRecordDigest: previousActiveDigest,
    requestedAtMs: context.command.request.requestedAtMs,
  });
  const evidence = object(recheck.evidence, 'legacy recheck evidence');
  exact(
    evidence,
    ['legacyCommitmentDigest', 'legacyContainerId'],
    'legacy recheck evidence',
  );
  if (
    evidence.legacyCommitmentDigest !== context.commitment.commitmentDigest ||
    evidence.legacyContainerId !==
      context.command.request.expectedLegacyContainerId
  ) {
    configurationError('legacy recheck evidence drifted');
  }
  const verifiedPath = phasePath(context.journal, generation, 'verified');
  if (!fs.existsSync(verifiedPath)) return undefined;
  const verified = readRecord(verifiedPath, context, {
    sequence: sequence(generation, 'verified'),
    generation,
    states: ['legacy_reverified', 'manual_required'],
    previousRecordDigest: recheck.recordDigest,
    requestedAtMs: context.command.request.requestedAtMs,
  });
  if (verified.state === 'manual_required') {
    verifyManualEvidence(verified);
    return Object.freeze({
      reverified: verified,
      terminal: result(context, 'existing', verified),
    });
  }
  const verifiedEvidence = object(
    verified.evidence,
    'legacy reverified evidence',
  );
  exact(
    verifiedEvidence,
    [
      'legacyCommitmentDigest',
      'legacyContainerIdentityDigest',
      'legacySourceBindingDigest',
    ],
    'legacy reverified evidence',
  );
  if (
    verifiedEvidence.legacyCommitmentDigest !==
      context.commitment.commitmentDigest ||
    verifiedEvidence.legacyContainerIdentityDigest !==
      context.commitment.legacyContainerIdentityDigest ||
    verifiedEvidence.legacySourceBindingDigest !==
      context.commitment.legacySourceBindingDigest
  ) {
    configurationError('legacy reverified evidence drifted');
  }
  return Object.freeze({ reverified: verified });
}

async function runWithStartBarrier(
  context: Readonly<RunContext>,
  previousRecordDigest: string,
  previousStartupReceiptDigest: string | null,
  dependencies: Required<
    Pick<LocalDeploymentTargetRunDependencies, 'runDocker' | 'now' | 'wait'>
  >,
): Promise<Readonly<LocalDeploymentTargetRunResult>> {
  const generation = context.command.request.generation;
  const requestPath = phasePath(context.journal, generation, 'request');
  let request: Readonly<TargetRunJournalRecord>;
  let requestStatus: 'prepared' | 'existing';
  if (fs.existsSync(requestPath)) {
    request = readRecord(requestPath, context, {
      sequence: sequence(generation, 'request'),
      generation,
      states: [
        generation === 1
          ? 'target_start_requested'
          : 'target_restart_requested',
      ],
      previousRecordDigest,
      requestedAtMs: context.command.request.requestedAtMs,
    });
    requestStatus = 'existing';
  } else {
    let target: Readonly<TargetContainerEvidence>;
    try {
      target = parseTargetContainerEvidence(
        inspectContainer(
          context.command,
          dependencies.runDocker,
          context.command.request.expectedTargetContainerId,
        ),
        context.command,
        context.application,
        'stopped',
      );
      const receipt = readTargetStartupReceipt(context.command);
      if (
        (generation === 1 && receipt !== null) ||
        (generation > 1 && receipt?.digest !== previousStartupReceiptDigest)
      ) {
        configurationError('target startup receipt preflight is invalid');
      }
    } catch {
      return publishManual(
        context,
        requestPath,
        sequence(generation, 'request'),
        previousRecordDigest,
        'target_preflight_unproved',
      );
    }
    request = journalRecord(
      context.command,
      sequence(generation, 'request'),
      generation === 1 ? 'target_start_requested' : 'target_restart_requested',
      previousRecordDigest,
      requestEvidence(context, target, previousStartupReceiptDigest),
    );
    requestStatus = publishRecord(
      context,
      requestPath,
      request,
      'target start barrier',
    );
  }
  const requestBinding = verifyRequestEvidence(context, request);
  const outcomePath = phasePath(context.journal, generation, 'outcome');
  if (fs.existsSync(outcomePath)) {
    const existing = replayCurrentTerminal(context, previousRecordDigest);
    if (existing === undefined) configurationError('target outcome drifted');
    return existing;
  }
  if (requestStatus === 'prepared') {
    try {
      const output = docker(
        context.command,
        dependencies.runDocker,
        [
          'container',
          'start',
          context.command.request.expectedTargetContainerId,
        ],
        45_000,
      ).trim();
      if (output !== context.command.request.expectedTargetContainerId) {
        configurationError('target start response identity is invalid');
      }
    } catch {
      // The durable barrier forbids retry; inspection below is authoritative.
    }
  }
  const observed = await observeActiveTarget(
    context,
    dependencies.runDocker,
    requestBinding,
    dependencies.now,
    dependencies.wait,
  );
  if (observed === undefined) {
    return publishManual(
      context,
      outcomePath,
      sequence(generation, 'outcome'),
      request.recordDigest,
      generation === 1
        ? 'target_start_result_unproved'
        : 'target_restart_result_unproved',
    );
  }
  const active = journalRecord(
    context.command,
    sequence(generation, 'outcome'),
    'target_active',
    request.recordDigest,
    activeEvidence(context, observed.target, observed.startupReceiptDigest),
  );
  publishRecord(context, outcomePath, active, 'target active commitment');
  return result(context, 'prepared', active);
}

export async function runLocalDeploymentDockerTarget(
  input: unknown,
  dependencies: LocalDeploymentTargetRunDependencies = {},
): Promise<Readonly<LocalDeploymentTargetRunResult>> {
  const command = normalizeLocalDeploymentTargetRunCommand(input);
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
  verifyTargetRunActivation(command);
  const commitment = readLegacySilenceEvidence(command);
  const application = readTargetApplicationBinding(command);
  const context = Object.freeze({
    command,
    journal,
    commitment,
    application,
    uid: identity.uid,
  });
  const instanceHead = assertLocalCutoverTargetHead(command, identity.uid);
  if (
    instanceHead.state === 'manual_required' &&
    instanceHead.generation !== command.request.generation
  ) {
    configurationError('manual-required instance lineage is terminal');
  }

  let previousRecordDigest = commitment.commitmentDigest;
  let previousStartupReceiptDigest: string | null = null;
  let canReplayCurrent = command.request.generation === 1;
  if (command.request.generation > 1) {
    const prior = readPriorActive(context);
    previousRecordDigest = prior.recordDigest;
    previousStartupReceiptDigest = prior.startupReceiptDigest;
    const prefix = restartRecheckPrefix(context, previousRecordDigest);
    if (prefix?.terminal !== undefined) return prefix.terminal;
    if (prefix !== undefined) {
      previousRecordDigest = prefix.reverified.recordDigest;
      canReplayCurrent = true;
    }
  }
  const replay = canReplayCurrent
    ? replayCurrentTerminal(context, previousRecordDigest)
    : undefined;
  if (replay !== undefined) return replay;

  const validateSocket =
    dependencies.validateSocket ?? validateLocalDeploymentDockerSocket;
  validateSocket(command.options.dockerSocketPath, identity.uid);
  const runDocker = dependencies.runDocker ?? runLocalDeploymentDockerCommand;
  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  if (command.request.generation > 1) {
    const recheckPath = phasePath(
      journal,
      command.request.generation,
      'recheck',
    );
    let recheck: Readonly<TargetRunJournalRecord>;
    if (fs.existsSync(recheckPath)) {
      recheck = readRecord(recheckPath, context, {
        sequence: sequence(command.request.generation, 'recheck'),
        generation: command.request.generation,
        states: ['legacy_recheck_requested'],
        previousRecordDigest,
        requestedAtMs: command.request.requestedAtMs,
      });
    } else {
      recheck = journalRecord(
        command,
        sequence(command.request.generation, 'recheck'),
        'legacy_recheck_requested',
        previousRecordDigest,
        Object.freeze({
          legacyCommitmentDigest: commitment.commitmentDigest,
          legacyContainerId: command.request.expectedLegacyContainerId,
        }),
      );
      publishRecord(context, recheckPath, recheck, 'legacy recheck request');
    }
    const verifiedPath = phasePath(
      journal,
      command.request.generation,
      'verified',
    );
    let verified: Readonly<TargetRunJournalRecord>;
    if (fs.existsSync(verifiedPath)) {
      verified = readRecord(verifiedPath, context, {
        sequence: sequence(command.request.generation, 'verified'),
        generation: command.request.generation,
        states: ['legacy_reverified', 'manual_required'],
        previousRecordDigest: recheck.recordDigest,
        requestedAtMs: command.request.requestedAtMs,
      });
      if (verified.state === 'manual_required') {
        verifyManualEvidence(verified);
        return result(context, 'existing', verified);
      }
    } else {
      let legacy;
      try {
        legacy = parseStoppedLegacyEvidence(
          inspectContainer(
            command,
            runDocker,
            command.request.expectedLegacyContainerId,
          ),
          command,
        );
        if (
          legacy.identityDigest !== commitment.legacyContainerIdentityDigest ||
          legacy.sourceBindingDigest !== commitment.legacySourceBindingDigest
        ) {
          configurationError('legacy silence evidence changed');
        }
      } catch {
        return publishManual(
          context,
          verifiedPath,
          sequence(command.request.generation, 'verified'),
          recheck.recordDigest,
          'legacy_silence_unproved',
        );
      }
      verified = journalRecord(
        command,
        sequence(command.request.generation, 'verified'),
        'legacy_reverified',
        recheck.recordDigest,
        Object.freeze({
          legacyCommitmentDigest: commitment.commitmentDigest,
          legacyContainerIdentityDigest: legacy.identityDigest,
          legacySourceBindingDigest: legacy.sourceBindingDigest,
        }),
      );
      publishRecord(
        context,
        verifiedPath,
        verified,
        'legacy reverified commitment',
      );
    }
    previousRecordDigest = verified.recordDigest;
  }

  return runWithStartBarrier(
    context,
    previousRecordDigest,
    previousStartupReceiptDigest,
    { runDocker, now, wait },
  );
}

export function runLocalDeploymentDockerTargetCommandFile(
  filePath: string,
): Promise<Readonly<LocalDeploymentTargetRunResult>> {
  return runLocalDeploymentDockerTarget(readPrivateLocalCommandFile(filePath));
}

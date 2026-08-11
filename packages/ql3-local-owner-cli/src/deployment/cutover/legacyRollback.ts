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
import {
  preflightPublishedFile,
  publishExactFile,
  validatePrivateDirectory,
} from '../foundation/files';
import {
  advanceLocalCutoverInstanceHead,
  localCutoverInstanceDirectory,
  readLocalCutoverInstanceHead,
  type LocalCutoverInstanceHead,
} from './instanceLineage';
import {
  EMPTY_ROLLBACK_PREPARATION_DIGEST,
  legacyRollbackTargetRunCommand,
  normalizeLocalDeploymentLegacyRollbackCommand,
  type LocalDeploymentLegacyRollbackCommand,
  type LocalDeploymentLegacyRollbackResult,
} from './legacyRollbackContract';
import {
  readTargetDataReconciliationEvidence,
  type TargetDataReconciliationEvidence,
} from './targetDataEvidence';
import {
  cutoverDigest,
  legacyCommitmentPath,
  parseActiveLegacyEvidence,
  parseStoppedLegacyEvidence,
  parseTargetContainerEvidence,
  readLegacySilenceEvidence,
  readTargetApplicationBinding,
  type LegacySilenceEvidence,
  type TargetApplicationBinding,
} from './targetEvidence';
import {
  legacyRollbackPhasePath,
  legacyRollbackSequence,
  publishTargetRunJournalRecord,
  readTargetRunJournalRecord,
  targetRunJournalRecord,
  targetRunManualEvidence,
  targetRunPhasePath,
  targetRunSequence,
  targetStopPhasePath,
  targetStopSequence,
  verifyTargetRunManualEvidence,
  type TargetRunJournalContext,
  type TargetRunJournalRecord,
} from './target-run/targetRunJournal';
import {
  verifyTargetActiveEvidence,
  verifyTargetRequestEvidence,
} from './target-run/targetRunRecordEvidence';
import {
  verifyTargetStoppedEvidence,
  verifyTargetStopRequestEvidence,
  type TargetStopActiveEvidence,
} from './targetStopRecordEvidence';
import type { LocalDeploymentTargetRunCommand } from './target-run/targetRunContract';

const PREPARATION_SCHEMA = 'qinglong3-local-legacy-rollback-preparation';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PREPARATIONS_PER_INSTANCE = 15;

export interface LocalDeploymentLegacyRollbackDependencies {
  readonly runDocker?: LocalDeploymentDockerRunner;
  readonly validateSocket?: (socketPath: string, uid: number) => void;
  readonly afterBarrier?: () => void;
  readonly afterStart?: () => void;
}

interface RollbackContext {
  readonly rollbackCommand: Readonly<LocalDeploymentLegacyRollbackCommand>;
  readonly command: Readonly<LocalDeploymentTargetRunCommand>;
  readonly sourceCommand: Readonly<LocalDeploymentTargetRunCommand>;
  readonly journalCommand: Readonly<LocalDeploymentTargetRunCommand>;
  readonly journal: string;
  readonly uid: number;
  readonly commitment: Readonly<LegacySilenceEvidence>;
  readonly application: Readonly<TargetApplicationBinding>;
}

interface RollbackSource {
  readonly active: Readonly<TargetStopActiveEvidence>;
  readonly stoppedRecord: Readonly<TargetRunJournalRecord>;
  readonly reconciliation: Readonly<TargetDataReconciliationEvidence>;
}

interface RollbackPreparation {
  readonly schema: typeof PREPARATION_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'rollback_prepared';
  readonly cutoverId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly activationDigest: string;
  readonly generation: number;
  readonly expectedInstanceHeadDigest: string;
  readonly stoppedRecordDigest: string;
  readonly reconciliationEvidenceDigest: string;
  readonly legacyContainerIdentityDigest: string;
  readonly legacySourceBindingDigest: string;
  readonly targetContainerIdentityDigest: string;
  readonly targetApplicationBindingDigest: string;
  readonly rollbackRequestedAtMs: number;
  readonly preparationDigest: string;
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

function journalCommand(
  source: Readonly<LocalDeploymentTargetRunCommand>,
  requestedAtMs: number,
): Readonly<LocalDeploymentTargetRunCommand> {
  return Object.freeze({
    ...source,
    request: Object.freeze({ ...source.request, requestedAtMs }),
  });
}

function targetContext(
  context: Readonly<RollbackContext>,
): Readonly<TargetRunJournalContext> {
  return Object.freeze({ command: context.sourceCommand, uid: context.uid });
}

function rollbackContext(
  context: Readonly<RollbackContext>,
): Readonly<TargetRunJournalContext> {
  return Object.freeze({ command: context.journalCommand, uid: context.uid });
}

function readRollbackSource(
  context: Readonly<RollbackContext>,
): Readonly<RollbackSource> {
  const generation = context.sourceCommand.request.generation;
  const request = readTargetRunJournalRecord(
    targetRunPhasePath(context.journal, generation, 'request'),
    targetContext(context),
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
  const activeRecord = readTargetRunJournalRecord(
    targetRunPhasePath(context.journal, generation, 'outcome'),
    targetContext(context),
    {
      sequence: targetRunSequence(generation, 'outcome'),
      generation,
      states: ['target_active'],
      previousRecordDigest: request.recordDigest,
    },
  );
  const active = Object.freeze({
    activeRecordDigest: activeRecord.recordDigest,
    targetContainerIdentityDigest:
      requestEvidence.targetContainerIdentityDigest,
    targetApplicationBindingDigest:
      requestEvidence.targetApplicationBindingDigest,
    startupReceiptDigest: verifyTargetActiveEvidence(
      context,
      activeRecord,
      requestEvidence,
    ),
  });
  const stopRequest = readTargetRunJournalRecord(
    targetStopPhasePath(context.journal, generation, 'request'),
    targetContext(context),
    {
      sequence: targetStopSequence(generation, 'request'),
      generation,
      states: ['target_stop_requested'],
      previousRecordDigest: activeRecord.recordDigest,
      requestedAtMs: context.sourceCommand.request.requestedAtMs,
    },
  );
  verifyTargetStopRequestEvidence(stopRequest, active);
  const stoppedRecord = readTargetRunJournalRecord(
    targetStopPhasePath(context.journal, generation, 'outcome'),
    targetContext(context),
    {
      sequence: targetStopSequence(generation, 'outcome'),
      generation,
      states: ['target_stopped'],
      previousRecordDigest: stopRequest.recordDigest,
      requestedAtMs: context.sourceCommand.request.requestedAtMs,
    },
  );
  const reconciliation = verifyTargetStoppedEvidence(stoppedRecord, active);
  if (
    stoppedRecord.recordDigest !==
      context.rollbackCommand.request.expectedStoppedRecordDigest ||
    reconciliation.disposition !== 'rollback_candidate'
  ) {
    configurationError('legacy rollback requires the exact rollback candidate');
  }
  return Object.freeze({ active, stoppedRecord, reconciliation });
}

function preparationPath(
  command: Readonly<LocalDeploymentLegacyRollbackCommand>,
): string {
  return path.join(
    localCutoverInstanceDirectory(
      command.options.deploymentRoot,
      command.request.instanceId,
    ),
    `rollback-${command.request.cutoverId}-${String(
      command.request.generation,
    ).padStart(2, '0')}.json`,
  );
}

function preparationRecord(
  context: Readonly<RollbackContext>,
  source: Readonly<RollbackSource>,
): Readonly<RollbackPreparation> {
  const payload = Object.freeze({
    schema: PREPARATION_SCHEMA,
    schemaVersion: 1 as const,
    state: 'rollback_prepared' as const,
    cutoverId: context.sourceCommand.request.cutoverId,
    profile: context.sourceCommand.request.profile,
    instanceId: context.sourceCommand.request.instanceId,
    activationDigest: context.sourceCommand.request.expectedActivationDigest,
    generation: context.sourceCommand.request.generation,
    expectedInstanceHeadDigest:
      context.rollbackCommand.request.expectedInstanceHeadDigest,
    stoppedRecordDigest: source.stoppedRecord.recordDigest,
    reconciliationEvidenceDigest: source.reconciliation.evidenceDigest,
    legacyContainerIdentityDigest:
      context.commitment.legacyContainerIdentityDigest,
    legacySourceBindingDigest: context.commitment.legacySourceBindingDigest,
    targetContainerIdentityDigest: source.active.targetContainerIdentityDigest,
    targetApplicationBindingDigest:
      source.active.targetApplicationBindingDigest,
    rollbackRequestedAtMs:
      context.rollbackCommand.request.rollbackRequestedAtMs,
  });
  return Object.freeze({
    ...payload,
    preparationDigest: cutoverDigest(payload),
  });
}

function parsePreparation(
  value: unknown,
  context: Readonly<RollbackContext>,
  source: Readonly<RollbackSource>,
): Readonly<RollbackPreparation> {
  const record = object(value, 'legacy rollback preparation');
  exact(
    record,
    [
      'activationDigest',
      'cutoverId',
      'expectedInstanceHeadDigest',
      'generation',
      'instanceId',
      'legacyContainerIdentityDigest',
      'legacySourceBindingDigest',
      'preparationDigest',
      'profile',
      'reconciliationEvidenceDigest',
      'rollbackRequestedAtMs',
      'schema',
      'schemaVersion',
      'state',
      'stoppedRecordDigest',
      'targetApplicationBindingDigest',
      'targetContainerIdentityDigest',
    ],
    'legacy rollback preparation',
  );
  const { preparationDigest, ...payload } = record;
  if (
    record.schema !== PREPARATION_SCHEMA ||
    record.schemaVersion !== 1 ||
    record.state !== 'rollback_prepared' ||
    record.cutoverId !== context.sourceCommand.request.cutoverId ||
    record.profile !== context.sourceCommand.request.profile ||
    record.instanceId !== context.sourceCommand.request.instanceId ||
    record.activationDigest !==
      context.sourceCommand.request.expectedActivationDigest ||
    record.generation !== context.sourceCommand.request.generation ||
    record.expectedInstanceHeadDigest !==
      context.rollbackCommand.request.expectedInstanceHeadDigest ||
    record.stoppedRecordDigest !== source.stoppedRecord.recordDigest ||
    record.reconciliationEvidenceDigest !==
      source.reconciliation.evidenceDigest ||
    record.legacyContainerIdentityDigest !==
      context.commitment.legacyContainerIdentityDigest ||
    record.legacySourceBindingDigest !==
      context.commitment.legacySourceBindingDigest ||
    record.targetContainerIdentityDigest !==
      source.active.targetContainerIdentityDigest ||
    record.targetApplicationBindingDigest !==
      source.active.targetApplicationBindingDigest ||
    record.rollbackRequestedAtMs !==
      context.rollbackCommand.request.rollbackRequestedAtMs ||
    typeof preparationDigest !== 'string' ||
    !DIGEST_PATTERN.test(preparationDigest) ||
    cutoverDigest(payload) !== preparationDigest
  ) {
    configurationError('legacy rollback preparation drifted');
  }
  return record as unknown as Readonly<RollbackPreparation>;
}

function docker(
  context: Readonly<RollbackContext>,
  runDocker: LocalDeploymentDockerRunner,
  args: readonly string[],
  timeoutMs: number,
): string {
  return runDocker({
    executable: context.sourceCommand.options.dockerExecutable,
    socketPath: context.sourceCommand.options.dockerSocketPath,
    args,
    timeoutMs,
  });
}

function stoppedObservations(
  context: Readonly<RollbackContext>,
  source: Readonly<RollbackSource>,
  runDocker: LocalDeploymentDockerRunner,
): void {
  const legacy = parseStoppedLegacyEvidence(
    docker(
      context,
      runDocker,
      [
        'container',
        'inspect',
        context.sourceCommand.request.expectedLegacyContainerId,
      ],
      30_000,
    ),
    context.sourceCommand,
  );
  const target = parseTargetContainerEvidence(
    docker(
      context,
      runDocker,
      [
        'container',
        'inspect',
        context.sourceCommand.request.expectedTargetContainerId,
      ],
      30_000,
    ),
    context.sourceCommand,
    context.application,
    'stopped',
  );
  const reconciliation = readTargetDataReconciliationEvidence(
    context.sourceCommand,
    context.uid,
  );
  if (
    legacy.identityDigest !==
      context.commitment.legacyContainerIdentityDigest ||
    legacy.sourceBindingDigest !==
      context.commitment.legacySourceBindingDigest ||
    target.identityDigest !== source.active.targetContainerIdentityDigest ||
    target.applicationBindingDigest !==
      source.active.targetApplicationBindingDigest ||
    reconciliation.disposition !== 'rollback_candidate' ||
    reconciliation.evidenceDigest !== source.reconciliation.evidenceDigest
  ) {
    configurationError('legacy rollback stopped evidence drifted');
  }
}

function result(
  context: Readonly<RollbackContext>,
  status: 'prepared' | 'existing',
  state: LocalDeploymentLegacyRollbackResult['state'],
  preparationDigest: string,
  recordDigest: string,
): Readonly<LocalDeploymentLegacyRollbackResult> {
  const head = advanceLocalCutoverInstanceHead(
    context.sourceCommand,
    context.uid,
    state,
    context.sourceCommand.request.generation,
    state === 'rollback_prepared' ? preparationDigest : recordDigest,
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: context.rollbackCommand.operation,
    status,
    state,
    cutoverId: context.sourceCommand.request.cutoverId,
    generation: context.sourceCommand.request.generation,
    preparationDigest,
    recordDigest,
    instanceHeadDigest: head.headDigest,
  });
}

function requestEvidence(
  preparation: Readonly<RollbackPreparation>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    preparationDigest: preparation.preparationDigest,
    stoppedRecordDigest: preparation.stoppedRecordDigest,
    reconciliationEvidenceDigest: preparation.reconciliationEvidenceDigest,
    legacyContainerIdentityDigest: preparation.legacyContainerIdentityDigest,
    legacySourceBindingDigest: preparation.legacySourceBindingDigest,
    targetContainerIdentityDigest: preparation.targetContainerIdentityDigest,
    targetApplicationBindingDigest: preparation.targetApplicationBindingDigest,
  });
}

function verifyRequestEvidence(
  record: Readonly<TargetRunJournalRecord>,
  preparation: Readonly<RollbackPreparation>,
): void {
  const evidence = object(record.evidence, 'legacy rollback request evidence');
  const expected = requestEvidence(preparation);
  exact(evidence, Object.keys(expected), 'legacy rollback request evidence');
  if (
    Object.entries(expected).some(([key, value]) => evidence[key] !== value)
  ) {
    configurationError('legacy rollback request evidence drifted');
  }
}

function outcomeEvidence(
  request: Readonly<TargetRunJournalRecord>,
  preparation: Readonly<RollbackPreparation>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    preparationDigest: preparation.preparationDigest,
    requestRecordDigest: request.recordDigest,
    legacyContainerIdentityDigest: preparation.legacyContainerIdentityDigest,
    legacySourceBindingDigest: preparation.legacySourceBindingDigest,
    targetContainerIdentityDigest: preparation.targetContainerIdentityDigest,
    targetApplicationBindingDigest: preparation.targetApplicationBindingDigest,
  });
}

function verifyOutcomeEvidence(
  record: Readonly<TargetRunJournalRecord>,
  request: Readonly<TargetRunJournalRecord>,
  preparation: Readonly<RollbackPreparation>,
): void {
  const evidence = object(record.evidence, 'legacy rollback outcome evidence');
  const expected = outcomeEvidence(request, preparation);
  exact(evidence, Object.keys(expected), 'legacy rollback outcome evidence');
  if (
    Object.entries(expected).some(([key, value]) => evidence[key] !== value)
  ) {
    configurationError('legacy rollback outcome evidence drifted');
  }
}

function publishManual(
  context: Readonly<RollbackContext>,
  filePath: string,
  sequence: number,
  previousRecordDigest: string,
  reason:
    | 'legacy_restart_preflight_unproved'
    | 'legacy_restart_result_unproved',
  preparationDigest: string,
): Readonly<LocalDeploymentLegacyRollbackResult> {
  const record = targetRunJournalRecord(
    context.journalCommand,
    sequence,
    'manual_required',
    previousRecordDigest,
    targetRunManualEvidence(reason),
  );
  const status = publishTargetRunJournalRecord(
    rollbackContext(context),
    filePath,
    record,
    'legacy rollback manual resolution',
  );
  return result(
    context,
    status,
    'manual_required',
    preparationDigest,
    record.recordDigest,
  );
}

function replayCommit(
  context: Readonly<RollbackContext>,
  preparation: Readonly<RollbackPreparation>,
): Readonly<LocalDeploymentLegacyRollbackResult> | undefined {
  const generation = context.sourceCommand.request.generation;
  const requestPath = legacyRollbackPhasePath(
    context.journal,
    generation,
    'request',
  );
  if (!fs.existsSync(requestPath)) return undefined;
  const request = readTargetRunJournalRecord(
    requestPath,
    rollbackContext(context),
    {
      sequence: legacyRollbackSequence(generation, 'request'),
      generation,
      states: ['legacy_restart_requested', 'manual_required'],
      previousRecordDigest: preparation.preparationDigest,
      requestedAtMs: context.rollbackCommand.request.rollbackRequestedAtMs,
    },
  );
  if (request.state === 'manual_required') {
    verifyTargetRunManualEvidence(request);
    return result(
      context,
      'existing',
      'manual_required',
      preparation.preparationDigest,
      request.recordDigest,
    );
  }
  verifyRequestEvidence(request, preparation);
  const outcomePath = legacyRollbackPhasePath(
    context.journal,
    generation,
    'outcome',
  );
  if (!fs.existsSync(outcomePath)) return undefined;
  const outcome = readTargetRunJournalRecord(
    outcomePath,
    rollbackContext(context),
    {
      sequence: legacyRollbackSequence(generation, 'outcome'),
      generation,
      states: ['legacy_running', 'manual_required'],
      previousRecordDigest: request.recordDigest,
      requestedAtMs: context.rollbackCommand.request.rollbackRequestedAtMs,
    },
  );
  if (outcome.state === 'manual_required') {
    verifyTargetRunManualEvidence(outcome);
    return result(
      context,
      'existing',
      'manual_required',
      preparation.preparationDigest,
      outcome.recordDigest,
    );
  }
  verifyOutcomeEvidence(outcome, request, preparation);
  return result(
    context,
    'existing',
    'legacy_running',
    preparation.preparationDigest,
    outcome.recordDigest,
  );
}

function prepare(
  context: Readonly<RollbackContext>,
  source: Readonly<RollbackSource>,
  head: Readonly<LocalCutoverInstanceHead>,
  dependencies: LocalDeploymentLegacyRollbackDependencies,
): Readonly<LocalDeploymentLegacyRollbackResult> {
  const filePath = preparationPath(context.rollbackCommand);
  if (head.state === 'rollback_prepared') {
    const preparation = parsePreparation(
      readPrivateLocalCommandFile(filePath),
      context,
      source,
    );
    if (
      head.previousHeadDigest !==
        context.rollbackCommand.request.expectedInstanceHeadDigest ||
      head.sourceRecordDigest !== preparation.preparationDigest
    ) {
      configurationError('legacy rollback preparation lost the instance head');
    }
    return result(
      context,
      'existing',
      'rollback_prepared',
      preparation.preparationDigest,
      source.stoppedRecord.recordDigest,
    );
  }
  if (
    head.state !== 'target_stopped' ||
    head.headDigest !==
      context.rollbackCommand.request.expectedInstanceHeadDigest ||
    head.sourceRecordDigest !== source.stoppedRecord.recordDigest ||
    head.generation !== context.sourceCommand.request.generation
  ) {
    configurationError(
      'legacy rollback prepare is not bound to target stopped',
    );
  }
  const validateSocket =
    dependencies.validateSocket ?? validateLocalDeploymentDockerSocket;
  validateSocket(context.sourceCommand.options.dockerSocketPath, context.uid);
  const runDocker = dependencies.runDocker ?? runLocalDeploymentDockerCommand;
  stoppedObservations(context, source, runDocker);
  const preparation = preparationRecord(context, source);
  const serialized = `${JSON.stringify(preparation, null, 2)}\n`;
  const directory = path.dirname(filePath);
  const preparationEntries = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith('rollback-'));
  if (preparationEntries.some((entry) => !entry.isFile())) {
    configurationError(
      'legacy rollback preparation directory contains an unsafe entry',
    );
  }
  if (
    preparationEntries.length >= MAX_PREPARATIONS_PER_INSTANCE &&
    !fs.existsSync(filePath)
  ) {
    configurationError(
      'legacy rollback preparation retention limit is reached',
    );
  }
  preflightPublishedFile(
    filePath,
    serialized,
    0o600,
    context.uid,
    'legacy rollback preparation',
  );
  const status = publishExactFile(
    filePath,
    serialized,
    0o600,
    context.uid,
    'legacy rollback preparation',
  );
  return result(
    context,
    status,
    'rollback_prepared',
    preparation.preparationDigest,
    source.stoppedRecord.recordDigest,
  );
}

function commit(
  context: Readonly<RollbackContext>,
  source: Readonly<RollbackSource>,
  head: Readonly<LocalCutoverInstanceHead>,
  dependencies: LocalDeploymentLegacyRollbackDependencies,
): Readonly<LocalDeploymentLegacyRollbackResult> {
  const preparation = parsePreparation(
    readPrivateLocalCommandFile(preparationPath(context.rollbackCommand)),
    context,
    source,
  );
  if (
    preparation.preparationDigest !==
    context.rollbackCommand.request.expectedPreparationDigest
  ) {
    configurationError('legacy rollback commit preparation is invalid');
  }
  const replay = replayCommit(context, preparation);
  if (replay !== undefined) return replay;
  if (
    head.state !== 'rollback_prepared' &&
    head.state !== 'legacy_restart_requested'
  ) {
    configurationError('legacy rollback commit is not bound to preparation');
  }
  if (
    head.state === 'rollback_prepared' &&
    (head.sourceRecordDigest !== preparation.preparationDigest ||
      head.previousHeadDigest !==
        context.rollbackCommand.request.expectedInstanceHeadDigest)
  ) {
    configurationError('legacy rollback commit lost the instance head');
  }
  const validateSocket =
    dependencies.validateSocket ?? validateLocalDeploymentDockerSocket;
  validateSocket(context.sourceCommand.options.dockerSocketPath, context.uid);
  const runDocker = dependencies.runDocker ?? runLocalDeploymentDockerCommand;
  const generation = context.sourceCommand.request.generation;
  const requestPath = legacyRollbackPhasePath(
    context.journal,
    generation,
    'request',
  );
  let request: Readonly<TargetRunJournalRecord>;
  let shouldStart = false;
  if (fs.existsSync(requestPath)) {
    request = readTargetRunJournalRecord(
      requestPath,
      rollbackContext(context),
      {
        sequence: legacyRollbackSequence(generation, 'request'),
        generation,
        states: ['legacy_restart_requested'],
        previousRecordDigest: preparation.preparationDigest,
        requestedAtMs: context.rollbackCommand.request.rollbackRequestedAtMs,
      },
    );
    verifyRequestEvidence(request, preparation);
    advanceLocalCutoverInstanceHead(
      context.sourceCommand,
      context.uid,
      'legacy_restart_requested',
      generation,
      request.recordDigest,
    );
  } else {
    try {
      stoppedObservations(context, source, runDocker);
    } catch {
      return publishManual(
        context,
        requestPath,
        legacyRollbackSequence(generation, 'request'),
        preparation.preparationDigest,
        'legacy_restart_preflight_unproved',
        preparation.preparationDigest,
      );
    }
    request = targetRunJournalRecord(
      context.journalCommand,
      legacyRollbackSequence(generation, 'request'),
      'legacy_restart_requested',
      preparation.preparationDigest,
      requestEvidence(preparation),
    );
    publishTargetRunJournalRecord(
      rollbackContext(context),
      requestPath,
      request,
      'legacy rollback start barrier',
    );
    advanceLocalCutoverInstanceHead(
      context.sourceCommand,
      context.uid,
      'legacy_restart_requested',
      generation,
      request.recordDigest,
    );
    shouldStart = true;
    dependencies.afterBarrier?.();
  }
  if (shouldStart) {
    try {
      stoppedObservations(context, source, runDocker);
    } catch {
      return publishManual(
        context,
        legacyRollbackPhasePath(context.journal, generation, 'outcome'),
        legacyRollbackSequence(generation, 'outcome'),
        request.recordDigest,
        'legacy_restart_result_unproved',
        preparation.preparationDigest,
      );
    }
    try {
      docker(
        context,
        runDocker,
        [
          'container',
          'start',
          context.sourceCommand.request.expectedLegacyContainerId,
        ],
        45_000,
      );
    } catch {
      // The exact running inspection below resolves a lost start response.
    }
    dependencies.afterStart?.();
  }
  const outcomePath = legacyRollbackPhasePath(
    context.journal,
    generation,
    'outcome',
  );
  try {
    const legacy = parseActiveLegacyEvidence(
      docker(
        context,
        runDocker,
        [
          'container',
          'inspect',
          context.sourceCommand.request.expectedLegacyContainerId,
        ],
        30_000,
      ),
      context.sourceCommand,
    );
    const target = parseTargetContainerEvidence(
      docker(
        context,
        runDocker,
        [
          'container',
          'inspect',
          context.sourceCommand.request.expectedTargetContainerId,
        ],
        30_000,
      ),
      context.sourceCommand,
      context.application,
      'stopped',
    );
    if (
      legacy.identityDigest !==
        context.commitment.legacyContainerIdentityDigest ||
      legacy.sourceBindingDigest !==
        context.commitment.legacySourceBindingDigest ||
      target.identityDigest !== source.active.targetContainerIdentityDigest ||
      target.applicationBindingDigest !==
        source.active.targetApplicationBindingDigest
    ) {
      configurationError('legacy rollback outcome identity drifted');
    }
  } catch {
    return publishManual(
      context,
      outcomePath,
      legacyRollbackSequence(generation, 'outcome'),
      request.recordDigest,
      'legacy_restart_result_unproved',
      preparation.preparationDigest,
    );
  }
  const outcome = targetRunJournalRecord(
    context.journalCommand,
    legacyRollbackSequence(generation, 'outcome'),
    'legacy_running',
    request.recordDigest,
    outcomeEvidence(request, preparation),
  );
  const status = publishTargetRunJournalRecord(
    rollbackContext(context),
    outcomePath,
    outcome,
    'legacy rollback running commitment',
  );
  return result(
    context,
    status,
    'legacy_running',
    preparation.preparationDigest,
    outcome.recordDigest,
  );
}

export function runLocalDeploymentLegacyRollback(
  input: unknown,
  dependencies: LocalDeploymentLegacyRollbackDependencies = {},
): Readonly<LocalDeploymentLegacyRollbackResult> {
  const rollbackCommand = normalizeLocalDeploymentLegacyRollbackCommand(input);
  const sourceCommand = legacyRollbackTargetRunCommand(rollbackCommand);
  const identity = currentIdentity();
  const journal = path.dirname(legacyCommitmentPath(sourceCommand));
  validatePrivateDirectory(
    sourceCommand.options.deploymentRoot,
    identity.uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(
    path.join(sourceCommand.options.deploymentRoot, 'service'),
    identity.uid,
    'serviceDescriptorRoot',
  );
  validatePrivateDirectory(journal, identity.uid, 'cutoverJournal');
  validatePrivateDirectory(
    localCutoverInstanceDirectory(
      sourceCommand.options.deploymentRoot,
      sourceCommand.request.instanceId,
    ),
    identity.uid,
    'cutoverInstanceDirectory',
  );
  const context = Object.freeze({
    rollbackCommand,
    command: sourceCommand,
    sourceCommand,
    journalCommand: journalCommand(
      sourceCommand,
      rollbackCommand.request.rollbackRequestedAtMs,
    ),
    journal,
    uid: identity.uid,
    commitment: readLegacySilenceEvidence(sourceCommand),
    application: readTargetApplicationBinding(sourceCommand),
  });
  const source = readRollbackSource(context);
  const head = readLocalCutoverInstanceHead(
    sourceCommand.options.deploymentRoot,
    sourceCommand.request.instanceId,
    identity.uid,
  );
  if (
    head.profile !== sourceCommand.request.profile ||
    head.cutoverId !== sourceCommand.request.cutoverId ||
    head.activationDigest !== sourceCommand.request.expectedActivationDigest ||
    head.generation !== sourceCommand.request.generation
  ) {
    configurationError('legacy rollback is not bound to the instance lineage');
  }
  return rollbackCommand.operation ===
    'local.deployment.cutover.legacy-rollback-prepare'
    ? prepare(context, source, head, dependencies)
    : commit(context, source, head, dependencies);
}

export function runLocalDeploymentLegacyRollbackCommandFile(
  filePath: string,
  expectedOperation?: LocalDeploymentLegacyRollbackCommand['operation'],
): Readonly<LocalDeploymentLegacyRollbackResult> {
  const input = readPrivateLocalCommandFile(filePath);
  if (
    expectedOperation !== undefined &&
    (!input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      (input as Record<string, unknown>).operation !== expectedOperation)
  ) {
    configurationError(
      'legacy rollback command does not match the CLI operation',
    );
  }
  return runLocalDeploymentLegacyRollback(input);
}

export { EMPTY_ROLLBACK_PREPARATION_DIGEST };

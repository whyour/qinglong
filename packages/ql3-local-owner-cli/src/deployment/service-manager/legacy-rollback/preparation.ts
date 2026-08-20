import crypto from 'node:crypto';
import path from 'node:path';

import {
  MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
  readPrivateLocalCommandFile,
  readPrivateLocalJsonFile,
} from '@qinglong/local-command-file';

import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
} from '../../cutover/instanceLineage';
import {
  readTargetDataReconciliationEvidenceForPaths,
  verifyTargetDataReconciliationEvidence,
  type TargetDataReconciliationEvidence,
} from '../../cutover/targetDataEvidence';
import { cutoverDigest } from '../../cutover/targetEvidence';
import { currentIdentity } from '../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../foundation/error';
import {
  preflightPublishedFile,
  publishExactFile,
} from '../../foundation/files';
import {
  localServiceManagerIntentPath,
  normalizeLocalServiceManagerIntent,
  type LocalServiceManagerKind,
} from '../serviceBridgeContract';
import { readServiceBridgeFile } from '../serviceBridgeFiles';
import { normalizeLocalServiceManagerCutoverRecord } from '../serviceCutoverJournal';

const SCHEMA = 'qinglong3-local-service-manager-rollback-preparation';
const ZERO_DIGEST = '0'.repeat(64);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CUTOVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const MAX_PATH_BYTES = 4_096;
const MAX_GENERATION = 15;

export interface LocalServiceManagerLegacyRollbackPrepareCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.legacy-rollback.prepare';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    cutoverId: string;
    profile: 'edge' | 'standalone';
    instanceId: string;
    generation: number;
    expectedActivationDigest: string;
    expectedStoppedRecordDigest: string;
    expectedInstanceHeadDigest: string;
    requestedAtMs: number;
  }>;
}

export interface LocalServiceManagerLegacyRollbackPrepareResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.legacy-rollback.prepare';
  readonly status: 'prepared' | 'existing' | 'not-prepared';
  readonly state: 'rollback_prepared' | 'target_stopped';
  readonly rollbackDisposition: TargetDataReconciliationEvidence['disposition'];
  readonly cutoverId: string;
  readonly generation: number;
  readonly preparationDigest: string;
  readonly instanceHeadDigest: string;
}

export interface LocalServiceManagerLegacyRollbackPreparation {
  readonly schema: typeof SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'rollback_prepared';
  readonly cutoverId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly managerKind: LocalServiceManagerKind;
  readonly expectedInstanceHeadDigest: string;
  readonly stoppedRecordDigest: string;
  readonly stoppedManagerOutcomeDigest: string;
  readonly applicationConfigDigest: string;
  readonly commitmentDigest: string;
  readonly commitmentFileDigest: string;
  readonly targetDescriptorDigest: string;
  readonly shutdownReceiptDigest: string;
  readonly reconciliation: Readonly<TargetDataReconciliationEvidence>;
  readonly requestedAtMs: number;
  readonly preparationDigest: string;
}

interface AdoptedPaths {
  readonly activationPath: string;
  readonly legacySourcePath: string;
  readonly targetDatabasePath: string;
  readonly expectedActivationDigest: string;
  readonly commitmentDigest: string;
  readonly commitmentFileDigest: string;
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

function safeAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    value.includes('//') ||
    !SAFE_PATH_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    configurationError(`${label} must be a supervisor-safe absolute path`);
  }
  return value;
}

function normalizeCommand(
  value: unknown,
): Readonly<LocalServiceManagerLegacyRollbackPrepareCommand> {
  const command = object(value, 'service manager rollback prepare command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  const options = object(command.options, 'options');
  exact(options, ['allowRootService', 'deploymentRoot'], 'options');
  const request = object(command.request, 'request');
  exact(
    request,
    [
      'cutoverId',
      'expectedActivationDigest',
      'expectedInstanceHeadDigest',
      'expectedStoppedRecordDigest',
      'generation',
      'instanceId',
      'profile',
      'requestedAtMs',
    ],
    'request',
  );
  const identity = currentIdentity();
  if (
    command.schemaVersion !== 1 ||
    command.operation !==
      'local.deployment.service-manager.legacy-rollback.prepare' ||
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService ||
    typeof request.cutoverId !== 'string' ||
    !CUTOVER_ID_PATTERN.test(request.cutoverId) ||
    (request.profile !== 'edge' && request.profile !== 'standalone') ||
    typeof request.instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(request.instanceId) ||
    !Number.isSafeInteger(request.generation) ||
    (request.generation as number) < 1 ||
    (request.generation as number) > MAX_GENERATION ||
    typeof request.expectedActivationDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedActivationDigest) ||
    typeof request.expectedStoppedRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedStoppedRecordDigest) ||
    typeof request.expectedInstanceHeadDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedInstanceHeadDigest) ||
    !Number.isSafeInteger(request.requestedAtMs) ||
    (request.requestedAtMs as number) < 0
  ) {
    configurationError('service manager rollback prepare command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation:
      'local.deployment.service-manager.legacy-rollback.prepare' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      allowRootService: options.allowRootService,
    }),
    request: Object.freeze({
      cutoverId: request.cutoverId,
      profile: request.profile,
      instanceId: request.instanceId,
      generation: request.generation as number,
      expectedActivationDigest: request.expectedActivationDigest,
      expectedStoppedRecordDigest: request.expectedStoppedRecordDigest,
      expectedInstanceHeadDigest: request.expectedInstanceHeadDigest,
      requestedAtMs: request.requestedAtMs as number,
    }),
  });
}

function stoppedRecordPath(
  command: Readonly<LocalServiceManagerLegacyRollbackPrepareCommand>,
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

export function localServiceManagerLegacyRollbackPreparationPath(
  deploymentRoot: string,
  cutoverId: string,
  generation: number,
): string {
  return path.join(
    deploymentRoot,
    'service',
    'cutovers',
    cutoverId,
    `service-manager-g${String(generation).padStart(
      2,
      '0',
    )}-rollback-prepared.json`,
  );
}

function privateFileSha256(
  filePath: string,
  uid: number,
  gid: number,
  label: string,
): string {
  let bytes: Buffer | undefined;
  try {
    bytes = readServiceBridgeFile(filePath, { uid, gid, mode: 0o600 }, label);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    return configurationError(`${label} cannot be hashed`, error);
  } finally {
    bytes?.fill(0);
  }
}

function adoptedPaths(
  applicationPath: string,
  command: Readonly<LocalServiceManagerLegacyRollbackPrepareCommand>,
  expectedApplicationDigest: string,
  expectedCommitmentDigest: string,
  uid: number,
  gid: number,
): Readonly<AdoptedPaths> {
  if (
    privateFileSha256(
      applicationPath,
      uid,
      gid,
      'application configuration',
    ) !== expectedApplicationDigest
  ) {
    configurationError('adopted application configuration digest drifted');
  }
  const application = object(
    readPrivateLocalCommandFile(applicationPath),
    'adopted application configuration',
  );
  const storage = object(application.storage, 'adopted storage');
  const cutover = object(application.cutover, 'adopted cutover');
  const commitmentPath = safeAbsolutePath(
    cutover.commitmentPath,
    'commitmentPath',
  );
  const expectedCommitmentPath = path.join(
    command.options.deploymentRoot,
    'service',
    'cutovers',
    command.request.cutoverId,
    '0002-legacy-stopped.json',
  );
  const commitment = object(
    readPrivateLocalCommandFile(commitmentPath),
    'legacy silence commitment',
  );
  const { commitmentDigest, ...commitmentPayload } = commitment;
  if (
    application.schema !== 'qinglong/local-application-process@v3' ||
    application.profile !== command.request.profile ||
    application.instanceId !== command.request.instanceId ||
    storage.mode !== 'adopted' ||
    storage.expectedActivationDigest !==
      command.request.expectedActivationDigest ||
    cutover.cutoverId !== command.request.cutoverId ||
    cutover.expectedCommitmentDigest !== expectedCommitmentDigest ||
    commitmentPath !== expectedCommitmentPath ||
    commitment.schemaVersion !== 1 ||
    commitment.kind !== 'qinglong3-local-legacy-silence-commitment' ||
    commitment.state !== 'legacy_stopped' ||
    commitment.cutoverId !== command.request.cutoverId ||
    commitment.profile !== command.request.profile ||
    commitment.instanceId !== command.request.instanceId ||
    commitment.activationDigest !== command.request.expectedActivationDigest ||
    commitmentDigest !== expectedCommitmentDigest ||
    cutoverDigest(commitmentPayload) !== commitmentDigest
  ) {
    configurationError('adopted application rollback binding drifted');
  }
  return Object.freeze({
    activationPath: safeAbsolutePath(storage.activationPath, 'activationPath'),
    legacySourcePath: safeAbsolutePath(storage.sourcePath, 'legacySourcePath'),
    targetDatabasePath: safeAbsolutePath(
      storage.targetPath,
      'targetDatabasePath',
    ),
    expectedActivationDigest: command.request.expectedActivationDigest,
    commitmentDigest: expectedCommitmentDigest,
    commitmentFileDigest: privateFileSha256(
      commitmentPath,
      uid,
      gid,
      'legacy silence commitment',
    ),
  });
}

function preparationRecord(
  command: Readonly<LocalServiceManagerLegacyRollbackPrepareCommand>,
  stopped: ReturnType<typeof normalizeLocalServiceManagerCutoverRecord>,
  reconciliation: Readonly<TargetDataReconciliationEvidence>,
  managerKind: LocalServiceManagerKind,
  commitmentFileDigest: string,
  targetDescriptorDigest: string,
): Readonly<LocalServiceManagerLegacyRollbackPreparation> {
  if (
    stopped.evidence.shutdownReceiptDigest === null ||
    stopped.evidence.manualReason !== null
  ) {
    configurationError('stopped service evidence cannot authorize rollback');
  }
  const payload = Object.freeze({
    schema: SCHEMA,
    schemaVersion: 1 as const,
    state: 'rollback_prepared' as const,
    cutoverId: command.request.cutoverId,
    profile: command.request.profile,
    instanceId: command.request.instanceId,
    generation: command.request.generation,
    activationDigest: command.request.expectedActivationDigest,
    managerKind,
    expectedInstanceHeadDigest: command.request.expectedInstanceHeadDigest,
    stoppedRecordDigest: stopped.recordDigest,
    stoppedManagerOutcomeDigest: stopped.evidence.managerOutcomeDigest,
    applicationConfigDigest: stopped.evidence.applicationConfigDigest,
    commitmentDigest: stopped.evidence.commitmentDigest,
    commitmentFileDigest,
    targetDescriptorDigest,
    shutdownReceiptDigest: stopped.evidence.shutdownReceiptDigest,
    reconciliation,
    requestedAtMs: command.request.requestedAtMs,
  });
  return Object.freeze({
    ...payload,
    preparationDigest: cutoverDigest(payload),
  });
}

export function normalizeLocalServiceManagerLegacyRollbackPreparation(
  value: unknown,
): Readonly<LocalServiceManagerLegacyRollbackPreparation> {
  const record = object(value, 'service manager rollback preparation');
  exact(
    record,
    [
      'activationDigest',
      'applicationConfigDigest',
      'commitmentDigest',
      'commitmentFileDigest',
      'cutoverId',
      'expectedInstanceHeadDigest',
      'generation',
      'instanceId',
      'managerKind',
      'preparationDigest',
      'profile',
      'reconciliation',
      'requestedAtMs',
      'schema',
      'schemaVersion',
      'shutdownReceiptDigest',
      'state',
      'stoppedManagerOutcomeDigest',
      'stoppedRecordDigest',
      'targetDescriptorDigest',
    ],
    'service manager rollback preparation',
  );
  const reconciliation = verifyTargetDataReconciliationEvidence(
    record.reconciliation,
  );
  const { preparationDigest, ...rawPayload } = record;
  const payload = { ...rawPayload, reconciliation };
  if (
    record.schema !== SCHEMA ||
    record.schemaVersion !== 1 ||
    record.state !== 'rollback_prepared' ||
    typeof record.cutoverId !== 'string' ||
    !CUTOVER_ID_PATTERN.test(record.cutoverId) ||
    (record.profile !== 'edge' && record.profile !== 'standalone') ||
    typeof record.instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(record.instanceId) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    (record.generation as number) > MAX_GENERATION ||
    typeof record.activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.activationDigest) ||
    (record.managerKind !== 'systemd' && record.managerKind !== 'openrc') ||
    typeof record.expectedInstanceHeadDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.expectedInstanceHeadDigest) ||
    typeof record.stoppedRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.stoppedRecordDigest) ||
    typeof record.stoppedManagerOutcomeDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.stoppedManagerOutcomeDigest) ||
    typeof record.applicationConfigDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.applicationConfigDigest) ||
    typeof record.commitmentDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.commitmentDigest) ||
    typeof record.commitmentFileDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.commitmentFileDigest) ||
    typeof record.targetDescriptorDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.targetDescriptorDigest) ||
    typeof record.shutdownReceiptDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.shutdownReceiptDigest) ||
    reconciliation.disposition !== 'rollback_candidate' ||
    !Number.isSafeInteger(record.requestedAtMs) ||
    (record.requestedAtMs as number) < 0 ||
    typeof preparationDigest !== 'string' ||
    !DIGEST_PATTERN.test(preparationDigest) ||
    cutoverDigest(payload) !== preparationDigest
  ) {
    configurationError('service manager rollback preparation drifted');
  }
  return Object.freeze({
    ...(payload as Omit<
      LocalServiceManagerLegacyRollbackPreparation,
      'preparationDigest'
    >),
    preparationDigest,
  });
}

function result(
  command: Readonly<LocalServiceManagerLegacyRollbackPrepareCommand>,
  status: LocalServiceManagerLegacyRollbackPrepareResult['status'],
  state: LocalServiceManagerLegacyRollbackPrepareResult['state'],
  reconciliation: Readonly<TargetDataReconciliationEvidence>,
  preparationDigest: string,
  instanceHeadDigest: string,
): Readonly<LocalServiceManagerLegacyRollbackPrepareResult> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status,
    state,
    rollbackDisposition: reconciliation.disposition,
    cutoverId: command.request.cutoverId,
    generation: command.request.generation,
    preparationDigest,
    instanceHeadDigest,
  });
}

export function prepareLocalServiceManagerLegacyRollback(
  input: unknown,
): Readonly<LocalServiceManagerLegacyRollbackPrepareResult> {
  const command = normalizeCommand(input);
  const identity = currentIdentity();
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
    (head.state !== 'target_stopped' && head.state !== 'rollback_prepared')
  ) {
    configurationError('rollback prepare is not bound to the instance head');
  }
  const stopped = normalizeLocalServiceManagerCutoverRecord(
    readPrivateLocalCommandFile(stoppedRecordPath(command)),
  );
  if (
    stopped.state !== 'target_stopped' ||
    stopped.action !== 'stop' ||
    stopped.cutoverId !== command.request.cutoverId ||
    stopped.profile !== command.request.profile ||
    stopped.instanceId !== command.request.instanceId ||
    stopped.activationDigest !== command.request.expectedActivationDigest ||
    stopped.generation !== command.request.generation ||
    stopped.recordDigest !== command.request.expectedStoppedRecordDigest ||
    stopped.completedAtMs > command.request.requestedAtMs ||
    (head.state === 'target_stopped' &&
      head.sourceRecordDigest !== stopped.recordDigest) ||
    (head.state === 'target_stopped' &&
      head.headDigest !== command.request.expectedInstanceHeadDigest)
  ) {
    configurationError('stopped service rollback binding drifted');
  }
  const intent = normalizeLocalServiceManagerIntent(
    readPrivateLocalJsonFile(
      localServiceManagerIntentPath(
        command.options.deploymentRoot,
        stopped.actionId,
      ),
      { maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES },
    ),
  );
  if (
    !UUID_V4_PATTERN.test(intent.actionId) ||
    intent.intentDigest !== stopped.intentDigest ||
    intent.action !== 'stop' ||
    intent.profile !== command.request.profile ||
    intent.instanceId !== command.request.instanceId ||
    intent.lineage.mode !== 'adopted' ||
    intent.lineage.cutoverId !== command.request.cutoverId ||
    intent.lineage.generation !== command.request.generation ||
    intent.lineage.expectedActivationDigest !==
      command.request.expectedActivationDigest
  ) {
    configurationError('stopped service intent binding drifted');
  }
  const paths = adoptedPaths(
    intent.deployment.applicationConfigPath,
    command,
    stopped.evidence.applicationConfigDigest,
    stopped.evidence.commitmentDigest,
    identity.uid,
    identity.gid,
  );
  const reconciliation = readTargetDataReconciliationEvidenceForPaths(
    {
      profile: command.request.profile,
      activationPath: paths.activationPath,
      legacySourcePath: paths.legacySourcePath,
      targetDatabasePath: paths.targetDatabasePath,
      expectedActivationDigest: paths.expectedActivationDigest,
    },
    identity.uid,
  );
  if (reconciliation.disposition !== 'rollback_candidate') {
    if (head.state !== 'target_stopped') {
      configurationError('prepared rollback data drifted after authorization');
    }
    return result(
      command,
      'not-prepared',
      'target_stopped',
      reconciliation,
      ZERO_DIGEST,
      head.headDigest,
    );
  }
  const preparation = preparationRecord(
    command,
    stopped,
    reconciliation,
    intent.service.kind,
    paths.commitmentFileDigest,
    intent.descriptor.sha256,
  );
  const filePath = localServiceManagerLegacyRollbackPreparationPath(
    command.options.deploymentRoot,
    command.request.cutoverId,
    command.request.generation,
  );
  if (head.state === 'rollback_prepared') {
    const existing = normalizeLocalServiceManagerLegacyRollbackPreparation(
      readPrivateLocalCommandFile(filePath),
    );
    if (
      existing.preparationDigest !== preparation.preparationDigest ||
      head.sourceRecordDigest !== existing.preparationDigest ||
      head.previousHeadDigest !== command.request.expectedInstanceHeadDigest
    ) {
      configurationError('service manager rollback preparation replay drifted');
    }
    return result(
      command,
      'existing',
      'rollback_prepared',
      reconciliation,
      existing.preparationDigest,
      head.headDigest,
    );
  }
  const contents = `${JSON.stringify(preparation, null, 2)}\n`;
  preflightPublishedFile(
    filePath,
    contents,
    0o600,
    identity.uid,
    'service manager rollback preparation',
  );
  const status = publishExactFile(
    filePath,
    contents,
    0o600,
    identity.uid,
    'service manager rollback preparation',
  );
  const next = advanceLocalCutoverInstanceHead(
    {
      options: { deploymentRoot: command.options.deploymentRoot },
      request: {
        cutoverId: command.request.cutoverId,
        profile: command.request.profile,
        instanceId: command.request.instanceId,
        expectedActivationDigest: command.request.expectedActivationDigest,
        requestedAtMs: command.request.requestedAtMs,
      },
    },
    identity.uid,
    'rollback_prepared',
    command.request.generation,
    preparation.preparationDigest,
  );
  return result(
    command,
    status,
    'rollback_prepared',
    reconciliation,
    preparation.preparationDigest,
    next.headDigest,
  );
}

export function prepareLocalServiceManagerLegacyRollbackCommandFile(
  filePath: string,
): Readonly<LocalServiceManagerLegacyRollbackPrepareResult> {
  return prepareLocalServiceManagerLegacyRollback(
    readPrivateLocalJsonFile(filePath, {
      maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
    }),
  );
}

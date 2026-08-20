import path from 'node:path';

import {
  MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
  readPrivateLocalJsonFile,
} from '@qinglong/local-command-file';

import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
} from '../../cutover/instanceLineage';
import { cutoverDigest } from '../../cutover/targetEvidence';
import { currentIdentity } from '../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../foundation/error';
import {
  preflightPublishedFile,
  publishExactFile,
} from '../../foundation/files';
import {
  localServiceManagerLegacyCompletionPath,
  localServiceManagerLegacyStartAuthorizationDigest,
  localServiceManagerLegacyStartAuthorizationPath,
  localServiceManagerLegacyStartOutcomePath,
  normalizeLocalServiceManagerLegacyStartAuthorization,
  normalizeLocalServiceManagerLegacyStartOutcome,
  type LocalServiceManagerLegacyStartAuthorization,
  type LocalServiceManagerLegacyStartOutcome,
} from './contract';
import {
  localServiceManagerLegacyRollbackPreparationPath,
  normalizeLocalServiceManagerLegacyRollbackPreparation,
  prepareLocalServiceManagerLegacyRollback,
  type LocalServiceManagerLegacyRollbackPreparation,
} from './preparation';

const COMPLETION_SCHEMA =
  'qinglong3-local-service-manager-legacy-rollback-completion';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CUTOVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const MAX_PATH_BYTES = 4_096;
const MAX_GENERATION = 15;

interface RollbackIdentity {
  readonly cutoverId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly generation: number;
  readonly expectedActivationDigest: string;
}

export interface LocalServiceManagerLegacyRollbackAuthorizeCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.legacy-rollback.authorize';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<
    RollbackIdentity & {
      expectedPreparationDigest: string;
      expectedInstanceHeadDigest: string;
      requestedAtMs: number;
    }
  >;
}

export interface LocalServiceManagerLegacyRollbackAuthorizeResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.legacy-rollback.authorize';
  readonly status: 'prepared' | 'existing';
  readonly state: 'legacy_restart_requested';
  readonly cutoverId: string;
  readonly generation: number;
  readonly preparationDigest: string;
  readonly authorizationDigest: string;
  readonly instanceHeadDigest: string;
}

export interface LocalServiceManagerLegacyRollbackConsumeCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.legacy-rollback.consume';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<
    RollbackIdentity & {
      expectedPreparationDigest: string;
      expectedAuthorizationDigest: string;
      expectedAuthorizationHeadDigest: string;
      requestedAtMs: number;
    }
  >;
}

export interface LocalServiceManagerLegacyRollbackConsumeResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.legacy-rollback.consume';
  readonly status: 'prepared' | 'existing';
  readonly state: 'legacy_running' | 'manual_required';
  readonly cutoverId: string;
  readonly generation: number;
  readonly outcomeDigest: string;
  readonly completionDigest: string;
  readonly instanceHeadDigest: string;
}

export interface LocalServiceManagerLegacyRollbackCompletion {
  readonly schema: typeof COMPLETION_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'legacy_running' | 'manual_required';
  readonly cutoverId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly preparationDigest: string;
  readonly authorizationDigest: string;
  readonly expectedAuthorizationHeadDigest: string;
  readonly rootOutcomeDigest: string;
  readonly rootBarrierDigest: string;
  readonly legacyDescriptorDigest: string;
  readonly targetDescriptorDigest: string;
  readonly legacyObservationDigest: string;
  readonly targetObservationDigest: string;
  readonly manualReason: LocalServiceManagerLegacyStartOutcome['manualReason'];
  readonly completedAtMs: number;
  readonly completionDigest: string;
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

function normalizeIdentity(
  value: Record<string, unknown>,
): Readonly<RollbackIdentity> {
  if (
    typeof value.cutoverId !== 'string' ||
    !CUTOVER_ID_PATTERN.test(value.cutoverId) ||
    (value.profile !== 'edge' && value.profile !== 'standalone') ||
    typeof value.instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(value.instanceId) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    (value.generation as number) > MAX_GENERATION ||
    typeof value.expectedActivationDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.expectedActivationDigest)
  ) {
    configurationError('legacy rollback identity is invalid');
  }
  return Object.freeze({
    cutoverId: value.cutoverId,
    profile: value.profile,
    instanceId: value.instanceId,
    generation: value.generation as number,
    expectedActivationDigest: value.expectedActivationDigest,
  });
}

function normalizeAuthorizeCommand(
  value: unknown,
): Readonly<LocalServiceManagerLegacyRollbackAuthorizeCommand> {
  const command = object(value, 'legacy rollback authorize command');
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
      'expectedPreparationDigest',
      'generation',
      'instanceId',
      'profile',
      'requestedAtMs',
    ],
    'request',
  );
  const identity = currentIdentity();
  const rollbackIdentity = normalizeIdentity(request);
  if (
    command.schemaVersion !== 1 ||
    command.operation !==
      'local.deployment.service-manager.legacy-rollback.authorize' ||
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService ||
    typeof request.expectedPreparationDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedPreparationDigest) ||
    typeof request.expectedInstanceHeadDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedInstanceHeadDigest) ||
    !Number.isSafeInteger(request.requestedAtMs) ||
    (request.requestedAtMs as number) < 0
  ) {
    configurationError('legacy rollback authorize command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation:
      'local.deployment.service-manager.legacy-rollback.authorize' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      allowRootService: options.allowRootService,
    }),
    request: Object.freeze({
      ...rollbackIdentity,
      expectedPreparationDigest: request.expectedPreparationDigest,
      expectedInstanceHeadDigest: request.expectedInstanceHeadDigest,
      requestedAtMs: request.requestedAtMs as number,
    }),
  });
}

function normalizeConsumeCommand(
  value: unknown,
): Readonly<LocalServiceManagerLegacyRollbackConsumeCommand> {
  const command = object(value, 'legacy rollback consume command');
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
      'expectedAuthorizationDigest',
      'expectedAuthorizationHeadDigest',
      'expectedPreparationDigest',
      'generation',
      'instanceId',
      'profile',
      'requestedAtMs',
    ],
    'request',
  );
  const identity = currentIdentity();
  const rollbackIdentity = normalizeIdentity(request);
  if (
    command.schemaVersion !== 1 ||
    command.operation !==
      'local.deployment.service-manager.legacy-rollback.consume' ||
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService ||
    typeof request.expectedPreparationDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedPreparationDigest) ||
    typeof request.expectedAuthorizationDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedAuthorizationDigest) ||
    typeof request.expectedAuthorizationHeadDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedAuthorizationHeadDigest) ||
    !Number.isSafeInteger(request.requestedAtMs) ||
    (request.requestedAtMs as number) < 0
  ) {
    configurationError('legacy rollback consume command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation:
      'local.deployment.service-manager.legacy-rollback.consume' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      allowRootService: options.allowRootService,
    }),
    request: Object.freeze({
      ...rollbackIdentity,
      expectedPreparationDigest: request.expectedPreparationDigest,
      expectedAuthorizationDigest: request.expectedAuthorizationDigest,
      expectedAuthorizationHeadDigest: request.expectedAuthorizationHeadDigest,
      requestedAtMs: request.requestedAtMs as number,
    }),
  });
}

function readPreparation(
  deploymentRoot: string,
  identity: Readonly<RollbackIdentity>,
): Readonly<LocalServiceManagerLegacyRollbackPreparation> {
  return normalizeLocalServiceManagerLegacyRollbackPreparation(
    readPrivateLocalJsonFile(
      localServiceManagerLegacyRollbackPreparationPath(
        deploymentRoot,
        identity.cutoverId,
        identity.generation,
      ),
      { maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES },
    ),
  );
}

function assertPreparationBinding(
  preparation: Readonly<LocalServiceManagerLegacyRollbackPreparation>,
  identity: Readonly<RollbackIdentity>,
  expectedPreparationDigest: string,
): void {
  if (
    preparation.cutoverId !== identity.cutoverId ||
    preparation.profile !== identity.profile ||
    preparation.instanceId !== identity.instanceId ||
    preparation.generation !== identity.generation ||
    preparation.activationDigest !== identity.expectedActivationDigest ||
    preparation.preparationDigest !== expectedPreparationDigest
  ) {
    configurationError('legacy rollback preparation binding drifted');
  }
}

function authorizationRecord(
  command: Readonly<LocalServiceManagerLegacyRollbackAuthorizeCommand>,
  preparation: Readonly<LocalServiceManagerLegacyRollbackPreparation>,
): Readonly<LocalServiceManagerLegacyStartAuthorization> {
  const payload = Object.freeze({
    schema:
      'qinglong3-local-service-manager-legacy-start-authorization' as const,
    schemaVersion: 1 as const,
    state: 'legacy_restart_requested' as const,
    cutoverId: command.request.cutoverId,
    profile: command.request.profile,
    instanceId: command.request.instanceId,
    generation: command.request.generation,
    activationDigest: command.request.expectedActivationDigest,
    managerKind: preparation.managerKind,
    expectedInstanceHeadDigest: command.request.expectedInstanceHeadDigest,
    preparationDigest: preparation.preparationDigest,
    reconciliationEvidenceDigest: preparation.reconciliation.evidenceDigest,
    applicationConfigDigest: preparation.applicationConfigDigest,
    commitmentFileDigest: preparation.commitmentFileDigest,
    targetDescriptorDigest: preparation.targetDescriptorDigest,
    requestedAtMs: command.request.requestedAtMs,
  });
  return normalizeLocalServiceManagerLegacyStartAuthorization({
    ...payload,
    authorizationDigest:
      localServiceManagerLegacyStartAuthorizationDigest(payload),
  });
}

function authorizeResult(
  command: Readonly<LocalServiceManagerLegacyRollbackAuthorizeCommand>,
  status: 'prepared' | 'existing',
  preparationDigest: string,
  authorizationDigest: string,
  instanceHeadDigest: string,
): Readonly<LocalServiceManagerLegacyRollbackAuthorizeResult> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status,
    state: 'legacy_restart_requested' as const,
    cutoverId: command.request.cutoverId,
    generation: command.request.generation,
    preparationDigest,
    authorizationDigest,
    instanceHeadDigest,
  });
}

export function authorizeLocalServiceManagerLegacyRollback(
  input: unknown,
): Readonly<LocalServiceManagerLegacyRollbackAuthorizeResult> {
  const command = normalizeAuthorizeCommand(input);
  const identity = currentIdentity();
  const preparation = readPreparation(
    command.options.deploymentRoot,
    command.request,
  );
  assertPreparationBinding(
    preparation,
    command.request,
    command.request.expectedPreparationDigest,
  );
  const authorization = authorizationRecord(command, preparation);
  const authorizationPath = localServiceManagerLegacyStartAuthorizationPath(
    command.options.deploymentRoot,
    command.request.cutoverId,
    command.request.generation,
  );
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    command.request.instanceId,
    identity.uid,
  );
  if (head.state === 'legacy_restart_requested') {
    const existing = normalizeLocalServiceManagerLegacyStartAuthorization(
      readPrivateLocalJsonFile(authorizationPath, {
        maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
      }),
    );
    if (
      existing.authorizationDigest !== authorization.authorizationDigest ||
      head.sourceRecordDigest !== existing.authorizationDigest ||
      head.previousHeadDigest !== command.request.expectedInstanceHeadDigest
    ) {
      configurationError('legacy rollback authorization replay drifted');
    }
    return authorizeResult(
      command,
      'existing',
      preparation.preparationDigest,
      existing.authorizationDigest,
      head.headDigest,
    );
  }
  if (
    head.state !== 'rollback_prepared' ||
    head.headDigest !== command.request.expectedInstanceHeadDigest ||
    head.sourceRecordDigest !== preparation.preparationDigest ||
    head.profile !== command.request.profile ||
    head.cutoverId !== command.request.cutoverId ||
    head.activationDigest !== command.request.expectedActivationDigest ||
    head.generation !== command.request.generation ||
    preparation.requestedAtMs > command.request.requestedAtMs
  ) {
    configurationError('legacy rollback authorization lost the instance head');
  }
  const revalidated = prepareLocalServiceManagerLegacyRollback({
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.legacy-rollback.prepare',
    options: command.options,
    request: {
      cutoverId: preparation.cutoverId,
      profile: preparation.profile,
      instanceId: preparation.instanceId,
      generation: preparation.generation,
      expectedActivationDigest: preparation.activationDigest,
      expectedStoppedRecordDigest: preparation.stoppedRecordDigest,
      expectedInstanceHeadDigest: preparation.expectedInstanceHeadDigest,
      requestedAtMs: preparation.requestedAtMs,
    },
  });
  if (
    revalidated.status !== 'existing' ||
    revalidated.state !== 'rollback_prepared' ||
    revalidated.preparationDigest !== preparation.preparationDigest
  ) {
    configurationError('legacy rollback preparation cannot authorize start');
  }
  const contents = `${JSON.stringify(authorization, null, 2)}\n`;
  preflightPublishedFile(
    authorizationPath,
    contents,
    0o600,
    identity.uid,
    'legacy start authorization',
  );
  const status = publishExactFile(
    authorizationPath,
    contents,
    0o600,
    identity.uid,
    'legacy start authorization',
  );
  const next = advanceLocalCutoverInstanceHead(
    {
      options: { deploymentRoot: command.options.deploymentRoot },
      request: command.request,
    },
    identity.uid,
    'legacy_restart_requested',
    command.request.generation,
    authorization.authorizationDigest,
  );
  return authorizeResult(
    command,
    status,
    preparation.preparationDigest,
    authorization.authorizationDigest,
    next.headDigest,
  );
}

function completionRecord(
  command: Readonly<LocalServiceManagerLegacyRollbackConsumeCommand>,
  outcome: Readonly<LocalServiceManagerLegacyStartOutcome>,
): Readonly<LocalServiceManagerLegacyRollbackCompletion> {
  const payload = Object.freeze({
    schema: COMPLETION_SCHEMA,
    schemaVersion: 1 as const,
    state: outcome.state,
    cutoverId: command.request.cutoverId,
    profile: command.request.profile,
    instanceId: command.request.instanceId,
    generation: command.request.generation,
    activationDigest: command.request.expectedActivationDigest,
    preparationDigest: command.request.expectedPreparationDigest,
    authorizationDigest: command.request.expectedAuthorizationDigest,
    expectedAuthorizationHeadDigest:
      command.request.expectedAuthorizationHeadDigest,
    rootOutcomeDigest: outcome.outcomeDigest,
    rootBarrierDigest: outcome.barrierDigest,
    legacyDescriptorDigest: outcome.legacyDescriptorDigest,
    targetDescriptorDigest: outcome.targetDescriptorDigest,
    legacyObservationDigest: outcome.legacyObservation.observationDigest,
    targetObservationDigest: outcome.targetObservation.observationDigest,
    manualReason: outcome.manualReason,
    completedAtMs: Math.max(
      command.request.requestedAtMs,
      outcome.completedAtMs,
    ),
  });
  return Object.freeze({
    ...payload,
    completionDigest: cutoverDigest(payload),
  });
}

export function normalizeLocalServiceManagerLegacyRollbackCompletion(
  value: unknown,
): Readonly<LocalServiceManagerLegacyRollbackCompletion> {
  const record = object(value, 'legacy rollback completion');
  exact(
    record,
    [
      'activationDigest',
      'authorizationDigest',
      'completedAtMs',
      'completionDigest',
      'cutoverId',
      'expectedAuthorizationHeadDigest',
      'generation',
      'instanceId',
      'legacyDescriptorDigest',
      'legacyObservationDigest',
      'manualReason',
      'preparationDigest',
      'profile',
      'rootBarrierDigest',
      'rootOutcomeDigest',
      'schema',
      'schemaVersion',
      'state',
      'targetDescriptorDigest',
      'targetObservationDigest',
    ],
    'legacy rollback completion',
  );
  const { completionDigest, ...payload } = record;
  const digests = [
    record.activationDigest,
    record.preparationDigest,
    record.authorizationDigest,
    record.expectedAuthorizationHeadDigest,
    record.rootOutcomeDigest,
    record.rootBarrierDigest,
    record.legacyDescriptorDigest,
    record.targetDescriptorDigest,
    record.legacyObservationDigest,
    record.targetObservationDigest,
  ];
  if (
    record.schema !== COMPLETION_SCHEMA ||
    record.schemaVersion !== 1 ||
    (record.state !== 'legacy_running' && record.state !== 'manual_required') ||
    typeof record.cutoverId !== 'string' ||
    !CUTOVER_ID_PATTERN.test(record.cutoverId) ||
    (record.profile !== 'edge' && record.profile !== 'standalone') ||
    typeof record.instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(record.instanceId) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    (record.generation as number) > MAX_GENERATION ||
    digests.some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    (record.manualReason !== null &&
      record.manualReason !== 'start_precondition_unproved' &&
      record.manualReason !== 'authorization_material_drifted' &&
      record.manualReason !== 'manager_command_failed' &&
      record.manualReason !== 'manager_state_unproved' &&
      record.manualReason !== 'service_descriptor_drifted') ||
    (record.state === 'manual_required') !== (record.manualReason !== null) ||
    !Number.isSafeInteger(record.completedAtMs) ||
    (record.completedAtMs as number) < 0 ||
    typeof completionDigest !== 'string' ||
    !DIGEST_PATTERN.test(completionDigest) ||
    cutoverDigest(payload) !== completionDigest
  ) {
    configurationError('legacy rollback completion drifted');
  }
  return record as unknown as Readonly<LocalServiceManagerLegacyRollbackCompletion>;
}

function consumeResult(
  command: Readonly<LocalServiceManagerLegacyRollbackConsumeCommand>,
  status: 'prepared' | 'existing',
  completion: Readonly<LocalServiceManagerLegacyRollbackCompletion>,
  instanceHeadDigest: string,
): Readonly<LocalServiceManagerLegacyRollbackConsumeResult> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status,
    state: completion.state,
    cutoverId: completion.cutoverId,
    generation: completion.generation,
    outcomeDigest: completion.rootOutcomeDigest,
    completionDigest: completion.completionDigest,
    instanceHeadDigest,
  });
}

export function consumeLocalServiceManagerLegacyRollback(
  input: unknown,
): Readonly<LocalServiceManagerLegacyRollbackConsumeResult> {
  const command = normalizeConsumeCommand(input);
  const identity = currentIdentity();
  const preparation = readPreparation(
    command.options.deploymentRoot,
    command.request,
  );
  assertPreparationBinding(
    preparation,
    command.request,
    command.request.expectedPreparationDigest,
  );
  const authorization = normalizeLocalServiceManagerLegacyStartAuthorization(
    readPrivateLocalJsonFile(
      localServiceManagerLegacyStartAuthorizationPath(
        command.options.deploymentRoot,
        command.request.cutoverId,
        command.request.generation,
      ),
      { maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES },
    ),
  );
  if (
    authorization.cutoverId !== command.request.cutoverId ||
    authorization.profile !== command.request.profile ||
    authorization.instanceId !== command.request.instanceId ||
    authorization.generation !== command.request.generation ||
    authorization.activationDigest !==
      command.request.expectedActivationDigest ||
    authorization.preparationDigest !== preparation.preparationDigest ||
    authorization.authorizationDigest !==
      command.request.expectedAuthorizationDigest
  ) {
    configurationError('legacy start authorization binding drifted');
  }
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    command.request.instanceId,
    identity.uid,
  );
  const completionPath = localServiceManagerLegacyCompletionPath(
    command.options.deploymentRoot,
    command.request.cutoverId,
    command.request.generation,
  );
  if (head.state === 'legacy_running' || head.state === 'manual_required') {
    const existing = normalizeLocalServiceManagerLegacyRollbackCompletion(
      readPrivateLocalJsonFile(completionPath, {
        maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
      }),
    );
    if (
      existing.state !== head.state ||
      existing.authorizationDigest !== authorization.authorizationDigest ||
      existing.expectedAuthorizationHeadDigest !==
        command.request.expectedAuthorizationHeadDigest ||
      head.sourceRecordDigest !== existing.completionDigest ||
      head.previousHeadDigest !==
        command.request.expectedAuthorizationHeadDigest
    ) {
      configurationError('legacy rollback completion replay drifted');
    }
    return consumeResult(command, 'existing', existing, head.headDigest);
  }
  if (
    head.state !== 'legacy_restart_requested' ||
    head.headDigest !== command.request.expectedAuthorizationHeadDigest ||
    head.sourceRecordDigest !== authorization.authorizationDigest ||
    head.profile !== command.request.profile ||
    head.cutoverId !== command.request.cutoverId ||
    head.activationDigest !== command.request.expectedActivationDigest ||
    head.generation !== command.request.generation ||
    authorization.requestedAtMs > command.request.requestedAtMs
  ) {
    configurationError('legacy rollback consume lost the instance head');
  }
  const outcome = normalizeLocalServiceManagerLegacyStartOutcome(
    readPrivateLocalJsonFile(
      localServiceManagerLegacyStartOutcomePath(
        command.options.deploymentRoot,
        command.request.cutoverId,
        command.request.generation,
      ),
      { maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES },
    ),
  );
  if (
    outcome.cutoverId !== command.request.cutoverId ||
    outcome.profile !== command.request.profile ||
    outcome.instanceId !== command.request.instanceId ||
    outcome.generation !== command.request.generation ||
    outcome.activationDigest !== command.request.expectedActivationDigest ||
    outcome.managerKind !== preparation.managerKind ||
    outcome.preparationDigest !== preparation.preparationDigest ||
    outcome.authorizationDigest !== authorization.authorizationDigest ||
    outcome.targetDescriptorDigest !== preparation.targetDescriptorDigest ||
    outcome.completedAtMs > command.request.requestedAtMs
  ) {
    configurationError('legacy start outcome binding drifted');
  }
  const completion = completionRecord(command, outcome);
  const contents = `${JSON.stringify(completion, null, 2)}\n`;
  preflightPublishedFile(
    completionPath,
    contents,
    0o600,
    identity.uid,
    'legacy rollback completion',
  );
  const status = publishExactFile(
    completionPath,
    contents,
    0o600,
    identity.uid,
    'legacy rollback completion',
  );
  const next = advanceLocalCutoverInstanceHead(
    {
      options: { deploymentRoot: command.options.deploymentRoot },
      request: command.request,
    },
    identity.uid,
    completion.state,
    command.request.generation,
    completion.completionDigest,
  );
  return consumeResult(command, status, completion, next.headDigest);
}

export function authorizeLocalServiceManagerLegacyRollbackCommandFile(
  filePath: string,
): Readonly<LocalServiceManagerLegacyRollbackAuthorizeResult> {
  return authorizeLocalServiceManagerLegacyRollback(
    readPrivateLocalJsonFile(filePath, {
      maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
    }),
  );
}

export function consumeLocalServiceManagerLegacyRollbackCommandFile(
  filePath: string,
): Readonly<LocalServiceManagerLegacyRollbackConsumeResult> {
  return consumeLocalServiceManagerLegacyRollback(
    readPrivateLocalJsonFile(filePath, {
      maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
    }),
  );
}

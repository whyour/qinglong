import crypto from 'node:crypto';
import path from 'node:path';

import { LocalDeploymentConfigurationError } from '../../foundation/error';
import type {
  LocalServiceBridgeManager,
  LocalServiceManagerKind,
} from '../serviceBridgeContract';

const AUTHORIZATION_SCHEMA =
  'qinglong3-local-service-manager-legacy-start-authorization';
const OUTCOME_SCHEMA = 'qinglong3-local-service-manager-legacy-start-outcome';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CUTOVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const MAX_PATH_BYTES = 4_096;
const MAX_GENERATION = 15;
const MAX_PID = 0x7fffffff;

export type LocalServiceManagerRollbackMutationDisposition =
  | 'executed'
  | 'response-loss-inspected'
  | 'replay-inspected';

export type LocalServiceManagerRollbackManualReason =
  | 'start_precondition_unproved'
  | 'authorization_material_drifted'
  | 'manager_command_failed'
  | 'manager_state_unproved'
  | 'service_descriptor_drifted';

export interface LocalServiceManagerLegacyStartAuthorization {
  readonly schema: typeof AUTHORIZATION_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'legacy_restart_requested';
  readonly cutoverId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly managerKind: LocalServiceManagerKind;
  readonly expectedInstanceHeadDigest: string;
  readonly preparationDigest: string;
  readonly reconciliationEvidenceDigest: string;
  readonly applicationConfigDigest: string;
  readonly commitmentFileDigest: string;
  readonly targetDescriptorDigest: string;
  readonly requestedAtMs: number;
  readonly authorizationDigest: string;
}

export interface LocalServiceManagerRollbackObservation {
  readonly managerKind: LocalServiceManagerKind;
  readonly serviceName: 'qinglong' | 'qinglong3';
  readonly fragmentPath: string;
  readonly loadState: 'loaded' | 'not-found' | 'unknown';
  readonly activeState: 'active' | 'inactive' | 'failed' | 'unknown';
  readonly subState: string;
  readonly enabledState: 'enabled' | 'disabled' | 'static' | 'unknown';
  readonly mainPid: number;
  readonly observedAtMs: number;
  readonly observationDigest: string;
}

export interface LocalServiceManagerLegacyStartOutcome {
  readonly schema: typeof OUTCOME_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'legacy_running' | 'manual_required';
  readonly cutoverId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly managerKind: LocalServiceManagerKind;
  readonly preparationDigest: string;
  readonly authorizationDigest: string;
  readonly barrierDigest: string;
  readonly legacyDescriptorDigest: string;
  readonly targetDescriptorDigest: string;
  readonly mutationDisposition: LocalServiceManagerRollbackMutationDisposition;
  readonly manualReason: LocalServiceManagerRollbackManualReason | null;
  readonly legacyObservation: Readonly<LocalServiceManagerRollbackObservation>;
  readonly targetObservation: Readonly<LocalServiceManagerRollbackObservation>;
  readonly completedAtMs: number;
  readonly outcomeDigest: string;
}

export interface LocalServiceManagerLegacyRollbackBridgeCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.legacy-rollback.execute';
  readonly options: Readonly<{
    deploymentRoot: string;
    controllerRoot: string;
    allowRootController: true;
    manager: LocalServiceBridgeManager;
  }>;
  readonly request: Readonly<{
    cutoverId: string;
    generation: number;
    expectedAuthorizationDigest: string;
  }>;
}

export interface LocalServiceManagerLegacyRollbackBridgeResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.legacy-rollback.execute';
  readonly status: 'prepared' | 'existing';
  readonly state: LocalServiceManagerLegacyStartOutcome['state'];
  readonly cutoverId: string;
  readonly generation: number;
  readonly outcomeDigest: string;
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

function digest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
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

function normalizedManager(value: unknown): LocalServiceBridgeManager {
  const manager = object(value, 'manager');
  if (manager.kind === 'systemd') {
    exact(manager, ['executable', 'kind'], 'manager');
    return Object.freeze({
      kind: 'systemd' as const,
      executable: safeAbsolutePath(manager.executable, 'systemd executable'),
    });
  }
  exact(manager, ['kind', 'serviceExecutable', 'updateExecutable'], 'manager');
  if (manager.kind !== 'openrc') configurationError('manager kind is invalid');
  return Object.freeze({
    kind: 'openrc' as const,
    serviceExecutable: safeAbsolutePath(
      manager.serviceExecutable,
      'OpenRC service executable',
    ),
    updateExecutable: safeAbsolutePath(
      manager.updateExecutable,
      'OpenRC update executable',
    ),
  });
}

export function localServiceManagerLegacyStartAuthorizationPath(
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
    )}-legacy-start-intent.json`,
  );
}

export function localServiceManagerLegacyStartOutcomePath(
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
    )}-legacy-start-outcome.json`,
  );
}

export function localServiceManagerLegacyCompletionPath(
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
    )}-legacy-completion.json`,
  );
}

export function localServiceManagerLegacyDescriptorPath(
  kind: LocalServiceManagerKind,
): string {
  return kind === 'systemd'
    ? '/etc/systemd/system/qinglong.service'
    : '/etc/init.d/qinglong';
}

export function localServiceManagerTargetDescriptorPath(
  kind: LocalServiceManagerKind,
): string {
  return kind === 'systemd'
    ? '/etc/systemd/system/qinglong3.service'
    : '/etc/init.d/qinglong3';
}

export function localServiceManagerLegacyStartAuthorizationDigest(
  value: Omit<
    LocalServiceManagerLegacyStartAuthorization,
    'authorizationDigest'
  >,
): string {
  return digest(value);
}

export function normalizeLocalServiceManagerLegacyStartAuthorization(
  value: unknown,
): Readonly<LocalServiceManagerLegacyStartAuthorization> {
  const record = object(value, 'legacy start authorization');
  exact(
    record,
    [
      'activationDigest',
      'applicationConfigDigest',
      'authorizationDigest',
      'commitmentFileDigest',
      'cutoverId',
      'expectedInstanceHeadDigest',
      'generation',
      'instanceId',
      'managerKind',
      'preparationDigest',
      'profile',
      'reconciliationEvidenceDigest',
      'requestedAtMs',
      'schema',
      'schemaVersion',
      'state',
      'targetDescriptorDigest',
    ],
    'legacy start authorization',
  );
  const { authorizationDigest, ...payload } = record;
  if (
    record.schema !== AUTHORIZATION_SCHEMA ||
    record.schemaVersion !== 1 ||
    record.state !== 'legacy_restart_requested' ||
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
    typeof record.preparationDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.preparationDigest) ||
    typeof record.reconciliationEvidenceDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.reconciliationEvidenceDigest) ||
    typeof record.applicationConfigDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.applicationConfigDigest) ||
    typeof record.commitmentFileDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.commitmentFileDigest) ||
    typeof record.targetDescriptorDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.targetDescriptorDigest) ||
    !Number.isSafeInteger(record.requestedAtMs) ||
    (record.requestedAtMs as number) < 0 ||
    typeof authorizationDigest !== 'string' ||
    !DIGEST_PATTERN.test(authorizationDigest) ||
    digest(payload) !== authorizationDigest
  ) {
    configurationError('legacy start authorization drifted');
  }
  return record as unknown as Readonly<LocalServiceManagerLegacyStartAuthorization>;
}

export function localServiceManagerRollbackObservationDigest(
  value: Omit<LocalServiceManagerRollbackObservation, 'observationDigest'>,
): string {
  return digest(value);
}

export function normalizeLocalServiceManagerRollbackObservation(
  value: unknown,
): Readonly<LocalServiceManagerRollbackObservation> {
  const observation = object(value, 'legacy rollback observation');
  exact(
    observation,
    [
      'activeState',
      'enabledState',
      'fragmentPath',
      'loadState',
      'mainPid',
      'managerKind',
      'observationDigest',
      'observedAtMs',
      'serviceName',
      'subState',
    ],
    'legacy rollback observation',
  );
  const payload = Object.freeze({
    managerKind: observation.managerKind,
    serviceName: observation.serviceName,
    fragmentPath: safeAbsolutePath(observation.fragmentPath, 'fragmentPath'),
    loadState: observation.loadState,
    activeState: observation.activeState,
    subState: observation.subState,
    enabledState: observation.enabledState,
    mainPid: observation.mainPid,
    observedAtMs: observation.observedAtMs,
  });
  if (
    (observation.managerKind !== 'systemd' &&
      observation.managerKind !== 'openrc') ||
    (observation.serviceName !== 'qinglong' &&
      observation.serviceName !== 'qinglong3') ||
    (observation.loadState !== 'loaded' &&
      observation.loadState !== 'not-found' &&
      observation.loadState !== 'unknown') ||
    (observation.activeState !== 'active' &&
      observation.activeState !== 'inactive' &&
      observation.activeState !== 'failed' &&
      observation.activeState !== 'unknown') ||
    typeof observation.subState !== 'string' ||
    Buffer.byteLength(observation.subState, 'utf8') > 128 ||
    (observation.enabledState !== 'enabled' &&
      observation.enabledState !== 'disabled' &&
      observation.enabledState !== 'static' &&
      observation.enabledState !== 'unknown') ||
    !Number.isSafeInteger(observation.mainPid) ||
    (observation.mainPid as number) < 0 ||
    (observation.mainPid as number) > MAX_PID ||
    !Number.isSafeInteger(observation.observedAtMs) ||
    (observation.observedAtMs as number) < 0 ||
    typeof observation.observationDigest !== 'string' ||
    !DIGEST_PATTERN.test(observation.observationDigest) ||
    digest(payload) !== observation.observationDigest
  ) {
    configurationError('legacy rollback observation is invalid');
  }
  return Object.freeze({
    ...(payload as Omit<
      LocalServiceManagerRollbackObservation,
      'observationDigest'
    >),
    observationDigest: observation.observationDigest,
  });
}

export function localServiceManagerLegacyStartOutcomeDigest(
  value: Omit<LocalServiceManagerLegacyStartOutcome, 'outcomeDigest'>,
): string {
  return digest(value);
}

export function normalizeLocalServiceManagerLegacyStartOutcome(
  value: unknown,
): Readonly<LocalServiceManagerLegacyStartOutcome> {
  const record = object(value, 'legacy start outcome');
  exact(
    record,
    [
      'activationDigest',
      'authorizationDigest',
      'barrierDigest',
      'completedAtMs',
      'cutoverId',
      'generation',
      'instanceId',
      'legacyDescriptorDigest',
      'legacyObservation',
      'managerKind',
      'manualReason',
      'mutationDisposition',
      'outcomeDigest',
      'preparationDigest',
      'profile',
      'schema',
      'schemaVersion',
      'state',
      'targetDescriptorDigest',
      'targetObservation',
    ],
    'legacy start outcome',
  );
  const legacyObservation = normalizeLocalServiceManagerRollbackObservation(
    record.legacyObservation,
  );
  const targetObservation = normalizeLocalServiceManagerRollbackObservation(
    record.targetObservation,
  );
  const { outcomeDigest, ...rawPayload } = record;
  const payload = {
    ...rawPayload,
    legacyObservation,
    targetObservation,
  };
  if (
    record.schema !== OUTCOME_SCHEMA ||
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
    typeof record.activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.activationDigest) ||
    (record.managerKind !== 'systemd' && record.managerKind !== 'openrc') ||
    typeof record.preparationDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.preparationDigest) ||
    typeof record.authorizationDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.authorizationDigest) ||
    typeof record.barrierDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.barrierDigest) ||
    typeof record.legacyDescriptorDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.legacyDescriptorDigest) ||
    typeof record.targetDescriptorDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.targetDescriptorDigest) ||
    (record.mutationDisposition !== 'executed' &&
      record.mutationDisposition !== 'response-loss-inspected' &&
      record.mutationDisposition !== 'replay-inspected') ||
    (record.manualReason !== null &&
      record.manualReason !== 'start_precondition_unproved' &&
      record.manualReason !== 'authorization_material_drifted' &&
      record.manualReason !== 'manager_command_failed' &&
      record.manualReason !== 'manager_state_unproved' &&
      record.manualReason !== 'service_descriptor_drifted') ||
    (record.state === 'manual_required') !== (record.manualReason !== null) ||
    legacyObservation.managerKind !== record.managerKind ||
    legacyObservation.serviceName !== 'qinglong' ||
    targetObservation.managerKind !== record.managerKind ||
    targetObservation.serviceName !== 'qinglong3' ||
    !Number.isSafeInteger(record.completedAtMs) ||
    (record.completedAtMs as number) < legacyObservation.observedAtMs ||
    (record.completedAtMs as number) < targetObservation.observedAtMs ||
    typeof outcomeDigest !== 'string' ||
    !DIGEST_PATTERN.test(outcomeDigest) ||
    digest(payload) !== outcomeDigest
  ) {
    configurationError('legacy start outcome drifted');
  }
  return Object.freeze({
    ...(payload as Omit<
      LocalServiceManagerLegacyStartOutcome,
      'outcomeDigest'
    >),
    outcomeDigest,
  });
}

export function normalizeLocalServiceManagerLegacyRollbackBridgeCommand(
  value: unknown,
): Readonly<LocalServiceManagerLegacyRollbackBridgeCommand> {
  const command = object(value, 'legacy rollback bridge command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'legacy rollback bridge command',
  );
  const options = object(command.options, 'options');
  exact(
    options,
    ['allowRootController', 'controllerRoot', 'deploymentRoot', 'manager'],
    'options',
  );
  const request = object(command.request, 'request');
  exact(
    request,
    ['cutoverId', 'expectedAuthorizationDigest', 'generation'],
    'request',
  );
  const manager = normalizedManager(options.manager);
  if (
    command.schemaVersion !== 1 ||
    command.operation !==
      'local.deployment.service-manager.legacy-rollback.execute' ||
    options.allowRootController !== true ||
    typeof request.cutoverId !== 'string' ||
    !CUTOVER_ID_PATTERN.test(request.cutoverId) ||
    !Number.isSafeInteger(request.generation) ||
    (request.generation as number) < 1 ||
    (request.generation as number) > MAX_GENERATION ||
    typeof request.expectedAuthorizationDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedAuthorizationDigest)
  ) {
    configurationError('legacy rollback bridge command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation:
      'local.deployment.service-manager.legacy-rollback.execute' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      controllerRoot: safeAbsolutePath(
        options.controllerRoot,
        'controllerRoot',
      ),
      allowRootController: true as const,
      manager,
    }),
    request: Object.freeze({
      cutoverId: request.cutoverId,
      generation: request.generation as number,
      expectedAuthorizationDigest: request.expectedAuthorizationDigest,
    }),
  });
}

import crypto from 'node:crypto';

import { LocalDeploymentConfigurationError } from '../foundation/contract';
import type {
  LocalServiceManagerAction,
  LocalServiceManagerKind,
} from './serviceBridgeContract';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PID = 0x7fffffff;

export type LocalServiceManagerOutcomeState =
  | 'active'
  | 'stopped'
  | 'manual_required';

export type LocalServiceManagerMutationDisposition =
  | 'executed'
  | 'response-loss-inspected'
  | 'replay-inspected';

export type LocalServiceManagerManualReason =
  | 'descriptor_install_unproved'
  | 'manager_command_failed'
  | 'manager_state_unproved';

export interface LocalServiceManagerObservation {
  readonly managerKind: LocalServiceManagerKind;
  readonly serviceName: 'qinglong3';
  readonly fragmentPath: string;
  readonly loadState: 'loaded' | 'not-found' | 'unknown';
  readonly activeState: 'active' | 'inactive' | 'failed' | 'unknown';
  readonly subState: string;
  readonly enabledState: 'enabled' | 'disabled' | 'static' | 'unknown';
  readonly mainPid: number;
  readonly observedAtMs: number;
  readonly observationDigest: string;
}

export interface LocalServiceManagerOutcome {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-local-service-manager-outcome';
  readonly actionId: string;
  readonly action: LocalServiceManagerAction;
  readonly intentDigest: string;
  readonly descriptorDigest: string;
  readonly state: LocalServiceManagerOutcomeState;
  readonly mutationDisposition: LocalServiceManagerMutationDisposition;
  readonly manualReason: LocalServiceManagerManualReason | null;
  readonly observation: Readonly<LocalServiceManagerObservation>;
  readonly completedAtMs: number;
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

export function localServiceManagerObservationDigest(
  value: Omit<LocalServiceManagerObservation, 'observationDigest'>,
): string {
  return digest(value);
}

export function localServiceManagerOutcomeDigest(
  value: Omit<LocalServiceManagerOutcome, 'outcomeDigest'>,
): string {
  return digest(value);
}

export function normalizeLocalServiceManagerObservation(
  value: unknown,
): Readonly<LocalServiceManagerObservation> {
  const observation = object(value, 'service manager observation');
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
    'service manager observation',
  );
  if (
    (observation.managerKind !== 'systemd' &&
      observation.managerKind !== 'openrc') ||
    observation.serviceName !== 'qinglong3' ||
    typeof observation.fragmentPath !== 'string' ||
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
    !DIGEST_PATTERN.test(observation.observationDigest)
  ) {
    configurationError('service manager observation is invalid');
  }
  const payload = Object.freeze({
    managerKind: observation.managerKind,
    serviceName: 'qinglong3' as const,
    fragmentPath: observation.fragmentPath,
    loadState: observation.loadState,
    activeState: observation.activeState,
    subState: observation.subState,
    enabledState: observation.enabledState,
    mainPid: observation.mainPid as number,
    observedAtMs: observation.observedAtMs as number,
  });
  if (
    localServiceManagerObservationDigest(payload) !==
    observation.observationDigest
  ) {
    configurationError('service manager observation digest is invalid');
  }
  return Object.freeze({
    ...payload,
    observationDigest: observation.observationDigest,
  });
}

export function normalizeLocalServiceManagerOutcome(
  value: unknown,
): Readonly<LocalServiceManagerOutcome> {
  const outcome = object(value, 'service manager outcome');
  exact(
    outcome,
    [
      'action',
      'actionId',
      'completedAtMs',
      'descriptorDigest',
      'intentDigest',
      'kind',
      'manualReason',
      'mutationDisposition',
      'observation',
      'outcomeDigest',
      'schemaVersion',
      'state',
    ],
    'service manager outcome',
  );
  const observation = normalizeLocalServiceManagerObservation(
    outcome.observation,
  );
  if (
    outcome.schemaVersion !== 1 ||
    outcome.kind !== 'qinglong3-local-service-manager-outcome' ||
    typeof outcome.actionId !== 'string' ||
    (outcome.action !== 'install-enable-start' &&
      outcome.action !== 'start' &&
      outcome.action !== 'restart' &&
      outcome.action !== 'stop') ||
    typeof outcome.intentDigest !== 'string' ||
    !DIGEST_PATTERN.test(outcome.intentDigest) ||
    typeof outcome.descriptorDigest !== 'string' ||
    !DIGEST_PATTERN.test(outcome.descriptorDigest) ||
    (outcome.state !== 'active' &&
      outcome.state !== 'stopped' &&
      outcome.state !== 'manual_required') ||
    (outcome.mutationDisposition !== 'executed' &&
      outcome.mutationDisposition !== 'response-loss-inspected' &&
      outcome.mutationDisposition !== 'replay-inspected') ||
    (outcome.manualReason !== null &&
      outcome.manualReason !== 'descriptor_install_unproved' &&
      outcome.manualReason !== 'manager_command_failed' &&
      outcome.manualReason !== 'manager_state_unproved') ||
    (outcome.state === 'manual_required') !== (outcome.manualReason !== null) ||
    !Number.isSafeInteger(outcome.completedAtMs) ||
    (outcome.completedAtMs as number) < observation.observedAtMs ||
    typeof outcome.outcomeDigest !== 'string' ||
    !DIGEST_PATTERN.test(outcome.outcomeDigest)
  ) {
    configurationError('service manager outcome is invalid');
  }
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'qinglong3-local-service-manager-outcome' as const,
    actionId: outcome.actionId,
    action: outcome.action,
    intentDigest: outcome.intentDigest,
    descriptorDigest: outcome.descriptorDigest,
    state: outcome.state,
    mutationDisposition: outcome.mutationDisposition,
    manualReason: outcome.manualReason,
    observation,
    completedAtMs: outcome.completedAtMs as number,
  });
  if (localServiceManagerOutcomeDigest(payload) !== outcome.outcomeDigest) {
    configurationError('service manager outcome digest is invalid');
  }
  return Object.freeze({ ...payload, outcomeDigest: outcome.outcomeDigest });
}

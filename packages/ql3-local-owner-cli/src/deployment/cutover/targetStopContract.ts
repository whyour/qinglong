import { LocalDeploymentConfigurationError } from '../foundation/contract';
import {
  normalizeLocalDeploymentTargetRunCommand,
  type LocalDeploymentTargetRunCommand,
} from './target-run/targetRunContract';

export interface LocalDeploymentTargetStopCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.cutover.target-stop';
  readonly options: LocalDeploymentTargetRunCommand['options'];
  readonly request: LocalDeploymentTargetRunCommand['request'];
}

export type LocalDeploymentTargetReconciliationDisposition =
  | 'rollback_candidate'
  | 'reconciliation_required'
  | 'manual_review';

export interface LocalDeploymentTargetStopResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.cutover.target-stop';
  readonly status: 'prepared' | 'existing';
  readonly state: 'target_stopped' | 'manual_required';
  readonly cutoverId: string;
  readonly generation: number;
  readonly reconciliation: LocalDeploymentTargetReconciliationDisposition;
  readonly recordDigest: string;
  readonly instanceHeadDigest: string;
}

export function normalizeLocalDeploymentTargetStopCommand(
  value: unknown,
): Readonly<LocalDeploymentTargetStopCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new LocalDeploymentConfigurationError('command must be an object');
  }
  const command = value as Record<string, unknown>;
  if (command.operation !== 'local.deployment.cutover.target-stop') {
    throw new LocalDeploymentConfigurationError(
      'target stop operation is invalid',
    );
  }
  const request = command.request as Record<string, unknown> | undefined;
  const syntheticOperation =
    request?.generation === 1
      ? ('local.deployment.cutover.target-start' as const)
      : ('local.deployment.cutover.target-restart' as const);
  const normalized = normalizeLocalDeploymentTargetRunCommand({
    ...command,
    operation: syntheticOperation,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.cutover.target-stop' as const,
    options: normalized.options,
    request: normalized.request,
  });
}

export function targetStopRunCommand(
  command: Readonly<LocalDeploymentTargetStopCommand>,
): Readonly<LocalDeploymentTargetRunCommand> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation:
      command.request.generation === 1
        ? ('local.deployment.cutover.target-start' as const)
        : ('local.deployment.cutover.target-restart' as const),
    options: command.options,
    request: command.request,
  });
}

import {
  normalizeProjectPolicySubject,
  type ProjectRole,
} from '../security/project-policy/projectPolicy';
import {
  normalizeSecurityPolicyDecision,
  type SecurityPolicyFence,
  type SecuritySubject,
} from '../security/security';
import { RUN_STATUSES, type RunStatus } from './run';

export const RUN_CANCELLATION_SCHEMA = 'qinglong/run-cancellation@v1' as const;
/** @deprecated Use RUN_CANCELLATION_SCHEMA from the profile-neutral export. */
export const CLUSTER_RUN_CANCELLATION_SCHEMA = RUN_CANCELLATION_SCHEMA;
export const CLUSTER_RUN_CANCELLATION_STATUSES = [
  'accepted',
  'already_requested',
  'already_terminal',
] as const;

export type ClusterRunCancellationStatus =
  (typeof CLUSTER_RUN_CANCELLATION_STATUSES)[number];

export interface ClusterRunCancellationRequestBody {
  readonly schema: typeof CLUSTER_RUN_CANCELLATION_SCHEMA;
  readonly mutationId: string;
}

export interface ClusterRunCancellationWorkflowTarget {
  readonly packageName: string;
  readonly workflowId: string;
}

export interface ClusterRunCancellationCommand {
  readonly projectId: string;
  readonly runId: string;
  readonly mutationId: string;
  readonly eventId: string;
  readonly subject: Readonly<SecuritySubject>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
  readonly workflowTarget?: Readonly<ClusterRunCancellationWorkflowTarget>;
}

export interface ClusterRunCancellationResult {
  readonly status: ClusterRunCancellationStatus;
  readonly projectId: string;
  readonly runId: string;
  readonly runStatus: RunStatus;
  readonly runVersion: number;
  readonly eventSequence: number;
  readonly cancelRequestedAtMs?: number;
  readonly cancelReason?: 'user' | 'policy' | 'shutdown' | 'reconcile' | 'timeout';
}

export interface ClusterRunCancellationResponseBody
  extends ClusterRunCancellationResult {
  readonly schema: typeof CLUSTER_RUN_CANCELLATION_SCHEMA;
}

export interface ClusterRunCancellationRepository {
  requestUserCancellation(
    command: Readonly<ClusterRunCancellationCommand>,
  ): Promise<Readonly<ClusterRunCancellationResult>>;
}

export type ClusterRunCancellationFenceReason =
  | 'authorization_changed'
  | 'project_mismatch'
  | 'state_mismatch';

export class InvalidClusterRunCancellationError extends TypeError {
  constructor(message: string) {
    super(`Cluster Run cancellation is invalid: ${message}`);
    this.name = 'InvalidClusterRunCancellationError';
  }
}

export class ClusterRunCancellationNotFoundError extends Error {
  readonly code = 'CLUSTER_RUN_CANCELLATION_NOT_FOUND';
  constructor() {
    super('Cluster Run cancellation target does not exist');
    this.name = 'ClusterRunCancellationNotFoundError';
  }
}

export class ClusterRunCancellationFenceRejectedError extends Error {
  readonly code = 'CLUSTER_RUN_CANCELLATION_FENCE_REJECTED';
  constructor(readonly reason: ClusterRunCancellationFenceReason) {
    super(`Cluster Run cancellation fence rejected: ${reason}`);
    this.name = 'ClusterRunCancellationFenceRejectedError';
  }
}

export class ClusterRunCancellationUnavailableError extends Error {
  readonly code = 'CLUSTER_RUN_CANCELLATION_UNAVAILABLE';
  constructor(options?: ErrorOptions) {
    super('Cluster Run cancellation is unavailable', options);
    this.name = 'ClusterRunCancellationUnavailableError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const PACKAGE_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const TERMINAL = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
const CANCEL_REASONS = new Set([
  'user',
  'policy',
  'shutdown',
  'reconcile',
  'timeout',
]);

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidClusterRunCancellationError('shape is invalid');
  }
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new InvalidClusterRunCancellationError(`${name} is invalid`);
  }
  return value;
}

function counter(value: unknown, name: string, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > 2_147_483_647
  ) {
    throw new InvalidClusterRunCancellationError(`${name} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new InvalidClusterRunCancellationError(`${name} is invalid`);
  }
  return value;
}

export function parseClusterRunCancellationRequestBody(
  value: unknown,
): Readonly<ClusterRunCancellationRequestBody> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidClusterRunCancellationError('request body is invalid');
  }
  exactKeys(value, ['schema', 'mutationId']);
  const body = value as Record<string, unknown>;
  if (body.schema !== CLUSTER_RUN_CANCELLATION_SCHEMA) {
    throw new InvalidClusterRunCancellationError('schema is invalid');
  }
  return Object.freeze({
    schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
    mutationId: identifier(body.mutationId, 'mutationId'),
  });
}

export function normalizeClusterRunCancellationCommand(
  value: ClusterRunCancellationCommand,
): Readonly<ClusterRunCancellationCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidClusterRunCancellationError('command is invalid');
  }
  const hasWorkflowTarget = value.workflowTarget !== undefined;
  exactKeys(
    value,
    [
      'projectId',
      'runId',
      'mutationId',
      'eventId',
      'subject',
      'policyFence',
      ...(hasWorkflowTarget ? ['workflowTarget'] : []),
    ],
  );
  if (typeof value.eventId !== 'string' || !EVENT_ID_PATTERN.test(value.eventId)) {
    throw new InvalidClusterRunCancellationError('eventId is invalid');
  }
  let subject: Readonly<SecuritySubject>;
  let fence: Readonly<SecurityPolicyFence> | null;
  try {
    subject = normalizeProjectPolicySubject(value.subject);
    fence = normalizeSecurityPolicyDecision({
      effect: 'allow',
      reasons: ['role_grant'],
      fence: value.policyFence,
    }).fence;
  } catch {
    throw new InvalidClusterRunCancellationError(
      'authorization authority is invalid',
    );
  }
  if (!fence || fence.bindingVersion === null) {
    throw new InvalidClusterRunCancellationError(
      'authorization fence is incomplete',
    );
  }
  let workflowTarget:
    | Readonly<ClusterRunCancellationWorkflowTarget>
    | undefined;
  if (hasWorkflowTarget) {
    const target = value.workflowTarget;
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new InvalidClusterRunCancellationError(
        'workflowTarget is invalid',
      );
    }
    exactKeys(target, ['packageName', 'workflowId']);
    if (
      typeof target.packageName !== 'string' ||
      !PACKAGE_NAME_PATTERN.test(target.packageName) ||
      typeof target.workflowId !== 'string' ||
      !WORKFLOW_ID_PATTERN.test(target.workflowId)
    ) {
      throw new InvalidClusterRunCancellationError(
        'workflowTarget is invalid',
      );
    }
    workflowTarget = Object.freeze({
      packageName: target.packageName,
      workflowId: target.workflowId,
    });
  }
  return Object.freeze({
    projectId: identifier(value.projectId, 'projectId'),
    runId: identifier(value.runId, 'runId'),
    mutationId: identifier(value.mutationId, 'mutationId'),
    eventId: value.eventId,
    subject,
    policyFence: fence,
    ...(workflowTarget === undefined ? {} : { workflowTarget }),
  });
}

export function normalizeClusterRunCancellationResult(
  value: ClusterRunCancellationResult,
): Readonly<ClusterRunCancellationResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidClusterRunCancellationError('result is invalid');
  }
  const hasCancellation = value.cancelRequestedAtMs !== undefined;
  exactKeys(
    value,
    hasCancellation
      ? [
          'status', 'projectId', 'runId', 'runStatus', 'runVersion',
          'eventSequence', 'cancelRequestedAtMs', 'cancelReason',
        ]
      : [
          'status', 'projectId', 'runId', 'runStatus', 'runVersion',
          'eventSequence',
        ],
  );
  if (
    !CLUSTER_RUN_CANCELLATION_STATUSES.includes(value.status) ||
    !RUN_STATUSES.includes(value.runStatus) ||
    (value.status === 'accepted' && !hasCancellation) ||
    (value.status === 'already_requested' && !hasCancellation) ||
    (value.status === 'already_terminal' && !TERMINAL.has(value.runStatus)) ||
    (value.status !== 'already_terminal' && TERMINAL.has(value.runStatus))
  ) {
    throw new InvalidClusterRunCancellationError('result state is invalid');
  }
  let cancelRequestedAtMs: number | undefined;
  let cancelReason: ClusterRunCancellationResult['cancelReason'];
  if (hasCancellation) {
    cancelRequestedAtMs = timestamp(
      value.cancelRequestedAtMs,
      'cancelRequestedAtMs',
    );
    if (!CANCEL_REASONS.has(value.cancelReason ?? '')) {
      throw new InvalidClusterRunCancellationError('cancelReason is invalid');
    }
    cancelReason = value.cancelReason;
  } else if (value.cancelReason !== undefined) {
    throw new InvalidClusterRunCancellationError('cancellation shape is invalid');
  }
  return Object.freeze({
    status: value.status,
    projectId: identifier(value.projectId, 'projectId'),
    runId: identifier(value.runId, 'runId'),
    runStatus: value.runStatus,
    runVersion: counter(value.runVersion, 'runVersion', 1),
    eventSequence: counter(value.eventSequence, 'eventSequence', 0),
    ...(cancelRequestedAtMs === undefined
      ? {}
      : { cancelRequestedAtMs, cancelReason: cancelReason! }),
  });
}

export function createClusterRunCancellationResponseBody(
  value: ClusterRunCancellationResult,
): Readonly<ClusterRunCancellationResponseBody> {
  return Object.freeze({
    schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
    ...normalizeClusterRunCancellationResult(value),
  });
}

export function parseClusterRunCancellationResponseBody(
  value: unknown,
): Readonly<ClusterRunCancellationResponseBody> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidClusterRunCancellationError('response body is invalid');
  }
  const { schema, ...result } = value as Record<string, unknown>;
  if (schema !== CLUSTER_RUN_CANCELLATION_SCHEMA) {
    throw new InvalidClusterRunCancellationError('schema is invalid');
  }
  return createClusterRunCancellationResponseBody(
    result as unknown as ClusterRunCancellationResult,
  );
}

export type ClusterRunCancellationAllowedRole = Extract<
  ProjectRole,
  'owner' | 'admin' | 'operator'
>;

// Profile-neutral names are canonical for new Local and Cluster consumers.
// Cluster-prefixed names remain source-compatible throughout the 3.0 Alpha.
export const RUN_CANCELLATION_STATUSES = CLUSTER_RUN_CANCELLATION_STATUSES;
export type RunCancellationStatus = ClusterRunCancellationStatus;
export type RunCancellationRequestBody = ClusterRunCancellationRequestBody;
export type RunCancellationWorkflowTarget =
  ClusterRunCancellationWorkflowTarget;
export type RunCancellationCommand = ClusterRunCancellationCommand;
export type RunCancellationResult = ClusterRunCancellationResult;
export type RunCancellationResponseBody = ClusterRunCancellationResponseBody;
export type RunCancellationRepository = ClusterRunCancellationRepository;
export type RunCancellationFenceReason = ClusterRunCancellationFenceReason;
export type RunCancellationAllowedRole = ClusterRunCancellationAllowedRole;
export const InvalidRunCancellationError =
  InvalidClusterRunCancellationError;
export const RunCancellationNotFoundError =
  ClusterRunCancellationNotFoundError;
export const RunCancellationFenceRejectedError =
  ClusterRunCancellationFenceRejectedError;
export const RunCancellationUnavailableError =
  ClusterRunCancellationUnavailableError;
export const parseRunCancellationRequestBody =
  parseClusterRunCancellationRequestBody;
export const normalizeRunCancellationCommand =
  normalizeClusterRunCancellationCommand;
export const normalizeRunCancellationResult =
  normalizeClusterRunCancellationResult;
export const createRunCancellationResponseBody =
  createClusterRunCancellationResponseBody;
export const parseRunCancellationResponseBody =
  parseClusterRunCancellationResponseBody;

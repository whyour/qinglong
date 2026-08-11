import {
  normalizeProjectPolicySubject,
  type ProjectRole,
} from '../../security/project-policy/projectPolicy';
import {
  normalizeSecurityPolicyDecision,
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
} from '../../security/security';
import type { RunStatus } from '../run';

export const RUN_MANUAL_RETRY_SCHEMA = 'qinglong/run-manual-retry@v1' as const;
export const RUN_MANUAL_RETRY_STATUSES = ['accepted', 'existing'] as const;
export const RUN_MANUAL_RETRY_SOURCE_STATUSES = [
  'failed',
  'cancelled',
  'timed_out',
] as const;
export const RUN_MANUAL_RETRY_EXECUTOR_TYPES = [
  'local_process',
  'remote_worker',
] as const;
export const MAX_RUN_MANUAL_RETRY_AUTHENTICATION_AGE_MS = 5 * 60_000;

export type RunManualRetryStatus = (typeof RUN_MANUAL_RETRY_STATUSES)[number];
export type RunManualRetrySourceStatus =
  (typeof RUN_MANUAL_RETRY_SOURCE_STATUSES)[number];
export type RunManualRetryExecutorType =
  (typeof RUN_MANUAL_RETRY_EXECUTOR_TYPES)[number];
export type RunManualRetryAllowedRole = Extract<
  ProjectRole,
  'owner' | 'admin' | 'operator'
>;

export interface RunManualRetryRequestBody {
  readonly schema: typeof RUN_MANUAL_RETRY_SCHEMA;
  readonly mutationId: string;
  readonly expectedRunVersion: number;
  readonly expectedRunStatus: RunManualRetrySourceStatus;
}

export interface RunManualRetryCommand {
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly mutationId: string;
  readonly expectedRunVersion: number;
  readonly expectedRunStatus: RunManualRetrySourceStatus;
  readonly runId: string;
  readonly attemptId: string;
  readonly createdEventId: string;
  readonly queuedEventId: string;
  readonly auditEventId: string;
  readonly requestId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
}

export interface RunManualRetryResult {
  readonly status: RunManualRetryStatus;
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly sourceRunStatus: RunManualRetrySourceStatus;
  readonly sourceRunVersion: number;
  readonly runId: string;
  readonly retryOfRunId: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly attemptId: string;
  readonly runStatus: 'queued';
  readonly runVersion: 2;
  readonly eventSequence: 2;
  readonly executorType: RunManualRetryExecutorType;
  readonly executionRevisionDigest: string;
  readonly createdAtMs: number;
}

export interface RunManualRetryResponseBody extends RunManualRetryResult {
  readonly schema: typeof RUN_MANUAL_RETRY_SCHEMA;
}

export interface RunManualRetryRepository {
  retryRun(
    command: Readonly<RunManualRetryCommand>,
  ): Promise<Readonly<RunManualRetryResult>>;
}

export type RunManualRetryFenceReason =
  | 'authorization_changed'
  | 'authentication_changed'
  | 'source_changed'
  | 'source_not_terminal'
  | 'source_not_retryable'
  | 'task_disabled'
  | 'mutation_conflict';

export class InvalidRunManualRetryError extends TypeError {
  readonly code = 'RUN_MANUAL_RETRY_INVALID';

  constructor(message: string) {
    super(`Run manual retry is invalid: ${message}`);
    this.name = 'InvalidRunManualRetryError';
  }
}

export class RunManualRetryNotFoundError extends Error {
  readonly code = 'RUN_MANUAL_RETRY_NOT_FOUND';

  constructor() {
    super('Run manual retry target does not exist');
    this.name = 'RunManualRetryNotFoundError';
  }
}

export class RunManualRetryFenceRejectedError extends Error {
  readonly code = 'RUN_MANUAL_RETRY_FENCE_REJECTED';

  constructor(readonly reason: RunManualRetryFenceReason) {
    super(`Run manual retry fence rejected: ${reason}`);
    this.name = 'RunManualRetryFenceRejectedError';
  }
}

export class RunManualRetryRateLimitedError extends Error {
  readonly code = 'RUN_MANUAL_RETRY_RATE_LIMITED';

  constructor(readonly retryAfterMs: number) {
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1) {
      throw new InvalidRunManualRetryError('retry delay is invalid');
    }
    super('Run manual retry rate limit is exhausted');
    this.name = 'RunManualRetryRateLimitedError';
  }
}

export class RunManualRetryUnavailableError extends Error {
  readonly code = 'RUN_MANUAL_RETRY_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Run manual retry is unavailable', options);
    this.name = 'RunManualRetryUnavailableError';
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidRunManualRetryError('shape is invalid');
  }
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidRunManualRetryError(`${name} is invalid`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidRunManualRetryError(`${name} is invalid`);
  }
  return value;
}

function version(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 2_147_483_647
  ) {
    throw new InvalidRunManualRetryError(`${name} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRunManualRetryError(`${name} is invalid`);
  }
  return value;
}

function sourceStatus(value: unknown): RunManualRetrySourceStatus {
  if (
    !RUN_MANUAL_RETRY_SOURCE_STATUSES.includes(
      value as RunManualRetrySourceStatus,
    )
  ) {
    throw new InvalidRunManualRetryError('source Run status is invalid');
  }
  return value as RunManualRetrySourceStatus;
}

export function parseRunManualRetryRequestBody(
  value: unknown,
): Readonly<RunManualRetryRequestBody> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRunManualRetryError('request body is invalid');
  }
  exactKeys(value, [
    'schema',
    'mutationId',
    'expectedRunVersion',
    'expectedRunStatus',
  ]);
  const body = value as Record<string, unknown>;
  if (body.schema !== RUN_MANUAL_RETRY_SCHEMA) {
    throw new InvalidRunManualRetryError('schema is invalid');
  }
  return Object.freeze({
    schema: RUN_MANUAL_RETRY_SCHEMA,
    mutationId: uuid(body.mutationId, 'mutationId'),
    expectedRunVersion: version(
      body.expectedRunVersion,
      'expected Run version',
    ),
    expectedRunStatus: sourceStatus(body.expectedRunStatus),
  });
}

export function normalizeRunManualRetryCommand(
  value: RunManualRetryCommand,
): Readonly<RunManualRetryCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRunManualRetryError('command is invalid');
  }
  exactKeys(value, [
    'projectId',
    'sourceRunId',
    'mutationId',
    'expectedRunVersion',
    'expectedRunStatus',
    'runId',
    'attemptId',
    'createdEventId',
    'queuedEventId',
    'auditEventId',
    'requestId',
    'principal',
    'policyFence',
  ]);
  let principal: Readonly<SecurityPrincipal>;
  let fence: Readonly<SecurityPolicyFence> | null;
  try {
    principal = normalizeSecurityPrincipal(
      value.principal,
      value.principal.authenticatedAtMs,
    );
    fence = normalizeSecurityPolicyDecision({
      effect: 'allow',
      reasons: ['role_grant'],
      fence: value.policyFence,
    }).fence;
  } catch {
    throw new InvalidRunManualRetryError('authorization authority is invalid');
  }
  if (
    principal.subject.type !== 'user' ||
    !['multi_factor', 'hardware', 'local_console'].includes(
      principal.assurance,
    ) ||
    !fence ||
    fence.bindingVersion === null
  ) {
    throw new InvalidRunManualRetryError(
      'strong User authorization authority is incomplete',
    );
  }
  return Object.freeze({
    projectId: identifier(value.projectId, 'projectId'),
    sourceRunId: identifier(value.sourceRunId, 'sourceRunId'),
    mutationId: uuid(value.mutationId, 'mutationId'),
    expectedRunVersion: version(
      value.expectedRunVersion,
      'expected Run version',
    ),
    expectedRunStatus: sourceStatus(value.expectedRunStatus),
    runId: uuid(value.runId, 'runId'),
    attemptId: uuid(value.attemptId, 'attemptId'),
    createdEventId: uuid(value.createdEventId, 'createdEventId'),
    queuedEventId: uuid(value.queuedEventId, 'queuedEventId'),
    auditEventId: uuid(value.auditEventId, 'auditEventId'),
    requestId: identifier(value.requestId, 'requestId'),
    principal,
    policyFence: fence,
  });
}

export function normalizeRunManualRetryResult(
  value: RunManualRetryResult,
): Readonly<RunManualRetryResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRunManualRetryError('result is invalid');
  }
  exactKeys(value, [
    'status',
    'projectId',
    'sourceRunId',
    'sourceRunStatus',
    'sourceRunVersion',
    'runId',
    'retryOfRunId',
    'taskId',
    'taskRevision',
    'attemptId',
    'runStatus',
    'runVersion',
    'eventSequence',
    'executorType',
    'executionRevisionDigest',
    'createdAtMs',
  ]);
  if (
    !RUN_MANUAL_RETRY_STATUSES.includes(value.status) ||
    value.retryOfRunId !== value.sourceRunId ||
    value.runId === value.sourceRunId ||
    value.runStatus !== 'queued' ||
    value.runVersion !== 2 ||
    value.eventSequence !== 2 ||
    !RUN_MANUAL_RETRY_EXECUTOR_TYPES.includes(value.executorType) ||
    !DIGEST_PATTERN.test(value.executionRevisionDigest)
  ) {
    throw new InvalidRunManualRetryError('result state is invalid');
  }
  return Object.freeze({
    status: value.status,
    projectId: identifier(value.projectId, 'projectId'),
    sourceRunId: identifier(value.sourceRunId, 'sourceRunId'),
    sourceRunStatus: sourceStatus(value.sourceRunStatus),
    sourceRunVersion: version(value.sourceRunVersion, 'source Run version'),
    runId: uuid(value.runId, 'runId'),
    retryOfRunId: identifier(value.retryOfRunId, 'retryOfRunId'),
    taskId: identifier(value.taskId, 'taskId'),
    taskRevision: identifier(value.taskRevision, 'taskRevision'),
    attemptId: uuid(value.attemptId, 'attemptId'),
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    executorType: value.executorType,
    executionRevisionDigest: value.executionRevisionDigest,
    createdAtMs: timestamp(value.createdAtMs, 'createdAtMs'),
  });
}

export function createRunManualRetryResponseBody(
  value: RunManualRetryResult,
): Readonly<RunManualRetryResponseBody> {
  return Object.freeze({
    schema: RUN_MANUAL_RETRY_SCHEMA,
    ...normalizeRunManualRetryResult(value),
  });
}

export function isRunManualRetrySourceStatus(
  value: RunStatus,
): value is RunManualRetrySourceStatus {
  return RUN_MANUAL_RETRY_SOURCE_STATUSES.includes(
    value as RunManualRetrySourceStatus,
  );
}

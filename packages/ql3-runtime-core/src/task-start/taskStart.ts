import {
  normalizeProjectPolicySubject,
  type ProjectRole,
} from '../security/project-policy/projectPolicy';
import {
  normalizeSecurityPolicyDecision,
  type SecurityPolicyFence,
  type SecuritySubject,
} from '../security/security';

export const TASK_START_SCHEMA = 'qinglong/task-start@v1' as const;
export const TASK_START_STATUSES = ['accepted', 'existing'] as const;
export const TASK_START_EXECUTOR_TYPES = [
  'local_process',
  'remote_worker',
] as const;

export type TaskStartStatus = (typeof TASK_START_STATUSES)[number];
export type TaskStartExecutorType =
  (typeof TASK_START_EXECUTOR_TYPES)[number];

export interface TaskStartRequestBody {
  readonly schema: typeof TASK_START_SCHEMA;
  readonly mutationId: string;
  readonly expectedRevision: number;
  readonly expectedContentDigest: string;
}

export interface TaskStartCommand {
  readonly projectId: string;
  readonly taskId: string;
  readonly mutationId: string;
  readonly expectedRevision: number;
  readonly expectedContentDigest: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly createdEventId: string;
  readonly queuedEventId: string;
  readonly subject: Readonly<SecuritySubject>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
}

export interface TaskStartResult {
  readonly status: TaskStartStatus;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskContentDigest: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly runStatus: 'queued';
  readonly runVersion: 2;
  readonly eventSequence: 2;
  readonly executorType: TaskStartExecutorType;
  readonly executionRevisionDigest: string;
  readonly createdAtMs: number;
}

export interface TaskStartResponseBody extends TaskStartResult {
  readonly schema: typeof TASK_START_SCHEMA;
}

export interface TaskStartRepository {
  startTask(
    command: Readonly<TaskStartCommand>,
  ): Promise<Readonly<TaskStartResult>>;
}

export type TaskStartFenceReason =
  | 'authorization_changed'
  | 'definition_changed'
  | 'task_disabled'
  | 'task_not_executable'
  | 'mutation_conflict';

export type TaskStartAllowedRole = Extract<
  ProjectRole,
  'owner' | 'admin' | 'operator'
>;

export class InvalidTaskStartError extends TypeError {
  readonly code = 'TASK_START_INVALID';

  constructor(message: string) {
    super(`Task start is invalid: ${message}`);
    this.name = 'InvalidTaskStartError';
  }
}

export class TaskStartNotFoundError extends Error {
  readonly code = 'TASK_START_NOT_FOUND';

  constructor() {
    super('Task start target does not exist');
    this.name = 'TaskStartNotFoundError';
  }
}

export class TaskStartFenceRejectedError extends Error {
  readonly code = 'TASK_START_FENCE_REJECTED';

  constructor(readonly reason: TaskStartFenceReason) {
    super(`Task start fence rejected: ${reason}`);
    this.name = 'TaskStartFenceRejectedError';
  }
}

export class TaskStartUnavailableError extends Error {
  readonly code = 'TASK_START_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Task start is unavailable', options);
    this.name = 'TaskStartUnavailableError';
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
    throw new InvalidTaskStartError('shape is invalid');
  }
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidTaskStartError(`${name} is invalid`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidTaskStartError(`${name} is invalid`);
  }
  return value;
}

function revision(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 2_147_483_647
  ) {
    throw new InvalidTaskStartError(`${name} is invalid`);
  }
  return value;
}

function digest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidTaskStartError(`${name} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new InvalidTaskStartError(`${name} is invalid`);
  }
  return value;
}

export function parseTaskStartRequestBody(
  value: unknown,
): Readonly<TaskStartRequestBody> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskStartError('request body is invalid');
  }
  exactKeys(value, [
    'schema',
    'mutationId',
    'expectedRevision',
    'expectedContentDigest',
  ]);
  const body = value as Record<string, unknown>;
  if (body.schema !== TASK_START_SCHEMA) {
    throw new InvalidTaskStartError('schema is invalid');
  }
  return Object.freeze({
    schema: TASK_START_SCHEMA,
    mutationId: uuid(body.mutationId, 'mutationId'),
    expectedRevision: revision(body.expectedRevision, 'expectedRevision'),
    expectedContentDigest: digest(
      body.expectedContentDigest,
      'expectedContentDigest',
    ),
  });
}

export function normalizeTaskStartCommand(
  value: TaskStartCommand,
): Readonly<TaskStartCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskStartError('command is invalid');
  }
  exactKeys(value, [
    'projectId',
    'taskId',
    'mutationId',
    'expectedRevision',
    'expectedContentDigest',
    'runId',
    'attemptId',
    'createdEventId',
    'queuedEventId',
    'subject',
    'policyFence',
  ]);
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
    throw new InvalidTaskStartError('authorization authority is invalid');
  }
  if (!fence || fence.bindingVersion === null) {
    throw new InvalidTaskStartError('authorization fence is incomplete');
  }
  return Object.freeze({
    projectId: identifier(value.projectId, 'projectId'),
    taskId: identifier(value.taskId, 'taskId'),
    mutationId: uuid(value.mutationId, 'mutationId'),
    expectedRevision: revision(value.expectedRevision, 'expectedRevision'),
    expectedContentDigest: digest(
      value.expectedContentDigest,
      'expectedContentDigest',
    ),
    runId: uuid(value.runId, 'runId'),
    attemptId: uuid(value.attemptId, 'attemptId'),
    createdEventId: uuid(value.createdEventId, 'createdEventId'),
    queuedEventId: uuid(value.queuedEventId, 'queuedEventId'),
    subject,
    policyFence: fence,
  });
}

export function normalizeTaskStartResult(
  value: TaskStartResult,
): Readonly<TaskStartResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskStartError('result is invalid');
  }
  exactKeys(value, [
    'status',
    'projectId',
    'taskId',
    'taskRevision',
    'taskContentDigest',
    'runId',
    'attemptId',
    'runStatus',
    'runVersion',
    'eventSequence',
    'executorType',
    'executionRevisionDigest',
    'createdAtMs',
  ]);
  if (
    !TASK_START_STATUSES.includes(value.status) ||
    value.runStatus !== 'queued' ||
    value.runVersion !== 2 ||
    value.eventSequence !== 2 ||
    !TASK_START_EXECUTOR_TYPES.includes(value.executorType)
  ) {
    throw new InvalidTaskStartError('result state is invalid');
  }
  return Object.freeze({
    status: value.status,
    projectId: identifier(value.projectId, 'projectId'),
    taskId: identifier(value.taskId, 'taskId'),
    taskRevision: revision(value.taskRevision, 'taskRevision'),
    taskContentDigest: digest(value.taskContentDigest, 'taskContentDigest'),
    runId: uuid(value.runId, 'runId'),
    attemptId: uuid(value.attemptId, 'attemptId'),
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    executorType: value.executorType,
    executionRevisionDigest: digest(
      value.executionRevisionDigest,
      'executionRevisionDigest',
    ),
    createdAtMs: timestamp(value.createdAtMs, 'createdAtMs'),
  });
}

export function createTaskStartResponseBody(
  value: TaskStartResult,
): Readonly<TaskStartResponseBody> {
  return Object.freeze({
    schema: TASK_START_SCHEMA,
    ...normalizeTaskStartResult(value),
  });
}

export function parseTaskStartResponseBody(
  value: unknown,
): Readonly<TaskStartResponseBody> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskStartError('response body is invalid');
  }
  const { schema, ...result } = value as Record<string, unknown>;
  if (schema !== TASK_START_SCHEMA) {
    throw new InvalidTaskStartError('schema is invalid');
  }
  return createTaskStartResponseBody(result as unknown as TaskStartResult);
}

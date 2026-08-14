import { RUN_STATUSES, type RunStatus } from '../run';

export const MAX_TASK_RUN_OUTCOME_WINDOW_STORAGE_LIMIT = 65;

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export interface TaskRunOutcomeWindowQuery {
  readonly projectId: string;
  readonly taskId: string;
  readonly limit: number;
}

export interface TaskRunOutcomeWindowRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly status: RunStatus;
  readonly createdAtMs: number;
}

export interface TaskRunOutcomeWindowReader {
  listRecentRunsByTask(
    query: Readonly<TaskRunOutcomeWindowQuery>,
  ): Promise<readonly Readonly<TaskRunOutcomeWindowRecord>[]>;
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_PATTERN.test(value)
  );
}

export function normalizeTaskRunOutcomeWindowQuery(
  value: Readonly<TaskRunOutcomeWindowQuery>,
): Readonly<TaskRunOutcomeWindowQuery> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 3 ||
    !Object.hasOwn(value, 'projectId') ||
    !Object.hasOwn(value, 'taskId') ||
    !Object.hasOwn(value, 'limit') ||
    !boundedText(value.projectId, 128) ||
    !boundedText(value.taskId, 255) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_TASK_RUN_OUTCOME_WINDOW_STORAGE_LIMIT
  ) {
    throw new TypeError('Task Run outcome window query is invalid');
  }
  return Object.freeze({
    projectId: value.projectId,
    taskId: value.taskId,
    limit: value.limit,
  });
}

export function normalizeTaskRunOutcomeWindowRecord(
  value: Readonly<TaskRunOutcomeWindowRecord>,
): Readonly<TaskRunOutcomeWindowRecord> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 5 ||
    !Object.hasOwn(value, 'id') ||
    !Object.hasOwn(value, 'projectId') ||
    !Object.hasOwn(value, 'taskId') ||
    !Object.hasOwn(value, 'status') ||
    !Object.hasOwn(value, 'createdAtMs') ||
    !boundedText(value.id, 128) ||
    !boundedText(value.projectId, 128) ||
    !boundedText(value.taskId, 255) ||
    !RUN_STATUSES.includes(value.status) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0
  ) {
    throw new TypeError('Task Run outcome window record is invalid');
  }
  return Object.freeze({
    id: value.id,
    projectId: value.projectId,
    taskId: value.taskId,
    status: value.status,
    createdAtMs: value.createdAtMs,
  });
}

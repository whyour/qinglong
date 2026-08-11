import type { RunRecord } from './run';

export const MAX_PROJECT_RUN_LIST_STORAGE_LIMIT = 65;

export interface ProjectRunListCursor {
  readonly createdAtMs: number;
  readonly runId: string;
}

export interface ProjectRunListQuery {
  readonly projectId: string;
  readonly limit: number;
  readonly after?: Readonly<ProjectRunListCursor>;
}

export interface ProjectRunListReader {
  listRunsByProject(
    query: Readonly<ProjectRunListQuery>,
  ): Promise<readonly RunRecord[]>;
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_PATTERN.test(value)
  );
}

export function normalizeProjectRunListQuery(
  value: Readonly<ProjectRunListQuery>,
): Readonly<ProjectRunListQuery> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Project Run list query is invalid');
  }
  const keys = Reflect.ownKeys(value);
  const afterKeys =
    value.after &&
    typeof value.after === 'object' &&
    !Array.isArray(value.after)
      ? Reflect.ownKeys(value.after)
      : [];
  if (
    keys.length < 2 ||
    keys.length > 3 ||
    keys.some(
      (key) => key !== 'projectId' && key !== 'limit' && key !== 'after',
    ) ||
    !Object.hasOwn(value, 'projectId') ||
    !Object.hasOwn(value, 'limit') ||
    !boundedText(value.projectId, 128) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_PROJECT_RUN_LIST_STORAGE_LIMIT ||
    (value.after !== undefined &&
      (!value.after ||
        typeof value.after !== 'object' ||
        Array.isArray(value.after) ||
        afterKeys.length !== 2 ||
        afterKeys.some((key) => key !== 'createdAtMs' && key !== 'runId') ||
        !Object.hasOwn(value.after, 'createdAtMs') ||
        !Object.hasOwn(value.after, 'runId') ||
        !Number.isSafeInteger(value.after.createdAtMs) ||
        value.after.createdAtMs < 0 ||
        !boundedText(value.after.runId, 128)))
  ) {
    throw new TypeError('Project Run list query is invalid');
  }
  return Object.freeze({
    projectId: value.projectId,
    limit: value.limit,
    ...(value.after === undefined
      ? {}
      : {
          after: Object.freeze({
            createdAtMs: value.after.createdAtMs,
            runId: value.after.runId,
          }),
        }),
  });
}

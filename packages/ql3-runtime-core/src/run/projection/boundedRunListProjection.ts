import {
  EXECUTION_ORIGINS,
  RUN_STATUSES,
  type ExecutionOrigin,
  type ExecutionOwner,
  type RunRecord,
  type RunStatus,
} from '../run';
import {
  normalizeProjectRunListQuery,
  type ProjectRunListCursor,
  type ProjectRunListReader,
} from '../projectRunList';

export const DEFAULT_BOUNDED_RUN_LIST_LIMIT = 32;
export const MAX_BOUNDED_RUN_LIST_LIMIT = 64;

const MAX_INT = 2_147_483_647;
const MIN_INT = -2_147_483_648;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export interface BoundedRunListInput {
  readonly limit?: number;
  readonly after?: Readonly<ProjectRunListCursor>;
}

export interface BoundedRunListItem {
  readonly id: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly status: RunStatus;
  readonly version: number;
  readonly eventSequence: number;
  readonly priority: number;
  readonly executionOrigin: ExecutionOrigin;
  readonly executionOwner: ExecutionOwner;
  readonly createdAtMs: number;
  readonly queuedAtMs?: number;
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
}

export interface BoundedRunListProjection {
  readonly runs: readonly Readonly<BoundedRunListItem>[];
  readonly hasMore: boolean;
  readonly next?: Readonly<ProjectRunListCursor>;
}

export class InvalidBoundedRunListProjectionError extends TypeError {
  readonly code = 'BOUNDED_RUN_LIST_PROJECTION_INVALID';

  constructor() {
    super('Bounded Run list projection input is invalid');
    this.name = 'InvalidBoundedRunListProjectionError';
  }
}

export class BoundedRunListProjectionUnavailableError extends Error {
  readonly code = 'BOUNDED_RUN_LIST_PROJECTION_UNAVAILABLE';

  constructor() {
    super('Bounded Run list projection is unavailable');
    this.name = 'BoundedRunListProjectionUnavailableError';
  }
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_PATTERN.test(value)
  );
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

function cursor(value: unknown): value is Readonly<ProjectRunListCursor> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === 2 &&
    Object.hasOwn(value, 'createdAtMs') &&
    Object.hasOwn(value, 'runId') &&
    integer((value as ProjectRunListCursor).createdAtMs, 0, Number.MAX_SAFE_INTEGER) &&
    boundedText((value as ProjectRunListCursor).runId, 128)
  );
}

function normalizeInput(value: Readonly<BoundedRunListInput>): Readonly<{
  limit: number;
  after?: Readonly<ProjectRunListCursor>;
}> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidBoundedRunListProjectionError();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > 2 ||
    keys.some((key) => key !== 'limit' && key !== 'after') ||
    (value.limit !== undefined &&
      !integer(value.limit, 1, MAX_BOUNDED_RUN_LIST_LIMIT)) ||
    (value.after !== undefined && !cursor(value.after))
  ) {
    throw new InvalidBoundedRunListProjectionError();
  }
  return Object.freeze({
    limit: value.limit ?? DEFAULT_BOUNDED_RUN_LIST_LIMIT,
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

function isBefore(
  value: Readonly<ProjectRunListCursor>,
  boundary: Readonly<ProjectRunListCursor>,
): boolean {
  return (
    value.createdAtMs < boundary.createdAtMs ||
    (value.createdAtMs === boundary.createdAtMs && value.runId < boundary.runId)
  );
}

function optionalTimestamp(value: unknown): value is number | undefined {
  return value === undefined || integer(value, 0, Number.MAX_SAFE_INTEGER);
}

function projectRun(
  value: RunRecord,
  projectId: string,
  boundary?: Readonly<ProjectRunListCursor>,
): Readonly<BoundedRunListItem> | null {
  const rowCursor = { createdAtMs: value?.createdAtMs, runId: value?.id };
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.projectId !== projectId ||
    !cursor(rowCursor) ||
    (boundary !== undefined && !isBefore(rowCursor, boundary)) ||
    !boundedText(value.taskId, 255) ||
    !boundedText(value.taskRevision, 255) ||
    !RUN_STATUSES.includes(value.status) ||
    !EXECUTION_ORIGINS.includes(value.executionOrigin) ||
    (value.executionOwner !== 'legacy' && value.executionOwner !== 'runtime') ||
    !integer(value.version, 0, MAX_INT) ||
    !integer(value.eventSequence, 0, MAX_INT) ||
    !integer(value.priority, MIN_INT, MAX_INT) ||
    !optionalTimestamp(value.queuedAtMs) ||
    !optionalTimestamp(value.startedAtMs) ||
    !optionalTimestamp(value.finishedAtMs)
  ) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    status: value.status,
    version: value.version,
    eventSequence: value.eventSequence,
    priority: value.priority,
    executionOrigin: value.executionOrigin,
    executionOwner: value.executionOwner,
    createdAtMs: value.createdAtMs,
    ...(value.queuedAtMs === undefined ? {} : { queuedAtMs: value.queuedAtMs }),
    ...(value.startedAtMs === undefined ? {} : { startedAtMs: value.startedAtMs }),
    ...(value.finishedAtMs === undefined ? {} : { finishedAtMs: value.finishedAtMs }),
  });
}

export async function executeBoundedRunListProjection(
  runs: ProjectRunListReader,
  projectId: string,
  input: Readonly<BoundedRunListInput>,
): Promise<Readonly<BoundedRunListProjection>> {
  if (
    !runs ||
    typeof runs.listRunsByProject !== 'function' ||
    !boundedText(projectId, 128)
  ) {
    throw new InvalidBoundedRunListProjectionError();
  }
  const normalized = normalizeInput(input);
  const query = normalizeProjectRunListQuery({
    projectId,
    limit: normalized.limit + 1,
    ...(normalized.after === undefined ? {} : { after: normalized.after }),
  });
  let rows: readonly RunRecord[];
  try {
    rows = await runs.listRunsByProject(query);
  } catch {
    throw new BoundedRunListProjectionUnavailableError();
  }
  if (!Array.isArray(rows) || rows.length > normalized.limit + 1) {
    throw new BoundedRunListProjectionUnavailableError();
  }

  const projected: Readonly<BoundedRunListItem>[] = [];
  let boundary = normalized.after;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const item = projectRun(row, projectId, boundary);
    if (!item) throw new BoundedRunListProjectionUnavailableError();
    boundary = Object.freeze({ createdAtMs: row.createdAtMs, runId: row.id });
    if (index < normalized.limit) projected.push(item);
  }

  const hasMore = rows.length > normalized.limit;
  const lastReturned = projected.at(-1);
  return Object.freeze({
    runs: Object.freeze(projected),
    hasMore,
    ...(hasMore && lastReturned
      ? {
          next: Object.freeze({
            createdAtMs: lastReturned.createdAtMs,
            runId: lastReturned.id,
          }),
        }
      : {}),
  });
}

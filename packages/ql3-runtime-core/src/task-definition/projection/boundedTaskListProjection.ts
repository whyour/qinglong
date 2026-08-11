import {
  TASK_DEFINITION_KINDS,
  normalizeTaskDefinitionCursor,
  type TaskDefinitionCursor,
  type TaskDefinitionRecord,
  type TaskDefinitionSource,
} from '../taskDefinition';

export const DEFAULT_BOUNDED_TASK_LIST_LIMIT = 32;
export const MAX_BOUNDED_TASK_LIST_LIMIT = 64;

const MAX_REVISION = 2_147_483_647;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export interface BoundedTaskListInput {
  readonly limit?: number;
  readonly after?: Readonly<TaskDefinitionCursor>;
}

export interface BoundedTaskListItem {
  readonly taskId: string;
  readonly revision: number;
  readonly name: string;
  readonly kind: TaskDefinitionRecord['kind'];
  readonly specSchema: string;
  readonly enabled: boolean;
  readonly updatedAtMs: number;
}

export interface BoundedTaskListProjection {
  readonly tasks: readonly Readonly<BoundedTaskListItem>[];
  readonly hasMore: boolean;
  readonly next?: Readonly<TaskDefinitionCursor>;
}

export class InvalidBoundedTaskListProjectionError extends TypeError {
  readonly code = 'BOUNDED_TASK_LIST_PROJECTION_INVALID';

  constructor() {
    super('Bounded Task list projection input is invalid');
    this.name = 'InvalidBoundedTaskListProjectionError';
  }
}

export class BoundedTaskListProjectionUnavailableError extends Error {
  readonly code = 'BOUNDED_TASK_LIST_PROJECTION_UNAVAILABLE';

  constructor() {
    super('Bounded Task list projection is unavailable');
    this.name = 'BoundedTaskListProjectionUnavailableError';
  }
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    !CONTROL_PATTERN.test(value)
  );
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

function normalizeInput(
  value: Readonly<BoundedTaskListInput>,
): Readonly<{ limit: number; after?: Readonly<TaskDefinitionCursor> }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidBoundedTaskListProjectionError();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > 2 ||
    keys.some((key) => key !== 'limit' && key !== 'after') ||
    (value.limit !== undefined &&
      !integer(value.limit, 1, MAX_BOUNDED_TASK_LIST_LIMIT))
  ) {
    throw new InvalidBoundedTaskListProjectionError();
  }
  let after: Readonly<TaskDefinitionCursor> | undefined;
  try {
    after =
      value.after === undefined
        ? undefined
        : normalizeTaskDefinitionCursor(value.after);
  } catch {
    throw new InvalidBoundedTaskListProjectionError();
  }
  return Object.freeze({
    limit: value.limit ?? DEFAULT_BOUNDED_TASK_LIST_LIMIT,
    ...(after === undefined ? {} : { after }),
  });
}

function projectTask(
  value: TaskDefinitionRecord,
  projectId: string,
  after?: string,
): Readonly<BoundedTaskListItem> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.projectId !== projectId ||
    (after !== undefined && value.taskId <= after) ||
    !boundedText(value.taskId, 128) ||
    !integer(value.revision, 1, MAX_REVISION) ||
    !boundedText(value.name, 255) ||
    !TASK_DEFINITION_KINDS.includes(value.kind) ||
    !boundedText(value.spec?.schema, 137) ||
    typeof value.enabled !== 'boolean' ||
    !integer(value.updatedAtMs, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  return Object.freeze({
    taskId: value.taskId,
    revision: value.revision,
    name: value.name,
    kind: value.kind,
    specSchema: value.spec.schema,
    enabled: value.enabled,
    updatedAtMs: value.updatedAtMs,
  });
}

export async function executeBoundedTaskListProjection(
  source: Pick<TaskDefinitionSource, 'listTaskDefinitions'>,
  projectId: string,
  input: Readonly<BoundedTaskListInput>,
): Promise<Readonly<BoundedTaskListProjection>> {
  if (
    !source ||
    typeof source.listTaskDefinitions !== 'function' ||
    !boundedText(projectId, 128)
  ) {
    throw new InvalidBoundedTaskListProjectionError();
  }
  const normalized = normalizeInput(input);
  let page;
  try {
    page = await source.listTaskDefinitions({
      projectId,
      limit: normalized.limit,
      ...(normalized.after === undefined ? {} : { after: normalized.after }),
    });
  } catch {
    throw new BoundedTaskListProjectionUnavailableError();
  }
  if (
    !page ||
    !Array.isArray(page.definitions) ||
    page.definitions.length > normalized.limit ||
    typeof page.truncated !== 'boolean' ||
    page.truncated !== Boolean(page.next)
  ) {
    throw new BoundedTaskListProjectionUnavailableError();
  }

  const tasks: Readonly<BoundedTaskListItem>[] = [];
  let boundary = normalized.after?.taskId;
  for (const definition of page.definitions) {
    const projected = projectTask(definition, projectId, boundary);
    if (!projected) throw new BoundedTaskListProjectionUnavailableError();
    tasks.push(projected);
    boundary = definition.taskId;
  }
  if (
    page.truncated &&
    (!page.next || page.next.taskId !== boundary || tasks.length === 0)
  ) {
    throw new BoundedTaskListProjectionUnavailableError();
  }
  return Object.freeze({
    tasks: Object.freeze(tasks),
    hasMore: page.truncated,
    ...(page.truncated
      ? { next: Object.freeze({ taskId: boundary! }) }
      : {}),
  });
}

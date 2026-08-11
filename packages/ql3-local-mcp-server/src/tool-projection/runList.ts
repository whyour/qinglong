import {
  EXECUTION_ORIGINS,
  RUN_STATUSES,
} from '@qinglong/runtime-core/run';
import {
  type ProjectRunListCursor,
  type ProjectRunListReader,
} from '@qinglong/runtime-core/project-run-list';
import {
  BoundedRunListProjectionUnavailableError,
  DEFAULT_BOUNDED_RUN_LIST_LIMIT,
  InvalidBoundedRunListProjectionError,
  MAX_BOUNDED_RUN_LIST_LIMIT,
  executeBoundedRunListProjection,
} from '@qinglong/runtime-core/bounded-run-list-projection';
import {
  normalizeToolDefinition,
  type ToolJsonValue,
} from '@qinglong/runtime-core/tool-registry';

export const BUILTIN_RUN_LIST_TOOL = Object.freeze({
  name: 'qinglong.run.list',
  version: '1.0.0',
});
export const BUILTIN_RUN_LIST_TIMEOUT_SECONDS = 5;
export const BUILTIN_RUN_LIST_DEFAULT_LIMIT = DEFAULT_BOUNDED_RUN_LIST_LIMIT;
export const BUILTIN_RUN_LIST_MAX_LIMIT = MAX_BOUNDED_RUN_LIST_LIMIT;

const MAX_INT = 2_147_483_647;
const MIN_INT = -2_147_483_648;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

const RUN_LIST_ITEM_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    taskId: { type: 'string', minLength: 1, maxLength: 255 },
    taskRevision: { type: 'string', minLength: 1, maxLength: 255 },
    status: { type: 'string', maxLength: 32, enum: RUN_STATUSES },
    version: { type: 'integer', minimum: 0, maximum: MAX_INT },
    eventSequence: { type: 'integer', minimum: 0, maximum: MAX_INT },
    priority: { type: 'integer', minimum: MIN_INT, maximum: MAX_INT },
    executionOrigin: {
      type: 'string',
      maxLength: 32,
      enum: EXECUTION_ORIGINS,
    },
    executionOwner: {
      type: 'string',
      maxLength: 16,
      enum: ['legacy', 'runtime'],
    },
    createdAtMs: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    queuedAtMs: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    startedAtMs: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    finishedAtMs: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
  required: [
    'id',
    'taskId',
    'taskRevision',
    'status',
    'version',
    'eventSequence',
    'priority',
    'executionOrigin',
    'executionOwner',
    'createdAtMs',
  ],
  additionalProperties: false,
});

const RUN_LIST_CURSOR_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    createdAtMs: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    runId: { type: 'string', minLength: 1, maxLength: 128 },
  },
  required: ['createdAtMs', 'runId'],
  additionalProperties: false,
});

export const BUILTIN_RUN_LIST_TOOL_DEFINITION = normalizeToolDefinition({
  name: BUILTIN_RUN_LIST_TOOL.name,
  version: BUILTIN_RUN_LIST_TOOL.version,
  description: 'List recent low-sensitive Runs in the authenticated Project',
  inputSchema: {
    type: 'object',
    properties: {
      after: RUN_LIST_CURSOR_SCHEMA,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: BUILTIN_RUN_LIST_MAX_LIMIT,
      },
    },
    required: [],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      runs: {
        type: 'array',
        maxItems: BUILTIN_RUN_LIST_MAX_LIMIT,
        items: RUN_LIST_ITEM_SCHEMA,
      },
      hasMore: { type: 'boolean' },
      next: RUN_LIST_CURSOR_SCHEMA,
    },
    required: ['runs', 'hasMore'],
    additionalProperties: false,
  },
  effect: 'read',
  risk: 'low',
  requiredPermissions: ['run.read'],
  timeoutSeconds: BUILTIN_RUN_LIST_TIMEOUT_SECONDS,
});

export class InvalidBuiltInRunListToolError extends TypeError {
  readonly code = 'BUILTIN_RUN_LIST_TOOL_INVALID';

  constructor(message: string) {
    super(`Built-in Run list Tool is invalid: ${message}`);
    this.name = 'InvalidBuiltInRunListToolError';
  }
}

export class BuiltInRunListToolUnavailableError extends Error {
  readonly code = 'BUILTIN_RUN_LIST_TOOL_UNAVAILABLE';

  constructor() {
    super('Built-in Run list Tool is unavailable');
    this.name = 'BuiltInRunListToolUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidBuiltInRunListToolError(message);
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
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

function normalizeCursor(
  value: ToolJsonValue | undefined,
): ProjectRunListCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('cursor is invalid');
  }
  const cursor = value as Readonly<Record<string, ToolJsonValue>>;
  if (
    Reflect.ownKeys(cursor).length !== 2 ||
    !Object.hasOwn(cursor, 'createdAtMs') ||
    !Object.hasOwn(cursor, 'runId') ||
    !integer(cursor.createdAtMs, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedText(cursor.runId, 128)
  ) {
    return invalid('cursor is invalid');
  }
  return Object.freeze({
    createdAtMs: cursor.createdAtMs,
    runId: cursor.runId,
  });
}

export async function executeBuiltInRunListTool(
  runs: ProjectRunListReader,
  projectId: string,
  input: ToolJsonValue,
): Promise<Readonly<Record<string, ToolJsonValue>>> {
  const inputRecord =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Readonly<Record<string, ToolJsonValue>>)
      : null;
  const inputKeys = inputRecord ? Reflect.ownKeys(inputRecord) : [];
  if (
    !runs ||
    typeof runs.listRunsByProject !== 'function' ||
    !boundedText(projectId, 128) ||
    !inputRecord ||
    inputKeys.length > 2 ||
    inputKeys.some((key) => key !== 'after' && key !== 'limit') ||
    (inputRecord.limit !== undefined &&
      !integer(inputRecord.limit, 1, BUILTIN_RUN_LIST_MAX_LIMIT))
  ) {
    return invalid('execution context or input is invalid');
  }
  const after = normalizeCursor(inputRecord.after);
  const limit = inputRecord.limit ?? BUILTIN_RUN_LIST_DEFAULT_LIMIT;
  let result;
  try {
    result = await executeBoundedRunListProjection(runs, projectId, {
      limit,
      ...(after === undefined ? {} : { after }),
    });
  } catch (error) {
    if (error instanceof InvalidBoundedRunListProjectionError) {
      return invalid('execution context or input is invalid');
    }
    if (!(error instanceof BoundedRunListProjectionUnavailableError)) {
      throw error;
    }
    throw new BuiltInRunListToolUnavailableError();
  }
  const projected: readonly ToolJsonValue[] = result.runs.map((run) =>
    Object.freeze({ ...run }),
  );
  return Object.freeze({
    runs: Object.freeze(projected),
    hasMore: result.hasMore,
    ...(result.next === undefined
      ? {}
      : {
          next: Object.freeze({
            createdAtMs: result.next.createdAtMs,
            runId: result.next.runId,
          }),
        }),
  });
}

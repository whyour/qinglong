import {
  TASK_DEFINITION_KINDS,
  type TaskDefinitionSource,
} from '@qinglong/runtime-core/task-definition';
import {
  BoundedTaskListProjectionUnavailableError,
  DEFAULT_BOUNDED_TASK_LIST_LIMIT,
  InvalidBoundedTaskListProjectionError,
  MAX_BOUNDED_TASK_LIST_LIMIT,
  executeBoundedTaskListProjection,
} from '@qinglong/runtime-core/bounded-task-list-projection';
import {
  normalizeToolDefinition,
  type ToolJsonValue,
} from '@qinglong/runtime-core/tool-registry';

export const BUILTIN_TASK_LIST_TOOL = Object.freeze({
  name: 'qinglong.task.list',
  version: '1.0.0',
});
export const BUILTIN_TASK_LIST_TIMEOUT_SECONDS = 5;
export const BUILTIN_TASK_LIST_DEFAULT_LIMIT = DEFAULT_BOUNDED_TASK_LIST_LIMIT;
export const BUILTIN_TASK_LIST_MAX_LIMIT = MAX_BOUNDED_TASK_LIST_LIMIT;

const TASK_LIST_CURSOR_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    taskId: { type: 'string', minLength: 1, maxLength: 128 },
  },
  required: ['taskId'],
  additionalProperties: false,
});

export const BUILTIN_TASK_LIST_TOOL_DEFINITION = normalizeToolDefinition({
  name: BUILTIN_TASK_LIST_TOOL.name,
  version: BUILTIN_TASK_LIST_TOOL.version,
  description: 'List current low-sensitive Tasks in the authenticated Project',
  inputSchema: {
    type: 'object',
    properties: {
      after: TASK_LIST_CURSOR_SCHEMA,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: BUILTIN_TASK_LIST_MAX_LIMIT,
      },
    },
    required: [],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        maxItems: BUILTIN_TASK_LIST_MAX_LIMIT,
        items: {
          type: 'object',
          properties: {
            taskId: { type: 'string', minLength: 1, maxLength: 128 },
            revision: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
            name: { type: 'string', minLength: 1, maxLength: 255 },
            kind: {
              type: 'string',
              maxLength: 16,
              enum: TASK_DEFINITION_KINDS,
            },
            specSchema: { type: 'string', minLength: 1, maxLength: 137 },
            enabled: { type: 'boolean' },
            updatedAtMs: {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
          required: [
            'taskId',
            'revision',
            'name',
            'kind',
            'specSchema',
            'enabled',
            'updatedAtMs',
          ],
          additionalProperties: false,
        },
      },
      hasMore: { type: 'boolean' },
      next: TASK_LIST_CURSOR_SCHEMA,
    },
    required: ['tasks', 'hasMore'],
    additionalProperties: false,
  },
  effect: 'read',
  risk: 'low',
  requiredPermissions: ['task.read'],
  timeoutSeconds: BUILTIN_TASK_LIST_TIMEOUT_SECONDS,
});

export class InvalidBuiltInTaskListToolError extends TypeError {
  readonly code = 'BUILTIN_TASK_LIST_TOOL_INVALID';

  constructor(message: string) {
    super(`Built-in Task list Tool is invalid: ${message}`);
    this.name = 'InvalidBuiltInTaskListToolError';
  }
}

export class BuiltInTaskListToolUnavailableError extends Error {
  readonly code = 'BUILTIN_TASK_LIST_TOOL_UNAVAILABLE';

  constructor() {
    super('Built-in Task list Tool is unavailable');
    this.name = 'BuiltInTaskListToolUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidBuiltInTaskListToolError(message);
}

export async function executeBuiltInTaskListTool(
  source: Pick<TaskDefinitionSource, 'listTaskDefinitions'>,
  projectId: string,
  input: ToolJsonValue,
): Promise<Readonly<Record<string, ToolJsonValue>>> {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Readonly<Record<string, ToolJsonValue>>)
      : null;
  if (!record) return invalid('execution context or input is invalid');
  try {
    const result = await executeBoundedTaskListProjection(
      source,
      projectId,
      record,
    );
    return Object.freeze({
      tasks: Object.freeze(
        result.tasks.map((task) => Object.freeze({ ...task })),
      ),
      hasMore: result.hasMore,
      ...(result.next === undefined
        ? {}
        : { next: Object.freeze({ ...result.next }) }),
    });
  } catch (error) {
    if (error instanceof InvalidBoundedTaskListProjectionError) {
      return invalid('execution context or input is invalid');
    }
    if (error instanceof BoundedTaskListProjectionUnavailableError) {
      throw new BuiltInTaskListToolUnavailableError();
    }
    throw error;
  }
}

import {
  TASK_DEFINITION_KINDS,
  type TaskDefinitionSource,
} from '@qinglong/runtime-core/task-definition';
import {
  BoundedTaskReadProjectionUnavailableError,
  InvalidBoundedTaskReadProjectionError,
  executeBoundedTaskReadProjection,
} from '@qinglong/runtime-core/bounded-task-read-projection';
import {
  normalizeToolDefinition,
  type ToolJsonValue,
} from '@qinglong/runtime-core/tool-registry';

export const BUILTIN_TASK_GET_TOOL = Object.freeze({
  name: 'qinglong.task.get',
  version: '1.0.0',
});
export const BUILTIN_TASK_GET_TIMEOUT_SECONDS = 5;

export const BUILTIN_TASK_GET_TOOL_DEFINITION = normalizeToolDefinition({
  name: BUILTIN_TASK_GET_TOOL.name,
  version: BUILTIN_TASK_GET_TOOL.version,
  description: 'Read one current low-sensitive Task and its immutable fence',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', minLength: 1, maxLength: 128 },
    },
    required: ['taskId'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      taskId: { type: 'string', minLength: 1, maxLength: 128 },
      revision: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
      name: { type: 'string', minLength: 1, maxLength: 255 },
      kind: { type: 'string', maxLength: 16, enum: TASK_DEFINITION_KINDS },
      specSchema: { type: 'string', minLength: 1, maxLength: 137 },
      enabled: { type: 'boolean' },
      contentDigest: { type: 'string', minLength: 64, maxLength: 64 },
      createdAtMs: {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      updatedAtMs: {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
    },
    required: ['found'],
    additionalProperties: false,
  },
  effect: 'read',
  risk: 'low',
  requiredPermissions: ['task.read'],
  timeoutSeconds: BUILTIN_TASK_GET_TIMEOUT_SECONDS,
});

export class InvalidBuiltInTaskGetToolError extends TypeError {
  readonly code = 'BUILTIN_TASK_GET_TOOL_INVALID';

  constructor() {
    super('Built-in Task get Tool input is invalid');
    this.name = 'InvalidBuiltInTaskGetToolError';
  }
}

export class BuiltInTaskGetToolUnavailableError extends Error {
  readonly code = 'BUILTIN_TASK_GET_TOOL_UNAVAILABLE';

  constructor() {
    super('Built-in Task get Tool is unavailable');
    this.name = 'BuiltInTaskGetToolUnavailableError';
  }
}

export async function executeBuiltInTaskGetTool(
  source: Pick<TaskDefinitionSource, 'findCurrentTaskDefinition'>,
  projectId: string,
  input: ToolJsonValue,
): Promise<Readonly<Record<string, ToolJsonValue>>> {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Readonly<Record<string, ToolJsonValue>>)
      : null;
  if (
    !record ||
    Reflect.ownKeys(record).length !== 1 ||
    !Object.hasOwn(record, 'taskId') ||
    typeof record.taskId !== 'string'
  ) {
    throw new InvalidBuiltInTaskGetToolError();
  }
  try {
    return await executeBoundedTaskReadProjection(
      source,
      projectId,
      record.taskId,
    );
  } catch (error) {
    if (error instanceof InvalidBoundedTaskReadProjectionError) {
      throw new InvalidBuiltInTaskGetToolError();
    }
    if (error instanceof BoundedTaskReadProjectionUnavailableError) {
      throw new BuiltInTaskGetToolUnavailableError();
    }
    throw error;
  }
}

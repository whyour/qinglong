import { RUN_EVENT_ACTOR_TYPES } from '@qinglong/runtime-core/run';
import type { RunRepositoryReader } from '@qinglong/runtime-core/run-repository';
import {
  BoundedRunEventListProjectionUnavailableError,
  DEFAULT_BOUNDED_RUN_EVENT_LIST_LIMIT,
  InvalidBoundedRunEventListProjectionError,
  MAX_BOUNDED_RUN_EVENT_LIST_LIMIT,
  executeBoundedRunEventListProjection,
} from '@qinglong/runtime-core/bounded-run-event-list-projection';
import {
  normalizeToolDefinition,
  type ToolJsonValue,
} from '@qinglong/runtime-core/tool-registry';

export const BUILTIN_RUN_EVENT_LIST_TOOL = Object.freeze({
  name: 'qinglong.run.events.list',
  version: '1.0.0',
});
export const BUILTIN_RUN_EVENT_LIST_TIMEOUT_SECONDS = 5;
export const BUILTIN_RUN_EVENT_LIST_DEFAULT_LIMIT =
  DEFAULT_BOUNDED_RUN_EVENT_LIST_LIMIT;
export const BUILTIN_RUN_EVENT_LIST_MAX_LIMIT =
  MAX_BOUNDED_RUN_EVENT_LIST_LIMIT;

const MAX_INT = 2_147_483_647;

export const BUILTIN_RUN_EVENT_LIST_TOOL_DEFINITION = normalizeToolDefinition({
  name: BUILTIN_RUN_EVENT_LIST_TOOL.name,
  version: BUILTIN_RUN_EVENT_LIST_TOOL.version,
  description: 'List bounded low-sensitive events for one Project-scoped Run',
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', minLength: 1, maxLength: 128 },
      afterSequence: { type: 'integer', minimum: 0, maximum: MAX_INT },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: BUILTIN_RUN_EVENT_LIST_MAX_LIMIT,
      },
    },
    required: ['runId'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      events: {
        type: 'array',
        maxItems: BUILTIN_RUN_EVENT_LIST_MAX_LIMIT,
        items: {
          type: 'object',
          properties: {
            sequence: { type: 'integer', minimum: 0, maximum: MAX_INT },
            type: { type: 'string', minLength: 1, maxLength: 128 },
            actorType: {
              type: 'string',
              maxLength: 32,
              enum: RUN_EVENT_ACTOR_TYPES,
            },
            createdAtMs: {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
          required: ['sequence', 'type', 'actorType', 'createdAtMs'],
          additionalProperties: false,
        },
      },
      hasMore: { type: 'boolean' },
      nextAfterSequence: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_INT,
      },
    },
    required: ['found', 'events', 'hasMore', 'nextAfterSequence'],
    additionalProperties: false,
  },
  effect: 'read',
  risk: 'low',
  requiredPermissions: ['run.read'],
  timeoutSeconds: BUILTIN_RUN_EVENT_LIST_TIMEOUT_SECONDS,
});

export class InvalidBuiltInRunEventListToolError extends TypeError {
  readonly code = 'BUILTIN_RUN_EVENT_LIST_TOOL_INVALID';

  constructor(message: string) {
    super(`Built-in Run event list Tool is invalid: ${message}`);
    this.name = 'InvalidBuiltInRunEventListToolError';
  }
}

export class BuiltInRunEventListToolUnavailableError extends Error {
  readonly code = 'BUILTIN_RUN_EVENT_LIST_TOOL_UNAVAILABLE';

  constructor() {
    super('Built-in Run event list Tool is unavailable');
    this.name = 'BuiltInRunEventListToolUnavailableError';
  }
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function invalid(message: string): never {
  throw new InvalidBuiltInRunEventListToolError(message);
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

export async function executeBuiltInRunEventListTool(
  runs: Pick<RunRepositoryReader, 'findRunById' | 'listEvents'>,
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
    typeof runs.findRunById !== 'function' ||
    typeof runs.listEvents !== 'function' ||
    !boundedText(projectId, 128) ||
    !inputRecord ||
    inputKeys.length < 1 ||
    inputKeys.length > 3 ||
    inputKeys.some(
      (key) => key !== 'runId' && key !== 'afterSequence' && key !== 'limit',
    ) ||
    !Object.hasOwn(inputRecord, 'runId') ||
    !boundedText(inputRecord.runId, 128) ||
    (inputRecord.afterSequence !== undefined &&
      !integer(inputRecord.afterSequence, 0, MAX_INT)) ||
    (inputRecord.limit !== undefined &&
      !integer(inputRecord.limit, 1, BUILTIN_RUN_EVENT_LIST_MAX_LIMIT))
  ) {
    return invalid('execution context or input is invalid');
  }
  const runId = inputRecord.runId;
  const afterSequence = inputRecord.afterSequence ?? 0;
  const limit = inputRecord.limit ?? BUILTIN_RUN_EVENT_LIST_DEFAULT_LIMIT;
  try {
    const projection = await executeBoundedRunEventListProjection(
      runs,
      projectId,
      runId,
      { afterSequence, limit },
    );
    return Object.freeze({
      found: projection.found,
      events: Object.freeze(
        projection.events.map((event) =>
          Object.freeze({
            sequence: event.sequence,
            type: event.type,
            actorType: event.actorType,
            createdAtMs: event.createdAtMs,
          }),
        ),
      ),
      hasMore: projection.hasMore,
      nextAfterSequence: projection.nextAfterSequence,
    });
  } catch (error) {
    if (error instanceof InvalidBoundedRunEventListProjectionError) {
      return invalid('execution context or input is invalid');
    }
    if (error instanceof BoundedRunEventListProjectionUnavailableError) {
      throw new BuiltInRunEventListToolUnavailableError();
    }
    throw new BuiltInRunEventListToolUnavailableError();
  }
}

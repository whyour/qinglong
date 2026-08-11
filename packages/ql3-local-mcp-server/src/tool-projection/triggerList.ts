import type {
  TriggerCursor,
  TriggerRecord,
  TriggerSource,
} from '@qinglong/runtime-core/trigger';
import {
  normalizeToolDefinition,
  type ToolJsonValue,
} from '@qinglong/runtime-core/tool-registry';

export const BUILTIN_TRIGGER_LIST_TOOL = Object.freeze({
  name: 'qinglong.trigger.list',
  version: '1.0.0',
});
export const BUILTIN_TRIGGER_LIST_TIMEOUT_SECONDS = 5;
export const BUILTIN_TRIGGER_LIST_DEFAULT_LIMIT = 32;
export const BUILTIN_TRIGGER_LIST_MAX_LIMIT = 64;

const MAX_INT = 2_147_483_647;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const TRIGGER_SPEC_SCHEMA_PATTERN =
  /^[a-z][a-z0-9.-]{0,63}\/[a-z][a-z0-9.-]{0,63}@v[1-9][0-9]{0,5}$/;

const TRIGGER_LIST_CURSOR_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    triggerId: { type: 'string', minLength: 1, maxLength: 128 },
  },
  required: ['triggerId'],
  additionalProperties: false,
});

export const BUILTIN_TRIGGER_LIST_TOOL_DEFINITION = normalizeToolDefinition({
  name: BUILTIN_TRIGGER_LIST_TOOL.name,
  version: BUILTIN_TRIGGER_LIST_TOOL.version,
  description:
    'List current low-sensitive Triggers in the authenticated Project',
  inputSchema: {
    type: 'object',
    properties: {
      after: TRIGGER_LIST_CURSOR_SCHEMA,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: BUILTIN_TRIGGER_LIST_MAX_LIMIT,
      },
    },
    required: [],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      triggers: {
        type: 'array',
        maxItems: BUILTIN_TRIGGER_LIST_MAX_LIMIT,
        items: {
          type: 'object',
          properties: {
            triggerId: { type: 'string', minLength: 1, maxLength: 128 },
            revision: { type: 'integer', minimum: 1, maximum: MAX_INT },
            taskId: { type: 'string', minLength: 1, maxLength: 128 },
            taskRevision: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_INT,
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
            'triggerId',
            'revision',
            'taskId',
            'taskRevision',
            'specSchema',
            'enabled',
            'updatedAtMs',
          ],
          additionalProperties: false,
        },
      },
      hasMore: { type: 'boolean' },
      next: TRIGGER_LIST_CURSOR_SCHEMA,
    },
    required: ['triggers', 'hasMore'],
    additionalProperties: false,
  },
  effect: 'read',
  risk: 'low',
  requiredPermissions: ['trigger.read'],
  timeoutSeconds: BUILTIN_TRIGGER_LIST_TIMEOUT_SECONDS,
});

export class InvalidBuiltInTriggerListToolError extends TypeError {
  readonly code = 'BUILTIN_TRIGGER_LIST_TOOL_INVALID';

  constructor(message: string) {
    super(`Built-in Trigger list Tool is invalid: ${message}`);
    this.name = 'InvalidBuiltInTriggerListToolError';
  }
}

export class BuiltInTriggerListToolUnavailableError extends Error {
  readonly code = 'BUILTIN_TRIGGER_LIST_TOOL_UNAVAILABLE';

  constructor() {
    super('Built-in Trigger list Tool is unavailable');
    this.name = 'BuiltInTriggerListToolUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidBuiltInTriggerListToolError(message);
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

function cursor(value: ToolJsonValue | undefined): TriggerCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('cursor is invalid');
  }
  const record = value as Readonly<Record<string, ToolJsonValue>>;
  if (
    Reflect.ownKeys(record).length !== 1 ||
    !Object.hasOwn(record, 'triggerId') ||
    !boundedText(record.triggerId, 128)
  ) {
    return invalid('cursor is invalid');
  }
  return Object.freeze({ triggerId: record.triggerId });
}

function projectTrigger(
  value: TriggerRecord,
  projectId: string,
  after?: string,
): Readonly<Record<string, ToolJsonValue>> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.projectId !== projectId ||
    (after !== undefined && value.triggerId <= after) ||
    !boundedText(value.triggerId, 128) ||
    !integer(value.revision, 1, MAX_INT) ||
    !boundedText(value.taskId, 128) ||
    !integer(value.taskRevision, 1, MAX_INT) ||
    !boundedText(value.spec?.schema, 137) ||
    !TRIGGER_SPEC_SCHEMA_PATTERN.test(value.spec.schema) ||
    typeof value.enabled !== 'boolean' ||
    !integer(value.updatedAtMs, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  return Object.freeze({
    triggerId: value.triggerId,
    revision: value.revision,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    specSchema: value.spec.schema,
    enabled: value.enabled,
    updatedAtMs: value.updatedAtMs,
  });
}

export async function executeBuiltInTriggerListTool(
  source: Pick<TriggerSource, 'listTriggers'>,
  projectId: string,
  input: ToolJsonValue,
): Promise<Readonly<Record<string, ToolJsonValue>>> {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Readonly<Record<string, ToolJsonValue>>)
      : null;
  const keys = record ? Reflect.ownKeys(record) : [];
  if (
    typeof source?.listTriggers !== 'function' ||
    !boundedText(projectId, 128) ||
    !record ||
    keys.length > 2 ||
    keys.some((key) => key !== 'after' && key !== 'limit') ||
    (record.limit !== undefined &&
      !integer(record.limit, 1, BUILTIN_TRIGGER_LIST_MAX_LIMIT))
  ) {
    return invalid('execution context or input is invalid');
  }
  const after = cursor(record.after);
  const limit = record.limit ?? BUILTIN_TRIGGER_LIST_DEFAULT_LIMIT;
  let page;
  try {
    page = await source.listTriggers({
      projectId,
      limit,
      ...(after ? { after } : {}),
    });
  } catch {
    throw new BuiltInTriggerListToolUnavailableError();
  }
  if (
    !page ||
    !Array.isArray(page.triggers) ||
    page.triggers.length > limit ||
    typeof page.truncated !== 'boolean' ||
    page.truncated !== Boolean(page.next)
  ) {
    throw new BuiltInTriggerListToolUnavailableError();
  }
  const triggers: Readonly<Record<string, ToolJsonValue>>[] = [];
  let boundary = after?.triggerId;
  for (const trigger of page.triggers) {
    const projected = projectTrigger(trigger, projectId, boundary);
    if (!projected) throw new BuiltInTriggerListToolUnavailableError();
    triggers.push(projected);
    boundary = trigger.triggerId;
  }
  if (
    page.truncated &&
    (!page.next ||
      Reflect.ownKeys(page.next).length !== 1 ||
      !boundedText(page.next.triggerId, 128) ||
      page.next.triggerId !== boundary ||
      triggers.length === 0)
  ) {
    throw new BuiltInTriggerListToolUnavailableError();
  }
  return Object.freeze({
    triggers: Object.freeze(triggers),
    hasMore: page.truncated,
    ...(page.truncated ? { next: Object.freeze({ triggerId: boundary! }) } : {}),
  });
}

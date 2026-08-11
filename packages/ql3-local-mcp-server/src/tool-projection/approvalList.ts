import {
  APPROVAL_DECISION_MODES,
  APPROVAL_REQUEST_STATES,
  APPROVAL_RISKS,
  normalizeApprovalRequestRecord,
  type ApprovalRequestRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  approvalRequestUpdatedAtMs,
  type ApprovalRequestCursor,
  type ApprovalRequestSource,
} from '@qinglong/runtime-core/approval-discovery';
import { SECURITY_SUBJECT_TYPES } from '@qinglong/runtime-core/security';
import { normalizeProjectPermission } from '@qinglong/runtime-core/project-policy';
import {
  normalizeToolDefinition,
  type ToolJsonValue,
} from '@qinglong/runtime-core/tool-registry';

export const BUILTIN_APPROVAL_LIST_TOOL = Object.freeze({
  name: 'qinglong.approval.list',
  version: '1.0.0',
});
export const BUILTIN_APPROVAL_LIST_TIMEOUT_SECONDS = 5;
export const BUILTIN_APPROVAL_LIST_DEFAULT_LIMIT = 32;
export const BUILTIN_APPROVAL_LIST_MAX_LIMIT = 64;

const MAX_INT = 2_147_483_647;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

const APPROVAL_LIST_CURSOR_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    updatedAtMs: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    requestId: { type: 'string', minLength: 1, maxLength: 128 },
  },
  required: ['updatedAtMs', 'requestId'],
  additionalProperties: false,
});

export const BUILTIN_APPROVAL_LIST_TOOL_DEFINITION = normalizeToolDefinition({
  name: BUILTIN_APPROVAL_LIST_TOOL.name,
  version: BUILTIN_APPROVAL_LIST_TOOL.version,
  description:
    'List recent low-sensitive Approval requests in the authenticated Project',
  inputSchema: {
    type: 'object',
    properties: {
      after: APPROVAL_LIST_CURSOR_SCHEMA,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: BUILTIN_APPROVAL_LIST_MAX_LIMIT,
      },
    },
    required: [],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      approvals: {
        type: 'array',
        maxItems: BUILTIN_APPROVAL_LIST_MAX_LIMIT,
        items: {
          type: 'object',
          properties: {
            requestId: { type: 'string', minLength: 1, maxLength: 128 },
            version: { type: 'integer', minimum: 1, maximum: MAX_INT },
            state: {
              type: 'string',
              maxLength: 32,
              enum: [...APPROVAL_REQUEST_STATES],
            },
            risk: {
              type: 'string',
              maxLength: 32,
              enum: [...APPROVAL_RISKS],
            },
            decisionMode: {
              type: 'string',
              maxLength: 32,
              enum: [...APPROVAL_DECISION_MODES],
            },
            permission: { type: 'string', minLength: 1, maxLength: 255 },
            actionType: { type: 'string', minLength: 1, maxLength: 128 },
            requestedByType: {
              type: 'string',
              maxLength: 32,
              enum: [...SECURITY_SUBJECT_TYPES],
            },
            requestedAtMs: {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            expiresAtMs: {
              type: 'integer',
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            decidedAtMs: {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            consumedAtMs: {
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
          required: [
            'requestId',
            'version',
            'state',
            'risk',
            'decisionMode',
            'permission',
            'actionType',
            'requestedByType',
            'requestedAtMs',
            'expiresAtMs',
            'updatedAtMs',
          ],
          additionalProperties: false,
        },
      },
      hasMore: { type: 'boolean' },
      next: APPROVAL_LIST_CURSOR_SCHEMA,
    },
    required: ['approvals', 'hasMore'],
    additionalProperties: false,
  },
  effect: 'read',
  risk: 'low',
  requiredPermissions: ['approval.read'],
  timeoutSeconds: BUILTIN_APPROVAL_LIST_TIMEOUT_SECONDS,
});

export class InvalidBuiltInApprovalListToolError extends TypeError {
  readonly code = 'BUILTIN_APPROVAL_LIST_TOOL_INVALID';

  constructor(message: string) {
    super(`Built-in Approval list Tool is invalid: ${message}`);
    this.name = 'InvalidBuiltInApprovalListToolError';
  }
}

export class BuiltInApprovalListToolUnavailableError extends Error {
  readonly code = 'BUILTIN_APPROVAL_LIST_TOOL_UNAVAILABLE';

  constructor() {
    super('Built-in Approval list Tool is unavailable');
    this.name = 'BuiltInApprovalListToolUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidBuiltInApprovalListToolError(message);
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

function cursor(value: ToolJsonValue | undefined): ApprovalRequestCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('cursor is invalid');
  }
  const record = value as Readonly<Record<string, ToolJsonValue>>;
  if (
    Reflect.ownKeys(record).length !== 2 ||
    !Object.hasOwn(record, 'updatedAtMs') ||
    !Object.hasOwn(record, 'requestId') ||
    !integer(record.updatedAtMs, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedText(record.requestId, 128)
  ) {
    return invalid('cursor is invalid');
  }
  return Object.freeze({
    updatedAtMs: record.updatedAtMs,
    requestId: record.requestId,
  });
}

function before(
  updatedAtMs: number,
  requestId: string,
  boundary?: Readonly<ApprovalRequestCursor>,
): boolean {
  return (
    !boundary ||
    updatedAtMs < boundary.updatedAtMs ||
    (updatedAtMs === boundary.updatedAtMs && requestId < boundary.requestId)
  );
}

function projectApproval(
  value: Readonly<ApprovalRequestRecord>,
  projectId: string,
  boundary?: Readonly<ApprovalRequestCursor>,
): Readonly<Record<string, ToolJsonValue>> | null {
  let request: Readonly<ApprovalRequestRecord>;
  let permission: string;
  let updatedAtMs: number;
  try {
    request = normalizeApprovalRequestRecord(value);
    permission = normalizeProjectPermission(request.action.permission);
    updatedAtMs = approvalRequestUpdatedAtMs(request);
  } catch {
    return null;
  }
  if (
    request.projectId !== projectId ||
    !boundedText(request.id, 128) ||
    !before(updatedAtMs, request.id, boundary) ||
    !integer(request.version, 1, MAX_INT) ||
    !APPROVAL_REQUEST_STATES.includes(request.state) ||
    !APPROVAL_RISKS.includes(request.risk) ||
    !APPROVAL_DECISION_MODES.includes(request.decisionMode) ||
    !boundedText(permission, 255) ||
    !boundedText(request.action.actionType, 128) ||
    !SECURITY_SUBJECT_TYPES.includes(request.requestedBy.type) ||
    !integer(request.requestedAtMs, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(request.expiresAtMs, 1, Number.MAX_SAFE_INTEGER) ||
    (request.decidedAtMs !== null &&
      !integer(request.decidedAtMs, 0, Number.MAX_SAFE_INTEGER)) ||
    (request.consumedAtMs !== null &&
      !integer(request.consumedAtMs, 0, Number.MAX_SAFE_INTEGER))
  ) {
    return null;
  }
  return Object.freeze({
    requestId: request.id,
    version: request.version,
    state: request.state,
    risk: request.risk,
    decisionMode: request.decisionMode,
    permission,
    actionType: request.action.actionType,
    requestedByType: request.requestedBy.type,
    requestedAtMs: request.requestedAtMs,
    expiresAtMs: request.expiresAtMs,
    ...(request.decidedAtMs === null
      ? {}
      : { decidedAtMs: request.decidedAtMs }),
    ...(request.consumedAtMs === null
      ? {}
      : { consumedAtMs: request.consumedAtMs }),
    updatedAtMs,
  });
}

export async function executeBuiltInApprovalListTool(
  source: Pick<ApprovalRequestSource, 'listApprovalRequests'>,
  projectId: string,
  input: ToolJsonValue,
): Promise<Readonly<Record<string, ToolJsonValue>>> {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Readonly<Record<string, ToolJsonValue>>)
      : null;
  const keys = record ? Reflect.ownKeys(record) : [];
  if (
    typeof source?.listApprovalRequests !== 'function' ||
    !boundedText(projectId, 128) ||
    !record ||
    keys.length > 2 ||
    keys.some((key) => key !== 'after' && key !== 'limit') ||
    (record.limit !== undefined &&
      !integer(record.limit, 1, BUILTIN_APPROVAL_LIST_MAX_LIMIT))
  ) {
    return invalid('execution context or input is invalid');
  }
  const after = cursor(record.after);
  const limit = record.limit ?? BUILTIN_APPROVAL_LIST_DEFAULT_LIMIT;
  let page;
  try {
    page = await source.listApprovalRequests({
      projectId,
      limit,
      ...(after ? { after } : {}),
    });
  } catch {
    throw new BuiltInApprovalListToolUnavailableError();
  }
  if (
    !page ||
    !Array.isArray(page.requests) ||
    page.requests.length > limit ||
    typeof page.truncated !== 'boolean' ||
    page.truncated !== Boolean(page.next)
  ) {
    throw new BuiltInApprovalListToolUnavailableError();
  }
  const approvals: Readonly<Record<string, ToolJsonValue>>[] = [];
  let boundary = after;
  for (const request of page.requests) {
    const projected = projectApproval(request, projectId, boundary);
    if (!projected) throw new BuiltInApprovalListToolUnavailableError();
    approvals.push(projected);
    boundary = Object.freeze({
      updatedAtMs: projected.updatedAtMs as number,
      requestId: projected.requestId as string,
    });
  }
  if (
    page.truncated &&
    (!page.next ||
      Reflect.ownKeys(page.next).length !== 2 ||
      !boundary ||
      page.next.updatedAtMs !== boundary.updatedAtMs ||
      page.next.requestId !== boundary.requestId ||
      approvals.length === 0)
  ) {
    throw new BuiltInApprovalListToolUnavailableError();
  }
  return Object.freeze({
    approvals: Object.freeze(approvals),
    hasMore: page.truncated,
    ...(page.truncated ? { next: Object.freeze({ ...boundary! }) } : {}),
  });
}

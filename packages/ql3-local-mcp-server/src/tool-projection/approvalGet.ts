import {
  APPROVAL_DECISION_MODES,
  APPROVAL_REQUEST_STATES,
  APPROVAL_RISKS,
  normalizeApprovalRequestRecord,
} from '@qinglong/runtime-core/approved-action';
import type {
  ApprovalRequestDetailSource,
} from '@qinglong/runtime-core/approval-discovery';
import {
  normalizeApprovalDetailPreview,
} from '@qinglong/runtime-core/approval-discovery';
import { normalizeProjectPermission } from '@qinglong/runtime-core/project-policy';
import { SECURITY_SUBJECT_TYPES } from '@qinglong/runtime-core/security';
import {
  normalizeToolDefinition,
  type ToolJsonValue,
} from '@qinglong/runtime-core/tool-registry';

export const BUILTIN_APPROVAL_GET_TOOL = Object.freeze({
  name: 'qinglong.approval.get',
  version: '1.0.0',
});
export const BUILTIN_APPROVAL_GET_TIMEOUT_SECONDS = 5;

const MAX_INT = 2_147_483_647;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PREVIEW_FIELD_KINDS = ['count', 'identifier', 'redacted', 'text'] as const;

const PREVIEW_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 256 },
    summary: { type: 'string', minLength: 1, maxLength: 2048 },
    fields: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            maxLength: 16,
            enum: [...PREVIEW_FIELD_KINDS],
          },
          label: { type: 'string', minLength: 1, maxLength: 128 },
          value: { type: 'string', minLength: 1, maxLength: 512 },
        },
        required: ['kind', 'label'],
        additionalProperties: false,
      },
    },
    warnings: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 64 },
    },
  },
  required: ['title', 'summary', 'fields', 'warnings'],
  additionalProperties: false,
});

export const BUILTIN_APPROVAL_GET_TOOL_DEFINITION = normalizeToolDefinition({
  name: BUILTIN_APPROVAL_GET_TOOL.name,
  version: BUILTIN_APPROVAL_GET_TOOL.version,
  description:
    'Get one Approval and its bounded redacted Tool preview in the authenticated Project',
  inputSchema: {
    type: 'object',
    properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 },
    },
    required: ['requestId'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      approval: {
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
          previewAvailable: { type: 'boolean' },
          preview: PREVIEW_SCHEMA,
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
          'previewAvailable',
        ],
        additionalProperties: false,
      },
    },
    required: ['found'],
    additionalProperties: false,
  },
  effect: 'read',
  risk: 'low',
  requiredPermissions: ['approval.read', 'artifact.read'],
  timeoutSeconds: BUILTIN_APPROVAL_GET_TIMEOUT_SECONDS,
});

export class InvalidBuiltInApprovalGetToolError extends TypeError {
  readonly code = 'BUILTIN_APPROVAL_GET_TOOL_INVALID';

  constructor(message: string) {
    super(`Built-in Approval get Tool is invalid: ${message}`);
    this.name = 'InvalidBuiltInApprovalGetToolError';
  }
}

export class BuiltInApprovalGetToolUnavailableError extends Error {
  readonly code = 'BUILTIN_APPROVAL_GET_TOOL_UNAVAILABLE';

  constructor() {
    super('Built-in Approval get Tool is unavailable');
    this.name = 'BuiltInApprovalGetToolUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidBuiltInApprovalGetToolError(message);
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    !CONTROL_PATTERN.test(value)
  );
}

export async function executeBuiltInApprovalGetTool(
  source: Pick<ApprovalRequestDetailSource, 'getApprovalRequestDetail'>,
  projectId: string,
  input: ToolJsonValue,
): Promise<Readonly<Record<string, ToolJsonValue>>> {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Readonly<Record<string, ToolJsonValue>>)
      : null;
  if (
    typeof source?.getApprovalRequestDetail !== 'function' ||
    !boundedText(projectId, 128) ||
    !record ||
    Reflect.ownKeys(record).length !== 1 ||
    !Object.hasOwn(record, 'requestId') ||
    !boundedText(record.requestId, 128)
  ) {
    return invalid('execution context or input is invalid');
  }
  let detail;
  try {
    detail = await source.getApprovalRequestDetail({
      projectId,
      requestId: record.requestId,
    });
  } catch {
    throw new BuiltInApprovalGetToolUnavailableError();
  }
  if (!detail) return Object.freeze({ found: false });
  try {
    if (
      typeof detail !== 'object' ||
      Array.isArray(detail) ||
      Reflect.ownKeys(detail).length !== 2 ||
      !Object.hasOwn(detail, 'request') ||
      !Object.hasOwn(detail, 'preview')
    ) {
      throw new BuiltInApprovalGetToolUnavailableError();
    }
    const request = normalizeApprovalRequestRecord(detail.request);
    const preview = detail.preview
      ? normalizeApprovalDetailPreview(detail.preview)
      : null;
    const permission = normalizeProjectPermission(request.action.permission);
    if (
      request.projectId !== projectId ||
      request.id !== record.requestId ||
      (preview !== null && request.action.actionType !== 'tool.invoke')
    ) {
      throw new BuiltInApprovalGetToolUnavailableError();
    }
    return Object.freeze({
      found: true,
      approval: Object.freeze({
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
        previewAvailable: preview !== null,
        ...(preview === null
          ? {}
          : {
              preview: Object.freeze({
                title: preview.title,
                summary: preview.summary,
                fields: Object.freeze(
                  preview.fields.map((field) =>
                    Object.freeze({
                      kind: field.kind,
                      label: field.label,
                      ...(field.value === null ? {} : { value: field.value }),
                    }),
                  ),
                ),
                warnings: Object.freeze([...preview.warnings]),
              }),
            }),
      }),
    });
  } catch (error) {
    if (error instanceof BuiltInApprovalGetToolUnavailableError) throw error;
    throw new BuiltInApprovalGetToolUnavailableError();
  }
}

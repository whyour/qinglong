import type { ProjectPermission } from '../../security/project-policy/projectPolicy';
import type {
  SecurityPolicyDecision,
  SecurityPolicyFence,
  SecurityPrincipal,
  SecuritySubject,
} from '../../security/security';

export const TOOL_INVOCATION_SCHEMA = 'qinglong/tool-invocation@v1';
export const MAX_TOOL_DEFINITIONS = 128;
export const MAX_TOOL_REQUIRED_PERMISSIONS = 16;
export const MAX_TOOL_SCHEMA_DEPTH = 8;
export const MAX_TOOL_SCHEMA_NODES = 256;
export const MAX_TOOL_SCHEMA_PROPERTIES = 64;
export const MAX_TOOL_SCHEMA_ENUM_VALUES = 64;
export const MAX_TOOL_ARRAY_ITEMS = 256;
export const MAX_TOOL_INPUT_BYTES = 64 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
export const MAX_TOOL_TIMEOUT_SECONDS = 60 * 60;

export const TOOL_EFFECTS = ['read', 'write', 'execute', 'external'] as const;
export const TOOL_RISKS = ['low', 'medium', 'high', 'critical'] as const;
export const TOOL_JSON_SCHEMA_TYPES = [
  'null',
  'boolean',
  'string',
  'number',
  'integer',
  'array',
  'object',
] as const;

export type ToolEffect = (typeof TOOL_EFFECTS)[number];
export type ToolRisk = (typeof TOOL_RISKS)[number];
export type ToolJsonSchemaType = (typeof TOOL_JSON_SCHEMA_TYPES)[number];
export type ToolInvocationStatus = 'ready' | 'approval_required';
export type ToolJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ToolJsonValue[]
  | Readonly<{ [key: string]: ToolJsonValue }>;

export type ToolJsonSchema =
  | Readonly<{ type: 'null' }>
  | Readonly<{ type: 'boolean' }>
  | Readonly<{
      type: 'string';
      minLength?: number;
      maxLength: number;
      enum?: readonly string[];
    }>
  | Readonly<{
      type: 'number';
      minimum: number;
      maximum: number;
    }>
  | Readonly<{
      type: 'integer';
      minimum: number;
      maximum: number;
    }>
  | Readonly<{
      type: 'array';
      items: ToolJsonSchema;
      minItems?: number;
      maxItems: number;
      uniqueItems?: boolean;
    }>
  | Readonly<{
      type: 'object';
      properties: Readonly<Record<string, ToolJsonSchema>>;
      required: readonly string[];
      additionalProperties: false;
    }>;

export interface ToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: ToolJsonSchema;
  readonly outputSchema?: ToolJsonSchema;
  readonly effect: ToolEffect;
  readonly risk: ToolRisk;
  readonly requiredPermissions: readonly ProjectPermission[];
  readonly timeoutSeconds: number;
}

export interface ToolPolicyAuthorizer {
  authorize(
    principal: Readonly<SecurityPrincipal>,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<SecurityPolicyDecision>;
}

export interface ToolInvocationRequest {
  readonly projectId: string;
  readonly principal: SecurityPrincipal;
  readonly nowMs: number;
  readonly tool: Readonly<{ name: string; version: string }>;
  readonly input: unknown;
}

export interface DeniedToolInvocation {
  readonly status: 'denied';
  readonly tool: Readonly<{ name: string; version: string }>;
  readonly permission: ProjectPermission;
}

export interface PreparedToolInvocation {
  readonly status: ToolInvocationStatus;
  readonly schema: typeof TOOL_INVOCATION_SCHEMA;
  readonly projectId: string;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly tool: Readonly<{ name: string; version: string }>;
  readonly permission: ProjectPermission;
  readonly requiredPermissions: readonly ProjectPermission[];
  readonly effect: ToolEffect;
  readonly risk: ToolRisk;
  readonly timeoutSeconds: number;
  readonly fence: Readonly<SecurityPolicyFence>;
  readonly input: ToolJsonValue;
  readonly inputDigest: string;
  readonly actionDigest: string;
}

export type ToolInvocationPlan =
  | Readonly<DeniedToolInvocation>
  | Readonly<PreparedToolInvocation>;

export class InvalidToolDefinitionError extends TypeError {
  readonly code = 'TOOL_DEFINITION_INVALID';

  constructor(message: string) {
    super(`Tool definition is invalid: ${message}`);
    this.name = 'InvalidToolDefinitionError';
  }
}

export class InvalidToolJsonValueError extends TypeError {
  readonly code = 'TOOL_JSON_VALUE_INVALID';

  constructor(message: string) {
    super(`Tool JSON value is invalid: ${message}`);
    this.name = 'InvalidToolJsonValueError';
  }
}

export class UnsupportedToolError extends Error {
  readonly code = 'TOOL_UNSUPPORTED';

  constructor() {
    super('Tool is not registered');
    this.name = 'UnsupportedToolError';
  }
}

export class ToolPolicyUnavailableError extends Error {
  readonly code = 'TOOL_POLICY_UNAVAILABLE';

  constructor() {
    super('Tool policy authorization is unavailable');
    this.name = 'ToolPolicyUnavailableError';
  }
}

export class ToolPolicySnapshotConflictError extends Error {
  readonly code = 'TOOL_POLICY_SNAPSHOT_CONFLICT';

  constructor() {
    super('Tool permissions were not authorized by one policy snapshot');
    this.name = 'ToolPolicySnapshotConflictError';
  }
}

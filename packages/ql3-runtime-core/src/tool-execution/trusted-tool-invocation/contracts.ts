import type { ApprovedActionDispatchRecord } from '../../approved-action/approvedAction';
import type { DeploymentProfile } from '../../cluster-control/clusterControlActivation';
import type { ProjectPermission } from '../../security/project-policy/projectPolicy';
import type {
  SecurityPolicyFence,
  SecurityPrincipal,
  SecuritySubject,
} from '../../security/security';
import type {
  ToolEffect,
  ToolInvocationStatus,
  ToolPolicyAuthorizer,
  ToolRisk,
} from '../tool-registry/toolRegistry';
import type {
  ToolInvocationInputArtifact,
  ToolInvocationInputArtifactReference,
  ToolInvocationPreviewArtifact,
  ToolInvocationPreviewArtifactReference,
} from '../toolInvocationArtifact';

export const TRUSTED_TOOL_HANDLER_BINDING_SCHEMA =
  'qinglong/trusted-tool-handler-binding@v1' as const;
export const TRUSTED_TOOL_INVOCATION_PLAN_SCHEMA =
  'qinglong/trusted-tool-invocation-plan@v1' as const;
export const TRUSTED_TOOL_EXECUTION_ADMISSION_SCHEMA =
  'qinglong/trusted-tool-execution-admission@v1' as const;
export const TOOL_INVOKE_ACTION_TYPE = 'tool.invoke' as const;

export const TRUSTED_TOOL_EXECUTION_CLASSES = [
  'builtin_in_process',
  'isolated_process',
  'remote_worker',
  'mcp_client',
  'http_connector',
] as const;
export const TRUSTED_TOOL_HANDLER_AUTHORITIES = [
  'artifact.read',
  'artifact.write',
  'database.read',
  'database.write',
  'filesystem.read',
  'filesystem.write',
  'mcp.call',
  'model.invoke',
  'network.connect',
  'process.spawn',
  'run.control',
  'secret.use',
] as const;
export const TRUSTED_TOOL_PREVIEW_FIELD_KINDS = [
  'count',
  'identifier',
  'redacted',
  'text',
] as const;
export const TRUSTED_TOOL_DEPLOYMENT_PROFILES = [
  'edge',
  'standalone',
  'cluster-control',
  'worker',
] as const satisfies readonly DeploymentProfile[];

export const MAX_TRUSTED_TOOL_HANDLER_BINDINGS = 128;
export const MAX_TRUSTED_TOOL_HANDLER_AUTHORITIES = 16;
export const MAX_TRUSTED_TOOL_PREVIEW_FIELDS = 16;
export const MAX_TRUSTED_TOOL_PREVIEW_WARNINGS = 8;

export type TrustedToolExecutionClass =
  (typeof TRUSTED_TOOL_EXECUTION_CLASSES)[number];
export type TrustedToolHandlerAuthority =
  (typeof TRUSTED_TOOL_HANDLER_AUTHORITIES)[number];
export type TrustedToolPreviewFieldKind =
  (typeof TRUSTED_TOOL_PREVIEW_FIELD_KINDS)[number];

export interface TrustedToolContractIdentity {
  readonly id: string;
  readonly version: string;
}

export interface CreateTrustedToolHandlerBindingInput {
  readonly tool: Readonly<{ name: string; version: string }>;
  readonly adapter: TrustedToolContractIdentity;
  readonly executionClass: TrustedToolExecutionClass;
  readonly profiles: readonly DeploymentProfile[];
  readonly authorities: readonly TrustedToolHandlerAuthority[];
  readonly timeoutSeconds: number;
  readonly redactionContract: TrustedToolContractIdentity;
  readonly auditContract: TrustedToolContractIdentity;
}

export interface TrustedToolHandlerBinding
  extends CreateTrustedToolHandlerBindingInput {
  readonly schema: typeof TRUSTED_TOOL_HANDLER_BINDING_SCHEMA;
  readonly snapshotDigest: string;
  readonly definitionDigest: string;
  readonly bindingDigest: string;
}

export interface TrustedToolInvocationPreviewField {
  readonly kind: TrustedToolPreviewFieldKind;
  readonly label: string;
  readonly value: string | null;
}

export interface TrustedToolInvocationPreview {
  readonly title: string;
  readonly summary: string;
  readonly fields: readonly Readonly<TrustedToolInvocationPreviewField>[];
  readonly warnings: readonly string[];
}

export interface TrustedToolInvocationPlan {
  readonly schema: typeof TRUSTED_TOOL_INVOCATION_PLAN_SCHEMA;
  readonly status: ToolInvocationStatus;
  readonly actionType: typeof TOOL_INVOKE_ACTION_TYPE;
  readonly actionRef: string;
  readonly projectId: string;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly tool: Readonly<{ name: string; version: string }>;
  readonly permission: ProjectPermission;
  readonly requiredPermissions: readonly ProjectPermission[];
  readonly effect: ToolEffect;
  readonly risk: ToolRisk;
  readonly policyFence: Readonly<SecurityPolicyFence>;
  readonly profile: DeploymentProfile;
  readonly snapshotDigest: string;
  readonly definitionDigest: string;
  readonly binding: Readonly<TrustedToolHandlerBinding>;
  readonly timeoutSeconds: number;
  readonly invocationArtifact: Readonly<ToolInvocationInputArtifactReference>;
  readonly invocationActionDigest: string;
  readonly previewArtifact: Readonly<ToolInvocationPreviewArtifactReference>;
  readonly actionDigest: string;
  readonly sealedAtMs: number;
  readonly planDigest: string;
}

export interface TrustedToolInvocationPlanBundle {
  readonly plan: Readonly<TrustedToolInvocationPlan>;
  readonly inputArtifact: Readonly<ToolInvocationInputArtifact>;
  readonly previewArtifact: Readonly<ToolInvocationPreviewArtifact>;
}

export interface ToolExecutionStartEvidence {
  readonly stepRun: Readonly<{
    id: string;
    version: number;
    digest: string;
  }>;
  readonly trace: Readonly<{
    traceId: string;
    spanId: string;
    digest: string;
  }>;
  readonly audit: Readonly<{
    eventId: string;
    digest: string;
  }>;
}

export interface TrustedToolExecutionAdmission {
  readonly schema: typeof TRUSTED_TOOL_EXECUTION_ADMISSION_SCHEMA;
  readonly actionRef: string;
  readonly planDigest: string;
  readonly actionDigest: string;
  readonly projectId: string;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly tool: Readonly<{ name: string; version: string }>;
  readonly profile: DeploymentProfile;
  readonly snapshotDigest: string;
  readonly definitionDigest: string;
  readonly bindingDigest: string;
  readonly invocationArtifact: Readonly<ToolInvocationInputArtifactReference>;
  readonly previewArtifact: Readonly<ToolInvocationPreviewArtifactReference>;
  readonly adapter: Readonly<TrustedToolContractIdentity>;
  readonly redactionContract: Readonly<TrustedToolContractIdentity>;
  readonly auditContract: Readonly<TrustedToolContractIdentity>;
  readonly executionClass: TrustedToolExecutionClass;
  readonly timeoutSeconds: number;
  readonly policyFence: Readonly<SecurityPolicyFence>;
  readonly approvalRequestId: string | null;
  readonly approvalDispatchId: string | null;
  readonly approvalDispatchDigest: string | null;
  readonly evidence: Readonly<ToolExecutionStartEvidence>;
  readonly admittedAtMs: number;
  readonly admissionDigest: string;
}

export interface AdmitTrustedToolExecutionInput {
  readonly principal: SecurityPrincipal;
  readonly profile: DeploymentProfile;
  readonly nowMs: number;
  readonly authorizer: ToolPolicyAuthorizer;
  readonly evidence: ToolExecutionStartEvidence;
  readonly dispatch?: ApprovedActionDispatchRecord;
}

export class InvalidTrustedToolInvocationError extends TypeError {
  readonly code = 'TRUSTED_TOOL_INVOCATION_INVALID';

  constructor(message: string) {
    super(`Trusted Tool invocation is invalid: ${message}`);
    this.name = 'InvalidTrustedToolInvocationError';
  }
}

export class TrustedToolHandlerUnavailableError extends Error {
  readonly code = 'TRUSTED_TOOL_HANDLER_UNAVAILABLE';

  constructor() {
    super('No exact trusted Tool handler binding is available');
    this.name = 'TrustedToolHandlerUnavailableError';
  }
}

export class TrustedToolInvocationBindingConflictError extends Error {
  readonly code = 'TRUSTED_TOOL_INVOCATION_BINDING_CONFLICT';

  constructor() {
    super('Trusted Tool invocation binding changed');
    this.name = 'TrustedToolInvocationBindingConflictError';
  }
}

export class TrustedToolExecutionPolicyDeniedError extends Error {
  readonly code = 'TRUSTED_TOOL_EXECUTION_POLICY_DENIED';

  constructor() {
    super('Current Project Policy denies Tool execution');
    this.name = 'TrustedToolExecutionPolicyDeniedError';
  }
}

export class TrustedToolExecutionApprovalRequiredError extends Error {
  readonly code = 'TRUSTED_TOOL_EXECUTION_APPROVAL_REQUIRED';

  constructor() {
    super('Current Project Policy requires a new Tool approval');
    this.name = 'TrustedToolExecutionApprovalRequiredError';
  }
}

export class TrustedToolExecutionPolicyUnavailableError extends Error {
  readonly code = 'TRUSTED_TOOL_EXECUTION_POLICY_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Current Project Policy is unavailable for Tool execution', options);
    this.name = 'TrustedToolExecutionPolicyUnavailableError';
  }
}

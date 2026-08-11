import {
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionBinding,
  type ApprovedActionDispatchRecord,
} from '../../approved-action/approvedAction';
import type { DeploymentProfile } from '../../cluster-control/clusterControlActivation';
import {
  assertProjectPolicyProjectId,
  normalizeProjectPermission,
  normalizeProjectPolicySubject,
  type ProjectPermission,
} from '../../security/project-policy/projectPolicy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '../../security/security';
import {
  TOOL_INVOCATION_SCHEMA,
  ToolDefinitionRegistry,
  type PreparedToolInvocation,
} from '../tool-registry/toolRegistry';
import {
  createToolInvocationInputArtifact,
  createToolInvocationPreviewArtifact,
  normalizeToolInvocationInputArtifactReference,
  normalizeToolInvocationPreviewArtifactReference,
  toolInvocationInputArtifactReference,
  toolInvocationPreviewArtifactReference,
} from '../toolInvocationArtifact';
import {
  TrustedToolHandlerBindingRegistry,
  normalizeTrustedToolHandlerBinding,
} from './binding';
import {
  ACTION_DIGEST_DOMAIN,
  PLAN_DIGEST_DOMAIN,
  WARNING_PATTERN,
  boundedText,
  dataRecord,
  digest,
  exactKeys,
  hash,
  identifier,
  invalid,
  normalizeFence,
  normalizeProfile,
  normalizeToolIdentity,
  positiveInteger,
  sameSubject,
  timestamp,
  trustedToolContractIdentityDigest,
} from './codec';
import {
  MAX_TRUSTED_TOOL_PREVIEW_FIELDS,
  MAX_TRUSTED_TOOL_PREVIEW_WARNINGS,
  TOOL_INVOKE_ACTION_TYPE,
  TRUSTED_TOOL_INVOCATION_PLAN_SCHEMA,
  TRUSTED_TOOL_PREVIEW_FIELD_KINDS,
  TrustedToolExecutionApprovalRequiredError,
  TrustedToolInvocationBindingConflictError,
  type TrustedToolInvocationPlan,
  type TrustedToolInvocationPlanBundle,
  type TrustedToolInvocationPreview,
  type TrustedToolInvocationPreviewField,
} from './contracts';

function normalizePreviewField(
  value: TrustedToolInvocationPreviewField,
): Readonly<TrustedToolInvocationPreviewField> {
  const record = dataRecord(value, 'preview field');
  exactKeys(record, ['kind', 'label', 'value'], [], 'preview field');
  if (!TRUSTED_TOOL_PREVIEW_FIELD_KINDS.includes(value.kind)) {
    return invalid('preview field kind is invalid');
  }
  const label = boundedText(value.label, 128, 'preview field label');
  if (
    (value.kind === 'redacted' && value.value !== null) ||
    (value.kind !== 'redacted' && value.value === null)
  ) {
    return invalid('preview field redaction is invalid');
  }
  const normalizedValue =
    value.value === null
      ? null
      : boundedText(value.value, 512, 'preview field value');
  return Object.freeze({ kind: value.kind, label, value: normalizedValue });
}

export function normalizeTrustedToolInvocationPreview(
  value: TrustedToolInvocationPreview,
): Readonly<TrustedToolInvocationPreview> {
  const record = dataRecord(value, 'preview');
  exactKeys(record, ['fields', 'summary', 'title', 'warnings'], [], 'preview');
  if (
    !Array.isArray(value.fields) ||
    value.fields.length > MAX_TRUSTED_TOOL_PREVIEW_FIELDS ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > MAX_TRUSTED_TOOL_PREVIEW_WARNINGS
  ) {
    return invalid('preview collections are invalid');
  }
  const fields = value.fields.map(normalizePreviewField);
  const warnings = value.warnings.map((warning) => {
    if (typeof warning !== 'string' || !WARNING_PATTERN.test(warning)) {
      return invalid('preview warning is invalid');
    }
    return warning;
  });
  if (new Set(warnings).size !== warnings.length) {
    return invalid('preview warnings are duplicated');
  }
  return Object.freeze({
    title: boundedText(value.title, 256, 'preview title'),
    summary: boundedText(value.summary, 2048, 'preview summary'),
    fields: Object.freeze(fields),
    warnings: Object.freeze([...warnings].sort()),
  });
}

function normalizePermissions(
  value: readonly ProjectPermission[],
  label: string,
): readonly ProjectPermission[] {
  if (!Array.isArray(value) || value.length > 16) {
    return invalid(`${label} are invalid`);
  }
  const permissions = value.map((permission) => {
    try {
      return normalizeProjectPermission(permission);
    } catch {
      return invalid(`${label} are invalid`);
    }
  });
  if (
    new Set(permissions).size !== permissions.length ||
    permissions.some((permission) => permission.startsWith('tool.call:'))
  ) {
    return invalid(`${label} are duplicated or nested`);
  }
  return Object.freeze([...permissions].sort());
}

function normalizePreparedInvocation(
  value: PreparedToolInvocation,
  registry: ToolDefinitionRegistry,
): Readonly<PreparedToolInvocation> {
  const record = dataRecord(value, 'prepared invocation');
  exactKeys(
    record,
    [
      'actionDigest',
      'effect',
      'fence',
      'input',
      'inputDigest',
      'permission',
      'projectId',
      'requestedBy',
      'requiredPermissions',
      'risk',
      'schema',
      'status',
      'timeoutSeconds',
      'tool',
    ],
    [],
    'prepared invocation',
  );
  if (
    value.schema !== TOOL_INVOCATION_SCHEMA ||
    (value.status !== 'ready' && value.status !== 'approval_required')
  ) {
    return invalid('prepared invocation schema or status is invalid');
  }
  assertProjectPolicyProjectId(value.projectId);
  const requestedBy = normalizeProjectPolicySubject(value.requestedBy);
  const tool = normalizeToolIdentity(value.tool, 'prepared Tool');
  const definition = registry.resolve(tool.name, tool.version);
  const permission = normalizeProjectPermission(value.permission);
  const expectedPermission = normalizeProjectPermission(
    `tool.call:${definition.name}`,
  );
  const requiredPermissions = normalizePermissions(
    value.requiredPermissions,
    'prepared required permissions',
  );
  if (
    permission !== expectedPermission ||
    JSON.stringify(requiredPermissions) !==
      JSON.stringify(definition.requiredPermissions) ||
    value.effect !== definition.effect ||
    value.risk !== definition.risk ||
    value.timeoutSeconds !== definition.timeoutSeconds
  ) {
    return invalid('prepared invocation drifts from its Tool definition');
  }
  const input = registry.normalizeInput(tool.name, tool.version, value.input);
  const inputDigest = digest(value.inputDigest, 'input digest');
  if (hash(Buffer.alloc(0), input) !== inputDigest) {
    return invalid('prepared invocation input digest does not match');
  }
  const fence = normalizeFence(value.fence);
  const actionDigest = digest(value.actionDigest, 'invocation action digest');
  const expectedActionDigest = hash(Buffer.alloc(0), {
    schema: TOOL_INVOCATION_SCHEMA,
    projectId: value.projectId,
    requestedBy,
    tool,
    permission,
    requiredPermissions,
    effect: definition.effect,
    risk: definition.risk,
    timeoutSeconds: definition.timeoutSeconds,
    inputDigest,
  });
  if (actionDigest !== expectedActionDigest) {
    return invalid('prepared invocation action digest does not match');
  }
  return Object.freeze({
    status: value.status,
    schema: TOOL_INVOCATION_SCHEMA,
    projectId: value.projectId,
    requestedBy,
    tool,
    permission,
    requiredPermissions,
    effect: definition.effect,
    risk: definition.risk,
    timeoutSeconds: definition.timeoutSeconds,
    fence,
    input,
    inputDigest,
    actionDigest,
  });
}

function actionFields(
  value: Omit<
    TrustedToolInvocationPlan,
    'actionDigest' | 'planDigest' | 'previewArtifact'
  >,
): object {
  return {
    schema: value.schema,
    status: value.status,
    actionType: value.actionType,
    actionRef: value.actionRef,
    projectId: value.projectId,
    requestedBy: value.requestedBy,
    tool: value.tool,
    permission: value.permission,
    requiredPermissions: value.requiredPermissions,
    effect: value.effect,
    risk: value.risk,
    policyFence: value.policyFence,
    profile: value.profile,
    snapshotDigest: value.snapshotDigest,
    definitionDigest: value.definitionDigest,
    bindingDigest: value.binding.bindingDigest,
    timeoutSeconds: value.timeoutSeconds,
    invocationArtifact: value.invocationArtifact,
    invocationActionDigest: value.invocationActionDigest,
  };
}

function planWithoutDigest(
  value: Readonly<TrustedToolInvocationPlan>,
): Omit<TrustedToolInvocationPlan, 'planDigest'> {
  const { planDigest: _planDigest, ...unsigned } = value;
  return unsigned;
}

export function createTrustedToolInvocationPlan(
  bindings: TrustedToolHandlerBindingRegistry,
  invocationValue: PreparedToolInvocation,
  inputValue: Readonly<{
    actionRef: string;
    profile: DeploymentProfile;
    preview: TrustedToolInvocationPreview;
    inputArtifactId: string;
    previewArtifactId: string;
    artifactKeyId: string;
    artifactKey: Uint8Array;
    artifactNonce: Uint8Array;
    sealedAtMs: number;
  }>,
): Readonly<TrustedToolInvocationPlanBundle> {
  if (!(bindings instanceof TrustedToolHandlerBindingRegistry)) {
    return invalid('handler binding registry is invalid');
  }
  const input = dataRecord(inputValue, 'plan input');
  exactKeys(
    input,
    [
      'actionRef',
      'artifactKey',
      'artifactKeyId',
      'artifactNonce',
      'inputArtifactId',
      'preview',
      'previewArtifactId',
      'profile',
      'sealedAtMs',
    ],
    [],
    'plan input',
  );
  const definitionRegistry = bindings.definitionRegistry();
  const invocation = normalizePreparedInvocation(
    invocationValue,
    definitionRegistry,
  );
  if (invocation.projectId !== bindings.projectId) {
    throw new TrustedToolInvocationBindingConflictError();
  }
  const profile = normalizeProfile(inputValue.profile);
  const binding = bindings.resolve(
    invocation.tool.name,
    invocation.tool.version,
    profile,
  );
  const preview = normalizeTrustedToolInvocationPreview(inputValue.preview);
  const sealedAtMs = timestamp(inputValue.sealedAtMs, 'plan seal time');
  const normalizedActionRef = identifier(
    inputValue.actionRef,
    'action reference',
  );
  const inputArtifact = createToolInvocationInputArtifact(
    {
      artifactId: inputValue.inputArtifactId,
      projectId: invocation.projectId,
      actionRef: normalizedActionRef,
      requestedBy: invocation.requestedBy,
      tool: invocation.tool,
      input: invocation.input,
      inputDigest: invocation.inputDigest,
      invocationActionDigest: invocation.actionDigest,
      keyId: inputValue.artifactKeyId,
      key: inputValue.artifactKey,
      sealedAtMs,
    },
    () => inputValue.artifactNonce,
  );
  const invocationArtifact =
    toolInvocationInputArtifactReference(inputArtifact);
  const base = Object.freeze({
    schema: TRUSTED_TOOL_INVOCATION_PLAN_SCHEMA,
    status: invocation.status,
    actionType: TOOL_INVOKE_ACTION_TYPE,
    actionRef: normalizedActionRef,
    projectId: invocation.projectId,
    requestedBy: invocation.requestedBy,
    tool: invocation.tool,
    permission: invocation.permission,
    requiredPermissions: invocation.requiredPermissions,
    effect: invocation.effect,
    risk: invocation.risk,
    policyFence: invocation.fence,
    profile,
    snapshotDigest: bindings.snapshotDigest,
    definitionDigest: binding.definitionDigest,
    binding,
    timeoutSeconds: Math.min(invocation.timeoutSeconds, binding.timeoutSeconds),
    invocationArtifact,
    invocationActionDigest: invocation.actionDigest,
    sealedAtMs,
  } satisfies Omit<TrustedToolInvocationPlan, 'actionDigest' | 'planDigest' | 'previewArtifact'>);
  const actionDigest = hash(ACTION_DIGEST_DOMAIN, actionFields(base));
  const previewArtifact = createToolInvocationPreviewArtifact({
    artifactId: inputValue.previewArtifactId,
    projectId: invocation.projectId,
    actionRef: normalizedActionRef,
    actionDigest,
    preview,
    redactionContractDigest: trustedToolContractIdentityDigest(
      binding.redactionContract,
    ),
    sealedAtMs,
  });
  const previewArtifactReference =
    toolInvocationPreviewArtifactReference(previewArtifact);
  const unsigned = Object.freeze({
    ...base,
    previewArtifact: previewArtifactReference,
    actionDigest,
  });
  const plan = Object.freeze({
    ...unsigned,
    planDigest: hash(PLAN_DIGEST_DOMAIN, unsigned),
  });
  return Object.freeze({
    plan,
    inputArtifact,
    previewArtifact,
  });
}

export function normalizeTrustedToolInvocationPlan(
  value: TrustedToolInvocationPlan,
  bindings: TrustedToolHandlerBindingRegistry,
): Readonly<TrustedToolInvocationPlan> {
  if (!(bindings instanceof TrustedToolHandlerBindingRegistry)) {
    return invalid('handler binding registry is invalid');
  }
  const record = dataRecord(value, 'trusted invocation plan');
  exactKeys(
    record,
    [
      'actionRef',
      'actionDigest',
      'actionType',
      'binding',
      'definitionDigest',
      'effect',
      'invocationArtifact',
      'invocationActionDigest',
      'permission',
      'planDigest',
      'policyFence',
      'previewArtifact',
      'profile',
      'projectId',
      'requestedBy',
      'requiredPermissions',
      'risk',
      'schema',
      'sealedAtMs',
      'snapshotDigest',
      'status',
      'timeoutSeconds',
      'tool',
    ],
    [],
    'trusted invocation plan',
  );
  if (
    value.schema !== TRUSTED_TOOL_INVOCATION_PLAN_SCHEMA ||
    value.actionType !== TOOL_INVOKE_ACTION_TYPE ||
    (value.status !== 'ready' && value.status !== 'approval_required')
  ) {
    return invalid('trusted invocation plan schema or status is invalid');
  }
  assertProjectPolicyProjectId(value.projectId);
  const requestedBy = normalizeProjectPolicySubject(value.requestedBy);
  const tool = normalizeToolIdentity(value.tool, 'trusted plan Tool');
  const profile = normalizeProfile(value.profile);
  const currentBinding = bindings.resolve(tool.name, tool.version, profile);
  const binding = normalizeTrustedToolHandlerBinding(value.binding);
  if (
    value.projectId !== bindings.projectId ||
    digest(value.snapshotDigest, 'snapshot digest') !==
      bindings.snapshotDigest ||
    binding.bindingDigest !== currentBinding.bindingDigest ||
    digest(value.definitionDigest, 'definition digest') !==
      binding.definitionDigest
  ) {
    throw new TrustedToolInvocationBindingConflictError();
  }
  const definitionRegistry = bindings.definitionRegistry();
  const definition = definitionRegistry.resolve(tool.name, tool.version);
  const permission = normalizeProjectPermission(value.permission);
  const requiredPermissions = normalizePermissions(
    value.requiredPermissions,
    'trusted plan required permissions',
  );
  const policyFence = normalizeFence(value.policyFence);
  const invocationArtifact = normalizeToolInvocationInputArtifactReference(
    value.invocationArtifact,
  );
  const invocationActionDigest = digest(
    value.invocationActionDigest,
    'invocation action digest',
  );
  const expectedInvocationActionDigest = hash(Buffer.alloc(0), {
    schema: TOOL_INVOCATION_SCHEMA,
    projectId: value.projectId,
    requestedBy,
    tool,
    permission,
    requiredPermissions,
    effect: definition.effect,
    risk: definition.risk,
    timeoutSeconds: definition.timeoutSeconds,
    inputDigest: invocationArtifact.inputDigest,
  });
  if (
    permission !== normalizeProjectPermission(`tool.call:${definition.name}`) ||
    JSON.stringify(requiredPermissions) !==
      JSON.stringify(definition.requiredPermissions) ||
    value.effect !== definition.effect ||
    value.risk !== definition.risk ||
    invocationActionDigest !== expectedInvocationActionDigest
  ) {
    return invalid('trusted invocation plan drifts from its Tool definition');
  }
  const timeoutSeconds = positiveInteger(
    value.timeoutSeconds,
    definition.timeoutSeconds,
    'trusted plan timeout',
  );
  if (
    timeoutSeconds !==
    Math.min(definition.timeoutSeconds, binding.timeoutSeconds)
  ) {
    return invalid('trusted plan timeout does not match its binding');
  }
  const previewArtifact = normalizeToolInvocationPreviewArtifactReference(
    value.previewArtifact,
  );
  if (
    previewArtifact.redactionContractDigest !==
    trustedToolContractIdentityDigest(binding.redactionContract)
  ) {
    return invalid(
      'trusted preview Artifact redaction contract does not match',
    );
  }
  const base = Object.freeze({
    schema: TRUSTED_TOOL_INVOCATION_PLAN_SCHEMA,
    status: value.status,
    actionType: TOOL_INVOKE_ACTION_TYPE,
    actionRef: identifier(value.actionRef, 'action reference'),
    projectId: value.projectId,
    requestedBy,
    tool,
    permission,
    requiredPermissions,
    effect: definition.effect,
    risk: definition.risk,
    policyFence,
    profile,
    snapshotDigest: bindings.snapshotDigest,
    definitionDigest: binding.definitionDigest,
    binding,
    timeoutSeconds,
    invocationArtifact,
    invocationActionDigest,
    sealedAtMs: timestamp(value.sealedAtMs, 'plan seal time'),
  } satisfies Omit<TrustedToolInvocationPlan, 'actionDigest' | 'planDigest' | 'previewArtifact'>);
  const actionDigest = digest(value.actionDigest, 'action digest');
  const expectedActionDigest = hash(ACTION_DIGEST_DOMAIN, actionFields(base));
  if (
    actionDigest !== expectedActionDigest ||
    previewArtifact.actionDigest !== actionDigest
  ) {
    return invalid('trusted invocation action digest does not match');
  }
  const unsigned = Object.freeze({
    ...base,
    previewArtifact,
    actionDigest,
  });
  const planDigest = digest(value.planDigest, 'plan digest');
  if (hash(PLAN_DIGEST_DOMAIN, unsigned) !== planDigest) {
    return invalid('trusted invocation plan digest does not match');
  }
  return Object.freeze({ ...unsigned, planDigest });
}

export function trustedToolInvocationApprovalBinding(
  planValue: TrustedToolInvocationPlan,
  bindings: TrustedToolHandlerBindingRegistry,
): Readonly<ApprovedActionBinding> {
  const plan = normalizeTrustedToolInvocationPlan(planValue, bindings);
  if (plan.status !== 'approval_required') {
    throw new TrustedToolExecutionApprovalRequiredError();
  }
  return Object.freeze({
    permission: plan.permission,
    actionType: TOOL_INVOKE_ACTION_TYPE,
    actionRef: plan.actionRef,
    actionDigest: plan.actionDigest,
    previewDigest: plan.previewArtifact.previewDigest,
  });
}

export function assertTrustedToolApprovedDispatch(
  planValue: TrustedToolInvocationPlan,
  bindings: TrustedToolHandlerBindingRegistry,
  dispatchValue: ApprovedActionDispatchRecord,
): Readonly<ApprovedActionDispatchRecord> {
  const plan = normalizeTrustedToolInvocationPlan(planValue, bindings);
  if (plan.status !== 'approval_required') {
    throw new TrustedToolInvocationBindingConflictError();
  }
  const dispatch = normalizeApprovedActionDispatchRecord(dispatchValue);
  const expected = trustedToolInvocationApprovalBinding(plan, bindings);
  if (
    dispatch.projectId !== plan.projectId ||
    !sameSubject(dispatch.requestedBy, plan.requestedBy) ||
    dispatch.action.permission !== expected.permission ||
    dispatch.action.actionType !== expected.actionType ||
    dispatch.action.actionRef !== expected.actionRef ||
    dispatch.action.actionDigest !== expected.actionDigest ||
    dispatch.action.previewDigest !== expected.previewDigest ||
    dispatch.createdAtMs < plan.sealedAtMs
  ) {
    throw new TrustedToolInvocationBindingConflictError();
  }
  return dispatch;
}

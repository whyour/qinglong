import {
  BUILTIN_RUN_LOG_EXCERPT_ADAPTER,
  BUILTIN_RUN_LOG_EXCERPT_AUDIT_CONTRACT,
  BUILTIN_RUN_LOG_EXCERPT_REDACTION_CONTRACT,
  BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS,
  BUILTIN_RUN_LOG_EXCERPT_TOOL,
} from '@qinglong/runtime-core/builtin-run-log-excerpt-tool';
import { normalizeTrustedToolInvocationPlan } from '@qinglong/runtime-core/trusted-tool-invocation';

import {
  COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_SCHEMA,
  MAX_COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_BYTES,
  type CopilotFailureDiagnosisExecutionPlan,
  type CopilotFailureDiagnosisToolIntent,
  type PrepareCopilotFailureDiagnosisExecutionInput,
} from './contracts';
import {
  assertDeadline,
  assertJsonBudget,
  dataRecord,
  digest,
  exactKeys,
  failureDiagnosisToolInputDigest,
  hash,
  identity,
  invalid,
  normalizeFence,
  normalizeModelIntent,
  normalizeProjectPolicySubject,
  normalizeSourceFence,
  normalizeToolIntent,
  prepareModelIntent,
  runIdentity,
  sameFence,
  sameSubject,
  timestamp,
} from './validation';

const PLAN_DIGEST_DOMAIN =
  'qinglong/copilot-failure-diagnosis-execution-plan-digest@v1\0';
const IDENTITY_DOMAIN =
  'qinglong/copilot-failure-diagnosis-execution-identity@v1\0';

function executionIdentity(
  prefix: 'cdr' | 'cdt' | 'cdm' | 'cdi',
  value: Readonly<{
    requestId: string;
    projectId: string;
    sourceRunId: string;
    sourceAttemptId: string;
    toolPlanDigest: string;
  }>,
): string {
  return `${prefix}:${hash(IDENTITY_DOMAIN, { prefix, ...value }).slice(
    0,
    32,
  )}`;
}

function sameContract(
  left: Readonly<{ id: string; version: string }>,
  right: Readonly<{ id: string; version: string }>,
): boolean {
  return left.id === right.id && left.version === right.version;
}

function planFields(
  value: Omit<CopilotFailureDiagnosisExecutionPlan, 'planDigest'>,
): object {
  return {
    schema: value.schema,
    requestId: value.requestId,
    runId: value.runId,
    toolStepRunId: value.toolStepRunId,
    modelStepRunId: value.modelStepRunId,
    modelInvocationId: value.modelInvocationId,
    traceId: value.traceId,
    projectId: value.projectId,
    requestedBySubject: value.requestedBySubject,
    policyFence: value.policyFence,
    source: value.source,
    tool: value.tool,
    model: value.model,
    deadlineAtMs: value.deadlineAtMs,
    plannedAtMs: value.plannedAtMs,
  };
}

export function copilotFailureDiagnosisExecutionPlanDigest(
  value: Omit<CopilotFailureDiagnosisExecutionPlan, 'planDigest'>,
): string {
  return hash(PLAN_DIGEST_DOMAIN, planFields(value));
}

function expectedIdentities(
  value: Readonly<{
    requestId: string;
    projectId: string;
    sourceRunId: string;
    sourceAttemptId: string;
    toolPlanDigest: string;
  }>,
): Readonly<{
  runId: string;
  toolStepRunId: string;
  modelStepRunId: string;
  modelInvocationId: string;
}> {
  return Object.freeze({
    runId: executionIdentity('cdr', value),
    toolStepRunId: executionIdentity('cdt', value),
    modelStepRunId: executionIdentity('cdm', value),
    modelInvocationId: executionIdentity('cdi', value),
  });
}

export function normalizeCopilotFailureDiagnosisExecutionPlan(
  value: CopilotFailureDiagnosisExecutionPlan,
): Readonly<CopilotFailureDiagnosisExecutionPlan> {
  const candidate = dataRecord(value, 'execution plan');
  exactKeys(
    candidate,
    [
      'deadlineAtMs',
      'model',
      'modelInvocationId',
      'modelStepRunId',
      'planDigest',
      'plannedAtMs',
      'policyFence',
      'projectId',
      'requestId',
      'requestedBySubject',
      'runId',
      'schema',
      'source',
      'tool',
      'toolStepRunId',
      'traceId',
    ],
    'execution plan',
  );
  if (candidate.schema !== COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_SCHEMA) {
    return invalid('execution plan schema is unsupported');
  }
  const requestId = identity(candidate.requestId, 'request id');
  const projectId = identity(candidate.projectId, 'project id');
  const source = normalizeSourceFence(candidate.source);
  const tool = normalizeToolIntent(candidate.tool);
  const model = normalizeModelIntent(candidate.model);
  if (
    tool.invocationArtifact.inputDigest !==
    failureDiagnosisToolInputDigest(source)
  ) {
    return invalid('Tool input is not bound to the source Run Attempt');
  }
  const plannedAtMs = timestamp(candidate.plannedAtMs, 'planned time');
  const deadlineAtMs = timestamp(candidate.deadlineAtMs, 'deadline');
  assertDeadline(plannedAtMs, deadlineAtMs);
  if (tool.sealedAtMs > plannedAtMs) {
    return invalid('Tool plan was sealed after diagnosis planning');
  }
  const identityInput = Object.freeze({
    requestId,
    projectId,
    sourceRunId: source.runId,
    sourceAttemptId: source.attemptId,
    toolPlanDigest: tool.planDigest,
  });
  const identities = expectedIdentities(identityInput);
  const unsigned = Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_SCHEMA,
    requestId,
    runId: runIdentity(candidate.runId, 'diagnosis Run id'),
    toolStepRunId: identity(candidate.toolStepRunId, 'Tool StepRun id'),
    modelStepRunId: identity(candidate.modelStepRunId, 'model StepRun id'),
    modelInvocationId: identity(
      candidate.modelInvocationId,
      'model invocation id',
    ),
    traceId: identity(candidate.traceId, 'trace id'),
    projectId,
    requestedBySubject: normalizeProjectPolicySubject(
      candidate.requestedBySubject as never,
    ),
    policyFence: normalizeFence(candidate.policyFence),
    source,
    tool,
    model,
    deadlineAtMs,
    plannedAtMs,
  } satisfies Omit<CopilotFailureDiagnosisExecutionPlan, 'planDigest'>);
  if (
    unsigned.runId !== identities.runId ||
    unsigned.toolStepRunId !== identities.toolStepRunId ||
    unsigned.modelStepRunId !== identities.modelStepRunId ||
    unsigned.modelInvocationId !== identities.modelInvocationId
  ) {
    return invalid('execution identities are invalid');
  }
  const planDigest = digest(candidate.planDigest, 'plan digest');
  if (copilotFailureDiagnosisExecutionPlanDigest(unsigned) !== planDigest) {
    return invalid('plan digest does not match');
  }
  const normalized = Object.freeze({ ...unsigned, planDigest });
  assertJsonBudget(
    normalized,
    MAX_COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_BYTES,
    'execution plan',
  );
  return normalized;
}

export function prepareCopilotFailureDiagnosisExecution(
  inputValue: PrepareCopilotFailureDiagnosisExecutionInput,
): Readonly<CopilotFailureDiagnosisExecutionPlan> {
  const input = dataRecord(inputValue, 'execution input');
  exactKeys(
    input,
    [
      'bindings',
      'deadlineAtMs',
      'model',
      'plannedAtMs',
      'requestId',
      'source',
      'toolPlan',
      'traceId',
    ],
    'execution input',
  );
  const source = normalizeSourceFence(input.source);
  const toolPlan = normalizeTrustedToolInvocationPlan(
    inputValue.toolPlan,
    inputValue.bindings,
  );
  const binding = toolPlan.binding;
  if (
    toolPlan.status !== 'ready' ||
    toolPlan.profile !== 'cluster-control' ||
    toolPlan.tool.name !== BUILTIN_RUN_LOG_EXCERPT_TOOL.name ||
    toolPlan.tool.version !== BUILTIN_RUN_LOG_EXCERPT_TOOL.version ||
    toolPlan.effect !== 'read' ||
    toolPlan.risk !== 'medium' ||
    toolPlan.permission !== 'tool.call:qinglong.run.log.excerpt' ||
    toolPlan.requiredPermissions.length !== 1 ||
    toolPlan.requiredPermissions[0] !== 'artifact.read' ||
    toolPlan.invocationArtifact.inputDigest !==
      failureDiagnosisToolInputDigest(source) ||
    binding.executionClass !== 'builtin_in_process' ||
    binding.timeoutSeconds !== BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS ||
    !sameContract(binding.adapter, BUILTIN_RUN_LOG_EXCERPT_ADAPTER) ||
    !sameContract(
      binding.redactionContract,
      BUILTIN_RUN_LOG_EXCERPT_REDACTION_CONTRACT,
    ) ||
    !sameContract(binding.auditContract, BUILTIN_RUN_LOG_EXCERPT_AUDIT_CONTRACT)
  ) {
    return invalid('Tool plan is not the exact Cluster Run log excerpt plan');
  }
  const requestId = identity(input.requestId, 'request id');
  const projectId = identity(toolPlan.projectId, 'project id');
  const plannedAtMs = timestamp(input.plannedAtMs, 'planned time');
  const deadlineAtMs = timestamp(input.deadlineAtMs, 'deadline');
  assertDeadline(plannedAtMs, deadlineAtMs);
  if (toolPlan.sealedAtMs > plannedAtMs) {
    return invalid('Tool plan was sealed after diagnosis planning');
  }
  const tool = normalizeToolIntent({
    actionRef: toolPlan.actionRef,
    planDigest: toolPlan.planDigest,
    actionDigest: toolPlan.actionDigest,
    invocationActionDigest: toolPlan.invocationActionDigest,
    snapshotDigest: toolPlan.snapshotDigest,
    definitionDigest: toolPlan.definitionDigest,
    bindingDigest: binding.bindingDigest,
    invocationArtifact: toolPlan.invocationArtifact,
    previewArtifact: toolPlan.previewArtifact,
    sealedAtMs: toolPlan.sealedAtMs,
  } satisfies CopilotFailureDiagnosisToolIntent);
  const model = prepareModelIntent(inputValue.model);
  const identityInput = Object.freeze({
    requestId,
    projectId,
    sourceRunId: source.runId,
    sourceAttemptId: source.attemptId,
    toolPlanDigest: tool.planDigest,
  });
  const identities = expectedIdentities(identityInput);
  const unsigned = Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_SCHEMA,
    requestId,
    ...identities,
    traceId: identity(input.traceId, 'trace id'),
    projectId,
    requestedBySubject: toolPlan.requestedBy,
    policyFence: toolPlan.policyFence,
    source,
    tool,
    model,
    deadlineAtMs,
    plannedAtMs,
  } satisfies Omit<CopilotFailureDiagnosisExecutionPlan, 'planDigest'>);
  const plan = normalizeCopilotFailureDiagnosisExecutionPlan({
    ...unsigned,
    planDigest: copilotFailureDiagnosisExecutionPlanDigest(unsigned),
  });
  if (
    !sameSubject(plan.requestedBySubject, toolPlan.requestedBy) ||
    !sameFence(plan.policyFence, toolPlan.policyFence)
  ) {
    return invalid('Tool authority does not match diagnosis authority');
  }
  return plan;
}

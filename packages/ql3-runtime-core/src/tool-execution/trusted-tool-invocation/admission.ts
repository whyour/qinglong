import {
  approvedActionDispatchDigest,
  type ApprovedActionDispatchRecord,
} from '../../approved-action/approvedAction';
import {
  assertProjectPolicyProjectId,
  normalizeProjectPolicySubject,
} from '../../security/project-policy/projectPolicy';
import {
  normalizeSecurityPolicyDecision,
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPolicyFence,
  type SecurityPrincipal,
} from '../../security/security';
import type { ToolPolicyAuthorizer } from '../tool-registry/toolRegistry';
import {
  normalizeToolInvocationInputArtifactReference,
  normalizeToolInvocationPreviewArtifactReference,
} from '../toolInvocationArtifact';
import { TrustedToolHandlerBindingRegistry } from './binding';
import {
  ADMISSION_DIGEST_DOMAIN,
  dataRecord,
  digest,
  exactKeys,
  hash,
  identifier,
  invalid,
  normalizeContractIdentity,
  normalizeFence,
  normalizeProfile,
  normalizeToolIdentity,
  positiveInteger,
  sameFence,
  sameSubject,
  timestamp,
} from './codec';
import {
  TRUSTED_TOOL_EXECUTION_ADMISSION_SCHEMA,
  TRUSTED_TOOL_EXECUTION_CLASSES,
  TrustedToolExecutionApprovalRequiredError,
  TrustedToolExecutionPolicyDeniedError,
  TrustedToolExecutionPolicyUnavailableError,
  TrustedToolInvocationBindingConflictError,
  type AdmitTrustedToolExecutionInput,
  type ToolExecutionStartEvidence,
  type TrustedToolExecutionAdmission,
  type TrustedToolInvocationPlan,
} from './contracts';
import {
  assertTrustedToolApprovedDispatch,
  normalizeTrustedToolInvocationPlan,
} from './plan';

function normalizeExecutionEvidence(
  value: ToolExecutionStartEvidence,
): Readonly<ToolExecutionStartEvidence> {
  const evidence = dataRecord(value, 'execution evidence');
  exactKeys(evidence, ['audit', 'stepRun', 'trace'], [], 'execution evidence');
  const stepRun = dataRecord(value.stepRun, 'StepRun evidence');
  exactKeys(stepRun, ['digest', 'id', 'version'], [], 'StepRun evidence');
  const trace = dataRecord(value.trace, 'Trace evidence');
  exactKeys(trace, ['digest', 'spanId', 'traceId'], [], 'Trace evidence');
  const audit = dataRecord(value.audit, 'Audit evidence');
  exactKeys(audit, ['digest', 'eventId'], [], 'Audit evidence');
  return Object.freeze({
    stepRun: Object.freeze({
      id: identifier(value.stepRun.id, 'StepRun id'),
      version: positiveInteger(
        value.stepRun.version,
        2_147_483_647,
        'StepRun version',
      ),
      digest: digest(value.stepRun.digest, 'StepRun digest'),
    }),
    trace: Object.freeze({
      traceId: identifier(value.trace.traceId, 'Trace id'),
      spanId: identifier(value.trace.spanId, 'Trace span id'),
      digest: digest(value.trace.digest, 'Trace digest'),
    }),
    audit: Object.freeze({
      eventId: identifier(value.audit.eventId, 'Audit event id'),
      digest: digest(value.audit.digest, 'Audit digest'),
    }),
  });
}

export function normalizeTrustedToolExecutionAdmission(
  value: TrustedToolExecutionAdmission,
): Readonly<TrustedToolExecutionAdmission> {
  const record = dataRecord(value, 'execution admission');
  exactKeys(
    record,
    [
      'actionRef',
      'actionDigest',
      'adapter',
      'admissionDigest',
      'admittedAtMs',
      'approvalRequestId',
      'approvalDispatchDigest',
      'approvalDispatchId',
      'auditContract',
      'bindingDigest',
      'evidence',
      'executionClass',
      'definitionDigest',
      'invocationArtifact',
      'planDigest',
      'policyFence',
      'profile',
      'projectId',
      'previewArtifact',
      'requestedBy',
      'redactionContract',
      'schema',
      'snapshotDigest',
      'timeoutSeconds',
      'tool',
    ],
    [],
    'execution admission',
  );
  if (value.schema !== TRUSTED_TOOL_EXECUTION_ADMISSION_SCHEMA) {
    return invalid('execution admission schema is invalid');
  }
  assertProjectPolicyProjectId(value.projectId);
  const requestedBy = normalizeProjectPolicySubject(value.requestedBy);
  const tool = normalizeToolIdentity(value.tool, 'admitted Tool');
  const profile = normalizeProfile(value.profile);
  const adapter = normalizeContractIdentity(value.adapter, 'admitted adapter');
  if (!TRUSTED_TOOL_EXECUTION_CLASSES.includes(value.executionClass)) {
    return invalid('execution admission class is invalid');
  }
  const approvalDispatchId =
    value.approvalDispatchId === null
      ? null
      : identifier(value.approvalDispatchId, 'approval dispatch id');
  const approvalRequestId =
    value.approvalRequestId === null
      ? null
      : identifier(value.approvalRequestId, 'approval request id');
  const approvalDispatchDigest =
    value.approvalDispatchDigest === null
      ? null
      : digest(value.approvalDispatchDigest, 'approval dispatch digest');
  if (
    (approvalRequestId === null) !== (approvalDispatchId === null) ||
    (approvalDispatchId === null) !== (approvalDispatchDigest === null)
  ) {
    return invalid('execution admission approval binding is incomplete');
  }
  const unsigned = Object.freeze({
    schema: TRUSTED_TOOL_EXECUTION_ADMISSION_SCHEMA,
    actionRef: identifier(value.actionRef, 'admitted action reference'),
    planDigest: digest(value.planDigest, 'admitted plan digest'),
    actionDigest: digest(value.actionDigest, 'admitted action digest'),
    projectId: value.projectId,
    requestedBy,
    tool,
    profile,
    snapshotDigest: digest(value.snapshotDigest, 'admitted snapshot digest'),
    definitionDigest: digest(
      value.definitionDigest,
      'admitted definition digest',
    ),
    bindingDigest: digest(value.bindingDigest, 'admitted binding digest'),
    invocationArtifact: normalizeToolInvocationInputArtifactReference(
      value.invocationArtifact,
    ),
    previewArtifact: normalizeToolInvocationPreviewArtifactReference(
      value.previewArtifact,
    ),
    adapter,
    redactionContract: normalizeContractIdentity(
      value.redactionContract,
      'admitted redaction contract',
    ),
    auditContract: normalizeContractIdentity(
      value.auditContract,
      'admitted audit contract',
    ),
    executionClass: value.executionClass,
    timeoutSeconds: positiveInteger(
      value.timeoutSeconds,
      60 * 60,
      'admitted timeout',
    ),
    policyFence: normalizeFence(value.policyFence),
    approvalRequestId,
    approvalDispatchId,
    approvalDispatchDigest,
    evidence: normalizeExecutionEvidence(value.evidence),
    admittedAtMs: timestamp(value.admittedAtMs, 'admission time'),
  } satisfies Omit<TrustedToolExecutionAdmission, 'admissionDigest'>);
  if (unsigned.previewArtifact.actionDigest !== unsigned.actionDigest) {
    return invalid('execution admission Artifact bindings do not match');
  }
  const admissionDigest = digest(value.admissionDigest, 'admission digest');
  if (hash(ADMISSION_DIGEST_DOMAIN, unsigned) !== admissionDigest) {
    return invalid('execution admission digest does not match');
  }
  return Object.freeze({ ...unsigned, admissionDigest });
}

async function currentPolicyFence(
  plan: Readonly<TrustedToolInvocationPlan>,
  principal: Readonly<SecurityPrincipal>,
  authorizer: ToolPolicyAuthorizer,
): Promise<
  Readonly<{
    fence: Readonly<SecurityPolicyFence>;
    decisions: readonly Readonly<SecurityPolicyDecision>[];
  }>
> {
  if (!authorizer || typeof authorizer.authorize !== 'function') {
    throw new TrustedToolExecutionPolicyUnavailableError();
  }
  const permissions = [plan.permission, ...plan.requiredPermissions];
  const decisions: Readonly<SecurityPolicyDecision>[] = [];
  for (const permission of permissions) {
    let decision: Readonly<SecurityPolicyDecision>;
    try {
      decision = normalizeSecurityPolicyDecision(
        await authorizer.authorize(principal, plan.projectId, permission),
      );
    } catch (cause) {
      throw new TrustedToolExecutionPolicyUnavailableError({ cause });
    }
    if (decision.effect === 'deny') {
      throw new TrustedToolExecutionPolicyDeniedError();
    }
    decisions.push(decision);
  }
  const fence = decisions[0]?.fence;
  if (
    !fence ||
    decisions.some(
      (decision) => !decision.fence || !sameFence(fence, decision.fence),
    )
  ) {
    throw new TrustedToolExecutionPolicyUnavailableError();
  }
  return Object.freeze({
    fence,
    decisions: Object.freeze(decisions),
  });
}

export async function admitTrustedToolExecution(
  bindings: TrustedToolHandlerBindingRegistry,
  planValue: TrustedToolInvocationPlan,
  inputValue: AdmitTrustedToolExecutionInput,
): Promise<Readonly<TrustedToolExecutionAdmission>> {
  if (!(bindings instanceof TrustedToolHandlerBindingRegistry)) {
    return invalid('handler binding registry is invalid');
  }
  const input = dataRecord(inputValue, 'execution admission input');
  exactKeys(
    input,
    ['authorizer', 'evidence', 'nowMs', 'principal', 'profile'],
    ['dispatch'],
    'execution admission input',
  );
  const plan = normalizeTrustedToolInvocationPlan(planValue, bindings);
  const nowMs = timestamp(inputValue.nowMs, 'admission time');
  const principal = normalizeSecurityPrincipal(inputValue.principal, nowMs);
  if (!sameSubject(principal.subject, plan.requestedBy)) {
    throw new TrustedToolInvocationBindingConflictError();
  }
  const profile = normalizeProfile(inputValue.profile);
  const currentBinding = bindings.resolve(
    plan.tool.name,
    plan.tool.version,
    profile,
  );
  if (
    profile !== plan.profile ||
    currentBinding.bindingDigest !== plan.binding.bindingDigest
  ) {
    throw new TrustedToolInvocationBindingConflictError();
  }
  const policy = await currentPolicyFence(
    plan,
    principal,
    inputValue.authorizer,
  );
  let dispatch: Readonly<ApprovedActionDispatchRecord> | null = null;
  if (plan.status === 'approval_required') {
    if (!inputValue.dispatch) {
      throw new TrustedToolExecutionApprovalRequiredError();
    }
    dispatch = assertTrustedToolApprovedDispatch(
      plan,
      bindings,
      inputValue.dispatch,
    );
  } else {
    if (
      inputValue.dispatch !== undefined ||
      policy.decisions.some(
        (decision) => decision.effect === 'require_approval',
      )
    ) {
      throw new TrustedToolExecutionApprovalRequiredError();
    }
  }
  const evidence = normalizeExecutionEvidence(inputValue.evidence);
  const unsigned = Object.freeze({
    schema: TRUSTED_TOOL_EXECUTION_ADMISSION_SCHEMA,
    actionRef: plan.actionRef,
    planDigest: plan.planDigest,
    actionDigest: plan.actionDigest,
    projectId: plan.projectId,
    requestedBy: plan.requestedBy,
    tool: plan.tool,
    profile,
    snapshotDigest: plan.snapshotDigest,
    definitionDigest: plan.definitionDigest,
    bindingDigest: currentBinding.bindingDigest,
    invocationArtifact: plan.invocationArtifact,
    previewArtifact: plan.previewArtifact,
    adapter: currentBinding.adapter,
    redactionContract: currentBinding.redactionContract,
    auditContract: currentBinding.auditContract,
    executionClass: currentBinding.executionClass,
    timeoutSeconds: plan.timeoutSeconds,
    policyFence: policy.fence,
    approvalRequestId: dispatch?.approvalRequestId ?? null,
    approvalDispatchId: dispatch?.id ?? null,
    approvalDispatchDigest:
      dispatch === null ? null : approvedActionDispatchDigest(dispatch),
    evidence,
    admittedAtMs: nowMs,
  } satisfies Omit<TrustedToolExecutionAdmission, 'admissionDigest'>);
  return Object.freeze({
    ...unsigned,
    admissionDigest: hash(ADMISSION_DIGEST_DOMAIN, unsigned),
  });
}

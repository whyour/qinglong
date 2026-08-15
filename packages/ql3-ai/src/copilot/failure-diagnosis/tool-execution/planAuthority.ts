import {
  BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS,
  BUILTIN_RUN_LOG_EXCERPT_TOOL,
  createBuiltInRunLogExcerptToolHandlerBinding,
} from '@qinglong/runtime-core/builtin-run-log-excerpt-tool';
import {
  normalizeProjectToolDefinitionSnapshot,
  type ProjectToolDefinitionSnapshot,
} from '@qinglong/runtime-core/project-tool-definition-snapshot';
import {
  TrustedToolHandlerBindingRegistry,
  normalizeTrustedToolInvocationPlan,
  type TrustedToolHandlerBinding,
  type TrustedToolInvocationPlan,
} from '@qinglong/runtime-core/trusted-tool-invocation';

import type { CopilotFailureDiagnosisExecutionPlan } from '../admission/contracts';
import { normalizeCopilotFailureDiagnosisExecutionPlan } from '../admission/plan';
import {
  CopilotFailureDiagnosisToolExecutionConflictError,
  InvalidCopilotFailureDiagnosisToolExecutionError,
} from './contracts';

export interface CopilotFailureDiagnosisTrustedToolAuthority {
  readonly plan: Readonly<TrustedToolInvocationPlan>;
  readonly binding: Readonly<TrustedToolHandlerBinding>;
  readonly bindings: TrustedToolHandlerBindingRegistry;
}

function invalid(message: string): never {
  throw new InvalidCopilotFailureDiagnosisToolExecutionError(message);
}

export function restoreCopilotFailureDiagnosisTrustedToolAuthority(
  executionPlanValue: CopilotFailureDiagnosisExecutionPlan,
  snapshotValue: ProjectToolDefinitionSnapshot,
): Readonly<CopilotFailureDiagnosisTrustedToolAuthority> {
  const executionPlan =
    normalizeCopilotFailureDiagnosisExecutionPlan(executionPlanValue);
  const snapshot = normalizeProjectToolDefinitionSnapshot(snapshotValue);
  if (
    snapshot.projectId !== executionPlan.projectId ||
    snapshot.snapshotDigest !== executionPlan.tool.snapshotDigest
  ) {
    throw new CopilotFailureDiagnosisToolExecutionConflictError(
      'the current Project Tool snapshot changed',
    );
  }
  const binding = createBuiltInRunLogExcerptToolHandlerBinding(snapshot, [
    'cluster-control',
  ]);
  if (
    binding.bindingDigest !== executionPlan.tool.bindingDigest ||
    binding.definitionDigest !== executionPlan.tool.definitionDigest
  ) {
    throw new CopilotFailureDiagnosisToolExecutionConflictError(
      'the reviewed log Tool binding changed',
    );
  }
  const bindings = new TrustedToolHandlerBindingRegistry(snapshot, [binding]);
  let plan: Readonly<TrustedToolInvocationPlan>;
  try {
    plan = normalizeTrustedToolInvocationPlan(
      {
        schema: 'qinglong/trusted-tool-invocation-plan@v1',
        status: 'ready',
        actionType: 'tool.invoke',
        actionRef: executionPlan.tool.actionRef,
        projectId: executionPlan.projectId,
        requestedBy: executionPlan.requestedBySubject,
        tool: BUILTIN_RUN_LOG_EXCERPT_TOOL,
        permission: 'tool.call:qinglong.run.log.excerpt',
        requiredPermissions: ['artifact.read'],
        effect: 'read',
        risk: 'medium',
        policyFence: executionPlan.policyFence,
        profile: 'cluster-control',
        snapshotDigest: executionPlan.tool.snapshotDigest,
        definitionDigest: executionPlan.tool.definitionDigest,
        binding,
        timeoutSeconds: BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS,
        invocationArtifact: executionPlan.tool.invocationArtifact,
        invocationActionDigest: executionPlan.tool.invocationActionDigest,
        previewArtifact: executionPlan.tool.previewArtifact,
        actionDigest: executionPlan.tool.actionDigest,
        sealedAtMs: executionPlan.tool.sealedAtMs,
        planDigest: executionPlan.tool.planDigest,
      },
      bindings,
    );
  } catch (cause) {
    if (cause instanceof CopilotFailureDiagnosisToolExecutionConflictError) {
      throw cause;
    }
    return invalid('the admitted trusted Tool plan cannot be restored');
  }
  if (plan.planDigest !== executionPlan.tool.planDigest) {
    return invalid('the restored trusted Tool plan digest changed');
  }
  return Object.freeze({ plan, binding, bindings });
}

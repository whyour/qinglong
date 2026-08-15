import type { ToolJsonValue } from '@qinglong/runtime-core/tool-registry';
import type { ToolExecutionCompletionRecord } from '@qinglong/runtime-core/tool-execution-completion';
import type { ToolExecutionFailureCompletionRecord } from '@qinglong/runtime-core/tool-execution-failure-completion';
import { BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS } from '@qinglong/runtime-core/builtin-run-log-excerpt-tool';
import {
  STEP_RUN_TERMINAL_STATUSES,
  transitionStepRunMutation,
  type StepRunMutation,
  type StepRunRecord,
  type StepRunStatus,
} from '@qinglong/runtime-core/step-run';

import {
  CopilotFailureDiagnosisPreModelTerminalizationConflictError,
  CopilotFailureDiagnosisPreModelTerminalizationNotReadyError,
  CopilotFailureDiagnosisPreModelTerminalizationUnavailableError,
  InvalidCopilotFailureDiagnosisPreModelTerminalizationError,
  type CopilotFailureDiagnosisPreModelTerminalizationReason,
  type CopilotFailureDiagnosisPreModelTerminalizationRepository,
  type CopilotFailureDiagnosisPreModelTerminalizationReceipt,
} from './contracts';
import {
  copilotFailureDiagnosisPreModelEvidenceDigest,
  copilotFailureDiagnosisPreModelTerminalizationMapping,
  copilotFailureDiagnosisTerminalizationIdentity,
  createCopilotFailureDiagnosisPreModelTerminalizationCommand,
  createCopilotFailureDiagnosisPreModelTerminalizationReceipt,
  terminalStepReference,
} from './protocol';

export type CopilotFailureDiagnosisPreModelTerminalizationTrigger =
  | Readonly<{
      kind: 'tool_failure';
      completion: Readonly<ToolExecutionFailureCompletionRecord>;
    }>
  | Readonly<{
      kind: 'tool_projection';
      completion: Readonly<ToolExecutionCompletionRecord>;
      output: ToolJsonValue;
    }>
  | Readonly<{ kind: 'boundary' }>;

export interface CopilotFailureDiagnosisPreModelTerminalizationDependencies {
  readonly repository: CopilotFailureDiagnosisPreModelTerminalizationRepository;
}

export interface CopilotFailureDiagnosisPreModelTerminalizationResult {
  readonly status: 'created' | 'existing';
  readonly receipt: Readonly<CopilotFailureDiagnosisPreModelTerminalizationReceipt>;
}

function invalid(message: string): never {
  throw new InvalidCopilotFailureDiagnosisPreModelTerminalizationError(message);
}

function conflict(message: string): never {
  throw new CopilotFailureDiagnosisPreModelTerminalizationConflictError(
    message,
  );
}

function unavailable(cause?: unknown): never {
  throw new CopilotFailureDiagnosisPreModelTerminalizationUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function assertDependencies(
  value: CopilotFailureDiagnosisPreModelTerminalizationDependencies,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.repository?.findByRequestId !== 'function' ||
    typeof value.repository?.readAuthority !== 'function' ||
    typeof value.repository?.commit !== 'function'
  ) {
    return invalid('dependencies are invalid');
  }
}

function statusFromProjection(
  output: ToolJsonValue,
  runId: string,
  attemptId: string,
): 'not_found' | 'pending' | 'missing' | 'retired' | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return conflict('Tool projection is not an object');
  }
  const record = output as Readonly<Record<string, ToolJsonValue>>;
  if (
    record.runId !== runId ||
    record.attemptId !== attemptId ||
    record.profile !== 'cluster-control' ||
    typeof record.status !== 'string' ||
    !['available', 'not_found', 'pending', 'missing', 'retired'].includes(
      record.status,
    )
  ) {
    return conflict('Tool projection identity changed');
  }
  return record.status === 'available'
    ? null
    : (record.status as 'not_found' | 'pending' | 'missing' | 'retired');
}

function triggerEvidence(
  trigger: CopilotFailureDiagnosisPreModelTerminalizationTrigger,
  authority: Awaited<
    ReturnType<
      CopilotFailureDiagnosisPreModelTerminalizationRepository['readAuthority']
    >
  >,
): Readonly<{
  reason: CopilotFailureDiagnosisPreModelTerminalizationReason;
  evidenceDigest: string;
  toolStartId: string | null;
  toolCompletionDigest: string | null;
}> {
  const { plan, run, observedAtMs } = authority;
  if (trigger.kind === 'tool_failure') {
    const completion = trigger.completion;
    if (
      completion.runId !== plan.runId ||
      completion.stepRunId !== plan.toolStepRunId ||
      completion.outcome !== authority.toolStep.status ||
      completion.completedStepRunDigest !== authority.toolStep.stepRunDigest
    )
      return conflict('Tool failure completion changed');
    const reason =
      completion.outcome === 'timed_out' ? 'tool_timed_out' : 'tool_failed';
    return Object.freeze({
      reason,
      evidenceDigest: copilotFailureDiagnosisPreModelEvidenceDigest({
        reason,
        planDigest: plan.planDigest,
        toolCompletionDigest: completion.completionDigest,
      }),
      toolStartId: completion.startId,
      toolCompletionDigest: completion.completionDigest,
    });
  }
  if (trigger.kind === 'tool_projection') {
    const completion = trigger.completion;
    if (
      completion.runId !== plan.runId ||
      completion.stepRunId !== plan.toolStepRunId ||
      authority.toolStep.status !== 'succeeded' ||
      completion.completedStepRunDigest !== authority.toolStep.stepRunDigest
    )
      return conflict('Tool success completion changed');
    const status = statusFromProjection(
      trigger.output,
      plan.source.runId,
      plan.source.attemptId,
    );
    if (status === null)
      throw new CopilotFailureDiagnosisPreModelTerminalizationNotReadyError();
    const reason =
      `log_${status}` as CopilotFailureDiagnosisPreModelTerminalizationReason;
    return Object.freeze({
      reason,
      evidenceDigest: copilotFailureDiagnosisPreModelEvidenceDigest({
        reason,
        planDigest: plan.planDigest,
        toolCompletionDigest: completion.completionDigest,
        sourceStatus: status,
      }),
      toolStartId: completion.startId,
      toolCompletionDigest: completion.completionDigest,
    });
  }
  if (run.cancelRequestedAtMs !== undefined && run.cancelReason !== undefined) {
    const reason = 'cancellation_requested' as const;
    return Object.freeze({
      reason,
      evidenceDigest: copilotFailureDiagnosisPreModelEvidenceDigest({
        reason,
        planDigest: plan.planDigest,
        cancelRequestedAtMs: run.cancelRequestedAtMs,
        cancelReason: run.cancelReason,
      }),
      toolStartId: null,
      toolCompletionDigest: null,
    });
  }
  if (observedAtMs >= plan.deadlineAtMs) {
    const reason = 'deadline_exceeded' as const;
    return Object.freeze({
      reason,
      evidenceDigest: copilotFailureDiagnosisPreModelEvidenceDigest({
        reason,
        planDigest: plan.planDigest,
        deadlineAtMs: plan.deadlineAtMs,
      }),
      toolStartId: null,
      toolCompletionDigest: null,
    });
  }
  const requiredToolBudgetMs = BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS * 1_000;
  if (
    authority.toolStep.status === 'ready' &&
    observedAtMs + requiredToolBudgetMs > plan.deadlineAtMs
  ) {
    const reason = 'tool_budget_exhausted' as const;
    return Object.freeze({
      reason,
      evidenceDigest: copilotFailureDiagnosisPreModelEvidenceDigest({
        reason,
        planDigest: plan.planDigest,
        deadlineAtMs: plan.deadlineAtMs,
        observedAtMs,
        requiredToolBudgetMs,
      }),
      toolStartId: null,
      toolCompletionDigest: null,
    });
  }
  throw new CopilotFailureDiagnosisPreModelTerminalizationNotReadyError();
}

function targetFor(
  step: Readonly<StepRunRecord>,
  reason: CopilotFailureDiagnosisPreModelTerminalizationReason,
  outcome: 'failed' | 'timed_out' | 'cancelled',
): StepRunStatus | null {
  if (STEP_RUN_TERMINAL_STATUSES.includes(step.status as never)) return null;
  if (reason === 'tool_failed' || reason === 'tool_timed_out') {
    return step.kind === 'model'
      ? 'cancelled'
      : conflict('Tool Step is not terminal');
  }
  if (reason.startsWith('log_')) {
    return step.kind === 'model'
      ? 'failed'
      : conflict('log evidence Tool is not terminal');
  }
  if (step.status === 'pending') return 'cancelled';
  return outcome;
}

function transitionFacts(
  target: StepRunStatus,
  reason: CopilotFailureDiagnosisPreModelTerminalizationReason,
): Readonly<{ resultCode: string; errorSummary?: string }> {
  if (target === 'failed') {
    return Object.freeze({
      resultCode: 'copilot_log_unavailable',
      errorSummary: 'Failure diagnosis source log is unavailable',
    });
  }
  if (target === 'timed_out') {
    return Object.freeze({
      resultCode: 'copilot_deadline_exceeded',
      errorSummary: 'Copilot failure diagnosis deadline exceeded',
    });
  }
  return Object.freeze({
    resultCode: reason.startsWith('tool_')
      ? 'copilot_tool_dependency_failed'
      : 'copilot_cancelled',
  });
}

function mutations(
  authority: Awaited<
    ReturnType<
      CopilotFailureDiagnosisPreModelTerminalizationRepository['readAuthority']
    >
  >,
  reason: CopilotFailureDiagnosisPreModelTerminalizationReason,
  outcome: 'failed' | 'timed_out' | 'cancelled',
): readonly Readonly<StepRunMutation>[] {
  let runVersion = authority.run.version;
  let eventSequence = authority.run.eventSequence;
  const result: StepRunMutation[] = [];
  for (const step of [authority.toolStep, authority.modelStep]) {
    const target = targetFor(step, reason, outcome);
    if (target === null) continue;
    const facts = transitionFacts(target, reason);
    const mutationId = copilotFailureDiagnosisTerminalizationIdentity(
      'mutation',
      authority.plan.planDigest,
      reason,
      step.id,
    );
    const eventId = copilotFailureDiagnosisTerminalizationIdentity(
      'step-event',
      authority.plan.planDigest,
      reason,
      step.id,
    );
    const mutation = transitionStepRunMutation(
      step,
      {
        expectedVersion: step.version,
        expectedDigest: step.stepRunDigest,
        mutationId,
        to: target,
        atMs: authority.observedAtMs,
        resultCode: facts.resultCode,
        ...(facts.errorSummary === undefined
          ? {}
          : { errorSummary: facts.errorSummary }),
      },
      {
        expectedRunVersion: runVersion,
        expectedRunEventSequence: eventSequence,
        eventId,
        dedupeKey: eventId,
        actor: { type: 'system' },
      },
    );
    result.push(mutation);
    runVersion += 1;
    eventSequence += 1;
  }
  if (result.length < 1) return conflict('no non-terminal Step remains');
  return Object.freeze(result);
}

export async function terminalizeCopilotFailureDiagnosisBeforeModel(
  requestId: string,
  trigger: CopilotFailureDiagnosisPreModelTerminalizationTrigger,
  dependencies: CopilotFailureDiagnosisPreModelTerminalizationDependencies,
): Promise<Readonly<CopilotFailureDiagnosisPreModelTerminalizationResult>> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId))
    return invalid('request id is invalid');
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger))
    return invalid('trigger is invalid');
  assertDependencies(dependencies);
  try {
    const existing = await dependencies.repository.findByRequestId(requestId);
    if (existing)
      return Object.freeze({ status: 'existing' as const, receipt: existing });
    const authority = await dependencies.repository.readAuthority(requestId);
    if (
      authority.plan.requestId !== requestId ||
      authority.run.id !== authority.plan.runId ||
      authority.run.status !== 'running' ||
      authority.run.version !== authority.run.eventSequence ||
      authority.toolStep.id !== authority.plan.toolStepRunId ||
      authority.toolStep.runId !== authority.plan.runId ||
      authority.toolStep.kind !== 'tool' ||
      authority.modelStep.id !== authority.plan.modelStepRunId ||
      authority.modelStep.runId !== authority.plan.runId ||
      authority.modelStep.kind !== 'model' ||
      authority.modelStartExists ||
      !Number.isSafeInteger(authority.observedAtMs) ||
      authority.observedAtMs < authority.plan.plannedAtMs
    )
      return conflict('pre-Model authority is invalid');
    const evidence = triggerEvidence(trigger, authority);
    const mapping = copilotFailureDiagnosisPreModelTerminalizationMapping(
      evidence.reason,
      authority.run.cancelReason,
    );
    const stepMutations = mutations(
      authority,
      evidence.reason,
      mapping.outcome,
    );
    const receipt = createCopilotFailureDiagnosisPreModelTerminalizationReceipt(
      {
        requestId,
        planDigest: authority.plan.planDigest,
        runId: authority.plan.runId,
        stage: mapping.stage,
        reason: evidence.reason,
        outcome: mapping.outcome,
        evidenceDigest: evidence.evidenceDigest,
        toolStartId: evidence.toolStartId,
        toolCompletionDigest: evidence.toolCompletionDigest,
        terminalSteps: stepMutations.map(terminalStepReference),
        finalRunVersion: authority.run.version + stepMutations.length + 1,
        finalRunEventSequence:
          authority.run.eventSequence + stepMutations.length + 1,
        finalizedAtMs: authority.observedAtMs,
      },
    );
    const command = createCopilotFailureDiagnosisPreModelTerminalizationCommand(
      {
        plan: authority.plan,
        expectedRunVersion: authority.run.version,
        expectedRunEventSequence: authority.run.eventSequence,
        stepMutations,
        receipt,
      },
    );
    return dependencies.repository.commit(command);
  } catch (cause) {
    if (
      cause instanceof
        InvalidCopilotFailureDiagnosisPreModelTerminalizationError ||
      cause instanceof
        CopilotFailureDiagnosisPreModelTerminalizationConflictError ||
      cause instanceof
        CopilotFailureDiagnosisPreModelTerminalizationNotReadyError ||
      cause instanceof
        CopilotFailureDiagnosisPreModelTerminalizationUnavailableError
    )
      throw cause;
    return unavailable(cause);
  }
}

import type { ToolJsonValue } from '@qinglong/runtime-core/tool-registry';
import {
  openTrustedToolSuccessCompletion,
  type TrustedToolSuccessCompletionResult,
  type TrustedToolSuccessCompletionReadDependencies,
} from '@qinglong/runtime-core/trusted-tool-completion';

import type {
  BoundedModelGateway,
  ModelInvocationSuccessfulCompletionSink,
} from '../../../model-gateway/gateway';
import type { ModelInvocationRepository } from '../../../model-invocation/modelInvocation';
import type { CopilotFailureDiagnosisToolExecutionAdmissionReader } from '../tool-execution/contracts';
import type { CopilotFailureDiagnosisToolUnlockRepository } from '../tool-execution/contracts';
import { buildFailureDiagnosisPromptPlan } from '../prompt';
import { normalizeFailureDiagnosisProjection } from '../validation';
import type {
  CopilotFailureDiagnosisModelCompletionCoordinator,
  CopilotFailureDiagnosisOutputCompletionRepository,
} from './completion';
import {
  copilotFailureDiagnosisOutputReference,
  type CopilotFailureDiagnosisOutputReference,
} from './outputArtifact';
import type {
  CopilotFailureDiagnosisFinalizationReceipt,
  CopilotFailureDiagnosisFinalizationRepository,
} from './finalization';

export interface CopilotFailureDiagnosisModelExecutionDependencies {
  readonly admissions: CopilotFailureDiagnosisToolExecutionAdmissionReader;
  readonly unlocks: Pick<CopilotFailureDiagnosisToolUnlockRepository, 'findByRequestId'>;
  readonly toolResults: CopilotFailureDiagnosisToolResultReader;
  readonly modelInvocations: Pick<
    ModelInvocationRepository,
    'findStart' | 'findCompletion'
  >;
  readonly outputs: Pick<
    CopilotFailureDiagnosisOutputCompletionRepository,
    'findCopilotFailureDiagnosisOutput'
  >;
  readonly gateway: Pick<
    BoundedModelGateway,
    'generate' | 'supportsSuccessfulCompletionSink'
  >;
  readonly successfulCompletion: CopilotFailureDiagnosisModelCompletionCoordinator;
  readonly finalizations: CopilotFailureDiagnosisFinalizationRepository;
}

export interface CopilotFailureDiagnosisToolResultReader {
  open(
    requestId: string,
    startId: string,
  ): Promise<Readonly<TrustedToolSuccessCompletionResult>>;
}

export function createCopilotFailureDiagnosisToolResultReader(
  dependencies: TrustedToolSuccessCompletionReadDependencies,
): CopilotFailureDiagnosisToolResultReader {
  return Object.freeze({
    open: (_requestId: string, startId: string) =>
      openTrustedToolSuccessCompletion(startId, dependencies),
  });
}

export interface CopilotFailureDiagnosisModelExecutionResult {
  readonly outcome: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  readonly output: Readonly<CopilotFailureDiagnosisOutputReference> | null;
  readonly finalization: Readonly<CopilotFailureDiagnosisFinalizationReceipt>;
}

export class InvalidCopilotFailureDiagnosisModelExecutionError extends TypeError {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_MODEL_EXECUTION_INVALID';
  constructor(message: string) {
    super(`Copilot failure diagnosis Model execution is invalid: ${message}`);
    this.name = 'InvalidCopilotFailureDiagnosisModelExecutionError';
  }
}

export class CopilotFailureDiagnosisModelExecutionConflictError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_MODEL_EXECUTION_CONFLICT';
  constructor(message = 'durable Model execution facts changed') {
    super(`Copilot failure diagnosis Model execution conflicts: ${message}`);
    this.name = 'CopilotFailureDiagnosisModelExecutionConflictError';
  }
}

export class CopilotFailureDiagnosisModelExecutionUnavailableError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_MODEL_EXECUTION_UNAVAILABLE';
  constructor(options?: ErrorOptions) {
    super('Copilot failure diagnosis Model execution is unavailable', options);
    this.name = 'CopilotFailureDiagnosisModelExecutionUnavailableError';
  }
}

function assertDependencies(
  value: CopilotFailureDiagnosisModelExecutionDependencies,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.admissions?.findPlanByRequestId !== 'function' ||
    typeof value.admissions?.findByRequestId !== 'function' ||
    typeof value.unlocks?.findByRequestId !== 'function' ||
    typeof value.toolResults?.open !== 'function' ||
    typeof value.modelInvocations?.findStart !== 'function' ||
    typeof value.modelInvocations?.findCompletion !== 'function' ||
    typeof value.outputs?.findCopilotFailureDiagnosisOutput !== 'function' ||
    typeof value.gateway?.generate !== 'function' ||
    typeof value.gateway?.supportsSuccessfulCompletionSink !== 'function' ||
    typeof value.successfulCompletion?.begin !== 'function' ||
    typeof value.successfulCompletion?.reference !== 'function' ||
    typeof value.successfulCompletion?.end !== 'function' ||
    typeof value.finalizations?.findFinalization !== 'function' ||
    typeof value.finalizations?.finalize !== 'function'
  ) {
    throw new InvalidCopilotFailureDiagnosisModelExecutionError(
      'dependencies are invalid',
    );
  }
}

function projection(
  output: ToolJsonValue,
  runId: string,
  attemptId: string,
) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new CopilotFailureDiagnosisModelExecutionConflictError(
      'Tool output is not an object',
    );
  }
  const record = output as Readonly<Record<string, ToolJsonValue>>;
  if (
    record.status !== 'available' ||
    record.runId !== runId ||
    record.attemptId !== attemptId ||
    record.profile !== 'cluster-control'
  ) {
    throw new CopilotFailureDiagnosisModelExecutionConflictError(
      'the admitted source log projection is unavailable',
    );
  }
  return normalizeFailureDiagnosisProjection(
    {
      content: record.content,
      sourceBytes: record.sourceBytes,
      modelTextBytes: record.modelTextBytes,
      redaction: record.redaction,
      normalization: record.normalization,
      trust: record.trust,
    },
    'cluster-control',
  );
}

async function finalize(
  requestId: string,
  dependencies: CopilotFailureDiagnosisModelExecutionDependencies,
): Promise<Readonly<CopilotFailureDiagnosisModelExecutionResult>> {
  const result = await dependencies.finalizations.finalize(requestId);
  let output: Readonly<CopilotFailureDiagnosisOutputReference> | null = null;
  if (result.receipt.outputArtifactId !== null) {
    const artifact =
      await dependencies.outputs.findCopilotFailureDiagnosisOutput(
        result.receipt.outputArtifactId,
      );
    if (artifact) output = copilotFailureDiagnosisOutputReference(artifact);
    if (!output) {
      throw new CopilotFailureDiagnosisModelExecutionConflictError(
        'terminal output reference is unavailable',
      );
    }
  }
  return Object.freeze({
    outcome: result.receipt.outcome,
    output,
    finalization: result.receipt,
  });
}

export async function executeCopilotFailureDiagnosisModel(
  requestId: string,
  dependencies: CopilotFailureDiagnosisModelExecutionDependencies,
): Promise<Readonly<CopilotFailureDiagnosisModelExecutionResult>> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
    throw new InvalidCopilotFailureDiagnosisModelExecutionError(
      'request id is invalid',
    );
  }
  assertDependencies(dependencies);
  const existingFinalization = await dependencies.finalizations.findFinalization(
    requestId,
  );
  if (existingFinalization) return finalize(requestId, dependencies);

  const [plan, admission, unlock] = await Promise.all([
    dependencies.admissions.findPlanByRequestId(requestId),
    dependencies.admissions.findByRequestId(requestId),
    dependencies.unlocks.findByRequestId(requestId),
  ]);
  if (
    !plan ||
    !admission ||
    !unlock ||
    admission.planDigest !== plan.planDigest ||
    unlock.planDigest !== plan.planDigest ||
    unlock.runId !== plan.runId ||
    unlock.modelStepRunId !== plan.modelStepRunId
  ) {
    throw new CopilotFailureDiagnosisModelExecutionConflictError(
      'admission or Tool unlock evidence is incomplete',
    );
  }
  const existingCompletion = await dependencies.modelInvocations.findCompletion(
    plan.modelInvocationId,
  );
  if (existingCompletion) return finalize(requestId, dependencies);
  const existingStart = await dependencies.modelInvocations.findStart(
    plan.modelInvocationId,
  );
  if (existingStart) {
    throw new CopilotFailureDiagnosisModelExecutionConflictError(
      'an incomplete Model invocation cannot be executed again automatically',
    );
  }

  const tool = await dependencies.toolResults.open(requestId, unlock.startId);
  if (
    tool.completion.completionDigest !== unlock.toolCompletionDigest ||
    tool.completion.runId !== plan.runId ||
    tool.completion.stepRunId !== plan.toolStepRunId
  ) {
    throw new CopilotFailureDiagnosisModelExecutionConflictError(
      'Tool completion evidence changed',
    );
  }
  const prompt = buildFailureDiagnosisPromptPlan({
    provider: plan.model.provider,
    model: plan.model.model,
    modelBoundary: plan.model.modelBoundary,
    profile: 'cluster-control',
    responseLanguage: plan.model.responseLanguage,
    projection: projection(
      tool.output,
      plan.source.runId,
      plan.source.attemptId,
    ),
    maxOutputTokens: plan.model.maxOutputTokens,
    egressPolicy: plan.model.egressPolicy,
  });
  if (
    !dependencies.gateway.supportsSuccessfulCompletionSink(
      dependencies.successfulCompletion as ModelInvocationSuccessfulCompletionSink,
    )
  ) {
    throw new InvalidCopilotFailureDiagnosisModelExecutionError(
      'Gateway successful completion sink is not the Copilot sink',
    );
  }
  const lease = dependencies.successfulCompletion.begin({
    plan,
    prompt,
    toolCompletionDigest: unlock.toolCompletionDigest,
  });
  try {
    try {
      await dependencies.gateway.generate(prompt.request, {
        projectId: plan.projectId,
        runId: plan.runId,
        stepRunId: plan.modelStepRunId,
        traceId: plan.traceId,
        requestId: plan.modelInvocationId,
        deadlineAtMs: plan.deadlineAtMs,
      });
    } catch (cause) {
      const completion = await dependencies.modelInvocations.findCompletion(
        plan.modelInvocationId,
      );
      if (!completion) {
        throw new CopilotFailureDiagnosisModelExecutionUnavailableError({
          cause: cause instanceof Error ? cause : undefined,
        });
      }
    }
    return finalize(requestId, dependencies);
  } finally {
    dependencies.successfulCompletion.end(lease);
  }
}

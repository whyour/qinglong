import type {
  ModelInvocationCompletionCommand,
  ModelInvocationRepository,
} from '../../../model-invocation/modelInvocation';
import type { DurableModelInvocationCoordinator } from '../../../model-invocation/durableModelInvocationCoordinator';
import type { ModelInvocationAtomicSuccess } from '../../../model-invocation/modelInvocationAtomicSuccess';
import type {
  GenerateResult,
  ModelInvocationAuditRecord,
} from '../../../model-gateway/model';
import type { ModelInvocationSuccessfulCompletionSink } from '../../../model-gateway/gateway';
import type { CopilotFailureDiagnosisExecutionPlan } from '../admission/contracts';
import { normalizeCopilotFailureDiagnosisExecutionPlan } from '../admission/plan';
import type { FailureDiagnosisPromptPlan } from '../contracts';
import {
  CopilotFailureDiagnosisOutputArtifactConflictError,
  CopilotFailureDiagnosisOutputArtifactUnavailableError,
  copilotFailureDiagnosisOutputReference,
  createCopilotFailureDiagnosisOutputArtifact,
  normalizeCopilotFailureDiagnosisOutputArtifact,
  type CopilotFailureDiagnosisOutputArtifact,
  type CopilotFailureDiagnosisOutputKeyProvider,
  type CopilotFailureDiagnosisOutputReference,
} from './outputArtifact';

export const MAX_ACTIVE_COPILOT_FAILURE_DIAGNOSIS_MODEL_COMPLETIONS = 64;

export interface CommitCopilotFailureDiagnosisOutputResult {
  readonly status: 'created' | 'existing';
  readonly reference: Readonly<CopilotFailureDiagnosisOutputReference>;
}

export interface CopilotFailureDiagnosisOutputCompletionRepository {
  findCopilotFailureDiagnosisOutput(
    artifactId: string,
  ): Promise<Readonly<CopilotFailureDiagnosisOutputArtifact> | null>;
  completeWithCopilotFailureDiagnosisOutput(
    command: Readonly<ModelInvocationCompletionCommand>,
    artifact: Readonly<CopilotFailureDiagnosisOutputArtifact>,
  ): Promise<Readonly<CommitCopilotFailureDiagnosisOutputResult>>;
}

export function isCopilotFailureDiagnosisOutputCompletionRepository(
  value: ModelInvocationRepository,
): value is ModelInvocationRepository &
  CopilotFailureDiagnosisOutputCompletionRepository {
  return (
    typeof (value as Partial<CopilotFailureDiagnosisOutputCompletionRepository>)
      .findCopilotFailureDiagnosisOutput === 'function' &&
    typeof (value as Partial<CopilotFailureDiagnosisOutputCompletionRepository>)
      .completeWithCopilotFailureDiagnosisOutput === 'function'
  );
}

export function assertCopilotFailureDiagnosisOutputCompletionBinding(
  command: Readonly<ModelInvocationCompletionCommand>,
  artifactValue: CopilotFailureDiagnosisOutputArtifact,
): Readonly<{
  artifact: Readonly<CopilotFailureDiagnosisOutputArtifact>;
  reference: Readonly<CopilotFailureDiagnosisOutputReference>;
}> {
  const artifact = normalizeCopilotFailureDiagnosisOutputArtifact(artifactValue);
  if (
    command.completion.outcome !== 'succeeded' ||
    command.completion.errorCode !== null ||
    command.completion.invocationId !== artifact.invocationId ||
    command.completion.projectId !== artifact.projectId ||
    command.completion.runId !== artifact.runId ||
    command.completion.stepRunId !== artifact.stepRunId ||
    command.completion.outputBytes !== artifact.outputBytes ||
    command.start.provider !== artifact.provider ||
    command.start.model !== artifact.model ||
    command.stepRunMutation.stepRun.outputRef !== artifact.artifactId
  ) {
    throw new CopilotFailureDiagnosisOutputArtifactConflictError();
  }
  return Object.freeze({
    artifact,
    reference: copilotFailureDiagnosisOutputReference(artifact),
  });
}

function atomicSuccess(
  artifactValue: CopilotFailureDiagnosisOutputArtifact,
): ModelInvocationAtomicSuccess<CopilotFailureDiagnosisOutputReference> {
  const artifact = normalizeCopilotFailureDiagnosisOutputArtifact(artifactValue);
  const reference = copilotFailureDiagnosisOutputReference(artifact);
  const conflict = (): Error =>
    new CopilotFailureDiagnosisOutputArtifactConflictError();
  const extension: ModelInvocationAtomicSuccess<CopilotFailureDiagnosisOutputReference> = {
    outputRef: artifact.artifactId,
    assertAudit(audit): void {
      if (
        audit.phase !== 'completed' ||
        audit.requestId !== artifact.invocationId ||
        audit.projectId !== artifact.projectId ||
        audit.runId !== artifact.runId ||
        audit.stepRunId !== artifact.stepRunId ||
        audit.provider !== artifact.provider ||
        audit.model !== artifact.model ||
        audit.outputBytes !== artifact.outputBytes
      ) {
        throw conflict();
      }
    },
    async find(repository) {
      if (!isCopilotFailureDiagnosisOutputCompletionRepository(repository)) {
        throw conflict();
      }
      const stored = await repository.findCopilotFailureDiagnosisOutput(
        artifact.artifactId,
      );
      if (!stored) return null;
      if (JSON.stringify(stored) !== JSON.stringify(artifact)) throw conflict();
      return copilotFailureDiagnosisOutputReference(stored);
    },
    matches(stored): boolean {
      return JSON.stringify(stored) === JSON.stringify(reference);
    },
    async commit(repository, command) {
      if (!isCopilotFailureDiagnosisOutputCompletionRepository(repository)) {
        throw conflict();
      }
      return repository.completeWithCopilotFailureDiagnosisOutput(
        command,
        artifact,
      );
    },
    conflict,
  };
  return Object.freeze(extension);
}

export interface CopilotFailureDiagnosisModelCompletionLease {
  readonly invocationId: string;
}

interface ActiveCompletion {
  readonly lease: Readonly<CopilotFailureDiagnosisModelCompletionLease>;
  readonly plan: Readonly<CopilotFailureDiagnosisExecutionPlan>;
  readonly prompt: Readonly<FailureDiagnosisPromptPlan>;
  readonly toolCompletionDigest: string;
  reference: Readonly<CopilotFailureDiagnosisOutputReference> | null;
}

export class CopilotFailureDiagnosisModelCompletionCoordinator
  implements ModelInvocationSuccessfulCompletionSink
{
  readonly #coordinator: DurableModelInvocationCoordinator;
  readonly #keys: CopilotFailureDiagnosisOutputKeyProvider;
  readonly #now: () => number;
  readonly #nonceFactory: (() => Uint8Array) | undefined;
  readonly #active = new Map<string, ActiveCompletion>();

  constructor(options: Readonly<{
    coordinator: DurableModelInvocationCoordinator;
    keys: CopilotFailureDiagnosisOutputKeyProvider;
    now?: () => number;
    nonceFactory?: () => Uint8Array;
  }>) {
    if (
      !options ||
      typeof options !== 'object' ||
      typeof options.coordinator?.recordWithAtomicSuccess !== 'function' ||
      typeof options.keys?.active !== 'function' ||
      typeof options.keys?.resolve !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.nonceFactory !== undefined &&
        typeof options.nonceFactory !== 'function')
    ) {
      throw new CopilotFailureDiagnosisOutputArtifactUnavailableError();
    }
    this.#coordinator = options.coordinator;
    this.#keys = options.keys;
    this.#now = options.now ?? Date.now;
    this.#nonceFactory = options.nonceFactory;
  }

  begin(input: Readonly<{
    plan: CopilotFailureDiagnosisExecutionPlan;
    prompt: FailureDiagnosisPromptPlan;
    toolCompletionDigest: string;
  }>): Readonly<CopilotFailureDiagnosisModelCompletionLease> {
    const plan = normalizeCopilotFailureDiagnosisExecutionPlan(input.plan);
    if (
      input.prompt.request.provider !== plan.model.provider ||
      input.prompt.request.model !== plan.model.model ||
      input.prompt.request.maxOutputTokens !== plan.model.maxOutputTokens ||
      input.prompt.egressEvidence.modelBoundary !== plan.model.modelBoundary ||
      input.prompt.egressEvidence.policyRevision !==
        plan.model.egressPolicy.revision ||
      input.prompt.egressEvidence.maxOutputTokens !==
        plan.model.maxOutputTokens ||
      input.prompt.completionRequirements.persistence !== 'encrypted_only' ||
      input.prompt.completionRequirements.plaintextAudit !== 'forbidden' ||
      !/^[0-9a-f]{64}$/.test(input.toolCompletionDigest) ||
      this.#active.has(plan.modelInvocationId) ||
      this.#active.size >=
        MAX_ACTIVE_COPILOT_FAILURE_DIAGNOSIS_MODEL_COMPLETIONS
    ) {
      throw new CopilotFailureDiagnosisOutputArtifactConflictError();
    }
    const lease = Object.freeze({ invocationId: plan.modelInvocationId });
    this.#active.set(plan.modelInvocationId, {
      lease,
      plan,
      prompt: input.prompt,
      toolCompletionDigest: input.toolCompletionDigest,
      reference: null,
    });
    return lease;
  }

  reference(
    lease: Readonly<CopilotFailureDiagnosisModelCompletionLease>,
  ): Readonly<CopilotFailureDiagnosisOutputReference> | null {
    const active = this.#active.get(lease.invocationId);
    if (!active || active.lease !== lease) {
      throw new CopilotFailureDiagnosisOutputArtifactUnavailableError();
    }
    return active.reference;
  }

  end(lease: Readonly<CopilotFailureDiagnosisModelCompletionLease>): void {
    const active = this.#active.get(lease.invocationId);
    if (!active || active.lease !== lease) {
      throw new CopilotFailureDiagnosisOutputArtifactUnavailableError();
    }
    this.#active.delete(lease.invocationId);
  }

  async record(
    audit: Readonly<ModelInvocationAuditRecord>,
    result: Readonly<GenerateResult>,
  ) {
    const active = this.#active.get(audit.requestId);
    if (!active) return Object.freeze({ handled: false as const });
    const { plan, prompt } = active;
    if (
      audit.phase !== 'completed' ||
      audit.projectId !== plan.projectId ||
      audit.runId !== plan.runId ||
      audit.stepRunId !== plan.modelStepRunId ||
      audit.traceId !== plan.traceId ||
      audit.requestId !== plan.modelInvocationId ||
      result.provider !== plan.model.provider ||
      result.model !== plan.model.model
    ) {
      throw new CopilotFailureDiagnosisOutputArtifactConflictError();
    }
    const material = await this.#keys.active();
    try {
      const artifact = createCopilotFailureDiagnosisOutputArtifact(
        {
          requestId: plan.requestId,
          planDigest: plan.planDigest,
          toolCompletionDigest: active.toolCompletionDigest,
          projectId: plan.projectId,
          runId: plan.runId,
          stepRunId: plan.modelStepRunId,
          invocationId: plan.modelInvocationId,
          result,
          egressEvidence: prompt.egressEvidence,
          keyId: material.keyId,
          key: material.key,
          sealedAtMs: this.#now(),
        },
        this.#nonceFactory,
      );
      const disposition = await this.#coordinator.recordWithAtomicSuccess(
        audit,
        atomicSuccess(artifact),
      );
      active.reference = disposition.reference;
      return Object.freeze({
        handled: true as const,
        disposition: Object.freeze({ status: disposition.status }),
      });
    } finally {
      material.key.fill(0);
    }
  }
}

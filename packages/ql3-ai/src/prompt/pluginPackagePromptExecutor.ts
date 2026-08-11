import type { GenerateResult } from '../model-gateway/model';
import type { ModelInvocationRepository } from '../model-invocation/modelInvocation';
import type { ActiveModelGatewayCapability } from '../profile/profileComposition';
import type { ModelInvocationSuccessfulCompletionSink } from '../model-gateway/gateway';
import {
  PluginPackagePromptAdmissionConflictError,
  PluginPackagePromptAdmissionUnavailableError,
  PluginPackagePromptExecutionInProgressError,
  preparePluginPackagePromptExecution,
  type PluginPackagePromptAdmissionReceipt,
  type PluginPackagePromptAdmissionRepository,
  type PluginPackagePromptFinalizationReceipt,
  type PreparePluginPackagePromptExecutionInput,
} from './pluginPackagePromptExecution';
import {
  PluginPackagePromptOutputArtifactUnavailableError,
  pluginPackagePromptOutputArtifactIdentity,
  pluginPackagePromptOutputArtifactReference,
  type PluginPackagePromptOutputArtifactReference,
} from '../prompt-output/pluginPackagePromptOutputArtifact';
import {
  isPluginPackagePromptOutputCompletionRepository,
  type PluginPackagePromptOutputCompletionCapability,
  type PluginPackagePromptOutputCompletionLease,
} from '../prompt-output/pluginPackagePromptOutputCompletion';

export type PluginPackagePromptExecutionDisposition =
  | 'executed'
  | 'resumed'
  | 'existing';

export interface ExecutePluginPackagePromptResult {
  readonly status: PluginPackagePromptExecutionDisposition;
  readonly admission: Readonly<PluginPackagePromptAdmissionReceipt>;
  readonly finalization: Readonly<PluginPackagePromptFinalizationReceipt>;
  /** Present only on the live response path; Prompt output is not durably replayed. */
  readonly result: Readonly<GenerateResult> | null;
  readonly outputArtifact?: Readonly<PluginPackagePromptOutputArtifactReference>;
}

type PromptModelGateway = ActiveModelGatewayCapability & {
  supportsSuccessfulCompletionSink?(
    sink: ModelInvocationSuccessfulCompletionSink,
  ): boolean;
};

function assertAdmissions(
  value: PluginPackagePromptAdmissionRepository,
): PluginPackagePromptAdmissionRepository {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.findByRequestId !== 'function' ||
    typeof value.findByInvocationId !== 'function' ||
    typeof value.findFinalizationByRequestId !== 'function' ||
    typeof value.admit !== 'function' ||
    typeof value.finalize !== 'function'
  ) {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  return value;
}

function assertInvocations(
  value: ModelInvocationRepository,
): ModelInvocationRepository {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.findStart !== 'function' ||
    typeof value.findCompletion !== 'function'
  ) {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  return value;
}

function assertGateway(
  value: ActiveModelGatewayCapability,
): PromptModelGateway {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.generate !== 'function'
  ) {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  return value;
}

export class PluginPackagePromptExecutor {
  readonly #admissions: PluginPackagePromptAdmissionRepository;
  readonly #invocations: ModelInvocationRepository;
  readonly #gateway: PromptModelGateway;
  readonly #durableOutput:
    | PluginPackagePromptOutputCompletionCapability
    | undefined;

  constructor(
    options: Readonly<{
      admissions: PluginPackagePromptAdmissionRepository;
      invocations: ModelInvocationRepository;
      gateway: ActiveModelGatewayCapability;
      durableOutput?: PluginPackagePromptOutputCompletionCapability;
    }>,
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).sort().join('\0') !==
        [
          'admissions',
          ...(options.durableOutput === undefined ? [] : ['durableOutput']),
          'gateway',
          'invocations',
        ].join('\0')
    ) {
      throw new PluginPackagePromptAdmissionUnavailableError();
    }
    this.#admissions = assertAdmissions(options.admissions);
    this.#invocations = assertInvocations(options.invocations);
    this.#gateway = assertGateway(options.gateway);
    this.#durableOutput = options.durableOutput;
  }

  async execute(
    input: PreparePluginPackagePromptExecutionInput,
  ): Promise<Readonly<ExecutePluginPackagePromptResult>> {
    const prepared = preparePluginPackagePromptExecution(input);
    const plan = prepared.plan;
    const durable = plan.output?.mode === 'durable_artifact';
    if (
      durable &&
      (!this.#durableOutput ||
        !isPluginPackagePromptOutputCompletionRepository(this.#invocations) ||
        typeof this.#gateway.supportsSuccessfulCompletionSink !== 'function' ||
        !this.#gateway.supportsSuccessfulCompletionSink(
          this.#durableOutput as ModelInvocationSuccessfulCompletionSink,
        ))
    ) {
      throw new PluginPackagePromptOutputArtifactUnavailableError();
    }
    const admission = await this.#admissions.admit(plan);

    if (admission.status === 'existing') {
      const finalization = await this.#admissions.findFinalizationByRequestId(
        plan.requestId,
      );
      if (finalization) {
        const outputArtifact = durable
          ? await this.#storedOutputArtifact(plan.invocationId)
          : undefined;
        return Object.freeze({
          status: 'existing' as const,
          admission: admission.receipt,
          finalization,
          result: null,
          ...(outputArtifact === undefined ? {} : { outputArtifact }),
        });
      }
      const [start, completion] = await Promise.all([
        this.#invocations.findStart(plan.invocationId),
        this.#invocations.findCompletion(plan.invocationId),
      ]);
      if (completion) {
        if (!start || completion.startDigest !== start.startDigest) {
          throw new PluginPackagePromptAdmissionConflictError(
            'the durable ModelInvocation chain is incomplete',
          );
        }
        const finalized = await this.#admissions.finalize(plan.requestId);
        const outputArtifact = durable
          ? await this.#storedOutputArtifact(plan.invocationId)
          : undefined;
        return Object.freeze({
          status: 'existing' as const,
          admission: admission.receipt,
          finalization: finalized.receipt,
          result: null,
          ...(outputArtifact === undefined ? {} : { outputArtifact }),
        });
      }
      if (start) throw new PluginPackagePromptExecutionInProgressError();
    }

    let result: Readonly<GenerateResult>;
    let outputLease:
      | Readonly<PluginPackagePromptOutputCompletionLease>
      | undefined;
    let outputArtifact:
      | Readonly<PluginPackagePromptOutputArtifactReference>
      | undefined;
    try {
      if (durable) outputLease = this.#durableOutput!.begin(plan);
      result = await this.#gateway.generate(prepared.request, {
        projectId: plan.target.projectId,
        runId: plan.runId,
        stepRunId: plan.stepRunId,
        traceId: plan.traceId,
        requestId: plan.invocationId,
        deadlineAtMs: plan.deadlineAtMs,
        ...(prepared.signal === undefined ? {} : { signal: prepared.signal }),
      });
      if (outputLease) {
        outputArtifact =
          this.#durableOutput!.reference(outputLease) ?? undefined;
        if (!outputArtifact) {
          throw new PluginPackagePromptOutputArtifactUnavailableError();
        }
      }
    } catch (error) {
      const completion = await this.#invocations.findCompletion(
        plan.invocationId,
      );
      if (completion && completion.outcome !== 'outcome_unknown') {
        try {
          await this.#admissions.finalize(plan.requestId);
        } catch (finalizationError) {
          throw new AggregateError(
            [error, finalizationError],
            'Prompt execution and durable Run finalization both failed',
          );
        }
      }
      throw error;
    } finally {
      if (outputLease) this.#durableOutput!.end(outputLease);
    }

    const completion = await this.#invocations.findCompletion(
      plan.invocationId,
    );
    if (!completion || completion.outcome !== 'succeeded') {
      throw new PluginPackagePromptAdmissionConflictError(
        'the successful provider response lacks exact durable completion',
      );
    }
    const finalization = await this.#admissions.finalize(plan.requestId);
    return Object.freeze({
      status: admission.status === 'created' ? 'executed' : 'resumed',
      admission: admission.receipt,
      finalization: finalization.receipt,
      result,
      ...(outputArtifact === undefined ? {} : { outputArtifact }),
    });
  }

  async #storedOutputArtifact(
    invocationId: string,
  ): Promise<Readonly<PluginPackagePromptOutputArtifactReference>> {
    if (!isPluginPackagePromptOutputCompletionRepository(this.#invocations)) {
      throw new PluginPackagePromptOutputArtifactUnavailableError();
    }
    const artifact = await this.#invocations.findPromptOutputArtifact(
      pluginPackagePromptOutputArtifactIdentity(invocationId),
    );
    if (artifact) return pluginPackagePromptOutputArtifactReference(artifact);
    const tombstone =
      await this.#invocations.findPromptOutputArtifactTombstone?.(
        pluginPackagePromptOutputArtifactIdentity(invocationId),
      );
    if (
      tombstone &&
      tombstone.reference.artifactId ===
        pluginPackagePromptOutputArtifactIdentity(invocationId)
    ) {
      return tombstone.reference;
    }
    throw new PluginPackagePromptOutputArtifactUnavailableError();
  }
}

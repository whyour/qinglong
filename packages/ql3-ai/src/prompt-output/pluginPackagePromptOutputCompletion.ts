import type {
  CommitModelInvocationResult,
  ModelInvocationCompletionCommand,
  ModelInvocationCompletionRecord,
} from '../model-invocation/modelInvocation';
import type {
  GenerateResult,
  ModelInvocationAuditRecord,
} from '../model-gateway/model';
import type { ModelInvocationSuccessfulCompletionSink } from '../model-gateway/gateway';
import type { DurableModelInvocationCoordinator } from '../model-invocation/durableModelInvocationCoordinator';
import type { ModelInvocationAtomicSuccess } from '../model-invocation/modelInvocationAtomicSuccess';
import {
  normalizePluginPackagePromptExecutionPlan,
  type PluginPackagePromptExecutionPlan,
} from '../prompt/pluginPackagePromptExecution';
import {
  PluginPackagePromptOutputArtifactConflictError,
  PluginPackagePromptOutputArtifactUnavailableError,
  createPluginPackagePromptOutputArtifact,
  normalizePluginPackagePromptOutputArtifact,
  pluginPackagePromptOutputArtifactReference,
  type PluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifactKeyProvider,
  type PluginPackagePromptOutputArtifactReference,
} from './pluginPackagePromptOutputArtifact';
import type { PluginPackagePromptOutputArtifactTombstone } from './pluginPackagePromptOutputRetention';

export const MAX_ACTIVE_PLUGIN_PACKAGE_PROMPT_OUTPUT_COMPLETIONS = 64;

export interface PluginPackagePromptOutputCompletionLease {
  readonly invocationId: string;
}

export interface PluginPackagePromptOutputCompletionCapability
  extends ModelInvocationSuccessfulCompletionSink {
  begin(
    plan: PluginPackagePromptExecutionPlan,
  ): Readonly<PluginPackagePromptOutputCompletionLease>;
  reference(
    lease: Readonly<PluginPackagePromptOutputCompletionLease>,
  ): Readonly<PluginPackagePromptOutputArtifactReference> | null;
  end(lease: Readonly<PluginPackagePromptOutputCompletionLease>): void;
}

export interface CommitPluginPackagePromptOutputResult
  extends CommitModelInvocationResult<ModelInvocationCompletionRecord> {
  readonly artifact: Readonly<PluginPackagePromptOutputArtifact>;
  readonly reference: Readonly<PluginPackagePromptOutputArtifactReference>;
}

/**
 * Dialect-owned atomic boundary. Implementations must commit the encrypted
 * Artifact, ModelInvocation completion/settlements and StepRun/Event mutation
 * in one transaction. It is deliberately separate from the plain Artifact
 * repository so callers cannot accidentally compose a post-completion put.
 */
export interface PluginPackagePromptOutputCompletionRepository {
  findPromptOutputArtifact(
    artifactId: string,
  ): Promise<Readonly<PluginPackagePromptOutputArtifact> | null>;
  findPromptOutputArtifactTombstone?(
    artifactId: string,
  ): Promise<Readonly<PluginPackagePromptOutputArtifactTombstone> | null>;
  completeWithPromptOutputArtifact(
    command: ModelInvocationCompletionCommand,
    artifact: PluginPackagePromptOutputArtifact,
  ): Promise<Readonly<CommitPluginPackagePromptOutputResult>>;
}

export function isPluginPackagePromptOutputCompletionRepository(
  value: unknown,
): value is PluginPackagePromptOutputCompletionRepository {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as PluginPackagePromptOutputCompletionRepository)
      .findPromptOutputArtifact === 'function' &&
    typeof (value as PluginPackagePromptOutputCompletionRepository)
      .completeWithPromptOutputArtifact === 'function'
  );
}

export function assertPluginPackagePromptOutputCompletionBinding(
  command: Readonly<ModelInvocationCompletionCommand>,
  artifactValue: PluginPackagePromptOutputArtifact,
): Readonly<{
  artifact: Readonly<PluginPackagePromptOutputArtifact>;
  reference: Readonly<PluginPackagePromptOutputArtifactReference>;
}> {
  const artifact = normalizePluginPackagePromptOutputArtifact(artifactValue);
  const completion = command.completion;
  if (
    completion.outcome !== 'succeeded' ||
    completion.errorCode !== null ||
    completion.invocationId !== artifact.invocationId ||
    completion.projectId !== artifact.projectId ||
    completion.runId !== artifact.runId ||
    completion.stepRunId !== artifact.stepRunId ||
    completion.outputBytes !== artifact.outputBytes ||
    command.start.invocationId !== artifact.invocationId ||
    command.start.projectId !== artifact.projectId ||
    command.start.runId !== artifact.runId ||
    command.start.stepRunId !== artifact.stepRunId ||
    command.start.provider !== artifact.provider ||
    command.start.model !== artifact.model ||
    command.stepRunMutation.stepRun.outputRef !== artifact.artifactId
  ) {
    throw new PluginPackagePromptOutputArtifactConflictError();
  }
  return Object.freeze({
    artifact,
    reference: pluginPackagePromptOutputArtifactReference(artifact),
  });
}

function pluginPackagePromptOutputAtomicSuccess(
  artifactValue: PluginPackagePromptOutputArtifact,
): ModelInvocationAtomicSuccess<PluginPackagePromptOutputArtifactReference> {
  const artifact = normalizePluginPackagePromptOutputArtifact(artifactValue);
  const reference = pluginPackagePromptOutputArtifactReference(artifact);
  const conflict = (): Error =>
    new PluginPackagePromptOutputArtifactConflictError();
  const extension: ModelInvocationAtomicSuccess<PluginPackagePromptOutputArtifactReference> = {
    outputRef: artifact.artifactId,
    assertAudit(audit: Readonly<ModelInvocationAuditRecord>): void {
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
      if (!isPluginPackagePromptOutputCompletionRepository(repository)) {
        throw conflict();
      }
      const stored = await repository.findPromptOutputArtifact(
        artifact.artifactId,
      );
      if (!stored) return null;
      if (JSON.stringify(stored) !== JSON.stringify(artifact)) throw conflict();
      return pluginPackagePromptOutputArtifactReference(stored);
    },
    matches(stored): boolean {
      return JSON.stringify(stored) === JSON.stringify(reference);
    },
    async commit(repository, command) {
      if (!isPluginPackagePromptOutputCompletionRepository(repository)) {
        throw conflict();
      }
      const result = await repository.completeWithPromptOutputArtifact(
        command,
        artifact,
      );
      return Object.freeze({
        status: result.status,
        reference: result.reference,
      });
    },
    conflict,
  };
  return Object.freeze(extension);
}

interface ActiveCompletion {
  readonly lease: Readonly<PluginPackagePromptOutputCompletionLease>;
  readonly plan: Readonly<PluginPackagePromptExecutionPlan>;
  reference: Readonly<PluginPackagePromptOutputArtifactReference> | null;
}

/**
 * Bounded in-memory bridge between one admitted Prompt execution and the
 * Gateway's successful-result hook. The registry carries no plaintext and is
 * never a recovery authority; all durable facts are committed by the dialect
 * repository before the Gateway returns.
 */
export class PluginPackagePromptOutputCompletionCoordinator
  implements
    PluginPackagePromptOutputCompletionCapability,
    ModelInvocationSuccessfulCompletionSink
{
  readonly #coordinator: DurableModelInvocationCoordinator;
  readonly #keys: PluginPackagePromptOutputArtifactKeyProvider;
  readonly #now: () => number;
  readonly #nonceFactory: (() => Uint8Array) | undefined;
  readonly #active = new Map<string, ActiveCompletion>();

  constructor(
    options: Readonly<{
      coordinator: DurableModelInvocationCoordinator;
      keys: PluginPackagePromptOutputArtifactKeyProvider;
      now?: () => number;
      nonceFactory?: () => Uint8Array;
    }>,
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !options.coordinator ||
      typeof options.coordinator.recordWithAtomicSuccess !==
        'function' ||
      !options.keys ||
      typeof options.keys.active !== 'function' ||
      typeof options.keys.resolve !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.nonceFactory !== undefined &&
        typeof options.nonceFactory !== 'function')
    ) {
      throw new PluginPackagePromptOutputArtifactUnavailableError();
    }
    this.#coordinator = options.coordinator;
    this.#keys = options.keys;
    this.#now = options.now ?? Date.now;
    this.#nonceFactory = options.nonceFactory;
  }

  begin(
    planValue: PluginPackagePromptExecutionPlan,
  ): Readonly<PluginPackagePromptOutputCompletionLease> {
    const plan = normalizePluginPackagePromptExecutionPlan(planValue);
    if (
      plan.output?.mode !== 'durable_artifact' ||
      this.#active.has(plan.invocationId) ||
      this.#active.size >= MAX_ACTIVE_PLUGIN_PACKAGE_PROMPT_OUTPUT_COMPLETIONS
    ) {
      throw new PluginPackagePromptOutputArtifactUnavailableError();
    }
    const lease = Object.freeze({ invocationId: plan.invocationId });
    this.#active.set(plan.invocationId, {
      lease,
      plan,
      reference: null,
    });
    return lease;
  }

  reference(
    lease: Readonly<PluginPackagePromptOutputCompletionLease>,
  ): Readonly<PluginPackagePromptOutputArtifactReference> | null {
    const active = this.#active.get(lease.invocationId);
    if (!active || active.lease !== lease) {
      throw new PluginPackagePromptOutputArtifactUnavailableError();
    }
    return active.reference;
  }

  end(lease: Readonly<PluginPackagePromptOutputCompletionLease>): void {
    const active = this.#active.get(lease.invocationId);
    if (!active || active.lease !== lease) {
      throw new PluginPackagePromptOutputArtifactUnavailableError();
    }
    this.#active.delete(lease.invocationId);
  }

  async record(
    audit: Readonly<ModelInvocationAuditRecord>,
    result: Readonly<GenerateResult>,
  ): Promise<
    Readonly<
      | { handled: false }
      | {
          handled: true;
          disposition: Readonly<{ status: 'created' | 'existing' }>;
        }
    >
  > {
    const active = this.#active.get(audit.requestId);
    if (!active) return Object.freeze({ handled: false as const });
    const plan = active.plan;
    if (
      audit.phase !== 'completed' ||
      audit.projectId !== plan.target.projectId ||
      audit.runId !== plan.runId ||
      audit.stepRunId !== plan.stepRunId ||
      audit.traceId !== plan.traceId ||
      audit.requestId !== plan.invocationId ||
      audit.provider !== plan.provider ||
      audit.model !== plan.model ||
      result.provider !== plan.provider ||
      result.model !== plan.model ||
      plan.output?.mode !== 'durable_artifact'
    ) {
      throw new PluginPackagePromptOutputArtifactConflictError();
    }
    const material = await this.#keys.active();
    try {
      const artifact = createPluginPackagePromptOutputArtifact(
        {
          projectId: plan.target.projectId,
          runId: plan.runId,
          stepRunId: plan.stepRunId,
          invocationId: plan.invocationId,
          requestedBy: plan.requestedBySubject,
          result,
          retentionPolicy: plan.output.retentionPolicy,
          keyId: material.keyId,
          key: material.key,
          sealedAtMs: this.#now(),
        },
        this.#nonceFactory,
      );
      const disposition =
        await this.#coordinator.recordWithAtomicSuccess(
          audit,
          pluginPackagePromptOutputAtomicSuccess(artifact),
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

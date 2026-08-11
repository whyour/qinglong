import {
  transitionStepRunMutation,
  type StepRunStatus,
} from '@qinglong/runtime-core/step-run';

import type {
  ModelInvocationAuditDisposition,
  ModelInvocationAuditRecord,
  ModelInvocationAuditSink,
  ModelUsage,
} from '../model-gateway/model';
import {
  MAX_MODEL_INVOCATION_RECOVERY_PAGE_SIZE,
  ModelInvocationConflictError,
  ModelInvocationRepositoryUnavailableError,
  createModelInvocationCompletionCommand,
  createModelInvocationMutationIdentity,
  createModelInvocationStartCommand,
  normalizeModelInvocationCompletionRecord,
  normalizeModelInvocationStartRecord,
  type ModelInvocationCompletionRecord,
  type ModelInvocationRepository,
  type ModelInvocationStartRecord,
} from './modelInvocation';
import {
  isQuotaAwareModelInvocationRepository,
  normalizeModelInvocationQuotaAdmission,
  type ModelInvocationQuotaAdmission,
} from '../usage/usageQuota';
import {
  isPricingAwareModelInvocationRepository,
  normalizeModelInvocationPriceQuote,
  type ModelInvocationPriceQuote,
} from '../pricing/pricing';
import {
  isPluginPackagePromptOutputCompletionRepository,
  type PluginPackagePromptOutputCompletionRepository,
} from '../prompt-output/pluginPackagePromptOutputCompletion';
import {
  PluginPackagePromptOutputArtifactConflictError,
  normalizePluginPackagePromptOutputArtifact,
  pluginPackagePromptOutputArtifactReference,
  type PluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifactReference,
} from '../prompt-output/pluginPackagePromptOutputArtifact';

const MAX_COORDINATOR_ATTEMPTS = 3;

interface CompletionTransition {
  readonly to: StepRunStatus;
  readonly outputRef?: string;
  readonly resultCode?: string;
  readonly errorSummary?: string;
}

export interface ModelInvocationRecoverySummary {
  readonly observedAtMs: number;
  readonly scanned: number;
  readonly recovered: number;
  readonly alreadyCompleted: number;
  readonly failed: number;
  readonly hasMore: boolean;
}

function sameUsage(
  left: Readonly<ModelUsage> | null,
  right: Readonly<ModelUsage> | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertStartMatchesAudit(
  startValue: ModelInvocationStartRecord,
  audit: Readonly<ModelInvocationAuditRecord>,
): Readonly<ModelInvocationStartRecord> {
  const start = normalizeModelInvocationStartRecord(startValue);
  if (
    start.invocationId !== audit.requestId ||
    start.projectId !== audit.projectId ||
    start.runId !== audit.runId ||
    start.stepRunId !== audit.stepRunId ||
    start.traceId !== audit.traceId ||
    start.provider !== audit.provider ||
    start.model !== audit.model ||
    start.policyRevision !== audit.policyRevision ||
    start.requestDigest !== audit.requestDigest ||
    start.inputBytes !== audit.inputBytes ||
    start.maxOutputTokens !== audit.maxOutputTokens ||
    start.deadlineAtMs !== audit.deadlineAtMs
  ) {
    throw new ModelInvocationConflictError();
  }
  return start;
}

function completionTransition(
  audit: Readonly<ModelInvocationAuditRecord>,
  successOutputRef?: string,
): Readonly<CompletionTransition> {
  if (audit.phase === 'completed') {
    return Object.freeze({
      to: 'succeeded',
      outputRef: successOutputRef ?? `model-invocation:${audit.requestId}`,
    });
  }
  if (audit.errorCode === 'MODEL_INVOCATION_DEADLINE_EXCEEDED') {
    return Object.freeze({
      to: 'timed_out',
      resultCode: 'model_deadline_exceeded',
      errorSummary: 'Model invocation deadline exceeded',
    });
  }
  if (
    audit.errorCode === 'MODEL_INVOCATION_ABORTED' ||
    audit.errorCode === 'MODEL_STREAM_CANCELLED' ||
    audit.errorCode === 'MODEL_INVOCATION_OUTCOME_UNKNOWN'
  ) {
    return Object.freeze({
      to: 'lost',
      resultCode: 'model_outcome_unknown',
      errorSummary: 'Model invocation outcome is unknown',
    });
  }
  return Object.freeze({
    to: 'failed',
    resultCode: 'model_provider_failed',
    errorSummary: 'Model invocation failed',
  });
}

function expectedOutcome(
  transition: Readonly<CompletionTransition>,
): ModelInvocationCompletionRecord['outcome'] {
  if (transition.to === 'succeeded') return 'succeeded';
  if (transition.to === 'timed_out') return 'timed_out';
  if (transition.to === 'lost') return 'outcome_unknown';
  return 'failed';
}

function assertCompletionMatchesAudit(
  completionValue: ModelInvocationCompletionRecord,
  start: Readonly<ModelInvocationStartRecord>,
  audit: Readonly<ModelInvocationAuditRecord>,
): Readonly<ModelInvocationCompletionRecord> {
  const completion = normalizeModelInvocationCompletionRecord(completionValue);
  const transition = completionTransition(audit);
  if (
    completion.invocationId !== start.invocationId ||
    completion.projectId !== start.projectId ||
    completion.runId !== start.runId ||
    completion.stepRunId !== start.stepRunId ||
    completion.traceId !== start.traceId ||
    completion.startDigest !== start.startDigest ||
    completion.outcome !== expectedOutcome(transition) ||
    completion.outputBytes !== audit.outputBytes ||
    !sameUsage(completion.usage, audit.usage) ||
    completion.errorCode !== audit.errorCode
  ) {
    throw new ModelInvocationConflictError();
  }
  return completion;
}

function identity(record: Readonly<ModelInvocationAuditRecord>): Readonly<{
  projectId: string;
  runId: string;
  stepRunId: string;
}> {
  return Object.freeze({
    projectId: record.projectId,
    runId: record.runId,
    stepRunId: record.stepRunId,
  });
}

export class DurableModelInvocationCoordinator
  implements ModelInvocationAuditSink
{
  constructor(private readonly repository: ModelInvocationRepository) {
    if (
      !repository ||
      typeof repository.findStart !== 'function' ||
      typeof repository.findCompletion !== 'function' ||
      typeof repository.readAuthority !== 'function' ||
      typeof repository.admit !== 'function' ||
      typeof repository.complete !== 'function'
    ) {
      throw new ModelInvocationRepositoryUnavailableError();
    }
  }

  async record(
    record: Readonly<ModelInvocationAuditRecord>,
  ): Promise<Readonly<ModelInvocationAuditDisposition>> {
    return record.phase === 'admitted'
      ? this.#admit(record)
      : this.#complete(record);
  }

  async recordWithQuota(
    record: Readonly<ModelInvocationAuditRecord>,
    admissionValue: Readonly<ModelInvocationQuotaAdmission>,
  ): Promise<Readonly<ModelInvocationAuditDisposition>> {
    const admission = normalizeModelInvocationQuotaAdmission(admissionValue);
    if (
      record.phase !== 'admitted' ||
      record.requestId !== admission.invocationId ||
      record.projectId !== admission.projectId ||
      record.policyRevision !== admission.modelPolicyRevision ||
      !isQuotaAwareModelInvocationRepository(this.repository)
    ) {
      throw new ModelInvocationConflictError();
    }
    return this.#admit(record, admission);
  }

  async recordWithPricing(
    record: Readonly<ModelInvocationAuditRecord>,
    quoteValue: Readonly<ModelInvocationPriceQuote>,
    admissionValue?: Readonly<ModelInvocationQuotaAdmission>,
  ): Promise<Readonly<ModelInvocationAuditDisposition>> {
    const quote = normalizeModelInvocationPriceQuote(quoteValue);
    const admission =
      admissionValue === undefined
        ? undefined
        : normalizeModelInvocationQuotaAdmission(admissionValue);
    if (
      record.phase !== 'admitted' ||
      record.requestId !== quote.invocationId ||
      record.projectId !== quote.projectId ||
      record.policyRevision !== quote.modelPolicyRevision ||
      record.provider !== quote.provider ||
      record.model !== quote.model ||
      (admission !== undefined &&
        (admission.invocationId !== quote.invocationId ||
          admission.projectId !== quote.projectId ||
          admission.modelPolicyRevision !== quote.modelPolicyRevision)) ||
      !isPricingAwareModelInvocationRepository(this.repository)
    ) {
      throw new ModelInvocationConflictError();
    }
    return this.#admit(record, admission, quote);
  }

  async recordWithPromptOutputArtifact(
    record: Readonly<ModelInvocationAuditRecord>,
    artifactValue: PluginPackagePromptOutputArtifact,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      reference: Readonly<PluginPackagePromptOutputArtifactReference>;
    }>
  > {
    const artifact = normalizePluginPackagePromptOutputArtifact(artifactValue);
    if (
      record.phase !== 'completed' ||
      record.requestId !== artifact.invocationId ||
      record.projectId !== artifact.projectId ||
      record.runId !== artifact.runId ||
      record.stepRunId !== artifact.stepRunId ||
      record.provider !== artifact.provider ||
      record.model !== artifact.model ||
      record.outputBytes !== artifact.outputBytes ||
      !isPluginPackagePromptOutputCompletionRepository(this.repository)
    ) {
      throw new PluginPackagePromptOutputArtifactConflictError();
    }
    const result = await this.#complete(record, artifact);
    if (!result.reference) {
      throw new PluginPackagePromptOutputArtifactConflictError();
    }
    return Object.freeze({
      status: result.status,
      reference: result.reference,
    });
  }

  async #admit(
    audit: Readonly<ModelInvocationAuditRecord>,
    admission?: Readonly<ModelInvocationQuotaAdmission>,
    quote?: Readonly<ModelInvocationPriceQuote>,
  ): Promise<Readonly<ModelInvocationAuditDisposition>> {
    const existing = await this.repository.findStart(audit.requestId);
    if (existing) {
      assertStartMatchesAudit(existing, audit);
      if (admission) {
        if (!isQuotaAwareModelInvocationRepository(this.repository)) {
          throw new ModelInvocationConflictError();
        }
        const reservation = await this.repository.findQuotaReservation(
          audit.requestId,
        );
        if (
          !reservation ||
          reservation.admissionDigest !== admission.admissionDigest
        ) {
          throw new ModelInvocationConflictError();
        }
      }
      if (quote) {
        if (!isPricingAwareModelInvocationRepository(this.repository)) {
          throw new ModelInvocationConflictError();
        }
        const storedQuote = await this.repository.findPriceQuote(
          audit.requestId,
        );
        if (!storedQuote || storedQuote.quoteDigest !== quote.quoteDigest) {
          throw new ModelInvocationConflictError();
        }
      }
      return Object.freeze({ status: 'existing' });
    }
    for (let attempt = 0; attempt < MAX_COORDINATOR_ATTEMPTS; attempt += 1) {
      const authority = await this.repository.readAuthority(identity(audit));
      if (
        !authority ||
        authority.stepRun.status !== 'ready' ||
        authority.stepRun.kind !== 'model'
      ) {
        throw new ModelInvocationConflictError();
      }
      const mutationIdentity = createModelInvocationMutationIdentity(
        audit.requestId,
        'start',
      );
      const command = createModelInvocationStartCommand(
        audit,
        transitionStepRunMutation(
          authority.stepRun,
          {
            expectedVersion: authority.stepRun.version,
            expectedDigest: authority.stepRun.stepRunDigest,
            mutationId: mutationIdentity.mutationId,
            to: 'running',
            atMs: audit.occurredAtMs,
          },
          {
            expectedRunVersion: authority.runVersion,
            expectedRunEventSequence: authority.runEventSequence,
            eventId: mutationIdentity.eventId,
            dedupeKey: mutationIdentity.dedupeKey,
            actor: { type: 'executor', id: 'model-gateway' },
          },
        ),
      );
      try {
        const result = quote
          ? await (() => {
              if (!isPricingAwareModelInvocationRepository(this.repository)) {
                throw new ModelInvocationConflictError();
              }
              return this.repository.admitWithPricing(
                command,
                quote,
                admission,
              );
            })()
          : admission
          ? await (() => {
              if (!isQuotaAwareModelInvocationRepository(this.repository)) {
                throw new ModelInvocationConflictError();
              }
              return this.repository.admitWithQuota(command, admission);
            })()
          : await this.repository.admit(command);
        return Object.freeze({ status: result.status });
      } catch (error) {
        const stored = await this.#startAfterFailure(
          audit,
          error,
          admission,
          quote,
        );
        if (stored) return Object.freeze({ status: 'existing' });
        if (
          !(error instanceof ModelInvocationConflictError) ||
          attempt + 1 >= MAX_COORDINATOR_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    throw new ModelInvocationConflictError();
  }

  async #complete(
    audit: Readonly<ModelInvocationAuditRecord>,
    artifactValue?: Readonly<PluginPackagePromptOutputArtifact>,
  ): Promise<
    Readonly<
      ModelInvocationAuditDisposition & {
        reference?: Readonly<PluginPackagePromptOutputArtifactReference>;
      }
    >
  > {
    const artifact = artifactValue
      ? normalizePluginPackagePromptOutputArtifact(artifactValue)
      : undefined;
    const artifactRepository = artifact
      ? (this.repository as ModelInvocationRepository &
          PluginPackagePromptOutputCompletionRepository)
      : undefined;
    const startValue = await this.repository.findStart(audit.requestId);
    if (!startValue) throw new ModelInvocationConflictError();
    const start = assertStartMatchesAudit(startValue, audit);
    const existing = await this.repository.findCompletion(audit.requestId);
    if (existing) {
      assertCompletionMatchesAudit(existing, start, audit);
      if (artifact && artifactRepository) {
        const stored = await artifactRepository.findPromptOutputArtifact(
          artifact.artifactId,
        );
        if (!stored || JSON.stringify(stored) !== JSON.stringify(artifact)) {
          throw new PluginPackagePromptOutputArtifactConflictError();
        }
        return Object.freeze({
          status: 'existing' as const,
          reference: pluginPackagePromptOutputArtifactReference(stored),
        });
      }
      return Object.freeze({ status: 'existing' as const });
    }
    for (let attempt = 0; attempt < MAX_COORDINATOR_ATTEMPTS; attempt += 1) {
      const authority = await this.repository.readAuthority(identity(audit));
      if (
        !authority ||
        authority.stepRun.status !== 'running' ||
        authority.stepRun.version !== start.startedStepRunVersion ||
        authority.stepRun.stepRunDigest !== start.startedStepRunDigest
      ) {
        throw new ModelInvocationConflictError();
      }
      const transition = completionTransition(audit, artifact?.artifactId);
      const mutationIdentity = createModelInvocationMutationIdentity(
        audit.requestId,
        'completion',
      );
      const command = createModelInvocationCompletionCommand(
        start,
        audit,
        transitionStepRunMutation(
          authority.stepRun,
          {
            expectedVersion: authority.stepRun.version,
            expectedDigest: authority.stepRun.stepRunDigest,
            mutationId: mutationIdentity.mutationId,
            to: transition.to,
            atMs: audit.occurredAtMs,
            ...(transition.outputRef === undefined
              ? {}
              : { outputRef: transition.outputRef }),
            ...(transition.resultCode === undefined
              ? {}
              : { resultCode: transition.resultCode }),
            ...(transition.errorSummary === undefined
              ? {}
              : { errorSummary: transition.errorSummary }),
          },
          {
            expectedRunVersion: authority.runVersion,
            expectedRunEventSequence: authority.runEventSequence,
            eventId: mutationIdentity.eventId,
            dedupeKey: mutationIdentity.dedupeKey,
            actor: { type: 'executor', id: 'model-gateway' },
          },
        ),
        artifact?.artifactId,
      );
      try {
        const pricingAware = isPricingAwareModelInvocationRepository(
          this.repository,
        );
        const quote = pricingAware
          ? await this.repository.findPriceQuote(audit.requestId)
          : null;
        const quotaAware = isQuotaAwareModelInvocationRepository(
          this.repository,
        );
        const reservation = quotaAware
          ? await this.repository.findQuotaReservation(audit.requestId)
          : null;
        const result =
          artifactRepository && artifact
            ? await artifactRepository.completeWithPromptOutputArtifact(
                command,
                artifact,
              )
            : pricingAware && quote
            ? await this.repository.completeWithPricing(command)
            : quotaAware && reservation
            ? await this.repository.completeWithQuota(command)
            : await this.repository.complete(command);
        return Object.freeze({
          status: result.status,
          ...(artifact && artifactRepository
            ? {
                reference: pluginPackagePromptOutputArtifactReference(artifact),
              }
            : {}),
        });
      } catch (error) {
        const stored = await this.#completionAfterFailure(
          start,
          audit,
          error,
          artifact,
          artifactRepository,
        );
        if (stored) {
          return Object.freeze({
            status: 'existing' as const,
            ...(artifact
              ? {
                  reference:
                    pluginPackagePromptOutputArtifactReference(artifact),
                }
              : {}),
          });
        }
        if (
          !(error instanceof ModelInvocationConflictError) ||
          attempt + 1 >= MAX_COORDINATOR_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    throw new ModelInvocationConflictError();
  }

  async #startAfterFailure(
    audit: Readonly<ModelInvocationAuditRecord>,
    original: unknown,
    admission?: Readonly<ModelInvocationQuotaAdmission>,
    quote?: Readonly<ModelInvocationPriceQuote>,
  ): Promise<Readonly<ModelInvocationStartRecord> | null> {
    try {
      const stored = await this.repository.findStart(audit.requestId);
      if (!stored) return null;
      const start = assertStartMatchesAudit(stored, audit);
      if (admission) {
        if (!isQuotaAwareModelInvocationRepository(this.repository)) {
          throw original;
        }
        const reservation = await this.repository.findQuotaReservation(
          audit.requestId,
        );
        if (
          !reservation ||
          reservation.admissionDigest !== admission.admissionDigest
        ) {
          throw original;
        }
      }
      if (quote) {
        if (!isPricingAwareModelInvocationRepository(this.repository)) {
          throw original;
        }
        const storedQuote = await this.repository.findPriceQuote(
          audit.requestId,
        );
        if (!storedQuote || storedQuote.quoteDigest !== quote.quoteDigest) {
          throw original;
        }
      }
      return start;
    } catch {
      throw original;
    }
  }

  async #completionAfterFailure(
    start: Readonly<ModelInvocationStartRecord>,
    audit: Readonly<ModelInvocationAuditRecord>,
    original: unknown,
    artifact?: Readonly<PluginPackagePromptOutputArtifact>,
    artifactRepository?: PluginPackagePromptOutputCompletionRepository,
  ): Promise<Readonly<ModelInvocationCompletionRecord> | null> {
    try {
      const stored = await this.repository.findCompletion(audit.requestId);
      if (!stored) return null;
      const completion = assertCompletionMatchesAudit(stored, start, audit);
      if (artifact) {
        if (!artifactRepository) throw original;
        const storedArtifact =
          await artifactRepository.findPromptOutputArtifact(
            artifact.artifactId,
          );
        if (
          !storedArtifact ||
          JSON.stringify(storedArtifact) !== JSON.stringify(artifact)
        ) {
          throw original;
        }
      }
      return completion;
    } catch {
      throw original;
    }
  }
}

export class DurableModelInvocationRecovery {
  constructor(
    private readonly repository: ModelInvocationRepository,
    private readonly coordinator = new DurableModelInvocationCoordinator(
      repository,
    ),
  ) {}

  async recover(
    limit = MAX_MODEL_INVOCATION_RECOVERY_PAGE_SIZE,
  ): Promise<Readonly<ModelInvocationRecoverySummary>> {
    const page = await this.repository.listIncomplete(limit);
    let recovered = 0;
    let alreadyCompleted = 0;
    let failed = 0;
    for (const start of page.candidates) {
      try {
        const result = await this.coordinator.record(
          Object.freeze({
            phase: 'failed',
            projectId: start.projectId,
            runId: start.runId,
            stepRunId: start.stepRunId,
            traceId: start.traceId,
            requestId: start.invocationId,
            provider: start.provider,
            model: start.model,
            policyRevision: start.policyRevision,
            requestDigest: start.requestDigest,
            deadlineAtMs: start.deadlineAtMs,
            inputBytes: start.inputBytes,
            maxOutputTokens: start.maxOutputTokens,
            outputBytes: 0,
            usage: null,
            errorCode: 'MODEL_INVOCATION_OUTCOME_UNKNOWN',
            occurredAtMs: page.observedAtMs,
          }),
        );
        if (result.status === 'created') recovered += 1;
        else alreadyCompleted += 1;
      } catch {
        failed += 1;
      }
    }
    return Object.freeze({
      observedAtMs: page.observedAtMs,
      scanned: page.candidates.length,
      recovered,
      alreadyCompleted,
      failed,
      hasMore: page.hasMore,
    });
  }
}

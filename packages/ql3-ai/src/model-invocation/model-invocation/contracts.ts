import type { StepRunRecord, StepRunMutation } from '@qinglong/runtime-core/step-run';
import type { ModelUsage } from '../../model-gateway/model';

export const MODEL_INVOCATION_START_SCHEMA =
  'qinglong/model-invocation-start@v1' as const;
export const MODEL_INVOCATION_START_COMMAND_SCHEMA =
  'qinglong/model-invocation-start-command@v1' as const;
export const MODEL_INVOCATION_COMPLETION_SCHEMA =
  'qinglong/model-invocation-completion@v1' as const;
export const MODEL_INVOCATION_COMPLETION_COMMAND_SCHEMA =
  'qinglong/model-invocation-completion-command@v1' as const;

export const MAX_MODEL_INVOCATION_RECORD_JSON_BYTES = 24 * 1024;
export const MAX_MODEL_INVOCATION_RECOVERY_PAGE_SIZE = 128;
export const MODEL_INVOCATION_OUTCOMES = [
  'succeeded',
  'failed',
  'timed_out',
  'outcome_unknown',
] as const;
export const MODEL_INVOCATION_MUTATION_PHASES = [
  'start',
  'completion',
  'resolution',
] as const;

export type ModelInvocationOutcome = (typeof MODEL_INVOCATION_OUTCOMES)[number];
export type ModelInvocationMutationPhase =
  (typeof MODEL_INVOCATION_MUTATION_PHASES)[number];

export interface ModelInvocationStartRecord {
  readonly schema: typeof MODEL_INVOCATION_START_SCHEMA;
  readonly invocationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly traceId: string;
  readonly provider: string;
  readonly model: string;
  readonly policyRevision: string;
  readonly requestDigest: string;
  readonly inputBytes: number;
  readonly maxOutputTokens: number;
  readonly deadlineAtMs: number;
  readonly startedStepRunVersion: number;
  readonly stepRunMutationId: string;
  readonly stepRunMutationDigest: string;
  readonly startedStepRunDigest: string;
  readonly runEventId: string;
  readonly admittedAtMs: number;
  readonly startDigest: string;
}

export interface ModelInvocationStartCommand {
  readonly schema: typeof MODEL_INVOCATION_START_COMMAND_SCHEMA;
  readonly start: Readonly<ModelInvocationStartRecord>;
  readonly stepRunMutation: Readonly<StepRunMutation>;
  readonly commandDigest: string;
}

export interface ModelInvocationCompletionRecord {
  readonly schema: typeof MODEL_INVOCATION_COMPLETION_SCHEMA;
  readonly invocationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly traceId: string;
  readonly startDigest: string;
  readonly outcome: ModelInvocationOutcome;
  readonly outputBytes: number;
  readonly usage: Readonly<ModelUsage> | null;
  readonly errorCode: string | null;
  readonly completedStepRunVersion: number;
  readonly stepRunMutationId: string;
  readonly stepRunMutationDigest: string;
  readonly completedStepRunDigest: string;
  readonly runEventId: string;
  readonly completedAtMs: number;
  readonly completionDigest: string;
}

export interface ModelInvocationCompletionCommand {
  readonly schema: typeof MODEL_INVOCATION_COMPLETION_COMMAND_SCHEMA;
  readonly start: Readonly<ModelInvocationStartRecord>;
  readonly completion: Readonly<ModelInvocationCompletionRecord>;
  readonly stepRunMutation: Readonly<StepRunMutation>;
  readonly commandDigest: string;
}

export interface CommitModelInvocationResult<T> {
  readonly status: 'created' | 'existing';
  readonly record: Readonly<T>;
}

export interface ModelInvocationAuthoritySnapshot {
  readonly projectId: string;
  readonly runId: string;
  readonly runVersion: number;
  readonly runEventSequence: number;
  readonly stepRun: Readonly<StepRunRecord>;
}

export interface ModelInvocationRecoveryPage {
  readonly observedAtMs: number;
  readonly candidates: readonly Readonly<ModelInvocationStartRecord>[];
  readonly hasMore: boolean;
}

export interface ModelInvocationRepository {
  findStart(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationStartRecord> | null>;
  findCompletion(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationCompletionRecord> | null>;
  readAuthority(
    identity: Readonly<{
      projectId: string;
      runId: string;
      stepRunId: string;
    }>,
  ): Promise<Readonly<ModelInvocationAuthoritySnapshot> | null>;
  listIncomplete(limit: number): Promise<Readonly<ModelInvocationRecoveryPage>>;
  admit(
    command: ModelInvocationStartCommand,
  ): Promise<Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>>;
  complete(
    command: ModelInvocationCompletionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
  >;
}

export class InvalidModelInvocationError extends TypeError {
  readonly code = 'MODEL_INVOCATION_INVALID';

  constructor(message: string) {
    super(`Model invocation is invalid: ${message}`);
    this.name = 'InvalidModelInvocationError';
  }
}

export class ModelInvocationConflictError extends Error {
  readonly code = 'MODEL_INVOCATION_CONFLICT';

  constructor() {
    super('Model invocation conflicts with durable state');
    this.name = 'ModelInvocationConflictError';
  }
}

export class ModelInvocationRepositoryUnavailableError extends Error {
  readonly code = 'MODEL_INVOCATION_REPOSITORY_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Model invocation repository is unavailable', options);
    this.name = 'ModelInvocationRepositoryUnavailableError';
  }
}

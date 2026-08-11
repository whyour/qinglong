import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

// Model Invocation owns durable ambiguity resolution alongside its transaction contract.

import {
  normalizeStepRunMutation,
  transitionStepRunMutation,
  type StepRunMutation,
  type StepRunStatus,
} from '@qinglong/runtime-core/step-run';

import {
  MAX_MODEL_INVOCATION_RECORD_JSON_BYTES,
  ModelInvocationConflictError,
  ModelInvocationRepositoryUnavailableError,
  createModelInvocationMutationIdentity,
  normalizeModelInvocationCompletionRecord,
  type CommitModelInvocationResult,
  type ModelInvocationCompletionRecord,
  type ModelInvocationRepository,
} from './modelInvocation';

export const MODEL_INVOCATION_RESOLUTION_SCHEMA =
  'qinglong/model-invocation-resolution@v1' as const;
export const MODEL_INVOCATION_RESOLUTION_COMMAND_SCHEMA =
  'qinglong/model-invocation-resolution-command@v1' as const;
export const MODEL_INVOCATION_RESOLUTION_DECISIONS = [
  'retry',
  'fail',
  'cancel',
] as const;

export type ModelInvocationResolutionDecision =
  (typeof MODEL_INVOCATION_RESOLUTION_DECISIONS)[number];

export interface ModelInvocationResolutionRecord {
  readonly schema: typeof MODEL_INVOCATION_RESOLUTION_SCHEMA;
  readonly resolutionId: string;
  readonly invocationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly traceId: string;
  readonly completionDigest: string;
  readonly decision: ModelInvocationResolutionDecision;
  readonly resolvedByUserId: string;
  readonly resolvedStepRunVersion: number;
  readonly stepRunMutationId: string;
  readonly stepRunMutationDigest: string;
  readonly resolvedStepRunDigest: string;
  readonly runEventId: string;
  readonly resolvedAtMs: number;
  readonly resolutionDigest: string;
}

export interface ModelInvocationResolutionCommand {
  readonly schema: typeof MODEL_INVOCATION_RESOLUTION_COMMAND_SCHEMA;
  readonly completion: Readonly<ModelInvocationCompletionRecord>;
  readonly resolution: Readonly<ModelInvocationResolutionRecord>;
  readonly stepRunMutation: Readonly<StepRunMutation>;
  readonly commandDigest: string;
}

export interface ModelInvocationResolutionRepository
  extends ModelInvocationRepository {
  findResolution(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationResolutionRecord> | null>;
  resolve(
    command: ModelInvocationResolutionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationResolutionRecord>>
  >;
}

export class InvalidModelInvocationResolutionError extends TypeError {
  readonly code = 'MODEL_INVOCATION_RESOLUTION_INVALID';

  constructor(message: string) {
    super(`Model invocation resolution is invalid: ${message}`);
    this.name = 'InvalidModelInvocationResolutionError';
  }
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RESOLUTION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-resolution-digest@v1\0',
  'utf8',
);
const RESOLUTION_COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-resolution-command-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidModelInvocationResolutionError(message);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function hash(domain: Uint8Array, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function withoutDigest(
  value: Readonly<ModelInvocationResolutionRecord>,
): Omit<ModelInvocationResolutionRecord, 'resolutionDigest'> {
  const { resolutionDigest: _resolutionDigest, ...unsigned } = value;
  return unsigned;
}

export function resolutionTransition(
  decision: ModelInvocationResolutionDecision,
): Readonly<{
  to: StepRunStatus;
  resultCode?: string;
  errorSummary?: string;
}> {
  if (decision === 'retry') return Object.freeze({ to: 'ready' });
  if (decision === 'fail') {
    return Object.freeze({
      to: 'failed',
      resultCode: 'model_outcome_rejected',
      errorSummary: 'Unknown model outcome rejected by operator',
    });
  }
  if (decision === 'cancel') {
    return Object.freeze({
      to: 'cancelled',
      resultCode: 'model_outcome_cancelled',
    });
  }
  return invalid('decision is invalid');
}

export function normalizeModelInvocationResolutionRecord(
  value: ModelInvocationResolutionRecord,
): Readonly<ModelInvocationResolutionRecord> {
  const candidate = dataRecord(value, 'resolution record');
  exactKeys(
    candidate,
    [
      'completionDigest',
      'decision',
      'invocationId',
      'projectId',
      'resolutionDigest',
      'resolutionId',
      'resolvedAtMs',
      'resolvedByUserId',
      'resolvedStepRunDigest',
      'resolvedStepRunVersion',
      'runEventId',
      'runId',
      'schema',
      'stepRunId',
      'stepRunMutationDigest',
      'stepRunMutationId',
      'traceId',
    ],
    'resolution record',
  );
  if (
    value.schema !== MODEL_INVOCATION_RESOLUTION_SCHEMA ||
    !MODEL_INVOCATION_RESOLUTION_DECISIONS.includes(value.decision)
  ) {
    invalid('resolution schema or decision is invalid');
  }
  const normalized = Object.freeze({
    schema: MODEL_INVOCATION_RESOLUTION_SCHEMA,
    resolutionId: identifier(value.resolutionId, 'resolution id'),
    invocationId: identifier(value.invocationId, 'invocation id'),
    projectId: identifier(value.projectId, 'project id'),
    runId: identifier(value.runId, 'Run id'),
    stepRunId: identifier(value.stepRunId, 'StepRun id'),
    traceId: identifier(value.traceId, 'trace id'),
    completionDigest: digest(value.completionDigest, 'completion digest'),
    decision: value.decision,
    resolvedByUserId: identifier(value.resolvedByUserId, 'resolving user id'),
    resolvedStepRunVersion: integer(
      value.resolvedStepRunVersion,
      4,
      2_147_483_647,
      'resolved StepRun version',
    ),
    stepRunMutationId: identifier(
      value.stepRunMutationId,
      'StepRun mutation id',
    ),
    stepRunMutationDigest: digest(
      value.stepRunMutationDigest,
      'StepRun mutation digest',
    ),
    resolvedStepRunDigest: digest(
      value.resolvedStepRunDigest,
      'resolved StepRun digest',
    ),
    runEventId: identifier(value.runEventId, 'RunEvent id'),
    resolvedAtMs: integer(
      value.resolvedAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'resolved time',
    ),
    resolutionDigest: digest(value.resolutionDigest, 'resolution digest'),
  });
  const identity = createModelInvocationMutationIdentity(
    normalized.invocationId,
    'resolution',
  );
  if (
    normalized.resolutionId !== identity.dedupeKey ||
    normalized.stepRunMutationId !== identity.mutationId ||
    normalized.runEventId !== identity.eventId ||
    hash(RESOLUTION_DIGEST_DOMAIN, withoutDigest(normalized)) !==
      normalized.resolutionDigest
  ) {
    invalid('resolution identity or digest is invalid');
  }
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_MODEL_INVOCATION_RECORD_JSON_BYTES
  ) {
    invalid('resolution record exceeds its JSON budget');
  }
  return normalized;
}

export function createModelInvocationResolutionCommand(
  completionValue: ModelInvocationCompletionRecord,
  decision: ModelInvocationResolutionDecision,
  resolvedByUserIdValue: string,
  mutationValue: StepRunMutation,
): Readonly<ModelInvocationResolutionCommand> {
  const completion = normalizeModelInvocationCompletionRecord(completionValue);
  const transition = resolutionTransition(decision);
  const resolvedByUserId = identifier(
    resolvedByUserIdValue,
    'resolving user id',
  );
  const mutation = normalizeStepRunMutation(mutationValue);
  const identity = createModelInvocationMutationIdentity(
    completion.invocationId,
    'resolution',
  );
  if (
    completion.outcome !== 'outcome_unknown' ||
    mutation.previousStatus !== 'lost' ||
    mutation.expectedStepRunVersion !== completion.completedStepRunVersion ||
    mutation.expectedStepRunDigest !== completion.completedStepRunDigest ||
    mutation.mutationId !== identity.mutationId ||
    mutation.runId !== completion.runId ||
    mutation.stepRun.id !== completion.stepRunId ||
    mutation.stepRun.runId !== completion.runId ||
    mutation.stepRun.kind !== 'model' ||
    mutation.stepRun.status !== transition.to ||
    mutation.event.id !== identity.eventId ||
    mutation.event.dedupeKey !== identity.dedupeKey ||
    mutation.event.type !== `step.${transition.to}` ||
    mutation.event.actorType !== 'user' ||
    mutation.event.actorId !== resolvedByUserId ||
    mutation.stepRun.updatedAtMs < completion.completedAtMs ||
    (transition.to === 'ready'
      ? mutation.stepRun.outputRef !== null ||
        mutation.stepRun.resultCode !== null ||
        mutation.stepRun.errorSummary !== null
      : mutation.stepRun.resultCode !== transition.resultCode ||
        mutation.stepRun.errorSummary !==
          (transition.errorSummary === undefined
            ? null
            : transition.errorSummary))
  ) {
    invalid('resolution completion or StepRun mutation is not exact');
  }
  const unsigned = Object.freeze({
    schema: MODEL_INVOCATION_RESOLUTION_SCHEMA,
    resolutionId: identity.dedupeKey,
    invocationId: completion.invocationId,
    projectId: completion.projectId,
    runId: completion.runId,
    stepRunId: completion.stepRunId,
    traceId: completion.traceId,
    completionDigest: completion.completionDigest,
    decision,
    resolvedByUserId,
    resolvedStepRunVersion: mutation.stepRun.version,
    stepRunMutationId: mutation.mutationId,
    stepRunMutationDigest: mutation.mutationDigest,
    resolvedStepRunDigest: mutation.stepRun.stepRunDigest,
    runEventId: mutation.event.id,
    resolvedAtMs: mutation.stepRun.updatedAtMs,
  });
  const resolution = normalizeModelInvocationResolutionRecord({
    ...unsigned,
    resolutionDigest: hash(RESOLUTION_DIGEST_DOMAIN, unsigned),
  });
  const commandUnsigned = Object.freeze({
    schema: MODEL_INVOCATION_RESOLUTION_COMMAND_SCHEMA,
    completion,
    resolution,
    stepRunMutation: mutation,
  });
  return Object.freeze({
    ...commandUnsigned,
    commandDigest: hash(RESOLUTION_COMMAND_DIGEST_DOMAIN, commandUnsigned),
  });
}

export function normalizeModelInvocationResolutionCommand(
  value: ModelInvocationResolutionCommand,
): Readonly<ModelInvocationResolutionCommand> {
  const candidate = dataRecord(value, 'resolution command');
  exactKeys(
    candidate,
    ['commandDigest', 'completion', 'resolution', 'schema', 'stepRunMutation'],
    'resolution command',
  );
  if (value.schema !== MODEL_INVOCATION_RESOLUTION_COMMAND_SCHEMA) {
    invalid('resolution command schema is invalid');
  }
  const completion = normalizeModelInvocationCompletionRecord(value.completion);
  const resolution = normalizeModelInvocationResolutionRecord(value.resolution);
  const mutation = normalizeStepRunMutation(value.stepRunMutation);
  const canonical = createModelInvocationResolutionCommand(
    completion,
    resolution.decision,
    resolution.resolvedByUserId,
    mutation,
  );
  if (
    canonical.resolution.resolutionDigest !== resolution.resolutionDigest ||
    digest(value.commandDigest, 'command digest') !== canonical.commandDigest
  ) {
    invalid('resolution command is not canonical');
  }
  return canonical;
}

export function assertResolutionMatchesDecision(
  resolutionValue: ModelInvocationResolutionRecord,
  completionValue: ModelInvocationCompletionRecord,
  decision: ModelInvocationResolutionDecision,
  resolvedByUserId: string,
): Readonly<ModelInvocationResolutionRecord> {
  const resolution = normalizeModelInvocationResolutionRecord(resolutionValue);
  const completion = normalizeModelInvocationCompletionRecord(completionValue);
  if (
    resolution.invocationId !== completion.invocationId ||
    resolution.projectId !== completion.projectId ||
    resolution.runId !== completion.runId ||
    resolution.stepRunId !== completion.stepRunId ||
    resolution.traceId !== completion.traceId ||
    resolution.completionDigest !== completion.completionDigest ||
    resolution.decision !== decision ||
    resolution.resolvedByUserId !== resolvedByUserId
  ) {
    throw new ModelInvocationConflictError();
  }
  return resolution;
}

export interface ResolveModelInvocationOptions {
  readonly invocationId: string;
  readonly decision: ModelInvocationResolutionDecision;
  readonly resolvedByUserId: string;
  readonly resolvedAtMs: number;
}

const MAX_RESOLUTION_COORDINATOR_ATTEMPTS = 3;

export class DurableModelInvocationResolutionCoordinator {
  constructor(
    private readonly repository: ModelInvocationResolutionRepository,
  ) {
    if (
      !repository ||
      typeof repository.findCompletion !== 'function' ||
      typeof repository.findResolution !== 'function' ||
      typeof repository.readAuthority !== 'function' ||
      typeof repository.resolve !== 'function'
    ) {
      throw new ModelInvocationRepositoryUnavailableError();
    }
  }

  async resolve(
    optionsValue: ResolveModelInvocationOptions,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationResolutionRecord>>
  > {
    const options = dataRecord(optionsValue, 'resolution options');
    exactKeys(
      options,
      ['decision', 'invocationId', 'resolvedAtMs', 'resolvedByUserId'],
      'resolution options',
    );
    const invocationId = identifier(optionsValue.invocationId, 'invocation id');
    const decision = optionsValue.decision;
    resolutionTransition(decision);
    const resolvedByUserId = identifier(
      optionsValue.resolvedByUserId,
      'resolving user id',
    );
    const resolvedAtMs = integer(
      optionsValue.resolvedAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'resolved time',
    );
    const completion = await this.repository.findCompletion(invocationId);
    if (!completion || completion.outcome !== 'outcome_unknown') {
      throw new ModelInvocationConflictError();
    }
    const existing = await this.repository.findResolution(invocationId);
    if (existing) {
      return Object.freeze({
        status: 'existing',
        record: assertResolutionMatchesDecision(
          existing,
          completion,
          decision,
          resolvedByUserId,
        ),
      });
    }

    for (
      let attempt = 0;
      attempt < MAX_RESOLUTION_COORDINATOR_ATTEMPTS;
      attempt += 1
    ) {
      const authority = await this.repository.readAuthority({
        projectId: completion.projectId,
        runId: completion.runId,
        stepRunId: completion.stepRunId,
      });
      if (
        !authority ||
        authority.stepRun.kind !== 'model' ||
        authority.stepRun.status !== 'lost' ||
        authority.stepRun.version !== completion.completedStepRunVersion ||
        authority.stepRun.stepRunDigest !== completion.completedStepRunDigest
      ) {
        throw new ModelInvocationConflictError();
      }
      const transition = resolutionTransition(decision);
      const identity = createModelInvocationMutationIdentity(
        invocationId,
        'resolution',
      );
      const command = createModelInvocationResolutionCommand(
        completion,
        decision,
        resolvedByUserId,
        transitionStepRunMutation(
          authority.stepRun,
          {
            expectedVersion: authority.stepRun.version,
            expectedDigest: authority.stepRun.stepRunDigest,
            mutationId: identity.mutationId,
            to: transition.to,
            atMs: resolvedAtMs,
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
            eventId: identity.eventId,
            dedupeKey: identity.dedupeKey,
            actor: { type: 'user', id: resolvedByUserId },
          },
        ),
      );
      try {
        return await this.repository.resolve(command);
      } catch (error) {
        const stored = await this.#resolutionAfterFailure(
          completion,
          decision,
          resolvedByUserId,
          error,
        );
        if (stored) {
          return Object.freeze({ status: 'existing', record: stored });
        }
        if (
          !(error instanceof ModelInvocationConflictError) ||
          attempt + 1 >= MAX_RESOLUTION_COORDINATOR_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    throw new ModelInvocationConflictError();
  }

  async #resolutionAfterFailure(
    completion: Readonly<ModelInvocationCompletionRecord>,
    decision: ModelInvocationResolutionDecision,
    resolvedByUserId: string,
    original: unknown,
  ): Promise<Readonly<ModelInvocationResolutionRecord> | null> {
    try {
      const stored = await this.repository.findResolution(
        completion.invocationId,
      );
      return stored
        ? assertResolutionMatchesDecision(
            stored,
            completion,
            decision,
            resolvedByUserId,
          )
        : null;
    } catch {
      throw original;
    }
  }
}

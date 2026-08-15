import { createHash } from 'node:crypto';

import type { RunRepositoryReader } from '../run/runRepository';
import {
  normalizeStepRunRecord,
  transitionStepRunMutation,
  type StepRunRepository,
} from '../run/stepRun';
import {
  normalizeToolExecutionCompletionRecord,
  ToolExecutionCompletionConflictError,
  type ToolExecutionCompletionRecord,
} from './toolExecutionCompletion';
import {
  createToolExecutionFailureCompletionCommand,
  createToolExecutionFailureResult,
  normalizeToolExecutionFailureCompletionRecord,
  ToolExecutionFailureCompletionConflictError,
  ToolExecutionFailureCompletionUnavailableError,
  toolExecutionFailureCompletionRecord,
  type ToolExecutionFailureCompletionRecord,
  type ToolExecutionFailureCompletionRepository,
  type ToolExecutionFailureOutcome,
} from './toolExecutionFailureCompletion';
import {
  normalizeToolExecutionStartBarrierRecord,
  type ToolExecutionStartBarrierRecord,
} from './toolExecutionStartBarrier';
import {
  executeAndCompleteTrustedToolSuccess,
  type TrustedToolSuccessCompletionDependencies,
  type TrustedToolSuccessCompletionResult,
} from './trustedToolSuccessCompletion';
import {
  TrustedToolExecutionDeadlineExceededError,
  TrustedToolExecutionFailedError,
} from './trustedToolExecution';
import type { ToolJsonValue } from './tool-registry/toolRegistry';

export {
  openTrustedToolSuccessCompletion,
  type TrustedToolSuccessCompletionReadDependencies,
  type TrustedToolSuccessCompletionResult,
} from './trustedToolSuccessCompletion';

export interface TrustedToolFailureCompletionIdentities {
  readonly mutationId: string;
  readonly eventId: string;
}

export interface TrustedToolFailureCompletionIdentityFactory {
  create(startId: string): TrustedToolFailureCompletionIdentities;
}

export interface TrustedToolCompletionDependencies
  extends TrustedToolSuccessCompletionDependencies {
  readonly failureCompletions: ToolExecutionFailureCompletionRepository;
  readonly failureIdentities: TrustedToolFailureCompletionIdentityFactory;
  readonly stepRuns: Pick<StepRunRepository, 'findById'>;
  readonly runs: Pick<RunRepositoryReader, 'findRunById'>;
}

export interface TrustedToolSucceededCompletionResult {
  readonly outcome: 'succeeded';
  readonly status: 'created' | 'existing';
  readonly completion: Readonly<ToolExecutionCompletionRecord>;
  readonly output: ToolJsonValue;
}

export interface TrustedToolFailedCompletionResult {
  readonly outcome: ToolExecutionFailureOutcome;
  readonly status: 'created' | 'existing';
  readonly completion: Readonly<ToolExecutionFailureCompletionRecord>;
}

export type TrustedToolCompletionResult =
  | TrustedToolSucceededCompletionResult
  | TrustedToolFailedCompletionResult;

interface DurableTerminalState {
  readonly success: Readonly<ToolExecutionCompletionRecord> | null;
  readonly failure: Readonly<ToolExecutionFailureCompletionRecord> | null;
}

const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

function unavailable(cause?: unknown): never {
  throw new ToolExecutionFailureCompletionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function conflict(): never {
  throw new ToolExecutionFailureCompletionConflictError();
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateDependencies(
  dependencies: TrustedToolCompletionDependencies,
): void {
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    !dependencies.failureCompletions ||
    typeof dependencies.failureCompletions.findByStartId !== 'function' ||
    typeof dependencies.failureCompletions.commit !== 'function' ||
    !dependencies.failureIdentities ||
    typeof dependencies.failureIdentities.create !== 'function'
  ) {
    unavailable();
  }
}

async function findTerminalState(
  startId: string,
  dependencies: TrustedToolCompletionDependencies,
): Promise<Readonly<DurableTerminalState>> {
  try {
    const [successValue, failureValue] = await Promise.all([
      dependencies.completions.findByStartId(startId),
      dependencies.failureCompletions.findByStartId(startId),
    ]);
    const success =
      successValue === null
        ? null
        : normalizeToolExecutionCompletionRecord(successValue);
    const failure =
      failureValue === null
        ? null
        : normalizeToolExecutionFailureCompletionRecord(failureValue);
    if (success && failure) return conflict();
    return Object.freeze({ success, failure });
  } catch (cause) {
    if (
      cause instanceof ToolExecutionCompletionConflictError ||
      cause instanceof ToolExecutionFailureCompletionConflictError
    ) {
      throw cause;
    }
    return unavailable(cause);
  }
}

async function findBarrier(
  startId: string,
  dependencies: TrustedToolCompletionDependencies,
): Promise<Readonly<ToolExecutionStartBarrierRecord>> {
  try {
    const value = await dependencies.barriers.findByStartId(startId);
    if (!value) return unavailable();
    const barrier = normalizeToolExecutionStartBarrierRecord(value);
    if (barrier.startId !== startId) return unavailable();
    return barrier;
  } catch (cause) {
    return unavailable(cause);
  }
}

function failureMatchesBarrier(
  completion: Readonly<ToolExecutionFailureCompletionRecord>,
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
): boolean {
  return (
    completion.startId === barrier.startId &&
    completion.projectId === barrier.projectId &&
    completion.runId === barrier.runId &&
    completion.stepRunId === barrier.stepRunId &&
    completion.startedStepRunVersion === barrier.startedStepRunVersion &&
    completion.completedStepRunVersion === barrier.startedStepRunVersion + 1 &&
    completion.barrierDigest === barrier.barrierDigest &&
    completion.adapterDigest === barrier.adapterDigest
  );
}

async function openDurableFailure(
  completion: Readonly<ToolExecutionFailureCompletionRecord>,
  dependencies: TrustedToolCompletionDependencies,
): Promise<Readonly<TrustedToolFailedCompletionResult>> {
  const barrier = await findBarrier(completion.startId, dependencies);
  if (!failureMatchesBarrier(completion, barrier)) return conflict();
  return Object.freeze({
    outcome: completion.outcome,
    status: 'existing' as const,
    completion,
  });
}

function succeeded(
  result: Readonly<TrustedToolSuccessCompletionResult>,
): Readonly<TrustedToolSucceededCompletionResult> {
  return Object.freeze({
    outcome: 'succeeded' as const,
    status: result.status,
    completion: result.completion,
    output: result.output,
  });
}

async function openDurableSuccess(
  startId: string,
  dependencies: TrustedToolCompletionDependencies,
): Promise<Readonly<TrustedToolSucceededCompletionResult>> {
  return succeeded(
    await executeAndCompleteTrustedToolSuccess(startId, dependencies),
  );
}

async function returnDurableWinner(
  startId: string,
  dependencies: TrustedToolCompletionDependencies,
): Promise<Readonly<TrustedToolCompletionResult> | null> {
  const state = await findTerminalState(startId, dependencies);
  if (state.success) return openDurableSuccess(startId, dependencies);
  if (state.failure) return openDurableFailure(state.failure, dependencies);
  return null;
}

function observedAtMs(
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
  dependencies: TrustedToolCompletionDependencies,
): number {
  let value: number;
  try {
    value = (dependencies.now ?? Date.now)();
  } catch (cause) {
    return unavailable(cause);
  }
  if (
    !Number.isSafeInteger(value) ||
    value < barrier.startedAtMs ||
    value < 0
  ) {
    return unavailable();
  }
  return value;
}

async function findRunningStepAndRun(
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
  dependencies: TrustedToolCompletionDependencies,
) {
  try {
    const [stepValue, run] = await Promise.all([
      dependencies.stepRuns.findById(barrier.stepRunId),
      dependencies.runs.findRunById(barrier.runId),
    ]);
    if (!stepValue || !run) return unavailable();
    const stepRun = normalizeStepRunRecord(stepValue);
    if (
      stepRun.id !== barrier.stepRunId ||
      stepRun.runId !== barrier.runId ||
      stepRun.kind !== 'tool' ||
      stepRun.status !== 'running' ||
      stepRun.version !== barrier.startedStepRunVersion ||
      stepRun.stepRunDigest !== barrier.startedStepRunDigest ||
      run.id !== barrier.runId ||
      run.projectId !== barrier.projectId ||
      !Number.isSafeInteger(run.version) ||
      run.version < 0 ||
      !Number.isSafeInteger(run.eventSequence) ||
      run.eventSequence < 0 ||
      TERMINAL_RUN_STATUSES.has(run.status)
    ) {
      return conflict();
    }
    return Object.freeze({ stepRun, run });
  } catch (cause) {
    return unavailable(cause);
  }
}

function failureDedupeKey(startId: string): string {
  return `tool-failure:${createHash('sha256').update(startId).digest('hex')}`;
}

async function commitFailure(
  startId: string,
  outcome: ToolExecutionFailureOutcome,
  dependencies: TrustedToolCompletionDependencies,
): Promise<Readonly<TrustedToolCompletionResult>> {
  const winner = await returnDurableWinner(startId, dependencies);
  if (winner) return winner;

  const barrier = await findBarrier(startId, dependencies);
  const { stepRun, run } = await findRunningStepAndRun(barrier, dependencies);
  const failure = createToolExecutionFailureResult(
    barrier,
    outcome,
    observedAtMs(barrier, dependencies),
  );
  let identities: TrustedToolFailureCompletionIdentities;
  try {
    identities = dependencies.failureIdentities.create(startId);
  } catch (cause) {
    return unavailable(cause);
  }
  const mutation = transitionStepRunMutation(
    stepRun,
    {
      expectedVersion: stepRun.version,
      expectedDigest: stepRun.stepRunDigest,
      mutationId: identities.mutationId,
      to: outcome,
      atMs: failure.completedAtMs,
      resultCode: failure.resultCode,
      errorSummary: failure.errorSummary,
    },
    {
      expectedRunVersion: run.version,
      expectedRunEventSequence: run.eventSequence,
      eventId: identities.eventId,
      dedupeKey: failureDedupeKey(startId),
      actor: Object.freeze({
        type: 'system' as const,
        id: 'trusted-tool-runtime',
      }),
    },
  );
  const command = createToolExecutionFailureCompletionCommand({
    barrier,
    failure,
    stepRunMutation: mutation,
  });
  const expected = toolExecutionFailureCompletionRecord(command);

  try {
    const committed = await dependencies.failureCompletions.commit(command);
    const completion = normalizeToolExecutionFailureCompletionRecord(
      committed.completion,
    );
    if (
      !['created', 'existing'].includes(committed.status) ||
      !sameValue(completion, expected)
    ) {
      return conflict();
    }
    const concurrentSuccess = await dependencies.completions.findByStartId(
      startId,
    );
    if (concurrentSuccess) return conflict();
    return Object.freeze({
      outcome: completion.outcome,
      status: committed.status,
      completion,
    });
  } catch (cause) {
    const recovered = await returnDurableWinner(startId, dependencies);
    if (recovered) return recovered;
    throw cause;
  }
}

/**
 * Completes one already-started retry-safe Tool with exactly one durable
 * succeeded, failed or timed_out outcome.
 *
 * Only explicit adapter failure and deadline errors become terminal failures.
 * Binding, key, snapshot and storage errors stay non-terminal. A lost commit
 * response is recovered exclusively from durable state and never re-executes
 * the adapter in the same call.
 */
export async function executeAndCompleteTrustedTool(
  startId: string,
  dependencies: TrustedToolCompletionDependencies,
): Promise<Readonly<TrustedToolCompletionResult>> {
  validateDependencies(dependencies);
  const winner = await returnDurableWinner(startId, dependencies);
  if (winner) return winner;

  try {
    const result = await executeAndCompleteTrustedToolSuccess(
      startId,
      dependencies,
    );
    const concurrentFailure =
      await dependencies.failureCompletions.findByStartId(startId);
    if (concurrentFailure) return conflict();
    return succeeded(result);
  } catch (cause) {
    const durable = await returnDurableWinner(startId, dependencies);
    if (durable) return durable;
    if (cause instanceof TrustedToolExecutionDeadlineExceededError) {
      return commitFailure(startId, 'timed_out', dependencies);
    }
    if (cause instanceof TrustedToolExecutionFailedError) {
      return commitFailure(startId, 'failed', dependencies);
    }
    throw cause;
  }
}

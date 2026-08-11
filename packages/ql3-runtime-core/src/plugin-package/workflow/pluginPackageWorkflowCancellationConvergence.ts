import { createHash } from 'node:crypto';

import {
  normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt,
  type PluginPackageWorkflowTaskAttemptAdmissionReceipt,
} from './pluginPackageWorkflowTaskAttemptAdmission';
import {
  RUN_DISPATCH_LEASE_STATUSES,
  type RunDispatchLeaseStatus,
} from '../../run/runDispatchLease';
import type {
  RunAttemptRecord,
  RunCancellationReason,
  RunEventRecord,
  RunRecord,
} from '../../run/run';
import {
  MAX_STEP_RUNS_PER_RUN,
  STEP_RUN_TERMINAL_STATUSES,
  normalizeStepRunRecord,
  transitionStepRunMutation,
  type StepRunMutation,
  type StepRunRecord,
} from '../../run/stepRun';

export const PLUGIN_PACKAGE_WORKFLOW_CANCELLATION_CONVERGENCE_SCHEMA =
  'qinglong/plugin-package-workflow-cancellation-convergence@v1' as const;

export interface PluginPackageWorkflowCancellationActiveAttempt {
  readonly admission:
    Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>;
  readonly attempt: Readonly<RunAttemptRecord>;
  readonly leaseStatus: RunDispatchLeaseStatus | null;
}

export interface PluginPackageWorkflowCancellationSnapshot {
  readonly run: Readonly<RunRecord>;
  readonly stepRuns: readonly Readonly<StepRunRecord>[];
  readonly activeTaskAttempts:
    readonly Readonly<PluginPackageWorkflowCancellationActiveAttempt>[];
  readonly observedAtMs: number;
}

export interface PluginPackageWorkflowCancellationAttemptTransition {
  readonly previousStatus: 'claimed';
  readonly attempt: Readonly<RunAttemptRecord>;
  readonly event: Readonly<RunEventRecord>;
}

export interface PluginPackageWorkflowCancellationTerminalTransition {
  readonly expectedRunVersion: number;
  readonly expectedRunEventSequence: number;
  readonly status: 'cancelled' | 'timed_out';
  readonly finishedAtMs: number;
  readonly errorCode: 'EXECUTION_CANCELLED' | 'EXECUTION_TIMED_OUT';
  readonly errorSummary: string;
  readonly event: Readonly<RunEventRecord>;
}

export interface PluginPackageWorkflowCancellationResolution {
  readonly schema:
    typeof PLUGIN_PACKAGE_WORKFLOW_CANCELLATION_CONVERGENCE_SCHEMA;
  readonly expectedRunVersion: number;
  readonly expectedRunEventSequence: number;
  readonly run: Readonly<RunRecord>;
  readonly attemptTransitions:
    readonly Readonly<PluginPackageWorkflowCancellationAttemptTransition>[];
  readonly stepMutations: readonly Readonly<StepRunMutation>[];
  readonly blockedAttemptIds: readonly string[];
  readonly blockedStepRunIds: readonly string[];
  readonly terminalTransition:
    Readonly<PluginPackageWorkflowCancellationTerminalTransition> | null;
  readonly observedAtMs: number;
}

export class InvalidPluginPackageWorkflowCancellationConvergenceError
  extends TypeError
{
  readonly code =
    'PLUGIN_PACKAGE_WORKFLOW_CANCELLATION_CONVERGENCE_INVALID';

  constructor(message: string) {
    super(
      `Plugin Package Workflow cancellation convergence is invalid: ${message}`,
    );
    this.name =
      'InvalidPluginPackageWorkflowCancellationConvergenceError';
  }
}

const ACTIVE_ATTEMPT_STATUSES = new Set(['claimed', 'starting', 'running']);
const TERMINAL_STEP_STATUSES = new Set(STEP_RUN_TERMINAL_STATUSES);
const ID_DOMAIN = Buffer.from(
  'qinglong/plugin-package-workflow-cancellation-convergence-id@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidPluginPackageWorkflowCancellationConvergenceError(message);
}

function counter(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 2_147_483_647
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function identity(
  runId: string,
  cancelRequestedAtMs: number,
  kind: 'attempt' | 'step' | 'run',
  targetId: string,
  epoch: number,
): string {
  return createHash('sha256')
    .update(ID_DOMAIN)
    .update(runId, 'utf8')
    .update('\0', 'utf8')
    .update(String(cancelRequestedAtMs), 'utf8')
    .update('\0', 'utf8')
    .update(kind, 'utf8')
    .update('\0', 'utf8')
    .update(targetId, 'utf8')
    .update('\0', 'utf8')
    .update(String(epoch), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function terminalMapping(reason: RunCancellationReason): Readonly<{
  status: 'cancelled' | 'timed_out';
  errorCode: 'EXECUTION_CANCELLED' | 'EXECUTION_TIMED_OUT';
  errorSummary: string;
}> {
  return reason === 'timeout'
    ? Object.freeze({
        status: 'timed_out' as const,
        errorCode: 'EXECUTION_TIMED_OUT' as const,
        errorSummary: 'Execution exceeded its configured timeout',
      })
    : Object.freeze({
        status: 'cancelled' as const,
        errorCode: 'EXECUTION_CANCELLED' as const,
        errorSummary: 'Execution was cancelled',
      });
}

function validateRun(run: Readonly<RunRecord>): Readonly<{
  cancelRequestedAtMs: number;
  cancelReason: RunCancellationReason;
}> {
  if (
    !run ||
    typeof run !== 'object' ||
    Array.isArray(run) ||
    run.triggerType !== 'plugin_package_workflow' ||
    run.executionOrigin !== 'system' ||
    run.executionOwner !== 'runtime' ||
    run.status !== 'running' ||
    run.cancelRequestedAtMs === undefined ||
    run.cancelReason === undefined
  ) {
    invalid('Run is not a cancelling runtime-owned Workflow aggregate');
  }
  counter(run.version, 'Run version');
  counter(run.eventSequence, 'Run event sequence');
  const cancelRequestedAtMs = timestamp(
    run.cancelRequestedAtMs,
    'Run cancellation time',
  );
  return Object.freeze({
    cancelRequestedAtMs,
    cancelReason: run.cancelReason,
  });
}

function validateActiveAttempt(
  run: Readonly<RunRecord>,
  value: Readonly<PluginPackageWorkflowCancellationActiveAttempt>,
  stepsById: ReadonlyMap<string, Readonly<StepRunRecord>>,
): Readonly<{
  admission:
    Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>;
  attempt: Readonly<RunAttemptRecord>;
  leaseStatus: RunDispatchLeaseStatus | null;
  stepRun: Readonly<StepRunRecord>;
}> {
  let admission:
    Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>;
  try {
    admission =
      normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt(
        value.admission,
      );
  } catch {
    return invalid('active Attempt admission is invalid');
  }
  const { attempt } = value;
  if (
    !attempt ||
    typeof attempt !== 'object' ||
    Array.isArray(attempt) ||
    !ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ||
    attempt.id !== admission.attemptId ||
    attempt.runId !== run.id ||
    attempt.runId !== admission.runId ||
    attempt.stepRunId !== admission.stepRunId ||
    attempt.attempt !== admission.attemptNumber ||
    attempt.executorType !== admission.executorType ||
    attempt.createdAtMs !== admission.admittedAtMs
  ) {
    invalid('active Attempt does not match its immutable admission');
  }
  counter(attempt.callbackSequence, 'Attempt callback sequence');
  if (
    value.leaseStatus !== null &&
    !RUN_DISPATCH_LEASE_STATUSES.includes(value.leaseStatus)
  ) {
    invalid('active Attempt lease status is invalid');
  }
  const stepRun = stepsById.get(admission.stepRunId);
  if (!stepRun || stepRun.kind !== 'task') {
    invalid('active Attempt StepRun is missing');
  }
  if (
    attempt.status === 'claimed' ||
    attempt.status === 'starting'
  ) {
    if (
      stepRun.status !== 'ready' ||
      stepRun.version !== admission.stepRunVersion ||
      stepRun.stepRunDigest !== admission.stepRunDigest ||
      attempt.startedAtMs !== undefined
    ) {
      invalid('pre-start Attempt crossed its admitted StepRun epoch');
    }
  } else if (
    stepRun.status !== 'running' ||
    stepRun.version !== admission.stepRunVersion + 1 ||
    stepRun.startedAtMs === null ||
    attempt.startedAtMs === undefined
  ) {
    invalid('running Attempt does not match the canonical StepRun');
  }
  return Object.freeze({
    admission,
    attempt,
    leaseStatus: value.leaseStatus,
    stepRun,
  });
}

/**
 * Converges one cancelling Workflow snapshot without inventing completion for
 * active execution. Unleased pre-start claims and non-executing StepRuns are
 * settled immediately; leased/starting/running Attempts remain blocked until
 * worker completion or recovery crosses their own authority fences.
 */
export function resolvePluginPackageWorkflowCancellation(
  snapshot: Readonly<PluginPackageWorkflowCancellationSnapshot>,
): Readonly<PluginPackageWorkflowCancellationResolution> {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    invalid('snapshot is invalid');
  }
  const { cancelRequestedAtMs, cancelReason } = validateRun(snapshot.run);
  const observedAtMs = timestamp(snapshot.observedAtMs, 'observation time');
  if (observedAtMs < cancelRequestedAtMs) {
    invalid('observation precedes cancellation intent');
  }
  if (
    !Array.isArray(snapshot.stepRuns) ||
    snapshot.stepRuns.length < 1 ||
    snapshot.stepRuns.length > MAX_STEP_RUNS_PER_RUN ||
    !Array.isArray(snapshot.activeTaskAttempts)
  ) {
    invalid('Workflow StepRun or active Attempt collection is invalid');
  }

  const steps = snapshot.stepRuns.map((value) => {
    try {
      return normalizeStepRunRecord(value);
    } catch {
      return invalid('StepRun is invalid');
    }
  }).sort((left, right) =>
    left.stepKey.localeCompare(right.stepKey) || left.id.localeCompare(right.id));
  const stepsById = new Map<string, Readonly<StepRunRecord>>();
  for (const stepRun of steps) {
    if (
      stepRun.runId !== snapshot.run.id ||
      stepsById.has(stepRun.id) ||
      observedAtMs < stepRun.updatedAtMs
    ) {
      invalid('StepRun set is incomplete, duplicated or time-inconsistent');
    }
    stepsById.set(stepRun.id, stepRun);
  }

  const active = snapshot.activeTaskAttempts
    .map((value) =>
      validateActiveAttempt(snapshot.run, value, stepsById))
    .sort((left, right) => left.attempt.id.localeCompare(right.attempt.id));
  const activeByStepId = new Map<
    string,
    (typeof active)[number]
  >();
  for (const value of active) {
    if (
      activeByStepId.has(value.stepRun.id) ||
      observedAtMs < value.attempt.createdAtMs ||
      observedAtMs < (value.attempt.startedAtMs ?? 0)
    ) {
      invalid('active Attempt set is duplicated or time-inconsistent');
    }
    activeByStepId.set(value.stepRun.id, value);
  }

  const terminal = terminalMapping(cancelReason);
  const attemptTransitions:
    PluginPackageWorkflowCancellationAttemptTransition[] = [];
  const stepMutations: StepRunMutation[] = [];
  const blockedAttemptIds: string[] = [];
  const blockedStepRunIds = new Set<string>();
  let runVersion = snapshot.run.version;
  let runEventSequence = snapshot.run.eventSequence;

  for (const value of active) {
    const isBlocked =
      value.attempt.status !== 'claimed' ||
      value.leaseStatus === 'leased';
    if (isBlocked) {
      blockedAttemptIds.push(value.attempt.id);
      blockedStepRunIds.add(value.stepRun.id);
      continue;
    }
    if (
      runVersion >= 2_147_483_647 ||
      runEventSequence >= 2_147_483_647
    ) {
      invalid('Run aggregate counter overflowed');
    }
    const digest = identity(
      snapshot.run.id,
      cancelRequestedAtMs,
      'attempt',
      value.attempt.id,
      value.attempt.callbackSequence,
    );
    runVersion += 1;
    runEventSequence += 1;
    const attempt = Object.freeze({
      ...value.attempt,
      status: terminal.status,
      finishedAtMs: observedAtMs,
      errorCode: terminal.errorCode,
      errorSummary: terminal.errorSummary,
    });
    const event = Object.freeze({
      id: `wca:${digest}`,
      runId: snapshot.run.id,
      sequence: runEventSequence,
      type: `workflow.task_attempt.${terminal.status}`,
      dedupeKey: `wca:${digest}`,
      actorType: 'reconciler' as const,
      actorId: 'runtime:cancellation',
      attemptId: attempt.id,
      stepRunId: value.stepRun.id,
      payload: Object.freeze({
        execution_scope: 'workflow_task',
        attempt_id: attempt.id,
        step_run_id: value.stepRun.id,
        from_status: 'claimed',
        to_status: terminal.status,
        cancel_reason: cancelReason,
        cancel_requested_at_ms: cancelRequestedAtMs,
        error_code: terminal.errorCode,
        version: runVersion,
      }),
      createdAtMs: observedAtMs,
    } satisfies RunEventRecord);
    attemptTransitions.push(Object.freeze({
      previousStatus: 'claimed' as const,
      attempt,
      event,
    }));
  }

  let projectedSteps = new Map(stepsById);
  for (const current of steps) {
    if (
      TERMINAL_STEP_STATUSES.has(
        current.status as (typeof STEP_RUN_TERMINAL_STATUSES)[number],
      ) ||
      blockedStepRunIds.has(current.id)
    ) {
      continue;
    }
    if (current.status === 'running') {
      blockedStepRunIds.add(current.id);
      continue;
    }
    const target =
      cancelReason === 'timeout' &&
      (current.status === 'ready' ||
        current.status === 'waiting_approval')
        ? 'timed_out'
        : 'cancelled';
    if (
      runVersion >= 2_147_483_647 ||
      runEventSequence >= 2_147_483_647
    ) {
      invalid('Run aggregate counter overflowed');
    }
    const digest = identity(
      snapshot.run.id,
      cancelRequestedAtMs,
      'step',
      current.id,
      current.version,
    );
    const mutation = transitionStepRunMutation(
      current,
      {
        expectedVersion: current.version,
        expectedDigest: current.stepRunDigest,
        mutationId: `wcm:${digest}`,
        to: target,
        atMs: observedAtMs,
        resultCode:
          target === 'timed_out'
            ? 'workflow_timed_out'
            : 'workflow_cancelled',
        ...(target === 'timed_out'
          ? { errorSummary: terminal.errorSummary }
          : {}),
      },
      {
        expectedRunVersion: runVersion,
        expectedRunEventSequence: runEventSequence,
        eventId: `wcs:${digest}`,
        dedupeKey: `wcs:${digest}`,
        actor: {
          type: 'reconciler',
          id: 'runtime:cancellation',
        },
      },
    );
    stepMutations.push(mutation);
    projectedSteps.set(current.id, mutation.stepRun);
    runVersion += 1;
    runEventSequence += 1;
  }

  const blockedSteps = [...blockedStepRunIds].sort();
  const canTerminalize =
    blockedSteps.length === 0 &&
    [...projectedSteps.values()].every((stepRun) =>
      TERMINAL_STEP_STATUSES.has(
        stepRun.status as (typeof STEP_RUN_TERMINAL_STATUSES)[number],
      ));
  let terminalTransition:
    PluginPackageWorkflowCancellationTerminalTransition | null = null;
  if (canTerminalize) {
    if (
      runVersion >= 2_147_483_647 ||
      runEventSequence >= 2_147_483_647
    ) {
      invalid('Run aggregate counter overflowed');
    }
    const digest = identity(
      snapshot.run.id,
      cancelRequestedAtMs,
      'run',
      snapshot.run.id,
      runVersion,
    );
    terminalTransition = Object.freeze({
      expectedRunVersion: runVersion,
      expectedRunEventSequence: runEventSequence,
      status: terminal.status,
      finishedAtMs: observedAtMs,
      errorCode: terminal.errorCode,
      errorSummary: terminal.errorSummary,
      event: Object.freeze({
        id: `wcr:${digest}`,
        runId: snapshot.run.id,
        sequence: runEventSequence + 1,
        type: `workflow.${terminal.status}`,
        dedupeKey: `wcr:${digest}`,
        actorType: 'reconciler',
        actorId: 'runtime:cancellation',
        payload: Object.freeze({
          from_status: 'running',
          to_status: terminal.status,
          step_count: steps.length,
          cancel_reason: cancelReason,
          cancel_requested_at_ms: cancelRequestedAtMs,
          error_code: terminal.errorCode,
          version: runVersion + 1,
        }),
        createdAtMs: observedAtMs,
      }),
    });
    runVersion += 1;
    runEventSequence += 1;
  }

  return Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_CANCELLATION_CONVERGENCE_SCHEMA,
    expectedRunVersion: snapshot.run.version,
    expectedRunEventSequence: snapshot.run.eventSequence,
    run: Object.freeze({
      ...snapshot.run,
      version: runVersion,
      eventSequence: runEventSequence,
      ...(terminalTransition === null
        ? {}
        : {
            status: terminalTransition.status,
            finishedAtMs: terminalTransition.finishedAtMs,
            errorCode: terminalTransition.errorCode,
            errorSummary: terminalTransition.errorSummary,
          }),
    }),
    attemptTransitions: Object.freeze(attemptTransitions),
    stepMutations: Object.freeze(stepMutations),
    blockedAttemptIds: Object.freeze(blockedAttemptIds),
    blockedStepRunIds: Object.freeze(blockedSteps),
    terminalTransition,
    observedAtMs,
  });
}

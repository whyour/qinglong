import { createHash } from 'node:crypto';

import {
  normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt,
  type PluginPackageWorkflowTaskAttemptAdmissionReceipt,
} from './pluginPackageWorkflowTaskAttemptAdmission';
import type { RunAttemptRecord, RunEventRecord, RunRecord } from '../../run/run';
import {
  normalizeStepRunRecord,
  transitionStepRunMutation,
  type StepRunMutation,
  type StepRunRecord,
} from '../../run/stepRun';

export const PLUGIN_PACKAGE_WORKFLOW_TASK_RECOVERY_SCHEMA =
  'qinglong/plugin-package-workflow-task-recovery@v1' as const;

export type PluginPackageWorkflowTaskRecoveryReason =
  | 'unstarted_claim_expired'
  | 'execution_not_running';

export interface PluginPackageWorkflowTaskRecoveryInput {
  readonly admission:
    Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>;
  readonly run: Readonly<RunRecord>;
  readonly attempt: Readonly<RunAttemptRecord>;
  readonly stepRun: Readonly<StepRunRecord>;
  readonly reason: PluginPackageWorkflowTaskRecoveryReason;
  readonly observedAtMs: number;
}

export interface PluginPackageWorkflowTaskRecoveryBundle {
  readonly schema: typeof PLUGIN_PACKAGE_WORKFLOW_TASK_RECOVERY_SCHEMA;
  readonly disposition: 'requeued' | 'failed';
  readonly run: Readonly<RunRecord>;
  readonly attempt: Readonly<RunAttemptRecord>;
  readonly attemptEvent: Readonly<RunEventRecord>;
  readonly stepMutations: readonly Readonly<StepRunMutation>[];
}

export class InvalidPluginPackageWorkflowTaskRecoveryError
  extends TypeError
{
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_TASK_RECOVERY_INVALID';

  constructor(message: string) {
    super(`Plugin Package Workflow Task recovery is invalid: ${message}`);
    this.name = 'InvalidPluginPackageWorkflowTaskRecoveryError';
  }
}

const ACTIVE_ATTEMPT_STATUSES = new Set(['claimed', 'starting', 'running']);
const ID_DOMAIN = Buffer.from(
  'qinglong/plugin-package-workflow-task-recovery-id@v1\0',
  'utf8',
);
const LOST_ERROR_CODE = Object.freeze({
  unstarted_claim_expired:
    'CLUSTER_RECOVERY_UNSTARTED_CLAIM_EXPIRED',
  execution_not_running:
    'CLUSTER_RECOVERY_EXECUTION_NOT_RUNNING',
});
const LOST_ERROR_SUMMARY = Object.freeze({
  unstarted_claim_expired:
    'The Workflow Task Attempt claim expired before execution started',
  execution_not_running:
    'Trusted execution evidence proved that the Workflow Task Attempt is not running',
});

function invalid(message: string): never {
  throw new InvalidPluginPackageWorkflowTaskRecoveryError(message);
}

function safeInteger(
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

function identity(
  attempt: Readonly<RunAttemptRecord>,
  stepRun: Readonly<StepRunRecord>,
  reason: PluginPackageWorkflowTaskRecoveryReason,
): Readonly<{
  attemptEventId: string;
  requeueMutationId: string;
  requeueEventId: string;
  lostMutationId: string;
  lostEventId: string;
  failedMutationId: string;
  failedEventId: string;
}> {
  const digest = createHash('sha256')
    .update(ID_DOMAIN)
    .update(attempt.runId, 'utf8')
    .update('\0', 'utf8')
    .update(attempt.id, 'utf8')
    .update('\0', 'utf8')
    .update(String(attempt.callbackSequence), 'utf8')
    .update('\0', 'utf8')
    .update(stepRun.id, 'utf8')
    .update('\0', 'utf8')
    .update(String(stepRun.version), 'utf8')
    .update('\0', 'utf8')
    .update(reason, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return Object.freeze({
    attemptEventId: `wra:${digest}`,
    requeueMutationId: `wrq:${digest}`,
    requeueEventId: `wqe:${digest}`,
    lostMutationId: `wrl:${digest}`,
    lostEventId: `wle:${digest}`,
    failedMutationId: `wrf:${digest}`,
    failedEventId: `wfe:${digest}`,
  });
}

function validateAuthority(
  input: Readonly<PluginPackageWorkflowTaskRecoveryInput>,
  admission: Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>,
  stepRun: Readonly<StepRunRecord>,
): void {
  const { run, attempt, reason } = input;
  if (
    !run ||
    typeof run !== 'object' ||
    Array.isArray(run) ||
    run.id !== admission.runId ||
    run.triggerType !== 'plugin_package_workflow' ||
    run.executionOrigin !== 'system' ||
    run.executionOwner !== 'runtime' ||
    run.status !== 'running' ||
    run.cancelRequestedAtMs !== undefined
  ) {
    invalid('Run is not an active runtime-owned Workflow aggregate');
  }
  const runVersion = safeInteger(
    run.version,
    1,
    2_147_483_644,
    'Run version',
  );
  const runEventSequence = safeInteger(
    run.eventSequence,
    1,
    2_147_483_644,
    'Run event sequence',
  );
  if (
    runVersion !== runEventSequence ||
    admission.runVersion > runVersion ||
    admission.runEventSequence > runEventSequence
  ) {
    invalid('Run aggregate counters do not contain the admission event');
  }
  if (
    !attempt ||
    typeof attempt !== 'object' ||
    Array.isArray(attempt) ||
    attempt.id !== admission.attemptId ||
    attempt.runId !== run.id ||
    attempt.stepRunId !== admission.stepRunId ||
    attempt.attempt !== admission.attemptNumber ||
    attempt.executorType !== admission.executorType ||
    attempt.createdAtMs !== admission.admittedAtMs ||
    !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)
  ) {
    invalid('Attempt is not the active admission-bound Workflow Task Attempt');
  }
  safeInteger(
    attempt.callbackSequence,
    0,
    2_147_483_647,
    'Attempt callback sequence',
  );
  if (
    stepRun.id !== admission.stepRunId ||
    stepRun.runId !== run.id ||
    stepRun.kind !== 'task'
  ) {
    invalid('StepRun is not the admitted Workflow Task');
  }
  if (reason === 'unstarted_claim_expired') {
    if (
      attempt.status !== 'claimed' ||
      attempt.startedAtMs !== undefined ||
      stepRun.status !== 'ready' ||
      stepRun.version !== admission.stepRunVersion ||
      stepRun.stepRunDigest !== admission.stepRunDigest
    ) {
      invalid('unstarted recovery crossed the Workflow Task start barrier');
    }
  } else if (attempt.status === 'starting') {
    if (
      stepRun.status !== 'ready' ||
      stepRun.version !== admission.stepRunVersion ||
      stepRun.stepRunDigest !== admission.stepRunDigest
    ) {
      invalid('starting recovery does not match the admitted StepRun epoch');
    }
  } else if (
    attempt.status !== 'running' ||
    stepRun.status !== 'running' ||
    stepRun.version !== admission.stepRunVersion + 1 ||
    stepRun.startedAtMs === null
  ) {
    invalid('running recovery does not match the canonical StepRun');
  }
}

function transitionTime(
  observedAtMs: number,
  run: Readonly<RunRecord>,
  attempt: Readonly<RunAttemptRecord>,
  stepRun: Readonly<StepRunRecord>,
): number {
  const atMs = safeInteger(
    observedAtMs,
    0,
    Number.MAX_SAFE_INTEGER,
    'recovery observation time',
  );
  const lowerBound = Math.max(
    run.createdAtMs,
    run.startedAtMs ?? 0,
    attempt.createdAtMs,
    attempt.startedAtMs ?? 0,
    attempt.finishedAtMs ?? 0,
    stepRun.createdAtMs,
    stepRun.updatedAtMs,
    stepRun.startedAtMs ?? 0,
    stepRun.finishedAtMs ?? 0,
  );
  if (atMs < lowerBound) {
    invalid('recovery observation precedes durable state');
  }
  return atMs;
}

/**
 * Resolves only one immutable, admission-bound Workflow Task Attempt.
 *
 * An expired pre-start claim is safe to requeue by refreshing the exact
 * `ready` StepRun epoch. Once the start barrier has been crossed, v1 fails the
 * StepRun after trusted absence evidence instead of silently duplicating an
 * external side effect. The Workflow aggregate Run remains `running`; its
 * frontier owns final aggregation.
 */
export function buildPluginPackageWorkflowTaskRecovery(
  input: Readonly<PluginPackageWorkflowTaskRecoveryInput>,
): Readonly<PluginPackageWorkflowTaskRecoveryBundle> {
  let admission:
    Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>;
  let stepRun: Readonly<StepRunRecord>;
  try {
    admission =
      normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt(
        input.admission,
      );
    stepRun = normalizeStepRunRecord(input.stepRun);
  } catch {
    return invalid('durable admission or StepRun evidence is invalid');
  }
  if (
    input.reason !== 'unstarted_claim_expired' &&
    input.reason !== 'execution_not_running'
  ) {
    invalid('recovery reason is invalid');
  }
  validateAuthority(input, admission, stepRun);
  const atMs = transitionTime(
    input.observedAtMs,
    input.run,
    input.attempt,
    stepRun,
  );
  const ids = identity(input.attempt, stepRun, input.reason);
  const errorCode = LOST_ERROR_CODE[input.reason];
  const errorSummary = LOST_ERROR_SUMMARY[input.reason];
  let runVersion = input.run.version + 1;
  let runEventSequence = input.run.eventSequence + 1;
  const attempt = Object.freeze({
    ...input.attempt,
    status: 'lost' as const,
    finishedAtMs: atMs,
    errorCode,
    errorSummary,
  });
  const attemptEvent = Object.freeze({
    id: ids.attemptEventId,
    runId: input.run.id,
    sequence: runEventSequence,
    type: 'workflow.task_attempt.lost',
    dedupeKey: ids.attemptEventId,
    actorType: 'system' as const,
    attemptId: attempt.id,
    stepRunId: stepRun.id,
    payload: Object.freeze({
      execution_scope: 'workflow_task',
      attempt_id: attempt.id,
      step_run_id: stepRun.id,
      from_status: input.attempt.status,
      to_status: 'lost',
      reason: input.reason,
      error_code: errorCode,
      version: runVersion,
    }),
    createdAtMs: atMs,
  } satisfies RunEventRecord);
  const stepMutations: Readonly<StepRunMutation>[] = [];

  const transition = (
    mutationId: string,
    eventId: string,
    to: 'ready' | 'lost' | 'failed',
  ): void => {
    const mutation = transitionStepRunMutation(
      stepRun,
      {
        expectedVersion: stepRun.version,
        expectedDigest: stepRun.stepRunDigest,
        mutationId,
        to,
        atMs,
        ...(to === 'ready'
          ? {}
          : {
              resultCode: 'cluster_recovery_execution_not_running',
              errorSummary,
            }),
      },
      {
        expectedRunVersion: runVersion,
        expectedRunEventSequence: runEventSequence,
        eventId,
        dedupeKey: eventId,
        actor: { type: 'system' },
      },
    );
    stepMutations.push(mutation);
    stepRun = mutation.stepRun;
    runVersion += 1;
    runEventSequence += 1;
  };

  if (input.reason === 'unstarted_claim_expired') {
    transition(
      ids.requeueMutationId,
      ids.requeueEventId,
      'ready',
    );
  } else if (input.attempt.status === 'starting') {
    transition(
      ids.failedMutationId,
      ids.failedEventId,
      'failed',
    );
  } else {
    transition(ids.lostMutationId, ids.lostEventId, 'lost');
    transition(
      ids.failedMutationId,
      ids.failedEventId,
      'failed',
    );
  }

  return Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_TASK_RECOVERY_SCHEMA,
    disposition:
      input.reason === 'unstarted_claim_expired' ? 'requeued' : 'failed',
    run: Object.freeze({
      ...input.run,
      version: runVersion,
      eventSequence: runEventSequence,
    }),
    attempt,
    attemptEvent,
    stepMutations: Object.freeze(stepMutations),
  });
}

import { createHash } from 'node:crypto';

import {
  normalizePluginPackageTaskReconciliationReceipt,
  type PluginPackageTaskReconciliationReceipt,
} from '../pluginPackageTaskReconciliation';
import {
  normalizePluginPackageWorkflowExecutionPlan,
  type PluginPackageWorkflowExecutionPlan,
} from './pluginPackageWorkflowExecutionPlan';
import {
  normalizeClusterTaskExecutionRevision,
  type ClusterTaskExecutionRevision,
} from '../../task-definition/clusterExecutionRevision';
import {
  normalizeLocalTaskExecutionRevision,
  type LocalTaskExecutionRevision,
} from '../../local-runtime/localDispatch';
import type { RunAttemptRecord, RunEventRecord, RunRecord } from '../../run/run';
import {
  MAX_STEP_RUN_ATTEMPTS,
  normalizeStepRunRecord,
  type StepRunRecord,
} from '../../run/stepRun';

export const PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_ADMISSION_SCHEMA =
  'qinglong/plugin-package-workflow-task-attempt-admission@v1' as const;
export const MAX_PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_PAGE_SIZE = 64;
export const MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_ATTEMPTS =
  128 * MAX_STEP_RUN_ATTEMPTS;

export type PluginPackageWorkflowTaskExecutorType =
  | 'local_process'
  | 'remote_worker';

export interface PluginPackageWorkflowTaskExecutionBinding {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly taskDefinitionDigest: string;
  readonly executorType: PluginPackageWorkflowTaskExecutorType;
  readonly executionDigest: string;
}

export interface PluginPackageWorkflowTaskAttemptAdmissionReceipt {
  readonly schema:
    typeof PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_ADMISSION_SCHEMA;
  readonly attemptId: string;
  readonly planDigest: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly stepRunVersion: number;
  readonly stepRunDigest: string;
  readonly resourceTaskId: string;
  readonly taskReconciliationReceiptDigest: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly taskDefinitionDigest: string;
  readonly executorType: PluginPackageWorkflowTaskExecutorType;
  readonly executionDigest: string;
  readonly attemptNumber: number;
  readonly eventId: string;
  readonly runVersion: number;
  readonly runEventSequence: number;
  readonly admittedAtMs: number;
  readonly receiptDigest: string;
}

export interface PluginPackageWorkflowTaskAttemptAdmissionBundle {
  readonly receipt: Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>;
  readonly attempt: Readonly<RunAttemptRecord>;
  readonly event: Readonly<RunEventRecord>;
  readonly run: Readonly<RunRecord>;
}

export interface PluginPackageWorkflowTaskAttemptAdmissionCursor {
  readonly readyAtMs: number;
  readonly stepRunId: string;
}

export interface PluginPackageWorkflowTaskAttemptAdmissionCandidate
  extends PluginPackageWorkflowTaskAttemptAdmissionCursor {
  readonly runId: string;
  readonly planDigest: string;
}

export interface PluginPackageWorkflowTaskAttemptAdmissionPage {
  readonly candidates: readonly Readonly<PluginPackageWorkflowTaskAttemptAdmissionCandidate>[];
  readonly truncated: boolean;
  readonly next?: Readonly<PluginPackageWorkflowTaskAttemptAdmissionCursor>;
}

export interface PluginPackageWorkflowTaskAttemptAdmissionResult {
  readonly status: 'created' | 'existing';
  readonly receipt: Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>;
}

export interface PluginPackageWorkflowTaskAttemptAdmissionRepository {
  listCandidates(query: Readonly<{
    limit: number;
    after?: Readonly<PluginPackageWorkflowTaskAttemptAdmissionCursor>;
  }>): Promise<
    Readonly<PluginPackageWorkflowTaskAttemptAdmissionPage>
  >;
  admit(
    runId: string,
    stepRunId: string,
  ): Promise<
    Readonly<PluginPackageWorkflowTaskAttemptAdmissionResult>
  >;
}

export interface CreatePluginPackageWorkflowTaskAttemptAdmissionInput {
  readonly plan: Readonly<PluginPackageWorkflowExecutionPlan>;
  readonly run: Readonly<RunRecord>;
  readonly stepRun: Readonly<StepRunRecord>;
  readonly taskReconciliation:
    Readonly<PluginPackageTaskReconciliationReceipt>;
  readonly execution: Readonly<
    LocalTaskExecutionRevision | ClusterTaskExecutionRevision
  >;
  readonly attemptNumber: number;
  readonly admittedAtMs: number;
}

export class InvalidPluginPackageWorkflowTaskAttemptAdmissionError
  extends TypeError
{
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_ADMISSION_INVALID';

  constructor(message: string) {
    super(
      `Plugin Package Workflow Task Attempt admission is invalid: ${message}`,
    );
    this.name =
      'InvalidPluginPackageWorkflowTaskAttemptAdmissionError';
  }
}

export class PluginPackageWorkflowTaskAttemptAdmissionConflictError
  extends Error
{
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_ADMISSION_CONFLICT';

  constructor() {
    super('Plugin Package Workflow Task Attempt admission conflicts with state');
    this.name =
      'PluginPackageWorkflowTaskAttemptAdmissionConflictError';
  }
}

export class PluginPackageWorkflowTaskAttemptAdmissionUnavailableError
  extends Error
{
  readonly code =
    'PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_ADMISSION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package Workflow Task Attempt admission is unavailable', {
      cause: options?.cause,
    });
    this.name =
      'PluginPackageWorkflowTaskAttemptAdmissionUnavailableError';
  }
}

const DIGEST = /^[0-9a-f]{64}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_REVISION = /^qltd:v1:([1-9][0-9]{0,9}):([0-9a-f]{64})$/;
const ACTIVE_RECONCILIATION_DISPOSITIONS = new Set([
  'created',
  'retained',
  'updated',
]);
const ID_DOMAIN = Buffer.from(
  'qinglong/plugin-package-workflow-task-attempt-id@v1\0',
  'utf8',
);
const RECEIPT_DOMAIN = Buffer.from(
  'qinglong/plugin-package-workflow-task-attempt-receipt@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidPluginPackageWorkflowTaskAttemptAdmissionError(message);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== 'string') ||
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key === 'string' && !allowed.has(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
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

function timestamp(value: unknown, label: string): number {
  return integer(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function taskIdentity(packageName: string, resourceTaskId: string): string {
  return identity(
    `pkg:${packageName}:${resourceTaskId}`,
    'runtime Task identity',
  );
}

function executionBinding(
  value: Readonly<
    LocalTaskExecutionRevision | ClusterTaskExecutionRevision
  >,
): Readonly<PluginPackageWorkflowTaskExecutionBinding> {
  let normalized:
    | Readonly<LocalTaskExecutionRevision>
    | Readonly<ClusterTaskExecutionRevision>;
  try {
    normalized =
      value?.executorType === 'local_process'
        ? normalizeLocalTaskExecutionRevision(
            value as LocalTaskExecutionRevision,
          )
        : value?.executorType === 'remote_worker'
          ? normalizeClusterTaskExecutionRevision(
              value as ClusterTaskExecutionRevision,
            )
          : invalid('execution revision executorType is invalid');
  } catch (error) {
    if (
      error instanceof
      InvalidPluginPackageWorkflowTaskAttemptAdmissionError
    ) {
      throw error;
    }
    return invalid('execution revision is invalid');
  }
  const taskRevision = identity(
    normalized.taskRevision,
    'execution revision taskRevision',
  );
  const revisionMatch = TASK_REVISION.exec(taskRevision);
  if (!revisionMatch) {
    invalid('execution revision Task identity is inconsistent');
  }
  const taskDefinitionDigest = revisionMatch[2]!;
  return Object.freeze({
    projectId: identity(normalized.projectId, 'execution revision projectId'),
    taskId: identity(normalized.taskId, 'execution revision taskId'),
    taskRevision,
    taskDefinitionDigest,
    executorType: normalized.executorType,
    executionDigest: digest(
      normalized.contentDigest,
      'execution revision contentDigest',
    ),
  });
}

function admissionIdentity(
  planDigest: string,
  stepRunId: string,
  stepRunVersion: number,
): Readonly<{ attemptId: string; eventId: string }> {
  const value = createHash('sha256')
    .update(ID_DOMAIN)
    .update(planDigest, 'utf8')
    .update('\0', 'utf8')
    .update(stepRunId, 'utf8')
    .update('\0', 'utf8')
    .update(String(stepRunVersion), 'utf8')
    .digest('hex');
  return Object.freeze({
    attemptId: `wta:${value.slice(0, 32)}`,
    eventId: `wte:${value.slice(0, 32)}`,
  });
}

function unsignedReceipt(
  value: Omit<
    PluginPackageWorkflowTaskAttemptAdmissionReceipt,
    'receiptDigest'
  >,
): object {
  return {
    schema: value.schema,
    attemptId: value.attemptId,
    planDigest: value.planDigest,
    runId: value.runId,
    stepRunId: value.stepRunId,
    stepRunVersion: value.stepRunVersion,
    stepRunDigest: value.stepRunDigest,
    resourceTaskId: value.resourceTaskId,
    taskReconciliationReceiptDigest:
      value.taskReconciliationReceiptDigest,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    taskDefinitionDigest: value.taskDefinitionDigest,
    executorType: value.executorType,
    executionDigest: value.executionDigest,
    attemptNumber: value.attemptNumber,
    eventId: value.eventId,
    runVersion: value.runVersion,
    runEventSequence: value.runEventSequence,
    admittedAtMs: value.admittedAtMs,
  };
}

export function pluginPackageWorkflowTaskAttemptAdmissionReceiptDigest(
  value: Omit<
    PluginPackageWorkflowTaskAttemptAdmissionReceipt,
    'receiptDigest'
  >,
): string {
  return createHash('sha256')
    .update(RECEIPT_DOMAIN)
    .update(JSON.stringify(unsignedReceipt(value)), 'utf8')
    .digest('hex');
}

export function normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt(
  value: PluginPackageWorkflowTaskAttemptAdmissionReceipt,
): Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt> {
  const receipt = dataRecord(value, 'admission receipt');
  exactKeys(
    receipt,
    [
      'admittedAtMs',
      'attemptId',
      'attemptNumber',
      'eventId',
      'executionDigest',
      'executorType',
      'planDigest',
      'receiptDigest',
      'resourceTaskId',
      'runEventSequence',
      'runId',
      'runVersion',
      'schema',
      'stepRunDigest',
      'stepRunId',
      'stepRunVersion',
      'taskDefinitionDigest',
      'taskId',
      'taskReconciliationReceiptDigest',
      'taskRevision',
    ],
    [],
    'admission receipt',
  );
  if (
    value.schema !==
    PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_ADMISSION_SCHEMA
  ) {
    invalid('admission receipt schema is invalid');
  }
  const executorType = value.executorType;
  if (executorType !== 'local_process' && executorType !== 'remote_worker') {
    invalid('admission receipt executorType is invalid');
  }
  const taskDefinitionDigest = digest(
    value.taskDefinitionDigest,
    'admission receipt taskDefinitionDigest',
  );
  const taskRevision = identity(
    value.taskRevision,
    'admission receipt taskRevision',
  );
  const revisionMatch = TASK_REVISION.exec(taskRevision);
  if (!revisionMatch || revisionMatch[2] !== taskDefinitionDigest) {
    invalid('admission receipt Task revision is inconsistent');
  }
  const runVersion = integer(
    value.runVersion,
    1,
    2_147_483_647,
    'admission receipt Run version',
  );
  const runEventSequence = integer(
    value.runEventSequence,
    1,
    2_147_483_647,
    'admission receipt Run event sequence',
  );
  if (runVersion !== runEventSequence) {
    invalid('admission receipt Run counters are inconsistent');
  }
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_ADMISSION_SCHEMA,
    attemptId: identity(value.attemptId, 'admission receipt attemptId'),
    planDigest: digest(value.planDigest, 'admission receipt planDigest'),
    runId: identity(value.runId, 'admission receipt runId'),
    stepRunId: identity(value.stepRunId, 'admission receipt stepRunId'),
    stepRunVersion: integer(
      value.stepRunVersion,
      1,
      2_147_483_647,
      'admission receipt StepRun version',
    ),
    stepRunDigest: digest(
      value.stepRunDigest,
      'admission receipt StepRun digest',
    ),
    resourceTaskId: identity(
      value.resourceTaskId,
      'admission receipt resourceTaskId',
    ),
    taskReconciliationReceiptDigest: digest(
      value.taskReconciliationReceiptDigest,
      'admission receipt Task reconciliation digest',
    ),
    taskId: identity(value.taskId, 'admission receipt taskId'),
    taskRevision,
    taskDefinitionDigest,
    executorType,
    executionDigest: digest(
      value.executionDigest,
      'admission receipt executionDigest',
    ),
    attemptNumber: integer(
      value.attemptNumber,
      1,
      MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_ATTEMPTS,
      'admission receipt attemptNumber',
    ),
    eventId: identity(value.eventId, 'admission receipt eventId'),
    runVersion,
    runEventSequence,
    admittedAtMs: timestamp(
      value.admittedAtMs,
      'admission receipt admittedAtMs',
    ),
  });
  const receiptDigest = digest(
    value.receiptDigest,
    'admission receipt receiptDigest',
  );
  if (
    pluginPackageWorkflowTaskAttemptAdmissionReceiptDigest(unsigned) !==
    receiptDigest
  ) {
    invalid('admission receipt digest does not match');
  }
  return Object.freeze({ ...unsigned, receiptDigest });
}

export function createPluginPackageWorkflowTaskAttemptAdmission(
  value: CreatePluginPackageWorkflowTaskAttemptAdmissionInput,
): Readonly<PluginPackageWorkflowTaskAttemptAdmissionBundle> {
  const input = dataRecord(value, 'admission input');
  exactKeys(
    input,
    [
      'admittedAtMs',
      'attemptNumber',
      'execution',
      'plan',
      'run',
      'stepRun',
      'taskReconciliation',
    ],
    [],
    'admission input',
  );
  let plan: Readonly<PluginPackageWorkflowExecutionPlan>;
  let stepRun: Readonly<StepRunRecord>;
  let taskReconciliation:
    Readonly<PluginPackageTaskReconciliationReceipt>;
  try {
    plan = normalizePluginPackageWorkflowExecutionPlan(value.plan);
    stepRun = normalizeStepRunRecord(value.stepRun);
    taskReconciliation =
      normalizePluginPackageTaskReconciliationReceipt(
        value.taskReconciliation,
      );
  } catch {
    return invalid('durable Workflow evidence is invalid');
  }
  const execution = executionBinding(value.execution);
  const attemptNumber = integer(
    value.attemptNumber,
    1,
    MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_ATTEMPTS,
    'attemptNumber',
  );
  const admittedAtMs = timestamp(value.admittedAtMs, 'admittedAtMs');
  const run = value.run;
  if (
    !run ||
    typeof run !== 'object' ||
    Array.isArray(run) ||
    run.id !== plan.runId ||
    run.projectId !== plan.target.projectId ||
    run.taskId !== plan.target.workflowId ||
    run.taskRevision !== plan.target.publicationDigest ||
    run.triggerType !== 'plugin_package_workflow' ||
    run.executionOrigin !== 'system' ||
    run.executionOwner !== 'runtime' ||
    run.requestId !== plan.planId ||
    run.idempotencyKey !== `plugin-package-workflow:${plan.planId}` ||
    run.status !== 'running' ||
    run.cancelRequestedAtMs !== undefined ||
    !Number.isSafeInteger(run.version) ||
    run.version < 1 ||
    run.version !== run.eventSequence
  ) {
    invalid('Run does not match the admitted Workflow aggregate');
  }
  const planStep = plan.steps.find(
    ({ stepRunId }) => stepRunId === stepRun.id,
  );
  if (
    !planStep ||
    stepRun.runId !== run.id ||
    stepRun.stepKey !== planStep.stepKey ||
    stepRun.kind !== 'task' ||
    stepRun.definitionRef !== planStep.taskDefinitionRef ||
    stepRun.definitionDigest !== planStep.taskDefinitionDigest ||
    stepRun.required !== planStep.required ||
    stepRun.status !== 'ready' ||
    stepRun.attemptCount >= MAX_STEP_RUN_ATTEMPTS
  ) {
    invalid('StepRun is not one exact ready Task from the plan');
  }
  if (
    taskReconciliation.projectId !== plan.target.projectId ||
    taskReconciliation.packageName !== plan.target.packageName ||
    taskReconciliation.generation !== plan.target.generation ||
    taskReconciliation.generationDigest !== plan.target.generationDigest ||
    taskReconciliation.materializedRevisionDigest !==
      plan.target.materializedRevisionDigest ||
    taskReconciliation.lockDigest !== plan.target.lockDigest
  ) {
    invalid('Task reconciliation does not match the immutable plan');
  }
  const expectedTaskId = taskIdentity(
    plan.target.packageName,
    planStep.taskId,
  );
  const item = taskReconciliation.items.find(
    ({ taskId }) => taskId === expectedTaskId,
  );
  if (
    !item ||
    !ACTIVE_RECONCILIATION_DISPOSITIONS.has(item.disposition) ||
    execution.projectId !== plan.target.projectId ||
    execution.taskId !== item.taskId ||
    execution.taskDefinitionDigest !== item.contentDigest ||
    execution.taskRevision !==
      `qltd:v1:${item.revision}:${item.contentDigest}`
  ) {
    invalid('execution binding is not the reconciled Task revision');
  }
  if (
    admittedAtMs < plan.plannedAtMs ||
    admittedAtMs < taskReconciliation.committedAtMs ||
    admittedAtMs < stepRun.updatedAtMs
  ) {
    invalid('admission time precedes durable evidence');
  }
  if (
    run.version >= 2_147_483_647 ||
    run.eventSequence >= 2_147_483_647
  ) {
    invalid('Run counters overflowed');
  }
  const ids = admissionIdentity(
    plan.planDigest,
    stepRun.id,
    stepRun.version,
  );
  const nextRun = Object.freeze({
    ...run,
    version: run.version + 1,
    eventSequence: run.eventSequence + 1,
  });
  const attempt = Object.freeze({
    id: ids.attemptId,
    runId: run.id,
    stepRunId: stepRun.id,
    attempt: attemptNumber,
    status: 'claimed' as const,
    executorType: execution.executorType,
    callbackSequence: 0,
    createdAtMs: admittedAtMs,
  } satisfies RunAttemptRecord);
  const event = Object.freeze({
    id: ids.eventId,
    runId: run.id,
    sequence: nextRun.eventSequence,
    type: 'workflow.task_attempt_admitted',
    dedupeKey: ids.eventId,
    actorType: 'system' as const,
    attemptId: attempt.id,
    stepRunId: stepRun.id,
    payload: Object.freeze({
      planDigest: plan.planDigest,
      stepRunId: stepRun.id,
      stepRunVersion: stepRun.version,
      resourceTaskId: planStep.taskId,
      taskId: execution.taskId,
      taskRevision: execution.taskRevision,
      executorType: execution.executorType,
      executionDigest: execution.executionDigest,
      attemptNumber,
    }),
    createdAtMs: admittedAtMs,
  } satisfies RunEventRecord);
  const receiptUnsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_ADMISSION_SCHEMA,
    attemptId: attempt.id,
    planDigest: plan.planDigest,
    runId: run.id,
    stepRunId: stepRun.id,
    stepRunVersion: stepRun.version,
    stepRunDigest: stepRun.stepRunDigest,
    resourceTaskId: planStep.taskId,
    taskReconciliationReceiptDigest: taskReconciliation.receiptDigest,
    taskId: execution.taskId,
    taskRevision: execution.taskRevision,
    taskDefinitionDigest: execution.taskDefinitionDigest,
    executorType: execution.executorType,
    executionDigest: execution.executionDigest,
    attemptNumber,
    eventId: event.id,
    runVersion: nextRun.version,
    runEventSequence: nextRun.eventSequence,
    admittedAtMs,
  });
  const receipt =
    normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt({
      ...receiptUnsigned,
      receiptDigest:
        pluginPackageWorkflowTaskAttemptAdmissionReceiptDigest(
          receiptUnsigned,
        ),
    });
  return Object.freeze({ receipt, attempt, event, run: nextRun });
}

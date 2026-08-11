import { createHash } from 'node:crypto';

import {
  MAX_PLUGIN_PACKAGE_AUTOMATION_WORKFLOWS,
  normalizePluginPackageAutomationPublication,
  type PluginPackageAutomationPublication,
  type PluginPackageAutomationPublicationTarget,
} from '../pluginPackageAutomationPublication';
import {
  MAX_PLUGIN_PACKAGE_WORKFLOW_STEPS,
  normalizePluginPackageMaterializedRevision,
  normalizePluginPackageWorkflowResource,
  type PluginPackageMaterializedRevision,
  type PluginPackageTaskResource,
  type PluginPackageWorkflowResource,
} from '../pluginPackageResourceMaterialization';
import type { RunEventRecord, RunRecord } from '../../run/run';
import {
  createStepRunMutation,
  normalizeStepRunMutation,
  type StepRunMutation,
} from '../../run/stepRun';
import { TaskSpecSemanticRegistry } from '../../task-definition/taskSpecSemantic';

export const PLUGIN_PACKAGE_WORKFLOW_EXECUTION_PLAN_SCHEMA =
  'qinglong/plugin-package-workflow-execution-plan@v1' as const;
export const MAX_PLUGIN_PACKAGE_WORKFLOW_EXECUTION_PLAN_BYTES = 256 * 1024;
export const PLUGIN_PACKAGE_WORKFLOW_ADMISSION_RECEIPT_SCHEMA =
  'qinglong/plugin-package-workflow-admission-receipt@v1' as const;
export const MAX_PLUGIN_PACKAGE_WORKFLOW_ADMISSION_RECEIPT_BYTES = 256 * 1024;

export interface PluginPackageWorkflowExecutionPlanTarget
  extends PluginPackageAutomationPublicationTarget {
  readonly publicationDigest: string;
  readonly workflowId: string;
  readonly workflowDefinitionDigest: string;
}

export interface PluginPackageWorkflowExecutionPlanStep {
  readonly stepRunId: string;
  readonly stepKey: string;
  readonly taskId: string;
  readonly taskDefinitionRef: string;
  readonly taskDefinitionDigest: string;
  readonly needs: readonly string[];
  readonly initialStatus: 'pending' | 'ready';
  readonly required: true;
}

export interface PluginPackageWorkflowExecutionPlan {
  readonly schema: typeof PLUGIN_PACKAGE_WORKFLOW_EXECUTION_PLAN_SCHEMA;
  readonly planId: string;
  readonly runId: string;
  readonly target: Readonly<PluginPackageWorkflowExecutionPlanTarget>;
  readonly steps: readonly Readonly<PluginPackageWorkflowExecutionPlanStep>[];
  readonly plannedAtMs: number;
  readonly planDigest: string;
}

export interface CreatePluginPackageWorkflowExecutionPlanInput {
  readonly planId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly stepRunIds: Readonly<Record<string, string>>;
  readonly publication: Readonly<PluginPackageAutomationPublication>;
  readonly revision: Readonly<PluginPackageMaterializedRevision>;
  readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;
  readonly plannedAtMs: number;
}

export interface PluginPackageWorkflowAdmissionReceiptStep {
  readonly stepKey: string;
  readonly stepRunId: string;
  readonly stepRunDigest: string;
  readonly mutationId: string;
  readonly eventId: string;
}

export interface PluginPackageWorkflowAdmissionReceipt {
  readonly schema: typeof PLUGIN_PACKAGE_WORKFLOW_ADMISSION_RECEIPT_SCHEMA;
  readonly planId: string;
  readonly planDigest: string;
  readonly runId: string;
  readonly publicationDigest: string;
  readonly workflowId: string;
  readonly steps: readonly Readonly<PluginPackageWorkflowAdmissionReceiptStep>[];
  readonly finalRunVersion: number;
  readonly finalRunEventSequence: number;
  readonly admittedAtMs: number;
  readonly receiptDigest: string;
}

export interface PluginPackageWorkflowAdmissionBundle {
  readonly plan: Readonly<PluginPackageWorkflowExecutionPlan>;
  readonly run: Readonly<RunRecord>;
  readonly admissionEvent: Readonly<RunEventRecord>;
  readonly stepMutations: readonly Readonly<StepRunMutation>[];
  readonly receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
}

export interface PluginPackageWorkflowAdmissionRepository {
  findByPlanId(
    planId: string,
  ): Promise<Readonly<PluginPackageWorkflowAdmissionReceipt> | null>;
  findByRunId(
    runId: string,
  ): Promise<Readonly<PluginPackageWorkflowAdmissionReceipt> | null>;
  admit(plan: Readonly<PluginPackageWorkflowExecutionPlan>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
    }>
  >;
}

export class InvalidPluginPackageWorkflowExecutionPlanError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_EXECUTION_PLAN_INVALID';

  constructor(message: string) {
    super(`Plugin Package Workflow execution plan is invalid: ${message}`);
    this.name = 'InvalidPluginPackageWorkflowExecutionPlanError';
  }
}

export class PluginPackageWorkflowExecutionPlanConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_EXECUTION_PLAN_CONFLICT';

  constructor(message: string) {
    super(`Plugin Package Workflow cannot be planned: ${message}`);
    this.name = 'PluginPackageWorkflowExecutionPlanConflictError';
  }
}

export class InvalidPluginPackageWorkflowAdmissionReceiptError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_ADMISSION_RECEIPT_INVALID';

  constructor(message: string) {
    super(`Plugin Package Workflow admission receipt is invalid: ${message}`);
    this.name = 'InvalidPluginPackageWorkflowAdmissionReceiptError';
  }
}

export class PluginPackageWorkflowAdmissionConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_ADMISSION_CONFLICT';

  constructor(message: string) {
    super(`Plugin Package Workflow admission conflicts with state: ${message}`);
    this.name = 'PluginPackageWorkflowAdmissionConflictError';
  }
}

export class PluginPackageWorkflowAdmissionNotAllowedError extends Error {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_ADMISSION_NOT_ALLOWED';

  constructor() {
    super('Plugin Package Workflow admission is not allowed');
    this.name = 'PluginPackageWorkflowAdmissionNotAllowedError';
  }
}

export class PluginPackageWorkflowAdmissionUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_ADMISSION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package Workflow admission is unavailable', options);
    this.name = 'PluginPackageWorkflowAdmissionUnavailableError';
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PORTABLE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,62}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PLAN_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-workflow-execution-plan-digest@v1\0',
  'utf8',
);
const WORKFLOW_DEFINITION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-workflow-definition-digest@v1\0',
  'utf8',
);
const WORKFLOW_ADMISSION_RECEIPT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-workflow-admission-receipt-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidPluginPackageWorkflowExecutionPlanError(message);
}

function portableRunId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !PORTABLE_RUN_ID.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function conflict(message: string): never {
  throw new PluginPackageWorkflowExecutionPlanConflictError(message);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    return invalid(`${label} must contain enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key) => typeof key !== 'string') ||
    actual
      .map(String)
      .sort()
      .some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function denseArray(
  value: unknown,
  maximum: number,
  label: string,
  minimum = 1,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  const keys = Object.keys(value);
  const ownKeys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    ownKeys.length !== value.length + 1 ||
    !ownKeys.includes('length') ||
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index)) ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      );
    })
  ) {
    return invalid(`${label} must be a dense data array`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function resourceId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) {
    return invalid('packageName is invalid');
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 2_147_483_647
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid('plannedAtMs is invalid');
  }
  return value as number;
}

function hash(domain: Buffer, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

export function pluginPackageWorkflowDefinitionDigest(
  value: PluginPackageWorkflowResource,
): string {
  return hash(
    WORKFLOW_DEFINITION_DIGEST_DOMAIN,
    normalizePluginPackageWorkflowResource(value),
  );
}

function target(
  value: PluginPackageWorkflowExecutionPlanTarget,
): Readonly<PluginPackageWorkflowExecutionPlanTarget> {
  const record = dataRecord(value, 'plan target');
  exactKeys(
    record,
    [
      'generation',
      'generationDigest',
      'installationId',
      'lockDigest',
      'materializedRevisionDigest',
      'packageName',
      'projectId',
      'publicationDigest',
      'workflowDefinitionDigest',
      'workflowId',
    ],
    'plan target',
  );
  return Object.freeze({
    projectId: identifier(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
    installationId: identifier(value.installationId, 'installationId'),
    lockDigest: digest(value.lockDigest, 'lockDigest'),
    generation: positiveInteger(value.generation, 'generation'),
    generationDigest: digest(value.generationDigest, 'generationDigest'),
    materializedRevisionDigest: digest(
      value.materializedRevisionDigest,
      'materializedRevisionDigest',
    ),
    publicationDigest: digest(value.publicationDigest, 'publicationDigest'),
    workflowId: resourceId(value.workflowId, 'workflowId'),
    workflowDefinitionDigest: digest(
      value.workflowDefinitionDigest,
      'workflowDefinitionDigest',
    ),
  });
}

function taskDefinitionRef(
  materializedRevisionDigest: string,
  taskId: string,
): string {
  return `plugin-package:${materializedRevisionDigest}:task:${taskId}`;
}

function normalizeStep(
  value: PluginPackageWorkflowExecutionPlanStep,
  planTarget: Readonly<PluginPackageWorkflowExecutionPlanTarget>,
): Readonly<PluginPackageWorkflowExecutionPlanStep> {
  const step = dataRecord(value, 'plan step');
  exactKeys(
    step,
    [
      'initialStatus',
      'needs',
      'required',
      'stepKey',
      'stepRunId',
      'taskDefinitionDigest',
      'taskDefinitionRef',
      'taskId',
    ],
    'plan step',
  );
  if (
    (value.initialStatus !== 'pending' && value.initialStatus !== 'ready') ||
    value.required !== true
  ) {
    return invalid('plan step status or required flag is invalid');
  }
  const stepKey = resourceId(value.stepKey, 'stepKey');
  const taskId = resourceId(value.taskId, 'taskId');
  const needs = denseArray(
    value.needs,
    MAX_PLUGIN_PACKAGE_WORKFLOW_STEPS,
    'step needs',
    0,
  );
  const normalizedNeeds = Object.freeze(
    needs.map((need) => resourceId(need, 'step dependency')),
  );
  if (
    new Set(normalizedNeeds).size !== normalizedNeeds.length ||
    normalizedNeeds.includes(stepKey) ||
    [...normalizedNeeds]
      .sort()
      .some((need, index) => need !== normalizedNeeds[index]) ||
    (normalizedNeeds.length === 0) !== (value.initialStatus === 'ready')
  ) {
    return invalid('step dependency or initial status is invalid');
  }
  const expectedReference = taskDefinitionRef(
    planTarget.materializedRevisionDigest,
    taskId,
  );
  if (value.taskDefinitionRef !== expectedReference) {
    return invalid('taskDefinitionRef is not generation-bound');
  }
  return Object.freeze({
    stepRunId: identifier(value.stepRunId, 'stepRunId'),
    stepKey,
    taskId,
    taskDefinitionRef: expectedReference,
    taskDefinitionDigest: digest(
      value.taskDefinitionDigest,
      'taskDefinitionDigest',
    ),
    needs: normalizedNeeds,
    initialStatus: value.initialStatus,
    required: true,
  });
}

export function pluginPackageWorkflowExecutionPlanDigest(
  value:
    | Omit<PluginPackageWorkflowExecutionPlan, 'planDigest'>
    | PluginPackageWorkflowExecutionPlan,
): string {
  return hash(PLAN_DIGEST_DOMAIN, {
    schema: value.schema,
    planId: value.planId,
    runId: value.runId,
    target: value.target,
    steps: value.steps,
    plannedAtMs: value.plannedAtMs,
  });
}

function bounded(
  value: Readonly<PluginPackageWorkflowExecutionPlan>,
): Readonly<PluginPackageWorkflowExecutionPlan> {
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
    MAX_PLUGIN_PACKAGE_WORKFLOW_EXECUTION_PLAN_BYTES
  ) {
    return invalid('encoded plan exceeds its size limit');
  }
  return value;
}

function assertDag(
  steps: readonly Readonly<PluginPackageWorkflowExecutionPlanStep>[],
): void {
  const byKey = new Map(steps.map((step) => [step.stepKey, step]));
  if (
    byKey.size !== steps.length ||
    new Set(steps.map(({ stepRunId }) => stepRunId)).size !== steps.length ||
    steps.some(({ needs }) => needs.some((need) => !byKey.has(need)))
  ) {
    invalid('plan step identity or dependency is invalid');
  }
  const pending = new Map(
    steps.map((step) => [step.stepKey, new Set(step.needs)]),
  );
  const ready = [...pending.entries()]
    .filter(([, needs]) => needs.size === 0)
    .map(([stepKey]) => stepKey);
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.pop()!;
    if (!pending.delete(current)) continue;
    visited += 1;
    for (const [stepKey, needs] of pending) {
      if (needs.delete(current) && needs.size === 0) ready.push(stepKey);
    }
  }
  if (visited !== steps.length) invalid('plan graph contains a cycle');
}

export function normalizePluginPackageWorkflowExecutionPlan(
  value: PluginPackageWorkflowExecutionPlan,
): Readonly<PluginPackageWorkflowExecutionPlan> {
  const plan = dataRecord(value, 'plan');
  exactKeys(
    plan,
    [
      'planDigest',
      'planId',
      'plannedAtMs',
      'runId',
      'schema',
      'steps',
      'target',
    ],
    'plan',
  );
  if (value.schema !== PLUGIN_PACKAGE_WORKFLOW_EXECUTION_PLAN_SCHEMA) {
    return invalid('plan schema is invalid');
  }
  const normalizedTarget = target(value.target);
  const steps = denseArray(
    value.steps,
    MAX_PLUGIN_PACKAGE_WORKFLOW_STEPS,
    'plan steps',
  )
    .map((step) =>
      normalizeStep(
        step as PluginPackageWorkflowExecutionPlanStep,
        normalizedTarget,
      ),
    )
    .sort((left, right) => left.stepKey.localeCompare(right.stepKey));
  if (
    steps.some(
      (step, index) => index > 0 && steps[index - 1]!.stepKey === step.stepKey,
    )
  ) {
    return invalid('plan step identity is duplicated');
  }
  assertDag(steps);
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_EXECUTION_PLAN_SCHEMA,
    planId: identifier(value.planId, 'planId'),
    runId: portableRunId(value.runId, 'runId'),
    target: normalizedTarget,
    steps: Object.freeze(steps),
    plannedAtMs: timestamp(value.plannedAtMs),
  });
  const planDigest = digest(value.planDigest, 'planDigest');
  if (pluginPackageWorkflowExecutionPlanDigest(unsigned) !== planDigest) {
    return invalid('planDigest does not match plan');
  }
  return bounded(Object.freeze({ ...unsigned, planDigest }));
}

function assertPublicationRevisionBinding(
  publication: Readonly<PluginPackageAutomationPublication>,
  revision: Readonly<PluginPackageMaterializedRevision>,
): void {
  const generation = revision.generation;
  if (
    publication.state !== 'active' ||
    publication.target.projectId !== generation.projectId ||
    publication.target.packageName !== generation.packageName ||
    publication.target.installationId !== generation.installationId ||
    publication.target.lockDigest !== generation.lockDigest ||
    publication.target.generation !== generation.generation ||
    publication.target.generationDigest !== generation.generationDigest ||
    publication.target.materializedRevisionDigest !== revision.revisionDigest
  ) {
    conflict('publication is not the active definition of this revision');
  }
}

export function createPluginPackageWorkflowExecutionPlan(
  value: CreatePluginPackageWorkflowExecutionPlanInput,
): Readonly<PluginPackageWorkflowExecutionPlan> {
  const input = dataRecord(value, 'create input');
  exactKeys(
    input,
    [
      'planId',
      'plannedAtMs',
      'publication',
      'revision',
      'runId',
      'stepRunIds',
      'taskSpecSemanticRegistry',
      'workflowId',
    ],
    'create input',
  );
  if (!(value.taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry)) {
    return invalid('TaskSpec semantic registry is invalid');
  }
  const publication = normalizePluginPackageAutomationPublication(
    value.publication,
  );
  const revision = normalizePluginPackageMaterializedRevision(
    value.revision,
    value.taskSpecSemanticRegistry,
  );
  assertPublicationRevisionBinding(publication, revision);
  const workflowId = resourceId(value.workflowId, 'workflowId');
  const publicationWorkflow = publication.definitions.workflows.find(
    (workflow) => workflow.id === workflowId,
  );
  const revisionWorkflowResource = revision.resources.find(
    (resource) =>
      resource.kind === 'workflow' &&
      (resource.value as PluginPackageWorkflowResource).id === workflowId,
  );
  if (!publicationWorkflow || !revisionWorkflowResource) {
    return conflict('Workflow is not present in the exact publication');
  }
  const revisionWorkflow = normalizePluginPackageWorkflowResource(
    revisionWorkflowResource.value,
  );
  const workflowDefinitionDigest =
    pluginPackageWorkflowDefinitionDigest(publicationWorkflow);
  if (
    workflowDefinitionDigest !==
      pluginPackageWorkflowDefinitionDigest(revisionWorkflow) ||
    !publicationWorkflow.enabled
  ) {
    return conflict('Workflow definition drifted or is disabled');
  }
  if (
    publication.definitions.workflows.length >
    MAX_PLUGIN_PACKAGE_AUTOMATION_WORKFLOWS
  ) {
    return invalid('publication Workflow count exceeds the limit');
  }
  const tasks = new Map(
    revision.resources
      .filter(({ kind }) => kind === 'task')
      .map((resource) => [
        (resource.value as PluginPackageTaskResource).id,
        resource,
      ]),
  );
  const stepRunIds = dataRecord(value.stepRunIds, 'stepRunIds');
  exactKeys(
    stepRunIds,
    publicationWorkflow.steps.map(({ id }) => id),
    'stepRunIds',
  );
  if (publicationWorkflow.steps.length < 1) {
    return conflict('Workflow has no executable steps');
  }
  const planTarget = target({
    ...publication.target,
    publicationDigest: publication.publicationDigest,
    workflowId,
    workflowDefinitionDigest,
  });
  const steps = publicationWorkflow.steps.map((step) => {
    const taskResource = tasks.get(step.task);
    if (!taskResource) {
      return conflict('Workflow Task is absent from the exact revision');
    }
    const task = taskResource.value as PluginPackageTaskResource;
    if (!task.enabled) {
      return conflict('Workflow Task is disabled');
    }
    return normalizeStep(
      {
        stepRunId: stepRunIds[step.id] as string,
        stepKey: step.id,
        taskId: step.task,
        taskDefinitionRef: taskDefinitionRef(
          revision.revisionDigest,
          step.task,
        ),
        taskDefinitionDigest: taskResource.sourceDigest,
        needs: step.needs,
        initialStatus: step.needs.length === 0 ? 'ready' : 'pending',
        required: true,
      },
      planTarget,
    );
  });
  assertDag(steps);
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_EXECUTION_PLAN_SCHEMA,
    planId: identifier(value.planId, 'planId'),
    runId: portableRunId(value.runId, 'runId'),
    target: planTarget,
    steps: Object.freeze(
      [...steps].sort((left, right) =>
        left.stepKey.localeCompare(right.stepKey),
      ),
    ),
    plannedAtMs: timestamp(value.plannedAtMs),
  });
  const result = Object.freeze({
    ...unsigned,
    planDigest: pluginPackageWorkflowExecutionPlanDigest(unsigned),
  });
  return normalizePluginPackageWorkflowExecutionPlan(result);
}

function admissionIdentity(
  prefix: 'wfa' | 'wfe' | 'wfm',
  planDigest: string,
  index?: number,
): string {
  if (index === undefined) return `${prefix}:${planDigest.slice(0, 32)}`;
  const digestLength = prefix === 'wfe' ? 27 : 56;
  return `${prefix}:${planDigest.slice(0, digestLength)}:${index}`;
}

function receiptStep(
  value: PluginPackageWorkflowAdmissionReceiptStep,
): Readonly<PluginPackageWorkflowAdmissionReceiptStep> {
  const step = dataRecord(value, 'receipt step');
  exactKeys(
    step,
    ['eventId', 'mutationId', 'stepKey', 'stepRunDigest', 'stepRunId'],
    'receipt step',
  );
  return Object.freeze({
    stepKey: resourceId(value.stepKey, 'receipt stepKey'),
    stepRunId: identifier(value.stepRunId, 'receipt stepRunId'),
    stepRunDigest: digest(value.stepRunDigest, 'receipt stepRunDigest'),
    mutationId: identifier(value.mutationId, 'receipt mutationId'),
    eventId: identifier(value.eventId, 'receipt eventId'),
  });
}

function workflowAdmissionReceiptFields(
  value:
    | Omit<PluginPackageWorkflowAdmissionReceipt, 'receiptDigest'>
    | PluginPackageWorkflowAdmissionReceipt,
): Omit<PluginPackageWorkflowAdmissionReceipt, 'receiptDigest'> {
  return {
    schema: value.schema,
    planId: value.planId,
    planDigest: value.planDigest,
    runId: value.runId,
    publicationDigest: value.publicationDigest,
    workflowId: value.workflowId,
    steps: value.steps,
    finalRunVersion: value.finalRunVersion,
    finalRunEventSequence: value.finalRunEventSequence,
    admittedAtMs: value.admittedAtMs,
  };
}

export function pluginPackageWorkflowAdmissionReceiptDigest(
  value:
    | Omit<PluginPackageWorkflowAdmissionReceipt, 'receiptDigest'>
    | PluginPackageWorkflowAdmissionReceipt,
): string {
  return hash(
    WORKFLOW_ADMISSION_RECEIPT_DIGEST_DOMAIN,
    workflowAdmissionReceiptFields(value),
  );
}

export function normalizePluginPackageWorkflowAdmissionReceipt(
  value: PluginPackageWorkflowAdmissionReceipt,
): Readonly<PluginPackageWorkflowAdmissionReceipt> {
  const receipt = dataRecord(value, 'admission receipt');
  exactKeys(
    receipt,
    [
      'admittedAtMs',
      'finalRunEventSequence',
      'finalRunVersion',
      'planDigest',
      'planId',
      'publicationDigest',
      'receiptDigest',
      'runId',
      'schema',
      'steps',
      'workflowId',
    ],
    'admission receipt',
  );
  if (value.schema !== PLUGIN_PACKAGE_WORKFLOW_ADMISSION_RECEIPT_SCHEMA) {
    throw new InvalidPluginPackageWorkflowAdmissionReceiptError(
      'schema is invalid',
    );
  }
  const steps = denseArray(
    value.steps,
    MAX_PLUGIN_PACKAGE_WORKFLOW_STEPS,
    'receipt steps',
  )
    .map((step) =>
      receiptStep(step as PluginPackageWorkflowAdmissionReceiptStep),
    )
    .sort((left, right) => left.stepKey.localeCompare(right.stepKey));
  if (
    new Set(steps.map(({ stepKey }) => stepKey)).size !== steps.length ||
    new Set(steps.map(({ stepRunId }) => stepRunId)).size !== steps.length ||
    new Set(steps.map(({ mutationId }) => mutationId)).size !== steps.length ||
    new Set(steps.map(({ eventId }) => eventId)).size !== steps.length
  ) {
    throw new InvalidPluginPackageWorkflowAdmissionReceiptError(
      'step identity is duplicated',
    );
  }
  const finalCounter = steps.length + 1;
  if (
    value.finalRunVersion !== finalCounter ||
    value.finalRunEventSequence !== finalCounter
  ) {
    throw new InvalidPluginPackageWorkflowAdmissionReceiptError(
      'final Run counters are invalid',
    );
  }
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_ADMISSION_RECEIPT_SCHEMA,
    planId: identifier(value.planId, 'receipt planId'),
    planDigest: digest(value.planDigest, 'receipt planDigest'),
    runId: portableRunId(value.runId, 'receipt runId'),
    publicationDigest: digest(
      value.publicationDigest,
      'receipt publicationDigest',
    ),
    workflowId: resourceId(value.workflowId, 'receipt workflowId'),
    steps: Object.freeze(steps),
    finalRunVersion: finalCounter,
    finalRunEventSequence: finalCounter,
    admittedAtMs: timestamp(value.admittedAtMs),
  });
  const receiptDigest = digest(value.receiptDigest, 'receiptDigest');
  if (pluginPackageWorkflowAdmissionReceiptDigest(unsigned) !== receiptDigest) {
    throw new InvalidPluginPackageWorkflowAdmissionReceiptError(
      'receiptDigest does not match receipt',
    );
  }
  const normalized = Object.freeze({ ...unsigned, receiptDigest });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_PLUGIN_PACKAGE_WORKFLOW_ADMISSION_RECEIPT_BYTES
  ) {
    throw new InvalidPluginPackageWorkflowAdmissionReceiptError(
      'encoded receipt exceeds its size limit',
    );
  }
  return normalized;
}

export function createPluginPackageWorkflowAdmissionBundle(
  planValue: PluginPackageWorkflowExecutionPlan,
): Readonly<PluginPackageWorkflowAdmissionBundle> {
  const plan = normalizePluginPackageWorkflowExecutionPlan(planValue);
  const admissionEvent = Object.freeze({
    id: admissionIdentity('wfa', plan.planDigest),
    runId: plan.runId,
    sequence: 1,
    type: 'workflow.admitted',
    dedupeKey: admissionIdentity('wfa', plan.planDigest),
    actorType: 'system' as const,
    payload: Object.freeze({
      planId: plan.planId,
      planDigest: plan.planDigest,
      publicationDigest: plan.target.publicationDigest,
      workflowId: plan.target.workflowId,
      workflowDefinitionDigest: plan.target.workflowDefinitionDigest,
      stepCount: plan.steps.length,
    }),
    createdAtMs: plan.plannedAtMs,
  } satisfies RunEventRecord);
  const stepMutations = plan.steps.map((step, index) =>
    normalizeStepRunMutation(
      createStepRunMutation(
        {
          id: step.stepRunId,
          runId: plan.runId,
          stepKey: step.stepKey,
          kind: 'task',
          definitionRef: step.taskDefinitionRef,
          definitionDigest: step.taskDefinitionDigest,
          required: true,
          initialStatus: step.initialStatus,
          mutationId: admissionIdentity('wfm', plan.planDigest, index + 1),
          createdAtMs: plan.plannedAtMs,
        },
        {
          expectedRunVersion: index + 1,
          expectedRunEventSequence: index + 1,
          eventId: admissionIdentity('wfe', plan.planDigest, index + 1),
          dedupeKey: admissionIdentity('wfe', plan.planDigest, index + 1),
          actor: { type: 'system' },
        },
      ),
    ),
  );
  const finalCounter = stepMutations.length + 1;
  const run = Object.freeze({
    id: plan.runId,
    projectId: plan.target.projectId,
    taskId: plan.target.workflowId,
    taskRevision: plan.target.publicationDigest,
    taskSnapshotRef:
      `plugin-package:${plan.target.publicationDigest}:workflow:` +
      plan.target.workflowId,
    triggerType: 'plugin_package_workflow',
    executionOrigin: 'system' as const,
    executionOwner: 'runtime' as const,
    requestId: plan.planId,
    status: 'running' as const,
    version: finalCounter,
    eventSequence: finalCounter,
    priority: 0,
    idempotencyKey: `plugin-package-workflow:${plan.planId}`,
    createdAtMs: plan.plannedAtMs,
    startedAtMs: plan.plannedAtMs,
  } satisfies RunRecord);
  const receiptUnsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_ADMISSION_RECEIPT_SCHEMA,
    planId: plan.planId,
    planDigest: plan.planDigest,
    runId: plan.runId,
    publicationDigest: plan.target.publicationDigest,
    workflowId: plan.target.workflowId,
    steps: Object.freeze(
      stepMutations.map((mutation) =>
        Object.freeze({
          stepKey: mutation.stepRun.stepKey,
          stepRunId: mutation.stepRun.id,
          stepRunDigest: mutation.stepRun.stepRunDigest,
          mutationId: mutation.mutationId,
          eventId: mutation.event.id,
        }),
      ),
    ),
    finalRunVersion: finalCounter,
    finalRunEventSequence: finalCounter,
    admittedAtMs: plan.plannedAtMs,
  });
  const receipt = normalizePluginPackageWorkflowAdmissionReceipt({
    ...receiptUnsigned,
    receiptDigest: pluginPackageWorkflowAdmissionReceiptDigest(receiptUnsigned),
  });
  return Object.freeze({
    plan,
    run,
    admissionEvent,
    stepMutations: Object.freeze(stepMutations),
    receipt,
  });
}

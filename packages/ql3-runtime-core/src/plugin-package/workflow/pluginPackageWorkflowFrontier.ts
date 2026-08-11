import { createHash } from 'node:crypto';

import {
  normalizePluginPackageWorkflowExecutionPlan,
  type PluginPackageWorkflowExecutionPlan,
} from './pluginPackageWorkflowExecutionPlan';
import type { RunEventRecord, RunRecord, RunStatus } from '../../run/run';
import {
  STEP_RUN_TERMINAL_STATUSES,
  normalizeStepRunRecord,
  transitionStepRunMutation,
  type StepRunMutation,
  type StepRunRecord,
  type StepRunStatus,
} from '../../run/stepRun';

export const PLUGIN_PACKAGE_WORKFLOW_FRONTIER_SCHEMA =
  'qinglong/plugin-package-workflow-frontier@v1' as const;
export const MAX_PLUGIN_PACKAGE_WORKFLOW_FRONTIER_PAGE_SIZE = 64;

export type PluginPackageWorkflowTerminalStatus = Extract<
  RunStatus,
  'succeeded' | 'failed' | 'cancelled' | 'timed_out'
>;

export interface PluginPackageWorkflowFrontierSnapshot {
  readonly plan: Readonly<PluginPackageWorkflowExecutionPlan>;
  readonly run: Readonly<RunRecord>;
  readonly stepRuns: readonly Readonly<StepRunRecord>[];
  readonly observedAtMs: number;
}

export interface PluginPackageWorkflowFrontierResolution {
  readonly schema: typeof PLUGIN_PACKAGE_WORKFLOW_FRONTIER_SCHEMA;
  readonly runId: string;
  readonly planDigest: string;
  readonly expectedRunVersion: number;
  readonly expectedRunEventSequence: number;
  readonly stepMutations: readonly Readonly<StepRunMutation>[];
  readonly readyStepRunIds: readonly string[];
  readonly terminalStatus: PluginPackageWorkflowTerminalStatus | null;
  readonly terminalTransition: Readonly<PluginPackageWorkflowTerminalTransition> | null;
  readonly observedAtMs: number;
}

export interface PluginPackageWorkflowTerminalTransition {
  readonly expectedRunVersion: number;
  readonly expectedRunEventSequence: number;
  readonly status: PluginPackageWorkflowTerminalStatus;
  readonly finishedAtMs: number;
  readonly errorCode: string | null;
  readonly event: Readonly<RunEventRecord>;
}

export interface PluginPackageWorkflowFrontierCursor {
  readonly admittedAtMs: number;
  readonly planDigest: string;
}

export interface PluginPackageWorkflowFrontierCandidate
  extends PluginPackageWorkflowFrontierCursor {
  readonly runId: string;
}

export interface PluginPackageWorkflowFrontierPage {
  readonly candidates: readonly Readonly<PluginPackageWorkflowFrontierCandidate>[];
  readonly truncated: boolean;
  readonly next?: Readonly<PluginPackageWorkflowFrontierCursor>;
}

export interface PluginPackageWorkflowFrontierAdvanceResult {
  readonly status: 'advanced' | 'unchanged' | 'terminal' | 'settled';
  readonly runId: string;
  readonly planDigest: string;
  readonly stepMutationCount: number;
  readonly readyStepRunIds: readonly string[];
  readonly terminalStatus: PluginPackageWorkflowTerminalStatus | null;
  readonly runVersion: number;
  readonly runEventSequence: number;
  readonly observedAtMs: number;
}

export interface PluginPackageWorkflowFrontierRepository {
  listCandidates(query: Readonly<{
    limit: number;
    after?: Readonly<PluginPackageWorkflowFrontierCursor>;
  }>): Promise<Readonly<PluginPackageWorkflowFrontierPage>>;
  advance(
    runId: string,
  ): Promise<Readonly<PluginPackageWorkflowFrontierAdvanceResult>>;
}

export class InvalidPluginPackageWorkflowFrontierError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_FRONTIER_INVALID';

  constructor(message: string) {
    super(`Plugin Package Workflow frontier is invalid: ${message}`);
    this.name = 'InvalidPluginPackageWorkflowFrontierError';
  }
}

export class PluginPackageWorkflowFrontierConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_FRONTIER_CONFLICT';

  constructor() {
    super('Plugin Package Workflow frontier changed concurrently');
    this.name = 'PluginPackageWorkflowFrontierConflictError';
  }
}

export class PluginPackageWorkflowFrontierUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_WORKFLOW_FRONTIER_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package Workflow frontier is unavailable', options);
    this.name = 'PluginPackageWorkflowFrontierUnavailableError';
  }
}

const FRONTIER_ID_DOMAIN = Buffer.from(
  'qinglong/plugin-package-workflow-frontier-id@v1\0',
  'utf8',
);
const BLOCKING_TERMINAL_STATUSES = new Set<StepRunStatus>([
  'failed',
  'skipped',
  'cancelled',
  'timed_out',
]);
const TERMINAL_STATUSES = new Set<StepRunStatus>(
  STEP_RUN_TERMINAL_STATUSES,
);

function invalid(message: string): never {
  throw new InvalidPluginPackageWorkflowFrontierError(message);
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid('observation time is invalid');
  }
  return value as number;
}

function counter(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function frontierIdentity(
  planDigest: string,
  stepRun: Readonly<StepRunRecord>,
  target: 'ready' | 'skipped',
): Readonly<{ eventId: string; mutationId: string }> {
  const digest = createHash('sha256')
    .update(FRONTIER_ID_DOMAIN)
    .update(planDigest, 'utf8')
    .update('\0', 'utf8')
    .update(stepRun.id, 'utf8')
    .update('\0', 'utf8')
    .update(String(stepRun.version), 'utf8')
    .update('\0', 'utf8')
    .update(target, 'utf8')
    .digest('hex');
  return Object.freeze({
    eventId: `wff:${digest.slice(0, 32)}`,
    mutationId: `workflow-frontier:${digest}`,
  });
}

function terminalIdentity(
  planDigest: string,
  runVersion: number,
  status: PluginPackageWorkflowTerminalStatus,
): string {
  const digest = createHash('sha256')
    .update(FRONTIER_ID_DOMAIN)
    .update(planDigest, 'utf8')
    .update('\0terminal\0', 'utf8')
    .update(String(runVersion), 'utf8')
    .update('\0', 'utf8')
    .update(status, 'utf8')
    .digest('hex');
  return `wft:${digest.slice(0, 32)}`;
}

function terminalErrorCode(
  status: PluginPackageWorkflowTerminalStatus,
): string | null {
  if (status === 'succeeded') return null;
  if (status === 'failed') return 'workflow_step_failed';
  if (status === 'timed_out') return 'workflow_step_timed_out';
  return 'workflow_step_cancelled';
}

function validateRun(
  plan: Readonly<PluginPackageWorkflowExecutionPlan>,
  run: Readonly<RunRecord>,
): void {
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
    run.cancelRequestedAtMs !== undefined
  ) {
    invalid('Run does not match the admitted Workflow');
  }
  counter(run.version, 'Run version');
  counter(run.eventSequence, 'Run event sequence');
}

function validateStepRuns(
  plan: Readonly<PluginPackageWorkflowExecutionPlan>,
  stepRunValues: readonly Readonly<StepRunRecord>[],
): ReadonlyMap<string, Readonly<StepRunRecord>> {
  if (
    !Array.isArray(stepRunValues) ||
    stepRunValues.length !== plan.steps.length
  ) {
    return invalid('StepRun set is incomplete');
  }
  const byKey = new Map<string, Readonly<StepRunRecord>>();
  for (const value of stepRunValues) {
    let stepRun: Readonly<StepRunRecord>;
    try {
      stepRun = normalizeStepRunRecord(value);
    } catch {
      return invalid('StepRun record is invalid');
    }
    const step = plan.steps.find(({ stepKey }) => stepKey === stepRun.stepKey);
    if (
      !step ||
      byKey.has(step.stepKey) ||
      stepRun.id !== step.stepRunId ||
      stepRun.runId !== plan.runId ||
      stepRun.parentStepRunId !== null ||
      stepRun.kind !== 'task' ||
      stepRun.definitionRef !== step.taskDefinitionRef ||
      stepRun.definitionDigest !== step.taskDefinitionDigest ||
      stepRun.required !== step.required
    ) {
      return invalid('StepRun does not match the immutable plan');
    }
    byKey.set(step.stepKey, stepRun);
  }
  return byKey;
}

function dependencyCannotSucceed(
  stepKey: string,
  plan: Readonly<PluginPackageWorkflowExecutionPlan>,
  stepRuns: ReadonlyMap<string, Readonly<StepRunRecord>>,
  memo: Map<string, boolean>,
  visiting: Set<string>,
): boolean {
  const memoized = memo.get(stepKey);
  if (memoized !== undefined) return memoized;
  if (visiting.has(stepKey)) {
    return invalid('Workflow dependency graph is cyclic');
  }
  const step = plan.steps.find((candidate) => candidate.stepKey === stepKey);
  const stepRun = stepRuns.get(stepKey);
  if (!step || !stepRun) return invalid('Workflow dependency is missing');
  if (BLOCKING_TERMINAL_STATUSES.has(stepRun.status)) {
    memo.set(stepKey, true);
    return true;
  }
  if (stepRun.status !== 'pending') {
    memo.set(stepKey, false);
    return false;
  }
  visiting.add(stepKey);
  const blocked = step.needs.some((dependency) =>
    dependencyCannotSucceed(
      dependency,
      plan,
      stepRuns,
      memo,
      visiting,
    ),
  );
  visiting.delete(stepKey);
  memo.set(stepKey, blocked);
  return blocked;
}

function terminalStatus(
  statuses: readonly StepRunStatus[],
): PluginPackageWorkflowTerminalStatus | null {
  if (!statuses.every((status) => TERMINAL_STATUSES.has(status))) return null;
  if (statuses.includes('failed') || statuses.includes('skipped')) {
    return 'failed';
  }
  if (statuses.includes('timed_out')) return 'timed_out';
  if (statuses.includes('cancelled')) return 'cancelled';
  return 'succeeded';
}

export function resolvePluginPackageWorkflowFrontier(
  value: PluginPackageWorkflowFrontierSnapshot,
): Readonly<PluginPackageWorkflowFrontierResolution> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('snapshot is invalid');
  }
  const plan = normalizePluginPackageWorkflowExecutionPlan(value.plan);
  validateRun(plan, value.run);
  const observedAtMs = timestamp(value.observedAtMs);
  const byKey = validateStepRuns(plan, value.stepRuns);
  if (
    [...byKey.values()].some(
      (stepRun) => observedAtMs < stepRun.updatedAtMs,
    )
  ) {
    return invalid('observation time precedes StepRun state');
  }

  const blockedMemo = new Map<string, boolean>();
  const projectedStatuses = new Map(
    [...byKey].map(([stepKey, stepRun]) => [stepKey, stepRun.status]),
  );
  const mutations: Readonly<StepRunMutation>[] = [];
  let runVersion = value.run.version;
  let runEventSequence = value.run.eventSequence;

  for (const step of plan.steps) {
    const stepRun = byKey.get(step.stepKey)!;
    if (stepRun.status !== 'pending') continue;
    const blocked = dependencyCannotSucceed(
      step.stepKey,
      plan,
      byKey,
      blockedMemo,
      new Set(),
    );
    const allDependenciesSucceeded = step.needs.every(
      (dependency) => byKey.get(dependency)!.status === 'succeeded',
    );
    if (!blocked && !allDependenciesSucceeded) continue;
    const target = blocked ? 'skipped' : 'ready';
    const identity = frontierIdentity(plan.planDigest, stepRun, target);
    const mutation = transitionStepRunMutation(
      stepRun,
      {
        expectedVersion: stepRun.version,
        expectedDigest: stepRun.stepRunDigest,
        mutationId: identity.mutationId,
        to: target,
        atMs: observedAtMs,
        ...(target === 'skipped'
          ? { resultCode: 'dependency_not_succeeded' }
          : {}),
      },
      {
        expectedRunVersion: runVersion,
        expectedRunEventSequence: runEventSequence,
        eventId: identity.eventId,
        dedupeKey: identity.eventId,
        actor: { type: 'reconciler' },
      },
    );
    mutations.push(mutation);
    projectedStatuses.set(step.stepKey, target);
    runVersion += 1;
    runEventSequence += 1;
  }

  const readyStepRunIds = plan.steps
    .filter((step) => projectedStatuses.get(step.stepKey) === 'ready')
    .map((step) => step.stepRunId);
  const aggregateStatus = terminalStatus(
    plan.steps.map((step) => projectedStatuses.get(step.stepKey)!),
  );
  const terminalTransition =
    aggregateStatus === null
      ? null
      : (() => {
          const eventId = terminalIdentity(
            plan.planDigest,
            runVersion,
            aggregateStatus,
          );
          return Object.freeze({
            expectedRunVersion: runVersion,
            expectedRunEventSequence: runEventSequence,
            status: aggregateStatus,
            finishedAtMs: observedAtMs,
            errorCode: terminalErrorCode(aggregateStatus),
            event: Object.freeze({
              id: eventId,
              runId: plan.runId,
              sequence: runEventSequence + 1,
              type: `workflow.${aggregateStatus}`,
              dedupeKey: eventId,
              actorType: 'reconciler',
              payload: Object.freeze({
                planDigest: plan.planDigest,
                workflowId: plan.target.workflowId,
                stepCount: plan.steps.length,
                status: aggregateStatus,
              }),
              createdAtMs: observedAtMs,
            }),
          } satisfies PluginPackageWorkflowTerminalTransition);
        })();

  return Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_FRONTIER_SCHEMA,
    runId: plan.runId,
    planDigest: plan.planDigest,
    expectedRunVersion: value.run.version,
    expectedRunEventSequence: value.run.eventSequence,
    stepMutations: Object.freeze(mutations),
    readyStepRunIds: Object.freeze(readyStepRunIds),
    terminalStatus: aggregateStatus,
    terminalTransition,
    observedAtMs,
  });
}

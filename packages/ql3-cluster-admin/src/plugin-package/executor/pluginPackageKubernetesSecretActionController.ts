import type {
  ApprovedActionExecutionSnapshot,
  ClaimApprovedActionExecutionCommand,
  ClaimApprovedActionExecutionResult,
  CompleteApprovedActionExecutionCommand,
  ReleaseApprovedActionExecutionBeforeStartCommand,
} from '@qinglong/runtime-core/approved-action-execution';
import {
  PLUGIN_PACKAGE_SECRET_BINDING_ACTION_TYPE,
  createPluginPackageSecretBindingFromApprovalPlan,
  normalizePluginPackageSecretBindingApprovalPlan,
  type PluginPackageSecretBindingApprovalPlan,
} from '@qinglong/runtime-core/plugin-package-secret-binding-approval-plan';
import type { PluginPackageSecretBinding } from '@qinglong/runtime-core/plugin-package-secret-binding';
import {
  PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_ACTION_TYPE,
  normalizePluginPackageSecretBindingTransitionApprovalPlan,
  type PluginPackageSecretBindingTransitionApprovalPlan,
} from '@qinglong/runtime-core/plugin-package-secret-binding-transition-approval-plan';
import {
  createPluginPackageSecretBindingFromTransitionPlan,
  createPluginPackageSecretBindingTransitionReceipt,
  type PluginPackageSecretBindingTransitionReceipt,
} from '@qinglong/runtime-core/plugin-package-secret-binding-transition-receipt';

import {
  createPluginPackageKubernetesSecretActionJob,
  type PluginPackageKubernetesSecretActionJobOptions,
} from './pluginPackageKubernetesSecretActionJob';

const FIELD_MANAGER = 'qinglong-plugin-package-secret-action-controller';
const RECOVERY_OWNER = 'qinglong-secret-action-controller';
const RECOVERY_LEASE_DURATION_MS = 60_000;
const MAX_PAGE_SIZE = 32;

type SecretActionApprovalPlan =
  | PluginPackageSecretBindingApprovalPlan
  | PluginPackageSecretBindingTransitionApprovalPlan;

type JsonObject = Record<string, unknown>;

export interface PluginPackageSecretActionApprovalPlanReader<T> {
  findByActionRef(actionRef: string): Promise<Readonly<T> | null>;
}

export interface PluginPackageKubernetesSecretActionExecutionPort {
  listReconciliableExecutions(query: Readonly<{
    nowMs: number;
    limit: number;
    actionTypes: readonly string[];
  }>): Promise<Readonly<{
    executions: readonly Readonly<ApprovedActionExecutionSnapshot>[];
    truncated: boolean;
  }>>;
  completeExecution(
    command: CompleteApprovedActionExecutionCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>>;
  claimExecution(
    command: ClaimApprovedActionExecutionCommand,
  ): Promise<ClaimApprovedActionExecutionResult>;
  releaseExecutionBeforeStart(
    command: ReleaseApprovedActionExecutionBeforeStartCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>>;
}

export interface PluginPackageSecretActionDurableResultReader<T> {
  find(generationDigest: string): Promise<Readonly<T> | null>;
}

export interface PluginPackageKubernetesSecretActionJobResource {
  readonly metadata?: Readonly<{
    name?: string;
    namespace?: string;
    labels?: Readonly<Record<string, string>>;
    annotations?: Readonly<Record<string, string>>;
  }>;
  readonly spec?: Readonly<Record<string, unknown>>;
  readonly status?: Readonly<{
    conditions?: readonly Readonly<{
      type?: string;
      status?: string;
    }>[];
  }>;
}

export interface PluginPackageKubernetesSecretActionJobApi {
  createNamespacedJob(
    request: Readonly<{
      namespace: string;
      body: Readonly<Record<string, unknown>>;
      fieldManager: typeof FIELD_MANAGER;
      fieldValidation: 'Strict';
    }>,
  ): Promise<PluginPackageKubernetesSecretActionJobResource>;
  readNamespacedJob(
    request: Readonly<{
      name: string;
      namespace: string;
    }>,
  ): Promise<PluginPackageKubernetesSecretActionJobResource>;
}

export interface PluginPackageKubernetesSecretActionControllerOptions {
  readonly executions: PluginPackageKubernetesSecretActionExecutionPort;
  readonly bindingPlans: PluginPackageSecretActionApprovalPlanReader<PluginPackageSecretBindingApprovalPlan>;
  readonly transitionPlans: PluginPackageSecretActionApprovalPlanReader<PluginPackageSecretBindingTransitionApprovalPlan>;
  readonly bindings: PluginPackageSecretActionDurableResultReader<PluginPackageSecretBinding>;
  readonly transitionReceipts: PluginPackageSecretActionDurableResultReader<PluginPackageSecretBindingTransitionReceipt>;
  readonly jobs: PluginPackageKubernetesSecretActionJobApi;
  readonly job: Readonly<PluginPackageKubernetesSecretActionJobOptions>;
  readonly now?: () => number;
}

export interface PluginPackageKubernetesSecretActionControllerSummary {
  readonly scanned: number;
  readonly created: number;
  readonly existing: number;
  readonly active: number;
  readonly recoveredSucceeded: number;
  readonly recoveredFailed: number;
  readonly recoveredBlocked: number;
  readonly recoveryRequired: number;
  readonly unavailable: number;
  readonly truncated: boolean;
}

export interface ClusterPluginPackageKubernetesSecretActionControllerResource {
  readonly controller: PluginPackageKubernetesSecretActionController;
  dispose(): void;
}

export class PluginPackageKubernetesSecretActionControllerConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_KUBERNETES_SECRET_ACTION_CONTROLLER_CONFLICT';

  constructor() {
    super('Kubernetes Secret action Job conflicts with the durable dispatch');
    this.name = 'PluginPackageKubernetesSecretActionControllerConflictError';
  }
}

export class PluginPackageKubernetesSecretActionControllerUnavailableError extends Error {
  readonly code =
    'PLUGIN_PACKAGE_KUBERNETES_SECRET_ACTION_CONTROLLER_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Kubernetes Secret action Job authority is unavailable', options);
    this.name =
      'PluginPackageKubernetesSecretActionControllerUnavailableError';
  }
}

function apiStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  if ('code' in error && typeof error.code === 'number') return error.code;
  if (
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'statusCode' in error.response &&
    typeof error.response.statusCode === 'number'
  ) {
    return error.response.statusCode;
  }
  return null;
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function expectedSubset(expected: unknown, observed: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(observed) &&
      expected.length === observed.length &&
      expected.every((value, index) => expectedSubset(value, observed[index]))
    );
  }
  const expectedObject = object(expected);
  if (expectedObject) {
    const observedObject = object(observed);
    return (
      observedObject !== null &&
      Object.entries(expectedObject).every(([key, value]) =>
        expectedSubset(value, observedObject[key]),
      )
    );
  }
  return Object.is(expected, observed);
}

function terminalStatus(
  job: Readonly<PluginPackageKubernetesSecretActionJobResource>,
): 'active' | 'complete' | 'failed' {
  const conditions = job.status?.conditions ?? [];
  const complete = conditions.some(
    (condition) => condition.type === 'Complete' && condition.status === 'True',
  );
  const failed = conditions.some(
    (condition) => condition.type === 'Failed' && condition.status === 'True',
  );
  if (complete && failed) {
    throw new PluginPackageKubernetesSecretActionControllerConflictError();
  }
  if (complete) return 'complete';
  if (failed) return 'failed';
  return 'active';
}

function assertObservedJob(
  expected: Readonly<Record<string, unknown>>,
  observed: Readonly<PluginPackageKubernetesSecretActionJobResource>,
): void {
  const expectedMetadata = object(expected.metadata)!;
  const expectedSpec = object(expected.spec)!;
  const observedMetadata = observed.metadata;
  const observedPodSpec = object(
    object(object(observed.spec)?.template)?.spec,
  );
  if (
    observedMetadata?.name !== expectedMetadata.name ||
    observedMetadata?.namespace !== expectedMetadata.namespace ||
    !expectedSubset(expectedMetadata.labels, observedMetadata?.labels) ||
    !expectedSubset(expectedMetadata.annotations, observedMetadata?.annotations) ||
    !expectedSubset(expectedSpec, observed.spec) ||
    observedPodSpec === null ||
    observedPodSpec.hostNetwork === true ||
    observedPodSpec.hostPID === true ||
    observedPodSpec.hostIPC === true ||
    (Array.isArray(observedPodSpec.initContainers) &&
      observedPodSpec.initContainers.length > 0) ||
    (Array.isArray(observedPodSpec.ephemeralContainers) &&
      observedPodSpec.ephemeralContainers.length > 0)
  ) {
    throw new PluginPackageKubernetesSecretActionControllerConflictError();
  }
}

export class PluginPackageKubernetesSecretActionController {
  readonly #now: () => number;

  constructor(
    private readonly options: PluginPackageKubernetesSecretActionControllerOptions,
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      !options.executions ||
      typeof options.executions.listReconciliableExecutions !== 'function' ||
      typeof options.executions.completeExecution !== 'function' ||
      typeof options.executions.claimExecution !== 'function' ||
      typeof options.executions.releaseExecutionBeforeStart !== 'function' ||
      !options.bindingPlans ||
      typeof options.bindingPlans.findByActionRef !== 'function' ||
      !options.transitionPlans ||
      typeof options.transitionPlans.findByActionRef !== 'function' ||
      !options.bindings ||
      typeof options.bindings.find !== 'function' ||
      !options.transitionReceipts ||
      typeof options.transitionReceipts.find !== 'function' ||
      !options.jobs ||
      typeof options.jobs.createNamespacedJob !== 'function' ||
      typeof options.jobs.readNamespacedJob !== 'function' ||
      !options.job ||
      typeof options.job !== 'object' ||
      (options.now !== undefined && typeof options.now !== 'function')
    ) {
      throw new TypeError('Kubernetes Secret action controller options are invalid');
    }
    this.#now = options.now ?? Date.now;
  }

  async reconcile(
    input: Readonly<{ limit?: number }> = {},
  ): Promise<Readonly<PluginPackageKubernetesSecretActionControllerSummary>> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'limit')
    ) {
      throw new TypeError('Kubernetes Secret action reconciliation is invalid');
    }
    const limit = input.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new RangeError('Kubernetes Secret action reconciliation limit is invalid');
    }
    const nowMs = this.#now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError('Kubernetes Secret action controller clock is invalid');
    }
    let page;
    try {
      page = await this.options.executions.listReconciliableExecutions({
        nowMs,
        limit,
        actionTypes: Object.freeze([
          PLUGIN_PACKAGE_SECRET_BINDING_ACTION_TYPE,
          PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_ACTION_TYPE,
        ]),
      });
    } catch (error) {
      throw new PluginPackageKubernetesSecretActionControllerUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    const summary = {
      scanned: page.executions.length,
      created: 0,
      existing: 0,
      active: 0,
      recoveredSucceeded: 0,
      recoveredFailed: 0,
      recoveredBlocked: 0,
      recoveryRequired: 0,
      unavailable: 0,
      truncated: page.truncated,
    };
    for (const snapshot of page.executions) {
      try {
        const result = await this.#reconcileOne(snapshot, nowMs);
        summary[result] += 1;
      } catch (error) {
        if (
          error instanceof
          PluginPackageKubernetesSecretActionControllerConflictError
        ) {
          throw error;
        }
        summary.unavailable += 1;
      }
    }
    return Object.freeze({ ...summary });
  }

  async #reconcileOne(
    snapshot: Readonly<ApprovedActionExecutionSnapshot>,
    nowMs: number,
  ): Promise<
    | 'created'
    | 'existing'
    | 'active'
    | 'recoveredSucceeded'
    | 'recoveredFailed'
    | 'recoveredBlocked'
    | 'recoveryRequired'
  > {
    const plan = await this.#plan(snapshot);
    if (!plan) {
      throw new PluginPackageKubernetesSecretActionControllerUnavailableError();
    }
    const desired = createPluginPackageKubernetesSecretActionJob({
      dispatch: snapshot.dispatch,
      approvalPlan: plan,
      options: this.options.job,
    });
    const metadata = object(desired.metadata)!;
    const name = metadata.name as string;
    const namespace = metadata.namespace as string;
    let observed: PluginPackageKubernetesSecretActionJobResource;
    let disposition: 'created' | 'existing' | 'active' = 'active';
    try {
      observed = await this.options.jobs.readNamespacedJob({ name, namespace });
    } catch (error) {
      if (apiStatus(error) !== 404) throw error;
      if (
        snapshot.execution.status === 'executing'
      ) {
        return this.#recoverMissingExecuting(
          snapshot,
          plan,
          name,
          nowMs,
        );
      }
      if (nowMs > plan.expiresAtMs) {
        return this.#blockBeforeStart(
          snapshot,
          name,
          nowMs,
          'package_secret_action_approval_expired',
        );
      }
      try {
        observed = await this.options.jobs.createNamespacedJob({
          namespace,
          body: desired,
          fieldManager: FIELD_MANAGER,
          fieldValidation: 'Strict',
        });
        disposition = 'created';
      } catch (createError) {
        // CREATE may have succeeded even when its response was lost. Converge
        // every ambiguous failure through an exact-name GET before surfacing it.
        try {
          observed = await this.options.jobs.readNamespacedJob({
            name,
            namespace,
          });
        } catch (readAfterCreateError) {
          if (apiStatus(readAfterCreateError) === 404) throw createError;
          throw readAfterCreateError;
        }
        disposition = 'existing';
      }
    }
    assertObservedJob(desired, observed);
    const terminal = terminalStatus(observed);
    if (terminal !== 'active') {
      return this.#recoverTerminal(snapshot, plan, name, terminal, nowMs);
    }
    return disposition;
  }

  async #recoverTerminal(
    snapshot: Readonly<ApprovedActionExecutionSnapshot>,
    plan: Readonly<SecretActionApprovalPlan>,
    jobName: string,
    terminal: 'complete' | 'failed',
    nowMs: number,
  ): Promise<
    'recoveredSucceeded' | 'recoveredFailed' | 'recoveredBlocked' | 'recoveryRequired'
  > {
    const execution = snapshot.execution;
    if (execution.status !== 'executing') {
      return this.#blockBeforeStart(
        snapshot,
        jobName,
        nowMs,
        terminal === 'failed'
          ? 'package_secret_action_job_failed_before_start'
          : 'package_secret_action_job_completed_before_start',
      );
    }
    if (
      execution.startedAtMs === null ||
      execution.leaseOwner === null ||
      execution.leaseToken === null
    ) {
      throw new PluginPackageKubernetesSecretActionControllerConflictError();
    }
    const durableResultDigest = await this.#durableResultDigest(
      plan,
      execution.startedAtMs,
    );
    const outcome = durableResultDigest
      ? 'succeeded'
      : terminal === 'failed'
        ? 'failed'
        : 'indeterminate';
    return this.#completeExecuting(
      snapshot,
      jobName,
      nowMs,
      outcome,
      durableResultDigest
        ? snapshot.dispatch.action.actionType ===
          PLUGIN_PACKAGE_SECRET_BINDING_ACTION_TYPE
          ? 'package_secret_binding_job_recovered'
          : 'package_secret_transition_job_recovered'
        : terminal === 'failed'
          ? 'package_secret_action_job_failed'
          : 'package_secret_action_receipt_missing',
      durableResultDigest,
    );
  }

  async #recoverMissingExecuting(
    snapshot: Readonly<ApprovedActionExecutionSnapshot>,
    plan: Readonly<SecretActionApprovalPlan>,
    jobName: string,
    nowMs: number,
  ): Promise<'recoveredSucceeded' | 'recoveryRequired'> {
    const execution = snapshot.execution;
    if (
      execution.status !== 'executing' ||
      execution.startedAtMs === null ||
      execution.leaseOwner === null ||
      execution.leaseToken === null
    ) {
      throw new PluginPackageKubernetesSecretActionControllerConflictError();
    }
    const durableResultDigest = await this.#durableResultDigest(
      plan,
      execution.startedAtMs,
    );
    if (!durableResultDigest) return 'recoveryRequired';
    const recovered = await this.#completeExecuting(
      snapshot,
      jobName,
      nowMs,
      'succeeded',
      snapshot.dispatch.action.actionType ===
        PLUGIN_PACKAGE_SECRET_BINDING_ACTION_TYPE
        ? 'package_secret_binding_job_recovered'
        : 'package_secret_transition_job_recovered',
      durableResultDigest,
    );
    if (recovered !== 'recoveredSucceeded') {
      throw new PluginPackageKubernetesSecretActionControllerConflictError();
    }
    return recovered;
  }

  async #completeExecuting(
    snapshot: Readonly<ApprovedActionExecutionSnapshot>,
    jobName: string,
    nowMs: number,
    outcome: 'succeeded' | 'failed' | 'indeterminate',
    resultCode: string,
    resultDigest: string | null,
  ): Promise<'recoveredSucceeded' | 'recoveredFailed' | 'recoveredBlocked'> {
    const execution = snapshot.execution;
    if (
      execution.status !== 'executing' ||
      execution.leaseOwner === null ||
      execution.leaseToken === null ||
      (outcome === 'succeeded') !== (resultDigest !== null)
    ) {
      throw new PluginPackageKubernetesSecretActionControllerConflictError();
    }
    const result = await this.options.executions.completeExecution({
      dispatchId: execution.dispatchId,
      owner: execution.leaseOwner,
      leaseToken: execution.leaseToken,
      expectedVersion: execution.version,
      resultMutationId: `k8s-recovery-${jobName}`,
      outcome,
      resultCode,
      ...(resultDigest ? { resultDigest } : {}),
      completedAtMs: Math.max(nowMs, execution.updatedAtMs),
    });
    if (result.execution.status === 'succeeded') return 'recoveredSucceeded';
    if (result.execution.status === 'failed') return 'recoveredFailed';
    if (result.execution.status === 'blocked') return 'recoveredBlocked';
    throw new PluginPackageKubernetesSecretActionControllerConflictError();
  }

  async #blockBeforeStart(
    snapshot: Readonly<ApprovedActionExecutionSnapshot>,
    jobName: string,
    nowMs: number,
    resultCode: string,
  ): Promise<'recoveredBlocked' | 'recoveryRequired'> {
    const claimed = await this.options.executions.claimExecution({
      dispatchId: snapshot.execution.dispatchId,
      owner: RECOVERY_OWNER,
      leaseToken: `recovery-${jobName}`,
      nowMs,
      leaseDurationMs: RECOVERY_LEASE_DURATION_MS,
    });
    if (claimed.status !== 'claimed') {
      return claimed.status === 'blocked' ? 'recoveredBlocked' : 'recoveryRequired';
    }
    const released = await this.options.executions.releaseExecutionBeforeStart({
      dispatchId: claimed.snapshot.execution.dispatchId,
      owner: RECOVERY_OWNER,
      leaseToken: claimed.snapshot.execution.leaseToken!,
      expectedVersion: claimed.snapshot.execution.version,
      resultMutationId: `k8s-recovery-${jobName}`,
      resultCode,
      atMs: Math.max(nowMs, claimed.snapshot.execution.updatedAtMs),
    });
    if (released.execution.status !== 'blocked') {
      throw new PluginPackageKubernetesSecretActionControllerConflictError();
    }
    return 'recoveredBlocked';
  }

  async #durableResultDigest(
    plan: Readonly<SecretActionApprovalPlan>,
    startedAtMs: number,
  ): Promise<string | null> {
    if ('bindingPlan' in plan) {
      const normalized = normalizePluginPackageSecretBindingApprovalPlan(plan);
      const expected = createPluginPackageSecretBindingFromApprovalPlan(
        normalized,
        startedAtMs,
      );
      const stored = await this.options.bindings.find(
        normalized.bindingPlan.target.generationDigest,
      );
      if (!stored) return null;
      if (JSON.stringify(stored) !== JSON.stringify(expected)) {
        throw new PluginPackageKubernetesSecretActionControllerConflictError();
      }
      return stored.bindingDigest;
    }
    const normalized =
      normalizePluginPackageSecretBindingTransitionApprovalPlan(plan);
    const binding = createPluginPackageSecretBindingFromTransitionPlan(
      normalized.transitionPlan,
      'approved-action-execution',
      normalized.approvalPlanDigest,
      startedAtMs,
    );
    const expected = createPluginPackageSecretBindingTransitionReceipt({
      transitionPlan: normalized.transitionPlan,
      authority: Object.freeze({
        kind: 'approved-action-execution',
        evidenceDigest: normalized.approvalPlanDigest,
      }),
      binding,
      committedAtMs: startedAtMs,
    });
    const stored = await this.options.transitionReceipts.find(
      normalized.transitionPlan.nextTarget.generationDigest,
    );
    if (!stored) return null;
    if (JSON.stringify(stored) !== JSON.stringify(expected)) {
      throw new PluginPackageKubernetesSecretActionControllerConflictError();
    }
    return stored.receiptDigest;
  }

  #plan(
    snapshot: Readonly<ApprovedActionExecutionSnapshot>,
  ): Promise<Readonly<SecretActionApprovalPlan> | null> {
    const { actionType, actionRef } = snapshot.dispatch.action;
    if (actionType === PLUGIN_PACKAGE_SECRET_BINDING_ACTION_TYPE) {
      return this.options.bindingPlans.findByActionRef(actionRef);
    }
    if (actionType === PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_ACTION_TYPE) {
      return this.options.transitionPlans.findByActionRef(actionRef);
    }
    return Promise.resolve(null);
  }
}


type KubernetesModule = typeof import('@kubernetes/client-node', {
  with: { 'resolution-mode': 'import' }
});

export async function createClusterPluginPackageKubernetesSecretActionController(
  options: Omit<
    PluginPackageKubernetesSecretActionControllerOptions,
    'jobs'
  >,
): Promise<Readonly<ClusterPluginPackageKubernetesSecretActionControllerResource>> {
  const kubernetes = (await import('@kubernetes/client-node')) as KubernetesModule;
  const config = new kubernetes.KubeConfig();
  config.loadFromCluster();
  const jobs = config.makeApiClient(
    kubernetes.BatchV1Api,
  ) as unknown as PluginPackageKubernetesSecretActionJobApi;
  let active = true;
  return Object.freeze({
    controller: new PluginPackageKubernetesSecretActionController({
      ...options,
      jobs,
    }),
    dispose() {
      if (!active) return;
      active = false;
      for (const user of config.getUsers()) {
        const mutable = user as {
          token?: string;
          certData?: string;
          keyData?: string;
        };
        mutable.token = '';
        mutable.certData = '';
        mutable.keyData = '';
      }
      config.setCurrentContext('disposed');
    },
  });
}

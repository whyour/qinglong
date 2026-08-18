import { randomUUID } from 'node:crypto';
import {
  activateClusterControlRuntime,
  ClusterRunLostRetryCoordinator,
  ClusterRunCancellationConvergenceCoordinator,
  ClusterControlRecoveryEvidenceRegistry,
  ClusterControlRecoveryConvergenceVerifier,
  ClusterControlRecoverySupervisor,
  ClusterControlStartupRecoveryCoordinator,
  EvidenceBasedClusterControlRecoveryProcessor,
  MAX_CLUSTER_CONTROL_RECOVERY_CLAIMS_PER_PASS,
  MAX_CLUSTER_CONTROL_RECOVERY_CLAIM_LEASE_MS,
  MAX_CLUSTER_CONTROL_RECOVERY_EVIDENCE_TIMEOUT_MS,
  MAX_CLUSTER_CONTROL_RECOVERY_RETRY_DELAY_MS,
  MAX_CLUSTER_CONTROL_STARTUP_RECOVERY_PASSES,
  MAX_CLUSTER_RUN_CANCELLATION_CONVERGENCE_PAGE_SIZE,
  MAX_CLUSTER_RUN_CANCELLATION_CONVERGENCE_PAGES_PER_CYCLE,
  type ClusterControlActivationAudit,
  type ClusterControlActivationStack,
  type ClusterControlReadinessEvidence,
  type ClusterControlRecoveryExecutorEvidenceProvider,
  type ClusterControlRuntimeActivationResult,
  type ClusterControlStopResult,
  type DeploymentProfile,
  type OpenPostgresDatabase,
  type PostgresDatabaseResource,
  type PostgresPool,
  type ProjectPolicyRepository,
  type RunRepository,
  type ClusterRunCancellationConvergenceCycleResult,
} from '@qinglong/runtime-core';
import type { ClusterRunCancellationRepository } from '@qinglong/runtime-core/cluster-run-cancellation';
import {
  MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_CLAIMS,
  MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
  MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_RETRY_DELAY_MS,
  MIN_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
} from '@qinglong/runtime-core/cluster-run-attempt-log-retention';
import {
  MAX_RUN_ATTEMPT_LOG_RETENTION_MS,
  MIN_RUN_ATTEMPT_LOG_RETENTION_MS,
  type RunAttemptLogRetentionStateReader,
} from '@qinglong/runtime-core/run-attempt-log-retention';
import type { ProjectRunListReader } from '@qinglong/runtime-core/project-run-list';
import type { ClusterScheduleStore } from '@qinglong/runtime-core/cluster-scheduler';
import type { TaskDefinitionSource } from '@qinglong/runtime-core/task-definition';
import type { TriggerSource } from '@qinglong/runtime-core/trigger';
import type { ClusterTaskExecutionRevisionSource } from '@qinglong/runtime-core/cluster-execution-revision';
import type {
  ProjectToolDefinitionSnapshotRepository,
  ProjectToolDefinitionSnapshotSourceRepository,
} from '@qinglong/runtime-core/project-tool-definition-snapshot';
import type { StepRunRepository } from '@qinglong/runtime-core/step-run';
import type { ToolExecutionCompletionRepository } from '@qinglong/runtime-core/tool-execution-completion';
import type { ToolExecutionFailureCompletionRepository } from '@qinglong/runtime-core/tool-execution-failure-completion';
import type { ToolExecutionStartBarrierRepository } from '@qinglong/runtime-core/tool-execution-start-barrier';
import type { ToolInvocationArtifactRepository } from '@qinglong/runtime-core/tool-invocation-artifact';
import type { ToolResultKeyCatalogReader } from '@qinglong/runtime-core/tool-result-key-catalog';
import type { ToolExecutionResultRekeyReader } from '@qinglong/runtime-core/tool-result-rekey';
import {
  assertPostgresSchemaReady,
  PostgresClusterControlRecoverySource,
  PostgresClusterControlRecoveryClaimRepository,
  PostgresClusterControlRecoveryResolutionRepository,
  PostgresClusterRuntimeRecoverySource,
  PostgresClusterRunLostRetryRepository,
  PostgresClusterRunCancellationRepository,
  PostgresClusterRunCancellationConvergenceRepository,
  PostgresProjectPolicyRepository,
  PostgresApiCredentialRepository,
  PostgresSecurityAuditRepository,
  PostgresRunRepository,
  PostgresWorkerExecutionAttestationRepository,
  PostgresRunAttemptLogRetentionClaimRepository,
  PostgresTaskDefinitionSource,
  PostgresTaskExecutionRevisionSource,
  PostgresTriggerSource,
  PostgresClusterScheduleRepository,
  PostgresRemoteWorkerAttestationEvidenceProvider,
  PostgresProjectToolDefinitionSnapshotRepository,
  PostgresStepRunRepository,
  PostgresToolExecutionCompletionRepository,
  PostgresToolExecutionFailureCompletionRepository,
  PostgresToolExecutionStartBarrierRepository,
  PostgresToolInvocationArtifactRepository,
  PostgresToolResultKeyCatalogReader,
  PostgresToolResultRekeyReader,
  type PostgresSchemaReadinessReport,
} from '@qinglong/cluster-postgres/runtime';
import { PostgresPluginPackageWorkflowFrontierRepository } from '@qinglong/cluster-postgres/plugin-package-workflow-frontier';
import { PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository } from '@qinglong/cluster-postgres/plugin-package-workflow-task-attempt-admission';
import { PostgresTaskStartRepository } from '@qinglong/cluster-postgres/task-start';
import { PostgresPluginPackageAutomationPublicationRepository } from '@qinglong/cluster-postgres/plugin-package-automation-publication';
import { PostgresPluginPackageMaterializedRevisionRepository } from '@qinglong/cluster-postgres/plugin-package-materialized-revision';
import {
  PostgresAuthorizedPluginPackageWorkflowAdmissionRepository,
  PostgresAuthorizedPluginPackageWorkflowRunEventListRepository,
  PostgresAuthorizedPluginPackageWorkflowRunInspectionRepository,
  PostgresAuthorizedPluginPackageWorkflowRunListRepository,
  PostgresAuthorizedPluginPackageWorkflowStepRunListRepository,
} from '@qinglong/cluster-postgres/plugin-package-workflow-administration';
import {
  assertClusterControlApiCredentialPepper,
  createClusterControlApiCredentialAuthenticator,
} from '../authentication/apiCredentialAuthenticator';
import type {
  ClusterControlRequestAuthenticator,
  ClusterControlSecurityAuditSink,
} from '../transport/admissionPipeline';
import {
  MAX_CLUSTER_SCHEDULE_CLAIMS_PER_CYCLE,
  ClusterSchedulerCoordinator,
  ClusterSchedulerLifecycle,
  type ClusterSchedulerCycleSummary,
} from '../scheduling/scheduler';
import { ClusterWorkflowSchedulerCoordinator } from '../scheduling/workflowScheduler';
import { ClusterRuntimeSchedulerCoordinator } from '../scheduling/runtimeScheduler';
import { ClusterRunCancellationConvergenceLifecycle } from '../run/runCancellationLifecycle';
import {
  ClusterRunAttemptLogRetentionCoordinator,
  ClusterRunAttemptLogRetentionLifecycle,
  type ClusterRunAttemptLogRetirementStore,
  type ClusterRunAttemptLogRetentionCycleSummary,
} from '../run/runAttemptLogRetentionLifecycle';
import type { TaskStartRepository } from '@qinglong/runtime-core/task-start';
import {
  createClusterWorkerRuntimePort,
  type ClusterWorkerRuntimeDependencies,
  type ClusterWorkerRuntimePort,
} from '../remote-execution/workerRuntimePort';
import {
  createClusterPluginPackageWorkflowAdministrationCapability,
  type ClusterPluginPackageWorkflowAdministrationCapability,
} from '../plugin-package/workflow/pluginPackageWorkflowAdministration';

export interface ClusterTrustedToolStorage {
  readonly invocationArtifacts: ToolInvocationArtifactRepository;
  readonly stepRuns: StepRunRepository;
  readonly startBarriers: ToolExecutionStartBarrierRepository;
  readonly completions: ToolExecutionCompletionRepository;
  readonly failureCompletions: ToolExecutionFailureCompletionRepository;
  readonly resultKeyCatalog: ToolResultKeyCatalogReader;
  readonly resultRekeys: ToolExecutionResultRekeyReader;
  readonly toolDefinitionSnapshots: ProjectToolDefinitionSnapshotRepository &
    ProjectToolDefinitionSnapshotSourceRepository;
}

export interface ClusterControlAssemblyInput {
  readonly evidence: ClusterControlReadinessEvidence;
  readonly policies: ProjectPolicyRepository;
  readonly runs: RunRepository & ProjectRunListReader;
  readonly runAttemptLogRetention: RunAttemptLogRetentionStateReader;
  readonly runCancellation: ClusterRunCancellationRepository;
  readonly taskStart: TaskStartRepository;
  readonly taskDefinitions: TaskDefinitionSource;
  readonly taskExecutionRevisions: ClusterTaskExecutionRevisionSource;
  readonly triggers: TriggerSource;
  readonly schedules: ClusterScheduleStore;
  readonly trustedToolStorage: ClusterTrustedToolStorage;
  readonly authenticator: ClusterControlRequestAuthenticator;
  readonly securityAudit: ClusterControlSecurityAuditSink;
  readonly workflowAdministration: ClusterPluginPackageWorkflowAdministrationCapability;
  readonly workerRuntime?: ClusterWorkerRuntimePort;
}

export interface ClusterControlRecoveryRuntimeOptions {
  readonly ownerId: string;
  readonly providers?: readonly ClusterControlRecoveryExecutorEvidenceProvider[];
  readonly claimLimit?: number;
  readonly claimLeaseMs?: number;
  readonly retryDelayMs?: number;
  readonly providerTimeoutMs?: number;
  readonly maxStartupPasses?: number;
}

export interface ClusterSchedulerRuntimeOptions {
  readonly ownerId?: string;
  readonly claimLeaseMs?: number;
  readonly maxClaimsPerCycle?: number;
  readonly misfireGraceMs?: number;
  readonly intervalMs?: number;
  readonly stopTimeoutMs?: number;
  readonly onDiagnostic?: (
    error: unknown,
    summary?: ClusterSchedulerCycleSummary,
  ) => void | Promise<void>;
}

export interface ClusterRunCancellationConvergenceRuntimeOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly intervalMs?: number;
  readonly stopTimeoutMs?: number;
  readonly onDiagnostic?: (
    error: unknown,
    summary?: Readonly<ClusterRunCancellationConvergenceCycleResult>,
  ) => void | Promise<void>;
}

export interface ClusterRunAttemptLogRetentionRuntimeOptions {
  readonly store: ClusterRunAttemptLogRetirementStore;
  readonly ownerId?: string;
  readonly retentionMs?: number;
  readonly claimLimit?: number;
  readonly leaseMs?: number;
  readonly maximumCycleMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaximumMs?: number;
  readonly maximumFailures?: number;
  readonly intervalMs?: number;
  readonly stopTimeoutMs?: number;
  readonly onDiagnostic?: (
    error: unknown,
    summary?: Readonly<ClusterRunAttemptLogRetentionCycleSummary>,
  ) => void | Promise<void>;
}

export interface ClusterControlBootstrapOptions {
  readonly enabled?: boolean;
  readonly profile: DeploymentProfile;
  readonly apiCredentialPepper?: string;
  readonly recovery?: ClusterControlRecoveryRuntimeOptions;
  readonly scheduler?: ClusterSchedulerRuntimeOptions;
  readonly cancellationConvergence?: ClusterRunCancellationConvergenceRuntimeOptions;
  readonly logRetention?: ClusterRunAttemptLogRetentionRuntimeOptions;
  readonly workerRuntime?: ClusterWorkerRuntimeDependencies;
  readonly openDatabase: OpenPostgresDatabase;
  readonly create: (
    input: ClusterControlAssemblyInput,
  ) => ClusterControlActivationStack;
  readonly audit: (
    record: ClusterControlActivationAudit,
  ) => void | Promise<void>;
}

interface PreparedRecoveryRuntime {
  readonly providers: readonly ClusterControlRecoveryExecutorEvidenceProvider[];
  readonly providerTimeoutMs: number;
  readonly ownerId: string;
  readonly claimLimit: number;
  readonly claimLeaseMs: number;
  readonly retryDelayMs: number;
  readonly maxStartupPasses: number;
}

interface PreparedSchedulerRuntime {
  readonly ownerId: string;
  readonly claimLeaseMs: number;
  readonly maxClaimsPerCycle: number;
  readonly misfireGraceMs: number;
  readonly intervalMs: number;
  readonly stopTimeoutMs: number;
  readonly onDiagnostic?: ClusterSchedulerRuntimeOptions['onDiagnostic'];
}

interface PreparedCancellationConvergenceRuntime {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly intervalMs: number;
  readonly stopTimeoutMs: number;
  readonly onDiagnostic?: ClusterRunCancellationConvergenceRuntimeOptions['onDiagnostic'];
}

interface PreparedLogRetentionRuntime {
  readonly store: ClusterRunAttemptLogRetirementStore;
  readonly ownerId: string;
  readonly retentionMs: number;
  readonly claimLimit: number;
  readonly leaseMs: number;
  readonly maximumCycleMs: number;
  readonly retryBaseMs: number;
  readonly retryMaximumMs: number;
  readonly maximumFailures: number;
  readonly intervalMs: number;
  readonly stopTimeoutMs: number;
  readonly onDiagnostic?: ClusterRunAttemptLogRetentionRuntimeOptions['onDiagnostic'];
}

function boundedInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = value ?? fallback;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function prepareRecoveryRuntime(
  options: ClusterControlRecoveryRuntimeOptions | undefined,
): PreparedRecoveryRuntime {
  if (!options) {
    throw new TypeError(
      'Enabled cluster-control requires bounded recovery configuration',
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.ownerId)) {
    throw new TypeError('Cluster-control recovery ownerId is invalid');
  }
  const claimLeaseMs = boundedInteger(
    'Cluster-control recovery claim lease',
    options.claimLeaseMs,
    30_000,
    1_000,
    MAX_CLUSTER_CONTROL_RECOVERY_CLAIM_LEASE_MS,
  );
  const providerTimeoutMs = boundedInteger(
    'Cluster-control recovery evidence timeout',
    options.providerTimeoutMs,
    5_000,
    1,
    MAX_CLUSTER_CONTROL_RECOVERY_EVIDENCE_TIMEOUT_MS,
  );
  if (providerTimeoutMs + 250 > claimLeaseMs) {
    throw new RangeError(
      'Cluster-control recovery evidence timeout must leave at least 250ms for fenced settlement',
    );
  }
  return Object.freeze({
    providers: Object.freeze([...(options.providers ?? [])]),
    providerTimeoutMs,
    ownerId: options.ownerId,
    claimLimit: boundedInteger(
      'Cluster-control recovery claim limit',
      options.claimLimit,
      16,
      1,
      MAX_CLUSTER_CONTROL_RECOVERY_CLAIMS_PER_PASS,
    ),
    claimLeaseMs,
    retryDelayMs: boundedInteger(
      'Cluster-control recovery retry delay',
      options.retryDelayMs,
      5_000,
      0,
      MAX_CLUSTER_CONTROL_RECOVERY_RETRY_DELAY_MS,
    ),
    maxStartupPasses: boundedInteger(
      'Cluster-control startup recovery passes',
      options.maxStartupPasses,
      8,
      1,
      MAX_CLUSTER_CONTROL_STARTUP_RECOVERY_PASSES,
    ),
  });
}

function prepareSchedulerRuntime(
  options: ClusterSchedulerRuntimeOptions | undefined,
  fallbackOwnerId: string,
): PreparedSchedulerRuntime {
  const allowedKeys = new Set([
    'claimLeaseMs',
    'intervalMs',
    'maxClaimsPerCycle',
    'misfireGraceMs',
    'onDiagnostic',
    'ownerId',
    'stopTimeoutMs',
  ]);
  if (
    options !== undefined &&
    (!options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => !allowedKeys.has(key)))
  ) {
    throw new TypeError('Cluster scheduler configuration is invalid');
  }
  const ownerId = options?.ownerId ?? fallbackOwnerId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerId)) {
    throw new TypeError('Cluster scheduler ownerId is invalid');
  }
  if (
    options?.onDiagnostic !== undefined &&
    typeof options.onDiagnostic !== 'function'
  ) {
    throw new TypeError('Cluster scheduler diagnostic sink is invalid');
  }
  return Object.freeze({
    ownerId,
    claimLeaseMs: boundedInteger(
      'Cluster scheduler claim lease',
      options?.claimLeaseMs,
      30_000,
      1_000,
      60_000,
    ),
    maxClaimsPerCycle: boundedInteger(
      'Cluster scheduler claim budget',
      options?.maxClaimsPerCycle,
      16,
      1,
      MAX_CLUSTER_SCHEDULE_CLAIMS_PER_CYCLE,
    ),
    misfireGraceMs: boundedInteger(
      'Cluster scheduler misfire grace',
      options?.misfireGraceMs,
      30_000,
      0,
      5 * 60_000,
    ),
    intervalMs: boundedInteger(
      'Cluster scheduler interval',
      options?.intervalMs,
      1_000,
      250,
      60 * 60_000,
    ),
    stopTimeoutMs: boundedInteger(
      'Cluster scheduler stop timeout',
      options?.stopTimeoutMs,
      10_000,
      100,
      30_000,
    ),
    ...(options?.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: options.onDiagnostic }),
  });
}

function prepareCancellationConvergenceRuntime(
  options: ClusterRunCancellationConvergenceRuntimeOptions | undefined,
): PreparedCancellationConvergenceRuntime {
  const allowedKeys = new Set([
    'intervalMs',
    'maxPages',
    'onDiagnostic',
    'pageSize',
    'stopTimeoutMs',
  ]);
  if (
    options !== undefined &&
    (!options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => !allowedKeys.has(key)))
  ) {
    throw new TypeError(
      'Cluster Run cancellation convergence configuration is invalid',
    );
  }
  if (
    options?.onDiagnostic !== undefined &&
    typeof options.onDiagnostic !== 'function'
  ) {
    throw new TypeError(
      'Cluster Run cancellation convergence diagnostic sink is invalid',
    );
  }
  return Object.freeze({
    pageSize: boundedInteger(
      'Cluster Run cancellation convergence page size',
      options?.pageSize,
      32,
      1,
      MAX_CLUSTER_RUN_CANCELLATION_CONVERGENCE_PAGE_SIZE,
    ),
    maxPages: boundedInteger(
      'Cluster Run cancellation convergence page limit',
      options?.maxPages,
      4,
      1,
      MAX_CLUSTER_RUN_CANCELLATION_CONVERGENCE_PAGES_PER_CYCLE,
    ),
    intervalMs: boundedInteger(
      'Cluster Run cancellation convergence interval',
      options?.intervalMs,
      1_000,
      250,
      60 * 60_000,
    ),
    stopTimeoutMs: boundedInteger(
      'Cluster Run cancellation convergence stop timeout',
      options?.stopTimeoutMs,
      10_000,
      100,
      30_000,
    ),
    ...(options?.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: options.onDiagnostic }),
  });
}

function prepareLogRetentionRuntime(
  options: ClusterRunAttemptLogRetentionRuntimeOptions | undefined,
  fallbackOwnerId: string,
): PreparedLogRetentionRuntime | undefined {
  if (options === undefined) return undefined;
  const allowedKeys = new Set([
    'claimLimit',
    'intervalMs',
    'leaseMs',
    'maximumCycleMs',
    'maximumFailures',
    'onDiagnostic',
    'ownerId',
    'retentionMs',
    'retryBaseMs',
    'retryMaximumMs',
    'stopTimeoutMs',
    'store',
  ]);
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !allowedKeys.has(key)) ||
    typeof options.store?.retire !== 'function' ||
    (options.onDiagnostic !== undefined &&
      typeof options.onDiagnostic !== 'function')
  ) {
    throw new TypeError(
      'Cluster Run Attempt log retention configuration is invalid',
    );
  }
  const ownerId = options.ownerId ?? fallbackOwnerId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerId)) {
    throw new TypeError('Cluster Run Attempt log retention ownerId is invalid');
  }
  const leaseMs = boundedInteger(
    'Cluster Run Attempt log retention lease',
    options.leaseMs,
    30_000,
    MIN_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
    MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
  );
  const retryBaseMs = boundedInteger(
    'Cluster Run Attempt log retention retry base',
    options.retryBaseMs,
    5_000,
    0,
    MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_RETRY_DELAY_MS,
  );
  return Object.freeze({
    store: options.store,
    ownerId,
    retentionMs: boundedInteger(
      'Cluster Run Attempt log retention duration',
      options.retentionMs,
      30 * 24 * 60 * 60_000,
      MIN_RUN_ATTEMPT_LOG_RETENTION_MS,
      MAX_RUN_ATTEMPT_LOG_RETENTION_MS,
    ),
    claimLimit: boundedInteger(
      'Cluster Run Attempt log retention claim limit',
      options.claimLimit,
      4,
      1,
      MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_CLAIMS,
    ),
    leaseMs,
    maximumCycleMs: boundedInteger(
      'Cluster Run Attempt log retention cycle budget',
      options.maximumCycleMs,
      10_000,
      100,
      leaseMs - 500,
    ),
    retryBaseMs,
    retryMaximumMs: boundedInteger(
      'Cluster Run Attempt log retention retry maximum',
      options.retryMaximumMs,
      60 * 60_000,
      retryBaseMs,
      MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_RETRY_DELAY_MS,
    ),
    maximumFailures: boundedInteger(
      'Cluster Run Attempt log retention failure limit',
      options.maximumFailures,
      8,
      1,
      32,
    ),
    intervalMs: boundedInteger(
      'Cluster Run Attempt log retention interval',
      options.intervalMs,
      60_000,
      1_000,
      24 * 60 * 60_000,
    ),
    stopTimeoutMs: boundedInteger(
      'Cluster Run Attempt log retention stop timeout',
      options.stopTimeoutMs,
      10_000,
      100,
      30_000,
    ),
    ...(options.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: options.onDiagnostic }),
  });
}

function readinessEvidence(
  report: PostgresSchemaReadinessReport,
): ClusterControlReadinessEvidence {
  return Object.freeze({
    contractName: report.contractName,
    contractVersion: report.contractVersion,
    serverMajor: report.serverMajor,
    migrationIds: Object.freeze([...report.migrationIds]),
  });
}

/**
 * Owns the cluster database around the readiness-first activation gate.
 * Repository and service construction happens through create() only after the
 * runtime role, migration history and catalog contract are proven ready.
 */
export async function bootstrapClusterControlRuntime(
  options: ClusterControlBootstrapOptions,
): Promise<ClusterControlRuntimeActivationResult> {
  let recoveryRuntime: PreparedRecoveryRuntime | undefined;
  let schedulerRuntime: PreparedSchedulerRuntime | undefined;
  let cancellationConvergenceRuntime:
    | PreparedCancellationConvergenceRuntime
    | undefined;
  let logRetentionRuntime: PreparedLogRetentionRuntime | undefined;
  let recoveryRegistry: ClusterControlRecoveryEvidenceRegistry | undefined;
  if ((options.enabled ?? false) && options.profile === 'cluster-control') {
    assertClusterControlApiCredentialPepper(options.apiCredentialPepper ?? '');
    recoveryRuntime = prepareRecoveryRuntime(options.recovery);
    schedulerRuntime = prepareSchedulerRuntime(
      options.scheduler,
      recoveryRuntime.ownerId,
    );
    cancellationConvergenceRuntime = prepareCancellationConvergenceRuntime(
      options.cancellationConvergence,
    );
    logRetentionRuntime = prepareLogRetentionRuntime(
      options.logRetention,
      recoveryRuntime.ownerId,
    );
  }
  let database: PostgresDatabaseResource | undefined;
  let closePromise: Promise<void> | undefined;
  const closeDatabase = (): Promise<void> => {
    if (!database) return Promise.resolve();
    closePromise ??= Promise.resolve().then(() => database!.close());
    return closePromise;
  };

  try {
    const activation = await activateClusterControlRuntime({
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
      profile: options.profile,
      readiness: {
        async assertReady() {
          if (database) {
            throw new Error(
              'Cluster-control database was opened more than once',
            );
          }
          database = await options.openDatabase();
          return readinessEvidence(
            await assertPostgresSchemaReady(database.pool),
          );
        },
      },
      create(evidence) {
        if (!database) {
          throw new Error(
            'Cluster-control database is unavailable after readiness',
          );
        }
        const recovery = new PostgresClusterControlRecoverySource(
          database.pool,
        );
        const recoveryClaims =
          new PostgresClusterControlRecoveryClaimRepository(database.pool);
        const recoveryTransitions =
          new PostgresClusterControlRecoveryResolutionRepository(database.pool);
        if (!recoveryRuntime) {
          throw new Error(
            'Cluster-control recovery runtime is unavailable after readiness',
          );
        }
        if (!schedulerRuntime) {
          throw new Error(
            'Cluster scheduler runtime is unavailable after readiness',
          );
        }
        if (!cancellationConvergenceRuntime) {
          throw new Error(
            'Cluster Run cancellation convergence runtime is unavailable after readiness',
          );
        }
        const remoteAttestations =
          new PostgresWorkerExecutionAttestationRepository(database.pool);
        recoveryRegistry = new ClusterControlRecoveryEvidenceRegistry(
          [
            ...recoveryRuntime.providers,
            new PostgresRemoteWorkerAttestationEvidenceProvider(
              database.pool,
              remoteAttestations,
            ),
          ],
          { timeoutMs: recoveryRuntime.providerTimeoutMs },
        );
        const recoveryProcessor =
          new EvidenceBasedClusterControlRecoveryProcessor(
            recoveryTransitions,
            recoveryRegistry,
            { retryDelayMs: recoveryRuntime.retryDelayMs },
          );
        const recoverySupervisor = new ClusterControlRecoverySupervisor(
          recoveryClaims,
          recoveryProcessor,
          {
            ownerId: recoveryRuntime.ownerId,
            limit: recoveryRuntime.claimLimit,
            leaseMs: recoveryRuntime.claimLeaseMs,
            retryDelayMs: recoveryRuntime.retryDelayMs,
          },
        );
        const recoveryCoordinator =
          new ClusterControlStartupRecoveryCoordinator(recoverySupervisor, {
            maxPasses: recoveryRuntime.maxStartupPasses,
          });
        const runtimeRecoverySupervisor = new ClusterControlRecoverySupervisor(
          new PostgresClusterControlRecoveryClaimRepository(
            database.pool,
            randomUUID,
            (queryable) => new PostgresClusterRuntimeRecoverySource(queryable),
          ),
          recoveryProcessor,
          {
            ownerId: recoveryRuntime.ownerId,
            limit: recoveryRuntime.claimLimit,
            leaseMs: recoveryRuntime.claimLeaseMs,
            retryDelayMs: recoveryRuntime.retryDelayMs,
          },
        );
        const schedules = new PostgresClusterScheduleRepository(database.pool);
        const runs = new PostgresRunRepository(database.pool);
        const runAttemptLogRetention =
          new PostgresRunAttemptLogRetentionClaimRepository(database.pool);
        const trustedToolStorage: ClusterTrustedToolStorage = Object.freeze({
          invocationArtifacts: new PostgresToolInvocationArtifactRepository(
            database.pool,
          ),
          stepRuns: new PostgresStepRunRepository(database.pool),
          startBarriers: new PostgresToolExecutionStartBarrierRepository(
            database.pool,
          ),
          completions: new PostgresToolExecutionCompletionRepository(
            database.pool,
          ),
          failureCompletions:
            new PostgresToolExecutionFailureCompletionRepository(database.pool),
          resultKeyCatalog: new PostgresToolResultKeyCatalogReader(
            database.pool,
          ),
          resultRekeys: new PostgresToolResultRekeyReader(database.pool),
          toolDefinitionSnapshots:
            new PostgresProjectToolDefinitionSnapshotRepository(database.pool),
        });
        const workflowScheduler = new ClusterWorkflowSchedulerCoordinator(
          new ClusterSchedulerCoordinator(schedules, {
            ownerId: schedulerRuntime.ownerId,
            claimLeaseMs: schedulerRuntime.claimLeaseMs,
            maxClaimsPerCycle: schedulerRuntime.maxClaimsPerCycle,
            misfireGraceMs: schedulerRuntime.misfireGraceMs,
          }),
          new PostgresPluginPackageWorkflowFrontierRepository(database.pool),
          new PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository(
            database.pool,
          ),
          {
            frontierPageSize: 32,
            frontierMaxPages: 4,
            taskAttemptPageSize: 32,
            taskAttemptMaxPages: 4,
          },
        );
        const runtimeScheduler = new ClusterRuntimeSchedulerCoordinator(
          runtimeRecoverySupervisor,
          new ClusterRunLostRetryCoordinator(
            new PostgresClusterRunLostRetryRepository(database.pool),
            { pageSize: 16 },
          ),
          workflowScheduler,
        );
        const schedulerLifecycle = new ClusterSchedulerLifecycle(
          runtimeScheduler,
          {
            intervalMs: schedulerRuntime.intervalMs,
            stopTimeoutMs: schedulerRuntime.stopTimeoutMs,
            ...(schedulerRuntime.onDiagnostic === undefined
              ? {}
              : { onDiagnostic: schedulerRuntime.onDiagnostic }),
          },
        );
        const cancellationConvergenceLifecycle =
          new ClusterRunCancellationConvergenceLifecycle(
            new ClusterRunCancellationConvergenceCoordinator(
              new PostgresClusterRunCancellationConvergenceRepository(
                database.pool,
              ),
              {
                pageSize: cancellationConvergenceRuntime.pageSize,
                maxPages: cancellationConvergenceRuntime.maxPages,
              },
            ),
            {
              intervalMs: cancellationConvergenceRuntime.intervalMs,
              stopTimeoutMs: cancellationConvergenceRuntime.stopTimeoutMs,
              ...(cancellationConvergenceRuntime.onDiagnostic === undefined
                ? {}
                : {
                    onDiagnostic: cancellationConvergenceRuntime.onDiagnostic,
                  }),
            },
          );
        const logRetentionLifecycle =
          logRetentionRuntime === undefined
            ? undefined
            : new ClusterRunAttemptLogRetentionLifecycle(
                new ClusterRunAttemptLogRetentionCoordinator(
                  runAttemptLogRetention,
                  logRetentionRuntime.store,
                  {
                    ownerId: logRetentionRuntime.ownerId,
                    retentionMs: logRetentionRuntime.retentionMs,
                    claimLimit: logRetentionRuntime.claimLimit,
                    leaseMs: logRetentionRuntime.leaseMs,
                    maximumCycleMs: logRetentionRuntime.maximumCycleMs,
                    retryBaseMs: logRetentionRuntime.retryBaseMs,
                    retryMaximumMs: logRetentionRuntime.retryMaximumMs,
                    maximumFailures: logRetentionRuntime.maximumFailures,
                  },
                ),
                {
                  intervalMs: logRetentionRuntime.intervalMs,
                  stopTimeoutMs: logRetentionRuntime.stopTimeoutMs,
                  ...(logRetentionRuntime.onDiagnostic === undefined
                    ? {}
                    : { onDiagnostic: logRetentionRuntime.onDiagnostic }),
                },
              );
        const runCancellation = new PostgresClusterRunCancellationRepository(
          database.pool,
        );
        const taskStart = new PostgresTaskStartRepository(database.pool);
        const application = options.create({
          evidence,
          authenticator: createClusterControlApiCredentialAuthenticator(
            new PostgresApiCredentialRepository(database.pool),
            options.apiCredentialPepper ?? '',
          ),
          policies: new PostgresProjectPolicyRepository(database.pool),
          runs,
          runAttemptLogRetention,
          runCancellation,
          taskStart,
          taskDefinitions: new PostgresTaskDefinitionSource(database.pool),
          taskExecutionRevisions: new PostgresTaskExecutionRevisionSource(
            database.pool,
          ),
          triggers: new PostgresTriggerSource(database.pool),
          schedules,
          trustedToolStorage,
          securityAudit: new PostgresSecurityAuditRepository(database.pool),
          workflowAdministration:
            createClusterPluginPackageWorkflowAdministrationCapability(
              new PostgresPluginPackageAutomationPublicationRepository(
                database.pool,
              ),
              new PostgresPluginPackageMaterializedRevisionRepository(
                database.pool,
              ),
              new PostgresAuthorizedPluginPackageWorkflowAdmissionRepository(
                database.pool,
              ),
              new PostgresAuthorizedPluginPackageWorkflowRunInspectionRepository(
                database.pool,
              ),
              new PostgresAuthorizedPluginPackageWorkflowRunListRepository(
                database.pool,
              ),
              new PostgresAuthorizedPluginPackageWorkflowStepRunListRepository(
                database.pool,
              ),
              new PostgresAuthorizedPluginPackageWorkflowRunEventListRepository(
                database.pool,
              ),
              runCancellation,
            ),
          ...(options.workerRuntime === undefined
            ? {}
            : {
                workerRuntime: createClusterWorkerRuntimePort(
                  database.pool,
                  options.workerRuntime,
                  {
                    cancellationDispatchOwnerId: recoveryRuntime.ownerId,
                  },
                ),
              }),
        });
        const convergence = new ClusterControlRecoveryConvergenceVerifier(
          recovery,
        );
        return {
          async reconcile() {
            const outstanding = await convergence.verify();
            if (!outstanding.safe) {
              const system = await recoveryCoordinator.reconcile();
              if (
                !system.safe ||
                system.remaining !== 0 ||
                system.failed !== 0
              ) {
                return system;
              }
            }
            const summary = await application.reconcile();
            if (
              !summary.safe ||
              summary.remaining !== 0 ||
              summary.failed !== 0
            ) {
              return summary;
            }
            return convergence.verify();
          },
          async startLifecycles() {
            if (!(await application.startLifecycles())) return false;
            schedulerLifecycle.start();
            cancellationConvergenceLifecycle.start();
            logRetentionLifecycle?.start();
            return true;
          },
          installAdmission: () => application.installAdmission(),
          async stop() {
            recoveryRegistry?.dispose();
            let schedulerStatus: 'stopped' | 'timed_out' = 'stopped';
            let cancellationStatus: 'stopped' | 'timed_out' = 'stopped';
            let logRetentionStatus: 'stopped' | 'timed_out' = 'stopped';
            let applicationStatus: ClusterControlStopResult = 'stopped';
            let primaryError: unknown;
            try {
              logRetentionStatus =
                (await logRetentionLifecycle?.stopAndDrain()) ?? 'stopped';
            } catch (error) {
              primaryError = error;
            }
            try {
              cancellationStatus = (
                await cancellationConvergenceLifecycle.stopAndDrain()
              ).status;
            } catch (error) {
              primaryError ??= error;
            }
            try {
              schedulerStatus = (await schedulerLifecycle.stopAndDrain())
                .status;
            } catch (error) {
              primaryError ??= error;
            }
            try {
              applicationStatus = await application.stop();
            } catch (error) {
              primaryError ??= error;
            }
            if (primaryError) throw primaryError;
            return cancellationStatus === 'timed_out' ||
              logRetentionStatus === 'timed_out' ||
              schedulerStatus === 'timed_out' ||
              applicationStatus === 'timed_out'
              ? 'timed_out'
              : 'stopped';
          },
        };
      },
      audit: options.audit,
    });
    if (activation.status === 'disabled') return activation;

    let stopPromise: Promise<ClusterControlStopResult> | undefined;
    return {
      ...activation,
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          let result: ClusterControlStopResult | undefined;
          let primaryError: unknown;
          try {
            result = await activation.stop();
          } catch (error) {
            primaryError = error;
          }
          try {
            await closeDatabase();
          } catch (error) {
            primaryError ??= error;
          }
          if (primaryError) throw primaryError;
          return result!;
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    recoveryRegistry?.dispose();
    try {
      await closeDatabase();
    } catch {
      // Preserve the readiness/assembly/activation failure.
    }
    throw error;
  }
}

export type {
  ClusterControlActivationAudit,
  ClusterControlActivationStack,
  ClusterControlReadinessEvidence,
  ClusterControlRuntimeActivationResult,
  ClusterControlStopResult,
  DeploymentProfile,
  OpenPostgresDatabase,
  PostgresDatabaseResource,
  PostgresPool,
  ProjectPolicyRepository,
  RunRepository,
  ClusterRunCancellationRepository,
  ClusterControlRequestAuthenticator,
  ClusterControlSecurityAuditSink,
  ClusterControlRecoveryExecutorEvidenceProvider,
  ClusterScheduleStore,
};

export { ClusterRunCancellationConvergenceLifecycle } from '../run/runCancellationLifecycle';

export * from '../scheduling/scheduler';
export * from '../scheduling/workflowScheduler';
export * from '../scheduling/runtimeScheduler';
export * from '../remote-execution/remoteWorkerDispatcher';
export * from '../remote-execution/workerRuntimePort';

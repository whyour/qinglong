import type { LocalSqliteActivationFence } from '../runtime';
import {
  bootstrapLocalProfileStorage,
  type LocalProfileStorageAudit,
  type LocalProfileStorageBootstrapResult,
} from '@qinglong/local-sqlite/profile';

type ReadyLocalStorage = Extract<
  LocalProfileStorageBootstrapResult,
  { status: 'storage_ready' }
>;
type LocalSqliteProfile = LocalProfileStorageBootstrapResult['profile'];
type LocalSqliteReadinessEvidence = ReadyLocalStorage['evidence'];
type LocalSqliteRunRepository = ReadyLocalStorage['runs'];
type LocalSqliteStepRunReader = ReadyLocalStorage['stepRunReader'];
type LocalSqliteRunCancellationRepository =
  ReadyLocalStorage['runCancellationRepository'];
type LocalSqliteTaskStartRepository = ReadyLocalStorage['taskStartRepository'];
type TaskDefinitionRepository = ReadyLocalStorage['taskDefinitions'];
type LocalScheduleStore = ReadyLocalStorage['schedules'];
type LocalDispatchStore = ReadyLocalStorage['dispatch'];
type LocalSecretEnvelopeRepository = ReadyLocalStorage['localSecrets'];
type LocalSecretAdministrationRepository =
  ReadyLocalStorage['localSecretAdministration'];
type ProjectPolicyRepository = ReadyLocalStorage['projectPolicy'];
type SecurityAuditSink = ReadyLocalStorage['securityAudit'];
type ApiCredentialRepository = ReadyLocalStorage['apiCredentials'];
type LocalOwnerPepperRepository = ReadyLocalStorage['ownerPepper'];
type PluginPackageInstallRepository =
  ReadyLocalStorage['pluginPackageInstalls'];
type PluginPackageMaterializedRevisionRepository =
  ReadyLocalStorage['pluginPackageMaterializedRevisions'];
type PluginPackageSecretBindingRepository =
  ReadyLocalStorage['pluginPackageSecretBindings'];
type PluginPackageTaskReconciliationRepository =
  ReadyLocalStorage['pluginPackageTaskReconciliations'];
type PluginPackageAutomationPublicationRepository =
  ReadyLocalStorage['pluginPackageAutomationPublications'];
type ProjectToolDefinitionSnapshotRepository =
  ReadyLocalStorage['projectToolDefinitionSnapshots'];
type LocalWorkflowTaskExecutionRepository =
  ReadyLocalStorage['pluginPackageWorkflowRuntime'];
type LocalSqliteTrustedToolStorage = ReadyLocalStorage['trustedToolStorage'];

export type LocalAdoptedProfileState =
  | 'disabled'
  | 'fence_acquired'
  | 'storage_ready'
  | 'failed'
  | 'stopped';

export interface LocalAdoptedProfileAudit {
  readonly profile: LocalSqliteProfile;
  readonly state: LocalAdoptedProfileState;
}

export interface LocalAdoptedProfileBootstrapOptions {
  readonly enabled?: boolean;
  readonly profile: LocalSqliteProfile;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly recoveryPath: string;
  readonly manifestPath: string;
  readonly activationPath: string;
  readonly expectedActivationDigest: string;
  readonly busyTimeoutMs?: number;
  readonly audit: (record: LocalProfileStorageAudit) => void | Promise<void>;
  readonly adoptionAudit: (
    record: LocalAdoptedProfileAudit,
  ) => void | Promise<void>;
}

export type LocalAdoptedProfileBootstrapResult =
  | {
      readonly status: 'disabled';
      readonly profile: LocalSqliteProfile;
      stop(): Promise<'stopped'>;
    }
  | {
      readonly status: 'adopted_storage_ready';
      readonly profile: LocalSqliteProfile;
      readonly evidence: LocalSqliteReadinessEvidence;
      readonly runs: LocalSqliteRunRepository;
      readonly stepRunReader: LocalSqliteStepRunReader;
      readonly runCancellationRepository: LocalSqliteRunCancellationRepository;
      readonly taskStartRepository: LocalSqliteTaskStartRepository;
      readonly taskDefinitions: TaskDefinitionRepository;
      readonly schedules: LocalScheduleStore;
      readonly dispatch: LocalDispatchStore;
      readonly executionControl: ReadyLocalStorage['executionControl'];
      readonly completionReceipts: ReadyLocalStorage['completionReceipts'];
      readonly runAttemptLogRetention: ReadyLocalStorage['runAttemptLogRetention'];
      readonly runLostRetry: ReadyLocalStorage['runLostRetry'];
      readonly localSecrets: LocalSecretEnvelopeRepository;
      readonly localSecretAdministration: LocalSecretAdministrationRepository;
      readonly projectPolicy: ProjectPolicyRepository;
      readonly securityAudit: SecurityAuditSink;
      readonly apiCredentials: ApiCredentialRepository;
      readonly ownerPepper: LocalOwnerPepperRepository;
      readonly pluginPackageInstalls: PluginPackageInstallRepository;
      readonly pluginPackageMaterializedRevisions: PluginPackageMaterializedRevisionRepository;
      readonly pluginPackageSecretBindings: PluginPackageSecretBindingRepository;
      readonly pluginPackageTaskReconciliations: PluginPackageTaskReconciliationRepository;
      readonly pluginPackageAutomationPublications: PluginPackageAutomationPublicationRepository;
      readonly projectToolDefinitionSnapshots: ProjectToolDefinitionSnapshotRepository;
      readonly pluginPackageWorkflowRuntime: LocalWorkflowTaskExecutionRepository;
      readonly trustedToolStorage: LocalSqliteTrustedToolStorage;
      readonly startupRecovery: ReadyLocalStorage['startupRecovery'];
      stop(): Promise<'stopped'>;
    };

function assertOptions(options: LocalAdoptedProfileBootstrapOptions): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Local adopted Profile bootstrap options are invalid');
  }
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new TypeError('Local adopted Profile enabled flag is invalid');
  }
  if (options.profile !== 'edge' && options.profile !== 'standalone') {
    throw new TypeError('Local adopted Profile is invalid');
  }
  if (typeof options.audit !== 'function') {
    throw new TypeError('Local adopted Profile storage audit sink is invalid');
  }
  if (typeof options.adoptionAudit !== 'function') {
    throw new TypeError('Local adopted Profile adoption audit sink is invalid');
  }
}

async function cleanupAfterFailure(
  storage: LocalProfileStorageBootstrapResult | undefined,
  fence: LocalSqliteActivationFence | undefined,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (storage) {
    try {
      await storage.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (fence) {
    try {
      await fence.release();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export async function bootstrapLocalAdoptedProfileStorage(
  options: LocalAdoptedProfileBootstrapOptions,
): Promise<LocalAdoptedProfileBootstrapResult> {
  assertOptions(options);
  if (!(options.enabled ?? false)) {
    const storage = await bootstrapLocalProfileStorage({
      enabled: false,
      profile: options.profile,
      databasePath: options.targetPath,
      audit: options.audit,
    });
    await options.adoptionAudit({
      profile: options.profile,
      state: 'disabled',
    });
    let stopPromise: Promise<'stopped'> | undefined;
    return Object.freeze({
      status: 'disabled',
      profile: options.profile,
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          await storage.stop();
          await options.adoptionAudit({
            profile: options.profile,
            state: 'stopped',
          });
          return 'stopped' as const;
        })();
        return stopPromise;
      },
    });
  }

  let fence: LocalSqliteActivationFence | undefined;
  let storage: LocalProfileStorageBootstrapResult | undefined;
  try {
    const { acquireLocalSqliteActivation } = await import('../runtime.js');
    const acquiredFence = await acquireLocalSqliteActivation({
      sourcePath: options.sourcePath,
      targetPath: options.targetPath,
      recoveryPath: options.recoveryPath,
      manifestPath: options.manifestPath,
      activationPath: options.activationPath,
      expectedActivationDigest: options.expectedActivationDigest,
      ...(options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: options.busyTimeoutMs }),
    });
    fence = acquiredFence;
    await options.adoptionAudit({
      profile: options.profile,
      state: 'fence_acquired',
    });
    storage = await bootstrapLocalProfileStorage({
      enabled: true,
      profile: options.profile,
      databasePath: options.targetPath,
      audit: options.audit,
      ...(options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: options.busyTimeoutMs }),
    });
    if (storage.status !== 'storage_ready') {
      throw new Error('Enabled adopted Profile storage did not become ready');
    }
    acquiredFence.assertTargetIdentity();
    await options.adoptionAudit({
      profile: options.profile,
      state: 'storage_ready',
    });
    let stopPromise: Promise<'stopped'> | undefined;
    const readyStorage = storage;
    const activeFence = acquiredFence;
    return Object.freeze({
      status: 'adopted_storage_ready',
      profile: options.profile,
      evidence: readyStorage.evidence,
      runs: readyStorage.runs,
      stepRunReader: readyStorage.stepRunReader,
      runCancellationRepository: readyStorage.runCancellationRepository,
      taskStartRepository: readyStorage.taskStartRepository,
      taskDefinitions: readyStorage.taskDefinitions,
      schedules: readyStorage.schedules,
      dispatch: readyStorage.dispatch,
      executionControl: readyStorage.executionControl,
      completionReceipts: readyStorage.completionReceipts,
      runAttemptLogRetention: readyStorage.runAttemptLogRetention,
      runLostRetry: readyStorage.runLostRetry,
      localSecrets: readyStorage.localSecrets,
      localSecretAdministration: readyStorage.localSecretAdministration,
      projectPolicy: readyStorage.projectPolicy,
      securityAudit: readyStorage.securityAudit,
      apiCredentials: readyStorage.apiCredentials,
      ownerPepper: readyStorage.ownerPepper,
      pluginPackageInstalls: readyStorage.pluginPackageInstalls,
      pluginPackageMaterializedRevisions:
        readyStorage.pluginPackageMaterializedRevisions,
      pluginPackageSecretBindings: readyStorage.pluginPackageSecretBindings,
      pluginPackageTaskReconciliations:
        readyStorage.pluginPackageTaskReconciliations,
      pluginPackageAutomationPublications:
        readyStorage.pluginPackageAutomationPublications,
      projectToolDefinitionSnapshots:
        readyStorage.projectToolDefinitionSnapshots,
      pluginPackageWorkflowRuntime: readyStorage.pluginPackageWorkflowRuntime,
      trustedToolStorage: readyStorage.trustedToolStorage,
      startupRecovery: readyStorage.startupRecovery,
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          const errors = await cleanupAfterFailure(readyStorage, activeFence);
          if (errors.length > 0) {
            throw errors.length === 1
              ? errors[0]
              : new AggregateError(errors, 'Adopted Profile stop failed');
          }
          await options.adoptionAudit({
            profile: options.profile,
            state: 'stopped',
          });
          return 'stopped' as const;
        })();
        return stopPromise;
      },
    });
  } catch (error) {
    const cleanupErrors = await cleanupAfterFailure(storage, fence);
    try {
      await options.adoptionAudit({
        profile: options.profile,
        state: 'failed',
      });
    } catch (auditError) {
      cleanupErrors.push(auditError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Adopted Profile activation failed and cleanup was incomplete',
      );
    }
    throw error;
  }
}

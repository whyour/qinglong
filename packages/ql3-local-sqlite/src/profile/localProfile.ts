import {
  openLocalSqliteRuntimeDatabase,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
  type LocalSqliteReadinessEvidence,
  type LocalSqliteRuntimeDatabase,
} from '../runtime/runtimeDatabase';

export type LocalProfileStorageState =
  | 'disabled'
  | 'storage_ready'
  | 'failed'
  | 'stopped';

export interface LocalProfileStorageAudit {
  readonly profile: LocalSqliteProfile;
  readonly state: LocalProfileStorageState;
  readonly contractName?: string;
  readonly contractVersion?: number;
  readonly migrationCount?: number;
  readonly journalMode?: string;
}

export interface LocalProfileStorageBootstrapOptions
  extends LocalSqliteDatabaseOptions {
  readonly enabled?: boolean;
  readonly audit: (record: LocalProfileStorageAudit) => void | Promise<void>;
}

export type LocalProfileStorageBootstrapResult =
  | {
      readonly status: 'disabled';
      readonly profile: LocalSqliteProfile;
      stop(): Promise<'stopped'>;
    }
  | {
      readonly status: 'storage_ready';
      readonly profile: LocalSqliteProfile;
      readonly evidence: LocalSqliteReadinessEvidence;
      readonly runs: LocalSqliteRuntimeDatabase['runRepository'];
      readonly stepRunReader: LocalSqliteRuntimeDatabase['stepRunReader'];
      readonly runCancellationRepository: LocalSqliteRuntimeDatabase['runCancellationRepository'];
      readonly taskStartRepository: LocalSqliteRuntimeDatabase['taskStartRepository'];
      readonly taskDefinitions: LocalSqliteRuntimeDatabase['taskDefinitions'];
      readonly schedules: LocalSqliteRuntimeDatabase['schedules'];
      readonly dispatch: LocalSqliteRuntimeDatabase['localDispatch'];
      readonly executionControl: LocalSqliteRuntimeDatabase['executionControl'];
      readonly completionReceipts: LocalSqliteRuntimeDatabase['completionReceipts'];
      readonly runAttemptLogRetention: LocalSqliteRuntimeDatabase['runAttemptLogRetention'];
      readonly runLostRetry: LocalSqliteRuntimeDatabase['runLostRetry'];
      readonly localSecrets: LocalSqliteRuntimeDatabase['localSecrets'];
      readonly localSecretAdministration: LocalSqliteRuntimeDatabase['localSecretAdministration'];
      readonly projectPolicy: LocalSqliteRuntimeDatabase['projectPolicy'];
      readonly securityAudit: LocalSqliteRuntimeDatabase['securityAudit'];
      readonly apiCredentials: LocalSqliteRuntimeDatabase['apiCredentials'];
      readonly ownerPepper: LocalSqliteRuntimeDatabase['ownerPepper'];
      readonly pluginPackageInstalls: LocalSqliteRuntimeDatabase['pluginPackageInstalls'];
      readonly pluginPackageMaterializedRevisions: LocalSqliteRuntimeDatabase['pluginPackageMaterializedRevisions'];
      readonly pluginPackageSecretBindings: LocalSqliteRuntimeDatabase['pluginPackageSecretBindings'];
      readonly pluginPackageTaskReconciliations: LocalSqliteRuntimeDatabase['pluginPackageTaskReconciliations'];
      readonly pluginPackageAutomationPublications: LocalSqliteRuntimeDatabase['pluginPackageAutomationPublications'];
      readonly projectToolDefinitionSnapshots: LocalSqliteRuntimeDatabase['projectToolDefinitionSnapshots'];
      readonly pluginPackageWorkflowRuntime: LocalSqliteRuntimeDatabase['pluginPackageWorkflowRuntime'];
      readonly trustedToolStorage: LocalSqliteRuntimeDatabase['trustedToolStorage'];
      readonly startupRecovery: LocalSqliteRuntimeDatabase['startupRecovery'];
      stop(): Promise<'stopped'>;
    };

function evidenceAudit(
  profile: LocalSqliteProfile,
  state: LocalProfileStorageState,
  evidence: LocalSqliteReadinessEvidence,
): LocalProfileStorageAudit {
  return Object.freeze({
    profile,
    state,
    contractName: evidence.contractName,
    contractVersion: evidence.contractVersion,
    migrationCount: evidence.migrationIds.length,
    journalMode: evidence.journalMode,
  });
}

function assertBootstrapBoundary(
  options: LocalProfileStorageBootstrapOptions,
): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Local Profile storage bootstrap options are invalid');
  }
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new TypeError('Local Profile storage enabled flag is invalid');
  }
  if (options.profile !== 'edge' && options.profile !== 'standalone') {
    throw new TypeError('Local Profile storage Profile is invalid');
  }
  if (typeof options.audit !== 'function') {
    throw new TypeError('Local Profile storage audit sink is invalid');
  }
}

/**
 * Owns exactly one local database authority. This gate proves storage only; it
 * does not claim that scheduler, executor, admission, or recovery is active.
 */
export async function bootstrapLocalProfileStorage(
  options: LocalProfileStorageBootstrapOptions,
): Promise<LocalProfileStorageBootstrapResult> {
  assertBootstrapBoundary(options);
  if (!(options.enabled ?? false)) {
    await options.audit({ profile: options.profile, state: 'disabled' });
    return Object.freeze({
      status: 'disabled',
      profile: options.profile,
      stop: async () => 'stopped' as const,
    });
  }

  let database: LocalSqliteRuntimeDatabase | undefined;
  try {
    database = await openLocalSqliteRuntimeDatabase({
      databasePath: options.databasePath,
      profile: options.profile,
      ...(options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: options.busyTimeoutMs }),
    });
    await options.audit(
      evidenceAudit(options.profile, 'storage_ready', database.readiness),
    );
    let stopPromise: Promise<'stopped'> | undefined;
    return Object.freeze({
      status: 'storage_ready',
      profile: options.profile,
      evidence: database.readiness,
      runs: database.runRepository,
      stepRunReader: database.stepRunReader,
      runCancellationRepository: database.runCancellationRepository,
      taskStartRepository: database.taskStartRepository,
      taskDefinitions: database.taskDefinitions,
      schedules: database.schedules,
      dispatch: database.localDispatch,
      executionControl: database.executionControl,
      completionReceipts: database.completionReceipts,
      runAttemptLogRetention: database.runAttemptLogRetention,
      runLostRetry: database.runLostRetry,
      localSecrets: database.localSecrets,
      localSecretAdministration: database.localSecretAdministration,
      projectPolicy: database.projectPolicy,
      securityAudit: database.securityAudit,
      apiCredentials: database.apiCredentials,
      ownerPepper: database.ownerPepper,
      pluginPackageInstalls: database.pluginPackageInstalls,
      pluginPackageMaterializedRevisions:
        database.pluginPackageMaterializedRevisions,
      pluginPackageSecretBindings: database.pluginPackageSecretBindings,
      pluginPackageTaskReconciliations:
        database.pluginPackageTaskReconciliations,
      pluginPackageAutomationPublications:
        database.pluginPackageAutomationPublications,
      projectToolDefinitionSnapshots: database.projectToolDefinitionSnapshots,
      pluginPackageWorkflowRuntime: database.pluginPackageWorkflowRuntime,
      trustedToolStorage: database.trustedToolStorage,
      startupRecovery: database.startupRecovery,
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          await database!.close();
          await options.audit(
            evidenceAudit(options.profile, 'stopped', database!.readiness),
          );
          return 'stopped' as const;
        })();
        return stopPromise;
      },
    });
  } catch (error) {
    if (database) {
      try {
        await database.close();
      } catch {
        // Preserve the readiness or audit failure.
      }
    }
    try {
      await options.audit({ profile: options.profile, state: 'failed' });
    } catch {
      // Diagnostic failure cannot replace the activation failure.
    }
    throw error;
  }
}

import { LocalExecutionCoordinator } from '@qinglong/local-execution/execution';
import {
  LocalCompletionReceiptProcessor,
  LocalExecutionControlCoordinator,
  LocalExecutionControlLifecycle,
  LocalExecutionControlScanner,
  type LocalExecutionControlCycleSummary,
} from '@qinglong/local-execution/control';
import {
  LocalDispatchPlanMaterializer,
  LocalFileArtifactAllocator,
  LocalRunDispatcher,
  localArtifactCapacityPolicyForProfile,
} from '@qinglong/local-execution/dispatch';
import {
  LocalRunStartupRecoveryCoordinator,
  LocalWorkflowTaskStartupRecoveryCoordinator,
  type LocalRunStartupRecoverySummary,
  type LocalWorkflowTaskStartupRecoverySummary,
} from '@qinglong/local-execution/recovery';
import {
  LocalSchedulerCoordinator,
  LocalSchedulerLifecycle,
  LocalWorkflowSchedulerCoordinator,
} from '@qinglong/local-execution/scheduler';
import {
  CompletionReceiptFileStore,
  LocalCompletionReceiptCleanupScanner,
  LocalProcessController,
  LocalProcessPersistedExecutionInspector,
  LocalProcessLauncher,
  type LocalCompletionReceiptCleanupSummary,
} from '@qinglong/local-process';
import {
  EncryptedLocalSecretService,
  LocalSecretKeyringFileProvider,
} from '@qinglong/local-secret';
import { MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE } from '@qinglong/runtime-core/plugin-package-install';
import { MAX_PLUGIN_PACKAGE_RECOVERY_PAGES } from '@qinglong/runtime-core/plugin-package-recovery';
import {
  MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGES,
  MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGE_SIZE,
} from '@qinglong/runtime-core/plugin-package-task-publication';
import {
  type LocalApplicationActivationAudit,
  type LocalApplicationBootstrapOptions,
  type LocalApplicationBootstrapResult,
  type LocalApplicationEnabledBootstrapOptions,
  type LocalApplicationProfile,
  type LocalApplicationProductSurfaceLifecycle,
  type LocalApplicationStopResult,
} from './contract';
import {
  recoverLocalApplicationPluginPackages,
  type LocalApplicationPluginPackageStartup,
} from './pluginPackageStartup';
import {
  openLocalApplicationStorage,
  type LocalApplicationReadyStorage,
} from './storageActivation';
import { LocalApplicationStartupRecoveryRequiredError } from './startupErrors';
export {
  LocalApplicationPluginPackageAutomationPublicationRequiredError,
  LocalApplicationPluginPackageRecoveryRequiredError,
  LocalApplicationPluginPackageTaskPublicationRequiredError,
  LocalApplicationPluginPackageToolSnapshotRequiredError,
  LocalApplicationStartupRecoveryRequiredError,
} from './startupErrors';

const EXECUTION_CONTROL_POLICIES = Object.freeze({
  edge: Object.freeze({
    cleanupIntervalMs: 5 * 60_000,
    cleanupPageSize: 8,
    controlIntervalMs: 5_000,
    controlPageSize: 4,
    lostRetryPageSize: 2,
    maxDrainPages: 2,
    retentionMs: 24 * 60 * 60_000,
    artifactNormalRetentionMs: 7 * 24 * 60 * 60_000,
    artifactPressureRetentionMs: 24 * 60 * 60_000,
    artifactMinimumFreeBytes: 64 * 1024 * 1024,
    artifactRetentionPageSize: 4,
    artifactMaximumDeletions: 2,
    stopTimeoutMs: 5_000,
  }),
  standalone: Object.freeze({
    cleanupIntervalMs: 60_000,
    cleanupPageSize: 32,
    controlIntervalMs: 1_000,
    controlPageSize: 32,
    lostRetryPageSize: 16,
    maxDrainPages: 8,
    retentionMs: 60 * 60_000,
    artifactNormalRetentionMs: 30 * 24 * 60 * 60_000,
    artifactPressureRetentionMs: 24 * 60 * 60_000,
    artifactMinimumFreeBytes: 256 * 1024 * 1024,
    artifactRetentionPageSize: 16,
    artifactMaximumDeletions: 8,
    stopTimeoutMs: 10_000,
  }),
});

function assertProfile(
  profile: unknown,
): asserts profile is LocalApplicationProfile {
  if (profile !== 'edge' && profile !== 'standalone') {
    throw new TypeError('Local application Profile is invalid');
  }
}

function assertEnabledBoundary(
  options: LocalApplicationBootstrapOptions,
): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Local application bootstrap options are invalid');
  }
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new TypeError('Local application enabled flag is invalid');
  }
  assertProfile(options.profile);
  if (typeof options.applicationAudit !== 'function') {
    throw new TypeError('Local application audit sink is invalid');
  }
}

function assertActiveBoundary(
  options: LocalApplicationBootstrapOptions,
): asserts options is LocalApplicationEnabledBootstrapOptions {
  if (options.enabled !== true) {
    throw new TypeError('Local application enabled configuration is invalid');
  }
  if (typeof options.audit !== 'function') {
    throw new TypeError('Local application storage audit sink is invalid');
  }
  if (
    options.storageMode !== 'fresh' &&
    typeof options.adoptionAudit !== 'function'
  ) {
    throw new TypeError('Local application adoption audit sink is invalid');
  }
  if (
    options.storageMode === 'fresh' &&
    typeof options.databasePath !== 'string'
  ) {
    throw new TypeError('Local application fresh database path is invalid');
  }
  if (typeof options.receiptRoot !== 'string') {
    throw new TypeError('Local application receipt root is invalid');
  }
  if (typeof options.artifactRoot !== 'string') {
    throw new TypeError('Local application Artifact root is invalid');
  }
  if (typeof options.secretKeyringPath !== 'string') {
    throw new TypeError('Local application Secret keyring path is invalid');
  }
  if (
    options.productSurface !== undefined &&
    typeof options.productSurface?.start !== 'function'
  ) {
    throw new TypeError('Local application product surface is invalid');
  }
  const pluginPackages = options.pluginPackages;
  if (
    !pluginPackages ||
    typeof pluginPackages !== 'object' ||
    Array.isArray(pluginPackages) ||
    Object.keys(pluginPackages).some(
      (key) =>
        ![
          'stageProvider',
          'stagingRoot',
          'activationRoot',
          'now',
          'pageSize',
          'maxPages',
          'taskPublicationPageSize',
          'taskPublicationMaxPages',
        ].includes(key),
    ) ||
    !pluginPackages.stageProvider ||
    typeof pluginPackages.stageProvider.stage !== 'function' ||
    typeof pluginPackages.stagingRoot !== 'string' ||
    typeof pluginPackages.activationRoot !== 'string' ||
    typeof pluginPackages.now !== 'function' ||
    (pluginPackages.pageSize !== undefined &&
      (!Number.isSafeInteger(pluginPackages.pageSize) ||
        pluginPackages.pageSize < 1 ||
        pluginPackages.pageSize >
          MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE)) ||
    (pluginPackages.maxPages !== undefined &&
      (!Number.isSafeInteger(pluginPackages.maxPages) ||
        pluginPackages.maxPages < 1 ||
        pluginPackages.maxPages > MAX_PLUGIN_PACKAGE_RECOVERY_PAGES)) ||
    (pluginPackages.taskPublicationPageSize !== undefined &&
      (!Number.isSafeInteger(pluginPackages.taskPublicationPageSize) ||
        pluginPackages.taskPublicationPageSize < 1 ||
        pluginPackages.taskPublicationPageSize >
          MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGE_SIZE)) ||
    (pluginPackages.taskPublicationMaxPages !== undefined &&
      (!Number.isSafeInteger(pluginPackages.taskPublicationMaxPages) ||
        pluginPackages.taskPublicationMaxPages < 1 ||
        pluginPackages.taskPublicationMaxPages >
          MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGES))
  ) {
    throw new TypeError(
      'Local application Plugin Package recovery configuration is invalid',
    );
  }
}

function oneOrAggregate(errors: unknown[], message: string): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}

async function bestEffortAudit(
  options: LocalApplicationBootstrapOptions,
  record: LocalApplicationActivationAudit,
): Promise<void> {
  try {
    await options.applicationAudit(record);
  } catch {
    // Diagnostics cannot replace the activation or shutdown result.
  }
}

export async function bootstrapLocalApplication(
  options: LocalApplicationBootstrapOptions,
): Promise<LocalApplicationBootstrapResult> {
  assertEnabledBoundary(options);
  if (options.enabled !== true) {
    await options.applicationAudit({
      profile: options.profile,
      state: 'disabled',
    });
    return Object.freeze({
      status: 'disabled' as const,
      profile: options.profile,
      stop: async () => 'stopped' as const,
    });
  }
  assertActiveBoundary(options);

  let storage: LocalApplicationReadyStorage | undefined;
  let schedulerLifecycle: LocalSchedulerLifecycle | undefined;
  let executionControlLifecycle: LocalExecutionControlLifecycle | undefined;
  let runRecovery: LocalRunStartupRecoverySummary | undefined;
  let workflowTaskRecovery: LocalWorkflowTaskStartupRecoverySummary | undefined;
  let receiptCleanup: LocalCompletionReceiptCleanupSummary | undefined;
  let executionControl: LocalExecutionControlCycleSummary | undefined;
  let pluginPackageStartup: LocalApplicationPluginPackageStartup | undefined;
  let productSurfaceLifecycle:
    | Readonly<LocalApplicationProductSurfaceLifecycle>
    | undefined;

  try {
    storage = await openLocalApplicationStorage(options);
    await options.applicationAudit({
      profile: options.profile,
      state: 'storage_ready',
    });

    pluginPackageStartup = await recoverLocalApplicationPluginPackages(
      options,
      storage,
    );

    const secretKeys = new LocalSecretKeyringFileProvider(
      options.secretKeyringPath,
    );
    const activeSecretKey = await secretKeys.active();
    activeSecretKey.key.fill(0);
    const localSecrets = new EncryptedLocalSecretService(
      storage.localSecrets,
      secretKeys,
    );
    await options.applicationAudit({
      profile: options.profile,
      state: 'secrets_ready',
    });

    const executionPolicy = EXECUTION_CONTROL_POLICIES[options.profile];
    const [artifactStorage, retentionCore] = await Promise.all([
      import('@qinglong/local-execution/artifact-read'),
      import('@qinglong/runtime-core/run-attempt-log-retention'),
    ]);
    const artifactRetention = new retentionCore.RunAttemptLogRetentionService(
      storage.runAttemptLogRetention,
      new artifactStorage.LocalRunAttemptLogRetirementStore(
        options.artifactRoot,
      ),
      new artifactStorage.LocalRunAttemptLogCapacityProbe(options.artifactRoot),
      {
        normalRetentionMs: executionPolicy.artifactNormalRetentionMs,
        pressureRetentionMs: executionPolicy.artifactPressureRetentionMs,
        minimumFreeBytes: executionPolicy.artifactMinimumFreeBytes,
        pageSize: executionPolicy.artifactRetentionPageSize,
        maximumDeletions: executionPolicy.artifactMaximumDeletions,
      },
    );
    const receipts = new CompletionReceiptFileStore(options.receiptRoot);
    const localProcessLauncher = new LocalProcessLauncher(
      storage.completionReceipts,
      {
        receiptRoot: options.receiptRoot,
      },
    );
    const localProcessController = new LocalProcessController();
    const workflowRuntime = await storage.pluginPackageWorkflowRuntime();
    const localProcess = new LocalExecutionCoordinator(
      storage.runs,
      localProcessLauncher,
      localProcessController,
      { workflowTasks: workflowRuntime.executions },
    );
    const completionProcessor = new LocalCompletionReceiptProcessor(
      storage.runs,
      receipts,
      {
        journal: storage.completionReceipts,
        quarantineRetentionMs: executionPolicy.retentionMs,
        workflowTasks: workflowRuntime.executions,
      },
    );
    executionControlLifecycle = new LocalExecutionControlLifecycle(
      completionProcessor,
      new LocalExecutionControlScanner(
        storage.executionControl,
        new LocalExecutionControlCoordinator(
          storage.runs,
          completionProcessor,
          localProcessController,
          { workflowTasks: workflowRuntime.executions },
        ),
      ),
      new LocalCompletionReceiptCleanupScanner(
        storage.completionReceipts,
        receipts,
        {
          terminalMissingRetentionMs: executionPolicy.retentionMs,
        },
      ),
      {
        intervalMs: executionPolicy.controlIntervalMs,
        pageSize: executionPolicy.controlPageSize,
        cleanupIntervalMs: executionPolicy.cleanupIntervalMs,
        cleanupPageSize: executionPolicy.cleanupPageSize,
        stopTimeoutMs: executionPolicy.stopTimeoutMs,
        maxDrainPages: executionPolicy.maxDrainPages,
        artifactRetention,
        lostRetry: storage.runLostRetry,
        lostRetryPageSize: executionPolicy.lostRetryPageSize,
        onDiagnostic: async (error) => {
          if (error === undefined) return;
          await bestEffortAudit(options, {
            profile: options.profile,
            state: 'execution_control_degraded',
          });
        },
      },
    );
    const localProcessDispatcher = new LocalRunDispatcher(
      storage.dispatch,
      new LocalDispatchPlanMaterializer(
        storage.dispatch,
        new LocalFileArtifactAllocator(
          options.artifactRoot,
          localArtifactCapacityPolicyForProfile(options.profile),
        ),
        localSecrets,
      ),
      localProcess,
      {
        pageSize: options.profile === 'edge' ? 4 : 16,
        maxPages: 1,
        onCompletion: (attemptId) => {
          executionControlLifecycle?.notifyCompletion(attemptId);
        },
      },
    );
    const scheduler = new LocalSchedulerCoordinator(storage.schedules, {
      pageSize: options.profile === 'edge' ? 4 : 16,
      misfireGraceMs: options.profile === 'edge' ? 30_000 : 5_000,
    });
    const workflowScheduler = new LocalWorkflowSchedulerCoordinator(
      scheduler,
      workflowRuntime.cancellation,
      workflowRuntime.frontier,
      workflowRuntime.taskAttempts,
      localProcessDispatcher,
      {
        cancellationPageSize: options.profile === 'edge' ? 4 : 32,
        cancellationMaxPages: options.profile === 'edge' ? 1 : 4,
        frontierPageSize: options.profile === 'edge' ? 1 : 16,
        frontierMaxPages: options.profile === 'edge' ? 1 : 4,
        taskAttemptPageSize: options.profile === 'edge' ? 1 : 16,
        taskAttemptMaxPages: options.profile === 'edge' ? 1 : 4,
        maxDispatches: options.profile === 'edge' ? 1 : 4,
      },
    );
    schedulerLifecycle = new LocalSchedulerLifecycle(workflowScheduler, {
      intervalMs: options.profile === 'edge' ? 5_000 : 1_000,
      stopTimeoutMs: executionPolicy.stopTimeoutMs,
      onDiagnostic: async (error) => {
        if (error === undefined) return;
        await bestEffortAudit(options, {
          profile: options.profile,
          state: 'scheduler_degraded',
        });
      },
    });

    runRecovery = await new LocalRunStartupRecoveryCoordinator(
      storage.runs,
      storage.startupRecovery,
      receipts,
      new LocalProcessPersistedExecutionInspector(),
      {
        receiptPublishGraceMs: options.profile === 'edge' ? 50 : 100,
        journal: storage.completionReceipts,
        quarantineRetentionMs: executionPolicy.retentionMs,
        completionProcessor,
      },
    ).recover();
    if (!runRecovery.safe) {
      throw new LocalApplicationStartupRecoveryRequiredError(
        Math.max(
          runRecovery.remaining + runRecovery.failed,
          runRecovery.scanned - runRecovery.recovered,
        ),
        runRecovery.truncated,
      );
    }
    workflowTaskRecovery =
      await new LocalWorkflowTaskStartupRecoveryCoordinator(
        storage.runs,
        workflowRuntime.executions,
        workflowRuntime.executions,
        completionProcessor,
        new LocalProcessPersistedExecutionInspector(),
        {
          receiptPublishGraceMs: options.profile === 'edge' ? 50 : 100,
        },
      ).recover();
    if (!workflowTaskRecovery.safe) {
      throw new LocalApplicationStartupRecoveryRequiredError(
        workflowTaskRecovery.remaining + workflowTaskRecovery.failed,
        workflowTaskRecovery.truncated,
      );
    }
    await options.applicationAudit({
      profile: options.profile,
      state: 'runs_recovered',
      runRecovery,
      workflowTaskRecovery,
    });
    executionControl = await executionControlLifecycle.runOnce(true);
    receiptCleanup = executionControl.cleanup;
    if (!receiptCleanup) {
      throw new Error('Local completion receipt cleanup did not run');
    }
    await options.applicationAudit({
      profile: options.profile,
      state: 'receipts_reconciled',
      runRecovery,
      workflowTaskRecovery,
      receiptCleanup,
      executionControl,
    });
    await schedulerLifecycle.runOnce();
    await options.applicationAudit({
      profile: options.profile,
      state: 'recovered',
      runRecovery,
      workflowTaskRecovery,
      receiptCleanup,
      executionControl,
    });

    executionControlLifecycle.start();
    schedulerLifecycle.start();
    await options.applicationAudit({
      profile: options.profile,
      state: 'lifecycles_started',
      runRecovery,
      workflowTaskRecovery,
      receiptCleanup,
      executionControl,
    });

    if (options.productSurface) {
      const [
        stepRuns,
        runCancellation,
        taskStart,
        { LocalRunAttemptLogRangeReader },
        { RunAttemptLogReadService },
      ] = await Promise.all([
        storage.stepRunReader(),
        storage.runCancellationRepository(),
        storage.taskStartRepository(),
        import('@qinglong/local-execution/artifact-read'),
        import('@qinglong/runtime-core/run-attempt-log-read'),
      ]);
      const runAttemptLogRead = new RunAttemptLogReadService(
        storage.runs,
        new LocalRunAttemptLogRangeReader(options.artifactRoot),
        {
          executorType: 'local_process',
          artifactIdPattern: /^local-[a-f0-9]{30}$/,
          maximumReadBytes: 32 * 1024,
        },
        storage.runAttemptLogRetention,
      );
      productSurfaceLifecycle = await options.productSurface.start(
        Object.freeze({
          profile: options.profile,
          runs: storage.runs,
          stepRuns,
          runCancellation,
          taskStart,
          runAttemptLogRead,
          taskDefinitions: storage.taskDefinitions,
          taskDefinitionAdministrationForCredential:
            storage.taskDefinitionAdministrationForCredential,
          apiCredentials: storage.apiCredentials,
          ownerPepper: storage.ownerPepper,
          projectPolicy: storage.projectPolicy,
          securityAudit: storage.securityAudit,
        }),
      );
      if (
        !productSurfaceLifecycle ||
        typeof productSurfaceLifecycle.stopAndDrain !== 'function'
      ) {
        throw new TypeError(
          'Local application product surface lifecycle is invalid',
        );
      }
    }

    await options.applicationAudit({
      profile: options.profile,
      state: 'active',
      runRecovery,
      workflowTaskRecovery,
      receiptCleanup,
      executionControl,
    });

    let stopPromise: Promise<LocalApplicationStopResult> | undefined;
    const activeStorage = storage;
    const activeSchedulerLifecycle = schedulerLifecycle;
    const activeExecutionControlLifecycle = executionControlLifecycle;
    const activeRunRecovery = runRecovery;
    const activeWorkflowTaskRecovery = workflowTaskRecovery;
    const activeReceiptCleanup = receiptCleanup;
    const activeExecutionControl = executionControl;
    const activePluginPackageStartup = pluginPackageStartup;
    const activeProductSurfaceLifecycle = productSurfaceLifecycle;
    return Object.freeze({
      status: 'active' as const,
      profile: options.profile,
      evidence: activeStorage.evidence,
      runs: activeStorage.runs,
      runRecovery: activeRunRecovery,
      workflowTaskRecovery: activeWorkflowTaskRecovery,
      receiptCleanup: activeReceiptCleanup,
      executionControl: activeExecutionControl,
      pluginPackageRecovery: activePluginPackageStartup.pluginPackageRecovery,
      pluginPackageTaskPublicationRecovery:
        activePluginPackageStartup.pluginPackageTaskPublicationRecovery,
      pluginPackageAutomationPublicationRecovery:
        activePluginPackageStartup.pluginPackageAutomationPublicationRecovery,
      pluginPackageToolSnapshotRecovery:
        activePluginPackageStartup.pluginPackageToolSnapshotRecovery,
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          const errors: unknown[] = [];
          let timedOut = false;
          await bestEffortAudit(options, {
            profile: options.profile,
            state: 'draining',
            runRecovery: activeRunRecovery,
            workflowTaskRecovery: activeWorkflowTaskRecovery,
            receiptCleanup: activeReceiptCleanup,
            executionControl: activeExecutionControl,
          });
          if (activeProductSurfaceLifecycle) {
            try {
              const surfaceStop =
                await activeProductSurfaceLifecycle.stopAndDrain();
              timedOut = surfaceStop === 'timed_out' || timedOut;
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            const schedulerStop = await activeSchedulerLifecycle.stopAndDrain();
            timedOut = schedulerStop.status === 'timed_out' || timedOut;
          } catch (error) {
            errors.push(error);
          }
          try {
            const executionStop =
              await activeExecutionControlLifecycle.stopAndDrain();
            timedOut = executionStop.status === 'timed_out' || timedOut;
            await bestEffortAudit(options, {
              profile: options.profile,
              state: 'draining',
              runRecovery: activeRunRecovery,
              workflowTaskRecovery: activeWorkflowTaskRecovery,
              receiptCleanup: executionStop.cleanup ?? activeReceiptCleanup,
              executionControl: activeExecutionControl,
              ...(executionStop.drain === undefined
                ? {}
                : { executionDrain: executionStop.drain }),
            });
          } catch (error) {
            errors.push(error);
          }
          try {
            await activeStorage.stop();
          } catch (error) {
            errors.push(error);
          }
          await bestEffortAudit(options, {
            profile: options.profile,
            state: 'stopped',
            runRecovery: activeRunRecovery,
            workflowTaskRecovery: activeWorkflowTaskRecovery,
            receiptCleanup: activeReceiptCleanup,
            executionControl: activeExecutionControl,
          });
          if (errors.length > 0) {
            throw oneOrAggregate(errors, 'Local application stop failed');
          }
          return timedOut ? 'timed_out' : 'stopped';
        })();
        return stopPromise;
      },
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (productSurfaceLifecycle) {
      try {
        await productSurfaceLifecycle.stopAndDrain();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (schedulerLifecycle) {
      try {
        await schedulerLifecycle.stopAndDrain();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (executionControlLifecycle) {
      try {
        await executionControlLifecycle.stopAndDrain();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (storage) {
      try {
        await storage.stop();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    await bestEffortAudit(options, {
      profile: options.profile,
      state: 'failed',
      ...(runRecovery ? { runRecovery } : {}),
      ...(workflowTaskRecovery ? { workflowTaskRecovery } : {}),
      ...(receiptCleanup ? { receiptCleanup } : {}),
      ...(executionControl ? { executionControl } : {}),
    });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Local application activation failed and cleanup was incomplete',
      );
    }
    throw error;
  }
}

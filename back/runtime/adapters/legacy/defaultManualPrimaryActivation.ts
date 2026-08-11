import type { Sequelize } from 'sequelize';
import { sequelize } from '../../../data';
import Logger from '../../../loaders/logger';
import {
  PrimaryCompletionReceiptLifecycle,
  type PrimaryCompletionReceiptLifecycleOptions,
} from '../../application/primaryCompletionReceiptLifecycle';
import { PrimaryCompletionReceiptJournalScanner } from '../../application/primaryCompletionReceiptJournalScanner';
import { PrimaryCompletionReceiptSupervisor } from '../../application/primaryCompletionReceiptSupervisor';
import { PrimaryCompletionReceiptConsumer } from '../../application/primaryCompletionReceiptConsumer';
import { PrimaryRunCompletionService } from '../../application/primaryRunCompletionService';
import {
  PrimaryCancellationLifecycle,
  type PrimaryCancellationLifecycleOptions,
} from '../../application/primaryCancellationLifecycle';
import { PrimaryCancellationDispatcher } from '../../application/primaryCancellationDispatcher';
import { PrimaryCancellationSupervisor } from '../../application/primaryCancellationSupervisor';
import { PrimaryTimeoutRequester } from '../../application/primaryTimeoutRequester';
import { PrimaryTimeoutSupervisor } from '../../application/primaryTimeoutSupervisor';
import {
  PrimaryTimeoutLifecycle,
  type PrimaryTimeoutLifecycleOptions,
} from '../../application/primaryTimeoutLifecycle';
import { RunCommandService } from '../../application/runCommandService';
import { PrimaryRunStartupReconciler } from '../../application/primaryRunStartupReconciler';
import {
  PrimaryRunStartupSupervisor,
  type PrimaryRunStartupOptions,
} from '../../application/primaryRunStartupSupervisor';
import type { RuntimeRolloutPolicy } from '../../domain/runtimeRollout';
import {
  localPrimaryResourcePolicy,
  type DeploymentProfile,
} from '../../domain/deploymentProfile';
import { LegacySequelizeCancellationDispatchRepository } from '../legacy-sequelize/cancellationDispatchRepository';
import { LegacySequelizePrimaryCancellationSource } from '../legacy-sequelize/primaryCancellationSource';
import { LegacySequelizePrimaryTimeoutSource } from '../legacy-sequelize/primaryTimeoutSource';
import { PrimaryCronProjection } from '../legacy-sequelize/primaryCronProjection';
import { LegacySequelizePrimaryRunRecoverySource } from '../legacy-sequelize/primaryRunRecoverySource';
import { LegacySequelizeCompletionReceiptJournal } from '../legacy-sequelize/completionReceiptJournal';
import { LegacySequelizeProjectedRunRepository } from '../legacy-sequelize/projectedRunRepository';
import { LocalProcessPersistedExecutionInspector } from '../local-process/localProcessIdentity';
import { LocalProcessPersistedExecutionController } from '../local-process/persistedLocalProcessController';
import { LocalProcessExecutor } from '../local-process/localProcessExecutor';
import { CompletionReceiptFileStore } from '../fs/completionReceiptFileStore';
import {
  DEFAULT_COMPLETION_RECEIPT_ROOT,
  DEFAULT_LOCAL_PROCESS_LAUNCHER_PATH,
  LegacyManualPrimaryLogFiles,
} from './defaultManualPrimaryRuntime';
import { ManualPrimaryRuntime } from '../../application/manualPrimaryRuntime';

export interface DefaultManualPrimaryActivationOptions {
  database?: Sequelize;
  owner?: string;
  deploymentProfile?: DeploymentProfile;
  recovery?: PrimaryRunStartupOptions;
  completion?: Pick<
    PrimaryCompletionReceiptLifecycleOptions,
    'intervalMs' | 'initialDelayMs' | 'stopTimeoutMs' | 'cycle'
  >;
  cancellation?: Pick<
    PrimaryCancellationLifecycleOptions,
    'intervalMs' | 'initialDelayMs' | 'stopTimeoutMs' | 'cycle'
  >;
  timeout?: Pick<
    PrimaryTimeoutLifecycleOptions,
    'intervalMs' | 'initialDelayMs' | 'stopTimeoutMs' | 'cycle'
  >;
}

function boundedOwner(value: string): string {
  if (!value || value.length > 128) {
    throw new RangeError(
      'Primary activation owner must be 1 to 128 characters',
    );
  }
  return value;
}

export function createDefaultManualPrimaryActivationStack(
  rollout: RuntimeRolloutPolicy,
  options: DefaultManualPrimaryActivationOptions = {},
) {
  const database = options.database ?? sequelize;
  const resources = localPrimaryResourcePolicy(
    options.deploymentProfile ?? 'standalone',
  );
  const repository = new LegacySequelizeProjectedRunRepository(database, [
    new PrimaryCronProjection(database),
  ]);
  const recoverySource = new LegacySequelizePrimaryRunRecoverySource(database);
  const completionReceiptJournal = new LegacySequelizeCompletionReceiptJournal(
    database,
  );
  const completionReceiptStore = new CompletionReceiptFileStore(
    DEFAULT_COMPLETION_RECEIPT_ROOT,
  );
  const completionReceipts = new PrimaryCompletionReceiptConsumer(
    completionReceiptStore,
    new PrimaryRunCompletionService(repository),
    {
      journal: completionReceiptJournal,
      quarantineRetentionMs: resources.receiptQuarantineRetentionMs,
    },
  );
  const startup = new PrimaryRunStartupSupervisor(
    new PrimaryRunStartupReconciler(
      repository,
      recoverySource,
      [new LocalProcessPersistedExecutionInspector()],
      {
        completionReceipts,
        completionReceiptJournal,
        receiptPublishGraceMs: resources.receiptPublishGraceMs,
      },
    ),
  );
  const completion = new PrimaryCompletionReceiptLifecycle(
    new PrimaryCompletionReceiptSupervisor(
      new PrimaryCompletionReceiptJournalScanner(
        completionReceiptJournal,
        completionReceiptStore,
        completionReceipts,
        {
          terminalMissingRetentionMs:
            resources.receiptTerminalMissingRetentionMs,
        },
      ),
    ),
    {
      intervalMs:
        options.completion?.intervalMs ?? resources.completion.intervalMs,
      initialDelayMs:
        options.completion?.initialDelayMs ??
        resources.completion.initialDelayMs,
      stopTimeoutMs:
        options.completion?.stopTimeoutMs ?? resources.completion.stopTimeoutMs,
      cycle: options.completion?.cycle ?? {
        pageSize: resources.completion.pageSize,
        maxPages: resources.completion.maxPages,
      },
      onCycle(summary) {
        Logger.info(
          `[runtime-completion] ${JSON.stringify({
            profile: resources.profile,
            pages: summary.pages,
            scanned: summary.scanned,
            applied: summary.applied,
            alreadyTerminal: summary.alreadyTerminal,
            quarantined: summary.quarantined,
            purgedQuarantines: summary.purgedQuarantines,
            expiredMissing: summary.expiredMissing,
            missing: summary.missing,
            cleanupPending: summary.cleanupPending,
            skipped: summary.skipped,
            ambiguous: summary.ambiguous,
            failed: summary.failed,
            stopReason: summary.stopReason,
            remaining: summary.remaining,
          })}`,
        );
      },
      onError() {
        Logger.error('[runtime-completion] cycle failed');
      },
    },
  );
  const cancellation = new PrimaryCancellationLifecycle(
    new PrimaryCancellationSupervisor(
      new PrimaryCancellationDispatcher(
        new LegacySequelizePrimaryCancellationSource(database),
        new LegacySequelizeCancellationDispatchRepository(database),
        [new LocalProcessPersistedExecutionController()],
        { owner: boundedOwner(options.owner ?? `http:${process.pid}`) },
      ),
    ),
    {
      intervalMs:
        options.cancellation?.intervalMs ?? resources.cancellation.intervalMs,
      initialDelayMs:
        options.cancellation?.initialDelayMs ??
        resources.cancellation.initialDelayMs,
      stopTimeoutMs:
        options.cancellation?.stopTimeoutMs ??
        resources.cancellation.stopTimeoutMs,
      cycle: options.cancellation?.cycle ?? {
        pageSize: resources.cancellation.pageSize,
        maxPages: resources.cancellation.maxPages,
      },
      onCycle(summary) {
        Logger.info(
          `[runtime-cancellation] ${JSON.stringify({
            pages: summary.pages,
            scanned: summary.scanned,
            claimed: summary.claimed,
            pending: summary.pending,
            failed: summary.failed,
            stopReason: summary.stopReason,
            remaining: summary.remaining,
          })}`,
        );
      },
      onError() {
        Logger.error('[runtime-cancellation] cycle failed');
      },
    },
  );
  const timeout = new PrimaryTimeoutLifecycle(
    new PrimaryTimeoutSupervisor(
      new PrimaryTimeoutRequester(
        new LegacySequelizePrimaryTimeoutSource(database),
        new RunCommandService(repository),
      ),
    ),
    {
      intervalMs: options.timeout?.intervalMs ?? resources.timeout.intervalMs,
      initialDelayMs:
        options.timeout?.initialDelayMs ?? resources.timeout.initialDelayMs,
      stopTimeoutMs:
        options.timeout?.stopTimeoutMs ?? resources.timeout.stopTimeoutMs,
      cycle: options.timeout?.cycle ?? {
        pageSize: resources.timeout.pageSize,
        maxPages: resources.timeout.maxPages,
      },
      onCycle(summary) {
        Logger.info(
          `[runtime-timeout] ${JSON.stringify({
            profile: resources.profile,
            pages: summary.pages,
            scanned: summary.scanned,
            accepted: summary.accepted,
            alreadyRequested: summary.alreadyRequested,
            alreadyTerminal: summary.alreadyTerminal,
            failed: summary.failed,
            stopReason: summary.stopReason,
            remaining: summary.remaining,
          })}`,
        );
      },
      onError() {
        Logger.error('[runtime-timeout] cycle failed');
      },
    },
  );

  return {
    router: new ManualPrimaryRuntime(
      repository,
      new LocalProcessExecutor({
        durableLauncherPath: DEFAULT_LOCAL_PROCESS_LAUNCHER_PATH,
      }),
      rollout,
      new LegacyManualPrimaryLogFiles(
        undefined,
        undefined,
        completionReceiptJournal,
      ),
      {
        orchestrator: { completionReceiptJournal },
      },
    ),
    reconcile: () => startup.run(options.recovery),
    startCompletion: () => completion.start(),
    stopCompletion: () => completion.stop(),
    startTimeout: () => timeout.start(),
    stopTimeout: () => timeout.stop(),
    startCancellation: () => cancellation.start(),
    stopCancellation: () => cancellation.stop(),
  };
}

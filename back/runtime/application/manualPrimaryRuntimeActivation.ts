import type { ManualPrimaryExecutionRouter } from '../compatibility/manualPrimaryExecutionBridge';
import type { RuntimeRolloutPolicy } from '../domain/runtimeRollout';
import type {
  RuntimeRolloutLoadAudit,
  RuntimeRolloutLoadResult,
} from '../ports/runtimeRolloutLoader';
import type { PrimaryCancellationStopResult } from './primaryCancellationLifecycle';
import type { PrimaryCompletionReceiptStopResult } from './primaryCompletionReceiptLifecycle';
import type { PrimaryRunStartupSummary } from './primaryRunStartupSupervisor';
import type { PrimaryTimeoutStopResult } from './primaryTimeoutLifecycle';

export type ManualPrimaryActivationState =
  | 'not_activated'
  | 'selected'
  | 'reconciled'
  | 'activated'
  | 'failed'
  | 'stopped';

export interface ManualPrimaryActivationAudit extends RuntimeRolloutLoadAudit {
  activation: ManualPrimaryActivationState;
  recovery?: {
    scanned: number;
    verifiedRunning: number;
    recoveredRunning: number;
    completedFromReceipt: number;
    quarantinedReceipts: number;
    publishGraceWaits: number;
    markedLost: number;
  };
}

export interface ManualPrimaryActivationStack {
  router: ManualPrimaryExecutionRouter;
  reconcile(): Promise<PrimaryRunStartupSummary>;
  startCompletion(): boolean;
  stopCompletion(): Promise<PrimaryCompletionReceiptStopResult>;
  startTimeout(): boolean;
  stopTimeout(): Promise<PrimaryTimeoutStopResult>;
  startCancellation(): boolean;
  stopCancellation(): Promise<PrimaryCancellationStopResult>;
}

export interface ManualPrimaryRuntimeActivationOptions {
  load(): Promise<RuntimeRolloutLoadResult>;
  create(policy: RuntimeRolloutPolicy): ManualPrimaryActivationStack;
  install(router: ManualPrimaryExecutionRouter): () => void;
  audit(record: ManualPrimaryActivationAudit): void | Promise<void>;
}

export interface ManualPrimaryRuntimeActivationResult {
  load: RuntimeRolloutLoadResult;
  active: boolean;
  recovery?: PrimaryRunStartupSummary;
  stop(): Promise<PrimaryCancellationStopResult>;
}

const NOOP_STOP = async (): Promise<PrimaryCancellationStopResult> => 'drained';

async function stopLifecycles(
  stack: ManualPrimaryActivationStack,
  started: { completion: boolean; timeout: boolean; cancellation: boolean },
): Promise<PrimaryCancellationStopResult> {
  let result: PrimaryCancellationStopResult = 'drained';
  let firstError: unknown;
  if (started.timeout) {
    try {
      if ((await stack.stopTimeout()) === 'timed_out') result = 'timed_out';
    } catch (error) {
      firstError = error;
    }
  }
  if (started.cancellation) {
    try {
      if ((await stack.stopCancellation()) === 'timed_out') {
        result = 'timed_out';
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  if (started.completion) {
    try {
      if ((await stack.stopCompletion()) === 'timed_out') {
        result = 'timed_out';
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
  return result;
}

function assertSafeRecovery(summary: PrimaryRunStartupSummary): void {
  if (
    summary.remaining ||
    summary.stopReason !== 'complete' ||
    summary.skipped > 0 ||
    summary.ambiguous > 0 ||
    summary.failed > 0
  ) {
    throw new Error('Primary startup reconciliation did not converge safely');
  }
}

function recoveryAudit(summary: PrimaryRunStartupSummary) {
  return {
    scanned: summary.scanned,
    verifiedRunning: summary.verifiedRunning,
    recoveredRunning: summary.recoveredRunning,
    completedFromReceipt: summary.completedFromReceipt,
    quarantinedReceipts: summary.quarantinedReceipts,
    publishGraceWaits: summary.publishGraceWaits,
    markedLost: summary.markedLost,
  };
}

export async function activateManualPrimaryRuntime(
  options: ManualPrimaryRuntimeActivationOptions,
): Promise<ManualPrimaryRuntimeActivationResult> {
  const load = await options.load();
  const shouldActivate =
    load.status === 'accepted' && load.policy.modeFor('manual') === 'primary';
  if (!shouldActivate) {
    await options.audit({ ...load.audit, activation: 'not_activated' });
    return { load, active: false, stop: NOOP_STOP };
  }

  let stack: ManualPrimaryActivationStack | undefined;
  let dispose: (() => void) | undefined;
  let completionStarted = false;
  let timeoutStarted = false;
  let cancellationStarted = false;
  try {
    await options.audit({ ...load.audit, activation: 'selected' });
    stack = options.create(load.policy);
    const recovery = await stack.reconcile();
    assertSafeRecovery(recovery);
    await options.audit({
      ...load.audit,
      activation: 'reconciled',
      recovery: recoveryAudit(recovery),
    });
    completionStarted = stack.startCompletion();
    if (!completionStarted) {
      throw new Error('Primary completion lifecycle did not start');
    }
    timeoutStarted = stack.startTimeout();
    if (!timeoutStarted) {
      throw new Error('Primary timeout lifecycle did not start');
    }
    cancellationStarted = stack.startCancellation();
    if (!cancellationStarted) {
      throw new Error('Primary cancellation lifecycle did not start');
    }
    dispose = options.install(stack.router);
    await options.audit({
      ...load.audit,
      activation: 'activated',
      recovery: recoveryAudit(recovery),
    });

    let stopped = false;
    return {
      load,
      active: true,
      recovery,
      async stop() {
        if (stopped) return 'drained';
        stopped = true;
        dispose?.();
        const result = await stopLifecycles(stack!, {
          completion: completionStarted,
          timeout: timeoutStarted,
          cancellation: cancellationStarted,
        });
        try {
          await options.audit({
            ...load.audit,
            activation: 'stopped',
            recovery: recoveryAudit(recovery),
          });
        } catch {
          // Cleanup must not be reversed by a diagnostic failure.
        }
        return result;
      },
    };
  } catch (error) {
    dispose?.();
    if (stack && (completionStarted || timeoutStarted || cancellationStarted)) {
      try {
        await stopLifecycles(stack, {
          completion: completionStarted,
          timeout: timeoutStarted,
          cancellation: cancellationStarted,
        });
      } catch {
        // Preserve the activation error after best-effort cleanup.
      }
    }
    try {
      await options.audit({ ...load.audit, activation: 'failed' });
    } catch {
      // Preserve the activation error while ownership remains uninstalled.
    }
    throw error;
  }
}

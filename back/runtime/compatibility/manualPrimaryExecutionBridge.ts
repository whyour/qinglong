import type { ExecutionOutcome } from '../domain/execution';

export interface ManualPrimaryCronSnapshot {
  id: number;
  name?: string;
  command: string;
  schedule?: string;
  extraSchedules: readonly string[];
  taskBefore?: string;
  taskAfter?: string;
  workDirectory?: string;
  logName?: string;
}

export interface ManualPrimaryStartInput {
  cron: ManualPrimaryCronSnapshot;
  acceptedAtMs: number;
}

export interface ManualPrimaryCompletion {
  runId: string;
  attemptId: string;
  outcome: ExecutionOutcome;
  exitCode?: number;
}

export interface ManualPrimaryStartedExecution {
  runId: string;
  attemptId: string;
  pid?: number;
  logPath: string;
  completion: Promise<ManualPrimaryCompletion>;
}

export interface ManualPrimaryStopResult {
  matched: number;
  failed: number;
}

export interface ManualPrimaryExecutionRouter {
  /** Immutable selection for new manual triggers; off/shadow return false. */
  ownsNewRuns(): boolean;
  start(input: ManualPrimaryStartInput): Promise<ManualPrimaryStartedExecution>;
  stopCron(
    cronId: number,
    requestedAtMs: number,
  ): Promise<ManualPrimaryStopResult>;
  stopAttempt(
    attemptId: string,
    requestedAtMs: number,
  ): Promise<ManualPrimaryStopResult>;
}

let triggerRouter: ManualPrimaryExecutionRouter | undefined;
const ownerRouters = new Map<ManualPrimaryExecutionRouter, number>();

/**
 * Returns the selected owner object so a concurrent config change cannot switch
 * owner between the decision and start calls.
 */
export function selectManualPrimaryExecutionRouter():
  | ManualPrimaryExecutionRouter
  | undefined {
  const selected = triggerRouter;
  if (!selected) return undefined;
  try {
    return selected.ownsNewRuns() ? selected : undefined;
  } catch {
    // Invalid/unavailable configuration is off before Runtime accepts a Run.
    return undefined;
  }
}

export async function stopManualPrimaryCron(
  cronId: number,
  requestedAtMs: number,
): Promise<ManualPrimaryStopResult> {
  return stopAcrossOwners((owner) => owner.stopCron(cronId, requestedAtMs));
}

export async function stopManualPrimaryAttempt(
  attemptId: string,
  requestedAtMs: number,
): Promise<ManualPrimaryStopResult> {
  return stopAcrossOwners((owner) =>
    owner.stopAttempt(attemptId, requestedAtMs),
  );
}

async function stopAcrossOwners(
  stop: (
    router: ManualPrimaryExecutionRouter,
  ) => Promise<ManualPrimaryStopResult>,
): Promise<ManualPrimaryStopResult> {
  const results = await Promise.allSettled([...ownerRouters.keys()].map(stop));
  let matched = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      matched += result.value.matched;
      failed += result.value.failed;
    } else {
      // Conservatively protect a possibly-owned execution from PID fallback.
      matched += 1;
      failed += 1;
    }
  }
  return { matched, failed };
}

/**
 * Installs one manifest-gated owner. Default boot has no router unless the
 * lightweight HTTP bootstrap accepts an explicit manual Primary manifest.
 */
export function installManualPrimaryExecutionRouter(
  next: ManualPrimaryExecutionRouter,
): () => void {
  const previous = triggerRouter;
  triggerRouter = next;
  ownerRouters.set(next, (ownerRouters.get(next) ?? 0) + 1);
  return () => {
    if (triggerRouter === next) triggerRouter = previous;
    const references = ownerRouters.get(next);
    if (references === 1) ownerRouters.delete(next);
    else if (references !== undefined) ownerRouters.set(next, references - 1);
  };
}

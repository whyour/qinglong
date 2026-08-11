import type {
  ExecutionOutcome,
  ExecutionOutputSink,
} from '../domain/execution';
import type { Executor } from '../ports/executor';
import type { RunRepository } from '../ports/runRepository';
import { buildLegacyCronExecutionSpec } from '../adapters/legacy/legacyCronExecutionSpec';
import { createLegacyTaskRevision } from '../compatibility/legacyTaskRevision';
import { createLegacyLogOutputRef } from '../compatibility/legacyLogOutputRef';
import type {
  ManualPrimaryCompletion,
  ManualPrimaryExecutionRouter,
  ManualPrimaryStartInput,
  ManualPrimaryStartedExecution,
  ManualPrimaryStopResult,
} from '../compatibility/manualPrimaryExecutionBridge';
import type { RuntimeRolloutPolicy } from '../domain/runtimeRollout';
import {
  PrimaryRunOrchestrator,
  type ActivePrimaryRun,
  type PrimaryRunClock,
  type PrimaryRunOrchestratorOptions,
} from './primaryRunOrchestrator';

export interface PreparedManualPrimaryLog {
  logPath: string;
  output: ExecutionOutputSink;
  completionCommitted?(attemptId: string): Promise<void>;
  close(): Promise<void>;
}

export interface ManualPrimaryLogFiles {
  prepare(input: ManualPrimaryStartInput): Promise<PreparedManualPrimaryLog>;
}

export interface ManualPrimaryRuntimeOptions {
  clock?: PrimaryRunClock;
  orchestrator?: PrimaryRunOrchestratorOptions;
}

interface ActiveManualExecution {
  cronId: number;
  attemptId: string;
  execution: ActivePrimaryRun;
}

interface PendingManualExecution {
  cronId: number;
  controller: AbortController;
}

export class ManualPrimaryOwnershipError extends Error {
  constructor() {
    super('Manual execution is not Runtime-owned');
    this.name = 'ManualPrimaryOwnershipError';
  }
}

/**
 * Process-local manual Primary owner. The active maps are bounded by actual
 * concurrent executions; durable restart/cross-worker ownership remains the
 * startup Reconciler and future supervisor's responsibility.
 */
export class ManualPrimaryRuntime implements ManualPrimaryExecutionRouter {
  private readonly orchestrator: PrimaryRunOrchestrator;
  private readonly clock: PrimaryRunClock;
  private readonly pending = new Map<symbol, PendingManualExecution>();
  private readonly active = new Map<string, ActiveManualExecution>();

  constructor(
    repository: RunRepository,
    executor: Executor,
    private readonly rollout: RuntimeRolloutPolicy,
    private readonly logs: ManualPrimaryLogFiles,
    options: ManualPrimaryRuntimeOptions = {},
  ) {
    this.clock = options.clock ?? { now: Date.now };
    this.orchestrator = new PrimaryRunOrchestrator(repository, executor, {
      ...options.orchestrator,
      clock: this.clock,
    });
  }

  ownsNewRuns(): boolean {
    return this.rollout.decide('manual').owner === 'runtime';
  }

  async start(
    input: ManualPrimaryStartInput,
  ): Promise<ManualPrimaryStartedExecution> {
    if (!this.ownsNewRuns()) throw new ManualPrimaryOwnershipError();
    const pendingId = Symbol('manual-primary-pending');
    const controller = new AbortController();
    this.pending.set(pendingId, { cronId: input.cron.id, controller });

    let prepared: PreparedManualPrimaryLog | undefined;
    try {
      prepared = await this.logs.prepare(input);
      const taskRevision = createLegacyTaskRevision({
        command: input.cron.command,
        ...(input.cron.schedule === undefined
          ? {}
          : { schedule: input.cron.schedule }),
        extraSchedules: input.cron.extraSchedules,
        ...(input.cron.taskBefore === undefined
          ? {}
          : { taskBefore: input.cron.taskBefore }),
        ...(input.cron.taskAfter === undefined
          ? {}
          : { taskAfter: input.cron.taskAfter }),
        ...(input.cron.workDirectory === undefined
          ? {}
          : { workDirectory: input.cron.workDirectory }),
        ...(input.cron.logName === undefined
          ? {}
          : { logName: input.cron.logName }),
      });
      const outputRef = createLegacyLogOutputRef(prepared.logPath);
      const active = await this.orchestrator.start({
        definition: {
          projectId: 'default',
          taskId: 'legacy-cron:' + input.cron.id,
          taskRevision,
          ...(input.cron.name === undefined
            ? {}
            : { taskName: input.cron.name }),
          legacyCronId: input.cron.id,
          triggerType: 'manual',
          executionOrigin: 'manual',
          triggeredBy: 'legacy:manual-api',
          outputRef,
          acceptedAtMs: input.acceptedAtMs,
          actor: { type: 'compatibility', id: 'legacy:manual-api' },
        },
        createSpec: (reference) =>
          buildLegacyCronExecutionSpec({
            runId: reference.run.id,
            attemptId: reference.attempt.id,
            projectId: reference.run.projectId,
            taskRevision: reference.run.taskRevision,
            cron: {
              id: input.cron.id,
              command: input.cron.command,
              ...(input.cron.taskBefore === undefined
                ? {}
                : { taskBefore: input.cron.taskBefore }),
              ...(input.cron.taskAfter === undefined
                ? {}
                : { taskAfter: input.cron.taskAfter }),
              ...(input.cron.workDirectory === undefined
                ? {}
                : { workDirectory: input.cron.workDirectory }),
              ...(input.cron.logName === undefined
                ? {}
                : { logName: input.cron.logName }),
            },
            realTime: true,
            realLogPath: prepared!.logPath,
            noDelay: true,
          }),
        context: {
          environment: {},
          signal: controller.signal,
          output: prepared.output,
        },
      });

      const entry: ActiveManualExecution = {
        cronId: input.cron.id,
        attemptId: active.attempt.id,
        execution: active,
      };
      this.active.set(active.run.id, entry);
      this.pending.delete(pendingId);
      const completion = this.completion(active, prepared).finally(() => {
        if (this.active.get(active.run.id) === entry) {
          this.active.delete(active.run.id);
        }
      });
      void completion.catch(() => undefined);
      return {
        runId: active.run.id,
        attemptId: active.attempt.id,
        ...(active.handle.pid === undefined ? {} : { pid: active.handle.pid }),
        logPath: prepared.logPath,
        completion,
      };
    } catch (error) {
      if (prepared) await prepared.close().catch(() => undefined);
      throw error;
    } finally {
      this.pending.delete(pendingId);
    }
  }

  async stopCron(
    cronId: number,
    requestedAtMs: number,
  ): Promise<ManualPrimaryStopResult> {
    let matched = 0;
    for (const pending of this.pending.values()) {
      if (pending.cronId !== cronId) continue;
      matched += 1;
      pending.controller.abort();
    }
    const executions = [...this.active.values()].filter(
      (entry) => entry.cronId === cronId,
    );
    matched += executions.length;
    const failed = await this.stopActive(executions, requestedAtMs);
    return { matched, failed };
  }

  async stopAttempt(
    attemptId: string,
    requestedAtMs: number,
  ): Promise<ManualPrimaryStopResult> {
    const execution = [...this.active.values()].find(
      (entry) => entry.attemptId === attemptId,
    );
    if (!execution) return { matched: 0, failed: 0 };
    const failed = await this.stopActive([execution], requestedAtMs);
    return { matched: 1, failed };
  }

  private async stopActive(
    executions: readonly ActiveManualExecution[],
    requestedAtMs: number,
  ): Promise<number> {
    const results = await Promise.allSettled(
      executions.map((entry) =>
        entry.execution.cancel({ kind: 'user', requestedAtMs }),
      ),
    );
    return results.filter((result) => result.status === 'rejected').length;
  }

  private async completion(
    active: ActivePrimaryRun,
    prepared: PreparedManualPrimaryLog,
  ): Promise<ManualPrimaryCompletion> {
    try {
      const completed = await active.completion;
      await prepared
        .completionCommitted?.(completed.attempt.id)
        .catch(() => undefined);
      const result = completed.result;
      return {
        runId: completed.run.id,
        attemptId: completed.attempt.id,
        outcome: result.outcome as ExecutionOutcome,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      };
    } finally {
      await prepared.close().catch(() => undefined);
    }
  }
}

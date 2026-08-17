import type { Crontab } from '../../data/cron';
import type { LegacyExecutionObservation } from '../ports/legacyExecutionObserver';
import { observeLegacyShellExecutionCallback } from './legacyExecutionBridge';
import { createLegacyTaskRevision } from './legacyTaskRevision';

const EXECUTION_ID_PATTERN =
  /^legacy-system:([1-9][0-9]{0,12}):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

export interface LegacyScheduledSystemCallbackInput {
  executionId: string;
  phase: 'running' | 'finished';
  observedAtMs: number;
  pid?: number;
  logPath?: string;
  exitCode?: number;
}

export function decorateScheduledSystemCronCommand(
  command: string,
  systemScheduler: boolean,
): string {
  return systemScheduler
    ? `QL_EXECUTION_ORIGIN=scheduled_system ${command}`
    : command;
}

export function parseLegacyScheduledSystemExecutionId(
  value: string,
): { requestId: string; acceptedAtMs: number } | undefined {
  const match = EXECUTION_ID_PATTERN.exec(value);
  if (!match) return undefined;
  const acceptedAtMs = Number(match[1]) * 1000;
  if (!Number.isSafeInteger(acceptedAtMs) || acceptedAtMs < 1) return undefined;
  return Object.freeze({ requestId: value, acceptedAtMs });
}

export function observeLegacyScheduledSystemExecution(
  cron: Crontab,
  input: LegacyScheduledSystemCallbackInput,
): LegacyExecutionObservation | undefined {
  const identity = parseLegacyScheduledSystemExecutionId(input.executionId);
  if (
    !identity ||
    cron.id === undefined ||
    !Number.isSafeInteger(input.observedAtMs) ||
    input.observedAtMs < identity.acceptedAtMs
  ) {
    return undefined;
  }
  return observeLegacyShellExecutionCallback(
    () => ({
      origin: 'scheduled_system',
      projectId: 'default',
      taskId: `legacy-cron:${cron.id}`,
      taskRevision: createLegacyTaskRevision({
        command: cron.command,
        ...(cron.schedule === undefined ? {} : { schedule: cron.schedule }),
        extraSchedules:
          cron.extra_schedules?.map((item) => item.schedule) ?? [],
        ...(cron.task_before === undefined
          ? {}
          : { taskBefore: cron.task_before }),
        ...(cron.task_after === undefined
          ? {}
          : { taskAfter: cron.task_after }),
        ...(cron.work_dir === undefined
          ? {}
          : { workDirectory: cron.work_dir }),
        ...(cron.log_name === undefined ? {} : { logName: cron.log_name }),
      }),
      ...(cron.name === undefined ? {} : { taskName: cron.name }),
      legacyCronId: cron.id,
      triggerType: 'scheduled_system',
      triggeredBy: 'legacy:system-crond',
      requestId: identity.requestId,
      scheduledForMs: identity.acceptedAtMs,
      acceptedAtMs: identity.acceptedAtMs,
    }),
    {
      phase: input.phase,
      atMs: input.observedAtMs,
      ...(input.pid === undefined ? {} : { pid: input.pid }),
      ...(input.logPath === undefined ? {} : { logPath: input.logPath }),
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    },
  );
}

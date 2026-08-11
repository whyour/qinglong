import type {
  ExecutionResourcePolicy,
  ExecutionSpec,
} from '../../domain/execution';
import { InvalidExecutionSpecError } from '../../domain/executorErrors';

export interface LegacyCronSnapshot {
  id: number;
  command: string;
  taskBefore?: string;
  taskAfter?: string;
  workDirectory?: string;
  logName?: string;
}

export interface LegacyCronExecutionInput {
  runId: string;
  attemptId: string;
  projectId: string;
  taskRevision: string;
  cron: LegacyCronSnapshot;
  realTime: boolean;
  realLogPath?: string;
  noDelay?: boolean;
  timeoutMs?: number;
  terminationGraceMs?: number;
  resourcePolicy?: ExecutionResourcePolicy;
}

export const DEFAULT_LEGACY_TERMINATION_GRACE_MS = 10_000;

function quoteShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeHook(value: string): string {
  return value.replace(/;? *\r?\n/g, ';').trim();
}

function assignment(name: string, value: string | number | boolean): string {
  return `${name}=${quoteShellValue(String(value))}`;
}

function legacyTaskCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new InvalidExecutionSpecError(
      'Legacy Cron command must not be empty',
    );
  }
  if (trimmed.startsWith('task ') || trimmed.startsWith('ql ')) return trimmed;
  return `task ${trimmed}`;
}

export function buildLegacyCronExecutionSpec(
  input: LegacyCronExecutionInput,
): ExecutionSpec {
  if (!Number.isSafeInteger(input.cron.id) || input.cron.id < 1) {
    throw new InvalidExecutionSpecError(
      'Legacy Cron id must be a positive safe integer',
    );
  }

  const variables: string[] = [];
  if (input.realLogPath) {
    variables.push(assignment('real_log_path', input.realLogPath));
  }
  if (input.noDelay) variables.push(assignment('no_delay', true));
  variables.push(assignment('real_time', input.realTime));
  variables.push(assignment('no_tee', true));
  variables.push(assignment('ID', input.cron.id));
  if (input.cron.logName) {
    variables.push(assignment('log_name', input.cron.logName));
  }
  if (input.cron.taskBefore) {
    variables.push(
      assignment('task_before', normalizeHook(input.cron.taskBefore)),
    );
  }
  if (input.cron.taskAfter) {
    variables.push(
      assignment('task_after', normalizeHook(input.cron.taskAfter)),
    );
  }
  if (input.cron.workDirectory) {
    variables.push(assignment('work_dir', input.cron.workDirectory));
  }

  return {
    runId: input.runId,
    attemptId: input.attemptId,
    projectId: input.projectId,
    taskId: `legacy-cron:${input.cron.id}`,
    taskRevision: input.taskRevision,
    command: {
      kind: 'shell',
      command: `${variables.join(' ')} ${legacyTaskCommand(
        input.cron.command,
      )}`,
      shell: '/bin/bash',
    },
    environmentPolicy: 'inherit',
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    terminationGraceMs:
      input.terminationGraceMs ?? DEFAULT_LEGACY_TERMINATION_GRACE_MS,
    ...(input.resourcePolicy === undefined
      ? {}
      : { resourcePolicy: input.resourcePolicy }),
  };
}

import type { Crontab } from '../../data/cron';
import type { ICron } from '../../protos/cron';
import { execSync } from 'child_process';
import { ScheduleType } from '../../interface/schedule';
import { TASK_PREFIX, QL_PREFIX } from '../../config/const';
import { shellQuote } from '../../shared/shellQuote';

export type SchedulerMode = 'system' | 'node';

// Adapt persisted task definitions without reserving or starting an execution.
export function isNodeCron(cron: Crontab) {
  const { schedule, extra_schedules } = cron;
  const fields = schedule?.trim().split(/\s+/) || [];
  // System crontab only receives portable numeric five-field expressions.
  // Extended syntax, macros and legacy shorthand use the Node scheduler.
  return (
    Boolean(
      cron.max_queue_wait || cron.catchup_seconds || cron.skip_if_pending,
    ) ||
    fields.length !== 5 ||
    /[^\d\s*,/\-]/.test(schedule || '') ||
    Boolean(extra_schedules?.length) ||
    // BusyBox treats N/step as a single value and doesn't support Sunday=7.
    fields.some((field) =>
      field.split(',').some((part) => /^\d+\//.test(part)),
    ) ||
    fields[4].includes('7') ||
    // BusyBox steps DOM from zero; its full-range day/week wildcard
    // handling also differs from the legacy Node parser's OR semantics.
    fields[2].includes('/') ||
    (fields[2] !== '*' && fields[4] !== '*')
  );
}

export function schedulerMode(): SchedulerMode {
  const env = process.env.QL_SCHEDULER;
  if (env === 'system') return 'system';
  if (env === 'node') return 'node';
  try {
    execSync('which crond', { stdio: 'ignore' });
    return 'system';
  } catch {
    return 'node';
  }
}

export function shouldUseCronClient(cron: Crontab, mode: SchedulerMode) {
  if (mode === 'node') {
    return !isSpecialSchedule(cron.schedule);
  }
  return isNodeCron(cron) && !isSpecialSchedule(cron.schedule);
}

export function isOnceSchedule(schedule?: string) {
  return schedule?.startsWith(ScheduleType.ONCE);
}

export function isBootSchedule(schedule?: string) {
  return schedule?.startsWith(ScheduleType.BOOT);
}

export function isSpecialSchedule(schedule?: string) {
  return isOnceSchedule(schedule) || isBootSchedule(schedule);
}

export function shellValue(value: string) {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : shellQuote(value);
}

// Manual, Node and system-crond launches share the existing shell wire format.
export function makeCommand(tab: Crontab, realTime?: boolean) {
  let command = tab.command.trim();
  if (!command.startsWith(TASK_PREFIX) && !command.startsWith(QL_PREFIX)) {
    command = `${TASK_PREFIX}${tab.command}`;
  }
  let commandVariable = `${
    tab.recovery_from ? `QL_CRON_REVISION=${Number(tab.recovery_from)} ` : ''
  }real_time=${Boolean(realTime)} no_tee=true ID=${tab.id} `;
  // Only include log_name if it has a truthy value to avoid passing null/undefined to shell
  if (tab.log_name) {
    commandVariable += `log_name=${shellValue(tab.log_name)} `;
  }
  if (tab.task_before) {
    commandVariable += `task_before='${tab.task_before
      .replace(/'/g, "'\\''")
      .replace(/;? *\n/g, ';')
      .trim()}' `;
  }
  if (tab.task_after) {
    commandVariable += `task_after='${tab.task_after
      .replace(/'/g, "'\\''")
      .replace(/;? *\n/g, ';')
      .trim()}' `;
  }
  if (tab.work_dir) {
    commandVariable += `work_dir='${tab.work_dir.replace(/'/g, "'\\''")}' `;
  }

  const crontab_job_string = `${commandVariable}${command}`;
  return crontab_job_string;
}

export function nodeCron(doc: Crontab, command: string): ICron {
  return {
    name: doc.name || '',
    id: String(doc.id),
    schedule: doc.schedule!,
    command,
    extra_schedules: doc.extra_schedules || [],
    max_queue_wait: doc.max_queue_wait,
    skip_if_pending: Boolean(doc.skip_if_pending),
    catchup_seconds: doc.catchup_seconds,
    recovery_from: doc.recovery_from,
  };
}

import { t } from './i18n';
import { spawn } from 'cross-spawn';
import taskLimit from './pLimit';
import Logger from '../loaders/logger';
import { ICron } from '../protos/cron';
import { CrontabModel, CrontabStatus } from '../data/cron';
import { observeChildProcess, asError } from './childProcess';

export function runCron(
  cmd: string,
  cron: ICron,
  isCurrent: () => boolean = () => true,
): Promise<number | void> {
  const execute = async () => {
    try {
      if (!isCurrent()) return;
      // A single-instance trigger must not interrupt work already in progress.
      try {
        const existingCron = await CrontabModel.findOne({
          where: { id: Number(cron.id) },
        });

        // A mutation may commit while this queued run is reading the database.
        if (!isCurrent() || !existingCron || existingCron.isDisabled) return;

        // Default to single instance mode (0) for backward compatibility
        const allowSingleInstances =
          existingCron?.allow_multiple_instances === 0;

        if (
          allowSingleInstances &&
          existingCron &&
          existingCron.pid &&
          (existingCron.status === CrontabStatus.running ||
            existingCron.status === CrontabStatus.queued)
        ) {
          Logger.info(
            '[schedule][Skip active single-instance task] Task ID: %s, PID: %s',
            cron.id,
            existingCron.pid,
          );
          return;
        }
      } catch (error) {
        Logger.error(
          t('[schedule][检查已运行任务失败] 任务ID: %s, 错误: %s'),
          cron.id,
          error,
        );
        throw error;
      }

      // Invalidation can happen during the asynchronous database check.
      if (!isCurrent()) return;
      Logger.info(
        t('[schedule][开始执行任务] 参数 %s'),
        JSON.stringify({
          ...cron,
          command: cmd,
        }),
      );
      const cp = spawn(cmd, { shell: '/bin/bash' });

      const { completed } = observeChildProcess(cp, {
        onStderr: async (message) => {
          Logger.info(
            t('[schedule][任务标准错误] 命令: %s, 信息: %s'),
            cmd,
            message,
          );
        },
      });
      const result = await completed;
      if (result.error) {
        Logger.error(
          t('[schedule][执行任务失败] 命令: %s, 错误: %s'),
          cmd,
          result.error.message,
        );
      }
      Logger.info(
        t('[schedule][执行任务结束] 任务ID: %s, 退出码: %j'),
        cron.id,
        result.code,
      );
      return { ...cron, command: cmd, pid: cp.pid, ...result } as any;
    } catch (error) {
      Logger.error(
        t('[schedule][创建任务失败] 命令: %s, 错误: %s'),
        cmd,
        asError(error).message,
      );
    } finally {
      taskLimit.removeQueuedCron(cron.id, execute);
    }
  };
  return taskLimit.runWithCronLimit(cron, execute, undefined, isCurrent);
}

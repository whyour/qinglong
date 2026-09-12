import { spawn } from 'cross-spawn';
import taskLimit from './pLimit';
import Logger from '../loaders/logger';
import { ICron } from '../protos/cron';
import { CrontabModel, CrontabStatus } from '../data/cron';
import { killTask } from '../config/util';
import { RunningInstanceModel, InstanceStatus } from '../data/runningInstance';
import dayjs from 'dayjs';
import { observeChildProcess, asError } from './childProcess';

export function runCron(cmd: string, cron: ICron): Promise<number | void> {
  return taskLimit.runWithCronLimit(cron, async () => {
    try {
      // Check if the cron is already running and stop it (only if multiple instances are not allowed)
      try {
        const existingCron = await CrontabModel.findOne({
          where: { id: Number(cron.id) },
        });

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
            `[schedule][停止已运行任务] 任务ID: ${cron.id}, PID: ${existingCron.pid}`,
          );
          await killTask(existingCron.pid);
          // Mark old running instances as stopped
          const stoppedAt = dayjs().unix();
          await RunningInstanceModel.update(
            { status: InstanceStatus.stopped, finished_at: stoppedAt },
            {
              where: {
                cron_id: Number(cron.id),
                status: InstanceStatus.running,
              },
            },
          );
          // Update the status to idle after killing
          await CrontabModel.update(
            { status: CrontabStatus.idle, pid: undefined },
            { where: { id: Number(cron.id) } },
          );
        }
      } catch (error) {
        Logger.error(
          `[schedule][检查已运行任务失败] 任务ID: ${cron.id}, 错误: ${error}`,
        );
      }

      Logger.info(
        `[schedule][开始执行任务] 参数 ${JSON.stringify({
          ...cron,
          command: cmd,
        })}`,
      );
      const cp = spawn(cmd, { shell: '/bin/bash' });

      const { completed } = observeChildProcess(cp, {
        onStderr: async (message) => {
          Logger.info(
            '[schedule][任务标准错误] 命令: %s, 信息: %s',
            cmd,
            message,
          );
        },
      });
      const result = await completed;
      if (result.error) {
        Logger.error(
          '[schedule][执行任务失败] 命令: %s, 错误: %s',
          cmd,
          result.error.message,
        );
      }
      Logger.info(
        '[schedule][执行任务结束] 任务ID: %s, 退出码: %j',
        cron.id,
        result.code,
      );
      return { ...cron, command: cmd, pid: cp.pid, ...result } as any;
    } catch (error) {
      Logger.error(
        '[schedule][创建任务失败] 命令: %s, 错误: %s',
        cmd,
        asError(error).message,
      );
    } finally {
      taskLimit.removeQueuedCron(cron.id);
    }
  });
}

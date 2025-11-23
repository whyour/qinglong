import { spawn } from 'cross-spawn';
import taskLimit from './pLimit';
import Logger from '../loaders/logger';
import { ICron } from '../protos/cron';
import { CrontabModel, CrontabStatus } from '../data/cron';
import { killTask } from '../config/util';

export function runCron(cmd: string, cron: ICron): Promise<number | void> {
  return taskLimit.runWithCronLimit(cron, () => {
    return new Promise(async (resolve: any) => {
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

      cp.stderr.on('data', (data) => {
        Logger.info(
          '[schedule][执行任务失败] 命令: %s, 错误信息: %j',
          cmd,
          data.toString(),
        );
      });
      cp.on('error', (err) => {
        Logger.error(
          '[schedule][创建任务失败] 命令: %s, 错误信息: %j',
          cmd,
          err,
        );
      });

      cp.on('exit', async (code) => {
        taskLimit.removeQueuedCron(cron.id);
        Logger.info(
          '[schedule][执行任务结束] 参数: %s, 退出码: %j',
          JSON.stringify({
            ...cron,
            command: cmd,
          }),
          code,
        );
        resolve({ ...cron, command: cmd, pid: cp.pid, code });
      });
    });
  });
}

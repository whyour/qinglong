import { spawn } from 'cross-spawn';
import taskLimit from './pLimit';
import Logger from '../loaders/logger';
import { ICron } from '../protos/cron';

export function runCron(cmd: string, cron: ICron): Promise<number | void> {
  return taskLimit.runWithCronLimit(cron, () => {
    return new Promise(async (resolve: any) => {
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

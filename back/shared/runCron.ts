import { spawn } from 'cross-spawn';
import taskLimit from './pLimit';
import Logger from '../loaders/logger';

export function runCron(cmd: string, options?: { schedule: string; extraSchedules: Array<{ schedule: string }>; name: string }): Promise<number | void> {
  return taskLimit.runWithCronLimit(() => {
    return new Promise(async (resolve: any) => {
      Logger.info(`[schedule][开始执行任务] 参数 ${JSON.stringify({ ...options, command: cmd })}`);
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
        resolve({ ...options, command: cmd, pid: cp.pid, code });
      });
    });
  });
}

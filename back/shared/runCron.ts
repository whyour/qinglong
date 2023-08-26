import { spawn } from 'cross-spawn';
import taskLimit from './pLimit';
import Logger from '../loaders/logger';

export function runCron(cmd: string): Promise<number> {
  return taskLimit.runWithCpuLimit(() => {
    return new Promise(async (resolve: any) => {
      Logger.info(`[schedule][开始执行任务] 运行命令: ${cmd}`);

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

      cp.on('close', async (code) => {
        Logger.info(`[schedule][任务退出] ${cmd} 进程id: ${cp.pid} 退出, 退出码 ${code}`);
        resolve();
      });
    });
  });
}

import { Service, Inject } from 'typedi';
import winston from 'winston';
import path, { join } from 'path';
import SockService from './sock';
import CronService from './cron';
import ScheduleService, { TaskCallbacks } from './schedule';
import config from '../config';
import { TASK_COMMAND } from '../config/const';
import { getFileContentByName, getPid, killTask, rmPath } from '../config/util';
import taskLimit from '../shared/pLimit';

@Service()
export default class ScriptService {
  constructor(
    @Inject('logger') private logger: winston.Logger,
    private sockService: SockService,
    private cronService: CronService,
    private scheduleService: ScheduleService,
  ) {}

  private taskCallbacks(filePath: string): TaskCallbacks {
    return {
      onEnd: async (cp, endTime, diff) => {
        await rmPath(filePath);
      },
      onError: async (message: string) => {
        this.sockService.sendMessage({
          type: 'manuallyRunScript',
          message,
        });
      },
      onLog: async (message: string) => {
        this.sockService.sendMessage({
          type: 'manuallyRunScript',
          message,
        });
      },
    };
  }

  public async runScript(filePath: string) {
    const relativePath = path.relative(config.scriptPath, filePath);
    const command = `${TASK_COMMAND} ${relativePath} now`;
    const pid = await this.scheduleService.runTask(
      `real_time=true ${command}`,
      this.taskCallbacks(filePath),
      { command, id: relativePath.replace(/ /g, '-'), runOrigin: 'script' },
      'start',
    );

    return { code: 200, data: pid };
  }

  public async stopScript(filePath: string, pid: number) {
    if (!pid) {
      const relativePath = path.relative(config.scriptPath, filePath);
      taskLimit.removeQueuedCron(relativePath.replace(/ /g, '-'));
      pid = (await getPid(`${TASK_COMMAND} ${relativePath} now`)) as number;
    }
    try {
      await killTask(pid);
    } catch (error) {}

    return { code: 200 };
  }

  public checkFilePath(filePath: string, fileName: string) {
    const finalPath = path.resolve(config.scriptPath, filePath, fileName);
    return finalPath.startsWith(config.scriptPath) ? finalPath : '';
  }

  public async getFile(filePath: string, fileName: string) {
    const finalPath = this.checkFilePath(filePath, fileName);

    if (!finalPath) {
      return '';
    }

    const content = await getFileContentByName(finalPath);
    return content;
  }
}

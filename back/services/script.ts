import { Service, Inject } from 'typedi';
import winston from 'winston';
import fs from 'fs';
import path from 'path';
import SockService from './sock';
import CronService from './cron';
import ScheduleService, { TaskCallbacks } from './schedule';
import config from '../config';
import { LOG_END_SYMBOL } from '../config/const';
import { getPid, killTask } from '../config/util';

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
        try {
          fs.unlinkSync(filePath);
        } catch (error) {}
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
    const command = `task -l ${relativePath} now`;
    const pid = this.scheduleService.runTask(
      command,
      this.taskCallbacks(filePath),
    );

    return { code: 200, data: pid };
  }

  public async stopScript(filePath: string, pid: number) {
    let str = '';
    if (!pid) {
      const relativePath = path.relative(config.scriptPath, filePath);
      pid = await getPid(`task -l ${relativePath} now`);
    }
    try {
      await killTask(pid);
    } catch (error) {}

    this.sockService.sendMessage({
      type: 'manuallyRunScript',
      message: `${str}\n## 执行结束...  ${new Date()
        .toLocaleString('zh', { hour12: false })
        .replace(' 24:', ' 00:')}${LOG_END_SYMBOL}`,
    });

    return { code: 200 };
  }
}

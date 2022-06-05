import { Service, Inject } from 'typedi';
import winston from 'winston';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import SockService from './sock';
import CronService from './cron';
import ScheduleService, { TaskCallbacks } from './schedule';

@Service()
export default class ScriptService {
  constructor(
    @Inject('logger') private logger: winston.Logger,
    private sockService: SockService,
    private cronService: CronService,
    private scheduleService: ScheduleService,
  ) {}

  private taskCallbacks(): TaskCallbacks {
    return {
      onEnd: async (cp, endTime, diff) => {
        this.sockService.sendMessage({
          type: 'manuallyRunScript',
          message: `\n## 执行结束... ${endTime.format(
            'YYYY-MM-DD HH:mm:ss',
          )}  耗时 ${diff} 秒`,
        });
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
    const command = `task -l ${filePath} now`;
    this.scheduleService.runTask(command, this.taskCallbacks());

    return { code: 200 };
  }

  public async stopScript(path: string) {
    const err = await this.cronService.killTask(`task -l ${path} now`);
    const str = err ? `\n${err}` : '';
    this.sockService.sendMessage({
      type: 'manuallyRunScript',
      message: `${str}\n## 执行结束...  ${new Date()
        .toLocaleString('zh', { hour12: false })
        .replace(' 24:', ' 00:')} `,
    });

    return { code: 200 };
  }
}

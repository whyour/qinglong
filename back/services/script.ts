import { Service, Inject } from 'typedi';
import winston from 'winston';
import { spawn } from 'child_process';
import SockService from './sock';
import CronService from './cron';

@Service()
export default class ScriptService {
  constructor(
    @Inject('logger') private logger: winston.Logger,
    private sockService: SockService,
    private cronService: CronService,
  ) {}

  public async runScript(path: string) {
    const cp = spawn(`task -l ${path} now`, { shell: '/bin/bash' });

    cp.stdout.on('data', (data) => {
      this.sockService.sendMessage({
        type: 'manuallyRunScript',
        message: data.toString(),
      });
    });

    cp.stderr.on('data', (data) => {
      this.sockService.sendMessage({
        type: 'manuallyRunScript',
        message: data.toString(),
      });
    });

    cp.on('error', (err) => {
      this.sockService.sendMessage({
        type: 'manuallyRunScript',
        message: JSON.stringify(err),
      });
    });

    cp.on('close', (err) => {
      this.sockService.sendMessage({
        type: 'manuallyRunScript',
        message: `执行结束`,
      });
    });

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

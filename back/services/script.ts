import { Service, Inject } from 'typedi';
import winston from 'winston';
import { spawn } from 'child_process';
import SockService from './sock';

@Service()
export default class ScriptService {
  constructor(
    @Inject('logger') private logger: winston.Logger,
    private sockService: SockService,
  ) {}

  public async runScript(path: string) {
    const cp = spawn(`task -l ${path} now`, { shell: '/bin/bash' });

    this.sockService.sendMessage({
      type: 'manuallyRunScript',
      message: `开始执行脚本`,
    });
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

    return { code: 200 };
  }
}

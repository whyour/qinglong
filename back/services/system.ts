import { Response } from 'express';
import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import {
  AuthDataType,
  AuthInfo,
  SystemInstance,
  SystemModel,
  SystemModelInfo,
} from '../data/system';
import { NotificationInfo } from '../data/notify';
import NotificationService from './notify';
import ScheduleService, { TaskCallbacks } from './schedule';
import { spawn } from 'cross-spawn';
import SockService from './sock';
import got from 'got';
import {
  getPid,
  killTask,
  parseContentVersion,
  parseVersion,
  promiseExec,
  readDirs,
} from '../config/util';
import { TASK_COMMAND } from '../config/const';
import taskLimit from '../shared/pLimit';
import tar from 'tar';
import path from 'path';
import fs from 'fs';
import sum from 'lodash/sum';

@Service()
export default class SystemService {
  @Inject((type) => NotificationService)
  private notificationService!: NotificationService;

  constructor(
    @Inject('logger') private logger: winston.Logger,
    private scheduleService: ScheduleService,
    private sockService: SockService,
  ) {}

  public async getSystemConfig() {
    const doc = await this.getDb({ type: AuthDataType.systemConfig });
    return doc || ({} as SystemInstance);
  }

  private async updateAuthDb(payload: AuthInfo): Promise<SystemInstance> {
    await SystemModel.upsert({ ...payload });
    const doc = await this.getDb({ type: payload.type });
    return doc;
  }

  public async getDb(query: any): Promise<SystemInstance> {
    const doc: any = await SystemModel.findOne({ where: { ...query } });
    return doc && doc.get({ plain: true });
  }

  public async updateNotificationMode(notificationInfo: NotificationInfo) {
    const code = Math.random().toString().slice(-6);
    const isSuccess = await this.notificationService.testNotify(
      notificationInfo,
      '青龙',
      `【蛟龙】测试通知 https://t.me/jiao_long`,
    );
    if (isSuccess) {
      const result = await this.updateAuthDb({
        type: AuthDataType.notification,
        info: { ...notificationInfo },
      });
      return { code: 200, data: { ...result, code } };
    } else {
      return { code: 400, message: '通知发送失败，请检查参数' };
    }
  }

  public async updateLogRemoveFrequency(info: SystemModelInfo) {
    const oDoc = await this.getSystemConfig();
    const result = await this.updateAuthDb({
      ...oDoc,
      info: { ...oDoc.info, ...info },
    });
    const cron = {
      id: result.id || NaN,
      name: '删除日志',
      command: `ql rmlog ${info.logRemoveFrequency}`,
    };
    if (oDoc.info?.logRemoveFrequency) {
      await this.scheduleService.cancelIntervalTask(cron);
    }
    if (info.logRemoveFrequency && info.logRemoveFrequency > 0) {
      this.scheduleService.createIntervalTask(cron, {
        days: info.logRemoveFrequency,
      });
    }
    return { code: 200, data: info };
  }

  public async updateCronConcurrency(info: SystemModelInfo) {
    const oDoc = await this.getSystemConfig();
    await this.updateAuthDb({
      ...oDoc,
      info: { ...oDoc.info, ...info },
    });
    if (info.cronConcurrency) {
      await taskLimit.setCustomLimit(info.cronConcurrency);
    }
    return { code: 200, data: info };
  }

  public async updateDependenceProxy(info: SystemModelInfo) {
    const oDoc = await this.getSystemConfig();
    await this.updateAuthDb({
      ...oDoc,
      info: { ...oDoc.info, ...info },
    });
    if (info.dependenceProxy) {
      await fs.promises.writeFile(
        config.dependenceProxyFile,
        `export http_proxy="${info.dependenceProxy}"\nexport https_proxy="${info.dependenceProxy}"`,
      );
    } else {
      await fs.promises.rm(config.dependenceProxyFile);
    }
    return { code: 200, data: info };
  }

  public async updateNodeMirror(info: SystemModelInfo, res: Response) {
    const oDoc = await this.getSystemConfig();
    await this.updateAuthDb({
      ...oDoc,
      info: { ...oDoc.info, ...info },
    });
    let cmd = 'pnpm config delete registry';
    if (info.nodeMirror) {
      cmd = `pnpm config set registry ${info.nodeMirror}`;
    }
    const command = `cd && ${cmd} && pnpm i -g`;
    this.scheduleService.runTask(
      command,
      {
        onStart: async (cp) => {
          res.setHeader('QL-Task-Pid', `${cp.pid}`);
          res.end();
        },
        onEnd: async () => {
          this.sockService.sendMessage({
            type: 'updateNodeMirror',
            message: 'update node mirror end',
          });
        },
        onError: async (message: string) => {
          this.sockService.sendMessage({ type: 'updateNodeMirror', message });
        },
        onLog: async (message: string) => {
          this.sockService.sendMessage({ type: 'updateNodeMirror', message });
        },
      },
      {
        command,
      },
    );
  }

  public async updatePythonMirror(info: SystemModelInfo) {
    const oDoc = await this.getSystemConfig();
    await this.updateAuthDb({
      ...oDoc,
      info: { ...oDoc.info, ...info },
    });
    let cmd = 'pip config unset global.index-url';
    if (info.pythonMirror) {
      cmd = `pip3 config set global.index-url ${info.pythonMirror}`;
    }
    await promiseExec(cmd);
    return { code: 200, data: info };
  }

  public async updateLinuxMirror(info: SystemModelInfo, res: Response) {
    const oDoc = await this.getSystemConfig();
    await this.updateAuthDb({
      ...oDoc,
      info: { ...oDoc.info, ...info },
    });
    let targetDomain = 'dl-cdn.alpinelinux.org';
    if (info.linuxMirror) {
      targetDomain = info.linuxMirror;
    }
    const command = `sed -i 's/${
      oDoc.info?.linuxMirror || 'dl-cdn.alpinelinux.org'
    }/${targetDomain}/g' /etc/apk/repositories && apk update -f`;

    this.scheduleService.runTask(
      command,
      {
        onStart: async (cp) => {
          res.setHeader('QL-Task-Pid', `${cp.pid}`);
          res.end();
        },
        onEnd: async () => {
          this.sockService.sendMessage({
            type: 'updateLinuxMirror',
            message: 'update linux mirror end',
          });
        },
        onError: async (message: string) => {
          this.sockService.sendMessage({ type: 'updateLinuxMirror', message });
        },
        onLog: async (message: string) => {
          this.sockService.sendMessage({ type: 'updateLinuxMirror', message });
        },
      },
      {
        command,
      },
    );
  }

  public async checkUpdate() {
    try {
      const currentVersionContent = await parseVersion(config.versionFile);

      let lastVersionContent;
      try {
        const result = await got.get(
          `${config.lastVersionFile}?t=${Date.now()}`,
          {
            timeout: 30000,
          },
        );
        lastVersionContent = await parseContentVersion(result.body);
      } catch (error) {}

      if (!lastVersionContent) {
        lastVersionContent = currentVersionContent;
      }

      return {
        code: 200,
        data: {
          hasNewVersion: this.checkHasNewVersion(
            currentVersionContent.version,
            lastVersionContent.version,
          ),
          lastVersion: lastVersionContent.version,
          lastLog: lastVersionContent.changeLog,
          lastLogLink: lastVersionContent.changeLogLink,
        },
      };
    } catch (error: any) {
      return {
        code: 400,
        message: error.message,
      };
    }
  }

  private checkHasNewVersion(curVersion: string, lastVersion: string) {
    const curArr = curVersion.split('.').map((x) => parseInt(x, 10));
    const lastArr = lastVersion.split('.').map((x) => parseInt(x, 10));
    if (curArr[0] < lastArr[0]) {
      return true;
    }
    if (curArr[0] === lastArr[0] && curArr[1] < lastArr[1]) {
      return true;
    }
    if (
      curArr[0] === lastArr[0] &&
      curArr[1] === lastArr[1] &&
      curArr[2] < lastArr[2]
    ) {
      return true;
    }
    return false;
  }

  public async updateSystem() {
    const cp = spawn('no_tee=true ql update false', { shell: '/bin/bash' });

    cp.stdout.on('data', (data) => {
      this.sockService.sendMessage({
        type: 'updateSystemVersion',
        message: data.toString(),
      });
    });

    cp.stderr.on('data', (data) => {
      this.sockService.sendMessage({
        type: 'updateSystemVersion',
        message: data.toString(),
      });
    });

    cp.on('error', (err) => {
      this.sockService.sendMessage({
        type: 'updateSystemVersion',
        message: JSON.stringify(err),
      });
    });

    return { code: 200 };
  }

  public async reloadSystem(target: 'system' | 'data') {
    const cmd = `no_tee=true ql reload ${target || ''}`;
    const cp = spawn(cmd, { shell: '/bin/bash' });

    cp.stdout.on('data', (data) => {
      this.sockService.sendMessage({
        type: 'reloadSystem',
        message: data.toString(),
      });
    });

    cp.stderr.on('data', (data) => {
      this.sockService.sendMessage({
        type: 'reloadSystem',
        message: data.toString(),
      });
    });

    cp.on('error', (err) => {
      this.sockService.sendMessage({
        type: 'reloadSystem',
        message: JSON.stringify(err),
      });
    });

    return { code: 200 };
  }

  public async notify({ title, content }: { title: string; content: string }) {
    const isSuccess = await this.notificationService.notify(title, content);
    if (isSuccess) {
      return { code: 200, message: '通知发送成功' };
    } else {
      return { code: 400, message: '通知发送失败，请检查系统设置/通知配置' };
    }
  }

  public async run(
    { command, logPath }: { command: string; logPath: string },
    callback: TaskCallbacks,
  ) {
    if (!command.startsWith(TASK_COMMAND)) {
      command = `${TASK_COMMAND} ${command}`;
    }
    this.scheduleService.runTask(
      `real_log_path=${logPath} real_time=true ${command}`,
      callback,
      {
        command,
      },
    );
  }

  public async stop({ command, pid }: { command: string; pid: number }) {
    if (!pid && !command) {
      return { code: 400, message: '参数错误' };
    }

    if (pid) {
      await killTask(pid);
      return { code: 200 };
    }

    if (!command.startsWith(TASK_COMMAND)) {
      command = `${TASK_COMMAND} ${command}`;
    }
    const _pid = await getPid(command);
    if (_pid) {
      await killTask(_pid);
      return { code: 200 };
    } else {
      return { code: 400, message: '任务未找到' };
    }
  }

  public async exportData(res: Response) {
    try {
      await tar.create(
        { gzip: true, file: config.dataTgzFile, cwd: config.rootPath },
        ['data'],
      );
      res.download(config.dataTgzFile);
    } catch (error: any) {
      return res.send({ code: 400, message: error.message });
    }
  }

  public async importData() {
    try {
      await promiseExec(`rm -rf ${path.join(config.tmpPath, 'data')}`);
      await tar.x({ file: config.dataTgzFile, cwd: config.tmpPath });
      return { code: 200 };
    } catch (error: any) {
      return { code: 400, message: error.message };
    }
  }

  public async getSystemLog(res: Response) {
    const result = await readDirs(config.systemLogPath, config.systemLogPath);
    const logs = result.reverse().filter((x) => x.title.endsWith('.log'));
    res.set({
      'Content-Length': sum(logs.map((x) => x.size)),
    });
    (function sendFiles(res, fileNames) {
      if (fileNames.length === 0) {
        res.end();
        return;
      }

      const currentLog = fileNames.shift();
      if (currentLog) {
        const currentFileStream = fs.createReadStream(
          path.join(config.systemLogPath, currentLog.title),
        );
        currentFileStream.on('end', () => {
          sendFiles(res, fileNames);
        });
        currentFileStream.pipe(res, { end: false });
      }
    })(res, logs);
  }
}

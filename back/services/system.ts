import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import * as fs from 'fs';
import { AuthDataType, AuthInfo, AuthModel, AuthModelInfo } from '../data/auth';
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
} from '../config/util';
import { TASK_COMMAND } from '../config/const';
import taskLimit from '../shared/pLimit'

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
    return doc || {};
  }

  private async updateAuthDb(payload: AuthInfo): Promise<any> {
    await AuthModel.upsert({ ...payload });
    const doc = await this.getDb({ type: payload.type });
    return doc;
  }

  public async getDb(query: any): Promise<any> {
    const doc: any = await AuthModel.findOne({ where: { ...query } });
    return doc && (doc.get({ plain: true }) as any);
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

  public async updateSystemConfig(info: AuthModelInfo) {
    const oDoc = await this.getSystemConfig();
    const result = await this.updateAuthDb({
      ...oDoc,
      type: AuthDataType.systemConfig,
      info,
    });
    if (info.logRemoveFrequency) {
      const cron = {
        id: result.id,
        name: '删除日志',
        command: `ql rmlog ${info.logRemoveFrequency}`,
      };
      await this.scheduleService.cancelIntervalTask(cron);
      if (info.logRemoveFrequency > 0) {
        this.scheduleService.createIntervalTask(cron, {
          days: info.logRemoveFrequency,
        });
      }
    }
    if (info.cronConcurrency) {
      await taskLimit.setCustomLimit(info.cronConcurrency);
    }
    return { code: 200, data: info };
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
    const cp = spawn('ql -l update', { shell: '/bin/bash' });

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
}

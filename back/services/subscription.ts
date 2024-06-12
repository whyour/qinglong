import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import {
  Subscription,
  SubscriptionModel,
  SubscriptionStatus,
} from '../data/subscription';
import { ChildProcessWithoutNullStreams } from 'child_process';
import {
  getFileContentByName,
  concurrentRun,
  fileExist,
  createFile,
  killTask,
  handleLogPath,
  promiseExec,
  rmPath,
} from '../config/util';
import fs from 'fs/promises';
import { FindOptions, Op } from 'sequelize';
import path, { join } from 'path';
import ScheduleService, { TaskCallbacks } from './schedule';
import { SimpleIntervalSchedule } from 'toad-scheduler';
import SockService from './sock';
import SshKeyService from './sshKey';
import dayjs from 'dayjs';
import { LOG_END_SYMBOL } from '../config/const';
import { formatCommand, formatUrl } from '../config/subscription';
import { CrontabModel } from '../data/cron';
import CrontabService from './cron';

@Service()
export default class SubscriptionService {
  constructor(
    @Inject('logger') private logger: winston.Logger,
    private scheduleService: ScheduleService,
    private sockService: SockService,
    private sshKeyService: SshKeyService,
    private crontabService: CrontabService,
  ) {}

  public async list(searchText?: string): Promise<Subscription[]> {
    let query = {};
    if (searchText) {
      const reg = {
        [Op.or]: [
          { [Op.like]: `%${searchText}%` },
          { [Op.like]: `%${encodeURI(searchText)}%` },
        ],
      };
      query = {
        [Op.or]: [
          {
            name: reg,
          },
          {
            url: reg,
          },
        ],
      };
    }
    try {
      const result = await SubscriptionModel.findAll({
        where: query,
        order: [
          ['is_disabled', 'ASC'],
          ['createdAt', 'DESC'],
        ],
      });
      return result;
    } catch (error) {
      throw error;
    }
  }

  public async handleTask(
    doc: Subscription,
    needCreate = true,
    runImmediately = false,
  ) {
    const { url } = formatUrl(doc);

    doc.command = formatCommand(doc, url as string);

    if (doc.schedule_type === 'crontab') {
      this.scheduleService.cancelCronTask(doc as any);
      needCreate &&
        (await this.scheduleService.createCronTask(
          doc as any,
          this.taskCallbacks(doc),
          runImmediately,
        ));
    } else if (doc.interval_schedule) {
      this.scheduleService.cancelIntervalTask(doc as any);
      const { type, value } = doc.interval_schedule;
      needCreate &&
        (await this.scheduleService.createIntervalTask(
          doc as any,
          { [type]: value } as SimpleIntervalSchedule,
          runImmediately,
          this.taskCallbacks(doc),
        ));
    }
  }

  public async setSshConfig() {
    const docs = await SubscriptionModel.findAll();
    await this.sshKeyService.setSshConfig(docs);
  }

  private taskCallbacks(doc: Subscription): TaskCallbacks {
    return {
      onBefore: async (startTime) => {
        const logTime = startTime.format('YYYY-MM-DD-HH-mm-ss');
        const logPath = `${doc.alias}/${logTime}.log`;
        await SubscriptionModel.update(
          {
            status: SubscriptionStatus.running,
            log_path: logPath,
          },
          { where: { id: doc.id } },
        );
        const absolutePath = await handleLogPath(
          logPath as string,
          `## 开始执行... ${startTime.format('YYYY-MM-DD HH:mm:ss')}\n`,
        );

        // 执行sub_before
        let beforeStr = '';
        try {
          if (doc.sub_before) {
            await fs.appendFile(absolutePath, `\n## 执行before命令...\n\n`);
            beforeStr = await promiseExec(doc.sub_before);
          }
        } catch (error: any) {
          beforeStr =
            (error.stderr && error.stderr.toString()) || JSON.stringify(error);
        }
        if (beforeStr) {
          await fs.appendFile(absolutePath, `${beforeStr}\n`);
        }
      },
      onStart: async (cp: ChildProcessWithoutNullStreams, startTime) => {
        await SubscriptionModel.update(
          {
            pid: cp.pid,
          },
          { where: { id: doc.id } },
        );
      },
      onEnd: async (cp, endTime, diff) => {
        const sub = await this.getDb({ id: doc.id });
        const absolutePath = await handleLogPath(sub.log_path as string);

        // 执行 sub_after
        let afterStr = '';
        try {
          if (sub.sub_after) {
            await fs.appendFile(absolutePath, `\n\n## 执行after命令...\n\n`);
            afterStr = await promiseExec(sub.sub_after);
          }
        } catch (error: any) {
          afterStr =
            (error.stderr && error.stderr.toString()) || JSON.stringify(error);
        }
        if (afterStr) {
          await fs.appendFile(absolutePath, `${afterStr}\n`);
        }

        await fs.appendFile(
          absolutePath,
          `\n## 执行结束... ${endTime.format(
            'YYYY-MM-DD HH:mm:ss',
          )}  耗时 ${diff} 秒${LOG_END_SYMBOL}`,
        );

        await SubscriptionModel.update(
          { status: SubscriptionStatus.idle, pid: undefined },
          { where: { id: sub.id } },
        );

        this.sockService.sendMessage({
          type: 'runSubscriptionEnd',
          message: '订阅执行完成',
          references: [doc.id as number],
        });
      },
      onError: async (message: string) => {
        const sub = await this.getDb({ id: doc.id });
        const absolutePath = await handleLogPath(sub.log_path as string);
        await fs.appendFile(absolutePath, `\n${message}`);
      },
      onLog: async (message: string) => {
        const sub = await this.getDb({ id: doc.id });
        const absolutePath = await handleLogPath(sub.log_path as string);
        await fs.appendFile(absolutePath, `\n${message}`);
      },
    };
  }

  public async create(payload: Subscription): Promise<Subscription> {
    const tab = new Subscription(payload);
    const doc = await this.insert(tab);
    await this.handleTask(doc);
    await this.setSshConfig();
    return doc;
  }

  public async insert(payload: Subscription): Promise<Subscription> {
    return await SubscriptionModel.create(payload, { returning: true });
  }

  public async update(payload: Subscription): Promise<Subscription> {
    const doc = await this.getDb({ id: payload.id });
    const tab = new Subscription({ ...doc, ...payload });
    const newDoc = await this.updateDb(tab);
    await this.handleTask(newDoc, !newDoc.is_disabled);
    await this.setSshConfig();
    return newDoc;
  }

  public async updateDb(payload: Subscription): Promise<Subscription> {
    await SubscriptionModel.update(payload, { where: { id: payload.id } });
    return await this.getDb({ id: payload.id });
  }

  public async status({
    ids,
    status,
    pid,
    log_path,
    last_running_time = 0,
    last_execution_time = 0,
  }: {
    ids: number[];
    status: SubscriptionStatus;
    pid: number;
    log_path: string;
    last_running_time: number;
    last_execution_time: number;
  }) {
    const options: any = {
      status,
      pid,
      log_path,
      last_execution_time,
    };
    if (last_running_time > 0) {
      options.last_running_time = last_running_time;
    }

    return await SubscriptionModel.update(
      { ...options },
      { where: { id: ids } },
    );
  }

  public async remove(ids: number[], query: { force?: boolean }) {
    const docs = await SubscriptionModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      await this.handleTask(doc, false);
    }
    await SubscriptionModel.destroy({ where: { id: ids } });
    await this.setSshConfig();

    if (query?.force === true) {
      const crons = await CrontabModel.findAll({ where: { sub_id: ids } });
      if (crons?.length) {
        await this.crontabService.remove(crons.map((x) => x.id!));
      }
      for (const doc of docs) {
        const filePath = join(config.scriptPath, doc.alias);
        await rmPath(filePath);
      }
    }
  }

  public async getDb(
    query: FindOptions<Subscription>['where'],
  ): Promise<Subscription> {
    const doc = await SubscriptionModel.findOne({ where: { ...query } });
    if (!doc) {
      throw new Error(`Subscription ${JSON.stringify(query)} not found`);
    }
    return doc.get({ plain: true });
  }

  public async run(ids: number[]) {
    await SubscriptionModel.update(
      { status: SubscriptionStatus.queued },
      { where: { id: ids } },
    );
    ids.forEach((id) => {
      this.runSingle(id);
    });
  }

  public async stop(ids: number[]) {
    const docs = await SubscriptionModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      if (doc.pid) {
        try {
          await killTask(doc.pid);
        } catch (error) {
          this.logger.error(error);
        }
      }
    }

    await SubscriptionModel.update(
      { status: SubscriptionStatus.idle, pid: undefined },
      { where: { id: ids } },
    );
  }

  private async runSingle(subscriptionId: number) {
    const subscription = await this.getDb({ id: subscriptionId });
    if (subscription.status !== SubscriptionStatus.queued) {
      return;
    }

    const command = formatCommand(subscription);

    this.scheduleService.runTask(command, this.taskCallbacks(subscription), {
      name: subscription.name,
      schedule: subscription.schedule,
      command,
    });
  }

  public async disabled(ids: number[]) {
    await SubscriptionModel.update({ is_disabled: 1 }, { where: { id: ids } });
    const docs = await SubscriptionModel.findAll({ where: { id: ids } });
    await this.setSshConfig();
    for (const doc of docs) {
      await this.handleTask(doc, false);
    }
  }

  public async enabled(ids: number[]) {
    await SubscriptionModel.update({ is_disabled: 0 }, { where: { id: ids } });
    const docs = await SubscriptionModel.findAll({ where: { id: ids } });
    await this.setSshConfig();
    for (const doc of docs) {
      await this.handleTask(doc);
    }
  }

  public async log(id: number) {
    const doc = await this.getDb({ id });
    if (!doc || !doc.log_path) {
      return '';
    }

    const absolutePath = await handleLogPath(doc.log_path as string);
    return await getFileContentByName(absolutePath);
  }

  public async logs(id: number) {
    const doc = await this.getDb({ id });
    if (!doc) {
      return [];
    }

    if (doc.log_path) {
      const relativeDir = path.dirname(`${doc.log_path}`);
      const dir = path.resolve(config.logPath, relativeDir);
      const _exist = await fileExist(dir);
      if (_exist) {
        let files = await fs.readdir(dir);
        return (
          await Promise.all(
            files.map(async (x) => ({
              filename: x,
              directory: relativeDir.replace(config.logPath, ''),
              time: (await fs.lstat(`${dir}/${x}`)).mtime.getTime(),
            })),
          )
        ).sort((a, b) => b.time - a.time);
      }
    }
  }
}

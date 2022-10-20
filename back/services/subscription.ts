import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import {
  Subscription,
  SubscriptionModel,
  SubscriptionStatus,
} from '../data/subscription';
import {
  ChildProcessWithoutNullStreams,
  exec,
  execSync,
  spawn,
} from 'child_process';
import fs from 'fs';
import cron_parser from 'cron-parser';
import {
  getFileContentByName,
  concurrentRun,
  fileExist,
  createFile,
} from '../config/util';
import { promises, existsSync } from 'fs';
import { promisify } from 'util';
import { Op } from 'sequelize';
import path from 'path';
import ScheduleService, { TaskCallbacks } from './schedule';
import { SimpleIntervalSchedule } from 'toad-scheduler';
import SockService from './sock';
import SshKeyService from './sshKey';
import dayjs from 'dayjs';
import { LOG_END_SYMBOL } from '../config/const';

@Service()
export default class SubscriptionService {
  constructor(
    @Inject('logger') private logger: winston.Logger,
    private scheduleService: ScheduleService,
    private sockService: SockService,
    private sshKeyService: SshKeyService,
  ) {}

  public async list(searchText?: string): Promise<Subscription[]> {
    let query = {};
    if (searchText) {
      const reg = {
        [Op.or]: [
          { [Op.like]: `%${searchText}%` },
          { [Op.like]: `%${encodeURIComponent(searchText)}%` },
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
      return result as any;
    } catch (error) {
      throw error;
    }
  }

  private formatCommand(doc: Subscription, url?: string) {
    let command = 'ql ';
    let _url = url || this.formatUrl(doc).url;
    const { type, whitelist, blacklist, dependences, branch, extensions } = doc;
    if (type === 'file') {
      command += `raw "${_url}"`;
    } else {
      command += `repo "${_url}" "${whitelist || ''}" "${blacklist || ''}" "${
        dependences || ''
      }" "${branch || ''}" "${extensions || ''}"`;
    }
    return command;
  }

  private formatUrl(doc: Subscription) {
    let url = doc.url;
    let host = '';
    if (doc.type === 'private-repo') {
      if (doc.pull_type === 'ssh-key') {
        host = doc.url!.replace(/.*\@([^\:]+)\:.*/, '$1');
        url = doc.url!.replace(host, doc.alias);
      } else {
        host = doc.url!.replace(/.*\:\/\/([^\/]+)\/.*/, '$1');
        const { username, password } = doc.pull_option as any;
        url = doc.url!.replace(host, `${username}:${password}@${host}`);
      }
    }
    return { url, host };
  }

  public async handleTask(
    doc: Subscription,
    needCreate = true,
    needAddKey = true,
    runImmediately = false,
  ) {
    const { url, host } = this.formatUrl(doc);
    if (doc.type === 'private-repo' && doc.pull_type === 'ssh-key') {
      if (needAddKey) {
        this.sshKeyService.addSSHKey(
          (doc.pull_option as any).private_key,
          doc.alias,
          host,
        );
      } else {
        this.sshKeyService.removeSSHKey(doc.alias, host);
      }
    }

    doc.command = this.formatCommand(doc, url as string);

    if (doc.schedule_type === 'crontab') {
      this.scheduleService.cancelCronTask(doc as any);
      needCreate &&
        (await this.scheduleService.createCronTask(
          doc as any,
          this.taskCallbacks(doc),
          runImmediately,
        ));
    } else {
      this.scheduleService.cancelIntervalTask(doc as any);
      const { type, value } = doc.interval_schedule as any;
      needCreate &&
        (await this.scheduleService.createIntervalTask(
          doc as any,
          { [type]: value } as SimpleIntervalSchedule,
          runImmediately,
          this.taskCallbacks(doc),
        ));
    }
  }

  private async promiseExec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(
        command,
        { maxBuffer: 200 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          resolve(stdout || stderr || JSON.stringify(err));
        },
      );
    });
  }

  private async handleLogPath(
    logPath: string,
    data: string = '',
  ): Promise<string> {
    const absolutePath = path.resolve(config.logPath, logPath);
    const logFileExist = await fileExist(absolutePath);
    if (!logFileExist) {
      await createFile(absolutePath, data);
    }
    return absolutePath;
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
        const absolutePath = await this.handleLogPath(
          logPath as string,
          `## 开始执行... ${startTime.format('YYYY-MM-DD HH:mm:ss')}\n`,
        );

        // 执行sub_before
        let beforeStr = '';
        try {
          if (doc.sub_before) {
            fs.appendFileSync(absolutePath, `\n## 执行before命令...\n\n`);
            beforeStr = await this.promiseExec(doc.sub_before);
          }
        } catch (error: any) {
          beforeStr =
            (error.stderr && error.stderr.toString()) || JSON.stringify(error);
        }
        if (beforeStr) {
          fs.appendFileSync(absolutePath, `${beforeStr}\n`);
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
        const absolutePath = await this.handleLogPath(sub.log_path as string);

        // 执行 sub_after
        let afterStr = '';
        try {
          if (sub.sub_after) {
            fs.appendFileSync(absolutePath, `\n\n## 执行after命令...\n\n`);
            afterStr = await this.promiseExec(sub.sub_after);
          }
        } catch (error: any) {
          afterStr =
            (error.stderr && error.stderr.toString()) || JSON.stringify(error);
        }
        if (afterStr) {
          fs.appendFileSync(absolutePath, `${afterStr}\n`);
        }

        fs.appendFileSync(
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
        const absolutePath = await this.handleLogPath(sub.log_path as string);
        fs.appendFileSync(absolutePath, `\n${message}`);
      },
      onLog: async (message: string) => {
        const sub = await this.getDb({ id: doc.id });
        const absolutePath = await this.handleLogPath(sub.log_path as string);
        fs.appendFileSync(absolutePath, `\n${message}`);
      },
    };
  }

  public async create(payload: Subscription): Promise<Subscription> {
    const tab = new Subscription(payload);
    const doc = await this.insert(tab);
    await this.handleTask(doc);
    return doc;
  }

  public async insert(payload: Subscription): Promise<Subscription> {
    return await SubscriptionModel.create(payload, { returning: true });
  }

  public async update(payload: Subscription): Promise<Subscription> {
    const newDoc = await this.updateDb(payload);
    await this.handleTask(newDoc, !newDoc.is_disabled);
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

  public async remove(ids: number[]) {
    const docs = await SubscriptionModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      await this.handleTask(doc, false, false);
    }
    await SubscriptionModel.destroy({ where: { id: ids } });
  }

  public async getDb(query: any): Promise<Subscription> {
    const doc: any = await SubscriptionModel.findOne({ where: { ...query } });
    return doc && (doc.get({ plain: true }) as Subscription);
  }

  public async run(ids: number[]) {
    await SubscriptionModel.update(
      { status: SubscriptionStatus.queued },
      { where: { id: ids } },
    );
    concurrentRun(
      ids.map((id) => async () => await this.runSingle(id)),
      10,
    );
  }

  public async stop(ids: number[]) {
    const docs = await SubscriptionModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      if (doc.pid) {
        try {
          process.kill(-doc.pid);
        } catch (error) {
          this.logger.silly(error);
        }
      }
      const command = this.formatCommand(doc);
      const err = await this.killTask(command);
      const absolutePath = await this.handleLogPath(doc.log_path as string);
      const str = err ? `\n${err}` : '';

      fs.appendFileSync(
        `${absolutePath}`,
        `${str}\n## 执行结束...  ${dayjs().format('YYYY-MM-DD HH:mm:ss')}${LOG_END_SYMBOL}`,
      );
    }

    await SubscriptionModel.update(
      { status: SubscriptionStatus.idle, pid: undefined },
      { where: { id: ids } },
    );
  }

  public async killTask(name: string) {
    let taskCommand = `ps -ef | grep "${name}" | grep -v grep | awk '{print $1}'`;
    const execAsync = promisify(exec);
    try {
      let pid = (await execAsync(taskCommand)).stdout;
      if (pid) {
        pid = (await execAsync(`pstree -p ${pid}`)).stdout;
      } else {
        return;
      }
      let pids = pid.match(/\(\d+/g);
      const killLogs = [];
      if (pids && pids.length > 0) {
        // node 执行脚本时还会有10个子进程，但是ps -ef中不存在，所以截取前三个
        for (const id of pids) {
          const c = `kill -9 ${id.slice(1)}`;
          try {
            const { stdout, stderr } = await execAsync(c);
            if (stderr) {
              killLogs.push(stderr);
            }
            if (stdout) {
              killLogs.push(stdout);
            }
          } catch (error: any) {
            killLogs.push(error.message);
          }
        }
      }
      return killLogs.length > 0 ? JSON.stringify(killLogs) : '';
    } catch (e) {
      return JSON.stringify(e);
    }
  }

  private async runSingle(subscriptionId: number) {
    const subscription = await this.getDb({ id: subscriptionId });
    if (subscription.status !== SubscriptionStatus.queued) {
      return;
    }

    const command = this.formatCommand(subscription);

    await this.scheduleService.runTask(
      command,
      this.taskCallbacks(subscription),
    );
  }

  public async disabled(ids: number[]) {
    const docs = await SubscriptionModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      await this.handleTask(doc, false);
    }
    await SubscriptionModel.update({ is_disabled: 1 }, { where: { id: ids } });
  }

  public async enabled(ids: number[]) {
    const docs = await SubscriptionModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      await this.handleTask(doc);
    }
    await SubscriptionModel.update({ is_disabled: 0 }, { where: { id: ids } });
  }

  public async log(id: number) {
    const doc = await this.getDb({ id });
    if (!doc || !doc.log_path) {
      return '';
    }

    const absolutePath = await this.handleLogPath(doc.log_path as string);
    return getFileContentByName(absolutePath);
  }

  public async logs(id: number) {
    const doc = await this.getDb({ id });
    if (!doc) {
      return [];
    }

    if (doc.log_path) {
      const relativeDir = path.dirname(`${doc.log_path}`);
      const dir = path.resolve(config.logPath, relativeDir);
      if (existsSync(dir)) {
        let files = await promises.readdir(dir);
        return files
          .map((x) => ({
            filename: x,
            directory: relativeDir.replace(config.logPath, ''),
            time: fs.statSync(`${dir}/${x}`).mtime.getTime(),
          }))
          .sort((a, b) => b.time - a.time);
      }
    }
  }
}

import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import {
  Subscription,
  SubscriptionModel,
  SubscriptionStatus,
} from '../data/subscription';
import { exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import cron_parser from 'cron-parser';
import { getFileContentByName, concurrentRun, fileExist } from '../config/util';
import { promises, existsSync } from 'fs';
import { promisify } from 'util';
import { Op } from 'sequelize';
import path from 'path';
import ScheduleService from './schedule';
import { SimpleIntervalSchedule } from 'toad-scheduler';

@Service()
export default class SubscriptionService {
  constructor(
    @Inject('logger') private logger: winston.Logger,
    private scheduleService: ScheduleService,
  ) {}

  public async list(searchText?: string): Promise<Subscription[]> {
    let query = {};
    if (searchText) {
      const textArray = searchText.split(':');
      switch (textArray[0]) {
        case 'name':
        case 'command':
        case 'schedule':
        case 'label':
          const column = textArray[0] === 'label' ? 'labels' : textArray[0];
          query = {
            [column]: {
              [Op.or]: [
                { [Op.like]: `%${textArray[1]}%` },
                { [Op.like]: `%${encodeURIComponent(textArray[1])}%` },
              ],
            },
          };
          break;
        default:
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
                command: reg,
              },
              {
                schedule: reg,
              },
              {
                labels: reg,
              },
            ],
          };
          break;
      }
    }
    try {
      const result = await SubscriptionModel.findAll({
        where: query,
        order: [['createdAt', 'DESC']],
      });
      return result as any;
    } catch (error) {
      throw error;
    }
  }

  private formatCommand(doc: Subscription) {
    let command = 'ql ';
    const { type, url, whitelist, blacklist, dependences, branch } = doc;
    if (type === 'file') {
      command += `raw ${url}`;
    } else {
      command += `repo ${url} ${whitelist || ''} ${blacklist || ''} ${
        dependences || ''
      } ${branch || ''}`;
    }
    return command;
  }

  private handleTask(doc: Subscription, needCreate = true) {
    doc.command = this.formatCommand(doc);
    if (doc.schedule_type === 'crontab') {
      this.scheduleService.cancelCronTask(doc as any);
      needCreate && this.scheduleService.createCronTask(doc as any);
    } else {
      this.scheduleService.cancelIntervalTask(doc as any);
      const { type, value } = doc.interval_schedule as any;
      needCreate &&
        this.scheduleService.createIntervalTask(
          doc as any,
          { [type]: value } as SimpleIntervalSchedule,
        );
    }
  }

  public async create(payload: Subscription): Promise<Subscription> {
    const tab = new Subscription(payload);
    const doc = await this.insert(tab);
    this.handleTask(doc);
    return doc;
  }

  public async insert(payload: Subscription): Promise<Subscription> {
    return await SubscriptionModel.create(payload, { returning: true });
  }

  public async update(payload: Subscription): Promise<Subscription> {
    const newDoc = await this.updateDb(payload);
    this.handleTask(newDoc);
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
      this.handleTask(doc, false);
      const command = this.formatCommand(doc);
      const err = await this.killTask(command);
      const absolutePath = path.resolve(config.logPath, `${doc.log_path}`);
      const logFileExist = doc.log_path && (await fileExist(absolutePath));
      if (logFileExist) {
        const str = err ? `\n${err}` : '';
        fs.appendFileSync(
          `${absolutePath}`,
          `${str}\n## 执行结束...  ${new Date()
            .toLocaleString('zh', { hour12: false })
            .replace(' 24:', ' 00:')} `,
        );
      }
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

  private async runSingle(cronId: number): Promise<number> {
    return new Promise(async (resolve: any) => {
      const cron = await this.getDb({ id: cronId });
      if (cron.status !== SubscriptionStatus.queued) {
        resolve();
        return;
      }

      let { id, log_path, name } = cron;
      const command = this.formatCommand(cron);
      const absolutePath = path.resolve(config.logPath, `${log_path}`);
      const logFileExist = log_path && (await fileExist(absolutePath));

      this.logger.silly('Running job' + name);
      this.logger.silly('ID: ' + id);
      this.logger.silly('Original command: ' + command);

      const cp = spawn(command, { shell: '/bin/bash' });

      await SubscriptionModel.update(
        { status: SubscriptionStatus.running, pid: cp.pid },
        { where: { id } },
      );
      cp.stderr.on('data', (data) => {
        if (logFileExist) {
          fs.appendFileSync(`${absolutePath}`, `${data}`);
        }
      });
      cp.on('error', (err) => {
        if (logFileExist) {
          fs.appendFileSync(`${absolutePath}`, `${JSON.stringify(err)}`);
        }
      });

      cp.on('exit', async (code, signal) => {
        this.logger.info(`${''} pid: ${cp.pid} exit ${code} signal ${signal}`);
        await SubscriptionModel.update(
          { status: SubscriptionStatus.idle, pid: undefined },
          { where: { id } },
        );
        resolve();
      });
      cp.on('close', async (code) => {
        this.logger.info(`${''} pid: ${cp.pid} closed ${code}`);
        await SubscriptionModel.update(
          { status: SubscriptionStatus.idle, pid: undefined },
          { where: { id } },
        );
        resolve();
      });
    });
  }

  public async disabled(ids: number[]) {
    const docs = await SubscriptionModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      this.handleTask(doc, false);
    }
    await SubscriptionModel.update({ is_disabled: 1 }, { where: { id: ids } });
  }

  public async enabled(ids: number[]) {
    const docs = await SubscriptionModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      this.handleTask(doc);
    }
    await SubscriptionModel.update({ is_disabled: 0 }, { where: { id: ids } });
  }

  public async log(id: number) {
    const doc = await this.getDb({ id });
    if (!doc) {
      return '';
    }

    const absolutePath = path.resolve(config.logPath, `${doc.log_path}`);
    const logFileExist = doc.log_path && (await fileExist(absolutePath));
    if (logFileExist) {
      return getFileContentByName(`${absolutePath}`);
    }
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

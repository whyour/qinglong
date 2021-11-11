import { Service, Inject } from 'typedi';
import winston from 'winston';
import DataStore from 'nedb';
import config from '../config';
import { Crontab, CrontabStatus } from '../data/cron';
import { exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import cron_parser from 'cron-parser';
import { getFileContentByName } from '../config/util';
import PQueue from 'p-queue';
import { promises, existsSync } from 'fs';
import { promisify } from 'util';
import { dbs } from '../loaders/db';

@Service()
export default class CronService {
  private cronDb = dbs.cronDb;

  private queue = new PQueue({
    concurrency: parseInt(process.env.MaxConcurrentNum as string) || 5,
  });

  constructor(@Inject('logger') private logger: winston.Logger) {}

  private isSixCron(cron: Crontab) {
    const { schedule } = cron;
    if (schedule.split(/ +/).length === 6) {
      return true;
    }
    return false;
  }

  public async create(payload: Crontab): Promise<Crontab> {
    const tab = new Crontab(payload);
    tab.created = new Date().valueOf();
    tab.saved = false;
    const doc = await this.insert(tab);
    await this.set_crontab(this.isSixCron(doc));
    return doc;
  }

  public async insert(payload: Crontab): Promise<Crontab> {
    return new Promise((resolve) => {
      this.cronDb.insert(payload, (err, docs) => {
        if (err) {
          this.logger.error(err);
        } else {
          resolve(docs);
        }
      });
    });
  }

  public async update(payload: Crontab): Promise<Crontab> {
    const { _id, ...other } = payload;
    const doc = await this.get(_id);
    const tab = new Crontab({ ...doc, ...other });
    tab.saved = false;
    const newDoc = await this.updateDb(tab);
    await this.set_crontab(this.isSixCron(newDoc));
    return newDoc;
  }

  public async updateDb(payload: Crontab): Promise<Crontab> {
    return new Promise((resolve) => {
      this.cronDb.update(
        { _id: payload._id },
        payload,
        { returnUpdatedDocs: true },
        (err, num, docs: any) => {
          if (err) {
            this.logger.error(err);
          } else {
            resolve(docs);
          }
        },
      );
    });
  }

  public async status({
    ids,
    status,
    pid,
    log_path,
    last_running_time = 0,
    last_execution_time = 0,
  }: {
    ids: string[];
    status: CrontabStatus;
    pid: number;
    log_path: string;
    last_running_time: number;
    last_execution_time: number;
  }) {
    return new Promise((resolve) => {
      this.cronDb.update(
        { _id: { $in: ids } },
        {
          $set: {
            status,
            pid,
            log_path,
            last_running_time,
            last_execution_time,
          },
        },
        { multi: true, returnUpdatedDocs: true },
        (err) => {
          resolve(null);
        },
      );
    });
  }

  public async remove(ids: string[]) {
    return new Promise((resolve: any) => {
      this.cronDb.remove(
        { _id: { $in: ids } },
        { multi: true },
        async (err) => {
          await this.set_crontab(true);
          resolve();
        },
      );
    });
  }

  public async pin(ids: string[]) {
    return new Promise((resolve: any) => {
      this.cronDb.update(
        { _id: { $in: ids } },
        { $set: { isPinned: 1 } },
        { multi: true },
        async (err) => {
          resolve();
        },
      );
    });
  }

  public async unPin(ids: string[]) {
    return new Promise((resolve: any) => {
      this.cronDb.update(
        { _id: { $in: ids } },
        { $set: { isPinned: 0 } },
        { multi: true },
        async (err) => {
          resolve();
        },
      );
    });
  }

  public async crontabs(searchText?: string): Promise<Crontab[]> {
    let query = {};
    if (searchText) {
      const reg = new RegExp(searchText, 'i');
      query = {
        $or: [
          {
            name: reg,
          },
          {
            command: reg,
          },
          {
            schedule: reg,
          },
        ],
      };
    }
    return new Promise((resolve) => {
      this.cronDb
        .find(query)
        .sort({ created: -1 })
        .exec((err, docs) => {
          resolve(docs);
        });
    });
  }

  public async get(_id: string): Promise<Crontab> {
    return new Promise((resolve) => {
      this.cronDb.find({ _id }).exec((err, docs) => {
        resolve(docs[0]);
      });
    });
  }

  public async run(ids: string[]) {
    this.cronDb.update(
      { _id: { $in: ids } },
      { $set: { status: CrontabStatus.queued } },
      { multi: true },
    );
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      this.queue.add(() => this.runSingle(id));
    }
  }

  public async stop(ids: string[]) {
    return new Promise((resolve: any) => {
      this.cronDb
        .find({ _id: { $in: ids } })
        .exec(async (err, docs: Crontab[]) => {
          for (const doc of docs) {
            if (doc.pid) {
              try {
                process.kill(-doc.pid);
              } catch (error) {
                this.logger.silly(error);
              }
            }
            const err = await this.killTask(doc.command);
            if (doc.log_path) {
              const str = err ? `\n${err}` : '';
              fs.appendFileSync(
                `${doc.log_path}`,
                `${str}\n## 执行结束...  ${new Date()
                  .toLocaleString('zh', { hour12: false })
                  .replace(' 24:', ' 00:')} `,
              );
            }
          }
          this.cronDb.update(
            { _id: { $in: ids } },
            { $set: { status: CrontabStatus.idle }, $unset: { pid: true } },
            { multi: true },
          );
          this.queue.clear();
          resolve();
        });
    });
  }

  private async killTask(name: string) {
    let taskCommand = `ps -ef | grep "${name}" | grep -v grep | awk '{print $1}'`;
    const execAsync = promisify(exec);
    try {
      let pid = (await execAsync(taskCommand)).stdout;
      if (pid) {
        pid = (await execAsync(`pstree -p ${pid}`)).stdout;
      } else {
        return;
      }
      const pids = pid.match(/\(\d+/g);
      const killLogs = [];
      for (const id of pids) {
        const c = `kill -9 ${id.slice(1)}`;
        const { stdout, stderr } = await execAsync(c);
        if (stderr) {
          killLogs.push(stderr);
        }
        if (stdout) {
          killLogs.push(stdout);
        }
      }
      return killLogs.length > 0 ? JSON.stringify(killLogs) : '';
    } catch (e) {
      return JSON.stringify(e);
    }
  }

  private async runSingle(id: string): Promise<number> {
    return new Promise(async (resolve: any) => {
      const cron = await this.get(id);
      if (cron.status !== CrontabStatus.queued) {
        resolve();
        return;
      }

      let { _id, command, log_path } = cron;

      this.logger.silly('Running job');
      this.logger.silly('ID: ' + _id);
      this.logger.silly('Original command: ' + command);

      let cmdStr = command;
      if (!cmdStr.includes('task ') && !cmdStr.includes('ql ')) {
        cmdStr = `task ${cmdStr}`;
      }
      if (cmdStr.endsWith('.js')) {
        cmdStr = `${cmdStr} now`;
      }

      const cp = spawn(cmdStr, { shell: '/bin/bash' });
      this.cronDb.update(
        { _id },
        { $set: { status: CrontabStatus.running, pid: cp.pid } },
      );
      cp.stderr.on('data', (data) => {
        if (log_path) {
          fs.appendFileSync(`${log_path}`, `${data}`);
        }
      });
      cp.on('error', (err) => {
        if (log_path) {
          fs.appendFileSync(`${log_path}`, `${JSON.stringify(err)}`);
        }
      });

      cp.on('exit', (code, signal) => {
        this.logger.info(
          `${command} pid: ${cp.pid} exit ${code} signal ${signal}`,
        );
        this.cronDb.update(
          { _id },
          { $set: { status: CrontabStatus.idle }, $unset: { pid: true } },
        );
        resolve();
      });
      cp.on('close', (code) => {
        this.logger.info(`${command} pid: ${cp.pid} closed ${code}`);
        this.cronDb.update(
          { _id },
          { $set: { status: CrontabStatus.idle }, $unset: { pid: true } },
        );
        resolve();
      });
    });
  }

  public async disabled(ids: string[]) {
    return new Promise((resolve: any) => {
      this.cronDb.update(
        { _id: { $in: ids } },
        { $set: { isDisabled: 1 } },
        { multi: true },
        async (err) => {
          await this.set_crontab(true);
          resolve();
        },
      );
    });
  }

  public async enabled(ids: string[]) {
    return new Promise((resolve: any) => {
      this.cronDb.update(
        { _id: { $in: ids } },
        { $set: { isDisabled: 0 } },
        { multi: true },
        async (err) => {
          await this.set_crontab(true);
          resolve();
        },
      );
    });
  }

  public async log(_id: string) {
    const doc = await this.get(_id);
    if (!doc) {
      return '';
    }

    if (doc.log_path) {
      return getFileContentByName(`${doc.log_path}`);
    }
    const [, commandStr, url] = doc.command.split(/ +/);
    let logPath = this.getKey(commandStr);
    const isQlCommand = doc.command.startsWith('ql ');
    const key =
      (url && ['repo', 'raw'].includes(commandStr) && this.getKey(url)) ||
      logPath;
    if (isQlCommand) {
      logPath = 'update';
    }
    let logDir = `${config.logPath}${logPath}`;
    if (existsSync(logDir)) {
      let files = await promises.readdir(logDir);
      if (isQlCommand) {
        files = files.filter((x) => x.includes(key));
      }
      return getFileContentByName(`${logDir}/${files[files.length - 1]}`);
    } else {
      return '';
    }
  }

  private getKey(command: string) {
    const start =
      command.lastIndexOf('/') !== -1 ? command.lastIndexOf('/') + 1 : 0;
    const end =
      command.lastIndexOf('.') !== -1
        ? command.lastIndexOf('.')
        : command.length;
    return command.substring(start, end);
  }

  private make_command(tab: Crontab) {
    const crontab_job_string = `ID=${tab._id} ${tab.command}`;
    return crontab_job_string;
  }

  private async set_crontab(needReloadSchedule: boolean = false) {
    const tabs = await this.crontabs();
    var crontab_string = '';
    tabs.forEach((tab) => {
      const _schedule = tab.schedule && tab.schedule.split(/ +/);
      if (tab.isDisabled === 1 || _schedule.length !== 5) {
        crontab_string += '# ';
        crontab_string += tab.schedule;
        crontab_string += ' ';
        crontab_string += this.make_command(tab);
        crontab_string += '\n';
      } else {
        crontab_string += tab.schedule;
        crontab_string += ' ';
        crontab_string += this.make_command(tab);
        crontab_string += '\n';
      }
    });

    this.logger.silly(crontab_string);
    fs.writeFileSync(config.crontabFile, crontab_string);

    execSync(`crontab ${config.crontabFile}`);
    if (needReloadSchedule) {
      exec(`pm2 reload schedule`);
    }
    this.cronDb.update({}, { $set: { saved: true } }, { multi: true });
  }

  public import_crontab() {
    exec('crontab -l', (error, stdout, stderr) => {
      var lines = stdout.split('\n');
      var namePrefix = new Date().getTime();

      lines.reverse().forEach((line, index) => {
        line = line.replace(/\t+/g, ' ');
        var regex =
          /^((\@[a-zA-Z]+\s+)|(([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+))/;
        var command = line.replace(regex, '').trim();
        var schedule = line.replace(command, '').trim();

        if (
          command &&
          schedule &&
          cron_parser.parseExpression(schedule).hasNext()
        ) {
          var name = namePrefix + '_' + index;

          this.cronDb.findOne({ command, schedule }, (err, doc) => {
            if (err) {
              throw err;
            }
            if (!doc) {
              this.create({ name, command, schedule });
            } else {
              doc.command = command;
              doc.schedule = schedule;
              this.update(doc);
            }
          });
        }
      });
    });
  }

  public autosave_crontab() {
    return this.set_crontab();
  }
}

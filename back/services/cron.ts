import { Service, Inject } from 'typedi';
import winston from 'winston';
import DataStore from 'nedb';
import config from '../config';
import { Crontab, CrontabStatus } from '../data/cron';
import { exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import cron_parser from 'cron-parser';
import { getFileContentByName } from '../config/util';

@Service()
export default class CronService {
  private cronDb = new DataStore({ filename: config.cronDbFile });

  constructor(@Inject('logger') private logger: winston.Logger) {
    this.cronDb.loadDatabase((err) => {
      if (err) throw err;
    });
  }

  public getDb(): DataStore {
    return this.cronDb;
  }

  private isSixCron(cron: Crontab) {
    const { schedule } = cron;
    if (schedule.split(' ').length === 6) {
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
    await this.set_crontab();
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

  public async status(_id: string, stopped: boolean) {
    this.cronDb.update({ _id }, { $set: { stopped, saved: false } });
  }

  public async remove(ids: string[]) {
    this.cronDb.remove({ _id: { $in: ids } }, { multi: true });
    await this.set_crontab(true);
  }

  public async crontabs(searchText?: string): Promise<Crontab[]> {
    let query = {};
    if (searchText) {
      const reg = new RegExp(searchText);
      query = {
        $or: [
          {
            name: reg,
          },
          {
            command: reg,
          },
        ],
      };
    }
    return new Promise((resolve) => {
      this.cronDb
        .find(query)
        .sort({ created: 1 })
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
    this.cronDb.find({ _id: { $in: ids } }).exec((err, docs: Crontab[]) => {
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        this.runSingle(doc);
      }
    });
  }

  public async stop(ids: string[]) {
    this.cronDb.find({ _id: { $in: ids } }).exec((err, docs: Crontab[]) => {
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        if (doc.pid) {
          exec(`kill -9 ${doc.pid}`);
        }
      }
    });
  }

  private async runSingle(cron: Crontab) {
    let { _id, command } = cron;

    this.logger.silly('Running job');
    this.logger.silly('ID: ' + _id);
    this.logger.silly('Original command: ' + command);

    let logFile = `${config.manualLogPath}${_id}.log`;
    fs.writeFileSync(logFile, `开始执行...\n\n${new Date().toString()}\n`);

    let cmdStr = command;
    if (!cmdStr.includes('task ') && !cmdStr.includes('ql ')) {
      cmdStr = `task ${cmdStr}`;
    }
    if (cmdStr.endsWith('.js')) {
      cmdStr = `${cmdStr} now`;
    }
    const cmd = spawn(cmdStr, { shell: true });

    this.cronDb.update(
      { _id },
      { $set: { status: CrontabStatus.running, pid: cmd.pid } },
    );

    cmd.stdout.on('data', (data) => {
      this.logger.silly(`stdout: ${data}`);
      fs.appendFileSync(logFile, data);
    });

    cmd.stderr.on('data', (data) => {
      this.logger.error(`stderr: ${data}`);
      fs.appendFileSync(logFile, data);
    });

    cmd.on('close', (code) => {
      this.logger.silly(`child process exited with code ${code}`);
      this.cronDb.update({ _id }, { $set: { status: CrontabStatus.idle } });
    });

    cmd.on('error', (err) => {
      this.logger.silly(err);
      fs.appendFileSync(logFile, err.stack);
    });

    cmd.on('exit', (code: number, signal: any) => {
      this.logger.silly(`cmd exit ${code}`);
      this.cronDb.update({ _id }, { $set: { status: CrontabStatus.idle } });
      fs.appendFileSync(logFile, `\n\n执行结束...`);
    });

    cmd.on('disconnect', () => {
      this.logger.silly(`cmd disconnect`);
      this.cronDb.update({ _id }, { $set: { status: CrontabStatus.idle } });
      fs.appendFileSync(logFile, `\n\n连接断开...`);
    });
  }

  public async disabled(ids: string[]) {
    this.cronDb.update(
      { _id: { $in: ids } },
      { $set: { status: CrontabStatus.disabled } },
      { multi: true },
    );
    await this.set_crontab();
  }

  public async enabled(ids: string[]) {
    this.cronDb.update(
      { _id: { $in: ids } },
      { $set: { status: CrontabStatus.idle } },
      { multi: true },
    );
  }

  public async log(_id: string) {
    let logFile = `${config.manualLogPath}${_id}.log`;
    return getFileContentByName(logFile);
  }

  private make_command(tab: Crontab) {
    const crontab_job_string = `ID=${tab._id} ${tab.command}`;
    return crontab_job_string;
  }

  private async set_crontab(needReloadSchedule: boolean = false) {
    const tabs = await this.crontabs();
    var crontab_string = '';
    tabs.forEach((tab) => {
      const _schedule = tab.schedule && tab.schedule.split(' ');
      if (tab.status === CrontabStatus.disabled || _schedule.length !== 5) {
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

  private reload_db() {
    this.cronDb.loadDatabase();
  }

  public import_crontab() {
    exec('crontab -l', (error, stdout, stderr) => {
      var lines = stdout.split('\n');
      var namePrefix = new Date().getTime();

      lines.reverse().forEach((line, index) => {
        line = line.replace(/\t+/g, ' ');
        var regex = /^((\@[a-zA-Z]+\s+)|(([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+))/;
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

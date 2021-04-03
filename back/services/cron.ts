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

  public async create(payload: Crontab): Promise<void> {
    const tab = new Crontab(payload);
    tab.created = new Date().valueOf();
    tab.saved = false;
    this.cronDb.insert(tab);
    await this.set_crontab();
  }

  public async update(payload: Crontab): Promise<void> {
    const { _id, ...other } = payload;
    const doc = await this.get(_id);
    const tab = new Crontab({ ...doc, ...other });
    tab.saved = false;
    this.cronDb.update({ _id }, tab, { returnUpdatedDocs: true });
    await this.set_crontab();
  }

  public async status(_id: string, stopped: boolean) {
    this.cronDb.update({ _id }, { $set: { stopped, saved: false } });
  }

  public async remove(_id: string) {
    this.cronDb.remove({ _id }, {});
    await this.set_crontab();
  }

  public async crontabs(): Promise<Crontab[]> {
    return new Promise((resolve) => {
      this.cronDb
        .find({})
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

  public async run(_id: string) {
    this.cronDb.find({ _id }).exec((err, docs) => {
      let res = docs[0];

      this.logger.silly('Running job');
      this.logger.silly('ID: ' + _id);
      this.logger.silly('Original command: ' + res.command);

      let logFile = `${config.manualLogPath}${res._id}.log`;
      fs.writeFileSync(logFile, `${new Date().toString()}\n\n`);

      const cmd = spawn(`${res.command} now`, { shell: true });

      this.cronDb.update({ _id }, { $set: { status: CrontabStatus.running } });

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
    });
  }

  public async disabled(_id: string) {
    this.cronDb.update({ _id }, { $set: { status: CrontabStatus.disabled } });
    await this.set_crontab();
  }

  public async enabled(_id: string) {
    this.cronDb.update({ _id }, { $set: { status: CrontabStatus.idle } });
  }

  public async log(_id: string) {
    let logFile = `${config.manualLogPath}${_id}.log`;
    return getFileContentByName(logFile);
  }

  private make_command(tab: Crontab) {
    const crontab_job_string = `ID=${tab._id} ${tab.command}`;
    return crontab_job_string;
  }

  private async set_crontab() {
    const tabs = await this.crontabs();
    var crontab_string = '';
    tabs.forEach((tab) => {
      if (tab.status !== CrontabStatus.disabled) {
        crontab_string += tab.schedule;
        crontab_string += ' ';
        crontab_string += this.make_command(tab);
        crontab_string += '\n';
      }
    });

    this.logger.silly(crontab_string);
    fs.writeFileSync(config.crontabFile, crontab_string);

    execSync(`crontab ${config.crontabFile}`);
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

        var is_valid = false;
        try {
          is_valid = cron_parser.parseString(line).expressions.length > 0;
        } catch (e) {}
        if (command && schedule && is_valid) {
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

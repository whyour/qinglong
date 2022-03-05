import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import { Crontab, CrontabModel, CrontabStatus } from '../data/cron';
import { exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import cron_parser from 'cron-parser';
import { getFileContentByName, concurrentRun, fileExist } from '../config/util';
import { promises, existsSync } from 'fs';
import { promisify } from 'util';
import { Op } from 'sequelize';

@Service()
export default class CronService {
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
    tab.saved = false;
    const doc = await this.insert(tab);
    await this.set_crontab(this.isSixCron(doc));
    return doc;
  }

  public async insert(payload: Crontab): Promise<Crontab> {
    return await CrontabModel.create(payload, { returning: true });
  }

  public async update(payload: Crontab): Promise<Crontab> {
    payload.saved = false;
    const newDoc = await this.updateDb(payload);
    await this.set_crontab(this.isSixCron(newDoc));
    return newDoc;
  }

  public async updateDb(payload: Crontab): Promise<Crontab> {
    await CrontabModel.update(payload, { where: { id: payload.id } });
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
    status: CrontabStatus;
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

    return await CrontabModel.update({ ...options }, { where: { id: ids } });
  }

  public async remove(ids: number[]) {
    await CrontabModel.destroy({ where: { id: ids } });
    await this.set_crontab(true);
  }

  public async pin(ids: number[]) {
    await CrontabModel.update({ isPinned: 1 }, { where: { id: ids } });
  }

  public async unPin(ids: number[]) {
    await CrontabModel.update({ isPinned: 0 }, { where: { id: ids } });
  }

  public async addLabels(ids: string[], labels: string[]) {
    const docs = await CrontabModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      await CrontabModel.update(
        {
          labels: Array.from(new Set((doc.labels || []).concat(labels))),
        },
        { where: { id: doc.id } },
      );
    }
  }

  public async removeLabels(ids: string[], labels: string[]) {
    const docs = await CrontabModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      await CrontabModel.update(
        {
          labels: (doc.labels || []).filter((label) => !labels.includes(label)),
        },
        { where: { id: doc.id } },
      );
    }
  }

  public async crontabs(searchText?: string): Promise<Crontab[]> {
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
      const result = await CrontabModel.findAll({
        where: query,
        order: [['createdAt', 'DESC']],
      });
      return result as any;
    } catch (error) {
      throw error;
    }
  }

  public async getDb(query: any): Promise<Crontab> {
    const doc: any = await CrontabModel.findOne({ where: { ...query } });
    return doc && (doc.get({ plain: true }) as Crontab);
  }

  public async run(ids: number[]) {
    await CrontabModel.update(
      { status: CrontabStatus.queued },
      { where: { id: ids } },
    );
    concurrentRun(
      ids.map((id) => async () => await this.runSingle(id)),
      10,
    );
  }

  public async stop(ids: number[]) {
    const docs = await CrontabModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      if (doc.pid) {
        try {
          process.kill(-doc.pid);
        } catch (error) {
          this.logger.silly(error);
        }
      }
      const err = await this.killTask(doc.command);
      const logFileExist = await fileExist(doc.log_path);
      if (doc.log_path && logFileExist) {
        const str = err ? `\n${err}` : '';
        fs.appendFileSync(
          `${doc.log_path}`,
          `${str}\n## 执行结束...  ${new Date()
            .toLocaleString('zh', { hour12: false })
            .replace(' 24:', ' 00:')} `,
        );
      }
    }

    await CrontabModel.update(
      { status: CrontabStatus.idle, pid: undefined },
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
      if (cron.status !== CrontabStatus.queued) {
        resolve();
        return;
      }

      let { id, command, log_path } = cron;

      this.logger.silly('Running job');
      this.logger.silly('ID: ' + id);
      this.logger.silly('Original command: ' + command);

      let cmdStr = command;
      if (!cmdStr.includes('task ') && !cmdStr.includes('ql ')) {
        cmdStr = `task ${cmdStr}`;
      }
      if (cmdStr.endsWith('.js')) {
        cmdStr = `${cmdStr} now`;
      }

      const cp = spawn(cmdStr, { shell: '/bin/bash' });

      await CrontabModel.update(
        { status: CrontabStatus.running, pid: cp.pid },
        { where: { id } },
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

      cp.on('exit', async (code, signal) => {
        this.logger.info(
          `${command} pid: ${cp.pid} exit ${code} signal ${signal}`,
        );
        await CrontabModel.update(
          { status: CrontabStatus.idle, pid: undefined },
          { where: { id } },
        );
        resolve();
      });
      cp.on('close', async (code) => {
        this.logger.info(`${command} pid: ${cp.pid} closed ${code}`);
        await CrontabModel.update(
          { status: CrontabStatus.idle, pid: undefined },
          { where: { id } },
        );
        resolve();
      });
    });
  }

  public async disabled(ids: number[]) {
    await CrontabModel.update({ isDisabled: 1 }, { where: { id: ids } });
    await this.set_crontab(true);
  }

  public async enabled(ids: number[]) {
    await CrontabModel.update({ isDisabled: 0 }, { where: { id: ids } });
    await this.set_crontab(true);
  }

  public async log(id: number) {
    const doc = await this.getDb({ id });
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

  public async logs(id: number) {
    const doc = await this.getDb({ id });
    if (!doc) {
      return [];
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
      return files
        .map((x) => ({
          filename: x,
          directory: logPath,
          time: fs.statSync(`${logDir}/${x}`).mtime.getTime(),
        }))
        .sort((a, b) => b.time - a.time);
    } else {
      return [];
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
    const crontab_job_string = `ID=${tab.id} ${tab.command}`;
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
    await CrontabModel.update({ saved: true }, { where: {} });
  }

  public import_crontab() {
    exec('crontab -l', (error, stdout, stderr) => {
      var lines = stdout.split('\n');
      var namePrefix = new Date().getTime();

      lines.reverse().forEach(async (line, index) => {
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

          const _crontab = await CrontabModel.findOne({
            where: { command, schedule },
          });
          if (!_crontab) {
            await this.create({ name, command, schedule });
          } else {
            _crontab.command = command;
            _crontab.schedule = schedule;
            await this.update(_crontab);
          }
        }
      });
    });
  }

  public autosave_crontab() {
    return this.set_crontab();
  }
}

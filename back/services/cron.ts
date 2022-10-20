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
import path from 'path';
import dayjs from 'dayjs';
import { LOG_END_SYMBOL } from '../config/const';

@Service()
export default class CronService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  private isSixCron(cron: Crontab) {
    const { schedule } = cron;
    if (schedule?.split(/ +/).length === 6) {
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

  private formatViewQuery(query: any, viewQuery: any) {
    if (viewQuery.filters && viewQuery.filters.length > 0) {
      if (!query[Op.and]) {
        query[Op.and] = [];
      }
      for (const col of viewQuery.filters) {
        const { property, value, operation } = col;
        let q: any = {};
        let operate2 = null;
        let operate = null;
        switch (operation) {
          case 'Reg':
            operate = Op.like;
            operate2 = Op.or;
            break;
          case 'NotReg':
            operate = Op.notLike;
            operate2 = Op.and;
            break;
          case 'In':
            q[Op.or] = [
              {
                [property]: value,
              },
              property === 'status' && value.includes(2)
                ? { isDisabled: 1 }
                : {},
            ];
            break;
          case 'Nin':
            q[Op.and] = [
              {
                [property]: {
                  [Op.notIn]: value,
                },
              },
              property === 'status' && value.includes(2)
                ? { isDisabled: { [Op.ne]: 1 } }
                : {},
            ];
            break;
          default:
            break;
        }
        if (operate && operate2) {
          q[property] = {
            [operate2]: [
              { [operate]: `%${value}%` },
              { [operate]: `%${encodeURIComponent(value)}%` },
            ],
          };
        }
        query[Op.and].push(q);
      }
    }
  }

  private formatSearchText(query: any, searchText: string | undefined) {
    if (searchText) {
      if (!query[Op.and]) {
        query[Op.and] = [];
      }
      let q: any = {};
      const textArray = searchText.split(':');
      switch (textArray[0]) {
        case 'name':
        case 'command':
        case 'schedule':
        case 'label':
          const column = textArray[0] === 'label' ? 'labels' : textArray[0];
          q[column] = {
            [Op.or]: [
              { [Op.like]: `%${textArray[1]}%` },
              { [Op.like]: `%${encodeURIComponent(textArray[1])}%` },
            ],
          };
          break;
        default:
          const reg = {
            [Op.or]: [
              { [Op.like]: `%${searchText}%` },
              { [Op.like]: `%${encodeURIComponent(searchText)}%` },
            ],
          };
          q[Op.or] = [
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
          ];
          break;
      }
      query[Op.and].push(q);
    }
  }

  private formatFilterQuery(query: any, filterQuery: any) {
    if (filterQuery) {
      if (!query[Op.and]) {
        query[Op.and] = [];
      }
      const filterKeys: any = Object.keys(filterQuery);
      for (const key of filterKeys) {
        let q: any = {};
        if (filterKeys[key]) {
          q[key] = filterKeys[key];
        }
        query[Op.and].push(q);
      }
    }
  }

  private formatViewSort(order: string[][], viewQuery: any) {
    if (viewQuery.sorts && viewQuery.sorts.length > 0) {
      for (const { property, type } of viewQuery.sorts) {
        order.unshift([property, type]);
      }
    }
  }

  public async crontabs(params?: {
    searchValue: string;
    page: string;
    size: string;
    sorter: string;
    filters: string;
    queryString: string;
  }): Promise<{ data: Crontab[]; total: number }> {
    const searchText = params?.searchValue;
    const page = Number(params?.page || '0');
    const size = Number(params?.size || '0');
    const viewQuery = JSON.parse(params?.queryString || '{}');
    const filterQuery = JSON.parse(params?.filters || '{}');
    const sorterQuery = JSON.parse(params?.sorter || '{}');

    let query: any = {};
    let order = [
      ['isPinned', 'DESC'],
      ['isDisabled', 'ASC'],
      ['status', 'ASC'],
      ['createdAt', 'DESC'],
    ];

    this.formatViewQuery(query, viewQuery);
    this.formatSearchText(query, searchText);
    this.formatFilterQuery(query, filterQuery);
    this.formatViewSort(order, viewQuery);

    if (sorterQuery) {
      const { field, type } = sorterQuery;
      if (field && type) {
        order.unshift([field, type]);
      }
    }
    let condition: any = {
      where: query,
      order: order,
    };
    if (page && size) {
      condition.offset = (page - 1) * size;
      condition.limit = size;
    }
    try {
      const result = await CrontabModel.findAll(condition);
      const count = await CrontabModel.count({ where: query });
      return { data: result, total: count };
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
      const absolutePath = path.resolve(config.logPath, `${doc.log_path}`);
      const logFileExist = doc.log_path && (await fileExist(absolutePath));

      const endTime = dayjs();
      const diffTimeStr = doc.last_execution_time
        ? `，耗时 ${endTime.diff(
            dayjs(doc.last_execution_time * 1000),
            'second',
          )}`
        : '';
      if (logFileExist) {
        const str = err ? `\n${err}` : '';
        fs.appendFileSync(
          `${absolutePath}`,
          `${str}\n## 执行结束... ${endTime.format(
            'YYYY-MM-DD HH:mm:ss',
          )}${diffTimeStr}${LOG_END_SYMBOL}`,
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
        pids = pids.slice(0, 3);
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
      const absolutePath = path.resolve(config.logPath, `${log_path}`);
      const logFileExist = log_path && (await fileExist(absolutePath));

      this.logger.silly('Running job');
      this.logger.silly('ID: ' + id);
      this.logger.silly('Original command: ' + command);

      let cmdStr = command;
      if (!cmdStr.includes('task ') && !cmdStr.includes('ql ')) {
        cmdStr = `task ${cmdStr}`;
      }
      if (
        cmdStr.endsWith('.js') ||
        cmdStr.endsWith('.py') ||
        cmdStr.endsWith('.pyc') ||
        cmdStr.endsWith('.sh') ||
        cmdStr.endsWith('.ts')
      ) {
        cmdStr = `${cmdStr} now`;
      }

      const cp = spawn(`ID=${id} ${cmdStr}`, { shell: '/bin/bash' });

      await CrontabModel.update(
        { status: CrontabStatus.running, pid: cp.pid },
        { where: { id } },
      );
      cp.stderr.on('data', (data) => {
        if (logFileExist) {
          fs.appendFileSync(`${absolutePath}`, `${data.toString()}`);
        }
      });
      cp.on('error', (err) => {
        if (logFileExist) {
          fs.appendFileSync(`${absolutePath}`, `${JSON.stringify(err)}`);
        }
      });

      cp.on('exit', async (code, signal) => {
        this.logger.info(
          `任务 ${command} 进程id: ${cp.pid} 退出，退出码 ${code}`,
        );
      });
      cp.on('close', async (code) => {
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

    const absolutePath = path.resolve(config.logPath, `${doc.log_path}`);
    const logFileExist = doc.log_path && (await fileExist(absolutePath));
    if (logFileExist) {
      return getFileContentByName(`${absolutePath}`);
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

  private getKey(command: string): string {
    const start =
      command.lastIndexOf('/') !== -1 ? command.lastIndexOf('/') + 1 : 0;
    const end =
      command.lastIndexOf('.') !== -1
        ? command.lastIndexOf('.')
        : command.length;

    const tmpStr = command.substring(0, start - 1);
    let index = 0;
    if (tmpStr.lastIndexOf('/') !== -1 && tmpStr.startsWith('http')) {
      index = tmpStr.lastIndexOf('/');
    } else if (tmpStr.lastIndexOf(':') !== -1 && tmpStr.startsWith('git@')) {
      index = tmpStr.lastIndexOf(':');
    }
    if (index) {
      return `${tmpStr.substring(index + 1)}_${command.substring(start, end)}`;
    } else {
      return command.substring(start, end);
    }
  }

  private make_command(tab: Crontab) {
    const crontab_job_string = `ID=${tab.id} ${tab.command}`;
    return crontab_job_string;
  }

  private async set_crontab(needReloadSchedule: boolean = false) {
    const tabs = await this.crontabs();
    var crontab_string = '';
    tabs.data.forEach((tab) => {
      const _schedule = tab.schedule && tab.schedule.split(/ +/);
      if (tab.isDisabled === 1 || _schedule!.length !== 5) {
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
      const lines = stdout.split('\n');
      const namePrefix = new Date().getTime();

      lines.reverse().forEach(async (line, index) => {
        line = line.replace(/\t+/g, ' ');
        const regex =
          /^((\@[a-zA-Z]+\s+)|(([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+))/;
        const command = line.replace(regex, '').trim();
        const schedule = line.replace(command, '').trim();

        if (
          command &&
          schedule &&
          cron_parser.parseExpression(schedule).hasNext()
        ) {
          const name = namePrefix + '_' + index;

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

import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import { Crontab, CrontabModel, CrontabStatus } from '../data/cron';
import { exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import cron_parser from 'cron-parser';
import {
  getFileContentByName,
  concurrentRun,
  fileExist,
  killTask,
} from '../config/util';
import { promises, existsSync } from 'fs';
import { Op, where, col as colFn } from 'sequelize';
import path from 'path';
import { TASK_PREFIX, QL_PREFIX } from '../config/const';

@Service()
export default class CronService {
  constructor(@Inject('logger') private logger: winston.Logger) { }

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
    await this.set_crontab();
    return doc;
  }

  public async insert(payload: Crontab): Promise<Crontab> {
    return await CrontabModel.create(payload, { returning: true });
  }

  public async update(payload: Crontab): Promise<Crontab> {
    payload.saved = false;
    const newDoc = await this.updateDb(payload);
    await this.set_crontab();
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
    await this.set_crontab();
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
      const primaryOperate = viewQuery.filterRelation === 'or' ? Op.or : Op.and;
      if (!query[primaryOperate]) {
        query[primaryOperate] = [];
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
            [Op.or]: [
              {
                [operate2]: [
                  { [operate]: `%${value}%` },
                  { [operate]: `%${encodeURIComponent(value)}%` },
                ],
              },
              {
                [operate2]: [
                  where(colFn(property), operate, `%${value}%`),
                  where(
                    colFn(property),
                    operate,
                    `%${encodeURIComponent(value)}%`,
                  ),
                ],
              },
            ],
          };
        }
        query[primaryOperate].push(q);
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
          await killTask(doc.pid);
        } catch (error) {
          this.logger.silly(error);
        }
      }
    }

    await CrontabModel.update(
      { status: CrontabStatus.idle, pid: undefined },
      { where: { id: ids } },
    );
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
      if (!cmdStr.startsWith(TASK_PREFIX) && !cmdStr.startsWith(QL_PREFIX)) {
        cmdStr = `${TASK_PREFIX}${cmdStr}`;
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
    await this.set_crontab();
  }

  public async enabled(ids: number[]) {
    await CrontabModel.update({ isDisabled: 0 }, { where: { id: ids } });
    await this.set_crontab();
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
    } else {
      return '任务未运行或运行失败，请尝试手动运行';
    }
  }

  public async logs(id: number) {
    const doc = await this.getDb({ id });
    if (!doc || !doc.log_path) {
      return [];
    }

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
    } else {
      return [];
    }

  }

  private make_command(tab: Crontab) {
    if (
      !tab.command.startsWith(TASK_PREFIX) &&
      !tab.command.startsWith(QL_PREFIX)
    ) {
      tab.command = `${TASK_PREFIX}${tab.command}`;
    }
    const crontab_job_string = `ID=${tab.id} ${tab.command}`;
    return crontab_job_string;
  }

  private async set_crontab() {
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
    exec(`pm2 reload schedule`);
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

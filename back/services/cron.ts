import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import { Crontab, CrontabModel, CrontabStatus } from '../data/cron';
import { exec, execSync } from 'child_process';
import fs from 'fs/promises';
import cron_parser from 'cron-parser';
import {
  getFileContentByName,
  fileExist,
  killTask,
  getUniqPath,
  safeJSONParse,
  isDemoEnv,
} from '../config/util';
import { Op, where, col as colFn, FindOptions, fn, Order } from 'sequelize';
import path from 'path';
import { TASK_PREFIX, QL_PREFIX } from '../config/const';
import cronClient from '../schedule/client';
import taskLimit from '../shared/pLimit';
import { spawn } from 'cross-spawn';
import dayjs from 'dayjs';
import pickBy from 'lodash/pickBy';
import omit from 'lodash/omit';
import { writeFileWithLock } from '../shared/utils';
import { ScheduleType } from '../interface/schedule';

@Service()
export default class CronService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  private isNodeCron(cron: Crontab) {
    const { schedule, extra_schedules } = cron;
    if (Number(schedule?.split(/ +/).length) > 5 || extra_schedules?.length) {
      return true;
    }
    return false;
  }

  private isOnceSchedule(schedule?: string) {
    return schedule?.startsWith(ScheduleType.ONCE);
  }

  private isBootSchedule(schedule?: string) {
    return schedule?.startsWith(ScheduleType.BOOT);
  }

  private isSpecialSchedule(schedule?: string) {
    return this.isOnceSchedule(schedule) || this.isBootSchedule(schedule);
  }

  public async create(payload: Crontab): Promise<Crontab> {
    const tab = new Crontab(payload);
    tab.saved = false;
    const doc = await this.insert(tab);

    if (isDemoEnv()) {
      return doc;
    }

    if (this.isNodeCron(doc) && !this.isSpecialSchedule(doc.schedule)) {
      await cronClient.addCron([
        {
          name: doc.name || '',
          id: String(doc.id),
          schedule: doc.schedule!,
          command: this.makeCommand(doc),
          extra_schedules: doc.extra_schedules || [],
        },
      ]);
    }

    await this.setCrontab();
    return doc;
  }

  public async insert(payload: Crontab): Promise<Crontab> {
    return await CrontabModel.create(payload, { returning: true });
  }

  public async update(payload: Partial<Crontab>): Promise<Crontab> {
    const doc = await this.getDb({ id: payload.id });
    const tab = new Crontab({ ...doc, ...payload });
    tab.saved = false;
    const newDoc = await this.updateDb(tab);

    if (doc.isDisabled === 1 || isDemoEnv()) {
      return newDoc;
    }

    if (this.isNodeCron(doc)) {
      await cronClient.delCron([String(doc.id)]);
    }

    if (this.isNodeCron(newDoc) && !this.isSpecialSchedule(newDoc.schedule)) {
      await cronClient.addCron([
        {
          name: doc.name || '',
          id: String(newDoc.id),
          schedule: newDoc.schedule!,
          command: this.makeCommand(newDoc),
          extra_schedules: newDoc.extra_schedules || [],
        },
      ]);
    }

    await this.setCrontab();
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
    let options: any = {
      status,
      pid,
      log_path,
      last_execution_time,
    };
    if (last_running_time > 0) {
      options.last_running_time = last_running_time;
    }

    for (const id of ids) {
      let cron;
      try {
        cron = await this.getDb({ id });
      } catch (err) {}
      if (!cron) {
        continue;
      }
      if (status === CrontabStatus.idle && log_path !== cron.log_path) {
        options = omit(options, ['status', 'log_path', 'pid']);
      }
      await CrontabModel.update(
        { ...pickBy(options, (v) => v === 0 || !!v) },
        { where: { id } },
      );
    }
  }

  public async remove(ids: number[]) {
    await CrontabModel.destroy({ where: { id: ids } });
    await cronClient.delCron(ids.map(String));
    await this.setCrontab();
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
        let operate2: any = null;
        let operate: any = null;
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
            if (
              property === 'status' &&
              !value.includes(CrontabStatus.disabled)
            ) {
              q[Op.and] = [
                { [property]: Array.isArray(value) ? value : [value] },
                { isDisabled: 0 },
              ];
            } else {
              q[Op.or] = [
                {
                  [property]: Array.isArray(value) ? value : [value],
                },
                property === 'status' && value.includes(CrontabStatus.disabled)
                  ? { isDisabled: 1 }
                  : {},
              ];
            }
            break;
          case 'Nin':
            q[Op.and] = [
              {
                [Op.or]: [
                  {
                    [property]: {
                      [Op.notIn]: Array.isArray(value) ? value : [value],
                    },
                  },
                  {
                    [property]: { [Op.is]: null },
                  },
                ],
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
                  { [operate]: `%${encodeURI(value)}%` },
                ],
              },
              {
                [operate2]: [
                  where(colFn(property), operate, `%${value}%`),
                  where(colFn(property), operate, `%${encodeURI(value)}%`),
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
              { [Op.like]: `%${encodeURI(textArray[1])}%` },
            ],
          };
          break;
        default:
          const reg = {
            [Op.or]: [
              { [Op.like]: `%${searchText}%` },
              { [Op.like]: `%${encodeURI(searchText)}%` },
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
        if (!filterQuery[key]) continue;
        if (key === 'status') {
          if (filterQuery[key].includes(CrontabStatus.disabled)) {
            q = { [Op.or]: [{ [key]: filterQuery[key] }, { isDisabled: 1 }] };
          } else {
            q = { [Op.and]: [{ [key]: filterQuery[key] }, { isDisabled: 0 }] };
          }
        } else {
          q[key] = filterQuery[key];
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

  public async find({
    log_path,
  }: {
    log_path: string;
  }): Promise<Crontab | undefined> {
    try {
      const result = await CrontabModel.findOne({ where: { log_path } });
      return result?.get({ plain: true });
    } catch (error) {
      throw error;
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
    const viewQuery = safeJSONParse(params?.queryString);
    const filterQuery = safeJSONParse(params?.filters);
    const sorterQuery = safeJSONParse(params?.sorter);

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
    let condition: FindOptions<Crontab> = {
      where: query,
      order: order as Order,
    };
    if (page && size) {
      condition.offset = (page - 1) * size;
      condition.limit = size;
    }
    try {
      const result = await CrontabModel.findAll(condition);
      const count = await CrontabModel.count({ where: query });
      return { data: result.map((x) => x.get({ plain: true })), total: count };
    } catch (error) {
      throw error;
    }
  }

  public async getDb(query: FindOptions<Crontab>['where']): Promise<Crontab> {
    const doc: any = await CrontabModel.findOne({ where: { ...query } });
    if (!doc) {
      throw new Error(`Cron ${JSON.stringify(query)} not found`);
    }
    return doc.get({ plain: true });
  }

  public async run(ids: number[]) {
    await CrontabModel.update(
      { status: CrontabStatus.queued },
      { where: { id: ids } },
    );
    ids.forEach((id) => {
      this.runSingle(id);
    });
  }

  public async stop(ids: number[]) {
    const docs = await CrontabModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      if (doc.pid) {
        try {
          await killTask(doc.pid);
        } catch (error) {
          this.logger.error(error);
        }
      }
    }

    await CrontabModel.update(
      { status: CrontabStatus.idle, pid: undefined },
      { where: { id: ids } },
    );
  }

  private async runSingle(cronId: number): Promise<number | void> {
    return taskLimit.manualRunWithCronLimit(() => {
      return new Promise(async (resolve: any) => {
        const cron = await this.getDb({ id: cronId });
        const params = {
          name: cron.name,
          command: cron.command,
          schedule: cron.schedule,
          extra_schedules: cron.extra_schedules,
        };
        if (cron.status !== CrontabStatus.queued) {
          resolve(params);
          return;
        }

        this.logger.info(
          `[panel][开始执行任务] 参数: ${JSON.stringify(params)}`,
        );

        let { id, command, log_path } = cron;
        const uniqPath = await getUniqPath(command, `${id}`);
        const logTime = dayjs().format('YYYY-MM-DD-HH-mm-ss-SSS');
        const logDirPath = path.resolve(config.logPath, `${uniqPath}`);
        if (log_path?.split('/')?.every((x) => x !== uniqPath)) {
          await fs.mkdir(logDirPath, { recursive: true });
        }
        const logPath = `${uniqPath}/${logTime}.log`;
        const absolutePath = path.resolve(config.logPath, `${logPath}`);
        const cp = spawn(
          `real_log_path=${logPath} no_delay=true ${this.makeCommand(
            cron,
            true,
          )}`,
          { shell: '/bin/bash' },
        );

        await CrontabModel.update(
          { status: CrontabStatus.running, pid: cp.pid, log_path: logPath },
          { where: { id } },
        );
        cp.stdout.on('data', async (data) => {
          await fs.appendFile(absolutePath, data.toString());
        });
        cp.stderr.on('data', async (data) => {
          this.logger.info(
            '[panel][执行任务失败] 命令: %s, 错误信息: %j',
            command,
            data.toString(),
          );
          await fs.appendFile(absolutePath, data.toString());
        });
        cp.on('error', async (err) => {
          this.logger.error(
            '[panel][创建任务失败] 命令: %s, 错误信息: %j',
            command,
            err,
          );
          await fs.appendFile(absolutePath, JSON.stringify(err));
        });

        cp.on('exit', async (code) => {
          this.logger.info(
            '[panel][执行任务结束] 参数: %s, 退出码: %j',
            JSON.stringify(params),
            code,
          );
          await CrontabModel.update(
            { status: CrontabStatus.idle, pid: undefined },
            { where: { id } },
          );
          resolve({ ...params, pid: cp.pid, code });
        });
      });
    });
  }

  public async disabled(ids: number[]) {
    await CrontabModel.update({ isDisabled: 1 }, { where: { id: ids } });
    await cronClient.delCron(ids.map(String));
    await this.setCrontab();
  }

  public async enabled(ids: number[]) {
    await CrontabModel.update({ isDisabled: 0 }, { where: { id: ids } });
    const docs = await CrontabModel.findAll({ where: { id: ids } });
    const sixCron = docs
      .filter((x) => this.isNodeCron(x) && !this.isSpecialSchedule(x.schedule))
      .map((doc) => ({
        name: doc.name || '',
        id: String(doc.id),
        schedule: doc.schedule!,
        command: this.makeCommand(doc),
        extra_schedules: doc.extra_schedules || [],
      }));

    if (isDemoEnv()) {
      return;
    }
    await cronClient.addCron(sixCron);
    await this.setCrontab();
  }

  public async log(id: number) {
    const doc = await this.getDb({ id });
    if (!doc) {
      return '';
    }

    const absolutePath = path.resolve(config.logPath, `${doc.log_path}`);
    const logFileExist = doc.log_path && (await fileExist(absolutePath));
    if (logFileExist) {
      return await getFileContentByName(`${absolutePath}`);
    } else {
      return typeof doc.status === 'number' &&
        [CrontabStatus.queued, CrontabStatus.running].includes(doc.status)
        ? '运行中...'
        : '日志不存在...';
    }
  }

  public async logs(id: number) {
    const doc = await this.getDb({ id });
    if (!doc || !doc.log_path) {
      return [];
    }

    const relativeDir = path.dirname(`${doc.log_path}`);
    const dir = path.resolve(config.logPath, relativeDir);
    const dirExist = await fileExist(dir);
    if (dirExist) {
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
    } else {
      return [];
    }
  }

  private makeCommand(tab: Crontab, realTime?: boolean) {
    let command = tab.command.trim();
    if (!command.startsWith(TASK_PREFIX) && !command.startsWith(QL_PREFIX)) {
      command = `${TASK_PREFIX}${tab.command}`;
    }
    let commandVariable = `real_time=${Boolean(realTime)} no_tee=true ID=${
      tab.id
    } `;
    if (tab.task_before) {
      commandVariable += `task_before='${tab.task_before
        .replace(/'/g, "'\\''")
        .replace(/;? *\n/g, ';')
        .trim()}' `;
    }
    if (tab.task_after) {
      commandVariable += `task_after='${tab.task_after
        .replace(/'/g, "'\\''")
        .replace(/;? *\n/g, ';')
        .trim()}' `;
    }

    const crontab_job_string = `${commandVariable}${command}`;
    return crontab_job_string;
  }

  private async setCrontab(data?: { data: Crontab[]; total: number }) {
    const tabs = data ?? (await this.crontabs());
    var crontab_string = '';
    tabs.data.forEach((tab) => {
      if (
        tab.isDisabled === 1 ||
        this.isNodeCron(tab) ||
        this.isSpecialSchedule(tab.schedule)
      ) {
        crontab_string += '# ';
        crontab_string += tab.schedule;
        crontab_string += ' ';
        crontab_string += this.makeCommand(tab);
        crontab_string += '\n';
      } else {
        crontab_string += tab.schedule;
        crontab_string += ' ';
        crontab_string += this.makeCommand(tab);
        crontab_string += '\n';
      }
    });

    await writeFileWithLock(config.crontabFile, crontab_string);

    execSync(`crontab ${config.crontabFile}`);
    await CrontabModel.update({ saved: true }, { where: {} });
  }

  public importCrontab() {
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

  public async autosave_crontab() {
    const tabs = await this.crontabs();
    const regularCrons = tabs.data
      .filter(
        (x) =>
          x.isDisabled !== 1 &&
          this.isNodeCron(x) &&
          !this.isSpecialSchedule(x.schedule),
      )
      .map((doc) => ({
        name: doc.name || '',
        id: String(doc.id),
        schedule: doc.schedule!,
        command: this.makeCommand(doc),
        extra_schedules: doc.extra_schedules || [],
      }));

    if (isDemoEnv()) {
      await writeFileWithLock(config.crontabFile, '');
      return;
    }
    await cronClient.addCron(regularCrons);
    this.setCrontab(tabs);
  }

  public async bootTask() {
    const tabs = await this.crontabs();
    const bootTasks = tabs.data.filter(
      (x) => !x.isDisabled && this.isBootSchedule(x.schedule),
    );
    if (bootTasks.length > 0) {
      await CrontabModel.update(
        { status: CrontabStatus.queued },
        { where: { id: bootTasks.map((t) => t.id!) } },
      );
      for (const task of bootTasks) {
        await this.runSingle(task.id!);
      }
    }
  }
}

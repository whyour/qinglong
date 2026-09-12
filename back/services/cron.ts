import { randomUUID } from 'crypto';
import {
  withSchedulerMutation,
  schedulerRegistrationError,
} from '../shared/schedulerMutationLock';
import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import { Crontab, CrontabModel, CrontabStatus } from '../data/cron';
import {
  RunningInstanceModel,
  InstanceStatus,
} from '../data/runningInstance';
import { exec, execSync } from 'child_process';
import fs from 'fs/promises';
import CronExpressionParser from 'cron-parser';
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
import { t } from '../shared/i18n';
import { ScheduleType } from '../interface/schedule';
import { logStreamManager } from '../shared/logStreamManager';
import { observeChildProcess, asError } from '../shared/childProcess';
import { isEmpty } from 'lodash';
import { LogReadOptions, readLogChunk } from '../shared/logReader';
import { resolveFileAccess } from '../shared/fileAccess';

@Service()
export default class CronService {
  constructor(@Inject('logger') private logger: winston.Logger) { }

  private isNodeCron(cron: Crontab) {
    const { schedule, extra_schedules } = cron;
    if (Number(schedule?.split(/ +/).length) > 5 || extra_schedules?.length) {
      return true;
    }
    return false;
  }

  private get schedulerMode(): 'system' | 'node' {
    const env = process.env.QL_SCHEDULER;
    if (env === 'system') return 'system';
    if (env === 'node') return 'node';
    try {
      execSync('which crond', { stdio: 'ignore' });
      return 'system';
    } catch {
      return 'node';
    }
  }

  private shouldUseCronClient(cron: Crontab): boolean {
    if (this.schedulerMode === 'node') {
      return !this.isSpecialSchedule(cron.schedule);
    }
    return this.isNodeCron(cron) && !this.isSpecialSchedule(cron.schedule);
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

  private async getLogName(cron: Crontab) {
    const { log_name, command, id } = cron;
    if (log_name === '/dev/null') {
      return log_name;
    }
    let uniqPath = await getUniqPath(command, `${id}`);
    if (log_name) {
      const normalizedLogName = log_name.startsWith('/')
        ? log_name
        : path.join(config.logPath, log_name);
      if (normalizedLogName.startsWith(config.logPath)) {
        uniqPath = log_name;
      }
    }
    const logDirPath = path.resolve(config.logPath, `${uniqPath}`);
    await fs.mkdir(logDirPath, { recursive: true });
    return uniqPath;
  }

  public async create(payload: Crontab): Promise<Crontab> {
    return withSchedulerMutation(async () => {
      const tab = new Crontab(payload);
      tab.saved = false;
      tab.log_name = await this.getLogName(tab);
      const doc = await this.insert(tab);

      if (isDemoEnv()) {
        return doc;
      }

      if (this.shouldUseCronClient(doc)) {
        try {
          await cronClient.addCron([
            {
              name: doc.name || '',
              id: String(doc.id),
              schedule: doc.schedule!,
              command: this.makeCommand(doc),
              extra_schedules: doc.extra_schedules || [],
            },
          ]);
        } catch (error: any) {
          // gRPC 注册失败时回滚 DB 记录，避免产生"僵尸任务"
          // （DB 和 crontab.list 有记录但调度器永远不会执行）
          await CrontabModel.destroy({ where: { id: doc.id } });
          this.logger.error(
            '[crontab] Failed to register cron job in scheduler, task creation rolled back:',
            error?.message || error,
          );
          throw schedulerRegistrationError(
            `${t('调度器注册失败，任务创建已回滚')}: ${(error as any)?.details || error?.message}`,
            error,
          );
        }
      }

      await this.setCrontab();
      return doc;
    });
  }

  public async insert(payload: Crontab): Promise<Crontab> {
    return await CrontabModel.create(payload, { returning: true });
  }

  public async update(payload: Partial<Crontab>): Promise<Crontab> {
    return withSchedulerMutation(async () => {
      const doc = await this.getDb({ id: payload.id });
      const tab = new Crontab({ ...doc, ...payload });
      tab.saved = false;
      tab.log_name = await this.getLogName(tab);
      const newDoc = await this.updateDb(tab);

      if (doc.isDisabled === 1 || isDemoEnv()) {
        return newDoc;
      }

      try {
        await cronClient.delCron([String(newDoc.id)]);
      } catch (error: any) {
        this.logger.warn(
          '[crontab] Failed to unregister cron job in scheduler:',
          error?.message || error,
        );
      }

      if (this.shouldUseCronClient(newDoc)) {
        try {
          await cronClient.addCron([
            {
              name: doc.name || '',
              id: String(newDoc.id),
              schedule: newDoc.schedule!,
              command: this.makeCommand(newDoc),
              extra_schedules: newDoc.extra_schedules || [],
            },
          ]);
        } catch (error: any) {
          // gRPC 注册新任务失败 → 回滚 DB 到旧数据，并尝试恢复旧调度注册
          await CrontabModel.update(omit(doc, ['queued_token']), {
            where: { id: doc.id },
          });
          if (this.shouldUseCronClient(doc)) {
            try {
              await cronClient.addCron([
                {
                  name: doc.name || '',
                  id: String(doc.id),
                  schedule: doc.schedule!,
                  command: this.makeCommand(doc),
                  extra_schedules: doc.extra_schedules || [],
                },
              ]);
            } catch (_recoveryError: any) {
              this.logger.warn(
                '[crontab] Failed to restore old cron job in scheduler after rollback:',
                _recoveryError?.message || _recoveryError,
              );
            }
          }
          this.logger.error(
            '[crontab] Failed to register updated cron job in scheduler, update rolled back:',
            error?.message || error,
          );
          throw schedulerRegistrationError(
            `${t('调度器注册失败，任务更新已回滚')}: ${(error as any)?.details || error?.message}`,
            error,
          );
        }
      }

      await this.setCrontab();
      return newDoc;
    });
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
    exit_code,
  }: {
    ids: number[];
    status: CrontabStatus;
    pid: number;
    log_path: string;
    last_running_time: number;
    last_execution_time: number;
    exit_code?: number;
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
      } catch (err) { }
      if (!cron) {
        continue;
      }
      if (status === CrontabStatus.idle && log_path !== cron.log_path) {
        options = omit(options, ['status', 'log_path', 'pid']);
      }

      // Manage RunningInstance records for status transitions from shell scripts
      if (status === CrontabStatus.running) {
        // Create a new running instance record
        await RunningInstanceModel.create({
          cron_id: id,
          pid: pid || undefined,
          log_path: log_path || undefined,
          started_at: last_execution_time || dayjs().unix(),
          status: InstanceStatus.running,
        });
      } else if (status === CrontabStatus.idle) {
        // Mark the matching running instance as finished
        const finishedAt = dayjs().unix();
        const instanceStatus =
          exit_code !== undefined && exit_code !== null && exit_code !== 0
            ? InstanceStatus.error
            : InstanceStatus.finished;
        await RunningInstanceModel.update(
          {
            finished_at: finishedAt,
            status: instanceStatus,
            exit_code: exit_code ?? undefined,
          },
          {
            where: {
              cron_id: id,
              pid: pid || undefined,
              status: InstanceStatus.running,
            },
          },
        );
      }

      await CrontabModel.update(
        { ...pickBy(options, (v) => v === 0 || !!v) },
        { where: { id } },
      );
    }
  }

  public async remove(ids: number[]) {
    return withSchedulerMutation(async () => {
      await CrontabModel.destroy({ where: { id: ids } });
      try {
        await cronClient.delCron(ids.map(String));
      } catch (error: any) {
        this.logger.warn(
          '[crontab] Failed to unregister cron job in scheduler:',
          error?.message || error,
        );
      }
      await this.setCrontab();
    });
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
    if (!isEmpty(filterQuery)) {
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
    const queuedToken = randomUUID();
    await CrontabModel.update(
      { status: CrontabStatus.queued, queued_token: queuedToken },
      { where: { id: ids } },
    );
    ids.forEach((id) => {
      this.runSingle(id, queuedToken);
    });
  }

  public async stop(ids: number[]) {
    const docs = await CrontabModel.findAll({ where: { id: ids } });
    // Cancel the queued snapshot first, so a late spawn cannot claim it.
    for (const doc of docs) {
      if (doc.status === CrontabStatus.queued) {
        const [cancelled] = await CrontabModel.update(
          { status: CrontabStatus.idle, pid: null, queued_token: null } as any,
          {
            where: {
              id: doc.id,
              status: CrontabStatus.queued,
              [Op.and]: [
                where(colFn('log_path'), { [Op.eq]: doc.log_path ?? null }),
                where(colFn('queued_token'), {
                  [Op.eq]: doc.queued_token ?? null,
                }),
              ],
            },
          }
        );
        // A concurrent claim may have won; capture its PID before signalling.
        if (!cancelled) await doc.reload();
      }
    }
    const stoppingInstances = await RunningInstanceModel.findAll({
      attributes: ['id', 'pid', 'cron_id'],
      where: { cron_id: ids, status: InstanceStatus.running },
    });
    const targets = new Set<number>(
      [
        ...stoppingInstances.map((instance) => instance.pid),
        ...docs
          .filter((doc) => doc.status === CrontabStatus.running)
          .map((doc) => doc.pid),
      ].filter((pid): pid is number => typeof pid === 'number' && pid > 0)
    );
    const stopped = new Set<number>();
    for (const pid of targets) {
      try {
        await killTask(pid, true);
        stopped.add(pid);
      } catch (error) {
        this.logger.error(
          '[panel][停止任务失败] PID: %s, 错误: %s',
          pid,
          asError(error).message
        );
      }
    }
    const stoppedIds = stoppingInstances
      .filter((instance) => instance.pid && stopped.has(instance.pid))
      .map((instance) => instance.id!);
    if (stoppedIds.length) {
      await RunningInstanceModel.update(
        { status: InstanceStatus.stopped, finished_at: dayjs().unix() },
        { where: { id: stoppedIds } }
      );
    }
    for (const doc of docs) {
      if (
        doc.status !== CrontabStatus.running ||
        (doc.pid && !stopped.has(doc.pid))
      )
        continue;
      const remaining = await RunningInstanceModel.count({
        where: { cron_id: doc.id, status: InstanceStatus.running },
      });
      if (remaining) continue;
      await CrontabModel.update(
        { status: CrontabStatus.idle, pid: null, queued_token: null } as any,
        {
          where: {
            id: doc.id,
            status: CrontabStatus.running,
            [Op.and]: [
              where(colFn('queued_token'), { [Op.eq]: doc.queued_token ?? null }),
              where(colFn('pid'), { [Op.eq]: doc.pid ?? null }),
              where(colFn('log_path'), { [Op.eq]: doc.log_path ?? null }),
            ],
          },
        }
      );
    }
  }

  public async stopInstance(instanceId: number) {
    const instance = await RunningInstanceModel.findOne({
      where: { id: instanceId, status: InstanceStatus.running },
    });
    if (!instance) {
      return { code: 400, message: t('实例不存在或已停止') };
    }
    if (instance.pid) {
      try {
        await killTask(instance.pid);
      } catch (error) {
        this.logger.error(
          `[panel][停止实例失败] 实例ID: ${instanceId}, PID: ${instance.pid}, 错误: ${error}`,
        );
      }
    }
    await RunningInstanceModel.update(
      { status: InstanceStatus.stopped, finished_at: dayjs().unix(), exit_code: 143 },
      { where: { id: instanceId } },
    );

    // Check if there are still other running instances for this cron
    const otherRunning = await RunningInstanceModel.count({
      where: { cron_id: instance.cron_id, status: InstanceStatus.running },
    });
    if (otherRunning === 0) {
      await CrontabModel.update(
        { status: CrontabStatus.idle, pid: undefined },
        { where: { id: instance.cron_id } },
      );
    }
    return { code: 200, message: t('实例已停止') };
  }

  private async runSingle(
    cronId: number,
    expectedToken?: string,
  ): Promise<number | void> {
    return taskLimit.manualRunWithCronLimit(async () => {
      let absolutePath: string | undefined;
      let logPath: string | undefined;
      let queuedLogPath: string | null | undefined;
      let queuedToken: string | null = null;
      let claimed = false;
      try {
        const cron = await this.getDb({ id: cronId });
        if (
          cron.status !== CrontabStatus.queued ||
          (expectedToken !== undefined && cron.queued_token !== expectedToken)
        ) return;
        queuedToken = cron.queued_token ?? null;
        queuedLogPath = cron.log_path ?? null;
        const { id, command, log_name } = cron;
        const uniqPath =
          log_name === '/dev/null' || !log_name
            ? await getUniqPath(command, `${id}`)
            : log_name;
        const logTime = dayjs().format('YYYY-MM-DD-HH-mm-ss-SSS');
        logPath = `${uniqPath}/${logTime}.log`;
        absolutePath = resolveFileAccess(config.logPath, [logPath]);
        if (!absolutePath)
          throw new Error('Log path is outside the log directory');
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        const outputPath = absolutePath;
        const cp = spawn(
          `real_log_path=${logPath} no_delay=true ${this.makeCommand(
            cron,
            true
          )}`,
          { shell: '/bin/bash' }
        );
        // Install observers before the first await: very short children may already exit.
        const { completed } = observeChildProcess(cp, {
          onStart: async () => {
            try {
              const [count] = await CrontabModel.update(
                {
                  status: CrontabStatus.running,
                  pid: cp.pid,
                  log_path: logPath,
                },
                {
                  where: {
                    id,
                    status: CrontabStatus.queued,
                    [Op.and]: [
                      where(colFn('queued_token'), { [Op.eq]: queuedToken }),
                      where(colFn('log_path'), { [Op.eq]: queuedLogPath }),
                    ],
                  },
                }
              );
              if (count !== 1)
                throw new Error(
                  'Task was stopped or superseded before startup'
                );
              claimed = true;
            } catch (error) {
              if (cp.pid) await killTask(cp.pid, true);
              throw error;
            }
          },
          onStdout: (message) => logStreamManager.write(outputPath, message),
          onStderr: (message) => logStreamManager.write(outputPath, message),
        });
        const result = await completed;
        if (result.error) {
          this.logger.error(
            '[panel][执行任务失败] 任务ID: %s, 错误: %s',
            id,
            result.error.message
          );
        }
        this.logger.info(
          '[panel][执行任务结束] 任务ID: %s, 退出码: %j',
          id,
          result.code
        );
        return { ...cron, pid: cp.pid, ...result } as any;
      } catch (error) {
        this.logger.error(
          '[panel][创建任务失败] 任务ID: %s, 错误: %s',
          cronId,
          asError(error).message
        );
      } finally {
        try {
          if (absolutePath) await logStreamManager.closeStream(absolutePath);
        } catch (error) {
          this.logger.error(
            '[panel][关闭任务日志失败] %s',
            asError(error).message
          );
        }
        try {
          // Do not overwrite a newer run's state or its script-reported exit code.
          await CrontabModel.update(
            { status: CrontabStatus.idle, pid: null, queued_token: null } as any,
            {
              where: {
                id: cronId,
                [Op.and]: where(colFn('queued_token'), { [Op.eq]: queuedToken }),
                [Op.or]: [
                  ...(queuedLogPath !== undefined && !claimed
                    ? [
                        {
                          status: CrontabStatus.queued,
                          [Op.and]: where(colFn('log_path'), {
                            [Op.eq]: queuedLogPath,
                          }),
                        },
                      ]
                    : []),
                  ...(claimed && logPath
                    ? [{ log_path: logPath, status: CrontabStatus.running }]
                    : []),
                ],
              },
            }
          );
        } catch (error) {
          this.logger.error(
            '[panel][清理任务状态失败] %s',
            asError(error).message
          );
        }
      }
    });
  }

  public async disabled(ids: number[]) {
    return withSchedulerMutation(async () => {
      await CrontabModel.update({ isDisabled: 1 }, { where: { id: ids } });
      try {
        await cronClient.delCron(ids.map(String));
      } catch (error: any) {
        this.logger.warn(
          '[crontab] Failed to unregister cron job in scheduler:',
          error?.message || error,
        );
      }
      await this.setCrontab();
    });
  }

  public async enabled(ids: number[]) {
    return withSchedulerMutation(async () => {
      await CrontabModel.update({ isDisabled: 0 }, { where: { id: ids } });
      const docs = await CrontabModel.findAll({ where: { id: ids } });
      const crons = docs
        .filter((x) => this.shouldUseCronClient(x))
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

      try {
        await cronClient.addCron(crons);
      } catch (error: any) {
        // gRPC 注册失败 → 回滚启用状态，避免 DB 显示已启用但调度器未注册
        await CrontabModel.update({ isDisabled: 1 }, { where: { id: ids } });
        this.logger.error(
          '[crontab] Failed to register cron job in scheduler, enable rolled back:',
          error?.message || error,
        );
        throw schedulerRegistrationError(
          `${t('调度器注册失败，任务启用已回滚')}: ${(error as any)?.details || error?.message}`,
          error,
        );
      }
      await this.setCrontab();
    });
  }

  public async log(
    id: number,
    options: LogReadOptions = {},
  ): Promise<{
    content: string;
    status: string;
    offset: number;
    nextOffset: number;
    total: number;
    truncated: boolean;
  }> {
    const doc = await this.getDb({ id });
    if (!doc) {
      return {
        content: '',
        status: 'empty',
        offset: 0,
        nextOffset: 0,
        total: 0,
        truncated: false,
      };
    }
    if (doc.log_name === '/dev/null') {
      return {
        content: t('日志设置为忽略'),
        status: 'ignored',
        offset: 0,
        nextOffset: 0,
        total: 0,
        truncated: false,
      };
    }
    const absolutePath = path.resolve(config.logPath, `${doc.log_path}`);
    const logFileExist = doc.log_path && (await fileExist(absolutePath));
    if (logFileExist) {
      const chunk = await readLogChunk(`${absolutePath}`, options);
      const isRunning =
        typeof doc.status === 'number' &&
        [CrontabStatus.running, CrontabStatus.queued].includes(doc.status);
      return {
        ...chunk,
        status: isRunning ? 'running' : 'completed',
      };
    } else {
      const status =
        typeof doc.status === 'number' &&
        [CrontabStatus.queued, CrontabStatus.running].includes(doc.status)
          ? 'running'
          : 'notFound';
      return {
        content: status === 'running' ? t('运行中...') : t('日志不存在...'),
        status,
        offset: 0,
        nextOffset: 0,
        total: 0,
        truncated: false,
      };
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
            time: (await fs.lstat(`${dir}/${x}`)).birthtimeMs,
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
    let commandVariable = `real_time=${Boolean(realTime)} no_tee=true ID=${tab.id} `;
    // Only include log_name if it has a truthy value to avoid passing null/undefined to shell
    if (tab.log_name) {
      commandVariable += `log_name=${tab.log_name} `;
    }
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
    if (tab.work_dir) {
      commandVariable += `work_dir='${tab.work_dir.replace(/'/g, "'\\''")}' `;
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

    if (this.schedulerMode === 'system') {
      try {
        execSync(`crontab ${config.crontabFile}`);
      } catch (error: any) {
        const errorMsg = error.message || String(error);
        this.logger.error('[crontab] Failed to update system crontab:', errorMsg);
      }
    }

    await CrontabModel.update({ saved: true }, { where: {} });
  }

  public importCrontab() {
    exec('crontab -l', (error, stdout) => {
      if (error) {
        const errorMsg = error.message || String(error);
        this.logger.error('[crontab] Failed to read system crontab:', errorMsg);
      }

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
          CronExpressionParser.parse(schedule).hasNext()
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

  public async autosave_crontab(requireScheduler = false) {
    return withSchedulerMutation(async () => {
      const tabs = await this.crontabs();
      const regularCrons = tabs.data
        .filter(
          (x) =>
            x.isDisabled !== 1 &&
            this.shouldUseCronClient(x),
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

      // 先同步 crontab.list 与系统 crontab，确保其始终反映数据库真实状态。
      // gRPC 调度注册为尽力而为：失败时不阻断文件同步，调度器重启后会重新注册。
      // 这避免了因调度器短暂不可用导致 crontab.list 与数据库脱节（订阅更新误判任务已存在）。
      await this.setCrontab(tabs);
      try {
        await cronClient.addCron(regularCrons, requireScheduler);
      } catch (error: any) {
        this.logger.warn(
          '[crontab] Failed to register cron job in scheduler:',
          error?.message || error,
        );
        if (requireScheduler) throw error;
      }
    });
  }

  public async bootTask() {
    const tabs = await this.crontabs();
    const bootTasks = tabs.data.filter(
      (x) => !x.isDisabled && this.isBootSchedule(x.schedule),
    );
    if (bootTasks.length > 0) {
      await this.run(bootTasks.map((task) => task.id!));
    }
  }
}

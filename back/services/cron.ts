import { CronExecution } from '../cron/execution/cronExecution';
import {
  isNodeCron,
  schedulerMode,
  shouldUseCronClient,
  isOnceSchedule,
  isBootSchedule,
  isSpecialSchedule,
  makeCommand,
  nodeCron,
} from '../cron/scheduling/cronScheduling';
import { SystemCronAdapter } from '../cron/scheduling/systemCron';
import { cronOperand } from '../cron/execution/cronOperand';
import { PendingCronInstall } from '../shared/errors';
import { TriggerHistory } from '../cron/history';
import {
  getInvalidCronSchedules,
  isValidCronSchedule,
} from '../cron/scheduling/cronSchedule';
import {
  withSchedulerMutation,
  schedulerRegistrationError,
} from '../cron/scheduling/schedulerMutationLock';
import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import { resolveLogPath } from '../shared/logPath';
import { Crontab, CrontabModel, CrontabStatus } from '../data/cron';
import { exec } from 'child_process';
import fs from 'fs/promises';
import {
  getFileContentByName,
  getUniqPath,
  safeJSONParse,
  isDemoEnv,
} from '../config/util';
import {
  Op,
  where,
  col as colFn,
  literal,
  FindOptions,
  fn,
  Order,
} from 'sequelize';
import path from 'path';
import cronClient from '../schedule/client';
import dayjs from 'dayjs';
import pickBy from 'lodash/pickBy';
import { writeFileWithLock } from '../shared/utils';
import { t } from '../shared/i18n';
import { asError } from '../shared/childProcess';
import { isEmpty } from 'lodash';
import {
  CronLogReader,
  CronLogOptions,
  CronLogResult,
} from '../cron/queries/cronLog';
import { visibleStatus, visibleAttributes } from '../cron/queries/cronViews';

function statusFilter(
  values: CrontabStatus[],
  exclude: boolean,
  forDisplay: boolean,
) {
  const column = forDisplay ? visibleStatus : colFn('status');
  const disabled = values.includes(CrontabStatus.disabled);
  if (exclude) {
    return {
      [Op.and]: [
        {
          [Op.or]: [
            where(column, { [Op.notIn]: values }),
            where(column, { [Op.is]: null }),
          ],
        },
        ...(disabled ? [{ isDisabled: { [Op.ne]: 1 } }] : []),
      ],
    };
  }
  const matches = where(column, { [Op.in]: values });
  return disabled
    ? { [Op.or]: [matches, { isDisabled: 1 }] }
    : { [Op.and]: [matches, { isDisabled: 0 }] };
}

@Service()
export default class CronService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  // One coordinator per service preserves in-flight stop deduplication. Late-bound
  // callbacks keep existing service overrides and execution entry points intact.
  private readonly execution: CronExecution = new CronExecution(this.logger, {
    getDb: (query) => this.getDb(query),
    makeCommand: (tab, realTime) => this.makeCommand(tab, realTime),
    runSingle: (...args) => this.runSingle(...args),
    stopInstance: (cronId, instanceId) => this.stopInstance(cronId, instanceId),
    stop: (ids, requestId) => this.stop(ids, requestId),
  });

  private isNodeCron(cron: Crontab) {
    return isNodeCron(cron);
  }

  private get schedulerMode(): 'system' | 'node' {
    return schedulerMode();
  }

  private shouldUseCronClient(cron: Crontab): boolean {
    return shouldUseCronClient(cron, this.schedulerMode);
  }

  private isOnceSchedule(schedule?: string) {
    return isOnceSchedule(schedule);
  }

  private isBootSchedule(schedule?: string) {
    return isBootSchedule(schedule);
  }

  private isSpecialSchedule(schedule?: string) {
    return isSpecialSchedule(schedule);
  }

  private async getLogName(cron: Crontab) {
    const { log_name, command, id } = cron;
    if (log_name === '/dev/null') {
      return log_name;
    }
    const candidate = log_name || (await getUniqPath(command, `${id}`));
    const logDirPath = resolveLogPath(config.logPath, candidate);
    await fs.mkdir(logDirPath, { recursive: true });
    // Shell joins the returned value to dir_log. Normalize old absolute names once.
    return path.relative(config.logPath, logDirPath);
  }

  public async create(payload: Crontab): Promise<Crontab> {
    return withSchedulerMutation(async () => {
      const tab = new Crontab(payload);
      tab.saved = false;
      tab.recovery_from = Date.now();
      tab.log_name = await this.getLogName(tab);
      const doc = await this.insert(tab);

      if (isDemoEnv()) {
        return doc;
      }

      if (this.shouldUseCronClient(doc)) {
        try {
          await cronClient.addCron([nodeCron(doc, this.makeCommand(doc))]);
        } catch (error: any) {
          // gRPC 注册失败时回滚 DB 记录，避免产生"僵尸任务"
          // （DB 和 crontab.list 有记录但调度器永远不会执行）
          await CrontabModel.destroy({ where: { id: doc.id } });
          this.logger.error(
            '[crontab] Failed to register cron job in scheduler, task creation rolled back:',
            error?.message || error,
          );
          throw schedulerRegistrationError(
            `${t('调度器注册失败，任务创建已回滚')}: ${
              (error as any)?.details || error?.message
            }`,
            error,
          );
        }
      }

      try {
        await this.setCrontab(undefined, [doc.id!]);
      } catch (error) {
        if ((error as { status?: number }).status === 503) {
          throw new PendingCronInstall(doc.id!, asError(error).message);
        }
        throw error;
      }
      doc.saved = true;
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
      tab.recovery_from = Math.max(
        Date.now(),
        Number(doc.recovery_from || 0) + 1,
      );
      tab.log_name = await this.getLogName(tab);
      if (isDemoEnv()) {
        tab.saved = doc.saved;
        return await this.updateDb(tab);
      }

      if (doc.isDisabled === 1) {
        const updated = await this.updateDb(tab);
        await this.setCrontab(undefined, [doc.id!]);
        updated.saved = true;
        return updated;
      }

      const register = (row: Crontab) =>
        cronClient.addCron([nodeCron(row, this.makeCommand(row))]);
      const restoreTimer = async () => {
        if (!this.shouldUseCronClient(doc)) return;
        try {
          await register(doc);
        } catch (error) {
          cronClient.readiness.invalidate();
          await CrontabModel.update(
            { saved: false },
            { where: { id: doc.id } },
          );
          throw Object.assign(
            new Error(t('原调度未能恢复，正在重试'), { cause: error }),
            { status: 503 },
          );
        }
      };
      // addCron stages and atomically replaces a Node timer. Never tear down the
      // old timer for a Node-to-Node edit that the database may still reject.
      const handOff =
        this.shouldUseCronClient(doc) && !this.shouldUseCronClient(tab);
      if (handOff) await cronClient.delCron([String(doc.id)]);
      let newDoc: Crontab;
      try {
        newDoc = await this.updateDb(tab);
      } catch (error) {
        if (handOff) await restoreTimer();
        throw error;
      }

      const useNode = this.shouldUseCronClient(newDoc);
      const movingFromSystem =
        useNode &&
        !this.shouldUseCronClient(doc) &&
        !this.isSpecialSchedule(doc.schedule);
      // Remove the previous system entry before the new Node timer can fire.
      if (movingFromSystem) await this.setCrontab();
      if (useNode) {
        try {
          await register(newDoc);
        } catch (error: any) {
          // gRPC 注册新任务失败 → 回滚 DB 到旧数据，并尝试恢复旧调度注册
          await this.updateDb(doc);
          await restoreTimer();
          if (movingFromSystem) {
            await CrontabModel.update(
              { saved: false },
              { where: { id: doc.id } },
            );
            await this.setCrontab(undefined, [doc.id!]);
          }
          this.logger.error(
            '[crontab] Failed to register updated cron job in scheduler, update rolled back:',
            error?.message || error,
          );
          throw schedulerRegistrationError(
            `${t('调度器注册失败，任务更新已回滚')}: ${
              (error as any)?.details || error?.message
            }`,
            error,
          );
        }
      }

      if (movingFromSystem)
        await CrontabModel.update({ saved: true }, { where: { id: doc.id } });
      else await this.setCrontab(undefined, [doc.id!]);
      newDoc.saved = true;
      return newDoc;
    });
  }

  public async updateDb(payload: Crontab): Promise<Crontab> {
    // A concurrent dispatch owns the runtime fields, including during rollback.
    await CrontabModel.update(payload, {
      where: { id: payload.id },
      fields: [
        'name',
        'command',
        'schedule',
        'timestamp',
        'saved',
        'labels',
        'sub_id',
        'extra_schedules',
        'task_before',
        'task_after',
        'log_name',
        'work_dir',
        'allow_multiple_instances',
        'skip_if_pending',
        'max_queue_wait',
        'catchup_seconds',
        'recovery_from',
      ],
    });
    return await this.getDb({ id: payload.id });
  }

  public async status({
    ids,
    status,
    pid,
    log_path,
    last_running_time,
    last_execution_time = 0,
    exit_code,
    trigger_id,
    trigger_stopped,
    finished_at,
  }: {
    ids: number[];
    status: CrontabStatus;
    pid: number;
    log_path: string;
    last_running_time: number;
    last_execution_time: number;
    exit_code?: number;
    trigger_id?: string;
    trigger_stopped?: boolean;
    finished_at?: number;
  }) {
    if (log_path && log_path !== '/dev/null') {
      resolveLogPath(config.logPath, log_path);
    }
    const options: any = {
      status,
      pid,
      log_path,
      last_execution_time,
    };
    if (last_running_time != null && last_running_time > 0) {
      options.last_running_time = last_running_time;
    }

    for (const id of ids) {
      if (!(await CrontabModel.findByPk(id, { attributes: ['id'] }))) continue;
      if (
        trigger_id &&
        [CrontabStatus.running, CrontabStatus.idle].includes(status)
      ) {
        await new TriggerHistory(CrontabModel.sequelize!).reportInstance(
          trigger_id,
          id,
          status === CrontabStatus.running,
          pid,
          log_path,
          last_execution_time,
          last_running_time,
          exit_code,
          trigger_stopped,
          finished_at,
        );
        continue;
      }

      if (status === CrontabStatus.running || status === CrontabStatus.idle) {
        if (
          Number.isSafeInteger(pid) &&
          pid > 0 &&
          Number.isSafeInteger(last_execution_time) &&
          last_execution_time > 0
        ) {
          await new TriggerHistory(CrontabModel.sequelize!).reportLegacy(
            id,
            status === CrontabStatus.running,
            pid,
            log_path,
            last_execution_time,
            last_running_time ?? 0,
            exit_code,
          );
        }
        continue;
      }

      await CrontabModel.update(
        { ...pickBy(options, (v) => v === 0 || !!v) },
        { where: { id } },
      );
    }
  }

  public async remove(
    targets: (
      | number
      | {
          id: number;
          script: string;
          command?: string;
          sub_id?: number | null;
          revision?: number;
        }
    )[],
  ) {
    return withSchedulerMutation(async () => {
      const ids = targets.map((target) =>
        typeof target === 'number' ? target : target.id,
      );
      for (const target of targets) {
        if (typeof target === 'number') continue;
        const current = await CrontabModel.findByPk(target.id);
        if (
          !current ||
          cronOperand(current.command, true) !== target.script ||
          (target.command !== undefined &&
            current.command !== target.command) ||
          (target.revision !== undefined &&
            current.recovery_from !== target.revision) ||
          (target.sub_id !== undefined &&
            (current.sub_id ?? null) !== target.sub_id)
        ) {
          throw Object.assign(new Error(t('任务已修改，请刷新后重试')), {
            status: 409,
          });
        }
      }
      await cronClient.delCron(ids.map(String));
      await CrontabModel.destroy({ where: { id: ids } });
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

  private formatViewQuery(query: any, viewQuery: any, forDisplay: boolean) {
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
        if (
          property === 'status' &&
          (operation === 'In' || operation === 'Nin')
        ) {
          query[primaryOperate].push(
            statusFilter(
              Array.isArray(value) ? value : [value],
              operation === 'Nin',
              forDisplay,
            ),
          );
          continue;
        }
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
            q[property] = Array.isArray(value) ? value : [value];
            break;
          case 'Nin':
            q[Op.or] = [
              {
                [property]: {
                  [Op.notIn]: Array.isArray(value) ? value : [value],
                },
              },
              { [property]: { [Op.is]: null } },
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

  private formatFilterQuery(query: any, filterQuery: any, forDisplay: boolean) {
    if (!isEmpty(filterQuery)) {
      if (!query[Op.and]) {
        query[Op.and] = [];
      }
      const filterKeys: any = Object.keys(filterQuery);
      for (const key of filterKeys) {
        let q: any = {};
        if (!filterQuery[key]) continue;
        if (key === 'status') {
          q = statusFilter(filterQuery[key], false, forDisplay);
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

  public async crontabs(
    params?: {
      searchValue: string;
      page: string;
      size: string;
      sorter: string;
      filters: string;
      queryString: string;
    },
    forDisplay = false,
  ): Promise<{ data: Crontab[]; total: number }> {
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

    this.formatViewQuery(query, viewQuery, forDisplay);
    this.formatSearchText(query, searchText);
    this.formatFilterQuery(query, filterQuery, forDisplay);
    this.formatViewSort(order, viewQuery);

    if (sorterQuery) {
      const { field, type } = sorterQuery;
      if (field && type) {
        order.unshift([field, type]);
      }
    }
    let condition: FindOptions<Crontab> = {
      where: query,
      order: (forDisplay
        ? order.map(([field, dir]) => [
            field === 'status' ? visibleStatus : field,
            dir,
          ])
        : order) as Order,
      ...(forDisplay ? { attributes: visibleAttributes } : {}),
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

  public async getDb(
    query: FindOptions<Crontab>['where'],
    projection: boolean | FindOptions['attributes'] = false,
  ): Promise<Crontab> {
    const attributes = projection === true ? visibleAttributes : projection;
    const doc: any = await CrontabModel.findOne({
      where: { ...query },
      ...(attributes && { attributes }),
    });
    if (!doc) {
      throw new Error(`Cron ${JSON.stringify(query)} not found`);
    }
    return doc.get({ plain: true });
  }

  public async run(ids: number[], source: 'manual' | 'boot' = 'manual') {
    return this.execution.run(ids, source);
  }

  public async stop(ids: number[], requestId?: string) {
    return this.execution.stop(ids, requestId);
  }

  public async resumePendingStops(
    history: TriggerHistory,
    requests: Awaited<ReturnType<TriggerHistory['pendingStops']>>,
    batches: Awaited<ReturnType<TriggerHistory['pendingStopBatches']>> = [],
  ) {
    return this.execution.resumePendingStops(history, requests, batches);
  }

  public stopInstance(cronId: number, instanceId: number) {
    return this.execution.stopInstance(cronId, instanceId);
  }

  private async runSingle(
    cronId: number,
    expectedToken?: string,
    triggerId?: string,
    submitted?: Crontab,
  ): Promise<number | void> {
    return this.execution.runSingle(
      cronId,
      expectedToken,
      triggerId,
      submitted,
    );
  }

  public async disabled(ids: number[]) {
    return withSchedulerMutation(async () => {
      await cronClient.delCron(ids.map(String));
      await CrontabModel.update(
        { isDisabled: 1, saved: false },
        { where: { id: ids } },
      );
      await this.setCrontab(undefined, ids);
    });
  }

  public async enabled(ids: number[]) {
    return withSchedulerMutation(async () => {
      await CrontabModel.update(
        { isDisabled: 0, recovery_from: Date.now() },
        { where: { id: ids } },
      );
      const docs = await CrontabModel.findAll({ where: { id: ids } });
      const crons = docs
        .filter((x) => this.shouldUseCronClient(x))
        .map((doc) => nodeCron(doc, this.makeCommand(doc)));

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
          `${t('调度器注册失败，任务启用已回滚')}: ${
            (error as any)?.details || error?.message
          }`,
          error,
        );
      }
      await CrontabModel.update({ saved: false }, { where: { id: ids } });
      await this.setCrontab(undefined, ids);
    });
  }

  public async log(
    id: number,
    options: CronLogOptions = {},
  ): Promise<CronLogResult> {
    return new CronLogReader((cronId, attributes) =>
      this.getDb({ id: cronId }, attributes),
    ).log(id, options);
  }

  public async logs(id: number) {
    return new CronLogReader((cronId, attributes) =>
      this.getDb({ id: cronId }, attributes),
    ).logs(id);
  }

  private makeCommand(tab: Crontab, realTime?: boolean) {
    return makeCommand(tab, realTime);
  }

  private async setCrontab(
    data?: { data: Crontab[]; total: number },
    appliedIds: number[] = [],
  ) {
    const tabs = data ?? (await this.crontabs());
    await new SystemCronAdapter(this.logger).publish(
      tabs.data,
      () => this.schedulerMode,
      (tab) => this.makeCommand(tab),
    );
    // Only these registrations were acknowledged by this mutation. An unrelated
    // file install cannot confirm a pending Node registration.
    if (appliedIds.length) await this.markSchedulesSaved(appliedIds);
  }

  private async markSchedulesSaved(ids: number[]) {
    await CrontabModel.update(
      { saved: true },
      { where: { id: ids, saved: false } },
    );
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

        if (command && schedule && isValidCronSchedule(schedule)) {
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
      // A bad persisted rule must not block startup or all other schedules.
      // Keep the DB row editable; omit it from both runtime scheduler snapshots.
      tabs.data = tabs.data.filter((doc) => {
        if (doc.isDisabled === 1) return true;
        const invalidSchedules = getInvalidCronSchedules(doc);
        if (invalidSchedules.length === 0) return true;
        this.logger.warn(
          '[crontab] Skipping task with invalid schedule (id=%s, name=%s): %s',
          doc.id,
          doc.name || '',
          JSON.stringify(invalidSchedules),
        );
        return false;
      });
      const regularCrons = tabs.data
        .filter((x) => x.isDisabled !== 1 && this.shouldUseCronClient(x))
        .map((doc) => nodeCron(doc, this.makeCommand(doc)));

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
        await this.markSchedulesSaved(tabs.data.map((row) => row.id!));
      } catch (error: any) {
        this.logger.warn(
          '[crontab] Failed to register cron job in scheduler: %s',
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
      await this.run(
        bootTasks.map((task) => task.id!),
        'boot',
      );
    }
  }
}

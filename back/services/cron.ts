import { confirmSystemPlan, stageSystemPlan, suspendSystemPlan, SystemRule } from '../shared/systemScheduleAudit';
import { cronOperand } from '../shared/cronOperand';
import { PendingCronInstall } from '../shared/errors';
import { shellQuote } from '../shared/shellQuote';
import { finishStoppedTree, hasLiveCronProcess, pidNamespaceOwner, systemOwner, verifyCronProcess } from '../shared/cronProcess';
import { TriggerHistory, TriggerState } from '../shared/triggerHistory';
import { randomUUID } from 'crypto';
import { getInvalidCronSchedules, isValidCronSchedule } from '../shared/cronSchedule';
import {
  withSchedulerMutation,
  schedulerRegistrationError,
} from '../shared/schedulerMutationLock';
import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import { resolveLogPath } from '../shared/logPath';
import { Crontab, CrontabModel, CrontabStatus } from '../data/cron';
import {
  RunningInstanceModel,
  InstanceStatus,
} from '../data/runningInstance';
import { exec, execSync, execFileSync } from 'child_process';
import fs from 'fs/promises';
import {
  getFileContentByName,
  fileExist,
  killTask,
  getUniqPath,
  safeJSONParse,
  isDemoEnv,
} from '../config/util';
import { Op, where, col as colFn, literal, FindOptions, fn, Order, QueryTypes, Transaction } from 'sequelize';
import path from 'path';
import { TASK_PREFIX, QL_PREFIX } from '../config/const';
import cronClient from '../schedule/client';
import taskLimit from '../shared/pLimit';
import dayjs from 'dayjs';
import pickBy from 'lodash/pickBy';
import { writeFileWithLock } from '../shared/utils';
import { t } from '../shared/i18n';
import { ScheduleType } from '../interface/schedule';
import { logStreamManager } from '../shared/logStreamManager';
import { spawnCronCommand, releaseCronCommand } from '../shared/cronCommandProcess';
import { observeChildProcess, asError } from '../shared/childProcess';
import { isEmpty } from 'lodash';
import { LogReadOptions, readLogChunk } from '../shared/logReader';
import { resolveFileAccess } from '../shared/fileAccess';

type BatchStopSnapshot = {
  docs: Array<Pick<Crontab, 'id' | 'status' | 'pid' | 'log_path' | 'queued_token' | 'last_execution_time'>>;
  instances: Array<{ id?: number; cron_id: number; pid?: number }>;
  cancelled: string[];
  missingPids?: number[];
  missingTargets?: string[];
  identityConflict: boolean;
};

// Queue membership belongs to the trigger. Expose it for list/detail reads
// without writing it into the manual-run reservation used by the scheduler.
const visibleStatus = literal(`CASE
  WHEN EXISTS (SELECT 1 FROM CronTriggers WHERE cron_id = "Crontab"."id" AND state = 'running') THEN 0
  WHEN "Crontab"."status" = 1 AND EXISTS (
    SELECT 1 FROM CronTriggers WHERE cron_id = "Crontab"."id" AND state = 'queued'
  ) THEN 3
  ELSE "Crontab"."status" END`);
const visibleAttributes: FindOptions['attributes'] = {
  exclude: ['status'], include: [[visibleStatus, 'status']],
};

// Resolve status and log ownership in one SQLite snapshot. A running trigger
// can be visible before its shell has published the file for this execution.
const activeLogTrigger = `FROM CronTriggers WHERE cron_id = "Crontab"."id"
  AND state = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1`;
const logAttributes: FindOptions['attributes'] = [
  'log_name', [visibleStatus, 'status'],
  [literal(`CASE WHEN EXISTS (SELECT 1 ${activeLogTrigger})
    THEN (SELECT log_path ${activeLogTrigger}) ELSE "Crontab"."log_path" END`), 'log_path'],
  [literal(`CASE WHEN allow_multiple_instances = 1 THEN COALESCE(
    (SELECT id ${activeLogTrigger}),
    (SELECT id FROM CronTriggers WHERE cron_id = "Crontab"."id" AND state = 'queued'
      ORDER BY observed_at DESC, rowid DESC LIMIT 1)
  ) END`), 'logTriggerId'],
];

function shellValue(value: string) {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : shellQuote(value);
}

function statusFilter(values: CrontabStatus[], exclude: boolean, forDisplay: boolean) {
  const column = forDisplay ? visibleStatus : colFn('status');
  const disabled = values.includes(CrontabStatus.disabled);
  if (exclude) {
    return { [Op.and]: [
      { [Op.or]: [where(column, { [Op.notIn]: values }), where(column, { [Op.is]: null })] },
      ...(disabled ? [{ isDisabled: { [Op.ne]: 1 } }] : []),
    ] };
  }
  const matches = where(column, { [Op.in]: values });
  return disabled
    ? { [Op.or]: [matches, { isDisabled: 1 }] }
    : { [Op.and]: [matches, { isDisabled: 0 }] };
}

@Service()
export default class CronService {
  constructor(@Inject('logger') private logger: winston.Logger) { }

  private isNodeCron(cron: Crontab) {
    const { schedule, extra_schedules } = cron;
    const fields = schedule?.trim().split(/\s+/) || [];
    // System crontab only receives portable numeric five-field expressions.
    // Extended syntax, macros and legacy shorthand use the Node scheduler.
    return (
      Boolean(cron.max_queue_wait || cron.catchup_seconds || cron.skip_if_pending) ||
      fields.length !== 5 ||
      /[^\d\s*,/\-]/.test(schedule || '') ||
      Boolean(extra_schedules?.length) ||
      // BusyBox treats N/step as a single value and doesn't support Sunday=7.
      fields.some((field) => field.split(',').some((part) => /^\d+\//.test(part))) ||
      fields[4].includes('7') ||
      // BusyBox steps DOM from zero; its full-range day/week wildcard
      // handling also differs from the legacy Node parser's OR semantics.
      fields[2].includes('/') ||
      (fields[2] !== '*' && fields[4] !== '*')
    );
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
    const candidate = log_name || await getUniqPath(command, `${id}`);
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
          await cronClient.addCron([
            {
              name: doc.name || '',
              id: String(doc.id),
              schedule: doc.schedule!,
              command: this.makeCommand(doc),
              extra_schedules: doc.extra_schedules || [],
              max_queue_wait: doc.max_queue_wait,
              skip_if_pending: Boolean(doc.skip_if_pending),
              catchup_seconds: doc.catchup_seconds,
              recovery_from: doc.recovery_from,
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
      tab.recovery_from = Math.max(Date.now(), Number(doc.recovery_from || 0) + 1);
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

      const register = (row: Crontab) => cronClient.addCron([{
        name: row.name || '', id: String(row.id), schedule: row.schedule!,
        command: this.makeCommand(row), extra_schedules: row.extra_schedules || [],
        max_queue_wait: row.max_queue_wait, skip_if_pending: Boolean(row.skip_if_pending),
        catchup_seconds: row.catchup_seconds, recovery_from: row.recovery_from,
      }]);
      const restoreTimer = async () => {
        if (!this.shouldUseCronClient(doc)) return;
        try { await register(doc); }
        catch (error) {
          cronClient.readiness.invalidate();
          await CrontabModel.update({ saved: false }, { where: { id: doc.id } });
          throw Object.assign(new Error(t('原调度未能恢复，正在重试'), { cause: error }), { status: 503 });
        }
      };
      // addCron stages and atomically replaces a Node timer. Never tear down the
      // old timer for a Node-to-Node edit that the database may still reject.
      const handOff = this.shouldUseCronClient(doc) && !this.shouldUseCronClient(tab);
      if (handOff) await cronClient.delCron([String(doc.id)]);
      let newDoc: Crontab;
      try { newDoc = await this.updateDb(tab); }
      catch (error) {
        if (handOff) await restoreTimer();
        throw error;
      }

      const useNode = this.shouldUseCronClient(newDoc);
      const movingFromSystem = useNode && !this.shouldUseCronClient(doc) && !this.isSpecialSchedule(doc.schedule);
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
            await CrontabModel.update({ saved: false }, { where: { id: doc.id } });
            await this.setCrontab(undefined, [doc.id!]);
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

      if (movingFromSystem) await CrontabModel.update({ saved: true }, { where: { id: doc.id } });
      else await this.setCrontab(undefined, [doc.id!]);
      newDoc.saved = true;
      return newDoc;
    });
  }

  public async updateDb(payload: Crontab): Promise<Crontab> {
    // A concurrent dispatch owns the runtime fields, including during rollback.
    await CrontabModel.update(payload, {
      where: { id: payload.id },
      fields: ['name', 'command', 'schedule', 'timestamp', 'saved', 'labels', 'sub_id',
        'extra_schedules', 'task_before', 'task_after', 'log_name', 'work_dir',
        'allow_multiple_instances', 'skip_if_pending', 'max_queue_wait', 'catchup_seconds', 'recovery_from'],
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
      if (!await CrontabModel.findByPk(id, { attributes: ['id'] })) continue;
      if (trigger_id && [CrontabStatus.running, CrontabStatus.idle].includes(status)) {
        await new TriggerHistory(CrontabModel.sequelize!).reportInstance(trigger_id, id,
          status === CrontabStatus.running, pid, log_path, last_execution_time,
          last_running_time, exit_code, trigger_stopped, finished_at);
        continue;
      }

      if (status === CrontabStatus.running || status === CrontabStatus.idle) {
        if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(last_execution_time) && last_execution_time > 0) {
          await new TriggerHistory(CrontabModel.sequelize!).reportLegacy(id, status === CrontabStatus.running,
            pid, log_path, last_execution_time, last_running_time ?? 0, exit_code);
        }
        continue;
      }

      await CrontabModel.update(
        { ...pickBy(options, (v) => v === 0 || !!v) },
        { where: { id } },
      );
    }
  }

  public async remove(targets: (number | { id: number; script: string; command?: string; sub_id?: number | null; revision?: number })[]) {
    return withSchedulerMutation(async () => {
      const ids = targets.map(target => typeof target === 'number' ? target : target.id);
      for (const target of targets) {
        if (typeof target === 'number') continue;
        const current = await CrontabModel.findByPk(target.id);
        if (!current || cronOperand(current.command, true) !== target.script ||
          (target.command !== undefined && current.command !== target.command) ||
          (target.revision !== undefined && current.recovery_from !== target.revision) ||
          (target.sub_id !== undefined && (current.sub_id ?? null) !== target.sub_id)) {
          throw Object.assign(new Error(t('任务已修改，请刷新后重试')), { status: 409 });
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
        if (property === 'status' && (operation === 'In' || operation === 'Nin')) {
          query[primaryOperate].push(statusFilter(Array.isArray(value) ? value : [value], operation === 'Nin', forDisplay));
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
              { [property]: { [Op.notIn]: Array.isArray(value) ? value : [value] } },
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

  public async crontabs(params?: {
    searchValue: string;
    page: string;
    size: string;
    sorter: string;
    filters: string;
    queryString: string;
  }, forDisplay = false): Promise<{ data: Crontab[]; total: number }> {
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
      order: (forDisplay ? order.map(([field, dir]) => [field === 'status' ? visibleStatus : field, dir]) : order) as Order,
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
    const doc: any = await CrontabModel.findOne({ where: { ...query }, ...(attributes && { attributes }) });
    if (!doc) {
      throw new Error(`Cron ${JSON.stringify(query)} not found`);
    }
    return doc.get({ plain: true });
  }

  public async run(ids: number[], source: 'manual' | 'boot' = 'manual') {
    const token = randomUUID();
    const database = CrontabModel.sequelize!;
    const history = new TriggerHistory(database);
    const queued = await database.transaction(async (transaction) => {
      const rows = await CrontabModel.findAll({ where: { id: ids }, transaction });
      const accepted: Crontab[] = [];
      for (const row of rows) {
        const id = row.id!;
        const trigger = token + '-' + id;
        await history.enqueue(trigger, id, source, null, Date.now(), transaction);
        if (!row.allow_multiple_instances && (hasLiveCronProcess(row.status, row.pid) || await history.isRunning(id, transaction))) {
          await history.finish(trigger, 'skipped', 'overlap', null, transaction);
        } else {
          accepted.push(row.get({ plain: true }));
        }
      }
      await CrontabModel.update({ status: CrontabStatus.queued, queued_token: token }, {
        where: { id: accepted.map(row => row.id!) }, transaction,
      });
      return accepted;
    });
    for (const row of queued) {
      const id = row.id!;
      void this.runSingle(id, token, token + '-' + id, row).catch((err) => this.logger.error(String(err)));
    }
  }

  private readonly stoppingBatches = new Map<string, Promise<void>>();

  public async stop(ids: number[], requestId?: string) {
    if (!ids.length && !requestId) return;
    const targets = [...new Set(ids)].sort((a, b) => a - b);
    const cronIds = JSON.stringify(targets);
    if (!requestId) return this.stopBatch(targets, cronIds);
    const key = requestId + '/' + cronIds;
    const pending = this.stoppingBatches.get(key);
    if (pending) return pending;
    // The database arbitrates different payloads and competing workers.
    const done = this.stopBatch(targets, cronIds, requestId).finally(() => this.stoppingBatches.delete(key));
    this.stoppingBatches.set(key, done);
    return done;
  }

  private async stopBatch(ids: number[], cronIds: string, requestId?: string) {
    const database = CrontabModel.sequelize!;
    const history = new TriggerHistory(database);
    const snapshot = await database.transaction({ type: Transaction.TYPES.IMMEDIATE }, async (transaction): Promise<BatchStopSnapshot | null> => {
      if (requestId) {
        const [existing] = await database.query<{ cron_ids: string; snapshot: string | null; status_code: number }>(
          'SELECT cron_ids,snapshot,status_code FROM CronStopBatches WHERE request_id=$requestId',
          { transaction, bind: { requestId }, type: QueryTypes.SELECT });
        if (existing) {
          if (existing.cron_ids !== cronIds)
            throw Object.assign(new Error('Idempotency-Key already used for different tasks'), { status: 409 });
          if (existing.status_code === 409) throw Object.assign(new Error(t('实例不存在或已停止')), { status: 409 });
          return existing.snapshot ? JSON.parse(existing.snapshot) : null;
        }
      }
      const docs = await CrontabModel.findAll({
        attributes: ['id', 'status', 'pid', 'log_path', 'queued_token', 'last_execution_time'],
        where: { id: ids }, transaction, raw: true,
      });
      const cancelled = await history.cancelQueuedInTransaction(ids, transaction);
      const instances = await RunningInstanceModel.findAll({
        attributes: ['id', 'cron_id', 'pid'], where: { cron_id: ids, status: InstanceStatus.running }, transaction, raw: true,
      });
      const { missingTargets, identityConflict } = await this.attachLegacyStopTargets(docs, instances, history, transaction);
      for (const instance of instances) {
        if (instance.pid) await history.queueInstanceStop(instance.id!, instance.cron_id, instance.pid, transaction);
      }
      for (const doc of docs) {
        if (doc.status === CrontabStatus.queued) {
          await CrontabModel.update({ status: CrontabStatus.idle, pid: null, queued_token: null } as any,
            { where: { id: doc.id, status: CrontabStatus.queued }, transaction });
        }
      }
      const batch = { docs, cancelled, instances, missingTargets, identityConflict };
      if (requestId) {
        await database.query('INSERT INTO CronStopBatches(request_id,cron_ids,snapshot) VALUES ($requestId,$cronIds,$snapshot)',
          { transaction, bind: { requestId, cronIds, snapshot: JSON.stringify(batch) } });
      }
      return batch;
    });
    if (!snapshot) return;
    const { docs, cancelled, instances, missingPids, missingTargets, identityConflict } = snapshot;
    if (cancelled.length) process.send?.({ type: 'cancel-queued-triggers', ids: cancelled });
    const stopped = new Set(missingTargets);
    let failure: Error | undefined;
    for (const instance of instances) {
      try {
        const result = await this.stopInstance(instance.cron_id, instance.id!);
        if (result.code === 409) failure ??= Object.assign(new Error(result.message), { status: 409 });
        if (instance.pid && 'data' in result && result.data?.outcome === 'stopped') stopped.add(instance.cron_id + '/' + instance.pid);
      } catch (error) { failure ??= asError(error); }
    }
    for (const doc of docs) {
      if (
        doc.status !== CrontabStatus.running ||
        (doc.pid && !missingPids?.includes(doc.pid) && !stopped.has(doc.id + '/' + doc.pid))
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
    if (failure) throw failure;
    // Retain the key after success. Even a much later retry must never take a new snapshot.
    if (requestId) await database.query('UPDATE CronStopBatches SET snapshot=NULL,status_code=$status WHERE request_id=$requestId AND snapshot IS NOT NULL',
      { bind: { requestId, status: identityConflict ? 409 : 200 } });
    if (identityConflict) throw Object.assign(new Error(t('实例不存在或已停止')), { status: 409 });
  }

  // Older databases can have a PID or a command receipt without an instance.
  // Give verified targets an instance before releasing the same snapshot transaction.
  private async attachLegacyStopTargets(docs: BatchStopSnapshot['docs'], instances: BatchStopSnapshot['instances'],
    history: TriggerHistory, transaction: Transaction) {
    const commands = await history.activeCommands(docs.map(doc => doc.id!), transaction);
    const registered = new Set(instances.map(row => row.cron_id + '/' + row.pid));
    const registeredPids = new Set(instances.map(row => row.pid));
    const legacy = new Map<string, { pid: number; cronId: number; trigger?: string; identity?: string; started?: number; log?: string }>();
    for (const doc of docs) {
      const key = doc.id + '/' + doc.pid;
      if (doc.status === CrontabStatus.running && doc.pid && !registered.has(key))
        legacy.set(key, { pid: doc.pid, cronId: doc.id!, started: doc.last_execution_time, log: doc.log_path });
    }
    for (const command of commands) {
      const pid = Number(command.command_identity.split(':')[1]);
      const key = command.cron_id + '/' + pid;
      if (!registered.has(key)) legacy.set(key, { pid, cronId: command.cron_id, trigger: command.id,
        identity: command.command_identity, started: Math.floor(command.started_at / 1000), log: command.log_path });
    }
    let identityConflict = false;
    const missingTargets: string[] = [];
    for (const target of legacy.values()) {
      const { pid } = target;
      // A different task already owns this PID in the snapshot.
      if (registeredPids.has(pid)) {
        identityConflict = true;
        continue;
      }
      let identity: string;
      try {
        identity = systemOwner(pid);
        verifyCronProcess(pid, target.cronId, target.identity, target.started);
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code!)) missingTargets.push(target.cronId + '/' + pid);
        else if ((error as { status?: number }).status === 409) identityConflict = true;
        else throw error;
        continue;
      }
      const row = await RunningInstanceModel.create({ cron_id: target.cronId, pid, status: InstanceStatus.running,
        started_at: target.started || dayjs().unix(), log_path: target.log }, { transaction });
      if (target.trigger) await CrontabModel.sequelize!.query(
        "UPDATE CronTriggers SET instance_id=$id,process_identity=$identity WHERE id=$trigger AND state='running'",
        { transaction, bind: { id: row.id, identity, trigger: target.trigger } });
      await history.queueInstanceStop(row.id!, target.cronId, pid, transaction, identity);
      instances.push({ id: row.id, cron_id: target.cronId, pid });
    }
    return { missingTargets, identityConflict };
  }

  public async resumePendingStops(history: TriggerHistory, requests: Awaited<ReturnType<TriggerHistory['pendingStops']>>,
    batches: Awaited<ReturnType<TriggerHistory['pendingStopBatches']>> = []) {
    for (const row of requests) {
      try {
        const result = await this.stopInstance(row.cron_id, row.instance_id);
        if (result.code !== 200) this.logger.warn(result.message);
      } catch (error) {
        this.logger.error(t('[panel][停止实例失败] 实例ID: %s, PID: %s, 错误: %s'),
          row.instance_id, row.pid, asError(error).message);
      }
    }
    for (const batch of batches) {
      try { await this.stop(JSON.parse(batch.cron_ids), batch.request_id); }
      catch (error) { this.logger.error(asError(error).message); }
    }
    await history.recoverSystemOwners();
  }

  private readonly stoppingInstances = new Map<string, Promise<{ code: number; message: string; data?: { outcome: string } }>>();

  public stopInstance(cronId: number, instanceId: number) {
    const key = `${cronId}/${instanceId}`;
    const pending = this.stoppingInstances.get(key);
    if (pending) return pending;
    const stop = this.stopOneInstance(cronId, instanceId).finally(() => this.stoppingInstances.delete(key));
    this.stoppingInstances.set(key, stop);
    return stop;
  }

  private async stopOneInstance(cronId: number, instanceId: number) {
    const ended = { code: 200, data: { outcome: 'ended' }, message: t('实例已结束') };
    const stopped = { code: 200, data: { outcome: 'stopped' }, message: t('实例已停止') };
    const history = new TriggerHistory(CrontabModel.sequelize!);
    const instance = await RunningInstanceModel.findOne({
      where: { id: instanceId, cron_id: cronId },
    });
    if (!instance) {
      await CrontabModel.sequelize!.query('DELETE FROM CronStopRequests WHERE instance_id=$instanceId AND cron_id=$cronId', { bind: { instanceId, cronId } });
      return { code: 404, message: t('实例不存在或已停止') };
    }
    const pending = await history.pendingStop(instanceId);
    const savedTargets: string[] = pending?.targets ? JSON.parse(pending.targets) : [];
    const settle = () => history.stopVerifiedInstance(instanceId,
      transaction => this.settleLegacyStop(instanceId, cronId, instance.pid, transaction));
    const finishClaim = async (claim: NonNullable<typeof pending>) => {
      await finishStoppedTree(claim.targets ? JSON.parse(claim.targets) : [], claim.signalled_at);
      return await settle() ? stopped : ended;
    };
    const releaseUnsignalled = async (recoverEnded = false) => {
      const claimed = await history.forgetStop(instanceId, recoverEnded ? async tx => {
        await history.recoverSystemOwners(cronId, tx, instanceId);
        if (await history.instanceStopRequested(instanceId, tx) === undefined)
          await this.settleLegacyStop(instanceId, cronId, instance.pid, tx, InstanceStatus.unknown);
      } : undefined);
      if (claimed) return finishClaim(claimed);
    };
    if (pending?.signalled) return finishClaim(pending);
    if (instance.status !== InstanceStatus.running) {
      if (savedTargets.length) await finishStoppedTree(savedTargets);
      const claimed = pending && await releaseUnsignalled();
      return claimed ?? (instance.status === InstanceStatus.stopped ? stopped : ended);
    }
    // A cold restart destroys the old process tree. The same numeric PIDs
    // may already belong to another execution, even when script and log match.
    if (pending?.namespace_owner && pending.namespace_owner !== pidNamespaceOwner()) {
      return await releaseUnsignalled(true) ?? ended;
    }
    if (!instance.pid || instance.pid < 1) {
      return { code: 409, message: t('实例不存在或已停止') };
    }
    let identity = pending?.root_identity || await history.instanceIdentity(instanceId)
      || savedTargets.find(birth => birth.startsWith(`crond:${instance.pid}:`));
    const verify = () => verifyCronProcess(instance.pid!, cronId, identity, instance.started_at,
      { logPath: instance.log_path });
    if (!identity && await RunningInstanceModel.count({ where: {
      id: { [Op.ne]: instanceId }, status: InstanceStatus.running, pid: instance.pid,
    } })) {
      const claimed = await releaseUnsignalled();
      return claimed ?? { code: 409, message: t('实例不存在或已停止') };
    }
    try {
      identity = verify() ?? identity;
      // Traversing the process tree is asynchronous. Persist the individual
      // request before traversal so a restart here also resumes this stop.
      if (!pending || (!pending.root_identity && identity))
        await history.queueInstanceStop(instanceId, cronId, instance.pid, undefined, identity ?? undefined);
      await killTask(instance.pid, true, verify, (signal, targets) =>
        history.requestInstanceStop(instanceId, instance.pid!, signal, targets));
      return await settle() ? stopped : ended;
    } catch (error) {
      const cause = (error as NodeJS.ErrnoException).code;
      if (cause === 'ESRCH' || cause === 'PID_REUSED') {
        if (savedTargets.length) await finishStoppedTree(savedTargets);
        const claimed = await releaseUnsignalled(true);
        if (claimed) return claimed;
        const latest = await RunningInstanceModel.findOne({ where: { id: instanceId, cron_id: cronId } });
        if (latest?.status === InstanceStatus.stopped) return stopped;
        if (latest?.status === InstanceStatus.running) {
          const requested = await history.instanceStopRequested(instanceId);
          if (requested) return stopped;
          if (cause === 'PID_REUSED' || requested === undefined) return { code: 409, message: t('实例不存在或已停止') };
        }
        return ended;
      }
      if ((error as { status?: number }).status === 409) {
        if (savedTargets.length) await finishStoppedTree(savedTargets);
        const claimed = await releaseUnsignalled();
        return claimed ?? { code: 409, message: t('实例不存在或已停止') };
      }
      this.logger.error(
        t("[panel][停止实例失败] 实例ID: %s, PID: %s, 错误: %s"), instanceId, instance.pid, error,
      );
      throw error;
    }
  }

  private async settleLegacyStop(instanceId: number, cronId: number, pid: number | undefined, transaction: Transaction,
    status = InstanceStatus.stopped) {
    const [updated] = await RunningInstanceModel.update(
      { status, finished_at: dayjs().unix() },
      { where: { id: instanceId, cron_id: cronId, status: InstanceStatus.running }, transaction },
    );

    if (!updated) {
      const latest = await RunningInstanceModel.findOne({ where: { id: instanceId, cron_id: cronId }, transaction });
      return latest?.status === InstanceStatus.stopped;
    }

    // Check if there are still other running instances for this cron
    const otherRunning = await RunningInstanceModel.count({
      where: { cron_id: cronId, status: InstanceStatus.running }, transaction,
    });
    if (otherRunning === 0) {
      await CrontabModel.update(
        { status: CrontabStatus.idle, pid: null } as any,
        { where: { id: cronId, status: CrontabStatus.running, pid }, transaction },
      );
    }
    return status === InstanceStatus.stopped;
  }

  private async runSingle(
    cronId: number,
    expectedToken?: string,
    triggerId?: string,
    submitted?: Crontab,
  ): Promise<number | void> {
    return taskLimit.manualRunWithCronLimit(async () => {
      let absolutePath: string | undefined;
      let logPath: string | undefined;
      let queuedLogPath: string | null | undefined;
      let queuedToken: string | null = null;
      let claimed = false;
      const history = new TriggerHistory(CrontabModel.sequelize!);
      let state: TriggerState = 'skipped';
      let reason: string | null = 'changed';
      let exitCode: number | null = null;
      try {
        const cron = await this.getDb({ id: cronId });
        const independent = Boolean(triggerId && submitted?.allow_multiple_instances && cron.allow_multiple_instances);
        if (!independent && (
          cron.status !== CrontabStatus.queued ||
          (expectedToken !== undefined && cron.queued_token !== expectedToken)
        )) return;
        queuedLogPath = cron.log_path ?? null;
        if (submitted && (submitted.recovery_from !== cron.recovery_from ||
          submitted.isDisabled !== cron.isDisabled || submitted.command !== cron.command)) {
          queuedToken = expectedToken ?? null;
          return;
        }
        queuedToken = cron.queued_token ?? null;
        const { id, command, log_name } = cron;
        if (log_name === '/dev/null') {
          logPath = '/dev/null';
        } else {
          const uniqPath = log_name
            ? path.relative(config.logPath, resolveLogPath(config.logPath, log_name))
            : await getUniqPath(command, `${id}`);
          const logTime = dayjs().format('YYYY-MM-DD-HH-mm-ss-SSS');
          logPath = `${uniqPath}/${logTime}${independent ? '-' + expectedToken : ''}.log`;
          absolutePath = resolveFileAccess(config.logPath, [logPath]);
          if (!absolutePath) throw new Error('Log path is outside the log directory');
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        }
        const outputPath = absolutePath;
        if (triggerId && submitted) {
          const claim = await history.claimManual(triggerId, submitted, expectedToken!, independent);
          if (claim !== 'started') {
            reason = claim;
            queuedToken = expectedToken!;
            return;
          }
        }
        const cp = spawnCronCommand(
          `real_log_path=${shellValue(logPath)} no_delay=true ${this.makeCommand(cron, true)}`, triggerId,
        );
        // Install observers before the first await: very short children may already exit.
        const { completed } = observeChildProcess(cp, {
          onStart: async () => {
            try {
              if (triggerId && !await history.bindCommand(triggerId, cp.pid!, logPath))
                throw new Error('Task was cancelled before startup');
              const [count] = await CrontabModel.update(
                {
                  status: CrontabStatus.running,
                  pid: cp.pid,
                  log_path: logPath,
                  ...(!triggerId && { last_execution_time: dayjs().unix(), last_running_time: null }),
                },
                {
                  where: {
                    id,
                    ...(independent ? {} : {
                      status: CrontabStatus.queued,
                      [Op.and]: [
                        where(colFn('queued_token'), { [Op.eq]: queuedToken }),
                        where(colFn('log_path'), { [Op.eq]: queuedLogPath }),
                      ],
                    }),
                  },
                }
              );
              if (count !== 1)
                throw new Error(
                  'Task was stopped or superseded before startup'
                );
              claimed = true;
              if (triggerId) {
                if (await history.shouldStop(triggerId)) cp.stdin.end();
                else await releaseCronCommand(cp);
              }
            } catch (error) {
              if (triggerId) cp.stdin.destroy();
              else if (cp.pid) await killTask(cp.pid, true);
              throw error;
            }
          },
          onStdout: outputPath ? (message) => logStreamManager.write(outputPath, message) : undefined,
          onStderr: outputPath ? (message) => logStreamManager.write(outputPath, message) : undefined,
        });
        const result = await completed;
        state = result.signal ? 'stopped' : result.error || result.code !== 0 ? 'failed' : 'finished';
        reason = result.error ? 'spawn' : result.signal || null;
        exitCode = result.code;
        if (result.error) {
          this.logger.error(
            t('[panel][执行任务失败] 任务ID: %s, 错误: %s'),
            id,
            result.error.message
          );
        }
        this.logger.info(
          t('[panel][执行任务结束] 任务ID: %s, 退出码: %j'),
          id,
          result.code
        );
        return { ...cron, pid: cp.pid, ...result } as any;
      } catch (error) {
        state = 'failed';
        reason = 'spawn';
        this.logger.error(
          t('[panel][创建任务失败] 任务ID: %s, 错误: %s'),
          cronId,
          asError(error).message
        );
      } finally {
        try {
          if (absolutePath) await logStreamManager.closeStream(absolutePath);
        } catch (error) {
          this.logger.error(
            t('[panel][关闭任务日志失败] %s'),
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
            t('[panel][清理任务状态失败] %s'),
            asError(error).message
          );
        }
        if (triggerId) await history.complete(triggerId, state, reason, exitCode);
      }
    }, undefined, { id: triggerId, name: submitted?.name || submitted?.command || String(cronId) }, CrontabModel.sequelize);
  }

  public async disabled(ids: number[]) {
    return withSchedulerMutation(async () => {
      await cronClient.delCron(ids.map(String));
      await CrontabModel.update({ isDisabled: 1, saved: false }, { where: { id: ids } });
      await this.setCrontab(undefined, ids);
    });
  }

  public async enabled(ids: number[]) {
    return withSchedulerMutation(async () => {
      await CrontabModel.update({ isDisabled: 0, recovery_from: Date.now() }, { where: { id: ids } });
      const docs = await CrontabModel.findAll({ where: { id: ids } });
      const crons = docs
        .filter((x) => this.shouldUseCronClient(x))
        .map((doc) => ({
          name: doc.name || '',
          id: String(doc.id),
          schedule: doc.schedule!,
          command: this.makeCommand(doc),
          extra_schedules: doc.extra_schedules || [],
          max_queue_wait: doc.max_queue_wait,
          skip_if_pending: Boolean(doc.skip_if_pending),
          catchup_seconds: doc.catchup_seconds,
          recovery_from: doc.recovery_from,
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
      await CrontabModel.update({ saved: false }, { where: { id: ids } });
      await this.setCrontab(undefined, ids);
    });
  }

  public async log(
    id: number,
    options: LogReadOptions & { previousPath?: string; triggerId?: string; instanceId?: number } = {},
  ): Promise<{
    content: string;
    status: string;
    logPath?: string;
    triggerId?: string;
    cursor?: string;
    reset?: boolean;
    offset: number;
    nextOffset: number;
    total: number;
    truncated: boolean;
  }> {
    let doc: Pick<Crontab, 'status' | 'log_path' | 'log_name'> & { logTriggerId?: string };
    if (options.instanceId !== undefined) {
      const instance = await RunningInstanceModel.findOne({ where: { id: options.instanceId, cron_id: id },
        attributes: ['status', 'log_path'], raw: true });
      doc = { status: instance?.status === InstanceStatus.running ? CrontabStatus.running : CrontabStatus.idle,
        log_path: instance?.log_path };
    } else if (options.triggerId) {
      const [trigger] = await new TriggerHistory(CrontabModel.sequelize!).visibleTriggers(id, [options.triggerId]);
      // A retained viewer must never fall back to a sibling if its receipt was removed.
      doc = {
        logTriggerId: options.triggerId,
        log_path: trigger?.log_path ?? undefined,
        status: trigger?.state === 'running' ? CrontabStatus.running
          : trigger?.state === 'queued' ? CrontabStatus.queued : CrontabStatus.idle,
      };
    } else {
      doc = await this.getDb({ id }, logAttributes);
    }
    const triggerId = doc.logTriggerId ?? undefined;
    if (doc.log_name === '/dev/null' || doc.log_path === '/dev/null') {
      return {
        content: t('日志设置为忽略'),
        status: 'ignored',
        triggerId,
        offset: 0,
        nextOffset: 0,
        total: 0,
        truncated: false,
      };
    }
    if (typeof doc.status === 'number' && doc.status === CrontabStatus.queued) {
      // The next run has reserved a slot but has not published its own path yet.
      return { triggerId, content: '', status: 'running', offset: 0, nextOffset: 0, total: 0, truncated: false };
    }
    const absolutePath = doc.log_path
      ? resolveLogPath(config.logPath, doc.log_path)
      : '';
    const logFileExist = doc.log_path && (await fileExist(absolutePath));
    if (logFileExist) {
      const changed = options.previousPath !== undefined && options.previousPath !== doc.log_path;
      const chunk = await readLogChunk(absolutePath, changed
        ? { ...options, cursor: undefined, offset: 0, tail: !options.follow }
        : options);
      const isRunning =
        typeof doc.status === 'number' &&
        [CrontabStatus.running, CrontabStatus.queued].includes(doc.status);
      return {
        ...chunk,
        triggerId,
        logPath: doc.log_path,
        status: isRunning ? 'running' : 'completed',
      };
    } else {
      const status =
        typeof doc.status === 'number' &&
        [CrontabStatus.queued, CrontabStatus.running].includes(doc.status)
          ? 'running'
          : 'notFound';
      return {
        triggerId,
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
    if (!doc || !doc.log_path || doc.log_path === '/dev/null') {
      return [];
    }

    const relativeDir = path.dirname(`${doc.log_path}`);
    const dir = path.dirname(resolveLogPath(config.logPath, doc.log_path));
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
    let commandVariable = `${tab.recovery_from ? `QL_CRON_REVISION=${Number(tab.recovery_from)} ` : ''}real_time=${Boolean(realTime)} no_tee=true ID=${tab.id} `;
    // Only include log_name if it has a truthy value to avoid passing null/undefined to shell
    if (tab.log_name) {
      commandVariable += `log_name=${shellValue(tab.log_name)} `;
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

  private async setCrontab(data?: { data: Crontab[]; total: number }, appliedIds: number[] = []) {
    const tabs = data ?? (await this.crontabs());
    const rules: SystemRule[] = [];
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
        rules.push({ id: tab.id!, schedule: tab.schedule!, name: tab.name || tab.command });
        crontab_string += `QL_SYSTEM_DISPATCHED=$(date +\\%s) QL_SYSTEM_RULE=${shellQuote(tab.schedule!)} ID=${tab.id} QL_TRIGGER_SOURCE=system bash "$QL_DIR/shell/system-cron.sh" ${shellQuote(this.makeCommand(tab))}`;
        crontab_string += '\n';
      }
    });

    try {
      const system = this.schedulerMode === 'system';
      const db = CrontabModel.sequelize!;
      const plan = system ? await stageSystemPlan(db, rules) : undefined;
      if (!system) await suspendSystemPlan(db);
      await writeFileWithLock(config.crontabFile, crontab_string);
      if (plan !== undefined) {
        execFileSync('crontab', [config.crontabFile]);
        await confirmSystemPlan(db, plan);
      }
    } catch (error) {
      this.logger.error('[crontab] Failed to publish crontab:', asError(error).message);
      cronClient.readiness.invalidate();
      if (process.env.SERVICE_TYPE === 'grpc') process.send?.('crontab-install-failed');
      // A fresh host may have no installed crontab at all. A previous boot's
      // saved flag does not confirm any portable rule in the failed snapshot.
      if (this.schedulerMode === 'system') {
        const ids = tabs.data
          .filter((row) => !this.isNodeCron(row) && !this.isSpecialSchedule(row.schedule))
          .map((row) => row.id!);
        if (ids.length) await CrontabModel.update({ saved: false }, { where: { id: ids } });
      }
      throw Object.assign(new Error(t('系统定时规则安装失败，旧规则可能仍在运行，正在重试')), { status: 503 });
    }
    // Only these registrations were acknowledged by this mutation. An unrelated
    // file install cannot confirm a pending Node registration.
    if (appliedIds.length) await this.markSchedulesSaved(appliedIds);
  }

  private async markSchedulesSaved(ids: number[]) {
    await CrontabModel.update({ saved: true }, { where: { id: ids, saved: false } });
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
          isValidCronSchedule(schedule)
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
          max_queue_wait: doc.max_queue_wait,
          skip_if_pending: Boolean(doc.skip_if_pending),
          catchup_seconds: doc.catchup_seconds,
          recovery_from: doc.recovery_from,
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
      await this.run(bootTasks.map((task) => task.id!), 'boot');
    }
  }
}

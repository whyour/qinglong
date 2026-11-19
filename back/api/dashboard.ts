import config from '../config';
import { stat } from 'fs/promises';
import { resolveFileAccess } from '../shared/fileAccess';
import { AnomalyPage, AnomalyKind } from '../shared/scheduleAnomalies';
import { auditSchedule } from '../shared/scheduleAudit';
import { systemScheduleAudit } from '../shared/systemScheduleAudit';
import { celebrate, Joi } from 'celebrate';
import { executionIdPattern, executionTriggerId, receiptFinishTime } from '../shared/executionIdentity';
import { oldestQueued } from '../shared/queueDiagnostics';
import { containerResources } from '../shared/containerResources';
import { TriggerHistory } from '../shared/triggerHistory';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { fn, col, where, Op, QueryTypes } from 'sequelize';
import { CrontabModel } from '../data/cron';
import { CrontabStatModel } from '../data/cronStats';
import {
  RunningInstanceModel,
  InstanceStatus,
} from '../data/runningInstance';
import dayjs from 'dayjs';
import os from 'os';
import { isEmpty } from 'lodash';
import { t, tf } from '../shared/i18n';

function averageElapsed(totalTime: number, runs: number, untimed: number) {
  const samples = Number(runs) - (Number(untimed) || 0);
  return samples > 0 ? Math.round(Number(totalTime) / samples) : 0;
}

const route = Router();

export default (app: Router) => {
  app.use('/dashboard', route);

  route.post('/record', async (req: Request, res: Response) => {
    try {
      const { ref_id, code, elapsed, trigger_id, execution_id } = req.body;
      if (!ref_id) return res.send({ code: 400, message: 'ref_id required' });

      if (trigger_id != null && (typeof trigger_id !== 'string' || !/^[a-z0-9-]{1,120}$/.test(trigger_id))) {
        return res.send({ code: 400 });
      }
      if (execution_id !== undefined && (trigger_id !== undefined ||
          typeof execution_id !== 'string' || !executionIdPattern.test(execution_id))) return res.send({ code: 400 });
      const id = execution_id ? executionTriggerId(execution_id) : trigger_id;
      // Old wrappers also send a status receipt with the process identity.
      // A stats-only retry cannot be distinguished from another identical run.
      if (!id) return res.send({ code: 200, data: { counted: false, reason: 'missing_execution_identity' } });
      const exitCode = typeof code === 'string' && /^-?\d+$/.test(code) ? Number(code) : code;
      const elapsedMs = Number(elapsed ?? 0) * 1000;
      if (!Number.isInteger(exitCode) || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
        return res.send({ code: 400, message: 'invalid exit code or elapsed time' });
      }
      await new TriggerHistory(CrontabStatModel.sequelize!).recordShellResult(id, Number(ref_id), exitCode, elapsedMs, Date.now(), receiptFinishTime(req.get('X-QL-Finished-At')));
      res.send({ code: 200 });
    } catch (e) {
      res.send({ code: 500 });
    }
  });

  route.get(
    '/overview',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const serverNow = Date.now();
        const day = dayjs(serverNow).startOf('day');
        const today = day.format('YYYY-MM-DD');

        const [total, enabled, disabled, stats, triggers] = await Promise.all([
          CrontabModel.count(),
          CrontabModel.count({ where: { isDisabled: 0 } }),
          CrontabModel.count({ where: { isDisabled: 1 } }),
          CrontabStatModel.findOne({
            attributes: [
              [fn('SUM', col('run_count')), 'total_runs'],
              [fn('SUM', col('success_count')), 'total_success'],
              [fn('SUM', col('fail_count')), 'total_fail'],
              [fn('SUM', col('untimed_count')), 'untimed_count'],
              [fn('SUM', col('total_time')), 'total_time'],
            ],
            where: { date: today },
            raw: true,
          }),
          new TriggerHistory(CrontabStatModel.sequelize!).metrics(day.valueOf()),
        ]);

        const row = stats as any;
        const totalRuns = Number(row?.total_runs) || 0;
        const totalSuccess = Number(row?.total_success) || 0;
        const totalFail = Number(row?.total_fail) || 0;
        const totalTime = Number(row?.total_time) || 0;

        res.send({
          code: 200,
          data: {
            serverNow,
            expiresAt: day.add(1, 'day').valueOf(),
            total,
            enabled,
            disabled,
            triggers,
            todayRuns: totalRuns,
            todaySuccess: totalSuccess,
            todayFail: totalFail,
            todayStopped: totalRuns - totalSuccess - totalFail,
            successRate: totalRuns > 0 ? ((totalSuccess / totalRuns) * 100).toFixed(1) : '0',
            avgTime: averageElapsed(totalTime,totalRuns,row?.untimed_count),
          },
        });
      } catch (e) {
        next(e);
      }
    },
  );

  route.get('/schedule-anomalies', celebrate({ query: Joi.object({
    source: Joi.string().valid('panel', 'system').required(),
    kind: Joi.string().valid('missing', 'skipped', 'unconfirmed').required(),
    at: Joi.number().integer().positive().required(),
    page: Joi.number().integer().min(1).default(1),
    revision: Joi.string().hex().length(64),
    live: Joi.boolean().default(false),
  }).unknown(true) }), async (req, res, next) => {
    try {
      const { source, kind, page, at, revision, live } = req.query;
      const until = Number(at);
      const serverNow = Date.now();
      const expiresAt = dayjs(until).startOf('day').add(1, 'day').valueOf();
      if (live && serverNow >= expiresAt)
        return res.send({ code: 200, data: { status: 'expired' } });
      if (until > Date.now() || until < dayjs().subtract(1, 'day').startOf('day').valueOf())
        return res.status(400).send({ code: 400 });
      const [snapshotRetention] = live ? await CrontabStatModel.sequelize!.query<{ cutoff: number }>(
        'SELECT cutoff FROM CronHistoryRetention WHERE id=1', { type: QueryTypes.SELECT },
      ) : [];
      const details = new AnomalyPage(kind as AnomalyKind, Number(page), revision as string | undefined);
      const audit = source === 'panel' ? auditSchedule : systemScheduleAudit;
      const summary = await audit(CrontabStatModel.sequelize!, dayjs(until).startOf('day').valueOf(), until, details);
      if (live && (!summary || summary.since > summary.through))
        return res.send({ code: 200, data: { status: 'unavailable' } });
      if (!summary) return res.status(409).send({ code: 409 });
      const result = details.result();
      const ids = [...new Set(result.rows.filter(row => !row.name).map(row => row.task))];
      const tasks = ids.length ? await CrontabModel.findAll({ where: { id: ids }, attributes: ['id','name','command'], raw: true }) : [];
      const names = new Map(tasks.map(task => [task.id, task.name || task.command]));
      const rows = await Promise.all(result.rows.map(async ({ logPath, ...row }) => {
        const path = logPath && resolveFileAccess(config.logPath, [logPath]);
        const hasLog = path ? await stat(path).then(file => file.isFile(), () => false) : false;
        return { ...row, name: row.name || names.get(row.task), hasLog };
      }));
      // Log checks can yield after the audit transaction. Do not publish that
      // snapshot if history cleanup has since removed part of its plan window.
      if (live) {
        const [retention] = await CrontabStatModel.sequelize!.query<{ cutoff: number }>(
          'SELECT cutoff FROM CronHistoryRetention WHERE id=1', { type: QueryTypes.SELECT },
        );
        if (retention && retention.cutoff > (snapshotRetention?.cutoff ?? 0))
          return res.send({ code: 200, data: { status: 'unavailable' } });
      }
      if (live && Date.now() >= expiresAt)
        return res.send({ code: 200, data: { status: 'expired' } });
      return res.send({ code: 200, data: { ...result, rows, serverNow, expiresAt, summary: source === 'panel' ? { audit: summary } : { systemAudit: summary }, zone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    } catch (error) { next(error); }
  });

  for (const isSuccess of [false, true]) {
    route.get(
      isSuccess ? '/successes' : '/failures',
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const countColumn = isSuccess ? 'success_count' : 'fail_count';
          const rows = (await CrontabStatModel.findAll({
            attributes: ['ref_id', [fn('SUM', col(countColumn)), 'result_count']],
            where: { date: dayjs().format('YYYY-MM-DD'), [countColumn]: { [Op.gt]: 0 } },
            group: ['ref_id'],
            order: [[fn('SUM', col(countColumn)), 'DESC'], ['ref_id', 'ASC']],
            raw: true,
          })) as any[];
          const crons = rows.length > 0 ? await CrontabModel.findAll({
            attributes: ['id', 'name', 'command'],
            where: { id: { [Op.in]: rows.map((row) => Number(row.ref_id)) } },
            raw: true,
          }) : [];
          const cronMap = new Map(crons.map((cron) => [cron.id, cron]));
          res.send({
            code: 200,
            data: rows.map((row) => {
              const id = Number(row.ref_id);
              const cron = cronMap.get(id);
              return {
                id,
                name: cron?.name || cron?.command || tf('任务#%s', id),
                command: cron?.command || '',
                [isSuccess ? 'successCount' : 'failCount']: Number(row.result_count),
                deleted: !cron,
              };
            }),
          });
        } catch (e) {
          next(e);
        }
      },
    );
  }

  route.get(
    '/trend',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const days = parseInt(req.query.days as string) || 7;
        const dates: string[] = [];
        for (let i = days - 1; i >= 0; i--) {
          dates.push(dayjs().subtract(i, 'day').format('YYYY-MM-DD'));
        }

        const rows = (await CrontabStatModel.findAll({
          attributes: [
            'date',
            [fn('SUM', col('run_count')), 'total_runs'],
            [fn('SUM', col('success_count')), 'total_success'],
            [fn('SUM', col('fail_count')), 'total_fail'],
          ],
          where: {
            date: { [Op.in]: dates },
          },
          group: ['date'],
          order: [['date', 'ASC']],
          raw: true,
        })) as any[];

        const dataMap: Record<string, any> = {};
        rows.forEach((r: any) => {
          dataMap[r.date] = {
            total: Number(r.total_runs) || 0,
            success: Number(r.total_success) || 0,
            fail: Number(r.total_fail) || 0,
          };
        });

        const data = dates.map((d) => ({
          date: dayjs(d).format('MM-DD'),
          ...(dataMap[d] || { total: 0, success: 0, fail: 0 }),
        }));

        res.send({ code: 200, data });
      } catch (e) {
        next(e);
      }
    },
  );

  route.get(
    '/top-time',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const today = dayjs().format('YYYY-MM-DD');

        const rows = (await CrontabStatModel.findAll({
          attributes: [
            'ref_id',
            [fn('SUM', col('untimed_count')), 'untimed_count'],
            [fn('SUM', col('total_time')), 'total_time'],
            [fn('SUM', col('run_count')), 'run_count'],
            [fn('MAX', col('max_time')), 'max_time'],
          ],
          where: { date: today, run_count: { [Op.gt]: 0 } },
          group: ['ref_id'],
          order: [[fn('SUM', col('total_time')), 'DESC']],
          limit: 5,
          raw: true,
        })) as any[];

        const ids = rows.map((r) => Number(r.ref_id));
        const crons = await CrontabModel.findAll({
          where: { id: { [Op.in]: ids } },
          raw: true,
        });
        const nameMap: Record<number, string> = {};
        crons.forEach((c: any) => { nameMap[c.id] = c.name || c.command; });

        const data = rows.map((r: any, i) => ({
          rank: i + 1,
          name: nameMap[Number(r.ref_id)] || tf('任务#%s', r.ref_id),
          avgTime: averageElapsed(r.total_time,r.run_count,r.untimed_count),
          maxTime: Number(r.max_time),
        }));

        res.send({ code: 200, data });
      } catch (e) {
        next(e);
      }
    },
  );

  route.get(
    '/top-count',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const today = dayjs().format('YYYY-MM-DD');

        const rows = (await CrontabStatModel.findAll({
          attributes: [
            'ref_id',
            [fn('SUM', col('run_count')), 'run_count'],
            [fn('SUM', col('untimed_count')), 'untimed_count'],
            [fn('SUM', col('total_time')), 'total_time'],
            [fn('SUM', col('success_count')), 'success_count'],
          ],
          where: { date: today, run_count: { [Op.gt]: 0 } },
          group: ['ref_id'],
          order: [[fn('SUM', col('run_count')), 'DESC']],
          limit: 5,
          raw: true,
        })) as any[];

        const ids = rows.map((r) => Number(r.ref_id));
        const crons = await CrontabModel.findAll({
          where: { id: { [Op.in]: ids } },
          raw: true,
        });
        const nameMap: Record<number, string> = {};
        crons.forEach((c: any) => { nameMap[c.id] = c.name || c.command; });

        const data = rows.map((r: any, i) => ({
          rank: i + 1,
          name: nameMap[Number(r.ref_id)] || tf('任务#%s', r.ref_id),
          runCount: Number(r.run_count),
          avgTime: averageElapsed(r.total_time,r.run_count,r.untimed_count),
          successRate:
            Number(r.run_count) > 0
              ? ((Number(r.success_count) / Number(r.run_count)) * 100).toFixed(1)
              : '0',
        }));

        res.send({ code: 200, data });
      } catch (e) {
        next(e);
      }
    },
  );

  route.get(
    '/runtime',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const queued = await new TriggerHistory(CrontabModel.sequelize!).queueCounts();
        const runningInstances = await RunningInstanceModel.findAll({
          where: {
            status: InstanceStatus.running,
          },
          raw: true,
        });

        // Fetch cron names for running instances
        const cronIds = [
          ...new Set(runningInstances.map((i: any) => i.cron_id)),
        ];
        const crons =
          cronIds.length > 0
            ? await CrontabModel.findAll({
              where: { id: cronIds },
              raw: true,
            })
            : [];
        const cronMap = new Map(crons.map((c: any) => [c.id, c]));

        const now = dayjs().unix();
        const running = runningInstances.map((inst: any) => {
          const cron = cronMap.get(inst.cron_id);
          return {
            instanceId: inst.id,
            id: inst.cron_id,
            name: cron?.name || cron?.command || tf('任务#%s', inst.cron_id),
            pid: inst.pid,
            elapsed: inst.started_at ? now - inst.started_at : 0,
            logPath: inst.log_path,
          };
        });

        const dayAgo = dayjs().subtract(24, 'hour').unix();
        const idleTasks = await CrontabModel.findAll({
          where: {
            isDisabled: 0,
            status: 1,
            last_execution_time: { [Op.lt]: dayAgo },
          },
          order: [['last_execution_time', 'ASC']],
          limit: 5,
          raw: true,
        });

        res.send({
          code: 200,
          data: {
            runningCount: running.length,
            queuedCount: queued.triggers,
            queuedTasks: queued.tasks,
            oldestQueued: queued.triggers ? await oldestQueued(CrontabModel.sequelize!) : [],
            running,
            idleTasks: idleTasks.map((c: any) => ({
              id: c.id,
              name: c.name || c.command || tf('任务#%s', c.id),
              lastRun: c.last_execution_time
                ? dayjs.unix(c.last_execution_time).format('MM-DD HH:mm')
                : '-',
            })),
          },
        });
      } catch (e) {
        next(e);
      }
    },
  );

  route.get(
    '/labels',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const today = dayjs().format('YYYY-MM-DD');
        const [crons, stats] = (await Promise.all([
          CrontabModel.findAll({ where: { isDisabled: 0 }, raw: true }),
          CrontabStatModel.findAll({ where: { date: today }, raw: true }),
        ]));

        const statMap: Record<number, any> = {};
        stats.forEach((s: any) => { statMap[s.ref_id] = s; });

        const labelMap: Record<string, { count: number; runs: number; success: number; untimed: number; totalTime: number }> = {};
        crons.forEach((c) => {
          let rawLabels = c.labels;
          if (typeof rawLabels === 'string') rawLabels = JSON.parse(rawLabels);
          const labels: string[] = Array.isArray(rawLabels)
            ? [...new Set((rawLabels as string[]).filter((l: string) => !isEmpty(l)))]
            : [];
          if (labels.length === 0) {
            labels.push(t('未分类'));
          }
          const st = statMap[c.id!];
          labels.forEach((label: string) => {
            if (!labelMap[label]) labelMap[label] = { count: 0, runs: 0, success: 0, untimed: 0, totalTime: 0 };
            labelMap[label].count += 1;
            if (st) {
              labelMap[label].runs += Number(st.run_count) || 0;
              labelMap[label].success += Number(st.success_count) || 0;
              labelMap[label].untimed += Number(st.untimed_count) || 0;
              labelMap[label].totalTime += Number(st.total_time) || 0;
            }
          });
        });

        const data = Object.entries(labelMap)
          .map(([label, v]) => ({
            label,
            count: v.count,
            todayRuns: v.runs,
            successRate: v.runs > 0 ? ((v.success / v.runs) * 100).toFixed(1) : '0',
            avgTime: averageElapsed(v.totalTime,v.runs,v.untimed),
          }))
          .sort((a, b) => b.todayRuns - a.todayRuns);

        res.send({ code: 200, data });
      } catch (e) {
        next(e);
      }
    },
  );

  route.get(
    '/system',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const memUsage = process.memoryUsage();
        res.send({
          code: 200,
          data: {
            platform: os.platform(),
            uptime: Math.floor(process.uptime()),
            ...containerResources(),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            loadAvg: os.loadavg().map((v) => Number(v.toFixed(2))),
          },
        });
      } catch (e) {
        next(e);
      }
    },
  );
};

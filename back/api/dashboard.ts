import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { fn, col, where, Op } from 'sequelize';
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

const route = Router();

export default (app: Router) => {
  app.use('/dashboard', route);

  route.post('/record', async (req: Request, res: Response) => {
    try {
      const { ref_id, code, elapsed } = req.body;
      if (!ref_id) return res.send({ code: 400, message: 'ref_id required' });

      const today = dayjs().format('YYYY-MM-DD');
      const isSuccess = code === 0 ? 1 : 0;
      const isFail = code !== 0 ? 1 : 0;
      const elapsedMs = (Number(elapsed) || 0) * 1000;

      const existing = await CrontabStatModel.findOne({
        where: { ref_id: Number(ref_id), date: today },
      });

      if (existing) {
        await CrontabStatModel.update(
          {
            run_count: (existing.run_count || 0) + 1,
            success_count: (existing.success_count || 0) + isSuccess,
            fail_count: (existing.fail_count || 0) + isFail,
            total_time: (existing.total_time || 0) + elapsedMs,
            max_time: Math.max(existing.max_time || 0, elapsedMs),
          },
          { where: { id: existing.id } },
        );
      } else {
        await CrontabStatModel.create({
          ref_id: Number(ref_id),
          date: today,
          run_count: 1,
          success_count: isSuccess,
          fail_count: isFail,
          total_time: elapsedMs,
          max_time: elapsedMs,
        });
      }

      res.send({ code: 200 });
    } catch (e) {
      res.send({ code: 500 });
    }
  });

  route.get(
    '/overview',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const today = dayjs().format('YYYY-MM-DD');

        const [total, enabled, disabled, stats] = await Promise.all([
          CrontabModel.count(),
          CrontabModel.count({ where: { isDisabled: 0 } }),
          CrontabModel.count({ where: { isDisabled: 1 } }),
          CrontabStatModel.findOne({
            attributes: [
              [fn('SUM', col('run_count')), 'total_runs'],
              [fn('SUM', col('success_count')), 'total_success'],
              [fn('SUM', col('fail_count')), 'total_fail'],
              [fn('SUM', col('total_time')), 'total_time'],
            ],
            where: { date: today },
            raw: true,
          }),
        ]);

        const row = stats as any;
        const totalRuns = Number(row?.total_runs) || 0;
        const totalSuccess = Number(row?.total_success) || 0;
        const totalFail = Number(row?.total_fail) || 0;
        const totalTime = Number(row?.total_time) || 0;

        res.send({
          code: 200,
          data: {
            total,
            enabled,
            disabled,
            todayRuns: totalRuns,
            todaySuccess: totalSuccess,
            todayFail: totalFail,
            successRate: totalRuns > 0 ? ((totalSuccess / totalRuns) * 100).toFixed(1) : '0',
            avgTime: totalRuns > 0 ? Math.round(totalTime / totalRuns) : 0,
          },
        });
      } catch (e) {
        next(e);
      }
    },
  );

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
          avgTime: Math.round(Number(r.total_time) / Number(r.run_count)),
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
          avgTime: Math.round(Number(r.total_time) / Number(r.run_count)),
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
        const runningInstances = await RunningInstanceModel.findAll({
          where: {
            status: InstanceStatus.running,
          },
          raw: true,
        });

        const queuedCrons = await CrontabModel.findAll({
          where: {
            status: 3, // queued
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
            queuedCount: queuedCrons.length,
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

        const labelMap: Record<string, { count: number; runs: number; success: number; totalTime: number }> = {};
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
            if (!labelMap[label]) labelMap[label] = { count: 0, runs: 0, success: 0, totalTime: 0 };
            labelMap[label].count += 1;
            if (st) {
              labelMap[label].runs += Number(st.run_count) || 0;
              labelMap[label].success += Number(st.success_count) || 0;
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
            avgTime: v.runs > 0 ? Math.round(v.totalTime / v.runs) : 0,
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
            memTotal: os.totalmem(),
            memFree: os.freemem(),
            memUsagePercent: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            loadAvg: os.loadavg().map((v) => Number(v.toFixed(2))),
            cpus: os.cpus().length,
          },
        });
      } catch (e) {
        next(e);
      }
    },
  );
};

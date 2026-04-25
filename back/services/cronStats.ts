import { Service, Inject } from 'typedi';
import winston from 'winston';
import { CrontabModel, CrontabStatus } from '../data/cron';
import { CronLogModel } from '../data/cronLog';
import { Op } from 'sequelize';
import dayjs from 'dayjs';

@Service()
export default class CronStatsService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  public async stats() {
    const todayStart = dayjs().startOf('day').unix();
    const todayEnd = dayjs().endOf('day').unix();

    const [allCrons, todayLogs] = await Promise.all([
      CrontabModel.findAll({ where: {} }),
      CronLogModel.findAll({
        where: {
          start_time: { [Op.between]: [todayStart, todayEnd] },
        },
      }),
    ]);

    const total = allCrons.length;
    const enabled = allCrons.filter((c) => c.isDisabled !== 1).length;
    const disabled = allCrons.filter((c) => c.isDisabled === 1).length;

    const todayCount = todayLogs.length;
    const todayTotalDuration = todayLogs.reduce(
      (sum, l) => sum + (l.duration || 0),
      0,
    );
    const todayAvgDuration =
      todayCount > 0 ? Math.round(todayTotalDuration / todayCount) : 0;

    return {
      total,
      enabled,
      disabled,
      today: {
        count: todayCount,
        avgDuration: todayAvgDuration,
      },
    };
  }

  public async trend() {
    const days = 7;
    const result: Array<{
      date: string;
      count: number;
    }> = [];

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = dayjs().subtract(i, 'day').startOf('day').unix();
      const dayEnd = dayjs().subtract(i, 'day').endOf('day').unix();
      const date = dayjs().subtract(i, 'day').format('MM-DD');

      const logs = await CronLogModel.findAll({
        where: {
          start_time: { [Op.between]: [dayStart, dayEnd] },
        },
      });

      result.push({
        date,
        count: logs.length,
      });
    }

    return result;
  }

  public async topDuration(limit = 5) {
    const todayStart = dayjs().startOf('day').unix();
    const todayEnd = dayjs().endOf('day').unix();

    const logs = await CronLogModel.findAll({
      where: {
        start_time: { [Op.between]: [todayStart, todayEnd] },
      },
    });

    const grouped: Record<
      number,
      { cron_id: number; cron_name: string; durations: number[] }
    > = {};

    for (const log of logs) {
      if (!grouped[log.cron_id]) {
        grouped[log.cron_id] = {
          cron_id: log.cron_id,
          cron_name: log.cron_name,
          durations: [],
        };
      }
      grouped[log.cron_id].durations.push(log.duration);
    }

    const result = Object.values(grouped)
      .map((g) => {
        const avgDuration = Math.round(
          g.durations.reduce((a, b) => a + b, 0) / g.durations.length,
        );
        const maxDuration = Math.max(...g.durations);
        return {
          cron_id: g.cron_id,
          cron_name: g.cron_name,
          count: g.durations.length,
          avgDuration,
          maxDuration,
        };
      })
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, limit);

    return result;
  }

  public async topCount(limit = 5) {
    const todayStart = dayjs().startOf('day').unix();
    const todayEnd = dayjs().endOf('day').unix();

    const logs = await CronLogModel.findAll({
      where: {
        start_time: { [Op.between]: [todayStart, todayEnd] },
      },
    });

    const grouped: Record<
      number,
      { cron_id: number; cron_name: string; durations: number[] }
    > = {};

    for (const log of logs) {
      if (!grouped[log.cron_id]) {
        grouped[log.cron_id] = {
          cron_id: log.cron_id,
          cron_name: log.cron_name,
          durations: [],
        };
      }
      grouped[log.cron_id].durations.push(log.duration);
    }

    const result = Object.values(grouped)
      .map((g) => {
        const avgDuration = Math.round(
          g.durations.reduce((a, b) => a + b, 0) / g.durations.length,
        );
        return {
          cron_id: g.cron_id,
          cron_name: g.cron_name,
          count: g.durations.length,
          avgDuration,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return result;
  }
}

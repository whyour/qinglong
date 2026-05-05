import { Service, Inject } from 'typedi';
import winston from 'winston';
import { CrontabModel } from '../data/cron';
import { CronLog, CronLogModel } from '../data/cronLog';
import { Op } from 'sequelize';
import dayjs from 'dayjs';

type GroupedLog = {
  cron_id: number;
  cron_name: string;
  durations: number[];
};

@Service()
export default class CronStatsService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  private groupLogsByCronId(logs: CronLog[]): Record<number, GroupedLog> {
    const grouped: Record<number, GroupedLog> = {};
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
    return grouped;
  }

  private avgOf(nums: number[]): number {
    if (nums.length === 0) return 0;
    return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  }

  private getTodayRange() {
    return {
      start: dayjs().startOf('day').unix(),
      end: dayjs().endOf('day').unix(),
    };
  }

  public async stats() {
    const { start, end } = this.getTodayRange();

    const [allCrons, todayLogs] = await Promise.all([
      CrontabModel.findAll({ where: {} }),
      CronLogModel.findAll({
        where: { start_time: { [Op.between]: [start, end] } },
      }),
    ]);

    const total = allCrons.length;
    const enabled = allCrons.filter((c: any) => c.isDisabled !== 1).length;
    const disabled = allCrons.filter((c: any) => c.isDisabled === 1).length;

    const todayCount = todayLogs.length;
    const todayTotalDuration = todayLogs.reduce(
      (sum: number, l: any) => sum + (l.duration || 0),
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
    const result: Array<{ date: string; count: number }> = [];

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = dayjs().subtract(i, 'day').startOf('day').unix();
      const dayEnd = dayjs().subtract(i, 'day').endOf('day').unix();
      const date = dayjs().subtract(i, 'day').format('MM-DD');

      const logs = await CronLogModel.findAll({
        where: { start_time: { [Op.between]: [dayStart, dayEnd] } },
      });

      result.push({ date, count: logs.length });
    }

    return result;
  }

  public async topDuration(limit = 5) {
    const { start, end } = this.getTodayRange();

    const logs = await CronLogModel.findAll({
      where: { start_time: { [Op.between]: [start, end] } },
    });

    const grouped = this.groupLogsByCronId(logs as any);

    return Object.values(grouped)
      .map((g) => ({
        cron_id: g.cron_id,
        cron_name: g.cron_name,
        count: g.durations.length,
        avgDuration: this.avgOf(g.durations),
        maxDuration: Math.max(...g.durations),
      }))
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, limit);
  }

  public async topCount(limit = 5) {
    const { start, end } = this.getTodayRange();

    const logs = await CronLogModel.findAll({
      where: { start_time: { [Op.between]: [start, end] } },
    });

    const grouped = this.groupLogsByCronId(logs as any);

    return Object.values(grouped)
      .map((g) => ({
        cron_id: g.cron_id,
        cron_name: g.cron_name,
        count: g.durations.length,
        avgDuration: this.avgOf(g.durations),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }
}

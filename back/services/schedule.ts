import { Service, Inject } from 'typedi';
import winston from 'winston';
import nodeSchedule from 'node-schedule';
import { Crontab } from '../data/cron';
import { exec } from 'child_process';

@Service()
export default class ScheduleService {
  private scheduleStacks = new Map<string, nodeSchedule.Job>();

  constructor(@Inject('logger') private logger: winston.Logger) {}

  async generateSchedule({ _id = '', command, name, schedule }: Crontab) {
    this.logger.info(
      '[创建定时任务]，任务ID: %s，cron: %s，任务名: %s，任务方法: %s',
      _id,
      schedule,
      name,
    );

    this.scheduleStacks.set(
      _id,
      nodeSchedule.scheduleJob(_id, schedule, async () => {
        try {
          exec(command, async (error, stdout, stderr) => {
            if (error) {
              await this.logger.info(
                '执行任务`%s`失败，时间：%s, 错误信息：%j',
                name,
                new Date().toLocaleString(),
                error,
              );
            }

            if (stderr) {
              await this.logger.info(
                '执行任务`%s`失败，时间：%s, 错误信息：%j',
                name,
                new Date().toLocaleString(),
                stderr,
              );
            }
          });
        } catch (error) {
          await this.logger.info(
            '执行任务`%s`失败，时间：%s, 错误信息：%j',
            name,
            new Date().toLocaleString(),
            error,
          );
        } finally {
        }
      }),
    );
  }

  async cancelSchedule({ _id = '', name }: Crontab) {
    this.logger.info('[取消定时任务]，任务名：%s', name);
    this.scheduleStacks.has(_id) && this.scheduleStacks.get(_id)?.cancel();
  }
}

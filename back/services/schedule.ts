import { Service, Inject } from 'typedi';
import winston from 'winston';
import nodeSchedule from 'node-schedule';
import { Crontab } from '../data/cron';
import { exec } from 'child_process';

@Service()
export default class ScheduleService {
  private scheduleStacks = new Map<number, nodeSchedule.Job>();

  constructor(@Inject('logger') private logger: winston.Logger) {}

  async generateSchedule({ id = 0, command, name, schedule }: Crontab) {
    this.logger.info(
      '[创建定时任务]，任务ID: %s，cron: %s，任务名: %s，执行命令: %s',
      id,
      schedule,
      name,
      command,
    );

    this.scheduleStacks.set(
      id,
      nodeSchedule.scheduleJob(id + '', schedule, async () => {
        try {
          exec(command, async (error, stdout, stderr) => {
            if (error) {
              await this.logger.info(
                '执行任务%s失败，时间：%s, 错误信息：%j',
                command,
                new Date().toLocaleString(),
                error,
              );
            }

            if (stderr) {
              await this.logger.info(
                '执行任务%s失败，时间：%s, 错误信息：%j',
                command,
                new Date().toLocaleString(),
                stderr,
              );
            }
          });
        } catch (error) {
          await this.logger.info(
            '执行任务%s失败，时间：%s, 错误信息：%j',
            command,
            new Date().toLocaleString(),
            error,
          );
        } finally {
        }
      }),
    );
  }

  async cancelSchedule({ id = 0, name }: Crontab) {
    this.logger.info('[取消定时任务]，任务名：%s', name);
    this.scheduleStacks.has(id) && this.scheduleStacks.get(id)?.cancel();
  }
}

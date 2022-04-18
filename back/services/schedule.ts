import { Service, Inject } from 'typedi';
import winston from 'winston';
import nodeSchedule from 'node-schedule';
import { Crontab } from '../data/cron';
import { exec } from 'child_process';
import {
  ToadScheduler,
  LongIntervalJob,
  AsyncTask,
  SimpleIntervalSchedule,
} from 'toad-scheduler';

@Service()
export default class ScheduleService {
  private scheduleStacks = new Map<string, nodeSchedule.Job>();

  private intervalSchedule = new ToadScheduler();

  private maxBuffer = 200 * 1024 * 1024;

  constructor(@Inject('logger') private logger: winston.Logger) {}

  async createCronTask({ id = 0, command, name, schedule = '' }: Crontab) {
    const _id = this.formatId(id);
    this.logger.info(
      '[创建cron任务]，任务ID: %s，cron: %s，任务名: %s，执行命令: %s',
      _id,
      schedule,
      name,
      command,
    );

    this.scheduleStacks.set(
      _id,
      nodeSchedule.scheduleJob(id + '', schedule, async () => {
        try {
          exec(
            command,
            { maxBuffer: this.maxBuffer },
            async (error, stdout, stderr) => {
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
            },
          );
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

  async cancelCronTask({ id = 0, name }: Crontab) {
    const _id = this.formatId(id);
    this.logger.info('[取消定时任务]，任务名：%s', name);
    this.scheduleStacks.has(_id) && this.scheduleStacks.get(_id)?.cancel();
  }

  async createIntervalTask(
    { id = 0, command, name = '' }: Crontab,
    schedule: SimpleIntervalSchedule,
  ) {
    const _id = this.formatId(id);
    this.logger.info(
      '[创建interval任务]，任务ID: %s，任务名: %s，执行命令: %s',
      _id,
      name,
      command,
    );
    const task = new AsyncTask(
      name,
      async () => {
        return new Promise(async (resolve, reject) => {
          try {
            exec(
              command,
              { maxBuffer: this.maxBuffer },
              async (error, stdout, stderr) => {
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
                resolve();
              },
            );
          } catch (error) {
            reject(error);
          }
        });
      },
      (err) => {
        this.logger.info(
          '执行任务%s失败，时间：%s, 错误信息：%j',
          command,
          new Date().toLocaleString(),
          err,
        );
      },
    );

    const job = new LongIntervalJob({ ...schedule }, task, _id);

    this.intervalSchedule.addIntervalJob(job);
  }

  async cancelIntervalTask({ id = 0, name }: Crontab) {
    const _id = this.formatId(id);
    this.logger.info('[取消interval任务]，任务ID: %s，任务名：%s', _id, name);
    this.intervalSchedule.removeById(_id);
  }

  private formatId(id: number): string {
    return String(id);
  }
}

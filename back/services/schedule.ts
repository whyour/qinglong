import { Service, Inject } from 'typedi';
import winston from 'winston';
import nodeSchedule from 'node-schedule';
import { ChildProcessWithoutNullStreams, exec, spawn } from 'child_process';
import {
  ToadScheduler,
  LongIntervalJob,
  AsyncTask,
  SimpleIntervalSchedule,
} from 'toad-scheduler';
import dayjs from 'dayjs';

interface ScheduleTaskType {
  id: number;
  command: string;
  name?: string;
  schedule?: string;
}

export interface TaskCallbacks {
  onBefore?: (startTime: dayjs.Dayjs) => Promise<void>;
  onStart?: (
    cp: ChildProcessWithoutNullStreams,
    startTime: dayjs.Dayjs,
  ) => Promise<void>;
  onEnd?: (
    cp: ChildProcessWithoutNullStreams,
    endTime: dayjs.Dayjs,
    diff: number,
  ) => Promise<void>;
  onLog?: (message: string) => Promise<void>;
  onError?: (message: string) => Promise<void>;
}

@Service()
export default class ScheduleService {
  private scheduleStacks = new Map<string, nodeSchedule.Job>();

  private intervalSchedule = new ToadScheduler();

  private maxBuffer = 200 * 1024 * 1024;

  constructor(@Inject('logger') private logger: winston.Logger) {}

  async runTask(command: string, callbacks: TaskCallbacks = {}) {
    return new Promise(async (resolve, reject) => {
      const startTime = dayjs();
      await callbacks.onBefore?.(startTime);

      const cp = spawn(command, { shell: '/bin/bash' });
      try {
        // TODO:
        callbacks.onStart?.(cp, startTime);

        cp.stdout.on('data', async (data) => {
          await callbacks.onLog?.(data.toString());
        });

        cp.stderr.on('data', async (data) => {
          this.logger.error(
            '执行任务 %s 失败，时间：%s, 错误信息：%j',
            command,
            new Date().toLocaleString(),
            data.toString(),
          );
          await callbacks.onError?.(data.toString());
        });

        cp.on('error', async (err) => {
          this.logger.error(
            '创建任务 %s 失败，时间：%s, 错误信息：%j',
            command,
            new Date().toLocaleString(),
            err,
          );
          await callbacks.onError?.(JSON.stringify(err));
        });

        cp.on('exit', async (code, signal) => {
          this.logger.info(
            `任务 ${command} 进程id: ${cp.pid} 退出，退出码 ${code}`,
          );
        });

        cp.on('close', async (code) => {
          const endTime = dayjs();
          await callbacks.onEnd?.(
            cp,
            endTime,
            endTime.diff(startTime, 'seconds'),
          );
          resolve(null);
        });
      } catch (error) {
        await this.logger.error(
          '执行任务%s失败，时间：%s, 错误信息：%j',
          command,
          new Date().toLocaleString(),
          error,
        );
        await callbacks.onError?.(JSON.stringify(error));
      }
      resolve(cp.pid);
    });
  }

  async createCronTask(
    { id = 0, command, name, schedule = '' }: ScheduleTaskType,
    callbacks?: TaskCallbacks,
    runImmediately = false,
  ) {
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
      nodeSchedule.scheduleJob(_id, schedule, async () => {
        await this.runTask(command, callbacks);
      }),
    );

    if (runImmediately) {
      await this.runTask(command, callbacks);
    }
  }

  async cancelCronTask({ id = 0, name }: ScheduleTaskType) {
    const _id = this.formatId(id);
    this.logger.info('[取消定时任务]，任务名：%s', name);
    this.scheduleStacks.has(_id) && this.scheduleStacks.get(_id)?.cancel();
  }

  async createIntervalTask(
    { id = 0, command, name = '' }: ScheduleTaskType,
    schedule: SimpleIntervalSchedule,
    runImmediately = true,
    callbacks?: TaskCallbacks,
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
          await this.runTask(command, callbacks);
        });
      },
      (err) => {
        this.logger.error(
          '执行任务%s失败，时间：%s, 错误信息：%j',
          command,
          new Date().toLocaleString(),
          err,
        );
      },
    );

    const job = new LongIntervalJob(
      { runImmediately: false, ...schedule },
      task,
      _id,
    );

    this.intervalSchedule.addIntervalJob(job);

    if (runImmediately) {
      await this.runTask(command, callbacks);
    }
  }

  async cancelIntervalTask({ id = 0, name }: ScheduleTaskType) {
    const _id = this.formatId(id);
    this.logger.info('[取消interval任务]，任务ID: %s，任务名：%s', _id, name);
    this.intervalSchedule.removeById(_id);
  }

  private formatId(id: number): string {
    return String(id);
  }
}

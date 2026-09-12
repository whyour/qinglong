import { Service, Inject } from 'typedi';
import winston from 'winston';
import nodeSchedule from 'node-schedule';
import { ChildProcessWithoutNullStreams } from 'child_process';
import {
  ToadScheduler,
  LongIntervalJob,
  SimpleIntervalSchedule,
  Task,
} from 'toad-scheduler';
import dayjs from 'dayjs';
import taskLimit from '../shared/pLimit';
import { spawn } from 'cross-spawn';
import { observeChildProcess, asError, ProcessResult } from '../shared/childProcess';

export interface ScheduleTaskType {
  id?: number;
  command: string;
  name?: string;
  schedule?: string;
  runOrigin: 'subscription' | 'system' | 'script';
}

export interface TaskCallbacks {
  onBefore?: (startTime: dayjs.Dayjs) => Promise<void>;
  onStart?: (
    cp: ChildProcessWithoutNullStreams,
    startTime: dayjs.Dayjs,
  ) => Promise<void>;
  onEnd?: (
    cp: ChildProcessWithoutNullStreams | undefined,
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

  private taskLimitMap = {
    system: 'runWithSystemLimit' as const,
    script: 'runWithScriptLimit' as const,
    subscription: 'runWithSubscriptionLimit' as const,
  };

  constructor(@Inject('logger') private logger: winston.Logger) {}

  async runTask(
    command: string,
    callbacks: TaskCallbacks = {},
    params: {
      schedule?: string;
      name?: string;
      command?: string;
      id: string;
      runOrigin: 'subscription' | 'system' | 'script';
    },
    completionTime: 'start' | 'end' = 'end',
  ) {
    const { runOrigin, ...others } = params;

    let resolveStart!: (pid: number | undefined) => void;
    let rejectStart!: (error: Error) => void;
    const startResult = new Promise<number | undefined>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    // Most scheduled callers only observe completion (or intentionally detach).
    void startResult.catch(() => {});
    const completion = taskLimit[this.taskLimitMap[runOrigin]](
      others,
      async () => {
        const startTime = dayjs();
        let cp: ChildProcessWithoutNullStreams | undefined;
        let result: ProcessResult = { code: null, signal: null };
        try {
          this.logger.info('[panel][开始执行任务] 任务ID: %s', others.id);
          await callbacks.onBefore?.(startTime);
          cp = spawn(command, { shell: '/bin/bash' });
          const child = cp;
          const observed = observeChildProcess(child, {
            onStart: async () => {
              await callbacks.onStart?.(child, startTime);
            },
            onStdout: callbacks.onLog,
            onStderr: callbacks.onError,
          });
          observed.started.then(resolveStart, rejectStart);
          result = await observed.completed;
        } catch (error) {
          result.error = asError(error);
          rejectStart(result.error);
        }

        if (result.error) {
          this.logger.error(
            '[panel][执行任务失败] 任务ID: %s, 错误: %s',
            others.id,
            result.error.message,
          );
          try {
            await callbacks.onError?.(result.error.message);
          } catch (error) {
            this.logger.error(
              '[panel][任务错误回调失败] %s',
              asError(error).message,
            );
          }
        }
        // Cleanup also runs after setup/spawn failure, and only after both pipes drain.
        const endTime = dayjs();
        try {
          await callbacks.onEnd?.(
            cp,
            endTime,
            endTime.diff(startTime, 'seconds'),
          );
        } catch (error) {
          result.error ??= asError(error);
          this.logger.error(
            '[panel][任务结束回调失败] %s',
            asError(error).message,
          );
        }
        this.logger.info(
          '[panel][执行任务结束] 任务ID: %s, 退出码: %j',
          others.id,
          result.code,
        );
        return { ...others, pid: cp?.pid, ...result };
      },
    ).catch((error) => {
      // Queue/setup failures must not become unhandled rejections in detached callers.
      rejectStart(asError(error));
      this.logger.error('[panel][任务队列失败] %s', asError(error).message);
      return { ...others, code: null, signal: null, error: asError(error) };
    });

    // Returning a PID must not release the execution slot while the process runs.
    return completionTime === 'start' ? startResult : completion;
  }

  async createCronTask(
    { id = 0, command, name, schedule = '', runOrigin }: ScheduleTaskType,
    callbacks?: TaskCallbacks,
    runImmediately = false,
  ) {
    const _id = this.formatId(id);
    this.logger.info(
      '[panel][创建cron任务] 任务ID: %s, cron: %s, 任务名: %s, 执行命令: %s',
      _id,
      schedule,
      name,
      command,
    );

    this.scheduleStacks.set(
      _id,
      nodeSchedule.scheduleJob(_id, schedule, async () => {
        this.runTask(command, callbacks, {
          name,
          schedule,
          command,
          id: _id,
          runOrigin,
        });
      }),
    );

    if (runImmediately) {
      this.runTask(command, callbacks, {
        name,
        schedule,
        command,
        id: _id,
        runOrigin,
      });
    }
  }

  async cancelCronTask({ id = 0, name }: ScheduleTaskType) {
    const _id = this.formatId(id);
    this.logger.info('[panel][取消定时任务] 任务名: %s', name);
    if (this.scheduleStacks.has(_id)) {
      this.scheduleStacks.get(_id)?.cancel();
      this.scheduleStacks.delete(_id);
    }
  }

  async createIntervalTask(
    { id = 0, command, name = '', runOrigin }: ScheduleTaskType,
    schedule: SimpleIntervalSchedule,
    runImmediately = true,
    callbacks?: TaskCallbacks,
  ) {
    const _id = this.formatId(id);
    this.logger.info(
      '[panel][创建interval任务] 任务ID: %s, 任务名: %s, 执行命令: %s',
      _id,
      name,
      command,
    );
    const task = new Task(
      name,
      () => {
        this.runTask(command, callbacks, {
          name,
          command,
          id: _id,
          runOrigin,
        });
      },
      (err) => {
        this.logger.error(
          '[panel][执行任务失败] 命令: %s, 错误信息: %j',
          command,
          err,
        );
      },
    );

    const job = new LongIntervalJob(
      { runImmediately: false, ...schedule },
      task,
      { id: _id },
    );

    this.intervalSchedule.addIntervalJob(job);

    if (runImmediately) {
      this.runTask(command, callbacks, {
        name,
        command,
        id: _id,
        runOrigin,
      });
    }
  }

  async cancelIntervalTask({ id = 0, name }: ScheduleTaskType) {
    const _id = this.formatId(id);
    this.logger.info(
      '[panel][取消interval任务] 任务ID: %s, 任务名: %s',
      _id,
      name,
    );
    this.intervalSchedule.removeById(_id);
  }

  private formatId(id: number): string {
    return String(id);
  }
}

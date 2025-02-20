export enum ScheduleType {
  BOOT = '@boot',
  ONCE = '@once',
}

export type ScheduleValidator = (schedule?: string) => boolean;
export type CronSchedulerPayload = {
  name: string;
  id: string;
  schedule: string;
  command: string;
  extra_schedules: Array<{ schedule: string }>;
};

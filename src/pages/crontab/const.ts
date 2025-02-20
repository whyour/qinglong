import { ScheduleType } from './type';

export const scheduleTypeMap = {
  [ScheduleType.Normal]: '',
  [ScheduleType.Once]: '@once',
  [ScheduleType.Boot]: '@boot',
};

export const getScheduleType = (schedule?: string): ScheduleType => {
  if (schedule?.startsWith('@once')) return ScheduleType.Once;
  if (schedule?.startsWith('@boot')) return ScheduleType.Boot;
  return ScheduleType.Normal;
};

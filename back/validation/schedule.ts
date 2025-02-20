import { Joi } from 'celebrate';
import cron_parser from 'cron-parser';
import { ScheduleType } from '../interface/schedule';

const validateSchedule = (value: string, helpers: any) => {
  if (
    value.startsWith(ScheduleType.ONCE) ||
    value.startsWith(ScheduleType.BOOT)
  ) {
    return value;
  }

  try {
    if (cron_parser.parseExpression(value).hasNext()) {
      return value;
    }
  } catch (e) {
    return helpers.error('any.invalid');
  }
  return helpers.error('any.invalid');
};

export const scheduleSchema = Joi.string()
  .required()
  .custom(validateSchedule)
  .messages({
    'any.invalid': '无效的定时规则',
    'string.empty': '定时规则不能为空',
  });

export const commonCronSchema = {
  name: Joi.string().optional(),
  command: Joi.string().required(),
  schedule: scheduleSchema,
  labels: Joi.array().optional(),
  sub_id: Joi.number().optional().allow(null),
  extra_schedules: Joi.array().optional().allow(null),
  task_before: Joi.string().optional().allow('').allow(null),
  task_after: Joi.string().optional().allow('').allow(null),
};

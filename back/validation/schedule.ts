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
  log_name: Joi.string()
    .optional()
    .allow('')
    .allow(null)
    .pattern(/^[a-zA-Z0-9_-]+$/)
    .max(100)
    .messages({
      'string.pattern.base': '日志名称只能包含字母、数字、下划线和连字符',
      'string.max': '日志名称不能超过100个字符',
    }),
};

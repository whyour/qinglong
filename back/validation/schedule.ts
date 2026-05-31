import { Joi } from 'celebrate';
import CronExpressionParser from 'cron-parser';
import { ScheduleType } from '../interface/schedule';
import path from 'path';
import config from '../config';

/**
 * Security validation function to detect potentially malicious shell code patterns
 */
const validateShellSecurity = (value: any, helpers: any, fieldName: string): any => {
  if (!value) return value;

  // Define dangerous patterns that should be blocked
  const dangerousPatterns = [
    // Command substitution
    /\$\([^)]*\)/,
    /`[^`]*`/,
    
    // File downloads
    /\b(curl|wget|fetch)\s+/i,
    
    // Suspicious domains or external URLs
    /https?:\/\/[^\s]+/i,
    
    // Hidden executable files (files starting with . in a path context)
    /\/\.\w+(\s|$|;|&|\||>)/,
    
    // Background process spawning with suspicious names
    /nohup\s+["']?[^\s"']*\/\.\w+/,
    
    // Redirect to dev null combined with downloads (hiding malware output)
    /(curl|wget|fetch)[^;]*>.*\/dev\/null.*&/i,
    
    // Base64 decode patterns (often used to obfuscate malicious code)
    /\b(base64|decode|eval)\s+/i,
    
    // Executable files in /tmp with chmod or execution
    /\/tmp\/[^\s]+\s*(&&|;)\s*(chmod|\.\/)/ ,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(value)) {
      return helpers.error('string.unsafe', { 
        pattern: pattern.source,
        field: fieldName 
      });
    }
  }

  // Check for excessive length (potential buffer overflow or obfuscation)
  if (value.length > 10000) {
    return helpers.error('string.max', { limit: 10000 });
  }

  return value;
};

const validateSchedule = (value: string, helpers: any) => {
  if (
    value.startsWith(ScheduleType.ONCE) ||
    value.startsWith(ScheduleType.BOOT)
  ) {
    return value;
  }

  try {
    if (CronExpressionParser.parse(value).hasNext()) {
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
  command: Joi.string().required().custom((value: any, helpers: any) => {
    return validateShellSecurity(value, helpers, 'command');
  }).messages({
    'string.unsafe': '命令包含潜在危险的模式，已被安全系统拦截',
  }),
  schedule: scheduleSchema,
  labels: Joi.array().optional(),
  sub_id: Joi.number().optional().allow(null),
  extra_schedules: Joi.array().optional().allow(null),
  task_before: Joi.string().optional().allow('').allow(null).custom((value: any, helpers: any) => {
    return validateShellSecurity(value, helpers, 'task_before');
  }).messages({
    'string.unsafe': '前置命令包含潜在危险的模式，已被安全系统拦截',
  }),
  task_after: Joi.string().optional().allow('').allow(null).custom((value: any, helpers: any) => {
    return validateShellSecurity(value, helpers, 'task_after');
  }).messages({
    'string.unsafe': '后置命令包含潜在危险的模式，已被安全系统拦截',
  }),
  log_name: Joi.string()
    .optional()
    .allow('')
    .allow(null)
    .custom((value, helpers) => {
      if (!value) return value;

      // Check if it's an absolute path
      if (value.startsWith('/')) {
        // Allow /dev/null as special case
        if (value === '/dev/null') {
          return value;
        }

        // For other absolute paths, ensure they are within the safe log directory
        const normalizedValue = path.normalize(value);
        const normalizedLogPath = path.normalize(config.logPath);

        if (!normalizedValue.startsWith(normalizedLogPath)) {
          return helpers.error('string.unsafePath');
        }

        return value;
      }

      if (
        !/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?:\/)?(?:[\w.-]+\/)*[\w.-]+\/?$/.test(
          value,
        )
      ) {
        return helpers.error('string.pattern.base');
      }
      if (value.length > 100) {
        return helpers.error('string.max');
      }
      return value;
    })
    .messages({
      'string.pattern.base': '日志名称只能包含字母、数字、下划线和连字符',
      'string.max': '日志名称不能超过100个字符',
      'string.unsafePath': '绝对路径必须在日志目录内或使用 /dev/null',
    }),
  allow_multiple_instances: Joi.number().optional().valid(0, 1).allow(null),
};

// Persisted SQLite names and types are part of the rollback contract.
type Field = {
  type: string;
  fieldName: string;
  nullable?: boolean;
  primary?: boolean;
  autoincrement?: boolean;
};
function entity<Name extends string>(
  name: Name,
  tableName: string,
  groups: Record<string, string[]>,
  required: string[] = [],
) {
  const properties: Record<string, Field> = {
    id: { type: 'number', fieldName: 'id', primary: true, autoincrement: true },
  };
  for (const [type, fields] of Object.entries(groups))
    for (const field of fields)
      properties[field] = {
        type,
        fieldName: field,
        nullable: !required.includes(field),
      };
  for (const field of ['createdAt', 'updatedAt'])
    properties[field] = {
      type: 'legacyDate',
      fieldName: field,
      nullable: false,
    };
  return { name, tableName, properties };
}
export const entityDefinitions = {
  App: entity(
    'App',
    'Apps',
    {
      string: ['name', 'client_id', 'client_secret'],
      json: ['scopes', 'tokens'],
    },
    [],
  ),
  Auth: entity('Auth', 'Auths', { string: ['ip', 'type'], json: ['info'] }, []),
  CrontabStat: entity(
    'CrontabStat',
    'CrontabStats',
    {
      number: [
        'ref_id',
        'run_count',
        'success_count',
        'fail_count',
        'total_time',
        'max_time',
      ],
      string: ['date'],
    },
    ['ref_id', 'date'],
  ),
  CrontabView: entity(
    'CrontabView',
    'CrontabViews',
    {
      string: ['name', 'filterRelation'],
      number: ['position', 'isDisabled', 'type'],
      json: ['filters', 'sorts'],
    },
    [],
  ),
  Crontab: entity(
    'Crontab',
    'Crontabs',
    {
      string: [
        'name',
        'command',
        'schedule',
        'timestamp',
        'log_path',
        'queued_token',
        'task_before',
        'task_after',
        'log_name',
        'work_dir',
      ],
      boolean: ['saved'],
      number: [
        'status',
        'isSystem',
        'pid',
        'isDisabled',
        'isPinned',
        'last_running_time',
        'last_execution_time',
        'sub_id',
        'allow_multiple_instances',
      ],
      json: ['labels', 'extra_schedules'],
    },
    [],
  ),
  Dependence: entity(
    'Dependence',
    'Dependences',
    {
      string: ['name', 'timestamp', 'remark'],
      number: ['type', 'status'],
      json: ['log'],
    },
    [],
  ),
  Env: entity(
    'Env',
    'Envs',
    {
      string: ['value', 'timestamp', 'name', 'remarks'],
      number: ['status', 'position', 'isPinned'],
      json: ['labels'],
    },
    [],
  ),
  RunningInstance: entity(
    'RunningInstance',
    'RunningInstances',
    {
      number: [
        'cron_id',
        'pid',
        'started_at',
        'finished_at',
        'status',
        'exit_code',
      ],
      string: ['log_path'],
    },
    ['cron_id', 'started_at', 'status'],
  ),
  Subscription: entity(
    'Subscription',
    'Subscriptions',
    {
      string: [
        'name',
        'url',
        'schedule',
        'type',
        'whitelist',
        'blacklist',
        'dependences',
        'extensions',
        'sub_before',
        'sub_after',
        'branch',
        'pull_type',
        'log_path',
        'schedule_type',
        'alias',
        'proxy',
      ],
      json: ['interval_schedule', 'pull_option'],
      number: ['status', 'pid', 'is_disabled', 'autoAddCron', 'autoDelCron'],
    },
    [],
  ),
};
export const initialSchema = [
  'CREATE TABLE IF NOT EXISTS `Apps` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255), `scopes` JSON, `client_id` VARCHAR(255), `client_secret` VARCHAR(255), `tokens` JSON, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, UNIQUE (`name`))',
  'CREATE TABLE IF NOT EXISTS `Auths` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `ip` VARCHAR(255), `type` VARCHAR(255), `info` JSON, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)',
  'CREATE TABLE IF NOT EXISTS `CrontabStats` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `ref_id` NUMBER NOT NULL, `date` VARCHAR(255) NOT NULL, `run_count` NUMBER DEFAULT 0, `success_count` NUMBER DEFAULT 0, `fail_count` NUMBER DEFAULT 0, `total_time` NUMBER DEFAULT 0, `max_time` NUMBER DEFAULT 0, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)',
  'CREATE TABLE IF NOT EXISTS `CrontabViews` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255), `position` NUMBER, `isDisabled` NUMBER, `filters` JSON, `sorts` JSON, `filterRelation` VARCHAR(255), `type` NUMBER, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, UNIQUE (`name`))',
  'CREATE TABLE IF NOT EXISTS `Crontabs` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255), `command` VARCHAR(255), `schedule` VARCHAR(255), `timestamp` VARCHAR(255), `saved` TINYINT(1), `status` NUMBER, `isSystem` NUMBER, `pid` NUMBER, `isDisabled` NUMBER, `isPinned` NUMBER, `log_path` VARCHAR(255), `queued_token` VARCHAR(255), `labels` JSON, `last_running_time` NUMBER, `last_execution_time` NUMBER, `sub_id` NUMBER, `extra_schedules` JSON, `task_before` VARCHAR(255), `task_after` VARCHAR(255), `log_name` VARCHAR(255), `allow_multiple_instances` NUMBER, `work_dir` VARCHAR(255), `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, UNIQUE (`name`, `command`, `schedule`))',
  'CREATE TABLE IF NOT EXISTS `Dependences` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255), `type` NUMBER, `timestamp` VARCHAR(255), `status` NUMBER, `log` JSON, `remark` VARCHAR(255), `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)',
  'CREATE TABLE IF NOT EXISTS `Envs` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `value` VARCHAR(255), `timestamp` VARCHAR(255), `status` NUMBER, `position` NUMBER, `name` VARCHAR(255), `remarks` VARCHAR(255), `isPinned` NUMBER, `labels` JSON, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, UNIQUE (`value`, `name`))',
  'CREATE TABLE IF NOT EXISTS `RunningInstances` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `cron_id` NUMBER NOT NULL, `pid` NUMBER, `log_path` VARCHAR(255), `started_at` NUMBER NOT NULL, `finished_at` NUMBER, `status` NUMBER NOT NULL DEFAULT 0, `exit_code` NUMBER, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL)',
  'CREATE TABLE IF NOT EXISTS `Subscriptions` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `name` VARCHAR(255), `url` VARCHAR(255), `schedule` VARCHAR(255), `interval_schedule` JSON, `type` VARCHAR(255), `whitelist` VARCHAR(255), `blacklist` VARCHAR(255), `status` NUMBER, `dependences` VARCHAR(255), `extensions` VARCHAR(255), `sub_before` VARCHAR(255), `sub_after` VARCHAR(255), `branch` VARCHAR(255), `pull_type` VARCHAR(255), `pull_option` JSON, `pid` NUMBER, `is_disabled` NUMBER, `log_path` VARCHAR(255), `schedule_type` VARCHAR(255), `alias` VARCHAR(255), `proxy` VARCHAR(255), `autoAddCron` NUMBER, `autoDelCron` NUMBER, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, UNIQUE (`name`, `url`, `schedule`, `interval_schedule`), UNIQUE (`alias`))',
  'CREATE INDEX IF NOT EXISTS `crontab_stats_date` ON `CrontabStats` (`date`)',
  'CREATE UNIQUE INDEX IF NOT EXISTS `crontab_stats_ref_id_date` ON `CrontabStats` (`ref_id`, `date`)',
];

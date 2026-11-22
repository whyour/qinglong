import { literal, FindOptions } from 'sequelize';

// Queue membership belongs to the trigger. Expose it for list/detail reads
// without writing it into the manual-run reservation used by the scheduler.
export const visibleStatus = literal(`CASE
  WHEN EXISTS (SELECT 1 FROM CronTriggers WHERE cron_id = "Crontab"."id" AND state = 'running') THEN 0
  WHEN "Crontab"."status" = 1 AND EXISTS (
    SELECT 1 FROM CronTriggers WHERE cron_id = "Crontab"."id" AND state = 'queued'
  ) THEN 3
  ELSE "Crontab"."status" END`);
export const visibleAttributes: FindOptions['attributes'] = {
  exclude: ['status'],
  include: [[visibleStatus, 'status']],
};

// Resolve status and log ownership in one SQLite snapshot. A running trigger
// can be visible before its shell has published the file for this execution.
const activeLogTrigger = `FROM CronTriggers WHERE cron_id = "Crontab"."id"
  AND state = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1`;
export const logAttributes: FindOptions['attributes'] = [
  'log_name',
  [visibleStatus, 'status'],
  [
    literal(`CASE WHEN EXISTS (SELECT 1 ${activeLogTrigger})
    THEN (SELECT log_path ${activeLogTrigger}) ELSE "Crontab"."log_path" END`),
    'log_path',
  ],
  [
    literal(`CASE WHEN allow_multiple_instances = 1 THEN COALESCE(
    (SELECT id ${activeLogTrigger}),
    (SELECT id FROM CronTriggers WHERE cron_id = "Crontab"."id" AND state = 'queued'
      ORDER BY observed_at DESC, rowid DESC LIMIT 1)
  ) END`),
    'logTriggerId',
  ],
];

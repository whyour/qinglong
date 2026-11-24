import { executionModel } from '../../data/executionModels';
import { Op } from 'sequelize';
import type { ICron } from '../../protos/cron';
import { CrontabModel } from '../../data/cron';
import { slotId } from '../identity';
import { runCron } from '../execution/runCron';

// Accepted work is distinct from catching up timers missed while offline.
// Keep its identity and original queue deadline; never replay a bound command.
export async function resumeAcceptedCrons(item: ICron, current: () => boolean) {
  const rows = await executionModel(
    CrontabModel.sequelize!,
    'CronTriggers',
  ).findAll({
    attributes: ['id', 'scheduled_at', 'queued_at'],
    where: {
      cron_id: Number(item.id),
      source: { [Op.in]: ['node', 'recovery'] },
      state: 'skipped',
      reason: 'restart',
      resume_pending: 1,
      started_at: null,
      queued_at: { [Op.gte]: item.recovery_from || 0 },
    },
    order: [
      ['queued_at', 'ASC'],
      ['id', 'ASC'],
    ],
    raw: true,
  });
  const rules = [
    item.schedule,
    ...(item.extra_schedules || []).map((s) => s.schedule),
  ];
  await Promise.all(
    rows
      .filter((row) =>
        rules.some(
          (rule, i) => slotId(item.id, i, rule, row.scheduled_at!) === row.id,
        ),
      )
      .map((row) =>
        runCron(item.command, item, current, {
          id: row.id,
          time: row.scheduled_at!,
          queuedAt: row.queued_at!,
          source: 'recovery',
        }),
      ),
  );
}

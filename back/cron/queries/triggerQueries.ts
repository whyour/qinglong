import { QueryTypes, Sequelize } from 'sequelize';
import type { Trigger } from '../types';
import { auditSchedule } from '../scheduling/scheduleAudit';
import { systemScheduleAudit } from '../scheduling/systemScheduleAudit';

// Keep uncertain exits unresolved in every history view. These projections
// describe evidence; they never settle a run or book statistics.
const historyColumns = `id,cron_id,source,state,queue_context,queue_live_context,dequeued_at,scheduled_at,queued_at,started_at,command_started_at,script_started_at,
  CASE WHEN exit_pending=1 OR (state='unknown' AND reason='restart') THEN NULL ELSE finished_at END AS finished_at,
  CASE WHEN exit_pending=1 THEN CASE WHEN EXISTS (SELECT 1 FROM CronExitObservations
    WHERE trigger_id=CronTriggers.id LIMIT 1 OFFSET 1) OR EXISTS (SELECT 1 FROM CronBoundExitConflicts
    WHERE trigger_id=CronTriggers.id) THEN 'exit_conflict' ELSE 'exit_pending' END ELSE reason END AS reason,
  EXISTS(SELECT 1 FROM CronLegacyExitBookings WHERE trigger_id=CronTriggers.id) AS legacy_exit_booking,
  CASE WHEN exit_pending=1 OR (state='unknown' AND reason='restart') THEN NULL ELSE exit_code END AS exit_code,log_path,observed_at`;

// Read-only execution history and diagnostics, independent of lifecycle writes.
export class TriggerQueries {
  constructor(private database: Sequelize) {}

  async visibleTriggers(cronId: number, ids: string[]) {
    return this.database.query<Trigger & { observed_at: number }>(
      `SELECT ${historyColumns} FROM CronTriggers WHERE cron_id=:cronId AND id IN (:ids)`,
      { replacements: { cronId, ids }, type: QueryTypes.SELECT },
    );
  }

  async recent(
    cronId: number,
    offset: number,
    limit = 25,
    before?: { time: number; id: string },
  ) {
    return this.database.query<Trigger & { observed_at: number }>(
      `SELECT ${historyColumns}
       FROM CronTriggers WHERE cron_id=$cronId
       ${before ? 'AND (observed_at,id) < ($time,$id)' : ''}
       ORDER BY observed_at DESC,id DESC LIMIT $limit OFFSET $offset`,
      { bind: { cronId, offset, limit, ...before }, type: QueryTypes.SELECT },
    );
  }

  async metrics(since: number) {
    const [row] = await this.database.query<{
      observed: number;
      skipped: number;
      samples: number;
      waitP95: number | null;
      onTime: number;
      planned: number;
      triggerOnTime: number;
      triggerDeviationP95: number | null;
      scriptSamples: number;
      scriptStartP95: number | null;
      scriptOnTime: number;
    }>(
      `WITH today AS (SELECT * FROM CronTriggers WHERE observed_at >= $since),
       triggers AS (SELECT ABS(observed_at - scheduled_at) AS deviation FROM today WHERE scheduled_at IS NOT NULL),
       scripts AS (SELECT script_started_at - scheduled_at AS delay FROM today
         WHERE scheduled_at IS NOT NULL AND script_started_at >= scheduled_at),
       waits AS (SELECT COALESCE(dequeued_at,started_at) - queued_at AS delay FROM today WHERE COALESCE(dequeued_at,started_at) >= queued_at)
       SELECT COUNT(*) AS observed, COUNT(CASE WHEN state='skipped' THEN 1 END) AS skipped,
       COUNT(scheduled_at) AS planned, COUNT(CASE WHEN started_at <= scheduled_at + 5000 THEN 1 END) AS onTime,
       (SELECT COUNT(*) FROM triggers WHERE deviation <= 5000) AS triggerOnTime,
       (SELECT deviation FROM triggers ORDER BY deviation LIMIT 1 OFFSET (SELECT MAX(0,(95*COUNT(*)+99)/100-1) FROM triggers)) AS triggerDeviationP95,
       (SELECT COUNT(*) FROM scripts) AS scriptSamples,
       (SELECT COUNT(*) FROM scripts WHERE delay <= 5000) AS scriptOnTime,
       (SELECT delay FROM scripts ORDER BY delay LIMIT 1 OFFSET (SELECT MAX(0,(95*COUNT(*)+99)/100-1) FROM scripts)) AS scriptStartP95,
       (SELECT COUNT(*) FROM waits) AS samples,
       (SELECT delay FROM waits ORDER BY delay LIMIT 1 OFFSET (SELECT MAX(0, (95*COUNT(*)+99)/100-1) FROM waits)) AS waitP95
       FROM today`,
      { bind: { since }, type: QueryTypes.SELECT },
    );
    return {
      ...row,
      audit: await auditSchedule(this.database, since),
      systemAudit: await systemScheduleAudit(this.database, since),
    };
  }
}

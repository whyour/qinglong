import dayjs from 'dayjs';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';

type DayCounts = {
  cron_id: number;
  day: string;
  successes: number;
  failures: number;
  later_successes: number;
  later_failures: number;
  has_bookings: number;
  saved_successes: number;
  saved_failures: number;
};

// Process one outcome, newest day first. Same-day receipts can only cover
// eligible exits. Surplus becomes available to earlier days after this match.
function matchDailyCounts(
  exits: number,
  saved: number,
  laterCredits: number,
  afterLastBooking = 0,
) {
  const localMatches = Math.min(saved, exits - afterLastBooking);
  const deficit = exits - localMatches;
  const borrowed = Math.min(deficit, laterCredits);
  return {
    missing: deficit - borrowed,
    remaining: laterCredits - borrowed + saved - localMatches,
  };
}

// A legacy terminal status needs a matching exit code. An identified supervisor
// also knows a child failed when the OS returns a signal instead of a code.
const confirmedResult = `t.started_at IS NOT NULL AND t.finished_at>=t.started_at
  AND t.state IN ('finished','failed')
  AND (t.source<>'legacy' OR (
    ((t.state='finished' AND t.exit_code=0) OR (t.state='failed' AND t.exit_code<>0))
    AND NOT EXISTS (SELECT 1 FROM RunningInstances sibling
      LEFT JOIN CronTriggers linked ON linked.instance_id=sibling.id
      WHERE sibling.cron_id=i.cron_id AND sibling.pid=i.pid AND sibling.finished_at=i.finished_at
        AND sibling.id<>i.id AND sibling.status IN (1,3)
        AND (linked.id IS NULL OR (linked.source='legacy' AND linked.owner IS NULL))
        AND (sibling.started_at<>i.started_at OR COALESCE(sibling.log_path,'')<>COALESCE(i.log_path,'')
          OR sibling.status<>i.status OR sibling.exit_code IS NOT i.exit_code OR linked.id IS NOT NULL))))`;

export function readDailyResults(database: Sequelize, cronId: number) {
  const today = dayjs().startOf('day');
  const first = today.subtract(6, 'day');
  const next = today.add(1, 'day');
  return database.query<{
    day: string;
    exitSuccess: number;
    exitFail: number;
    bookedSuccess: number;
    bookedFail: number;
    supplement: number;
  }>(
    `WITH results AS (
    SELECT date(t.finished_at/1000,'unixepoch','localtime') AS day,
      SUM(t.state='finished') AS exitSuccess,SUM(t.state='failed') AS exitFail,
      0 AS bookedSuccess,0 AS bookedFail,0 AS supplement
    FROM CronTriggers t LEFT JOIN RunningInstances i ON i.id=t.instance_id
    WHERE t.cron_id=$id AND t.finished_at >= $start AND t.finished_at < $end
      AND t.reason IS NOT 'spawn' AND ${confirmedResult} GROUP BY day
    UNION ALL
    SELECT date,0,0,COALESCE(success_count,0),COALESCE(fail_count,0),untimed_count
    FROM CrontabStats WHERE ref_id=$id AND date >= $first AND date < $next
  ) SELECT day,SUM(exitSuccess) AS exitSuccess,SUM(exitFail) AS exitFail,
    SUM(bookedSuccess) AS bookedSuccess,SUM(bookedFail) AS bookedFail,SUM(supplement) AS supplement
    FROM results GROUP BY day ORDER BY day DESC`,
    {
      type: QueryTypes.SELECT,
      bind: {
        id: cronId,
        start: first.valueOf(),
        end: next.valueOf(),
        first: first.format('YYYY-MM-DD'),
        next: next.format('YYYY-MM-DD'),
      },
    },
  );
}

// Run under the schema migration's write lock, before accepting new receipts.
export async function repairLegacyDailyStatistics(
  database: Sequelize,
  transaction: Transaction,
  priorVersion: 0 | 1 | 2,
) {
  // Old panels updated every outstanding start with the reported PID. Identical
  // copies of a start prove only one exit; conflicting rows cannot identify it.
  const imported = await database.query(
    `WITH exits AS (
    SELECT MIN(i.id) AS instance FROM RunningInstances i
    JOIN Crontabs c ON c.id=i.cron_id
    LEFT JOIN CronTriggers linked ON linked.instance_id=i.id
    WHERE (linked.id IS NULL OR (linked.source='legacy' AND linked.owner IS NULL))
      AND i.status IN (1,3) AND i.pid>0 AND i.started_at>0 AND i.finished_at>=i.started_at
      AND i.finished_at*1000>=COALESCE((SELECT cutoff FROM CronHistoryRetention WHERE id=1),0)
    GROUP BY i.cron_id,i.pid,i.finished_at
    HAVING MIN(i.started_at)=MAX(i.started_at)
      AND COUNT(DISTINCT COALESCE(i.log_path,''))=1 AND MIN(i.status)=MAX(i.status)
      AND COUNT(i.exit_code)=COUNT(*) AND MIN(i.exit_code)=MAX(i.exit_code)
      AND COUNT(linked.id)=0
  )
  INSERT INTO CronTriggers(id,cron_id,source,state,observed_at,started_at,finished_at,instance_id,log_path,exit_code,counted)
  SELECT 'legacy-db-' || i.id,i.cron_id,'legacy',CASE i.status WHEN 1 THEN 'finished' ELSE 'failed' END,
    i.started_at*1000,i.started_at*1000,i.finished_at*1000,i.id,i.log_path,i.exit_code,1
  FROM exits JOIN RunningInstances i ON i.id=exits.instance
  WHERE (i.status=1 AND i.exit_code=0) OR (i.status=3 AND i.exit_code<>0)`,
    { transaction, type: QueryTypes.BULKUPDATE },
  );

  // A newly imported last run must have the same owner it would acquire through
  // the normal handoff. An older exit must never replace a more recent start.
  if (imported)
    await database.query(
      `WITH ranked AS (
    SELECT cron_id,instance_id,started_at/1000 AS start,(finished_at-started_at)/1000 AS elapsed,
      ROW_NUMBER() OVER (PARTITION BY cron_id ORDER BY started_at DESC,instance_id DESC) AS position
    FROM CronTriggers WHERE source='legacy' AND id LIKE 'legacy-db-%'
  )
  UPDATE Crontabs AS c SET (last_instance_id,last_execution_time,last_running_time)=
    (SELECT instance_id,start,elapsed FROM ranked WHERE cron_id=c.id AND position=1)
  WHERE EXISTS (SELECT 1 FROM ranked r WHERE r.cron_id=c.id AND r.position=1 AND
    (c.last_execution_time IS NULL OR c.last_execution_time<r.start OR
     (c.last_execution_time=r.start AND (c.last_instance_id IS NULL OR c.last_instance_id<r.instance_id)))
    AND NOT EXISTS (SELECT 1 FROM RunningInstances i WHERE i.cron_id=c.id AND
      (i.started_at>r.start OR (i.started_at=r.start AND i.id>r.instance_id))))`,
      { transaction },
    );

  // Statistics retention removes whole dates across tasks. When the old panel
  // retained no earlier totals, yesterday is the oldest date even a 1-day policy keeps.
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const days = await database.query<DayCounts>(
    `WITH exits AS (
    SELECT t.cron_id,t.state,date(t.finished_at/1000,'unixepoch','localtime') AS day,
      t.started_at,i.createdAt,t.id
    FROM CronTriggers t LEFT JOIN RunningInstances i ON i.id=t.instance_id
    WHERE t.counted=1 AND ${confirmedResult}
  ), ordered AS (
    SELECT e.*, CASE WHEN e.id LIKE 'legacy-db-%' AND s.untimed_count=0
      AND date(s.updatedAt,'localtime')=e.day AND julianday(s.createdAt)<=julianday(s.updatedAt)
      AND e.started_at/1000>CAST(strftime('%s',s.updatedAt) AS INTEGER)
      AND julianday(e.createdAt)>julianday(s.updatedAt) THEN 1 ELSE 0 END AS later
    FROM exits e LEFT JOIN CrontabStats s ON s.ref_id=e.cron_id AND s.date=e.day
  ), evidence AS (
    SELECT cron_id,day,SUM(state='finished') AS successes,SUM(state='failed') AS failures,
      SUM(later*(state='finished')) AS later_successes,SUM(later*(state='failed')) AS later_failures,
      0 AS has_bookings,0 AS saved_successes,0 AS saved_failures FROM ordered GROUP BY cron_id,day
    UNION ALL
    SELECT ref_id,date,0,0,0,0,1,COALESCE(success_count,0),COALESCE(fail_count,0) FROM CrontabStats
  )
  SELECT cron_id,day,MAX(has_bookings) AS has_bookings,SUM(successes) AS successes,SUM(failures) AS failures,
    SUM(later_successes) AS later_successes,SUM(later_failures) AS later_failures,
    SUM(saved_successes) AS saved_successes,SUM(saved_failures) AS saved_failures
  FROM evidence WHERE day>=MIN($yesterday,COALESCE((SELECT MIN(date) FROM CrontabStats),$yesterday))
    AND day>=COALESCE((SELECT first_day FROM CronStatRetention WHERE id=1),'')
  GROUP BY cron_id,day ORDER BY cron_id,day DESC`,
    { type: QueryTypes.SELECT, transaction, bind: { yesterday } },
  );

  // Anonymous receipts cannot identify a particular exit. Match nearest
  // eligible days first; never move already booked counts or elapsed samples.
  let task: number | undefined;
  let successCredit = 0,
    failureCredit = 0;
  let priorSuccessCredit = 0,
    priorFailureCredit = 0;
  for (const day of days) {
    if (day.cron_id !== task) {
      task = day.cron_id;
      successCredit =
        failureCredit =
        priorSuccessCredit =
        priorFailureCredit =
          0;
    }
    const successes = matchDailyCounts(
      day.successes,
      day.saved_successes,
      successCredit,
      day.later_successes,
    );
    const failures = matchDailyCounts(
      day.failures,
      day.saved_failures,
      failureCredit,
      day.later_failures,
    );
    successCredit = successes.remaining;
    failureCredit = failures.remaining;
    let success = successes.missing,
      failure = failures.missing;
    if (priorVersion === 2) {
      // Replaying v2 on the current snapshot could resurrect a cleaned-up day.
      // Only the extra lower bound established by v3 is new evidence.
      const priorSuccess = matchDailyCounts(
        day.successes,
        day.saved_successes,
        priorSuccessCredit,
      );
      const priorFailure = matchDailyCounts(
        day.failures,
        day.saved_failures,
        priorFailureCredit,
      );
      priorSuccessCredit = priorSuccess.remaining;
      priorFailureCredit = priorFailure.remaining;
      success = Math.max(0, success - priorSuccess.missing);
      failure = Math.max(0, failure - priorFailure.missing);
    }
    // Old repairs did not journal deletions. An absent task/day could have
    // been cleared after a supplement. Preserve the gap on repeat upgrades.
    if (priorVersion && !day.has_bookings) continue;
    if (!success && !failure) continue;
    // Anonymous elapsed samples have no execution identity. Preserve measured
    // times; adding instance wall times here could count the same sample twice.
    await database.query(
      `INSERT INTO CrontabStats
      (ref_id,date,run_count,success_count,fail_count,untimed_count,total_time,max_time,createdAt,updatedAt)
      VALUES ($task,$day,$runs,$success,$failure,$runs,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT(ref_id,date) DO UPDATE SET run_count=COALESCE(run_count,0)+excluded.run_count,
        success_count=COALESCE(success_count,0)+excluded.success_count,
        fail_count=COALESCE(fail_count,0)+excluded.fail_count,
        untimed_count=untimed_count+excluded.untimed_count,updatedAt=CURRENT_TIMESTAMP`,
      {
        transaction,
        bind: { task, day: day.day, runs: success + failure, success, failure },
      },
    );
  }
}

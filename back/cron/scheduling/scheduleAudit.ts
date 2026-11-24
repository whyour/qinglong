import { executionModel } from '../../data/executionModels';
import { AnomalyPage } from '../queries/scheduleAnomalies';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { AddCronRequest, DeleteCronRequest } from '../../protos/cron';
import { upcomingSlots } from './cronScheduler';
import { slotId } from '../identity';

type Rule = {
  cron_id: string;
  rule_index: number;
  schedule: string;
  zone: string;
  since: number;
  until: number | null;
  open_latest: number;
  close_latest: number;
};
type Receipt = {
  id: string;
  cron_id: number;
  scheduled_at: number;
  observed_at: number;
  state: string;
  reason: string | null;
  log_path: string | null;
  source: 'node' | 'recovery';
  command_started_at: number | null;
  verified_exit: number;
  script_started_at: number | null;
  queued_at: number | null;
  started_at: number | null;
};

export async function saveSchedulePlan(
  db: Sequelize,
  change: AddCronRequest | DeleteCronRequest,
  at?: number,
  token?: string,
) {
  const rules =
    'crons' in change
      ? [
          ...new Map(change.crons.map((task) => [task.id, task])).values(),
        ].flatMap((task) =>
          [
            task.schedule,
            ...(task.extra_schedules || []).map((extra) => extra.schedule),
          ].map((schedule, index) => ({ task: task.id, index, schedule })),
        )
      : [];
  const ids =
    'crons' in change ? change.crons.map((task) => task.id) : change.ids;
  const replace = 'replace' in change && change.replace;
  await db.transaction(async (transaction) => {
    const now = at ?? Date.now();
    const bind = {
      rules: JSON.stringify(rules),
      ids: JSON.stringify(ids),
      replace: Number(replace),
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      now,
      token: token ?? null,
    };
    if (token)
      await executionModel(db, 'CronPlanSwitches').create(
        { token, staged_at: now },
        { transaction, silent: true, hooks: false, validate: false },
      );
    if (replace)
      await executionModel(db, 'CronPlanCoverage').bulkCreate(
        [{ id: 1, since: now }],
        { transaction, ignoreDuplicates: true, hooks: false },
      );
    const desired = `WITH desired AS (SELECT json_extract(value,'$.task') AS task, json_extract(value,'$.index') AS idx,
      json_extract(value,'$.schedule') AS schedule FROM json_each($rules))`;
    await db.query(
      `${desired} UPDATE CronPlanRules SET until=$now,closed_by=$token WHERE until IS NULL
      AND ($replace OR cron_id IN (SELECT value FROM json_each($ids)))
      AND (cron_id,rule_index,schedule,zone) NOT IN (SELECT task,idx,schedule,$zone FROM desired)`,
      { transaction, bind },
    );
    await db.query(
      `${desired} INSERT OR IGNORE INTO CronPlanRules(cron_id,rule_index,schedule,zone,since,opened_by)
      SELECT task,idx,schedule,$zone,$now,$token FROM desired`,
      {
        transaction,
        bind: { rules: bind.rules, zone: bind.zone, now, token: bind.token },
      },
    );
    // Only the current local day is displayed. Keep an extra day for zone changes.
    await db.query(
      `DELETE FROM CronPlanRules WHERE until < $now - 3*86400000 AND
        (closed_by IS NULL OR closed_by IN (SELECT token FROM CronPlanSwitches WHERE last_at < $now - 3*86400000))`,
      { transaction, bind: { now } },
    );
  });
}

// Persisting intent and installing timers are separated by an asynchronous
// SQLite commit. Only the synchronous timer swap defines the effective edges.
export async function confirmSchedulePlan(
  db: Sequelize,
  token: string,
  first: number,
  last: number,
  replace: boolean,
) {
  await db.transaction(async (transaction) => {
    await executionModel(db, 'CronPlanSwitches').update(
      { first_at: first, last_at: last },
      {
        where: { token, last_at: null },
        transaction,
        silent: true,
        hooks: false,
        validate: false,
      },
    );
    if (replace) {
      // After a crash the former worker's switch time is unknowable. A complete
      // replacement establishes the latest possible edge for older requests.
      await db.query(
        `UPDATE CronPlanSwitches SET first_at=staged_at,last_at=$last
        WHERE last_at IS NULL AND seq<(SELECT seq FROM CronPlanSwitches WHERE token=$token)`,
        { transaction, bind: { token, last } },
      );
    }
    await db.query(
      `DELETE FROM CronPlanSwitches WHERE last_at < $last - 3*86400000
      AND token NOT IN (SELECT opened_by FROM CronPlanRules WHERE opened_by IS NOT NULL)
      AND token NOT IN (SELECT closed_by FROM CronPlanRules WHERE closed_by IS NOT NULL)`,
      { transaction, bind: { last } },
    );
  });
}

export const blockSize = 15 * 60000;
const calendar = new Map<string, number[]>();
export function blockSlots(schedule: string, zone: string, block: number) {
  const key = JSON.stringify([zone, schedule, block]);
  let times = calendar.get(key);
  if (!times) {
    times = upcomingSlots(schedule, block - 1, Infinity, block + blockSize - 1);
    if (calendar.size >= 2048) calendar.delete(calendar.keys().next().value!);
    calendar.set(key, times);
  }
  return times;
}

function lowerBound(times: number[], time: number) {
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (times[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function p95(values: number[]) {
  return values.length
    ? values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
    : null;
}

export async function auditSchedule(
  db: Sequelize,
  dayStart: number,
  now = Date.now(),
  details?: AnomalyPage,
) {
  // All counts use the same settled plan window and the same committed snapshot.
  const nextDay = new Date(dayStart);
  nextDay.setHours(24, 0, 0, 0);
  const through = Math.min(now - 5000, nextDay.getTime() - 1);
  const snapshot = await db.transaction(
    { type: Transaction.TYPES.DEFERRED },
    async (transaction) => {
      const [coverage] = await db.query<{ since: number }>(
        `SELECT MAX(since,$dayStart,
      COALESCE((SELECT cutoff FROM CronHistoryRetention WHERE id=1),0)) AS since FROM CronPlanCoverage WHERE id=1`,
        { transaction, bind: { dayStart }, type: QueryTypes.SELECT },
      );
      if (!coverage || coverage.since > through) return;
      const bind = { since: coverage.since, through };
      const rules = await db.query<Rule>(
        `SELECT r.cron_id,r.rule_index,r.schedule,r.zone,COALESCE(o.first_at,r.since) AS since,
      CASE WHEN o.token IS NULL THEN r.since ELSE COALESCE(o.last_at,$through) END AS open_latest,
      COALESCE(c.first_at,r.until) AS until,
      CASE WHEN c.token IS NULL THEN COALESCE(r.until,$through) ELSE COALESCE(c.last_at,$through) END AS close_latest
      FROM CronPlanRules r LEFT JOIN CronPlanSwitches o ON o.token=r.opened_by
      LEFT JOIN CronPlanSwitches c ON c.token=r.closed_by
      WHERE r.since < $through AND close_latest >= $since ORDER BY r.cron_id,r.rule_index,r.since,r.rowid`,
        { transaction, bind, type: QueryTypes.SELECT },
      );
      const receipts = await db.query<Receipt>(
        `SELECT id,cron_id,scheduled_at,observed_at,state,${
          details ? 'source,reason,log_path,' : ''
        }
      command_started_at,script_started_at,queued_at,COALESCE(dequeued_at,started_at) AS started_at,
      EXISTS(SELECT 1 FROM CronLegacyExitBookings b WHERE b.trigger_id=CronTriggers.id AND b.bound=1) AS verified_exit FROM CronTriggers
      WHERE scheduled_at BETWEEN $since AND $through AND source IN ('node','recovery') ${
        details ? 'ORDER BY cron_id,scheduled_at,id' : ''
      }`,
        { transaction, bind, type: QueryTypes.SELECT },
      );
      return { since: coverage.since, rules, receipts };
    },
  );
  if (!snapshot) return null;
  const byTaskBlock = new Map<string, Receipt[]>();
  for (const row of snapshot.receipts) {
    const block = row.scheduled_at - (row.scheduled_at % blockSize);
    const key = row.cron_id + '/' + block;
    const group = byTaskBlock.get(key);
    if (group) group.push(row);
    else byTaskBlock.set(key, [row]);
  }
  const deviations: number[] = [],
    starts: number[] = [],
    entries: number[] = [],
    waits: number[] = [];
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let partial = false;
  let expected = 0,
    onTime = 0,
    skipped = 0,
    queued = 0,
    dispatched = 0;
  for (const rule of snapshot.rules) {
    const first = Math.max(snapshot.since, rule.since + 1);
    const last = Math.min(through, rule.close_latest);
    const certainFirst = Math.max(first, rule.open_latest + 1);
    const certainLast = Math.min(last, rule.until ?? last);
    if (first > last) continue;
    // A wall clock rule registered in another time zone cannot be replayed
    // against the current local calendar.
    if (rule.zone !== zone) return null;
    for (
      let block = first - (first % blockSize);
      block <= last;
      block += blockSize
    ) {
      const times = blockSlots(rule.schedule, zone, block);
      const possible = lowerBound(times, last + 1) - lowerBound(times, first);
      const certain = Math.max(
        0,
        lowerBound(times, certainLast + 1) - lowerBound(times, certainFirst),
      );
      if (certain < possible) partial = true;
      expected += certain;
      const received =
        details?.kind === 'missing' && certain ? new Set<number>() : null;
      for (const row of byTaskBlock.get(rule.cron_id + '/' + block) ?? []) {
        const time = row.scheduled_at;
        if (
          time < certainFirst ||
          time > certainLast ||
          times[lowerBound(times, time)] !== time ||
          row.id !== slotId(rule.cron_id, rule.rule_index, rule.schedule, time)
        )
          continue;
        received?.add(time);
        const deviation = Math.abs(row.observed_at - time);
        deviations.push(deviation);
        if (deviation <= 5000) onTime++;
        if (
          row.command_started_at != null ||
          row.script_started_at != null ||
          row.verified_exit
        ) {
          dispatched++;
          if (row.command_started_at != null && row.command_started_at >= time)
            starts.push(row.command_started_at - time);
        } else if (row.state === 'queued') {
          queued++;
        } else {
          const kind = row.state === 'skipped' ? 'skipped' : 'unconfirmed';
          if (kind === 'skipped') skipped++;
          if (details?.kind === kind)
            details.add({
              task: row.cron_id,
              rule: rule.schedule,
              ruleIndex: rule.rule_index,
              time,
              source: row.source,
              trigger: row.id,
              observed: row.observed_at,
              reason: row.reason,
              logPath: row.log_path,
            });
        }
        if (row.script_started_at != null && row.script_started_at >= time)
          entries.push(row.script_started_at - time);
        if (
          row.started_at != null &&
          row.queued_at != null &&
          row.started_at >= row.queued_at
        )
          waits.push(row.started_at - row.queued_at);
      }
      if (details && received && received.size < certain) {
        for (
          let i = lowerBound(times, certainFirst);
          i < times.length && times[i] <= certainLast;
          i++
        ) {
          if (!received.has(times[i]))
            details.add({
              task: Number(rule.cron_id),
              rule: rule.schedule,
              ruleIndex: rule.rule_index,
              time: times[i],
              source: 'node',
              trigger: null,
              observed: null,
              reason: null,
              logPath: null,
            });
        }
      }
    }
  }
  const observed = deviations.length;
  return {
    since: snapshot.since,
    through,
    zone,
    partial,
    expected,
    observed,
    missing: expected - observed,
    onTime,
    skipped,
    queued,
    dispatched,
    commandSamples: starts.length,
    unconfirmed: observed - dispatched - skipped - queued,
    triggerDeviationP95: p95(deviations),
    waitP95: p95(waits),
    waitSamples: waits.length,
    commandStartP95: p95(starts),
    scriptStartP95: p95(entries),
    scriptSamples: entries.length,
  };
}

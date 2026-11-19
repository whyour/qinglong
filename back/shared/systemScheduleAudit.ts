import { AnomalyPage } from './scheduleAnomalies';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { blockSize, blockSlots } from './scheduleAudit';

export type SystemRule = { id: number; schedule: string; name?: string };
type Install = {
  id: number;
  staged: number;
  confirmed: number | null;
  zone: string;
  rules: string;
};
type Receipt = {
  id: string;
  cron_id: number;
  system_rule: string | null;
  observed_at: number;
  system_dispatch_at: number | null;
  reason: string | null;
  log_path: string | null;
  launched: number;
  state: string;
};

export async function stageSystemPlan(
  db: Sequelize,
  rules: SystemRule[],
  at = Date.now(),
) {
  const bind = {
    at,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rules: JSON.stringify([...rules].sort((a, b) => a.id - b.id)),
  };
  return db.transaction(
    { type: Transaction.TYPES.IMMEDIATE },
    async (transaction) => {
      const [pending] = await db.query<{ id: number }>(
        `SELECT id FROM (SELECT * FROM CronSystemPlans ORDER BY id DESC LIMIT 1)
       WHERE confirmed IS NULL AND zone=$zone AND rules=$rules`,
        {
          bind: { zone: bind.zone, rules: bind.rules },
          transaction,
          type: QueryTypes.SELECT,
        },
      );
      if (pending) return pending.id;
      const [id] = await db.query(
        'INSERT INTO CronSystemPlans(staged,zone,rules) VALUES ($at,$zone,$rules)',
        { bind, transaction, type: QueryTypes.INSERT },
      );
      return id;
    },
  );
}

// On a switch to Node the service can no longer attest the installed daemon rules.
export async function suspendSystemPlan(db: Sequelize) {
  await db.query(
    `INSERT INTO CronSystemPlans(staged,zone,rules)
    SELECT $now,zone,'[]' FROM (SELECT zone,confirmed FROM CronSystemPlans ORDER BY id DESC LIMIT 1)
    WHERE confirmed IS NOT NULL`,
    { bind: { now: Date.now() } },
  );
}

export async function confirmSystemPlan(
  db: Sequelize,
  id: number,
  at = Date.now(),
) {
  await db.transaction(async (transaction) => {
    await db.query(
      'UPDATE CronSystemPlans SET confirmed=$at WHERE id=$id AND confirmed IS NULL',
      { transaction, bind: { id, at } },
    );
    // Keep the effective snapshot preceding the retention window.
    await db.query(
      'DELETE FROM CronSystemPlans WHERE id < (SELECT MAX(id) FROM CronSystemPlans WHERE staged < $cutoff AND confirmed IS NOT NULL)',
      { transaction, bind: { cutoff: at - 3 * 86400000 } },
    );
  });
}

export async function systemScheduleAudit(
  db: Sequelize,
  dayStart: number,
  now = Date.now(),
  details?: AnomalyPage,
) {
  const next = new Date(dayStart);
  next.setHours(24, 0, 0, 0);
  const through = Math.min(now - 5000, +next - 1);
  const { since, installs, receipts } = await db.transaction(
    { type: Transaction.TYPES.DEFERRED },
    async (transaction) => {
      const [retention] = await db.query<{ since: number }>(
        'SELECT MAX($dayStart,COALESCE((SELECT cutoff FROM CronHistoryRetention WHERE id=1),0)) AS since',
        { transaction, bind: { dayStart }, type: QueryTypes.SELECT },
      );
      const since = retention.since;
      const installs = await db.query<Install>(
        `SELECT * FROM CronSystemPlans WHERE id >= COALESCE((SELECT MAX(id) FROM CronSystemPlans
       WHERE confirmed < $since - 60000),0) AND staged <= $now ORDER BY id`,
        { transaction, bind: { since, now }, type: QueryTypes.SELECT },
      );
      const receipts = await db.query<Receipt>(
        `SELECT id,cron_id,system_rule,system_dispatch_at,observed_at,state,${details ? 'reason,log_path,' : ''}
       (command_started_at IS NOT NULL OR script_started_at IS NOT NULL OR
        (started_at IS NOT NULL AND EXISTS (SELECT 1 FROM CronLegacyExitBookings b
         WHERE b.trigger_id=CronTriggers.id AND b.bound=1 AND b.disputed=0))) AS launched
       FROM CronTriggers
       WHERE source='system' AND COALESCE(system_dispatch_at,observed_at) >= $since
       AND COALESCE(system_dispatch_at,observed_at) < $end ORDER BY observed_at,id`,
        {
          transaction,
          bind: {
            since,
            end: Math.min(
              +next,
              Math.floor(through / 60000) * 60000 + 60000,
              now + 1,
            ),
          },
          type: QueryTypes.SELECT,
        },
      );
      return { since, installs, receipts };
    },
  );
  if (!installs.length && !receipts.length) return null;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const minute = 60000;
  const plans = installs.map((plan) => ({
    ...plan,
    tasks: new Map(
      (JSON.parse(plan.rules) as SystemRule[]).map((rule) => [rule.id, rule]),
    ),
  }));
  const matched = details && details.kind !== 'missing' ? new Map<string, { time: number; name?: string }>() : null;
  const groups = new Map<string, Receipt[]>();
  const dispatchedTasks = new Set<string>();
  const legacyThrough = new Map<string, number>();
  const receiptKey = (task: number, rule: string | null, time: number) =>
    JSON.stringify([task, rule, time]);
  for (const row of receipts) {
    if (row.system_dispatch_at == null || !row.system_rule) {
      const key = JSON.stringify([row.cron_id, row.system_rule]);
      legacyThrough.set(
        key,
        Math.max(legacyThrough.get(key) ?? 0, row.observed_at),
      );
      continue;
    }
    dispatchedTasks.add(
      row.cron_id + '/' + Math.floor(row.system_dispatch_at / minute),
    );
    const key = receiptKey(
      row.cron_id,
      row.system_rule,
      Math.floor(row.system_dispatch_at / minute) * minute,
    );
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  let expected = 0,
    observed = 0,
    dispatched = 0,
    skipped = 0,
    missing = 0,
    duplicates = 0,
    matchedReceipts = 0;
  let uncertain = 0,
    awaiting = 0,
    switchSlots = 0,
    partial = false;
  type Slot = {
    time: number;
    task: number;
    name?: string;
    status: string;
    triggerCount: number;
    startCount: number;
    skipCount: number;
    unknownExitCount: number;
    id?: string;
  };
  const recent: Slot[] = [];
  const dst =
    new Date(dayStart).getTimezoneOffset() !==
    new Date(+next - 1).getTimezoneOffset();
  let baseline = -1,
    last = -1;
  const calendar = new Map<string, Set<number>>();
  for (
    let time =
      Math.ceil(Math.max(since, plans[0]?.staged ?? since) / minute) * minute;
    time <= through;
    time += minute
  ) {
    // A successful crontab install acknowledges the file. crond reads changes at
    // its minute tick. Around that tick either file can still explain a callback.
    while (last + 1 < plans.length && plans[last + 1].staged <= time + 5000)
      last++;
    while (baseline + 1 <= last) {
      let confirmed = baseline + 1;
      while (confirmed <= last && plans[confirmed].confirmed == null)
        confirmed++;
      if (confirmed > last || plans[confirmed].confirmed! >= time - minute)
        break;
      baseline = confirmed;
    }
    if (last < 0) continue;
    const possible = plans.slice(Math.max(0, baseline), last + 1);
    if (dst || possible.some((plan) => plan.zone !== zone)) {
      partial = true;
      continue;
    }
    const tasks = new Set<number>();
    for (const plan of possible)
      for (const id of plan.tasks.keys()) tasks.add(id);
    const block = time - (time % blockSize);
    if (time === block) calendar.clear();
    const entries: Slot[] = [];
    for (const task of tasks) {
      const schedules = new Set<string>();
      let name: string | undefined;
      for (const plan of possible) {
        const rule = plan.tasks.get(task);
        if (!rule) continue;
        name = rule.name;
        let times = calendar.get(rule.schedule);
        if (!times) {
          times = new Set(blockSlots(rule.schedule, zone, block));
          calendar.set(rule.schedule, times);
        }
        if (times.has(time)) schedules.add(rule.schedule);
      }
      if (!schedules.size) continue;
      const [schedule] = schedules;
      const stable =
        baseline >= 0 &&
        schedules.size === 1 &&
        possible.every(
          (plan) =>
            plan.confirmed != null &&
            plan.tasks.get(task)?.schedule === schedule,
        );
      const group = [...schedules].flatMap(
        (rule) => groups.get(receiptKey(task, rule, time)) ?? [],
      );
      let status: string;
      const launched = group.find((row) => row.launched === 1);
      const skip = group.find((row) => !row.launched && row.state === 'skipped');
      if (group.length) {
        ++expected;
        ++observed;
        if (matched) for (const row of group) matched.set(row.id, { time, name });
        matchedReceipts += group.length;
        duplicates += group.length - 1;
        if (launched) ++dispatched;
        else if (skip) ++skipped;
        status = launched ? 'started' : skip ? 'skipped' : 'unconfirmed';
      } else if (!stable) {
        ++switchSlots;
        partial = true;
        status = 'switch';
      } else {
        ++expected;
        const lastUndated = Math.max(
          legacyThrough.get(JSON.stringify([task, null])) ?? 0,
          legacyThrough.get(JSON.stringify([task, schedule])) ?? 0,
        );
        if (
          time <= lastUndated ||
          dispatchedTasks.has(task + '/' + time / minute)
        ) {
          ++uncertain;
          status = 'uncertain';
        } else if (time + minute > now) {
          ++awaiting;
          status = 'awaiting';
        } else {
          ++missing;
          if (details?.kind === 'missing') details.add({ task, name, rule: schedule, time, source: 'system',
            trigger: null, observed: null, reason: null, logPath: null });
          status = 'missing';
        }
      }
      entries.push({
        time,
        task,
        name,
        status,
        triggerCount: group.length,
        startCount: group.filter((row) => row.launched === 1).length,
        skipCount: group.filter((row) => !row.launched && row.state === 'skipped').length,
        unknownExitCount: group.filter((row) => row.launched === 1 && row.state === 'unknown').length,
        id: (launched || skip || group[0])?.id,
      });
    }
    if (entries.length)
      recent.unshift(...entries.sort((a, b) => a.task - b.task).slice(0, 25));
    recent.splice(25);
  }
  let actualSkips = 0, actualUnconfirmed = 0;
  for (const row of receipts) {
    if (row.launched === 1) continue;
    const kind = row.state === 'skipped' ? 'skipped' : 'unconfirmed';
    if (kind === 'skipped') actualSkips++;
    else actualUnconfirmed++;
    if (details?.kind === kind) {
      const slot = matched?.get(row.id);
      details.add({ task: row.cron_id, name: slot?.name, rule: row.system_rule, time: slot?.time ?? null,
        source: 'system', trigger: row.id, observed: row.observed_at, reason: row.reason, logPath: row.log_path });
    }
  }
  return {
    since: Math.max(since, plans[0]?.staged ?? since),
    through,
    confirmedAt:
      [...plans].reverse().find((p) => p.confirmed != null)?.confirmed ?? null,
    pending: plans.at(-1)?.confirmed == null,
    partial,
    expected,
    observed,
    dispatched,
    skipped,
    missing,
    duplicates,
    uncertain,
    awaiting,
    switchSlots,
    actualSkips, actualUnconfirmed,
    actualStarts: receipts.filter((row) => row.launched === 1).length,
    unmatched: receipts.length - matchedReceipts,
    recent,
  };
}

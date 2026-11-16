import { isLegacyCapture, isMetadataReceipt, publishedExits, publishedScriptStarts, readExit, receiptPath, retireLegacyFile, retiringExits, validExit } from './managedExit.cjs';
import { executionIdPattern } from './executionIdentity';
import type { Crontab } from '../data/cron';
import { hasLiveCronProcess, isProcessDescendant, legacyProcessOwner, pidNamespaceOwner, systemOwner } from './cronProcess';
export { systemOwner } from './cronProcess';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import dayjs from 'dayjs';
import { addDailyExit, recordCronResult } from './cronStatistics';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { createHash } from 'crypto';
import { systemScheduleAudit } from './systemScheduleAudit';
import { auditSchedule } from './scheduleAudit';

export type TriggerSource = 'node' | 'manual' | 'boot' | 'system' | 'recovery' | 'legacy' | 'client';
export type TriggerState =
  | 'queued'
  | 'running'
  | 'finished'
  | 'failed'
  | 'skipped'
  | 'stopped'
  | 'unknown';
type VerifiedSupervisorExit = { code: number | null; signal: string | null; time: number; version: 1 };
type ExitObservation = Omit<VerifiedSupervisorExit, 'version'>;
type LegacyExitBooking = {
  trigger_id: string; cron_id: number; source: TriggerSource; started_at: number; finished_at: number; outcome: string;
  stopped: number; stat_id: number | null; disputed: number; bound: number;
};

function observationKey(id: string, exit: ExitObservation) {
  return { id, outcome: exit.signal ?? String(exit.code), time: exit.time };
}

export type Trigger = {
  id: string;
  cron_id: number;
  source: TriggerSource;
  state: TriggerState;
  scheduled_at: number | null;
  queued_at: number | null;
  dequeued_at?: number | null;
  started_at: number | null;
  script_started_at: number | null;
  command_started_at: number | null;
  finished_at: number | null;
  reason: string | null;
  exit_code: number | null;
  log_path: string | null;
};

const historyColumns = `id,cron_id,source,state,queue_context,queue_live_context,dequeued_at,scheduled_at,queued_at,started_at,command_started_at,script_started_at,
  CASE WHEN exit_pending=1 OR (state='unknown' AND reason='restart') THEN NULL ELSE finished_at END AS finished_at,
  CASE WHEN exit_pending=1 THEN CASE WHEN EXISTS (SELECT 1 FROM CronExitObservations
    WHERE trigger_id=CronTriggers.id LIMIT 1 OFFSET 1) OR EXISTS (SELECT 1 FROM CronBoundExitConflicts
    WHERE trigger_id=CronTriggers.id) THEN 'exit_conflict' ELSE 'exit_pending' END ELSE reason END AS reason,
  EXISTS(SELECT 1 FROM CronLegacyExitBookings WHERE trigger_id=CronTriggers.id) AS legacy_exit_booking,
  CASE WHEN exit_pending=1 OR (state='unknown' AND reason='restart') THEN NULL ELSE exit_code END AS exit_code,log_path,observed_at`;

export function slotId(
  task: string,
  ruleIndex: number,
  rule: string,
  time: number,
) {
  return createHash('sha256')
    .update(JSON.stringify([task, ruleIndex, rule, time]))
    .digest('hex');
}

export async function installTriggerHistory(
  database: Sequelize,
  transaction: Transaction,
) {
  const conflictTable = `CREATE TABLE IF NOT EXISTS CronBoundExitConflicts (
    trigger_id TEXT NOT NULL, outcome TEXT NOT NULL, finished_at INTEGER NOT NULL,
    PRIMARY KEY(trigger_id,outcome,finished_at)) WITHOUT ROWID`;
  const statements = [
    `CREATE TABLE IF NOT EXISTS CronPlanSwitches (seq INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL,
      staged_at INTEGER NOT NULL, first_at INTEGER, last_at INTEGER)`,
    'CREATE TABLE IF NOT EXISTS CronPlanCoverage (id INTEGER PRIMARY KEY CHECK(id=1), since INTEGER NOT NULL)',
    `CREATE TABLE IF NOT EXISTS CronPlanRules (
      cron_id TEXT NOT NULL, rule_index INTEGER NOT NULL, schedule TEXT NOT NULL, zone TEXT NOT NULL,
      since INTEGER NOT NULL, until INTEGER)`,
    'CREATE UNIQUE INDEX IF NOT EXISTS cron_plan_active ON CronPlanRules(cron_id,rule_index) WHERE until IS NULL',
    `CREATE TABLE IF NOT EXISTS CronTriggers (
      id TEXT PRIMARY KEY, cron_id INTEGER NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL,
      scheduled_at INTEGER, queued_at INTEGER, started_at INTEGER, finished_at INTEGER,
      reason TEXT, exit_code INTEGER, log_path TEXT, counted INTEGER NOT NULL DEFAULT 0,
      owner TEXT, observed_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS CronShellBindings (
      receipt TEXT PRIMARY KEY, trigger_id TEXT NOT NULL REFERENCES CronTriggers(id) ON DELETE CASCADE)`,
    'CREATE INDEX IF NOT EXISTS cron_shell_binding_trigger ON CronShellBindings(trigger_id)',
    `CREATE TABLE IF NOT EXISTS CronExitObservations (
      trigger_id TEXT NOT NULL REFERENCES CronTriggers(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL, finished_at INTEGER NOT NULL,
      PRIMARY KEY(trigger_id,outcome,finished_at)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS CronLegacyExitBookings (
      trigger_id TEXT PRIMARY KEY, cron_id INTEGER NOT NULL, source TEXT NOT NULL, started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL, outcome TEXT NOT NULL, day TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0,
      stat_id INTEGER REFERENCES CrontabStats(id) ON DELETE SET NULL, disputed INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS CronPrunedUnknownRuns (
      trigger_id TEXT PRIMARY KEY, cron_id INTEGER NOT NULL REFERENCES Crontabs(id) ON DELETE CASCADE,
      source TEXT NOT NULL, started_at INTEGER NOT NULL, last_possible_day TEXT NOT NULL) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS cron_pruned_unknown_day ON CronPrunedUnknownRuns(last_possible_day)',
    `CREATE TABLE IF NOT EXISTS CronSystemPlans (id INTEGER PRIMARY KEY, staged INTEGER NOT NULL, confirmed INTEGER, zone TEXT NOT NULL, rules TEXT NOT NULL)`,
    conflictTable,
    `CREATE TABLE IF NOT EXISTS CronUnmatchedBoundExits (
      trigger_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, finished_at INTEGER NOT NULL) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS cron_legacy_booking_stat ON CronLegacyExitBookings(stat_id) WHERE stat_id IS NOT NULL',
    'CREATE TABLE IF NOT EXISTS CronStatRetention (id INTEGER PRIMARY KEY CHECK(id=1), first_day TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS CronHistoryRetention (id INTEGER PRIMARY KEY CHECK(id=1), cutoff INTEGER NOT NULL)',
    `CREATE TABLE IF NOT EXISTS CronStopBatches (
      request_id TEXT PRIMARY KEY, cron_ids TEXT NOT NULL, snapshot TEXT)`,
    "CREATE INDEX IF NOT EXISTS cron_stop_batch_pending ON CronStopBatches(request_id) WHERE snapshot IS NOT NULL",
    `CREATE TABLE IF NOT EXISTS CronStopRequests (
      instance_id INTEGER PRIMARY KEY, cron_id INTEGER NOT NULL, pid INTEGER NOT NULL, targets TEXT, signalled INTEGER NOT NULL DEFAULT 0)`,
    'CREATE INDEX IF NOT EXISTS cron_trigger_recent ON CronTriggers(cron_id, observed_at DESC)',
    "CREATE INDEX IF NOT EXISTS cron_trigger_running_task ON CronTriggers(cron_id) WHERE state='running'",
    "CREATE INDEX IF NOT EXISTS cron_trigger_queued_task ON CronTriggers(cron_id) WHERE state='queued'",
    'CREATE INDEX IF NOT EXISTS cron_trigger_day ON CronTriggers(observed_at)',
    'CREATE INDEX IF NOT EXISTS cron_trigger_slot ON CronTriggers(scheduled_at) WHERE scheduled_at IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS cron_trigger_active ON CronTriggers(source, state) WHERE finished_at IS NULL',
  ];
  for (const sql of statements) await database.query(sql, { transaction });
  const planFields = await database.query<{name:string}>('PRAGMA table_info(CronPlanRules)',
    {transaction, type:QueryTypes.SELECT});
  for (const column of ['opened_by','closed_by']) {
    if (!planFields.some(field => field.name === column))
      await database.query(`ALTER TABLE CronPlanRules ADD COLUMN ${column} TEXT`, {transaction});
  }
  const conflictFields = await database.query<{name: string}>('PRAGMA table_info(CronBoundExitConflicts)',
    { transaction, type: QueryTypes.SELECT });
  if (conflictFields.some(field => field.name === 'other_outcome')) {
    await database.query('ALTER TABLE CronBoundExitConflicts RENAME TO CronBoundExitConflictPairs', { transaction });
    await database.query(conflictTable, { transaction });
    await database.query(`INSERT INTO CronBoundExitConflicts(trigger_id,outcome,finished_at)
      SELECT trigger_id,outcome,finished_at FROM CronBoundExitConflictPairs UNION
      SELECT trigger_id,other_outcome,other_finished_at FROM CronBoundExitConflictPairs`, { transaction });
    await database.query('DROP TABLE CronBoundExitConflictPairs', { transaction });
  }
  const bookingFields = await database.query<{name: string}>('PRAGMA table_info(CronLegacyExitBookings)',
    { transaction, type: QueryTypes.SELECT });
  if (!bookingFields.some(field => field.name === 'bound'))
    await database.query('ALTER TABLE CronLegacyExitBookings ADD COLUMN bound INTEGER NOT NULL DEFAULT 0', { transaction });
  const batchFields = await database.query<{ name: string }>('PRAGMA table_info(CronStopBatches)',
    { transaction, type: QueryTypes.SELECT });
  if (!batchFields.some(column => column.name === 'status_code'))
    await database.query('ALTER TABLE CronStopBatches ADD COLUMN status_code INTEGER NOT NULL DEFAULT 200', { transaction });
  const stopFields = await database.query<{ name: string }>('PRAGMA table_info(CronStopRequests)',
    { transaction, type: QueryTypes.SELECT });
  if (!stopFields.some(column => column.name === 'signalled_at'))
    await database.query('ALTER TABLE CronStopRequests ADD COLUMN signalled_at INTEGER', { transaction });
  if (!stopFields.some(column => column.name === 'root_identity'))
    await database.query('ALTER TABLE CronStopRequests ADD COLUMN root_identity TEXT', { transaction });
  if (!stopFields.some(column => column.name === 'namespace_owner'))
    await database.query('ALTER TABLE CronStopRequests ADD COLUMN namespace_owner TEXT', { transaction });
  const fields = await database.query<{ name: string }>('PRAGMA table_info(CronTriggers)',
    { transaction, type: QueryTypes.SELECT });
  for (const [column, type] of [['queue_live_context', 'TEXT'], ['dequeued_at', 'INTEGER'], ['system_dispatch_at', 'INTEGER'], ['queue_context', 'TEXT'], ['system_rule', 'TEXT'], ['command_started_at', 'INTEGER'], ['instance_id', 'INTEGER'], ['script_started_at', 'INTEGER'], ['stop_requested', 'INTEGER'], ['process_identity', 'TEXT'], ['command_identity', 'TEXT'], ['stop_exit_at', 'INTEGER'], ['stop_exit_verified', 'INTEGER'], ['exit_pending', 'INTEGER']]) {
    if (!fields.some((field) => field.name === column))
      await database.query(`ALTER TABLE CronTriggers ADD COLUMN ${column} ${type}`, { transaction });
  }
  await database.query(`CREATE TRIGGER IF NOT EXISTS cron_exit_observations_settled AFTER UPDATE OF counted ON CronTriggers
    WHEN OLD.exit_pending=1 AND OLD.counted=0 AND NEW.counted=1 BEGIN
      DELETE FROM CronExitObservations WHERE trigger_id=NEW.id;
    END`, { transaction });
  await database.query("CREATE INDEX IF NOT EXISTS cron_system_dispatch ON CronTriggers(COALESCE(system_dispatch_at,observed_at)) WHERE source='system'", { transaction });
  await database.query('CREATE INDEX IF NOT EXISTS cron_trigger_pending_exit ON CronTriggers(id) WHERE exit_pending=1', { transaction });
  await database.query('CREATE UNIQUE INDEX IF NOT EXISTS cron_trigger_instance ON CronTriggers(instance_id) WHERE instance_id IS NOT NULL', { transaction });
}

function isBoundPublication(file: string) {
  return /^\.(pending|published)\./.test(basename(file)) && !isLegacyCapture(file);
}

export class TriggerHistory {
  constructor(private database: Sequelize) {}

  // No command or instance exists before the scheduler claims the trigger.
  // A cancelled or already claimed row must keep the outcome recorded by its owner.
  async skipQueued(id: string, reason: string, finishedAt: number) {
    await this.database.query(
      `UPDATE CronTriggers SET state='skipped', reason=$reason, finished_at=$finishedAt
       WHERE id=$id AND source IN ('node','recovery') AND state='queued' AND started_at IS NULL`,
      { bind: { id, reason, finishedAt }, type: QueryTypes.BULKUPDATE },
    );
  }

  async enqueue(
    id: string,
    cronId: number,
    source: TriggerSource,
    scheduledAt: number | null,
    now = Date.now(),
    transaction?: Transaction,
  ) {
    // The SQLite driver returns changes on the statement that claimed this slot.
    const changed = await this.database.query(
      `INSERT INTO CronTriggers(id, cron_id, source, scheduled_at, queued_at, observed_at, owner, state)
       VALUES ($id,$cronId,$source,$scheduledAt,$now,$now,$owner,'queued')
       ON CONFLICT(id) DO UPDATE SET state='queued', reason=NULL, finished_at=NULL,
         queued_at=excluded.queued_at, dequeued_at=NULL, queue_context=NULL, queue_live_context=NULL,
         source=excluded.source, owner=excluded.owner
       WHERE excluded.source='recovery' AND state='skipped' AND reason='restart' AND started_at IS NULL`,
      {
        bind: {
          id,
          cronId,
          source,
          scheduledAt,
          now,
          owner: process.env.SERVICE_TYPE || 'http',
        },
        transaction,
        type: QueryTypes.BULKUPDATE,
      },
    );
    return changed === 1;
  }

  // Serialize admission with the receipt so simultaneous timers and recovered
  // workers agree on which scheduled run owns the slot. Edits invalidate old waits.
  async enqueueUnlessPending(id: string, cronId: number, source: 'node' | 'recovery',
    scheduledAt: number, now: number, revision = 0) {
    return this.database.transaction(async transaction => {
      if (!await this.enqueue(id, cronId, source, scheduledAt, now, transaction)) return false;
      await this.recoverSystemOwners(cronId, transaction);
      const pending = await this.database.query(
        `SELECT 1 FROM CronTriggers WHERE cron_id=$cronId AND id<>$id
         AND source IN ('node','recovery','system')
         AND (state='running' OR (state='queued' AND queued_at >= $revision)) LIMIT 1`,
        { transaction, bind: { cronId, id, revision }, type: QueryTypes.SELECT },
      );
      if (!pending.length) return true;
      await this.finish(id, 'skipped', 'pending', null, transaction);
      return false;
    });
  }

  async start(id: string, now = Date.now(), multiple = false, transaction?: Transaction) {
    const claim = () => this.database.query(
      `UPDATE CronTriggers SET state='running', started_at=$now WHERE id=$id AND state='queued'
       AND ($multiple OR NOT EXISTS (SELECT 1 FROM CronTriggers AS active
         WHERE active.cron_id=CronTriggers.cron_id AND active.state='running'))`,
      { transaction, bind: { id, now, multiple: Number(multiple) }, type: QueryTypes.BULKUPDATE },
    );
    let changed = await claim();
    if (!changed && !multiple && !transaction) {
      const [task] = await this.database.query<{ cron_id: number }>(
        "SELECT cron_id FROM CronTriggers WHERE id=$id AND state='queued'",
        { bind: { id }, type: QueryTypes.SELECT },
      );
      if (task && await this.recoverSystemOwners(task.cron_id)) changed = await claim();
    }
    return changed === 1;
  }

  async claimManual(id: string, snapshot: Crontab, token: string, independent: boolean) {
    return this.database.transaction(async transaction => {
      // The write transaction orders a configuration save and a manual claim.
      const rows = await this.database.query(
        `SELECT 1 FROM Crontabs WHERE id=$cronId AND recovery_from IS $revision
         AND command=$command AND COALESCE(isDisabled,0)=$disabled
         AND COALESCE(allow_multiple_instances,0)=$multiple
         AND ($independent OR (status=3 AND queued_token=$token))`,
        { transaction, type: QueryTypes.SELECT, bind: { cronId: snapshot.id, revision: snapshot.recovery_from ?? null,
          command: snapshot.command, disabled: snapshot.isDisabled || 0, multiple: snapshot.allow_multiple_instances || 0,
          independent: Number(independent), token } },
      );
      if (!rows.length) return 'changed';
      if (!independent) await this.recoverSystemOwners(snapshot.id, transaction);
      return await this.start(id, Date.now(), independent, transaction) ? 'started' : 'overlap';
    });
  }

  async finish(
    id: string,
    state: TriggerState,
    reason: string | null = null,
    code: number | null = null,
    transaction?: Transaction,
    finishedAt?: number,
  ) {
    // A managed supervisor can observe the clock moving backwards during a run.
    // Clients supply their own timestamps; validate those against the recorded start.
    return this.database.query(
      `UPDATE CronTriggers SET state=$state, reason=$reason, exit_code=$code,
       started_at=CASE WHEN $state='skipped' THEN NULL ELSE started_at END,
       finished_at=COALESCE(CASE WHEN owner IS NOT NULL OR $finishedAt >= started_at THEN $finishedAt END,CASE WHEN state='unknown' THEN finished_at END,$now)
       WHERE id=$id AND (state IN ('running','queued') OR
         (state='unknown' AND $state IN ('finished','failed','stopped')))`,
      { transaction, type: QueryTypes.BULKUPDATE, bind: { id, state, reason, code, finishedAt: finishedAt ?? null, now: Date.now() } },
    );
  }

  // A child close is an independent receipt when either Shell callback is lost.
  async complete(id: string, state: TriggerState, reason: string | null, code: number | null, finishedAt?: number,
    report?: VerifiedSupervisorExit | 'legacy') {
    const sample = await this.readScriptSample(id);
    await this.database.transaction(async (transaction) => {
      await this.saveScriptSample(id, sample, transaction);
      await this.completeCommandExit(id, state, reason, code, transaction, undefined, finishedAt, report);
    });
    if (sample) await fs.unlink(sample.marker).catch(() => {});
  }

  private async completeCommandExit(id: string, state: TriggerState, reason: string | null,
    code: number | null, transaction: Transaction, receipt?: Awaited<ReturnType<typeof readExit>>, finishedAt?: number,
    report?: VerifiedSupervisorExit | 'legacy', recoveredCopies?: Awaited<ReturnType<typeof readExit>>[]) {
    const file = receiptPath(id);
    let pending = file ? await this.pendingExit(id, transaction) : undefined;
    const [saved] = file ? await this.database.query<LegacyExitBooking & { conflicted: number; unmatched_outcome: string | null; unmatched_time: number | null }>(
      `SELECT b.*,u.outcome AS unmatched_outcome,u.finished_at AS unmatched_time,EXISTS(SELECT 1 FROM CronBoundExitConflicts WHERE trigger_id=$id) AS conflicted
       FROM (SELECT 1) LEFT JOIN CronLegacyExitBookings b ON b.trigger_id=$id LEFT JOIN CronUnmatchedBoundExits u ON u.trigger_id=$id`,
      { bind: { id }, transaction, type: QueryTypes.SELECT }) : [];
    const booking = saved?.trigger_id ? saved : undefined;
    // Every version-1 publication has the same evidentiary weight, regardless of its path.
    const recovered = recoveredCopies ?? (file ? await Promise.all((await retiringExits())
      .filter(copy => copy.id === id).map(copy => readExit(id, copy.file))) : []);
    const published = receipt === undefined && file ? await readExit(id) : receipt;
    const files = [published, ...recovered];
    const candidates = [...files, ...files.map(copy => copy?.namedExit), report === 'legacy' ? undefined : report]
      .filter((value): value is VerifiedSupervisorExit => value?.version === 1);
    const bound = file && candidates[0] ? { ...candidates[0], file } : undefined;
    const tuples = candidates.map(value => observationKey(id, value));
    if (booking?.bound) tuples.push({ id, outcome: booking.outcome, time: booking.finished_at });
    if (saved?.unmatched_time != null && saved.unmatched_outcome != null) {
      tuples.push({ id, outcome: saved.unmatched_outcome, time: saved.unmatched_time });
    }
    const first = tuples[0];
    if (saved?.conflicted || tuples.some(tuple => tuple.time !== first.time || tuple.outcome !== first.outcome)) {
      await this.disputeBoundExit(id, tuples, transaction);
      if (saved.unmatched_time != null) await this.database.query('DELETE FROM CronUnmatchedBoundExits WHERE trigger_id=$id', { bind: { id }, transaction });
      this.retireDuplicatePublications(id, recovered, transaction);
      if (!saved?.conflicted) {
        if (booking) {
          await this.withdrawBooking(booking, transaction);
          await this.database.query('DELETE FROM CronLegacyExitBookings WHERE trigger_id=$id', { bind: { id }, transaction });
        }
        if (await this.invalidateBookedTrigger(id, transaction)) await this.deferExit(id, transaction);
      } else if (pending?.state === 'running') await this.deferExit(id, transaction);
      return;
    }
    for (const copy of recovered) {
      if (copy?.version === 1) this.retireReceiptAfterCommit(id, copy.file, transaction, 'bound-copy', copy);
    }
    if (bound && !pending && saved.unmatched_time == null) {
      // After history pruning the booking can disappear with its daily row.
      // Before releasing a verified replay, retain just its tuple so a later
      // conflicting file can still be recognized without recreating that day.
      await this.database.query(`INSERT OR IGNORE INTO CronUnmatchedBoundExits(trigger_id,outcome,finished_at)
        SELECT $id,$outcome,$time WHERE NOT EXISTS (SELECT 1 FROM CronTriggers WHERE id=$id)`,
        { bind: observationKey(id, bound), transaction });
    }
    const start = booking?.started_at ?? (pending?.owner ? pending.started_at : null);
    const observation = start != null && finishedAt !== undefined && finishedAt >= start &&
      validExit(code, reason, finishedAt) && state === (code === 0 ? 'finished' : 'failed')
      ? { code, signal: reason, time: finishedAt } : undefined;
    if (booking && !booking.bound && (bound || (observation && (booking.outcome !== observationKey(id, observation).outcome ||
        booking.finished_at !== observation.time)))) {
      const retained = await this.reviseLegacyBooking(booking, bound, transaction);
      if (!retained || !bound) {
        if (retained) await this.deferExit(id, transaction, observation);
        else if (file) this.retireReceiptAfterCommit(id, file, transaction, 'exit', published);
        return;
      }
      pending = await this.pendingExit(id, transaction);
    }
    if (file && !pending) {
      if (bound && !booking) {
        const [pruned] = await this.database.query<Pick<LegacyExitBooking, 'trigger_id' | 'cron_id' | 'source' | 'started_at'>>(
          'SELECT trigger_id,cron_id,source,started_at FROM CronPrunedUnknownRuns WHERE trigger_id=$id',
          { bind: { id }, transaction, type: QueryTypes.SELECT });
        if (pruned) {
          await this.bookPrunedExit(pruned, false, bound, transaction);
          await this.database.query('DELETE FROM CronPrunedUnknownRuns WHERE trigger_id=$id', { bind: { id }, transaction });
        }
      }
      await this.settleInstance(id, transaction);
      this.retireReceiptAfterCommit(id, file, transaction, 'exit', published);
      return;
    }
    if (pending?.finished_at != null && ['finished', 'failed', 'stopped'].includes(pending.state)) {
      // An earlier panel may have committed the trigger before claiming its statistic.
      await this.completeInTransaction(id, pending.state, pending.reason, pending.exit_code, transaction, undefined, pending.finished_at);
      if (file) this.retireReceiptAfterCommit(id, file, transaction, 'exit', published);
      return;
    }
    if (pending?.stop_exit_verified && pending.stop_exit_at != null) {
      // The outcome was verified before the last worker finished checking the process tree.
      await this.completeInTransaction(id, 'stopped', 'cancelled', pending.exit_code, transaction, undefined, pending.stop_exit_at);
      this.retireReceiptAfterCommit(id, file!, transaction, 'exit');
      return;
    }
    // A truncated publication is different from no publication. In particular
    // a killed supervisor cannot attest to the script's own exit status.
    const unreadable = recovered.some(copy => copy === null || (copy && copy.version !== 1 && isBoundPublication(copy.file)));
    const exit = bound ?? published ?? (unreadable ? null : published);
    if (exit && exit.version !== 1 && !booking?.bound) {
      if (observation) await this.saveExitObservation(id, observation, transaction);
      if (pending?.started_at == null || exit.time < pending.started_at ||
          !await this.hasExitObservation(id, exit, transaction)) {
        await this.deferExit(id, transaction);
        return;
      }
    }
    if (exit && pending?.started_at != null && !booking?.bound) {
      // Track the exact contribution until its history and retained statistic expire.
      await this.database.query(`INSERT OR IGNORE INTO CronLegacyExitBookings(trigger_id,cron_id,source,started_at,finished_at,outcome,day,bound)
        SELECT id,cron_id,source,started_at,$time,$outcome,$day,$bound FROM CronTriggers WHERE id=$id`,
        { bind: { ...observationKey(id, exit), bound: Number(exit.version === 1), day: dayjs(exit.time).format('YYYY-MM-DD') }, transaction });
      await this.database.query('DELETE FROM CronExitObservations WHERE trigger_id=$id', { bind: { id }, transaction });
      if (bound && saved?.unmatched_time != null) await this.database.query('DELETE FROM CronUnmatchedBoundExits WHERE trigger_id=$id', { bind: { id }, transaction });
    }
    // A signal on the bound supervisor before its first write says nothing about
    // the command it was waiting for. A verified stop has its own durable claim.
    const supervisorKilled = pending?.command_identity && !pending.stop_requested &&
      code === null && state === 'stopped' && reason?.startsWith('SIG');
    if (pending && pending.owner && pending.started_at !== null &&
        (exit === null || (!exit && (pending.exit_pending || supervisorKilled || report === 'legacy')))) {
      await this.deferExit(id, transaction, observation);
      return;
    }
    if (exit) {
      await this.completeInTransaction(id, exit.signal || exit.code !== 0 ? 'failed' : 'finished',
        exit.signal, exit.code, transaction, undefined, exit.time, true);
      this.retireReceiptAfterCommit(id, exit.file, transaction, 'exit');
    } else if (state === 'skipped') {
      await this.finish(id, state, reason, code, transaction);
      await this.settleInstance(id, transaction);
    } else {
      await this.completeInTransaction(id, state, reason, code, transaction, undefined, finishedAt);
    }
  }

  private async withdrawBooking(booking: LegacyExitBooking, transaction: Transaction) {
    const { trigger_id: id, stat_id: stat } = booking;
    const elapsed = Math.max(0, booking.finished_at - booking.started_at);
    if (stat !== null) {
      // Only the row that received this exact contribution can be debited. A deleted day stays deleted.
      await this.database.query(`UPDATE CrontabStats SET run_count=run_count-1, success_count=success_count-$success,
        fail_count=fail_count-$failure,total_time=total_time-$elapsed,updatedAt=CURRENT_TIMESTAMP,
        max_time=MAX(COALESCE(fixed_max_time,0),COALESCE((SELECT MAX(MAX(0,finished_at-started_at))
          FROM CronLegacyExitBookings WHERE stat_id=$stat AND trigger_id<>$id),0)) WHERE id=$stat`,
        { bind: { stat, id, elapsed, success: Number(!booking.stopped && booking.outcome === '0'),
          failure: Number(!booking.stopped && booking.outcome !== '0') }, transaction });
      await this.database.query('DELETE FROM CrontabStats WHERE id=$stat AND run_count=0', { bind: { stat }, transaction });
    }
  }

  private async invalidateBookedTrigger(id: string, transaction: Transaction) {
    const [trigger] = await this.database.query<{ instance_id: number | null; state: TriggerState; cron_id: number }>(
      'SELECT instance_id,state,cron_id FROM CronTriggers WHERE id=$id AND started_at IS NOT NULL', { bind: { id }, type: QueryTypes.SELECT, transaction });
    if (!trigger) return false;
    const ref = trigger.cron_id;
    await this.database.query(`UPDATE CronTriggers SET counted=0,exit_pending=1,stop_exit_verified=NULL,stop_exit_at=NULL,
      exit_code=NULL,reason=NULL,state=CASE WHEN state='running' THEN state ELSE 'unknown' END WHERE id=$id`, { bind: { id }, transaction });
    if (trigger.instance_id !== null && trigger.state !== 'running') {
      await this.database.query('UPDATE RunningInstances SET status=4,exit_code=NULL,updatedAt=CURRENT_TIMESTAMP WHERE id=$instance AND cron_id=$ref',
        { bind: { instance: trigger.instance_id, ref }, transaction });
      await this.database.query('UPDATE Crontabs SET last_running_time=NULL WHERE id=$ref AND last_instance_id=$instance',
        { bind: { ref, instance: trigger.instance_id }, transaction });
    }
    return true;
  }

  private async disputeBoundExit(id: string, tuples: { outcome: string; time: number }[], transaction: Transaction) {
    if (!tuples.length) return;
    await this.database.query(`INSERT OR IGNORE INTO CronBoundExitConflicts(trigger_id,outcome,finished_at)
      SELECT $id,json_extract(value,'$.outcome'),json_extract(value,'$.time') FROM json_each($tuples)`,
      { bind: { id, tuples: JSON.stringify(tuples) }, transaction });
  }

  private async bookPrunedExit(run: Pick<LegacyExitBooking, 'trigger_id' | 'cron_id' | 'source' | 'started_at'>,
    stopped: boolean, exit: ExitObservation, transaction: Transaction) {
    const day = dayjs(exit.time).format('YYYY-MM-DD');
    const state = stopped ? 'stopped' : exit.code === 0 ? 'finished' : 'failed';
    await addDailyExit(this.database, run.cron_id, day, state, Math.max(0, exit.time - run.started_at), true, transaction);
    await this.database.query(`INSERT INTO CronLegacyExitBookings(trigger_id,cron_id,source,started_at,finished_at,outcome,day,stopped,bound,stat_id)
      VALUES($id,$ref,$source,$start,$time,$outcome,$day,$stopped,1,
        (SELECT id FROM CrontabStats WHERE ref_id=$ref AND date=$day
         AND NOT EXISTS (SELECT 1 FROM CronStatRetention WHERE id=1 AND first_day>$day)))
      ON CONFLICT(trigger_id) DO UPDATE SET bound=1,disputed=0,outcome=excluded.outcome,finished_at=excluded.finished_at,
        day=excluded.day,stat_id=excluded.stat_id`,
      { bind: { ...observationKey(run.trigger_id, exit), ref: run.cron_id, source: run.source, start: run.started_at,
        day, stopped: Number(stopped) }, transaction });
  }

  private async reviseLegacyBooking(booking: LegacyExitBooking, bound: ExitObservation | undefined, transaction: Transaction) {
    const id = booking.trigger_id;
    await this.withdrawBooking(booking, transaction);
    const retained = await this.invalidateBookedTrigger(id, transaction);
    if (!retained) {
      if (!bound) {
        await this.database.query('UPDATE CronLegacyExitBookings SET disputed=1,stat_id=NULL WHERE trigger_id=$id',
          { bind: { id }, transaction });
      } else {
        await this.bookPrunedExit(booking, Boolean(booking.stopped), bound, transaction);
      }
      return false;
    }
    await this.database.query('DELETE FROM CronLegacyExitBookings WHERE trigger_id=$id', { bind: { id }, transaction });
    if (!bound) await this.database.query(`INSERT OR IGNORE INTO CronExitObservations(trigger_id,outcome,finished_at)
      VALUES($id,$outcome,$time)`, { bind: { id, outcome: booking.outcome, time: booking.finished_at }, transaction });
    return true;
  }

  private retireDuplicatePublications(id: string, copies: Awaited<ReturnType<typeof readExit>>[], transaction: Transaction) {
    // Independent scans must agree about which file to keep even if they see
    // different subsets. Only newer per-writer publications can be discarded.
    const witnesses = new Map<string, string>();
    const redundant: { file: string; key: string; outcome: string; time: number }[] = [];
    // Prefer a JSON copy readable by older panels. Compare full paths within
    // each format so concurrent collectors always choose the same survivor.
    const rank = (file: string) => (isMetadataReceipt(file) ? '1' : '0') + file;
    for (const copy of copies) {
      if (copy?.version !== 1 || copy.namedExit || !basename(copy.file).startsWith('.pending.')) continue;
      const { outcome, time } = observationKey(id, copy);
      const key = JSON.stringify([outcome, time]);
      const previous = witnesses.get(key);
      if (previous && previous !== copy.file) {
        redundant.push({ file: rank(previous) < rank(copy.file) ? copy.file : previous, key, outcome, time });
      }
      if (!previous || rank(copy.file) < rank(previous)) witnesses.set(key, copy.file);
    }
    if (!redundant.length) return;
    transaction.afterCommit(async () => {
      // Sequelize also invokes this hook after a failed COMMIT. Verify the
      // specific tuple in a separate snapshot, including on an existing dispute.
      try {
        const rows = await this.database.query<{outcome: string; finished_at: number}>(
          'SELECT outcome,finished_at FROM CronBoundExitConflicts WHERE trigger_id=$id',
          { bind: { id }, transaction: null, type: QueryTypes.SELECT });
        const committed = new Set(rows.map(row => JSON.stringify([row.outcome, row.finished_at])));
        for (const copy of redundant) {
          if (!committed.has(copy.key)) continue;
          const keeper = await readExit(id, witnesses.get(copy.key)!);
          if (keeper?.version === 1 && keeper.time === copy.time && observationKey(id, keeper).outcome === copy.outcome) {
            await retireLegacyFile(id, copy.file, copy).catch(() => {});
          }
        }
      } catch { /* Retry on the next recovery pass. */ }
    });
  }

  private retireReceiptAfterCommit(id: string, file: string, transaction: Transaction, kind: 'exit' | 'start' | 'bound-copy', observed?: Awaited<ReturnType<typeof readExit>>) {
    // Sequelize 6 runs afterCommit even when COMMIT itself failed. Check a
    // separate committed snapshot before deleting the only durable outcome.
    transaction.afterCommit(async () => {
      try {
        const pendingCondition = kind === 'start' ? 'script_started_at IS NULL' : 'counted=0';
        const [saved] = await this.database.query<{ pending: number; outcome: string | null; finished_at: number | null; bound: number; conflicted: number; unmatched: number }>(
          `SELECT EXISTS(SELECT 1 FROM CronTriggers WHERE id=$id AND ${pendingCondition}) AS pending,
             EXISTS(SELECT 1 FROM CronBoundExitConflicts WHERE trigger_id=$id) AS conflicted,
             (b.trigger_id IS NULL AND u.trigger_id IS NOT NULL) AS unmatched,
             COALESCE(b.outcome,u.outcome) AS outcome,COALESCE(b.finished_at,u.finished_at) AS finished_at,
             COALESCE(b.bound,u.trigger_id IS NOT NULL) AS bound FROM (SELECT 1)
             LEFT JOIN CronLegacyExitBookings b ON b.trigger_id=$id LEFT JOIN CronUnmatchedBoundExits u ON u.trigger_id=$id`,
          { bind: { id }, transaction: null, type: QueryTypes.SELECT });
        if (saved.pending || (kind !== 'start' && saved.conflicted)) return;
        if (saved.outcome !== null && saved.finished_at !== null && kind !== 'start') {
          if (saved.unmatched) {
            // A legacy public name may be unreadable until claimed. Verify the
            // moved bytes directly against the durable unmatched observation.
            await retireLegacyFile(id, file, { outcome: saved.outcome, time: saved.finished_at });
            return;
          }
          // After a failed correction the old booking is still visible.
          if (kind === 'bound-copy' && !saved.bound) return;
          const current = await readExit(id, file);
          if (current && ((saved.bound && current.version !== 1) || (current.time === saved.finished_at &&
              observationKey(id, current).outcome === saved.outcome && (saved.bound || current.version !== 1)))) {
            await retireLegacyFile(id, file, saved.bound ? { outcome: saved.outcome, time: saved.finished_at } : undefined);
          }
          return;
        }
        if (kind === 'start') await fs.rm(file, { force: true });
        else if (observed?.version !== 1) await retireLegacyFile(id, file);
      } catch { /* Keep the receipt for the next recovery pass. */ }
    });
  }

  private async replayRetiringExits(transaction?: Transaction) {
    const byId = new Map<string, NonNullable<Awaited<ReturnType<typeof readExit>>>[]>();
    const unreadable = new Set<string>();
    for (const { id, file } of await retiringExits()) {
      const exit = await readExit(id, file);
      if (exit === undefined) continue;
      if (exit === null || (exit.version !== 1 && isBoundPublication(file))) {
        unreadable.add(id);
        continue;
      }
      if (exit.version !== 1) {
        // Inspect the atomically moved bytes even when a stale temporary file is being replaced.
        await retireLegacyFile(id, file).catch(() => {});
        continue;
      }
      const copies = byId.get(id) ?? [];
      copies.push(exit);
      byId.set(id, copies);
    }
    if (unreadable.size) {
      // Retention runs this scan before deletion. Keep unresolved history for
      // later repair without ending a live process solely on damaged bytes.
      await this.database.query(`UPDATE CronTriggers SET exit_pending=1 WHERE counted=0 AND state='unknown'
        AND exit_pending IS NOT 1 AND owner IS NOT NULL AND started_at IS NOT NULL
        AND id IN (SELECT value FROM json_each($ids))`, { transaction, bind: { ids: JSON.stringify([...unreadable]) } });
    }
    for (const [id, copies] of byId) {
      const settle = async (tx: Transaction) => {
        await this.recoverScriptSample(id, tx);
        await this.completeCommandExit(id, 'unknown', null, null, tx, undefined, undefined, undefined, copies);
      };
      if (transaction) await settle(transaction);
      else await this.database.transaction(settle);
    }
    return byId;
  }

  private async pendingExit(id: string, transaction: Transaction) {
    const [row] = await this.database.query<Pick<Trigger, 'state' | 'reason' | 'exit_code' | 'started_at' | 'finished_at'> & {
      owner: string | null; command_identity: string | null; stop_requested: number | null; stop_exit_verified: number | null; stop_exit_at: number | null; exit_pending: number | null;
    }>(
      `SELECT state,reason,exit_code,started_at,finished_at,owner,command_identity,stop_requested,stop_exit_verified,stop_exit_at,exit_pending
       FROM CronTriggers WHERE id=$id AND counted=0`,
      { bind: { id }, transaction, type: QueryTypes.SELECT });
    return row;
  }

  private async hasExitObservation(id: string, exit: ExitObservation, transaction?: Transaction) {
    const [match] = await this.database.query(
      `SELECT 1 FROM CronExitObservations WHERE trigger_id=$id GROUP BY trigger_id
       HAVING COUNT(*)=1 AND MAX(outcome)=$outcome AND MAX(finished_at)=$time`,
      { bind: observationKey(id, exit), type: QueryTypes.SELECT, transaction });
    return Boolean(match);
  }

  private async saveExitObservation(id: string, observation: ExitObservation, transaction: Transaction) {
    await this.database.query(`INSERT INTO CronExitObservations(trigger_id,outcome,finished_at)
      SELECT $id,$outcome,$time WHERE NOT EXISTS
        (SELECT 1 FROM CronExitObservations WHERE trigger_id=$id LIMIT 1 OFFSET 1)
      ON CONFLICT(trigger_id,outcome,finished_at) DO NOTHING`, { bind: observationKey(id, observation), transaction });
  }

  private async deferExit(id: string, transaction: Transaction, observation?: ExitObservation) {
    if (observation) await this.saveExitObservation(id, observation, transaction);
    await this.database.query('UPDATE CronTriggers SET exit_pending=1 WHERE id=$id AND exit_pending IS NOT 1',
      { bind: { id }, transaction });
    // A signalled stop remains running until all of its descendants are gone.
    await this.database.query(`UPDATE CronTriggers SET state='unknown',reason=NULL,exit_code=NULL,
      finished_at=COALESCE(finished_at,$now) WHERE id=$id AND state='running'
      AND NOT EXISTS (SELECT 1 FROM CronStopRequests s WHERE s.instance_id=CronTriggers.instance_id
        AND s.targets IS NOT NULL AND s.signalled=1)`,
      { bind: { id, now: Date.now() }, transaction });
    await this.settleInstance(id, transaction);
  }

  async retryPendingExits() {
    const rows = await this.database.query<{ id: string }>(
      `SELECT id FROM CronTriggers WHERE exit_pending=1 AND
        NOT EXISTS (SELECT 1 FROM CronBoundExitConflicts WHERE trigger_id=CronTriggers.id)`, { type: QueryTypes.SELECT });
    for (const { id } of rows) {
      const exit = await readExit(id);
      if (exit && (exit.version === 1 || await this.hasExitObservation(id, exit))) {
        // Carry a verified bound receipt across a concurrent file replacement.
        // Unbound evidence must still match inside the writer transaction.
        await this.complete(id, 'unknown', null, null, undefined, exit.version === 1 ? exit : undefined);
      }
    }
    // A canonical-only file can reappear after startup already marked its owner
    // unknown. Probe IDs found on disk so missing receipts cost no per-run work.
    const recovered = await this.replayRetiringExits();
    const files = (await publishedExits()).filter(id => !recovered.has(id));
    if (files.length) {
      const candidates = await this.database.query<{ id: string }>(
        `SELECT value AS id FROM json_each($files) WHERE
          EXISTS (SELECT 1 FROM CronTriggers WHERE id=value AND state='unknown' AND reason='restart'
            AND counted=0 AND owner IS NOT NULL AND started_at IS NOT NULL) OR
          EXISTS (SELECT 1 FROM CronPrunedUnknownRuns WHERE trigger_id=value) OR
          EXISTS (SELECT 1 FROM CronLegacyExitBookings WHERE trigger_id=value) OR
          EXISTS (SELECT 1 FROM CronBoundExitConflicts WHERE trigger_id=value) OR
          EXISTS (SELECT 1 FROM CronUnmatchedBoundExits WHERE trigger_id=value)`,
        { bind: { files: JSON.stringify(files) }, type: QueryTypes.SELECT });
      for (const { id } of candidates) {
        const exit = await readExit(id);
        if (exit?.version === 1) await this.complete(id, 'unknown', null, null, undefined, exit);
      }
    }
    await this.collectPublishedScriptStarts();
  }

  private async collectPublishedScriptStarts() {
    const files = await publishedScriptStarts();
    if (!files.length) return;
    // Only probe existing executions. Keep live markers in place so another
    // instrumented command in the same execution cannot replace the first sample.
    const rows = await this.database.query<{ id: string; counted: number; script_started_at: number | null }>(
      `SELECT id,counted,script_started_at FROM CronTriggers WHERE id IN (SELECT value FROM json_each($ids))
       AND started_at IS NOT NULL AND (script_started_at IS NULL OR counted=1)`,
      { bind: { ids: JSON.stringify(files.map(({ id }) => id)) }, type: QueryTypes.SELECT });
    for (const row of rows) {
      const sample = await this.readScriptSample(row.id);
      if (!sample) continue;
      await this.database.transaction(async transaction => {
        if (row.script_started_at === null) await this.saveScriptSample(row.id, sample, transaction);
        if (row.counted) this.retireReceiptAfterCommit(row.id, sample.marker, transaction, 'start');
      });
    }
  }

  async replayPublishedExits(transaction: Transaction) {
    const recovered = await this.replayRetiringExits(transaction);
    // Entry instrumentation can outlive its committed transaction even if the
    // exit file was already deleted. An unregistered entry may still be live.
    const exits = new Set(await publishedExits());
    for (const { id, file } of await publishedScriptStarts()) {
      const [row] = await this.database.query<{ counted: number; script_started_at: number | null }>(
        'SELECT counted,script_started_at FROM CronTriggers WHERE id=$id',
        { bind: { id }, transaction, type: QueryTypes.SELECT });
      // After pruning the trigger, a matching supervisor exit still identifies
      // this panel's retired run. A start file alone cannot establish that.
      if (row ? row.counted && row.script_started_at !== null : exits.has(id)) {
        this.retireReceiptAfterCommit(id, file, transaction, 'start');
      }
    }
    for (const id of exits) {
      if (recovered.has(id)) continue;
      const pending = await this.pendingExit(id, transaction);
      if (!pending) {
        await this.completeCommandExit(id, 'unknown', 'restart', null, transaction, undefined, undefined, undefined, []);
      } else if (pending.owner && pending.started_at !== null) {
        const exit = await readExit(id);
        if (exit === undefined) continue;
        await this.recoverScriptSample(id, transaction);
        await this.completeCommandExit(id, 'unknown', 'restart', null, transaction, exit, undefined, undefined, []);
      }
    }
  }

  // Original registration order breaks ties even when upgrade adoption runs later.
  private async claimSummary(cronId: number, instance: number, seconds: number, transaction: Transaction,
    observedStart: boolean, duration: number | null = null) {
    await this.database.query(`UPDATE Crontabs SET last_instance_id=$instance,
      last_execution_time=$seconds,last_running_time=$duration WHERE id=$cronId AND
      (last_execution_time IS NULL OR last_execution_time<$seconds OR
       (last_execution_time=$seconds AND (last_instance_id IS NULL OR
         ($observedStart AND last_instance_id<$instance))))`,
      { transaction, bind: { cronId, instance, seconds, duration, observedStart: Number(observedStart) } });
  }

  private async completeInTransaction(id: string, state: TriggerState, reason: string | null,
    code: number | null, transaction: Transaction, elapsedMs?: number, finishedAt?: number, verifiedExit = false) {
    if (await this.shouldStop(id, transaction)) {
      state = 'stopped';
      reason = 'cancelled';
      // The command can exit before its TERM-resistant descendants. Keep the
      // receipt running until the stop operation has verified the whole tree.
      const waiting = await this.database.query(`UPDATE CronTriggers SET
        exit_code=CASE WHEN stop_exit_at IS NULL OR ($verified AND stop_exit_verified IS NOT 1) THEN $code ELSE exit_code END,
        stop_exit_at=CASE WHEN stop_exit_at IS NULL OR ($verified AND stop_exit_verified IS NOT 1) THEN $now ELSE stop_exit_at END,
        stop_exit_verified=CASE WHEN $verified THEN 1 ELSE stop_exit_verified END
        WHERE id=$id AND state='running' AND stop_requested=1 AND instance_id IN
        (SELECT instance_id FROM CronStopRequests WHERE targets IS NOT NULL AND signalled=1)`,
        { transaction, bind: { id, code, now: finishedAt ?? Date.now(), verified: Number(verifiedExit) }, type: QueryTypes.BULKUPDATE });
      if (waiting) return;
    } else if (state === 'stopped' && reason?.startsWith('SIG')) {
      state = 'failed';
    }
    const changed = await this.finish(id, state, reason, code, transaction, finishedAt);
    const [row] = await this.database.query<Trigger & { instance_id: number | null }>(
      `SELECT cron_id, instance_id, log_path, started_at, finished_at, exit_code FROM CronTriggers WHERE id=$id
       AND state IN ('finished','failed','stopped') AND started_at IS NOT NULL AND counted=0`,
      { transaction, bind: { id }, type: QueryTypes.SELECT },
    );
    await this.settleInstance(id, transaction);
    if (!row) return;
    const duration = elapsedMs ?? Math.max(0, row.finished_at! - row.started_at!);
    if (changed && row.instance_id !== null) {
      await this.database.query(`UPDATE Crontabs SET last_running_time=$duration
        WHERE id=$cronId AND last_execution_time=$start AND (last_instance_id=$instance OR
          (last_instance_id IS NULL AND $instance=(SELECT id FROM RunningInstances WHERE cron_id=$cronId
            ORDER BY started_at DESC,id DESC LIMIT 1)))`,
        { transaction, bind: { cronId: row.cron_id,
          start: Math.floor(row.started_at! / 1000), instance: row.instance_id, duration: Math.floor(duration / 1000) } });
    }
    await recordCronResult(this.database, row.cron_id, row.exit_code ?? 1, duration, row.finished_at!, id, transaction);
  }

  private async hasBoundConflict(id: string, transaction: Transaction) {
    const [conflict] = await this.database.query('SELECT 1 FROM CronBoundExitConflicts WHERE trigger_id=$id',
      { bind: { id }, transaction, type: QueryTypes.SELECT });
    return Boolean(conflict);
  }

  // Old shell-only executions publish status and statistics independently.
  // Either final receipt can settle that execution if the other was lost.
  async recordShellResult(id: string, cronId: number, code: number, elapsedMs: number, now: number, finishedAt?: number) {
    return this.database.transaction(async transaction => {
      if (await this.hasBoundConflict(id, transaction)) return;
      const [row] = await this.database.query<{ owner: string | null; state: TriggerState }>(
        'SELECT owner,state FROM CronTriggers WHERE id=$id AND cron_id=$cronId',
        { transaction, type: QueryTypes.SELECT, bind: { id, cronId } });
      if (!row) {
        if (finishedAt && finishedAt <= now) {
          const [pruned] = await this.database.query('SELECT 1 FROM CronHistoryRetention WHERE id=1 AND cutoff>$end',
            { transaction, type: QueryTypes.SELECT, bind: { end: finishedAt } });
          if (pruned) return;
        }
        throw new Error('Unknown trigger');
      }
      if (row.owner === null && (row.state === 'running' || row.state === 'unknown')) {
        await this.completeInTransaction(id, code === 0 ? 'finished' : 'failed', null, code, transaction, elapsedMs, finishedAt);
      } else {
        await recordCronResult(this.database, cronId, code, elapsedMs, now, id, transaction);
      }
    });
  }

  private async readScriptSample(id: string) {
    if (!process.env.QL_DIR || !/^[a-z0-9-]{1,120}$/.test(id)) return;
    const marker = join(process.env.QL_DIR, '.tmp', 'cron-start-' + id);
    try {
      const value = await fs.readFile(marker, 'utf8');
      if (/^\d{13}$/.test(value)) return { marker, time: Number(value) };
    } catch { /* Entries without instrumentation have no sample. */ }
  }

  private async recoverScriptSample(id: string, transaction: Transaction) {
    const sample = await this.readScriptSample(id);
    if (!sample) return;
    await this.saveScriptSample(id, sample, transaction);
    this.retireReceiptAfterCommit(id, sample.marker, transaction, 'start');
  }

  private async saveScriptSample(id: string, sample: { time: number } | undefined, transaction: Transaction) {
    if (sample) await this.database.query(`UPDATE CronTriggers SET script_started_at=$time
      WHERE id=$id AND script_started_at IS NULL AND started_at <= $time AND $time <= $now
      AND (finished_at IS NULL OR state='unknown' OR $time <= finished_at)`,
      { transaction, bind: { time: sample.time, now: Date.now(), id } });
  }

  async isRunning(cronId: number, transaction: Transaction) {
    await this.recoverSystemOwners(cronId, transaction);
    const rows = await this.database.query(
      "SELECT 1 FROM CronTriggers WHERE cron_id=$cronId AND state='running' LIMIT 1",
      { bind: { cronId }, transaction, type: QueryTypes.SELECT },
    );
    return rows.length !== 0;
  }

  async shellReport(
    id: string,
    cronId: number,
    system: boolean,
    running: boolean,
    log: string,
    seconds: number,
    exitCode?: number,
    stopped = false,
    transaction?: Transaction,
    elapsedMs?: number,
    finishedAt?: number,
  ): Promise<void | false> {
    if (!transaction) return this.database.transaction(tx =>
      this.shellReport(id, cronId, system, running, log, seconds, exitCode, stopped, tx, elapsedMs, finishedAt));
    if (await this.hasBoundConflict(id, transaction)) return false;
    if (system || executionIdPattern.test(id)) {
      // Standalone clients supply neither a scheduled instant nor a queue observation.
      const dated = Number.isSafeInteger(seconds) && seconds > 0;
      const start = dated ? seconds * 1000 : Date.now();
      const standalone = executionIdPattern.test(id) || id.startsWith('system-cli-');
      const lastKnownTime = standalone && !running && dated && finishedAt && finishedAt >= start && finishedAt <= Date.now()
        ? finishedAt : start;
      await this.database.query(
        `INSERT INTO CronTriggers(id,cron_id,source,state,started_at,observed_at)
         SELECT $id,$cronId,$source,'running',$start,$start
         WHERE NOT EXISTS (SELECT 1 FROM CronHistoryRetention WHERE id=1 AND ($dated=0 OR cutoff>$lastKnownTime))
         ON CONFLICT(id) DO NOTHING`,
        { transaction, bind: { id, cronId, start, lastKnownTime, dated: Number(dated), source: system ? 'system' : 'client' } },
      );
    }
    await this.database.query(
      `UPDATE CronTriggers SET log_path=COALESCE(log_path,$log) WHERE id=$id AND cron_id=$cronId`,
      { transaction, bind: { id, cronId, log } },
    );
    if (!running) {
      // For a managed command the wrapper may be only the first segment.
      // Only its supervisor can report the whole command's exit.
      const [legacy] = await this.database.query(
        'SELECT 1 FROM CronTriggers WHERE id=$id AND cron_id=$cronId AND owner IS NULL',
        { transaction, type: QueryTypes.SELECT, bind: { id, cronId } });
      if (legacy) {
        const state = stopped ? 'stopped' : exitCode == null ? 'unknown' : exitCode === 0 ? 'finished' : 'failed';
        await this.completeInTransaction(id, state, null, exitCode ?? null, transaction, elapsedMs, finishedAt);
      }
    }
  }

  async reportLegacy(cronId: number, running: boolean, pid: number, log: string,
    seconds: number, elapsed: number, code?: number) {
    return this.database.transaction(transaction =>
      this.applyLegacyReceipt(cronId, running, pid, log, seconds, elapsed, transaction, code));
  }

  private async applyLegacyReceipt(cronId: number, running: boolean, pid: number, log: string,
    seconds: number, elapsed: number, transaction: Transaction, code?: number) {
    const start = seconds * 1000;
    const receipt = 'legacy-' + createHash('sha256')
      .update(JSON.stringify([cronId, pid, seconds, log || null])).digest('hex');
    // A verified child stays attached to its supervisor even after the OS recycles its PID.
    const [bound] = await this.database.query('SELECT 1 FROM CronShellBindings WHERE receipt=$receipt',
      { transaction, type: QueryTypes.SELECT, bind: { receipt } });
    if (bound) return;

    const rows = await this.database.query<{ instance: number; status: number; finished_at: number | null; exit_code: number | null;
      id: string | null; source: TriggerSource | null; log_path: string | null }>(
      `SELECT i.id AS instance,i.status,i.finished_at,i.exit_code,i.log_path,t.id,t.source FROM RunningInstances i
       LEFT JOIN CronTriggers t ON t.instance_id=i.id WHERE i.cron_id=$cronId AND i.pid=$pid
       AND (t.id IS NULL OR t.source='legacy' OR t.owner IS NOT NULL)
       AND i.started_at=$seconds AND (i.log_path IS $log OR $log IS NULL OR i.log_path IS NULL) LIMIT 2`,
      { transaction, type: QueryTypes.SELECT, bind: { cronId, pid, seconds, log: log || null } });
    const [old] = rows;
    if (rows.length > 1) return;
    if (old) {
      if (!old.id && old.status === 4) {
        const [expired] = await this.database.query(
          'SELECT 1 FROM CronHistoryRetention WHERE cutoff>$end',
          { transaction, type: QueryTypes.SELECT, bind: { end: (old.finished_at ?? seconds) * 1000 } });
        if (expired) return;
      }
      if (old.status !== 0 && old.status !== 4) {
        if (!old.id && old.finished_at != null) {
          // The old panel owned the daily aggregate. Import its committed result
          // without replaying an anonymous statistics increment.
          const state = old.status === 1 ? 'finished' : old.status === 2 ? 'stopped' : 'failed';
          const inserted = await this.database.query(`INSERT INTO CronTriggers
            (id,cron_id,source,state,observed_at,started_at,finished_at,instance_id,log_path,exit_code,counted)
            SELECT $id,$cronId,'legacy',$state,$start,$start,$end,$instance,$log,$exit,1
            WHERE $end >= $start AND $end>=COALESCE((SELECT cutoff FROM CronHistoryRetention WHERE id=1),0)
              AND NOT EXISTS (SELECT 1 FROM RunningInstances sibling
                LEFT JOIN CronTriggers linked ON linked.instance_id=sibling.id
                WHERE sibling.cron_id=$cronId
                AND sibling.pid=$pid AND sibling.finished_at=$end/1000 AND sibling.id<>$instance
                AND sibling.status IN (1,3) AND (linked.id IS NULL OR (linked.source='legacy' AND linked.owner IS NULL)))
            ON CONFLICT DO NOTHING`, { transaction, type: QueryTypes.BULKUPDATE,
            bind: { id:receipt,cronId,pid,state,start,end:old.finished_at*1000,instance:old.instance,log:old.log_path,exit:old.exit_code } });
          if (inserted) await this.claimSummary(cronId, old.instance, seconds, transaction, true,
            Math.max(0, old.finished_at - seconds));
        }
        return;
      }
      if (running && (old.id || old.status === 4)) return;
      if (old.id && old.source !== 'legacy') return;
    }

    let identity: string | undefined;
    if (!old) {
      const [prior] = await this.database.query('SELECT 1 FROM CronTriggers WHERE id=$receipt UNION ALL SELECT 1 FROM CronHistoryRetention WHERE cutoff>$start',
        { transaction, type: QueryTypes.SELECT, bind: { receipt, start } });
      if (prior) return;
      identity = legacyProcessOwner(pid, seconds);
      const roots = await this.database.query<{id: string; command_identity: string}>(
        `SELECT id,command_identity FROM CronTriggers WHERE cron_id=$cronId AND state='running'
         AND command_identity IS NOT NULL AND started_at < $end`,
        { transaction, type: QueryTypes.SELECT, bind: { cronId, end: start + 1000 } });
      for (const root of roots) {
        if (!identity) break;
        const parent = Number(root.command_identity.split(':')[1]);
        try {
          if (!isProcessDescendant(pid, parent) || systemOwner(parent) !== root.command_identity) continue;
        } catch (error) {
          if (['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code!)) continue;
          throw error;
        }
        await this.database.query('INSERT INTO CronShellBindings(receipt,trigger_id) VALUES ($receipt,$id)',
          { transaction, bind: { receipt, id: root.id } });
        if (running) await this.attachShellLog(root.id, cronId, log, transaction);
        return;
      }
    }

    const id = old?.id ?? receipt;
    if (!old?.id) {
      // A later use of the same numeric PID proves the older process is gone.
      const others = await this.database.query<{id: string; started_at: number}>(
        `SELECT t.id,i.started_at FROM RunningInstances i LEFT JOIN CronTriggers t ON t.instance_id=i.id
         WHERE i.cron_id=$cronId AND i.pid=$pid AND i.started_at<>$seconds
         AND (i.started_at>$seconds OR (i.status=0 AND t.source='legacy'))`,
        { transaction, type: QueryTypes.SELECT, bind: { cronId, pid, seconds } });
      if (running && old) identity = legacyProcessOwner(pid, seconds);
      const historical = !running || !identity || others.some(other => other.started_at > seconds);

      let instance = old?.instance;
      if (!instance) {
        [instance] = await this.database.query(
          `INSERT INTO RunningInstances(cron_id,pid,log_path,started_at,status,finished_at,createdAt,updatedAt)
           VALUES ($cronId,$pid,$log,$seconds,$status,$finished,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          { transaction, type: QueryTypes.INSERT, bind: { cronId, pid, log: log || null, seconds,
            status: historical ? 4 : 0, finished: historical ? Math.floor(Date.now()/1000) : null } });
      }
      const unknown = historical || old?.status === 4;
      await this.database.query(`INSERT INTO CronTriggers
        (id,cron_id,source,state,observed_at,started_at,finished_at,instance_id,log_path,process_identity,reason)
        VALUES ($id,$cronId,'legacy',$state,$start,$start,$end,$instance,$log,$identity,$reason)`,
        { transaction, bind: { id, cronId, start, instance, log: old?.log_path ?? (log || null), identity: !unknown && running ? identity ?? null : null,
          reason: old && running && !unknown ? 'restart' : null,
          state: unknown ? 'unknown' : 'running', end: unknown ? (old?.finished_at ? old.finished_at*1000 : Date.now()) : null } });
      await this.claimSummary(cronId, instance!, seconds, transaction, old?.status === 0 || (running && !unknown));
      for (const other of others) {
        if (other.started_at < seconds) await this.completeInTransaction(other.id, 'unknown', null, null, transaction);
      }
      if (running && !unknown) await this.database.query(
        `UPDATE Crontabs SET status=0,pid=$pid,log_path=$log
         WHERE id=$cronId AND status IS NOT 3 AND $instance=(
           SELECT id FROM RunningInstances WHERE cron_id=$cronId AND status=0 ORDER BY id DESC LIMIT 1)`,
        { transaction, bind: { cronId,pid,log:log || null,instance } });
      if (unknown && old?.status === 0 && running) await this.settleInstance(id, transaction);
    }
    if (!running) {
      const state = code == null ? 'unknown' : code === 0 ? 'finished' : 'failed';
      await this.completeInTransaction(id,state,null,code ?? null,transaction, Math.max(0,elapsed)*1000);
    }
  }

  private async attachShellLog(id: string, cronId: number, log: string, transaction: Transaction) {
    const attached = await this.database.query(`UPDATE RunningInstances SET log_path=$log WHERE status=0 AND log_path IS NULL
      AND id=(SELECT instance_id FROM CronTriggers WHERE id=$id AND cron_id=$cronId AND state='running')`,
      { transaction, type: QueryTypes.BULKUPDATE, bind: { id,cronId,log } });
    if (attached) {
      await this.database.query('UPDATE CronTriggers SET log_path=COALESCE(log_path,$log) WHERE id=$id',
        { transaction, bind: { id,log } });
      await this.database.query(`UPDATE Crontabs SET log_path=$log WHERE id=$cronId AND status=0 AND pid=(
        SELECT i.pid FROM RunningInstances i JOIN CronTriggers t ON t.instance_id=i.id WHERE t.id=$id)`,
        { transaction, bind: { id,cronId,log } });
    }
  }

  // Link the Shell instance and its trigger in the same IMMEDIATE write transaction.
  async reportInstance(id: string, cronId: number, running: boolean, pid: number, log: string,
    seconds: number, elapsed: number | undefined, code?: number, stopped = false, finishedAt?: number) {
    const sample = running ? undefined : await this.readScriptSample(id);
    await this.database.transaction(async (transaction) => {
      const accepted = await this.shellReport(id, cronId, id.startsWith('system-'), running, log, seconds, code, stopped, transaction, elapsed == null ? undefined : elapsed * 1000, finishedAt);
      if (accepted === false) return;
      const [row] = await this.database.query<{ state: TriggerState; started_at: number | null; instance_id: number | null; command_identity: string | null; owner: string | null }>(
        'SELECT state,started_at,instance_id,command_identity,owner FROM CronTriggers WHERE id=$id AND cron_id=$cronId',
        { transaction, bind: { id, cronId }, type: QueryTypes.SELECT });
      if (!row) return;
      const startSeconds = seconds > 0 ? seconds : Math.floor((row.started_at ?? Date.now()) / 1000);
      if (['finished','failed','stopped','unknown'].includes(row.state) && row.owner === null && row.instance_id === null) {
        // The CLI exit can commit before its first start. Link a terminal history
        // row directly without ever publishing this PID as the current instance.
        const [instance] = await this.database.query(`INSERT INTO RunningInstances
          (cron_id,pid,log_path,started_at,finished_at,status,exit_code,createdAt,updatedAt)
          SELECT cron_id,$pid,log_path,CAST(started_at/1000 AS INTEGER),CAST(finished_at/1000 AS INTEGER),
            CASE state WHEN 'finished' THEN 1 WHEN 'stopped' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
            exit_code,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM CronTriggers
          WHERE id=$id AND state IN ('finished','failed','stopped','unknown')`,
          { transaction, type: QueryTypes.INSERT, bind: { id,pid:pid || null } });
        if (instance) {
          await this.database.query('UPDATE CronTriggers SET instance_id=$instance WHERE id=$id',
            { transaction, bind: { instance,id } });
          await this.claimSummary(cronId, instance, startSeconds, transaction, false, row.state === 'unknown' ? null : elapsed ?? null);
        }
        return;
      }
      if (running && row.state !== 'running') return;
      if (running && row.instance_id === null) {
        let identity = row.command_identity;
        if (identity?.startsWith('crond:')) {
          pid = Number(identity.split(':')[1]);
        } else if (pid) {
          try { identity = systemOwner(pid); } catch { /* A short child may have exited. */ }
        }
        const [instance] = await this.database.query(
          `INSERT INTO RunningInstances(cron_id,pid,log_path,started_at,status,createdAt,updatedAt)
           VALUES ($cronId,$pid,$log,$seconds,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          { transaction, type: QueryTypes.INSERT, bind: { cronId, pid, log, seconds: startSeconds } });
        await this.database.query('UPDATE CronTriggers SET instance_id=$instance,process_identity=$identity WHERE id=$id',
          { transaction, bind: { instance, identity, id } });
        await this.claimSummary(cronId, instance, startSeconds, transaction, true);
        await this.database.query(`UPDATE Crontabs SET status=0,pid=$pid,log_path=$log
          WHERE id=$cronId AND (status IS NOT 3 OR queued_token || '-' || id=$id)`,
          { transaction, bind: { cronId, id, pid, log } });
      }
      if (running && row.instance_id !== null) {
        await this.attachShellLog(id, cronId, log, transaction);
      }
      if (!running) await this.saveScriptSample(id, sample, transaction);
    });
  }

  private async settleInstance(id: string, transaction: Transaction) {
    const [row] = await this.database.query<Trigger & { instance_id: number }>(
      `SELECT cron_id,instance_id,log_path,state,finished_at,exit_code FROM CronTriggers
       WHERE id=$id AND instance_id IS NOT NULL AND finished_at IS NOT NULL`,
      { transaction, bind: { id }, type: QueryTypes.SELECT });
    if (!row) return;
    if (row.state === 'skipped') {
      // The launch gate closed before user code ran.
      await this.database.query('DELETE FROM RunningInstances WHERE id=$instance AND status=0',
        { transaction, bind: { instance: row.instance_id } });
      await this.database.query('UPDATE CronTriggers SET instance_id=NULL WHERE id=$id', { transaction, bind: { id } });
    } else {
      const status = row.state === 'finished' ? 1 : row.state === 'stopped' ? 2 : row.state === 'unknown' ? 4 : 3;
      const updated = await this.database.query(`UPDATE RunningInstances SET status=$status,finished_at=$end,exit_code=$code,
        updatedAt=CURRENT_TIMESTAMP WHERE id=$instance AND cron_id=$cronId AND status=0`,
        { transaction, type: QueryTypes.BULKUPDATE, bind: { instance: row.instance_id, cronId: row.cron_id,
          status, end: Math.floor(row.finished_at! / 1000), code: row.exit_code } });
      if (!updated) {
        // A late exit corrects only the historical instance. Its replacement
        // already owns the task row, even when it uses the same PID and log.
        if (status !== 4) await this.database.query(`UPDATE RunningInstances
          SET status=$status,finished_at=$end,exit_code=$code,updatedAt=CURRENT_TIMESTAMP
          WHERE id=$instance AND cron_id=$cronId AND status=4`,
          { transaction, bind: { instance: row.instance_id, cronId: row.cron_id, status,
            end: Math.floor(row.finished_at! / 1000), code: row.exit_code } });
        return;
      }
    }
    // A newer manual reservation owns its own token. Never clear it while an older run exits.
    const [active] = await this.database.query<{ pid: number; log_path: string; started_at: number }>(
      'SELECT pid,log_path,started_at FROM RunningInstances WHERE cron_id=$cronId AND status=0 ORDER BY id DESC LIMIT 1',
      { transaction, bind: { cronId: row.cron_id }, type: QueryTypes.SELECT });
    if (active) {
      await this.database.query(`UPDATE Crontabs SET status=0,pid=$pid,log_path=$log
        WHERE id=$cronId AND status IS NOT 3`, { transaction, bind: { cronId: row.cron_id,
        pid: active.pid, log: active.log_path } });
    } else {
      await this.database.query(`UPDATE Crontabs SET status=1,pid=NULL,queued_token=NULL
        WHERE id=$cronId AND status=0 AND log_path IS $log`,
        { transaction, bind: { cronId: row.cron_id, log: row.log_path } });
    }
  }

  async cancelQueued(ids: number[]) {
    if (!ids.length) return [];
    return this.database.transaction(tx => this.cancelQueuedInTransaction(ids, tx));
  }

  async cancelQueuedInTransaction(ids: number[], transaction: Transaction) {
    await this.database.query("UPDATE CronTriggers SET stop_requested=1 WHERE cron_id IN (:ids) AND state='running' AND command_identity IS NULL AND instance_id IS NULL",
      { replacements: { ids }, transaction });
    const rows = await this.database.query<{ id: string }>(
      "SELECT id FROM CronTriggers WHERE cron_id IN (:ids) AND state='queued'",
      { replacements: { ids }, transaction, type: QueryTypes.SELECT });
    await this.database.query(`UPDATE CronTriggers SET state='stopped',reason='cancelled',finished_at=:now
      WHERE cron_id IN (:ids) AND state='queued'`, { replacements: { ids, now: Date.now() }, transaction });
    return rows.map((r) => r.id);
  }

  async queueInstanceStop(instanceId: number, cronId: number, pid: number, transaction?: Transaction, identity?: string) {
    await this.database.query(`INSERT INTO CronStopRequests(instance_id,cron_id,pid,root_identity,namespace_owner)
      VALUES ($instanceId,$cronId,$pid,$identity,$namespace)
      ON CONFLICT(instance_id) DO UPDATE SET root_identity=excluded.root_identity
      WHERE root_identity IS NULL AND excluded.root_identity IS NOT NULL AND pid=excluded.pid AND signalled=0`,
      { transaction, bind: { instanceId, cronId, pid, identity: identity ?? null, namespace: pidNamespaceOwner() } });
  }

  async pendingStop(instanceId: number, transaction?: Transaction) {
    const [row] = await this.database.query<{ targets: string | null; signalled: number; signalled_at: number | null; root_identity: string | null; namespace_owner: string | null }>(
      'SELECT targets,signalled,signalled_at,root_identity,namespace_owner FROM CronStopRequests WHERE instance_id=$instanceId',
      { transaction, bind: { instanceId }, type: QueryTypes.SELECT });
    return row;
  }

  async pendingStopBatches() {
    return this.database.query<{ request_id: string; cron_ids: string }>(
      'SELECT request_id,cron_ids FROM CronStopBatches WHERE snapshot IS NOT NULL', { type: QueryTypes.SELECT });
  }

  async pendingStops() {
    return this.database.query<{ instance_id: number; cron_id: number; pid: number; targets: string | null }>(
      'SELECT instance_id,cron_id,pid,targets FROM CronStopRequests ORDER BY instance_id', { type: QueryTypes.SELECT });
  }

  async forgetStop(instanceId: number, onEnded?: (tx: Transaction) => Promise<void>) {
    return this.database.transaction(async transaction => {
      await this.database.query('DELETE FROM CronStopRequests WHERE instance_id=$instanceId AND signalled=0',
        { transaction, bind: { instanceId } });
      const claimed = await this.pendingStop(instanceId, transaction);
      if (!claimed && onEnded) await onEnded(transaction);
      return claimed;
    });
  }

  async shouldStop(id: string, transaction?: Transaction) {
    const rows = await this.database.query(
      "SELECT 1 FROM CronTriggers WHERE id=$id AND stop_requested=1",
      { transaction, bind: { id }, type: QueryTypes.SELECT });
    return rows.length > 0;
  }

  // The outer command can outlive any of its task wrappers.
  async recordCommandStart(id: string, at: number) {
    await this.database.query(`UPDATE CronTriggers SET command_started_at=$at
      WHERE id=$id AND command_started_at IS NULL AND started_at IS NOT NULL`,
      {bind: {id, at}});
  }

  async bindCommand(id: string, pid: number, log?: string) {
    let identity: string;
    try { identity = systemOwner(pid); } catch (error) {
      if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code!)) return false;
      throw error;
    }
    return this.database.transaction(async transaction => {
      const [row] = await this.database.query<{ instance_id: number | null; cron_id: number; started_at: number }>(
        "SELECT instance_id,cron_id,started_at FROM CronTriggers WHERE id=$id AND state='running'",
        { transaction, bind: { id }, type: QueryTypes.SELECT });
      if (!row) return false;
      await this.database.query('UPDATE CronTriggers SET command_identity=$identity WHERE id=$id',
        { transaction, bind: { identity, id } });
      if (row.instance_id) {
        await this.database.query('UPDATE RunningInstances SET pid=$pid WHERE id=$instance AND status=0',
          { transaction, bind: { pid, instance: row.instance_id } });
        await this.database.query('UPDATE CronTriggers SET process_identity=$identity WHERE id=$id',
          { transaction, bind: { identity, id } });
        await this.database.query('UPDATE Crontabs SET pid=$pid WHERE id=$cronId AND log_path=(SELECT log_path FROM CronTriggers WHERE id=$id) AND status=0',
          { transaction, bind: { pid, cronId: row.cron_id, id } });
      } else {
        await this.registerCommandInstance(id, row.cron_id, pid, identity, row.started_at, log, transaction);
      }
      return true;
    });
  }

  private async registerCommandInstance(id: string, cronId: number, pid: number, identity: string,
    started: number, log: string | undefined, transaction: Transaction) {
    const seconds = Math.floor(started / 1000);
    const [instance] = await this.database.query(
      `INSERT INTO RunningInstances(cron_id,pid,log_path,started_at,status,createdAt,updatedAt)
       VALUES ($cronId,$pid,$log,$seconds,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      { transaction, type: QueryTypes.INSERT, bind: { cronId, pid, log: log ?? null, seconds } });
    await this.database.query('UPDATE CronTriggers SET log_path=$log,instance_id=$instance,process_identity=$identity WHERE id=$id',
      { transaction, bind: { id, log: log ?? null, instance, identity } });
    await this.claimSummary(cronId, instance, seconds, transaction, true);
    if (log === undefined) await this.database.query(
      'UPDATE Crontabs SET status=0,pid=$pid,log_path=NULL WHERE id=$cronId AND status IS NOT 3',
      { transaction, bind: { cronId, pid } });
  }

  async activeCommands(ids: number[], transaction?: Transaction) {
    if (!ids.length) return [];
    return this.database.query<{ id: string; cron_id: number; command_identity: string; started_at: number; log_path: string }>(
      "SELECT id,cron_id,command_identity,started_at,log_path FROM CronTriggers WHERE cron_id IN (:ids) AND state='running' AND instance_id IS NULL AND command_identity IS NOT NULL",
      { replacements: { ids }, transaction, type: QueryTypes.SELECT });
  }

  async instanceIdentity(instanceId: number) {
    const [row] = await this.database.query<{ process_identity: string | null }>(
      'SELECT process_identity FROM CronTriggers WHERE instance_id=$instanceId',
      { bind: { instanceId }, type: QueryTypes.SELECT });
    return row?.process_identity;
  }

  async requestInstanceStop(instanceId: number, pid: number, signalTree: () => void | Error, targets?: string[]) {
    // Commit the verified tree BEFORE the first signal. If this worker dies even
    // inside the following transaction, its replacement still has the original PIDs.
    if (targets) await this.database.query(`INSERT INTO CronStopRequests(instance_id,cron_id,pid,targets)
      SELECT i.id,i.cron_id,i.pid,$targets FROM RunningInstances i WHERE i.id=$instanceId AND i.pid=$pid AND i.status=0
      ON CONFLICT(instance_id) DO UPDATE SET targets=(
        SELECT json_group_array(value) FROM (SELECT value FROM json_each(CronStopRequests.targets)
          UNION SELECT value FROM json_each(excluded.targets))) WHERE CronStopRequests.signalled=0`,
      { bind: { instanceId, pid, targets: JSON.stringify(targets) } });
    const result = await this.database.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
      const [row] = await this.database.query<{
        id: string | null; pid: number; status: number; state: TriggerState | null; stop_requested: number | null;
      }>(`SELECT t.id,i.pid,i.status,t.state,t.stop_requested FROM RunningInstances i
          LEFT JOIN CronTriggers t ON t.instance_id=i.id WHERE i.id=$instanceId`,
        { transaction, bind: { instanceId }, type: QueryTypes.SELECT });
      if (!row || row.status !== 0 || (row.state && row.state !== 'running')) {
        throw Object.assign(new Error('Instance already ended'), { code: 'ESRCH' });
      }
      if (row.pid !== pid) throw Object.assign(new Error('Instance process changed'), { status: 409 });
      if (row.stop_requested && !targets) return;
      const existing = await this.pendingStop(instanceId, transaction);
      const savedTargets: string[] = existing?.targets ? JSON.parse(existing.targets) : [];
      if (existing?.signalled) return { targets: savedTargets, signalledAt: existing.signalled_at };
      // The supervisor can still be draining output after the command has exited.
      if (row.id) {
        const exit = await this.exitBeforeStop(row.id);
        // An I/O error alone cannot prove a live process has already exited.
        if (!exit.published && exit.unreadable) throw Object.assign(new Error('Cannot verify command exit. Retry the stop request.'), { status: 503 });
        if (exit.published) {
          await this.completeCommandExit(row.id, 'unknown', null, null, transaction, exit.canonical, undefined, undefined, exit.recovered);
          return { ended: true };
        }
      }
      if (targets && !existing?.targets) {
        // Another worker released the prepared tree. Retry from a durable
        // snapshot before issuing an irreversible signal.
        throw Object.assign(new Error('Stop target snapshot changed. Retry the stop request.'), { status: 503 });
      }
      const signalledAt = Date.now();
      await this.database.query('UPDATE CronStopRequests SET signalled=1,signalled_at=$signalledAt WHERE instance_id=$instanceId',
        { transaction, bind: { instanceId, signalledAt } });
      if (row.state) await this.database.query(
        "UPDATE CronTriggers SET stop_requested=1 WHERE instance_id=$instanceId AND state='running'",
        { bind: { instanceId }, transaction });
      // Root delivery failure rolls back. After successful root delivery, retain
      // the stop marker even if some descendants still need recovery.
      const error = signalTree();
      return { targets: savedTargets, signalledAt, error };
    });
    if (result && 'ended' in result) throw Object.assign(new Error('Instance already ended'), { code: 'ESRCH' });
    if (result && 'error' in result && result.error instanceof Error) throw result.error;
    if (targets && result) return { targets: result.targets, signalledAt: result.signalledAt };
  }

  private async exitBeforeStop(id: string) {
    const recovered = await Promise.all((await retiringExits()).filter(copy => copy.id === id)
      .map(copy => readExit(id, copy.file)));
    const canonical = await readExit(id);
    const verified = recovered.some(copy => copy?.version === 1);
    const unreadable = canonical === null || recovered.some(copy => copy === null ||
      (copy && copy.version !== 1 && isBoundPublication(copy.file)));
    return { canonical, recovered, published: Boolean(canonical || verified), unreadable };
  }

  async instanceStopRequested(instanceId: number, transaction?: Transaction) {
    const [row] = await this.database.query<{ stop_requested: number | null }>(
      'SELECT stop_requested FROM CronTriggers WHERE instance_id=$instanceId',
      { transaction, bind: { instanceId }, type: QueryTypes.SELECT });
    return row && Boolean(row.stop_requested);
  }

  async stopVerifiedInstance(instanceId: number, settleLegacy?: (transaction: Transaction) => Promise<boolean>) {
    return this.database.transaction(async transaction => {
      const [row] = await this.database.query<{
        id: string; owner: string | null; command_identity: string | null; reason: string | null;
        state: TriggerState; stop_exit_at: number | null; exit_code: number | null; exit_pending: number | null;
      }>('SELECT id,owner,command_identity,reason,state,stop_exit_at,exit_code,exit_pending FROM CronTriggers WHERE instance_id=$instanceId',
        { transaction, bind: { instanceId }, type: QueryTypes.SELECT });
      await this.database.query('DELETE FROM CronStopRequests WHERE instance_id=$instanceId',
        { transaction, bind: { instanceId } });
      if (!row) return settleLegacy ? settleLegacy(transaction) : false;
      if (row.state !== 'running') return row.state === 'stopped';
      const legacyCrond = row.owner?.startsWith('crond:') && (!row.command_identity || row.owner === row.command_identity);
      // A live scheduler drains its log and reports the actual exit. If the
      // callback already arrived or its owner is gone, settle in this transaction.
      const exit = await this.exitBeforeStop(row.id);
      if (exit.published || exit.unreadable || row.exit_pending || row.stop_exit_at !== null || !row.owner || legacyCrond || row.reason === 'restart') {
        await this.recoverScriptSample(row.id, transaction);
        await this.completeCommandExit(row.id, 'stopped', 'cancelled', row.exit_code, transaction, exit.canonical, row.stop_exit_at ?? undefined, undefined, exit.recovered);
      }
      return true;
    });
  }

  async queueCounts() {
    await this.recoverSystemOwners();
    const [row] = await this.database.query<{ triggers: number; tasks: number }>(
      "SELECT COUNT(*) AS triggers, COUNT(DISTINCT cron_id) AS tasks FROM CronTriggers WHERE state='queued' AND dequeued_at IS NULL",
      { type: QueryTypes.SELECT });
    return row;
  }

  async startSystem(id: string, cronId: number, owner: string, commandIdentity = owner, wrapper?: { rule: string; at: number; dispatch?: number }) {
    // crond only tells us when the wrapper starts. It supplies no scheduled or queued time.
    return this.database.transaction(async (transaction) => {
      const [task] = await this.database.query<{ allow_multiple_instances: number; status: number; pid: number | null; isDisabled: number }>(
        'SELECT allow_multiple_instances, status, pid, isDisabled FROM Crontabs WHERE id=$cronId',
        { bind: { cronId }, type: QueryTypes.SELECT, transaction },
      );
      if (!task || (task.isDisabled && !wrapper?.dispatch)) return false;
      const now = Date.now();
      const inserted = await this.database.query(
        `INSERT INTO CronTriggers(id,cron_id,source,state,owner,command_identity,observed_at,system_rule,system_dispatch_at)
         VALUES ($id,$cronId,'system','queued',$owner,$commandIdentity,$observed,$rule,$dispatch) ON CONFLICT(id) DO NOTHING`,
        { bind: { id, cronId, owner, commandIdentity, observed: wrapper?.at ?? now, rule: wrapper?.rule ?? null, dispatch: wrapper?.dispatch ?? null }, type: QueryTypes.BULKUPDATE, transaction },
      );
      if (!inserted) return false;
      if (task.isDisabled) {
        await this.finish(id, 'skipped', 'changed', null, transaction);
        return false;
      }
      const multiple = task.allow_multiple_instances === 1;
      const claimed = (multiple || !hasLiveCronProcess(task.status, task.pid))
        && await this.start(id, now, multiple, transaction);
      if (claimed && wrapper) await this.database.query('UPDATE CronTriggers SET command_started_at=$now WHERE id=$id',
        { transaction, bind: { id, now } });
      if (claimed && owner.startsWith('crond:')) {
        await this.registerCommandInstance(id, cronId, Number(commandIdentity.split(':')[1]), commandIdentity, now, undefined, transaction);
      }
      if (!claimed) await this.finish(id, 'skipped', 'overlap', null, transaction);
      return claimed;
    });
  }

  async recoverSystemOwners(cronId?: number, transaction?: Transaction, instanceId?: number) {
    // HTTP may restart while crond children keep running. Match process birth, including across reboots.
    const active = await this.database.query<{ id: string; owner: string }>(
      `SELECT id,CASE WHEN owner LIKE 'crond:%' THEN owner ELSE COALESCE(command_identity,process_identity) END AS owner FROM CronTriggers WHERE state='running' AND (owner LIKE 'crond:%' OR reason='restart')
       AND NOT EXISTS (SELECT 1 FROM CronStopRequests s WHERE s.instance_id=CronTriggers.instance_id AND s.targets IS NOT NULL)
       AND ($cronId IS NULL OR cron_id=$cronId) AND ($instanceId IS NULL OR instance_id=$instanceId)`,
      { transaction, bind: { cronId: cronId ?? null, instanceId: instanceId ?? null }, type: QueryTypes.SELECT },
    );
    let reclaimed = false;
    for (const row of active) {
      const pid = Number(row.owner.split(':')[1]);
      try {
        if (systemOwner(pid) === row.owner) continue;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ESRCH') throw error;
      }
      const close = async (tx: Transaction) => {
        const [current] = await this.database.query<{ stop_requested: number; exit_code: number | null; stop_exit_at: number | null }>(
          `SELECT stop_requested,exit_code,stop_exit_at FROM CronTriggers WHERE id=$id AND state='running'
           AND NOT EXISTS (SELECT 1 FROM CronStopRequests s WHERE s.instance_id=CronTriggers.instance_id AND s.targets IS NOT NULL)`,
          { transaction: tx, bind: { id: row.id }, type: QueryTypes.SELECT });
        if (!current) return;
        await this.recoverScriptSample(row.id, tx);
        await this.completeCommandExit(row.id, current.stop_requested ? 'stopped' : 'unknown',
          current.stop_requested ? 'cancelled' : 'restart', current.exit_code, tx, undefined, current.stop_exit_at ?? undefined);
      };
      if (transaction) await close(transaction);
      else await this.database.transaction(close);
      reclaimed = true;
    }
    return reclaimed;
  }

  async interrupt(owner: string) {
    await this.database.transaction(async transaction => {
      await this.replayPublishedExits(transaction);
      if (owner === 'http') await this.database.query(`INSERT OR IGNORE INTO CronStopRequests(instance_id,cron_id,pid)
        SELECT instance_id,cron_id,CAST(substr(process_identity,7) AS INTEGER) FROM CronTriggers
        WHERE state='running' AND stop_requested=1 AND instance_id IS NOT NULL AND process_identity LIKE 'crond:%'`,
        { transaction });
      // No process was bound and its launch gate closed when the worker exited.
      await this.database.query(`UPDATE CronTriggers SET state='stopped',reason='cancelled',started_at=NULL,finished_at=$now
        WHERE owner=$owner AND state='running' AND stop_requested=1 AND instance_id IS NULL AND command_identity IS NULL`,
        { transaction, bind: { owner, now: Date.now() } });
      await this.database.query(`UPDATE CronTriggers SET reason='restart',
        state=CASE WHEN state='queued' THEN 'skipped' WHEN COALESCE(command_identity,process_identity) IS NOT NULL THEN 'running' ELSE 'unknown' END,
        finished_at=CASE WHEN state='running' AND COALESCE(command_identity,process_identity) IS NOT NULL THEN NULL ELSE $now END
        WHERE (owner=$owner OR (source IN ('system','legacy','client') AND owner IS NULL AND $owner='http')) AND state IN ('queued','running')`,
        { transaction, bind: { owner, now: Date.now() } });
      await this.recoverSystemOwners(undefined, transaction);
    });
  }

  async reconcileInstances() {
    await this.database.transaction(async transaction => {
      // Released panels created instance rows before trigger IDs existed. Link
      // their outstanding starts before cleanup so the original CLI can finish.
      const unlinked = await this.database.query<{ cron_id: number; pid: number; log_path: string | null; started_at: number }>(
        `WITH outstanding AS (SELECT DISTINCT cron_id,started_at FROM RunningInstances WHERE status=0)
         SELECT i.cron_id,i.pid,i.log_path,i.started_at FROM outstanding o
         JOIN RunningInstances i ON i.cron_id=o.cron_id AND i.started_at=o.started_at
         JOIN Crontabs c ON c.id=i.cron_id WHERE i.pid>0 AND i.started_at>0
         AND NOT EXISTS (SELECT 1 FROM CronTriggers t WHERE t.instance_id=i.id)
         AND NOT EXISTS (SELECT 1 FROM CronStopRequests s WHERE s.instance_id=i.id)
         ORDER BY i.started_at,i.id`, { transaction, type: QueryTypes.SELECT });
      for (const row of unlinked) {
        await this.applyLegacyReceipt(row.cron_id, true, row.pid, row.log_path || '', row.started_at, 0, transaction);
      }
      // Older versions mapped an unknown exit to error or stopped in instance history.
      await this.database.query(`UPDATE RunningInstances SET status=4,finished_at=COALESCE(finished_at,$now),updatedAt=CURRENT_TIMESTAMP
        WHERE status IN (0,2,3) AND id IN
        (SELECT instance_id FROM CronTriggers WHERE state='unknown' AND instance_id IS NOT NULL)`,
        { transaction, bind: { now: Math.floor(Date.now() / 1000) } });
      // HTTP and gRPC restart independently. Another worker or crond may still own the run.
      await this.database.query(`UPDATE RunningInstances SET status=2,finished_at=$now,updatedAt=CURRENT_TIMESTAMP
        WHERE status=0 AND NOT EXISTS (SELECT 1 FROM CronStopRequests s WHERE s.instance_id=RunningInstances.id)
          AND NOT EXISTS (SELECT 1 FROM CronTriggers t WHERE t.instance_id=RunningInstances.id AND t.state='running')`,
        { transaction, bind: { now: Math.floor(Date.now() / 1000) } });
      await this.database.query(`UPDATE Crontabs SET status=1,pid=NULL,queued_token=NULL
        WHERE status IN (0,3) AND NOT EXISTS (SELECT 1 FROM CronStopRequests s WHERE s.cron_id=Crontabs.id)
          AND NOT EXISTS (SELECT 1 FROM CronTriggers t
          WHERE t.cron_id=Crontabs.id AND t.state IN ('running','queued'))`, { transaction });
    });
  }

  private static expired =
    `state NOT IN ('queued','running') AND exit_pending IS NOT 1 AND finished_at IS NOT NULL AND observed_at < $cutoff AND finished_at < $cutoff
     AND NOT EXISTS (SELECT 1 FROM RunningInstances i WHERE i.id=CronTriggers.instance_id AND i.status=0)`;

  async countExpired(cutoff: number) {
    const [row] = await this.database.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM CronTriggers WHERE ${TriggerHistory.expired}`,
      { bind: { cutoff }, type: QueryTypes.SELECT },
    );
    return row.count;
  }

  async deleteExpired(cutoff: number, transaction: Transaction) {
    // Once both histories have expired, old packets must not recreate their rows.
    await this.database.query(`INSERT INTO CronHistoryRetention(id,cutoff) VALUES (1,$cutoff)
      ON CONFLICT(id) DO UPDATE SET cutoff=MAX(cutoff,excluded.cutoff)`, { transaction, bind: { cutoff } });
    // The visible histories can expire before statistics. Keep just enough to
    // credit a verified receipt to its task without recreating either history.
    await this.database.query(`INSERT OR IGNORE INTO CronPrunedUnknownRuns(trigger_id,cron_id,source,started_at,last_possible_day)
      SELECT id,cron_id,source,started_at,date(finished_at/1000,'unixepoch','localtime') FROM CronTriggers
      WHERE ${TriggerHistory.expired} AND state='unknown' AND reason='restart' AND counted=0 AND owner IS NOT NULL
        AND started_at IS NOT NULL AND EXISTS (SELECT 1 FROM Crontabs WHERE id=CronTriggers.cron_id)
        AND NOT EXISTS (SELECT 1 FROM CronLegacyExitBookings WHERE trigger_id=CronTriggers.id)
        AND NOT EXISTS (SELECT 1 FROM CronStatRetention WHERE first_day>date(finished_at/1000,'unixepoch','localtime'))`,
      { bind: { cutoff }, transaction });
    return this.database.query(
      `DELETE FROM CronTriggers WHERE ${TriggerHistory.expired}`,
      { bind: { cutoff }, transaction, type: QueryTypes.BULKDELETE },
    );
  }

  async visibleTriggers(cronId: number, ids: string[]) {
    return this.database.query<Trigger & { observed_at: number }>(
      `SELECT ${historyColumns} FROM CronTriggers WHERE cron_id=:cronId AND id IN (:ids)`,
      { replacements: { cronId, ids }, type: QueryTypes.SELECT },
    );
  }

  async recent(cronId: number, offset: number, limit = 25, before?: { time: number; id: string }) {
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
    return { ...row, audit: await auditSchedule(this.database, since), systemAudit: await systemScheduleAudit(this.database, since) };
  }
}

export function triggerHistory(): TriggerHistory {
  return new TriggerHistory(require('../data').sequelize);
}

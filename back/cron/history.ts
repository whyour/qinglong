import { LegacyClientAdapter } from './compatibility/legacyClient';
import type { readExit } from './settlement/exitReceipt.cjs';
export { slotId } from './identity';
import type { Crontab } from '../data/cron';
export { systemOwner } from './execution/cronProcess';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import type {
  TriggerSource,
  TriggerState,
  VerifiedSupervisorExit,
} from './types';
import { TriggerLifecycle } from './execution/triggerLifecycle';
import { TriggerSettlement } from './settlement/triggerSettlement';
export type { Trigger, TriggerSource, TriggerState } from './types';
import { TriggerQueries } from './queries/triggerQueries';

export { installTriggerHistory } from './schema';

export class TriggerHistory {
  constructor(private database: Sequelize) {}

  // Compatibility callers share the same lifecycle and settlement transaction paths.
  private readonly settlement: TriggerSettlement = new TriggerSettlement(
    this.database,
    {
      finish: (...args) => this.finish(...args),
      shouldStop: (id, transaction) => this.shouldStop(id, transaction),
    },
  );

  private readonly lifecycle: TriggerLifecycle = new TriggerLifecycle(
    this.database,
    {
      exitBeforeStop: (id) => this.exitBeforeStop(id),
      completeCommandExit: (...args) => this.completeCommandExit(...args),
      recoverScriptSample: (id, transaction) =>
        this.recoverScriptSample(id, transaction),
      replayPublishedExits: (transaction) =>
        this.replayPublishedExits(transaction),
    },
  );

  private readonly clients: LegacyClientAdapter = new LegacyClientAdapter(
    this.database,
    this.lifecycle,
    this.settlement,
  );

  // No command or instance exists before the scheduler claims the trigger.
  // A cancelled or already claimed row must keep the outcome recorded by its owner.
  async skipQueued(id: string, reason: string, finishedAt: number) {
    return this.lifecycle.skipQueued(id, reason, finishedAt);
  }

  async enqueue(
    id: string,
    cronId: number,
    source: TriggerSource,
    scheduledAt: number | null,
    now = Date.now(),
    transaction?: Transaction,
  ) {
    return this.lifecycle.enqueue(
      id,
      cronId,
      source,
      scheduledAt,
      now,
      transaction,
    );
  }

  // Serialize admission with the receipt so simultaneous timers and recovered
  // workers agree on which scheduled run owns the slot. Edits invalidate old waits.
  async enqueueUnlessPending(
    id: string,
    cronId: number,
    source: 'node' | 'recovery',
    scheduledAt: number,
    now: number,
    revision = 0,
  ) {
    return this.lifecycle.enqueueUnlessPending(
      id,
      cronId,
      source,
      scheduledAt,
      now,
      revision,
    );
  }

  async start(
    id: string,
    now = Date.now(),
    multiple = false,
    transaction?: Transaction,
  ) {
    return this.lifecycle.start(id, now, multiple, transaction);
  }

  async claimManual(
    id: string,
    snapshot: Crontab,
    token: string,
    independent: boolean,
  ) {
    return this.lifecycle.claimManual(id, snapshot, token, independent);
  }

  async finish(
    id: string,
    state: TriggerState,
    reason: string | null = null,
    code: number | null = null,
    transaction?: Transaction,
    finishedAt?: number,
  ) {
    return this.lifecycle.finish(
      id,
      state,
      reason,
      code,
      transaction,
      finishedAt,
    );
  }

  // A child close is an independent receipt when either Shell callback is lost.
  async complete(
    id: string,
    state: TriggerState,
    reason: string | null,
    code: number | null,
    finishedAt?: number,
    report?: VerifiedSupervisorExit | 'legacy',
  ) {
    return this.settlement.complete(
      id,
      state,
      reason,
      code,
      finishedAt,
      report,
    );
  }

  private async completeCommandExit(
    id: string,
    state: TriggerState,
    reason: string | null,
    code: number | null,
    transaction: Transaction,
    receipt?: Awaited<ReturnType<typeof readExit>>,
    finishedAt?: number,
    report?: VerifiedSupervisorExit | 'legacy',
    recoveredCopies?: Awaited<ReturnType<typeof readExit>>[],
  ) {
    return this.settlement.completeCommandExit(
      id,
      state,
      reason,
      code,
      transaction,
      receipt,
      finishedAt,
      report,
      recoveredCopies,
    );
  }

  async retryPendingExits() {
    return this.settlement.retryPendingExits();
  }

  async replayPublishedExits(transaction: Transaction) {
    return this.settlement.replayPublishedExits(transaction);
  }

  // Old shell-only executions publish status and statistics independently.
  // Either final receipt can settle that execution if the other was lost.
  async recordShellResult(
    id: string,
    cronId: number,
    code: number,
    elapsedMs: number,
    now: number,
    finishedAt?: number,
  ) {
    return this.clients.recordShellResult(
      id,
      cronId,
      code,
      elapsedMs,
      now,
      finishedAt,
    );
  }

  private async recoverScriptSample(id: string, transaction: Transaction) {
    return this.settlement.recoverScriptSample(id, transaction);
  }

  async isRunning(cronId: number, transaction: Transaction) {
    return this.lifecycle.isRunning(cronId, transaction);
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
    return this.clients.shellReport(
      id,
      cronId,
      system,
      running,
      log,
      seconds,
      exitCode,
      stopped,
      transaction,
      elapsedMs,
      finishedAt,
    );
  }

  async reportLegacy(
    cronId: number,
    running: boolean,
    pid: number,
    log: string,
    seconds: number,
    elapsed: number,
    code?: number,
  ) {
    return this.clients.reportLegacy(
      cronId,
      running,
      pid,
      log,
      seconds,
      elapsed,
      code,
    );
  }

  // Link the Shell instance and its trigger in the same IMMEDIATE write transaction.
  async reportInstance(
    id: string,
    cronId: number,
    running: boolean,
    pid: number,
    log: string,
    seconds: number,
    elapsed: number | undefined,
    code?: number,
    stopped = false,
    finishedAt?: number,
  ) {
    return this.clients.reportInstance(
      id,
      cronId,
      running,
      pid,
      log,
      seconds,
      elapsed,
      code,
      stopped,
      finishedAt,
    );
  }

  async cancelQueued(ids: number[]) {
    return this.lifecycle.cancelQueued(ids);
  }

  async cancelQueuedInTransaction(ids: number[], transaction: Transaction) {
    return this.lifecycle.cancelQueuedInTransaction(ids, transaction);
  }

  async queueInstanceStop(
    instanceId: number,
    cronId: number,
    pid: number,
    transaction?: Transaction,
    identity?: string,
  ) {
    return this.lifecycle.queueInstanceStop(
      instanceId,
      cronId,
      pid,
      transaction,
      identity,
    );
  }

  async pendingStop(instanceId: number, transaction?: Transaction) {
    return this.lifecycle.pendingStop(instanceId, transaction);
  }

  async pendingStopBatches() {
    return this.lifecycle.pendingStopBatches();
  }

  async pendingStops() {
    return this.lifecycle.pendingStops();
  }

  async forgetStop(
    instanceId: number,
    onEnded?: (tx: Transaction) => Promise<void>,
  ) {
    return this.lifecycle.forgetStop(instanceId, onEnded);
  }

  async shouldStop(id: string, transaction?: Transaction) {
    return this.lifecycle.shouldStop(id, transaction);
  }

  // The outer command can outlive any of its task wrappers.
  async recordCommandStart(id: string, at: number) {
    return this.lifecycle.recordCommandStart(id, at);
  }

  async bindCommand(id: string, pid: number, log?: string) {
    return this.lifecycle.bindCommand(id, pid, log);
  }

  async activeCommands(ids: number[], transaction?: Transaction) {
    return this.lifecycle.activeCommands(ids, transaction);
  }

  async instanceIdentity(instanceId: number) {
    return this.lifecycle.instanceIdentity(instanceId);
  }

  async requestInstanceStop(
    instanceId: number,
    pid: number,
    signalTree: () => void | Error,
    targets?: string[],
  ) {
    return this.lifecycle.requestInstanceStop(
      instanceId,
      pid,
      signalTree,
      targets,
    );
  }

  private async exitBeforeStop(id: string) {
    return this.settlement.exitBeforeStop(id);
  }

  async instanceStopRequested(instanceId: number, transaction?: Transaction) {
    return this.lifecycle.instanceStopRequested(instanceId, transaction);
  }

  async stopVerifiedInstance(
    instanceId: number,
    settleLegacy?: (transaction: Transaction) => Promise<boolean>,
  ) {
    return this.lifecycle.stopVerifiedInstance(instanceId, settleLegacy);
  }

  async queueCounts() {
    return this.lifecycle.queueCounts();
  }

  async startSystem(
    id: string,
    cronId: number,
    owner: string,
    commandIdentity = owner,
    wrapper?: { rule: string; at: number; dispatch?: number },
  ) {
    return this.lifecycle.startSystem(
      id,
      cronId,
      owner,
      commandIdentity,
      wrapper,
    );
  }

  async recoverSystemOwners(
    cronId?: number,
    transaction?: Transaction,
    instanceId?: number,
  ) {
    return this.lifecycle.recoverSystemOwners(cronId, transaction, instanceId);
  }

  async interrupt(owner: string) {
    return this.lifecycle.interrupt(owner);
  }

  async reconcileInstances() {
    return this.clients.reconcileInstances();
  }

  private static expired = `state NOT IN ('queued','running') AND exit_pending IS NOT 1 AND finished_at IS NOT NULL AND observed_at < $cutoff AND finished_at < $cutoff
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
    await this.database.query(
      `INSERT INTO CronHistoryRetention(id,cutoff) VALUES (1,$cutoff)
      ON CONFLICT(id) DO UPDATE SET cutoff=MAX(cutoff,excluded.cutoff)`,
      { transaction, bind: { cutoff } },
    );
    // The visible histories can expire before statistics. Keep just enough to
    // credit a verified receipt to its task without recreating either history.
    await this.database.query(
      `INSERT OR IGNORE INTO CronPrunedUnknownRuns(trigger_id,cron_id,source,started_at,last_possible_day)
      SELECT id,cron_id,source,started_at,date(finished_at/1000,'unixepoch','localtime') FROM CronTriggers
      WHERE ${TriggerHistory.expired} AND state='unknown' AND reason='restart' AND counted=0 AND owner IS NOT NULL
        AND started_at IS NOT NULL AND EXISTS (SELECT 1 FROM Crontabs WHERE id=CronTriggers.cron_id)
        AND NOT EXISTS (SELECT 1 FROM CronLegacyExitBookings WHERE trigger_id=CronTriggers.id)
        AND NOT EXISTS (SELECT 1 FROM CronStatRetention WHERE first_day>date(finished_at/1000,'unixepoch','localtime'))`,
      { bind: { cutoff }, transaction },
    );
    return this.database.query(
      `DELETE FROM CronTriggers WHERE ${TriggerHistory.expired}`,
      { bind: { cutoff }, transaction, type: QueryTypes.BULKDELETE },
    );
  }

  // Compatibility entry points for existing scheduler, API and extension callers.
  async visibleTriggers(cronId: number, ids: string[]) {
    return new TriggerQueries(this.database).visibleTriggers(cronId, ids);
  }

  async recent(
    cronId: number,
    offset: number,
    limit = 25,
    before?: { time: number; id: string },
  ) {
    return new TriggerQueries(this.database).recent(
      cronId,
      offset,
      limit,
      before,
    );
  }

  async metrics(since: number) {
    return new TriggerQueries(this.database).metrics(since);
  }
}

export function triggerHistory(): TriggerHistory {
  return new TriggerHistory(require('../data/index').sequelize);
}

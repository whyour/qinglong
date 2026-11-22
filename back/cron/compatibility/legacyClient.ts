import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { createHash } from 'crypto';
import { executionIdPattern } from '../identity';
import {
  isProcessDescendant,
  legacyProcessOwner,
  systemOwner,
} from '../execution/cronProcess';
import type { TriggerSource, TriggerState } from '../types';
import type { TriggerLifecycle } from '../execution/triggerLifecycle';
import type { TriggerSettlement } from '../settlement/triggerSettlement';

export type LegacyClientLifecycle = Pick<TriggerLifecycle, 'claimSummary'>;
export type LegacyClientSettlement = Pick<
  TriggerSettlement,
  | 'recordShellResult'
  | 'hasBoundConflict'
  | 'completeInTransaction'
  | 'readScriptSample'
  | 'saveScriptSample'
  | 'settleInstance'
>;

// Adapt PID-only and identified Shell reports without treating a wrapper exit
// as the managed command's result. Every state/settlement write keeps its transaction.
export class LegacyClientAdapter {
  constructor(
    private database: Sequelize,
    private lifecycle: LegacyClientLifecycle,
    private settlement: LegacyClientSettlement,
  ) {}

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
    return this.settlement.recordShellResult(
      id,
      cronId,
      code,
      elapsedMs,
      now,
      finishedAt,
    );
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
    if (!transaction)
      return this.database.transaction((tx) =>
        this.shellReport(
          id,
          cronId,
          system,
          running,
          log,
          seconds,
          exitCode,
          stopped,
          tx,
          elapsedMs,
          finishedAt,
        ),
      );
    if (await this.settlement.hasBoundConflict(id, transaction)) return false;
    if (system || executionIdPattern.test(id)) {
      // Standalone clients supply neither a scheduled instant nor a queue observation.
      const dated = Number.isSafeInteger(seconds) && seconds > 0;
      const start = dated ? seconds * 1000 : Date.now();
      const standalone =
        executionIdPattern.test(id) || id.startsWith('system-cli-');
      const lastKnownTime =
        standalone &&
        !running &&
        dated &&
        finishedAt &&
        finishedAt >= start &&
        finishedAt <= Date.now()
          ? finishedAt
          : start;
      await this.database.query(
        `INSERT INTO CronTriggers(id,cron_id,source,state,started_at,observed_at)
         SELECT $id,$cronId,$source,'running',$start,$start
         WHERE NOT EXISTS (SELECT 1 FROM CronHistoryRetention WHERE id=1 AND ($dated=0 OR cutoff>$lastKnownTime))
         ON CONFLICT(id) DO NOTHING`,
        {
          transaction,
          bind: {
            id,
            cronId,
            start,
            lastKnownTime,
            dated: Number(dated),
            source: system ? 'system' : 'client',
          },
        },
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
        { transaction, type: QueryTypes.SELECT, bind: { id, cronId } },
      );
      if (legacy) {
        const state = stopped
          ? 'stopped'
          : exitCode == null
          ? 'unknown'
          : exitCode === 0
          ? 'finished'
          : 'failed';
        await this.settlement.completeInTransaction(
          id,
          state,
          null,
          exitCode ?? null,
          transaction,
          elapsedMs,
          finishedAt,
        );
      }
    }
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
    return this.database.transaction((transaction) =>
      this.applyLegacyReceipt(
        cronId,
        running,
        pid,
        log,
        seconds,
        elapsed,
        transaction,
        code,
      ),
    );
  }

  private async applyLegacyReceipt(
    cronId: number,
    running: boolean,
    pid: number,
    log: string,
    seconds: number,
    elapsed: number,
    transaction: Transaction,
    code?: number,
  ) {
    const start = seconds * 1000;
    const receipt =
      'legacy-' +
      createHash('sha256')
        .update(JSON.stringify([cronId, pid, seconds, log || null]))
        .digest('hex');
    // A verified child stays attached to its supervisor even after the OS recycles its PID.
    const [bound] = await this.database.query(
      'SELECT 1 FROM CronShellBindings WHERE receipt=$receipt',
      { transaction, type: QueryTypes.SELECT, bind: { receipt } },
    );
    if (bound) return;

    const rows = await this.database.query<{
      instance: number;
      status: number;
      finished_at: number | null;
      exit_code: number | null;
      id: string | null;
      source: TriggerSource | null;
      log_path: string | null;
    }>(
      `SELECT i.id AS instance,i.status,i.finished_at,i.exit_code,i.log_path,t.id,t.source FROM RunningInstances i
       LEFT JOIN CronTriggers t ON t.instance_id=i.id WHERE i.cron_id=$cronId AND i.pid=$pid
       AND (t.id IS NULL OR t.source='legacy' OR t.owner IS NOT NULL)
       AND i.started_at=$seconds AND (i.log_path IS $log OR $log IS NULL OR i.log_path IS NULL) LIMIT 2`,
      {
        transaction,
        type: QueryTypes.SELECT,
        bind: { cronId, pid, seconds, log: log || null },
      },
    );
    const [old] = rows;
    if (rows.length > 1) return;
    if (old) {
      if (!old.id && old.status === 4) {
        const [expired] = await this.database.query(
          'SELECT 1 FROM CronHistoryRetention WHERE cutoff>$end',
          {
            transaction,
            type: QueryTypes.SELECT,
            bind: { end: (old.finished_at ?? seconds) * 1000 },
          },
        );
        if (expired) return;
      }
      if (old.status !== 0 && old.status !== 4) {
        if (!old.id && old.finished_at != null) {
          // The old panel owned the daily aggregate. Import its committed result
          // without replaying an anonymous statistics increment.
          const state =
            old.status === 1
              ? 'finished'
              : old.status === 2
              ? 'stopped'
              : 'failed';
          const inserted = await this.database.query(
            `INSERT INTO CronTriggers
            (id,cron_id,source,state,observed_at,started_at,finished_at,instance_id,log_path,exit_code,counted)
            SELECT $id,$cronId,'legacy',$state,$start,$start,$end,$instance,$log,$exit,1
            WHERE $end >= $start AND $end>=COALESCE((SELECT cutoff FROM CronHistoryRetention WHERE id=1),0)
              AND NOT EXISTS (SELECT 1 FROM RunningInstances sibling
                LEFT JOIN CronTriggers linked ON linked.instance_id=sibling.id
                WHERE sibling.cron_id=$cronId
                AND sibling.pid=$pid AND sibling.finished_at=$end/1000 AND sibling.id<>$instance
                AND sibling.status IN (1,3) AND (linked.id IS NULL OR (linked.source='legacy' AND linked.owner IS NULL)))
            ON CONFLICT DO NOTHING`,
            {
              transaction,
              type: QueryTypes.BULKUPDATE,
              bind: {
                id: receipt,
                cronId,
                pid,
                state,
                start,
                end: old.finished_at * 1000,
                instance: old.instance,
                log: old.log_path,
                exit: old.exit_code,
              },
            },
          );
          if (inserted)
            await this.lifecycle.claimSummary(
              cronId,
              old.instance,
              seconds,
              transaction,
              true,
              Math.max(0, old.finished_at - seconds),
            );
        }
        return;
      }
      if (running && (old.id || old.status === 4)) return;
      if (old.id && old.source !== 'legacy') return;
    }

    let identity: string | undefined;
    if (!old) {
      const [prior] = await this.database.query(
        'SELECT 1 FROM CronTriggers WHERE id=$receipt UNION ALL SELECT 1 FROM CronHistoryRetention WHERE cutoff>$start',
        { transaction, type: QueryTypes.SELECT, bind: { receipt, start } },
      );
      if (prior) return;
      identity = legacyProcessOwner(pid, seconds);
      const roots = await this.database.query<{
        id: string;
        command_identity: string;
      }>(
        `SELECT id,command_identity FROM CronTriggers WHERE cron_id=$cronId AND state='running'
         AND command_identity IS NOT NULL AND started_at < $end`,
        {
          transaction,
          type: QueryTypes.SELECT,
          bind: { cronId, end: start + 1000 },
        },
      );
      for (const root of roots) {
        if (!identity) break;
        const parent = Number(root.command_identity.split(':')[1]);
        try {
          if (
            !isProcessDescendant(pid, parent) ||
            systemOwner(parent) !== root.command_identity
          )
            continue;
        } catch (error) {
          if (
            ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code!)
          )
            continue;
          throw error;
        }
        await this.database.query(
          'INSERT INTO CronShellBindings(receipt,trigger_id) VALUES ($receipt,$id)',
          { transaction, bind: { receipt, id: root.id } },
        );
        if (running)
          await this.attachShellLog(root.id, cronId, log, transaction);
        return;
      }
    }

    const id = old?.id ?? receipt;
    if (!old?.id) {
      // A later use of the same numeric PID proves the older process is gone.
      const others = await this.database.query<{
        id: string;
        started_at: number;
      }>(
        `SELECT t.id,i.started_at FROM RunningInstances i LEFT JOIN CronTriggers t ON t.instance_id=i.id
         WHERE i.cron_id=$cronId AND i.pid=$pid AND i.started_at<>$seconds
         AND (i.started_at>$seconds OR (i.status=0 AND t.source='legacy'))`,
        {
          transaction,
          type: QueryTypes.SELECT,
          bind: { cronId, pid, seconds },
        },
      );
      if (running && old) identity = legacyProcessOwner(pid, seconds);
      const historical =
        !running ||
        !identity ||
        others.some((other) => other.started_at > seconds);

      let instance = old?.instance;
      if (!instance) {
        [instance] = await this.database.query(
          `INSERT INTO RunningInstances(cron_id,pid,log_path,started_at,status,finished_at,createdAt,updatedAt)
           VALUES ($cronId,$pid,$log,$seconds,$status,$finished,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          {
            transaction,
            type: QueryTypes.INSERT,
            bind: {
              cronId,
              pid,
              log: log || null,
              seconds,
              status: historical ? 4 : 0,
              finished: historical ? Math.floor(Date.now() / 1000) : null,
            },
          },
        );
      }
      const unknown = historical || old?.status === 4;
      await this.database.query(
        `INSERT INTO CronTriggers
        (id,cron_id,source,state,observed_at,started_at,finished_at,instance_id,log_path,process_identity,reason)
        VALUES ($id,$cronId,'legacy',$state,$start,$start,$end,$instance,$log,$identity,$reason)`,
        {
          transaction,
          bind: {
            id,
            cronId,
            start,
            instance,
            log: old?.log_path ?? (log || null),
            identity: !unknown && running ? identity ?? null : null,
            reason: old && running && !unknown ? 'restart' : null,
            state: unknown ? 'unknown' : 'running',
            end: unknown
              ? old?.finished_at
                ? old.finished_at * 1000
                : Date.now()
              : null,
          },
        },
      );
      await this.lifecycle.claimSummary(
        cronId,
        instance!,
        seconds,
        transaction,
        old?.status === 0 || (running && !unknown),
      );
      for (const other of others) {
        if (other.started_at < seconds)
          await this.settlement.completeInTransaction(
            other.id,
            'unknown',
            null,
            null,
            transaction,
          );
      }
      if (running && !unknown)
        await this.database.query(
          `UPDATE Crontabs SET status=0,pid=$pid,log_path=$log
         WHERE id=$cronId AND status IS NOT 3 AND $instance=(
           SELECT id FROM RunningInstances WHERE cron_id=$cronId AND status=0 ORDER BY id DESC LIMIT 1)`,
          { transaction, bind: { cronId, pid, log: log || null, instance } },
        );
      if (unknown && old?.status === 0 && running)
        await this.settlement.settleInstance(id, transaction);
    }
    if (!running) {
      const state =
        code == null ? 'unknown' : code === 0 ? 'finished' : 'failed';
      await this.settlement.completeInTransaction(
        id,
        state,
        null,
        code ?? null,
        transaction,
        Math.max(0, elapsed) * 1000,
      );
    }
  }

  private async attachShellLog(
    id: string,
    cronId: number,
    log: string,
    transaction: Transaction,
  ) {
    const attached = await this.database.query(
      `UPDATE RunningInstances SET log_path=$log WHERE status=0 AND log_path IS NULL
      AND id=(SELECT instance_id FROM CronTriggers WHERE id=$id AND cron_id=$cronId AND state='running')`,
      { transaction, type: QueryTypes.BULKUPDATE, bind: { id, cronId, log } },
    );
    if (attached) {
      await this.database.query(
        'UPDATE CronTriggers SET log_path=COALESCE(log_path,$log) WHERE id=$id',
        { transaction, bind: { id, log } },
      );
      await this.database.query(
        `UPDATE Crontabs SET log_path=$log WHERE id=$cronId AND status=0 AND pid=(
        SELECT i.pid FROM RunningInstances i JOIN CronTriggers t ON t.instance_id=i.id WHERE t.id=$id)`,
        { transaction, bind: { id, cronId, log } },
      );
    }
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
    const sample = running
      ? undefined
      : await this.settlement.readScriptSample(id);
    await this.database.transaction(async (transaction) => {
      const accepted = await this.shellReport(
        id,
        cronId,
        id.startsWith('system-'),
        running,
        log,
        seconds,
        code,
        stopped,
        transaction,
        elapsed == null ? undefined : elapsed * 1000,
        finishedAt,
      );
      if (accepted === false) return;
      const [row] = await this.database.query<{
        state: TriggerState;
        started_at: number | null;
        instance_id: number | null;
        command_identity: string | null;
        owner: string | null;
      }>(
        'SELECT state,started_at,instance_id,command_identity,owner FROM CronTriggers WHERE id=$id AND cron_id=$cronId',
        { transaction, bind: { id, cronId }, type: QueryTypes.SELECT },
      );
      if (!row) return;
      const startSeconds =
        seconds > 0
          ? seconds
          : Math.floor((row.started_at ?? Date.now()) / 1000);
      if (
        ['finished', 'failed', 'stopped', 'unknown'].includes(row.state) &&
        row.owner === null &&
        row.instance_id === null
      ) {
        // The CLI exit can commit before its first start. Link a terminal history
        // row directly without ever publishing this PID as the current instance.
        const [instance] = await this.database.query(
          `INSERT INTO RunningInstances
          (cron_id,pid,log_path,started_at,finished_at,status,exit_code,createdAt,updatedAt)
          SELECT cron_id,$pid,log_path,CAST(started_at/1000 AS INTEGER),CAST(finished_at/1000 AS INTEGER),
            CASE state WHEN 'finished' THEN 1 WHEN 'stopped' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
            exit_code,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM CronTriggers
          WHERE id=$id AND state IN ('finished','failed','stopped','unknown')`,
          {
            transaction,
            type: QueryTypes.INSERT,
            bind: { id, pid: pid || null },
          },
        );
        if (instance) {
          await this.database.query(
            'UPDATE CronTriggers SET instance_id=$instance WHERE id=$id',
            { transaction, bind: { instance, id } },
          );
          await this.lifecycle.claimSummary(
            cronId,
            instance,
            startSeconds,
            transaction,
            false,
            row.state === 'unknown' ? null : elapsed ?? null,
          );
        }
        return;
      }
      if (running && row.state !== 'running') return;
      if (running && row.instance_id === null) {
        let identity = row.command_identity;
        if (identity?.startsWith('crond:')) {
          pid = Number(identity.split(':')[1]);
        } else if (pid) {
          try {
            identity = systemOwner(pid);
          } catch {
            /* A short child may have exited. */
          }
        }
        const [instance] = await this.database.query(
          `INSERT INTO RunningInstances(cron_id,pid,log_path,started_at,status,createdAt,updatedAt)
           VALUES ($cronId,$pid,$log,$seconds,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          {
            transaction,
            type: QueryTypes.INSERT,
            bind: { cronId, pid, log, seconds: startSeconds },
          },
        );
        await this.database.query(
          'UPDATE CronTriggers SET instance_id=$instance,process_identity=$identity WHERE id=$id',
          { transaction, bind: { instance, identity, id } },
        );
        await this.lifecycle.claimSummary(
          cronId,
          instance,
          startSeconds,
          transaction,
          true,
        );
        await this.database.query(
          `UPDATE Crontabs SET status=0,pid=$pid,log_path=$log
          WHERE id=$cronId AND (status IS NOT 3 OR queued_token || '-' || id=$id)`,
          { transaction, bind: { cronId, id, pid, log } },
        );
      }
      if (running && row.instance_id !== null) {
        await this.attachShellLog(id, cronId, log, transaction);
      }
      if (!running)
        await this.settlement.saveScriptSample(id, sample, transaction);
    });
  }

  async reconcileInstances() {
    await this.database.transaction(async (transaction) => {
      // Released panels created instance rows before trigger IDs existed. Link
      // their outstanding starts before cleanup so the original CLI can finish.
      const unlinked = await this.database.query<{
        cron_id: number;
        pid: number;
        log_path: string | null;
        started_at: number;
      }>(
        `WITH outstanding AS (SELECT DISTINCT cron_id,started_at FROM RunningInstances WHERE status=0)
         SELECT i.cron_id,i.pid,i.log_path,i.started_at FROM outstanding o
         JOIN RunningInstances i ON i.cron_id=o.cron_id AND i.started_at=o.started_at
         JOIN Crontabs c ON c.id=i.cron_id WHERE i.pid>0 AND i.started_at>0
         AND NOT EXISTS (SELECT 1 FROM CronTriggers t WHERE t.instance_id=i.id)
         AND NOT EXISTS (SELECT 1 FROM CronStopRequests s WHERE s.instance_id=i.id)
         ORDER BY i.started_at,i.id`,
        { transaction, type: QueryTypes.SELECT },
      );
      for (const row of unlinked) {
        await this.applyLegacyReceipt(
          row.cron_id,
          true,
          row.pid,
          row.log_path || '',
          row.started_at,
          0,
          transaction,
        );
      }
      // Older versions mapped an unknown exit to error or stopped in instance history.
      await this.database.query(
        `UPDATE RunningInstances SET status=4,finished_at=COALESCE(finished_at,$now),updatedAt=CURRENT_TIMESTAMP
        WHERE status IN (0,2,3) AND id IN
        (SELECT instance_id FROM CronTriggers WHERE state='unknown' AND instance_id IS NOT NULL)`,
        { transaction, bind: { now: Math.floor(Date.now() / 1000) } },
      );
      // HTTP and gRPC restart independently. Another worker or crond may still own the run.
      await this.database.query(
        `UPDATE RunningInstances SET status=2,finished_at=$now,updatedAt=CURRENT_TIMESTAMP
        WHERE status=0 AND NOT EXISTS (SELECT 1 FROM CronStopRequests s WHERE s.instance_id=RunningInstances.id)
          AND NOT EXISTS (SELECT 1 FROM CronTriggers t WHERE t.instance_id=RunningInstances.id AND t.state='running')`,
        { transaction, bind: { now: Math.floor(Date.now() / 1000) } },
      );
      await this.database.query(
        `UPDATE Crontabs SET status=1,pid=NULL,queued_token=NULL
        WHERE status IN (0,3) AND NOT EXISTS (SELECT 1 FROM CronStopRequests s WHERE s.cron_id=Crontabs.id)
          AND NOT EXISTS (SELECT 1 FROM CronTriggers t
          WHERE t.cron_id=Crontabs.id AND t.state IN ('running','queued'))`,
        { transaction },
      );
    });
  }
}

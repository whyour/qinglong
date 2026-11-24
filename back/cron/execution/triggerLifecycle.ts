import { Op, QueryTypes, Sequelize, Transaction, col, fn } from 'sequelize';
import type { Crontab } from '../../data/cron';
import {
  executionAssociation,
  executionModel,
} from '../../data/executionModels';
import type { readExit } from '../settlement/exitReceipt.cjs';
import type {
  TriggerSource,
  TriggerState,
  VerifiedSupervisorExit,
} from '../types';
import {
  hasLiveCronProcess,
  pidNamespaceOwner,
  systemOwner,
} from './cronProcess';

type ExitReceipt = Awaited<ReturnType<typeof readExit>>;

// Evidence inspection and settlement remain in the existing ledger. Callers must
// use the supplied transaction so state, stop claims and statistics commit together.
export interface TriggerLifecycleEvidence {
  exitBeforeStop(id: string): Promise<{
    canonical: ExitReceipt;
    recovered: ExitReceipt[];
    published: boolean;
    unreadable: boolean;
  }>;
  completeCommandExit(
    id: string,
    state: TriggerState,
    reason: string | null,
    code: number | null,
    transaction: Transaction,
    receipt?: ExitReceipt,
    finishedAt?: number,
    report?: VerifiedSupervisorExit | 'legacy',
    recoveredCopies?: ExitReceipt[],
  ): Promise<void>;
  recoverScriptSample(id: string, transaction: Transaction): Promise<void>;
  replayPublishedExits(transaction: Transaction): Promise<void>;
}

// Launch/command binding uses bound SQL to keep write transactions short.
// Preserve the state predicates and caller transaction when changing a query.
// Persisted transitions shared by manual, Node and system-crond executions.
// In particular, recovery may reclaim an unstarted slot, never an unknown result.
export class TriggerLifecycle {
  constructor(
    private database: Sequelize,
    private evidence: TriggerLifecycleEvidence,
  ) {}

  // Only unclaimed scheduler work can expire; its owner controls claimed runs.
  async skipQueued(id: string, reason: string, finishedAt: number) {
    await executionModel(this.database, 'CronTriggers')
      .update(
        { state: 'skipped', reason, finished_at: finishedAt },
        {
          where: {
            id,
            source: { [Op.in]: ['node', 'recovery'] },
            state: 'queued',
            started_at: null,
          },
          silent: true,
          hooks: false,
          validate: false,
        },
      )
      .then(([changed]) => changed);
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
         source=excluded.source, owner=excluded.owner, resume_pending=NULL
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

  // Admission and competing pending runs share one write transaction.
  async enqueueUnlessPending(
    id: string,
    cronId: number,
    source: 'node' | 'recovery',
    scheduledAt: number,
    now: number,
    revision = 0,
  ) {
    return this.database.transaction(async (transaction) => {
      if (
        !(await this.enqueue(id, cronId, source, scheduledAt, now, transaction))
      )
        return false;
      await this.recoverSystemOwners(cronId, transaction);
      const pending = await executionModel(
        this.database,
        'CronTriggers',
      ).findAll({
        attributes: ['id'],
        where: {
          cron_id: cronId,
          id: { [Op.ne]: id },
          source: { [Op.in]: ['node', 'recovery', 'system'] },
          [Op.or]: [
            { state: 'running' },
            { state: 'queued', queued_at: { [Op.gte]: revision } },
          ],
        },
        limit: 1,
        transaction,
        raw: true,
      });
      if (!pending.length) return true;
      await this.finish(id, 'skipped', 'pending', null, transaction);
      return false;
    });
  }

  async start(
    id: string,
    now = Date.now(),
    multiple = false,
    transaction?: Transaction,
  ) {
    const claim = () =>
      this.database.query(
        `UPDATE CronTriggers SET state='running', started_at=$now WHERE id=$id AND state='queued'
       AND ($multiple OR NOT EXISTS (SELECT 1 FROM CronTriggers AS active
         WHERE active.cron_id=CronTriggers.cron_id AND active.state='running'))`,
        {
          transaction,
          bind: { id, now, multiple: Number(multiple) },
          type: QueryTypes.BULKUPDATE,
        },
      );
    let changed = await claim();
    if (!changed && !multiple && !transaction) {
      const [task] = await executionModel(
        this.database,
        'CronTriggers',
      ).findAll({
        attributes: ['cron_id'],
        where: { id, state: 'queued' },
        raw: true,
      });
      if (task && (await this.recoverSystemOwners(task.cron_id)))
        changed = await claim();
    }
    return changed === 1;
  }

  async claimManual(
    id: string,
    snapshot: Crontab,
    token: string,
    independent: boolean,
  ) {
    return this.database.transaction(async (transaction) => {
      // The write transaction orders a configuration save and a manual claim.
      const rows = await this.database.query(
        `SELECT 1 FROM Crontabs WHERE id=$cronId AND recovery_from IS $revision
         AND command=$command AND COALESCE(isDisabled,0)=$disabled
         AND COALESCE(allow_multiple_instances,0)=$multiple
         AND ($independent OR (status=3 AND queued_token=$token))`,
        {
          transaction,
          type: QueryTypes.SELECT,
          bind: {
            cronId: snapshot.id,
            revision: snapshot.recovery_from ?? null,
            command: snapshot.command,
            disabled: snapshot.isDisabled || 0,
            multiple: snapshot.allow_multiple_instances || 0,
            independent: Number(independent),
            token,
          },
        },
      );
      if (!rows.length) return 'changed';
      if (!independent)
        await this.recoverSystemOwners(snapshot.id, transaction);
      return (await this.start(id, Date.now(), independent, transaction))
        ? 'started'
        : 'overlap';
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
      {
        transaction,
        type: QueryTypes.BULKUPDATE,
        bind: {
          id,
          state,
          reason,
          code,
          finishedAt: finishedAt ?? null,
          now: Date.now(),
        },
      },
    );
  }

  async claimSummary(
    cronId: number,
    instance: number,
    seconds: number,
    transaction: Transaction,
    observedStart: boolean,
    duration: number | null = null,
  ) {
    await this.database.query(
      `UPDATE Crontabs SET last_instance_id=$instance,
      last_execution_time=$seconds,last_running_time=$duration WHERE id=$cronId AND
      (last_execution_time IS NULL OR last_execution_time<$seconds OR
       (last_execution_time=$seconds AND (last_instance_id IS NULL OR
         ($observedStart AND last_instance_id<$instance))))`,
      {
        transaction,
        bind: {
          cronId,
          instance,
          seconds,
          duration,
          observedStart: Number(observedStart),
        },
      },
    );
  }

  async isRunning(cronId: number, transaction: Transaction) {
    await this.recoverSystemOwners(cronId, transaction);
    const rows = await this.database.query(
      "SELECT 1 FROM CronTriggers WHERE cron_id=$cronId AND state='running' LIMIT 1",
      { bind: { cronId }, transaction, type: QueryTypes.SELECT },
    );
    return rows.length !== 0;
  }

  async cancelQueued(ids: number[]) {
    if (!ids.length) return [];
    return this.database.transaction((tx) =>
      this.cancelQueuedInTransaction(ids, tx),
    );
  }

  async cancelQueuedInTransaction(ids: number[], transaction: Transaction) {
    await executionModel(this.database, 'CronTriggers').update(
      { stop_requested: 1 },
      {
        where: {
          cron_id: { [Op.in]: ids },
          state: 'running',
          command_identity: null,
          instance_id: null,
        },
        transaction,
        silent: true,
        hooks: false,
        validate: false,
      },
    );
    const rows = await executionModel(this.database, 'CronTriggers').findAll({
      attributes: ['id'],
      where: {
        cron_id: { [Op.in]: ids },
        [Op.or]: [
          { state: 'queued' },
          {
            state: 'skipped',
            reason: 'restart',
            resume_pending: 1,
            started_at: null,
          },
        ],
      },
      transaction,
      raw: true,
    });
    await executionModel(this.database, 'CronTriggers').update(
      {
        state: 'stopped',
        reason: 'cancelled',
        finished_at: Date.now(),
        resume_pending: null,
      },
      {
        where: {
          cron_id: { [Op.in]: ids },
          [Op.or]: [
            { state: 'queued' },
            {
              state: 'skipped',
              reason: 'restart',
              resume_pending: 1,
              started_at: null,
            },
          ],
        },
        transaction,
        silent: true,
        hooks: false,
        validate: false,
      },
    );
    return rows.map((r) => r.id);
  }

  async queueInstanceStop(
    instanceId: number,
    cronId: number,
    pid: number,
    transaction?: Transaction,
    identity?: string,
  ) {
    await this.database.query(
      `INSERT INTO CronStopRequests(instance_id,cron_id,pid,root_identity,namespace_owner)
      VALUES ($instanceId,$cronId,$pid,$identity,$namespace)
      ON CONFLICT(instance_id) DO UPDATE SET root_identity=excluded.root_identity
      WHERE root_identity IS NULL AND excluded.root_identity IS NOT NULL AND pid=excluded.pid AND signalled=0`,
      {
        transaction,
        bind: {
          instanceId,
          cronId,
          pid,
          identity: identity ?? null,
          namespace: pidNamespaceOwner(),
        },
      },
    );
  }

  async pendingStop(instanceId: number, transaction?: Transaction) {
    const [row] = await executionModel(
      this.database,
      'CronStopRequests',
    ).findAll({
      attributes: [
        'targets',
        'signalled',
        'signalled_at',
        'root_identity',
        'namespace_owner',
      ],
      where: { instance_id: instanceId },
      transaction,
      raw: true,
    });
    return row;
  }

  async pendingStopBatches() {
    return executionModel(this.database, 'CronStopBatches').findAll({
      attributes: ['request_id', 'cron_ids'],
      where: { snapshot: { [Op.not]: null } },
      raw: true,
    });
  }

  async pendingStops() {
    return executionModel(this.database, 'CronStopRequests').findAll({
      attributes: ['instance_id', 'cron_id', 'pid', 'targets'],
      order: [['instance_id', 'ASC']],
      raw: true,
    });
  }

  async forgetStop(
    instanceId: number,
    onEnded?: (tx: Transaction) => Promise<void>,
  ) {
    return this.database.transaction(async (transaction) => {
      await executionModel(this.database, 'CronStopRequests').destroy({
        where: { instance_id: instanceId, signalled: 0 },
        transaction,
        hooks: false,
      });
      const claimed = await this.pendingStop(instanceId, transaction);
      if (!claimed && onEnded) await onEnded(transaction);
      return claimed;
    });
  }

  async shouldStop(id: string, transaction?: Transaction) {
    const rows = await this.database.query(
      'SELECT 1 FROM CronTriggers WHERE id=$id AND stop_requested=1',
      { transaction, bind: { id }, type: QueryTypes.SELECT },
    );
    return rows.length > 0;
  }

  // The outer command can outlive any of its task wrappers.
  async recordCommandStart(id: string, at: number) {
    await executionModel(this.database, 'CronTriggers').update(
      { command_started_at: at },
      {
        where: { id, command_started_at: null, started_at: { [Op.not]: null } },
        silent: true,
        hooks: false,
        validate: false,
      },
    );
  }

  async bindCommand(id: string, pid: number, log?: string) {
    let identity: string;
    try {
      identity = systemOwner(pid);
    } catch (error) {
      if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code!))
        return false;
      throw error;
    }
    return this.database.transaction(async (transaction) => {
      const [row] = await this.database.query<{
        instance_id: number | null;
        cron_id: number;
        started_at: number;
      }>(
        "SELECT instance_id,cron_id,started_at FROM CronTriggers WHERE id=$id AND state='running'",
        { transaction, bind: { id }, type: QueryTypes.SELECT },
      );
      if (!row) return false;
      await this.database.query(
        'UPDATE CronConcurrencyLeases SET command_identity=$identity WHERE trigger_id=$id',
        { transaction, bind: { identity, id } },
      );
      await this.database.query(
        'UPDATE CronTriggers SET command_identity=$identity WHERE id=$id',
        { transaction, bind: { identity, id } },
      );
      if (row.instance_id) {
        await this.database.query(
          'UPDATE RunningInstances SET pid=$pid WHERE id=$instance AND status=0',
          { transaction, bind: { pid, instance: row.instance_id } },
        );
        await this.database.query(
          'UPDATE CronTriggers SET process_identity=$identity WHERE id=$id',
          { transaction, bind: { identity, id } },
        );
        await this.database.query(
          'UPDATE Crontabs SET pid=$pid WHERE id=$cronId AND log_path=(SELECT log_path FROM CronTriggers WHERE id=$id) AND status=0',
          { transaction, bind: { pid, cronId: row.cron_id, id } },
        );
      } else {
        await this.registerCommandInstance(
          id,
          row.cron_id,
          pid,
          identity,
          row.started_at,
          log,
          transaction,
        );
      }
      return true;
    });
  }

  private async registerCommandInstance(
    id: string,
    cronId: number,
    pid: number,
    identity: string,
    started: number,
    log: string | undefined,
    transaction: Transaction,
  ) {
    const seconds = Math.floor(started / 1000);
    const [instance] = await this.database.query(
      `INSERT INTO RunningInstances(cron_id,pid,log_path,started_at,status,createdAt,updatedAt)
       VALUES ($cronId,$pid,$log,$seconds,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      {
        transaction,
        type: QueryTypes.INSERT,
        bind: { cronId, pid, log: log ?? null, seconds },
      },
    );
    await this.database.query(
      'UPDATE CronTriggers SET log_path=$log,instance_id=$instance,process_identity=$identity WHERE id=$id',
      { transaction, bind: { id, log: log ?? null, instance, identity } },
    );
    await this.claimSummary(cronId, instance, seconds, transaction, true);
    if (log === undefined)
      await this.database.query(
        'UPDATE Crontabs SET status=0,pid=$pid,log_path=NULL WHERE id=$cronId AND status IS NOT 3',
        { transaction, bind: { cronId, pid } },
      );
  }

  async activeCommands(ids: number[], transaction?: Transaction) {
    if (!ids.length) return [];
    return executionModel(this.database, 'CronTriggers').findAll({
      attributes: [
        'id',
        'cron_id',
        'command_identity',
        'started_at',
        'log_path',
      ],
      where: {
        cron_id: { [Op.in]: ids },
        state: 'running',
        instance_id: null,
        command_identity: { [Op.not]: null },
      },
      transaction,
      raw: true,
    });
  }

  async instanceIdentity(instanceId: number) {
    const [row] = await executionModel(this.database, 'CronTriggers').findAll({
      attributes: ['process_identity'],
      where: { instance_id: instanceId },
      raw: true,
    });
    return row?.process_identity;
  }

  async requestInstanceStop(
    instanceId: number,
    pid: number,
    signalTree: () => void | Error,
    targets?: string[],
  ) {
    // Commit the verified tree BEFORE the first signal. If this worker dies even
    // inside the following transaction, its replacement still has the original PIDs.
    if (targets)
      await this.database.query(
        `INSERT INTO CronStopRequests(instance_id,cron_id,pid,targets)
      SELECT i.id,i.cron_id,i.pid,$targets FROM RunningInstances i WHERE i.id=$instanceId AND i.pid=$pid AND i.status=0
      ON CONFLICT(instance_id) DO UPDATE SET targets=(
        SELECT json_group_array(value) FROM (SELECT value FROM json_each(CronStopRequests.targets)
          UNION SELECT value FROM json_each(excluded.targets))) WHERE CronStopRequests.signalled=0`,
        { bind: { instanceId, pid, targets: JSON.stringify(targets) } },
      );
    const result = await this.database.transaction(
      { type: Transaction.TYPES.IMMEDIATE },
      async (transaction) => {
        const [row] = (await executionModel(
          this.database,
          'RunningInstances',
        ).findAll({
          attributes: [
            [col('trigger.id'), 'id'],
            'pid',
            'status',
            [col('trigger.state'), 'state'],
            [col('trigger.stop_requested'), 'stop_requested'],
          ],
          where: { id: instanceId },
          include: [
            {
              association: executionAssociation(
                this.database,
                'instanceTrigger',
              ),
              attributes: [],
              required: false,
            },
          ],
          transaction,
          raw: true,
        })) as unknown as Array<{
          id: string | null;
          pid: number;
          status: number;
          state: string | null;
          stop_requested: number | null;
        }>;
        if (
          !row ||
          row.status !== 0 ||
          (row.state && row.state !== 'running')
        ) {
          throw Object.assign(new Error('Instance already ended'), {
            code: 'ESRCH',
          });
        }
        if (row.pid !== pid)
          throw Object.assign(new Error('Instance process changed'), {
            status: 409,
          });
        if (row.stop_requested && !targets) return;
        const existing = await this.pendingStop(instanceId, transaction);
        const savedTargets: string[] = existing?.targets
          ? JSON.parse(existing.targets)
          : [];
        if (existing?.signalled)
          return { targets: savedTargets, signalledAt: existing.signalled_at };
        // The supervisor can still be draining output after the command has exited.
        if (row.id) {
          const exit = await this.evidence.exitBeforeStop(row.id);
          // An I/O error alone cannot prove a live process has already exited.
          if (!exit.published && exit.unreadable)
            throw Object.assign(
              new Error('Cannot verify command exit. Retry the stop request.'),
              { status: 503 },
            );
          if (exit.published) {
            await this.evidence.completeCommandExit(
              row.id,
              'unknown',
              null,
              null,
              transaction,
              exit.canonical,
              undefined,
              undefined,
              exit.recovered,
            );
            return { ended: true };
          }
        }
        if (targets && !existing?.targets) {
          // Another worker released the prepared tree. Retry from a durable
          // snapshot before issuing an irreversible signal.
          throw Object.assign(
            new Error('Stop target snapshot changed. Retry the stop request.'),
            { status: 503 },
          );
        }
        const signalledAt = Date.now();
        await executionModel(this.database, 'CronStopRequests').update(
          { signalled: 1, signalled_at: signalledAt },
          {
            where: { instance_id: instanceId },
            transaction,
            silent: true,
            hooks: false,
            validate: false,
          },
        );
        if (row.state)
          await executionModel(this.database, 'CronTriggers').update(
            { stop_requested: 1 },
            {
              where: { instance_id: instanceId, state: 'running' },
              transaction,
              silent: true,
              hooks: false,
              validate: false,
            },
          );
        // Root delivery failure rolls back. After successful root delivery, retain
        // the stop marker even if some descendants still need recovery.
        const error = signalTree();
        return { targets: savedTargets, signalledAt, error };
      },
    );
    if (result && 'ended' in result)
      throw Object.assign(new Error('Instance already ended'), {
        code: 'ESRCH',
      });
    if (result && 'error' in result && result.error instanceof Error)
      throw result.error;
    if (targets && result)
      return { targets: result.targets, signalledAt: result.signalledAt };
  }

  async instanceStopRequested(instanceId: number, transaction?: Transaction) {
    const [row] = await executionModel(this.database, 'CronTriggers').findAll({
      attributes: ['stop_requested'],
      where: { instance_id: instanceId },
      transaction,
      raw: true,
    });
    return row && Boolean(row.stop_requested);
  }

  async stopVerifiedInstance(
    instanceId: number,
    settleLegacy?: (transaction: Transaction) => Promise<boolean>,
  ) {
    return this.database.transaction(async (transaction) => {
      const [row] = await executionModel(this.database, 'CronTriggers').findAll(
        {
          attributes: [
            'id',
            'owner',
            'command_identity',
            'reason',
            'state',
            'stop_exit_at',
            'exit_code',
            'exit_pending',
          ],
          where: { instance_id: instanceId },
          transaction,
          raw: true,
        },
      );
      await executionModel(this.database, 'CronStopRequests').destroy({
        where: { instance_id: instanceId },
        transaction,
        hooks: false,
      });
      if (!row) return settleLegacy ? settleLegacy(transaction) : false;
      if (row.state !== 'running') return row.state === 'stopped';
      const legacyCrond =
        row.owner?.startsWith('crond:') &&
        (!row.command_identity || row.owner === row.command_identity);
      // A live scheduler drains its log and reports the actual exit. If the
      // callback already arrived or its owner is gone, settle in this transaction.
      const exit = await this.evidence.exitBeforeStop(row.id);
      if (
        exit.published ||
        exit.unreadable ||
        row.exit_pending ||
        row.stop_exit_at !== null ||
        !row.owner ||
        legacyCrond ||
        row.reason === 'restart'
      ) {
        await this.evidence.recoverScriptSample(row.id, transaction);
        await this.evidence.completeCommandExit(
          row.id,
          'stopped',
          'cancelled',
          row.exit_code,
          transaction,
          exit.canonical,
          row.stop_exit_at ?? undefined,
          undefined,
          exit.recovered,
        );
      }
      return true;
    });
  }

  async queueCounts() {
    await this.recoverSystemOwners();
    const [row] = (await executionModel(this.database, 'CronTriggers').findAll({
      attributes: [
        [fn('COUNT', col('id')), 'triggers'],
        [fn('COUNT', fn('DISTINCT', col('cron_id'))), 'tasks'],
      ],
      where: { state: 'queued', dequeued_at: null },
      raw: true,
    })) as unknown as Array<{ triggers: number; tasks: number }>;
    return row;
  }

  async startSystem(
    id: string,
    cronId: number,
    owner: string,
    commandIdentity = owner,
    wrapper?: { rule: string; at: number; dispatch?: number },
  ) {
    // crond only tells us when the wrapper starts. It supplies no scheduled or queued time.
    return this.database.transaction(async (transaction) => {
      const [task] = await executionModel(this.database, 'Crontabs').findAll({
        attributes: ['allow_multiple_instances', 'status', 'pid', 'isDisabled'],
        where: { id: cronId },
        transaction,
        raw: true,
      });
      if (!task || (task.isDisabled && !wrapper?.dispatch)) return false;
      const now = Date.now();
      const inserted = await this.database.query(
        `INSERT INTO CronTriggers(id,cron_id,source,state,owner,command_identity,observed_at,system_rule,system_dispatch_at)
         VALUES ($id,$cronId,'system','queued',$owner,$commandIdentity,$observed,$rule,$dispatch)
         ON CONFLICT(id) DO UPDATE SET command_identity=excluded.command_identity,
           system_rule=excluded.system_rule,system_dispatch_at=excluded.system_dispatch_at
         WHERE state='queued' AND source='system' AND owner=$owner
           AND EXISTS (SELECT 1 FROM CronConcurrencyLeases WHERE trigger_id=$id AND command_identity=$commandIdentity)`,
        {
          bind: {
            id,
            cronId,
            owner,
            commandIdentity,
            observed: wrapper?.at ?? now,
            rule: wrapper?.rule ?? null,
            dispatch: wrapper?.dispatch ?? null,
          },
          type: QueryTypes.BULKUPDATE,
          transaction,
        },
      );
      if (!inserted) return false;
      if (task.isDisabled) {
        await this.finish(id, 'skipped', 'changed', null, transaction);
        return false;
      }
      const multiple = task.allow_multiple_instances === 1;
      const claimed =
        (multiple ||
          !hasLiveCronProcess(
            task.status ?? undefined,
            task.pid ?? undefined,
          )) &&
        (await this.start(id, now, multiple, transaction));
      if (claimed && wrapper)
        await executionModel(this.database, 'CronTriggers').update(
          { command_started_at: now },
          {
            where: { id },
            transaction,
            silent: true,
            hooks: false,
            validate: false,
          },
        );
      if (claimed && owner.startsWith('crond:')) {
        await this.registerCommandInstance(
          id,
          cronId,
          Number(commandIdentity.split(':')[1]),
          commandIdentity,
          now,
          undefined,
          transaction,
        );
      }
      if (!claimed)
        await this.finish(id, 'skipped', 'overlap', null, transaction);
      return claimed;
    });
  }

  async recoverSystemOwners(
    cronId?: number,
    transaction?: Transaction,
    instanceId?: number,
  ) {
    // HTTP may restart while crond children keep running. Match process birth, including across reboots.
    const active = await this.database.query<{
      id: string;
      owner: string;
      state: string;
    }>(
      `SELECT id,state,CASE WHEN owner LIKE 'crond:%' THEN owner ELSE COALESCE(command_identity,process_identity) END AS owner FROM CronTriggers WHERE (state='running' OR (state='queued' AND source='system' AND owner LIKE 'crond:%')) AND (owner LIKE 'crond:%' OR reason='restart')
       AND NOT EXISTS (SELECT 1 FROM CronStopRequests s WHERE s.instance_id=CronTriggers.instance_id AND s.targets IS NOT NULL)
       AND ($cronId IS NULL OR cron_id=$cronId) AND ($instanceId IS NULL OR instance_id=$instanceId)`,
      {
        transaction,
        bind: { cronId: cronId ?? null, instanceId: instanceId ?? null },
        type: QueryTypes.SELECT,
      },
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
        if (row.state === 'queued') {
          await this.finish(row.id, 'skipped', 'restart', null, tx);
          return;
        }
        const [current] = await this.database.query<{
          stop_requested: number;
          exit_code: number | null;
          stop_exit_at: number | null;
        }>(
          `SELECT stop_requested,exit_code,stop_exit_at FROM CronTriggers WHERE id=$id AND state='running'
           AND NOT EXISTS (SELECT 1 FROM CronStopRequests s WHERE s.instance_id=CronTriggers.instance_id AND s.targets IS NOT NULL)`,
          { transaction: tx, bind: { id: row.id }, type: QueryTypes.SELECT },
        );
        if (!current) return;
        await this.evidence.recoverScriptSample(row.id, tx);
        await this.evidence.completeCommandExit(
          row.id,
          current.stop_requested ? 'stopped' : 'unknown',
          current.stop_requested ? 'cancelled' : 'restart',
          current.exit_code,
          tx,
          undefined,
          current.stop_exit_at ?? undefined,
        );
      };
      if (transaction) await close(transaction);
      else await this.database.transaction(close);
      reclaimed = true;
    }
    return reclaimed;
  }

  async interrupt(owner: string) {
    await this.database.transaction(async (transaction) => {
      await this.evidence.replayPublishedExits(transaction);
      if (owner === 'http')
        await this.database.query(
          `INSERT OR IGNORE INTO CronStopRequests(instance_id,cron_id,pid)
        SELECT instance_id,cron_id,CAST(substr(process_identity,7) AS INTEGER) FROM CronTriggers
        WHERE state='running' AND stop_requested=1 AND instance_id IS NOT NULL AND process_identity LIKE 'crond:%'`,
          { transaction },
        );
      // No process was bound and its launch gate closed when the worker exited.
      await executionModel(this.database, 'CronTriggers').update(
        {
          state: 'stopped',
          reason: 'cancelled',
          started_at: null,
          finished_at: Date.now(),
        },
        {
          where: {
            owner,
            state: 'running',
            stop_requested: 1,
            instance_id: null,
            command_identity: null,
          },
          transaction,
          silent: true,
          hooks: false,
          validate: false,
        },
      );
      await this.database.query(
        `UPDATE CronTriggers SET state='queued',started_at=NULL,reason=NULL
         WHERE owner=$owner AND state='running' AND COALESCE(stop_requested,0)=0
         AND command_identity IS NULL AND process_identity IS NULL AND instance_id IS NULL
         AND (EXISTS (SELECT 1 FROM CronManualSubmissions WHERE trigger_id=CronTriggers.id)
           OR EXISTS (SELECT 1 FROM CronConcurrencyLeases WHERE trigger_id=CronTriggers.id AND command_identity IS NULL))`,
        { transaction, bind: { owner } },
      );
      await this.database.query(
        `UPDATE CronTriggers SET reason='restart',
        resume_pending=CASE WHEN state='queued' AND source IN ('node','recovery') THEN 1 ELSE resume_pending END,
        state=CASE WHEN state='queued' THEN 'skipped' WHEN COALESCE(command_identity,process_identity) IS NOT NULL THEN 'running' ELSE 'unknown' END,
        finished_at=CASE WHEN state='running' AND COALESCE(command_identity,process_identity) IS NOT NULL THEN NULL ELSE $now END
        WHERE (owner=$owner OR (source IN ('system','legacy','client') AND owner IS NULL AND $owner='http')) AND state IN ('queued','running')
        AND NOT (state='queued' AND EXISTS (SELECT 1 FROM CronManualSubmissions WHERE trigger_id=CronTriggers.id))`,
        { transaction, bind: { owner, now: Date.now() } },
      );
      await this.recoverSystemOwners(undefined, transaction);
    });
  }
}

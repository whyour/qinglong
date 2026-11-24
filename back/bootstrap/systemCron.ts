import { executionModel } from '../data/executionModels';
import { storageFull, writeExit } from '../cron/settlement/exitReceipt.cjs';
import { QueryTypes } from 'sequelize';
import { randomUUID } from 'crypto';
import { sequelize } from '../data';
import { systemOwner, TriggerHistory } from '../cron/history';
import { globalCronBudget } from '../cron/execution/globalCronBudget';

async function receipt() {
  const [action, task, pid, id, status, end] = process.argv.slice(2);
  const history = new TriggerHistory(sequelize);
  if (action === 'start') {
    await history.recoverSystemOwners(Number(task));
    const triggerId = id || `system-${task}-${randomUUID()}`;
    const owner = systemOwner(Number(pid));
    const command = status ? systemOwner(Number(status)) : owner;
    const at = Number(process.env.QL_SYSTEM_ENTERED);
    const rule = process.env.QL_SYSTEM_RULE;
    const dispatched = Number(process.env.QL_SYSTEM_DISPATCHED) * 1000;
    const dispatch =
      Number.isSafeInteger(dispatched) && dispatched > 0 && dispatched <= at
        ? dispatched
        : undefined;
    const wrapper =
      rule && Number.isSafeInteger(at) && at > 0 && at <= Date.now()
        ? { rule, at, dispatch }
        : undefined;
    const queued = await sequelize.query(
      `INSERT INTO CronTriggers(id,cron_id,source,state,owner,queued_at,observed_at)
       VALUES ($id,$cronId,'system','queued',$owner,$now,$now) ON CONFLICT(id) DO NOTHING`,
      {
        bind: { id: triggerId, cronId: Number(task), owner, now: Date.now() },
        type: QueryTypes.BULKUPDATE,
      },
    );
    const budget = globalCronBudget(sequelize);
    const token =
      queued === 1 &&
      (await budget.acquire(triggerId, {
        owner,
        commandIdentity: command,
        current: () => systemOwner(Number(pid)) === owner,
      }));
    const acquired =
      token &&
      (await history.startSystem(
        triggerId,
        Number(task),
        owner,
        command,
        wrapper,
      ));
    if (!acquired) {
      if (token) await budget.release(triggerId, token);
      process.exitCode = 75;
    } else if (!id) process.stdout.write(triggerId);
  } else if (action === 'finish') {
    // The live wrapper inherited both IDs from the start it just claimed. A
    // standalone retry must match the registered system task before writing.
    const fromWrapper =
      process.env.QL_TRIGGER_ID === id && process.env.ID === task;
    if (!fromWrapper || !id?.startsWith(`system-${Number(task)}-`)) {
      const [registered] = await sequelize.query(
        `SELECT 1 FROM CronTriggers WHERE id=$id AND cron_id=$task AND source='system' AND owner LIKE 'crond:%'
         UNION ALL SELECT 1 FROM CronLegacyExitBookings WHERE trigger_id=$id AND cron_id=$task AND source='system' LIMIT 1`,
        { bind: { id, task: Number(task) }, type: QueryTypes.SELECT },
      );
      if (!registered) return;
    }
    const code = Number(status);
    const finishedAt =
      end && /^\d{13}$/.test(end) && Number(end) <= Date.now()
        ? Number(end)
        : undefined;
    const bound = fromWrapper && finishedAt !== undefined;
    let journaled = false;
    if (bound) {
      try {
        writeExit(id, code, null, finishedAt);
        journaled = true;
      } catch (error) {
        if (!storageFull(error)) throw error;
        console.error(
          '[crond] Receipt storage full; settling the observed exit in SQLite:',
          error,
        );
      }
    }
    try {
      await history.complete(
        id,
        code === 0 ? 'finished' : 'failed',
        null,
        code,
        finishedAt,
        bound
          ? { version: 1, code, signal: null, time: finishedAt }
          : finishedAt === undefined
          ? undefined
          : 'legacy',
      );
      const [lease] = await executionModel(
        sequelize,
        'CronConcurrencyLeases',
      ).findAll({
        attributes: ['token'],
        where: { trigger_id: id },
        raw: true,
      });
      if (lease) await globalCronBudget(sequelize).release(id, lease.token);
    } catch (error) {
      if (!journaled || !storageFull(error)) throw error;
      // The regular recovery pass will settle the receipt after space returns.
    }
  } else {
    throw new Error('Unknown crond receipt action');
  }
}

receipt()
  .catch((error) => {
    console.error('[crond] Failed to persist execution receipt:', error);
    // At start, 75 means that another execution already owns the slot.
    process.exitCode =
      process.argv[2] === 'finish' && storageFull(error) ? 75 : 1;
  })
  .finally(() => sequelize.close());

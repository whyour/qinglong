const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const { Sequelize, QueryTypes } = require('sequelize');
const {
  GlobalCronBudget,
} = require('../../back/cron/execution/globalCronBudget');
const { systemOwner } = require('../../back/cron/execution/cronProcess');
const load = require('../helpers/load-security-module.cjs');
const {
  installTriggerHistory,
  TriggerHistory,
} = require('../../back/cron/history');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fixture(t, limit = 2, productionDatabase = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-budget-'));
  const storage = path.join(root, 'database.sqlite');
  const db = productionDatabase
    ? load('back/data/index.ts', { '../config/index': { dbPath: root } })
        .sequelize
    : new Sequelize({ dialect: 'sqlite', storage, logging: false });
  const tasks = load('back/data/cron.ts', { '.': { sequelize: db } });
  load('back/data/runningInstance.ts', { '.': { sequelize: db } });
  load('back/data/cronStats.ts', { '.': { sequelize: db } });
  load('back/data/system.ts', { '.': { sequelize: db } });
  await db.sync();
  await db.transaction((tx) => installTriggerHistory(db, tx));
  await db.query(
    "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES ('systemConfig',$info,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    { bind: { info: JSON.stringify({ cronConcurrency: limit }) } },
  );
  const history = new TriggerHistory(db);
  const budget = new GlobalCronBudget(db);
  t.after(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const enqueue = async (id, source = 'manual') => {
    await history.enqueue(id, 1, source, null);
    return id;
  };
  const leases = () =>
    db.query('SELECT * FROM CronConcurrencyLeases', {
      type: QueryTypes.SELECT,
    });
  return { db, storage, tasks, history, budget, enqueue, leases };
}

test('manual, node and recovery share the durable budget and duplicate requests cannot execute twice', async (t) => {
  const { budget, enqueue, leases } = await fixture(t, 2);
  let active = 0,
    peak = 0,
    done = 0;
  const ids = await Promise.all(
    Array.from({ length: 18 }, (_, i) =>
      enqueue('job-' + i, ['manual', 'node', 'recovery'][i % 3]),
    ),
  );
  await Promise.all(
    ids.map((id) =>
      budget.run(id, async () => {
        peak = Math.max(peak, ++active);
        assert.equal(await budget.acquire(id), undefined);
        await sleep(20);
        active--;
        done++;
      }),
    ),
  );
  assert.equal(done, 18);
  assert.equal(peak, 2);
  assert.deepEqual(await leases(), []);
});

test('cancelled and expired waiters never execute or leak permits; lowering and raising the shared limit takes effect', async (t) => {
  const { db, budget, enqueue, leases, history } = await fixture(t, 1);
  const token = await budget.acquire(await enqueue('holder'));
  const signal = new EventEmitter();
  const expired = budget.run(
    await enqueue('expired', 'node'),
    () => assert.fail('expired ran'),
    undefined,
    signal,
  );
  const cancelled = budget.run(await enqueue('cancelled'), () =>
    assert.fail('cancelled ran'),
  );
  signal.emit('expired');
  await history.finish('cancelled', 'stopped', 'cancelled');
  await Promise.all([expired, cancelled]);
  assert.equal((await leases()).length, 1);
  const pending = budget.acquire(await enqueue('next'));
  await db.query('UPDATE Auths SET info=\'{"cronConcurrency":2}\'');
  const next = await pending;
  assert.equal((await leases()).length, 2);
  await db.query('UPDATE Auths SET info=\'{"cronConcurrency":1}\'');
  let entered = false;
  const last = budget.run(await enqueue('last'), async () => {
    entered = true;
  });
  await budget.release('next', next);
  await sleep(150);
  assert.equal(entered, false);
  await budget.release('holder', token);
  await last;
  assert.deepEqual(await leases(), []);
});

test('a surviving supervisor holds its permit after worker death, and a dead or reused PID is reclaimed', async (t) => {
  const { db, budget, enqueue, leases } = await fixture(t, 1);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  t.after(() => child.kill('SIGKILL'));
  await once(child, 'spawn');
  const identity = systemOwner(child.pid);
  await enqueue('orphan');
  await db.query(
    'INSERT INTO CronConcurrencyLeases VALUES ($id,$token,$owner,$command)',
    {
      bind: {
        id: 'orphan',
        token: 'old',
        owner: identity + '-reused',
        command: identity,
      },
    },
  );
  let entered = false;
  const work = budget.run(await enqueue('recovery', 'recovery'), async () => {
    entered = true;
  });
  await sleep(200);
  assert.equal(entered, false);
  await budget.release('orphan', 'old');
  assert.equal((await leases()).length, 1);
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
  await work;
  assert.equal(entered, true);
  assert.deepEqual(await leases(), []);
  await db.query(
    'INSERT INTO CronConcurrencyLeases VALUES ($id,$token,$owner,NULL)',
    {
      bind: {
        id: 'dead-before-bind',
        token: 'stale',
        owner: systemOwner(process.pid) + '-reused',
      },
    },
  );
  await budget.run(await enqueue('after-unbound'), async () => {});
  assert.deepEqual(await leases(), []);
});

test('exceptions release unbound reservations and no idle polling remains', async (t) => {
  const { db, budget, enqueue, leases } = await fixture(t, 1);
  await assert.rejects(
    budget.run(await enqueue('failed'), async () => {
      throw new Error('spawn failed');
    }),
    /spawn failed/,
  );
  assert.deepEqual(await leases(), []);
  let queries = 0;
  db.options.logging = () => queries++;
  await sleep(250);
  assert.equal(queries, 0);
});

test('an upgrade counts surviving commands created before budget leases existed', async (t) => {
  const { db, budget, enqueue, leases, history } = await fixture(t, 1);
  await enqueue('old-version');
  await history.start('old-version');
  await db.query(
    "UPDATE CronTriggers SET command_identity=$identity WHERE id='old-version'",
    { bind: { identity: systemOwner(process.pid) } },
  );
  let ran = false;
  const pending = budget.run(await enqueue('new-version'), async () => {
    ran = true;
  });
  await sleep(150);
  assert.equal(ran, false);
  assert.deepEqual(await leases(), []);
  await history.finish('old-version', 'finished', null, 0);
  await pending;
  assert.equal(ran, true);
  assert.deepEqual(await leases(), []);
});

test('a cancelled supervisor keeps capacity until its recorded descendants exit', async (t) => {
  const { db, budget, enqueue, leases } = await fixture(t, 1);
  await enqueue('stopping');
  await db.query("UPDATE CronTriggers SET instance_id=9 WHERE id='stopping'");
  await db.query(
    'INSERT INTO CronStopRequests(instance_id,cron_id,pid,targets) VALUES (9,1,$pid,$targets)',
    {
      bind: {
        pid: process.pid,
        targets: JSON.stringify([systemOwner(process.pid)]),
      },
    },
  );
  await db.query(
    'INSERT INTO CronConcurrencyLeases VALUES ($id,$token,$owner,$command)',
    {
      bind: {
        id: 'stopping',
        token: 'stop',
        owner: 'crond:999999999:dead',
        command: 'crond:999999999:dead',
      },
    },
  );
  await budget.release('stopping', 'stop');
  assert.equal((await leases()).length, 1);
  let ran = false;
  const next = budget.run(await enqueue('after-stop'), async () => {
    ran = true;
  });
  await sleep(150);
  assert.equal(ran, false);
  await db.query('DELETE FROM CronStopRequests WHERE instance_id=9');
  await next;
  assert.equal(ran, true);
  assert.deepEqual(await leases(), []);
});

test('accepted scheduled recovery retains identity and queue deadline without replaying changed rules or bound commands', async (t) => {
  const { db, history } = await fixture(t);
  const { slotId } = require('../../back/cron/identity');
  const item = {
    id: '1',
    command: 'true',
    schedule: '* * * * * *',
    recovery_from: 100,
  };
  const original = slotId('1', 0, item.schedule, 1000);
  const historical = slotId('1', 0, item.schedule, 5000);
  for (const [id, at] of [
    [original, 1000],
    ['changed-rule', 2000],
    ['too-old', 3000],
    ['already-bound', 4000],
    [historical, 5000],
  ]) {
    await history.enqueue(id, 1, 'node', at, id === 'too-old' ? 50 : 120);
    await history.finish(id, 'skipped', 'restart');
  }
  await db.query(
    "UPDATE CronTriggers SET started_at=125 WHERE id='already-bound'",
  );
  await db.query(
    'UPDATE CronTriggers SET resume_pending=1 WHERE id<>$historical',
    { bind: { historical } },
  );
  const calls = [];
  const { resumeAcceptedCrons } = load(
    'back/cron/scheduling/resumeAcceptedCrons.ts',
    {
      '../../data/cron': { CrontabModel: { sequelize: db } },
      '../execution/runCron': { runCron: async (...args) => calls.push(args) },
    },
  );
  await resumeAcceptedCrons(item, () => true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][3], {
    id: original,
    time: 1000,
    queuedAt: 120,
    source: 'recovery',
  });
});

test('restart preserves submitted manual snapshots, requeues only unbound launches and never replays bound commands', async (t) => {
  const { db, history, enqueue } = await fixture(t);
  for (const id of ['queued', 'unbound', 'bound', 'cancelled']) {
    await enqueue(id);
    await db.query(
      'INSERT INTO CronManualSubmissions VALUES ($id,$token,$snapshot)',
      { bind: { id, token: id, snapshot: '{}' } },
    );
  }
  await db.query(
    "UPDATE CronTriggers SET state='running',started_at=1 WHERE id IN ('unbound','bound')",
  );
  await db.query(
    "UPDATE CronTriggers SET command_identity=$identity WHERE id='bound'",
    { bind: { identity: systemOwner(process.pid) } },
  );
  await history.finish('cancelled', 'stopped', 'cancelled');
  await history.interrupt('http');
  const rows = await db.query(
    'SELECT id,state,started_at FROM CronTriggers ORDER BY id',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.state]),
    [
      ['bound', 'running'],
      ['cancelled', 'stopped'],
      ['queued', 'queued'],
      ['unbound', 'queued'],
    ],
  );
  assert.equal(rows.find((r) => r.id === 'unbound').started_at, null);
});

test('cancellation between worker interruption and re-admission prevents recovery from launching the accepted slot', async (t) => {
  const { db, history, enqueue } = await fixture(t);
  await enqueue('interrupted', 'node');
  await history.interrupt('http');
  const [pending] = await db.query(
    "SELECT state,resume_pending FROM CronTriggers WHERE id='interrupted'",
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(pending, { state: 'skipped', resume_pending: 1 });
  assert.deepEqual(await history.cancelQueued([1]), ['interrupted']);
  assert.equal(
    await history.enqueue('interrupted', 1, 'recovery', 1000),
    false,
  );
  const [cancelled] = await db.query(
    "SELECT state,reason,resume_pending FROM CronTriggers WHERE id='interrupted'",
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(cancelled, {
    state: 'stopped',
    reason: 'cancelled',
    resume_pending: null,
  });
});

test('ready tasks across workers prefer short history, then age long tasks into FIFO', async (t) => {
  const { db, storage, tasks, budget, history, enqueue, leases } =
    await fixture(t, 1);
  await tasks.CrontabModel.bulkCreate([
    {
      id: 1,
      name: 'long',
      command: 'echo long',
      schedule: '* * * * *',
      last_running_time: 120,
      last_execution_time: 1,
    },
    {
      id: 2,
      name: 'short',
      command: 'echo short',
      schedule: '* * * * *',
      last_running_time: 0,
      last_execution_time: 1,
    },
  ]);
  const otherDb = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  t.after(() => otherDb.close());
  const other = new GlobalCronBudget(otherDb);
  const token = await budget.acquire(await enqueue('holder'));
  await history.enqueue('long', 1, 'node', null);
  await history.enqueue('short', 2, 'manual', null);
  await history.enqueue('aged', 1, 'recovery', null, Date.now() - 31000);
  const order = [];
  const jobs = [
    budget.run('long', async () => {
      order.push('long');
    }),
    other.run('short', async () => {
      order.push('short');
    }),
    budget.run('aged', async () => {
      order.push('aged');
    }),
  ];
  for (let i = 0; i < 100; i++) {
    const rows = await db.query('SELECT * FROM CronConcurrencyWaiters', {
      type: QueryTypes.SELECT,
    });
    if (rows.length === 3) break;
    await sleep(20);
  }
  await budget.release('holder', token);
  await Promise.all(jobs);
  assert.deepEqual(order, ['aged', 'short', 'long']);
  assert.deepEqual(await leases(), []);
  assert.deepEqual(
    await db.query('SELECT * FROM CronConcurrencyWaiters', {
      type: QueryTypes.SELECT,
    }),
    [],
  );
});

test('recovered queued tasks replace a dead ready owner without dropping or replaying the request', async (t) => {
  const { db, budget, enqueue, leases } = await fixture(t, 1);
  await enqueue('recovered-ready');
  await db.query(
    "INSERT INTO CronConcurrencyWaiters VALUES ('recovered-ready','old','system:99999999:dead')",
  );
  let calls = 0;
  await budget.run('recovered-ready', async () => {
    calls++;
  });
  assert.equal(calls, 1);
  assert.deepEqual(await leases(), []);
  assert.deepEqual(
    await db.query('SELECT * FROM CronConcurrencyWaiters', {
      type: QueryTypes.SELECT,
    }),
    [],
  );
});

test('ready-to-lease handoff is atomic and cleanup errors cannot hide a granted permit', async (t) => {
  const { db, budget, enqueue, leases } = await fixture(t, 1);
  await enqueue('atomic-handoff');
  const query = db.query.bind(db);
  let rejectHandoff = true;
  t.mock.method(db, 'query', async (sql, options) => {
    if (
      String(sql)
        .replace(/[`"]/g, '')
        .startsWith('DELETE FROM CronConcurrencyWaiters') &&
      options?.transaction &&
      rejectHandoff
    ) {
      rejectHandoff = false;
      throw Error('injected handoff failure');
    }
    return query(sql, options);
  });
  await assert.rejects(budget.acquire('atomic-handoff'), /handoff failure/);
  assert.deepEqual(await leases(), []);
  t.mock.method(db, 'query', async (sql, options) => {
    if (
      String(sql)
        .replace(/[`"]/g, '')
        .startsWith('DELETE FROM CronConcurrencyWaiters') &&
      !options?.transaction
    )
      throw Error('cleanup unavailable');
    return query(sql, options);
  });
  const token = await budget.acquire('atomic-handoff');
  assert.ok(token);
  assert.equal((await leases()).length, 1);
  await budget.release('atomic-handoff', token);
  assert.deepEqual(await leases(), []);
});

test('an idle budget ranks the entire synchronous submission before granting its first permit', async (t) => {
  const { db, tasks, history, budget, leases } = await fixture(t, 2);
  await tasks.CrontabModel.bulkCreate([
    {
      id: 1,
      name: 'long',
      command: 'long',
      schedule: '* * * * *',
      last_running_time: 30,
      last_execution_time: 1,
    },
    {
      id: 2,
      name: 'short',
      command: 'short',
      schedule: '* * * * *',
      last_running_time: 0,
      last_execution_time: 1,
    },
  ]);
  const ids = ['long-first', 'short-a', 'short-b', 'short-c'];
  for (const id of ids)
    await history.enqueue(id, id.startsWith('long') ? 1 : 2, 'manual', null);
  const order = [];
  let active = 0,
    peak = 0;
  await Promise.all(
    ids.map((id) =>
      budget.run(id, async () => {
        order.push(id);
        peak = Math.max(peak, ++active);
        await sleep(15);
        active--;
      }),
    ),
  );
  assert.deepEqual(new Set(order.slice(0, 2)), new Set(['short-a', 'short-b']));
  assert.ok(order.indexOf('short-c') < order.indexOf('long-first'));
  assert.equal(peak, 2);
  assert.deepEqual(await leases(), []);
  assert.deepEqual(
    await db.query('SELECT * FROM CronConcurrencyWaiters', {
      type: QueryTypes.SELECT,
    }),
    [],
  );
});

test('an arrival and expiration during registration are processed without a saturated polling delay', async (t) => {
  const { db, budget, enqueue, leases } = await fixture(t, 2);
  await enqueue('first');
  await enqueue('late');
  await enqueue('expired-late');
  const signal = new EventEmitter();
  let late,
    expired,
    injected = false;
  const query = db.query.bind(db);
  t.mock.method(db, 'query', async (sql, options) => {
    if (
      !injected &&
      (/^SELECT t\.id,w\.token FROM CronTriggers t JOIN CronConcurrencyWaiters w/.test(
        String(sql),
      ) ||
        /^SELECT .* FROM CronConcurrencyWaiters AS CronConcurrencyWaiters INNER JOIN CronTriggers AS trigger/.test(
          String(sql).replace(/[`"]/g, ''),
        ))
    ) {
      injected = true;
      late = budget.acquire('late');
      expired = budget.acquire('expired-late', { signal });
      signal.emit('expired');
    }
    return query(sql, options);
  });
  const first = await budget.acquire('first');
  assert.equal(
    injected,
    true,
    'the in-flight registration fault must be exercised',
  );
  // A 100 ms saturated poll here would postpone an already-ready arrival even
  // though one permit is free. The wakeup must survive the in-flight query.
  assert.equal(budget.timer, undefined);
  const second = await late;
  assert.ok(second);
  assert.equal(await expired, undefined);
  assert.equal((await leases()).length, 2);
  await budget.release('first', first);
  await budget.release('late', second);
  assert.deepEqual(await leases(), []);
});

test('local saturation reduces fallback reads and a release immediately wakes admission', async (t) => {
  const { db, budget, enqueue, leases } = await fixture(t, 1);
  const first = await budget.acquire(await enqueue('local-holder'));
  let snapshots = 0;
  const query = db.query.bind(db);
  t.mock.method(db, 'query', async (sql, options) => {
    if (String(sql).startsWith('SELECT l.*,s.targets') && !options?.transaction)
      snapshots++;
    return query(sql, options);
  });
  const next = budget.acquire(await enqueue('local-next'));
  await sleep(650);
  assert.ok(
    snapshots >= 1 && snapshots <= 3,
    `saturated snapshots: ${snapshots}`,
  );
  assert.equal((await leases()).length, 1);
  await budget.release('local-holder', first);
  // Release interrupts the fallback timer; admission must not wait for it.
  assert.equal(budget.timer, undefined);
  const token = await next;
  assert.ok(token);
  await budget.release('local-next', token);
  assert.equal(budget.heldTokens.size, 0);
  assert.deepEqual(await leases(), []);
});

test('another budget in the same worker retains fast polling and sees releases without local notifications', async (t) => {
  const { db, storage, budget, enqueue, leases } = await fixture(t, 1);
  const otherDb = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  t.after(() => otherDb.close());
  const other = new GlobalCronBudget(otherDb);
  const first = await budget.acquire(await enqueue('foreign-holder'));
  let snapshots = 0;
  const query = otherDb.query.bind(otherDb);
  t.mock.method(otherDb, 'query', async (sql, options) => {
    if (String(sql).startsWith('SELECT l.*,s.targets') && !options?.transaction)
      snapshots++;
    return query(sql, options);
  });
  const next = other.acquire(await enqueue('foreign-next'));
  await sleep(650);
  assert.ok(snapshots >= 4, `foreign snapshots: ${snapshots}`);
  await budget.release('foreign-holder', first);
  const token = await next;
  assert.ok(token);
  await other.release('foreign-next', token);
  assert.deepEqual(await leases(), []);
});

test('large admission batches preserve tokens across chunks and ignore duplicate, missing and cancelled requests', async (t) => {
  const { db, budget, enqueue, leases, history } = await fixture(t, 4);
  const ids = Array.from({ length: 401 }, (_, i) => `chunk-${i}`);
  for (const id of ids) await enqueue(id);
  await enqueue('cancelled-batch');
  await history.finish('cancelled-batch', 'stopped', 'cancelled');
  let active = 0;
  let peak = 0;
  const calls = new Map();
  const jobs = ids.map((id) =>
    budget.run(id, async () => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      peak = Math.max(peak, ++active);
      await history.finish(id, 'finished', null, 0);
      active--;
    }),
  );
  for (const id of [ids[0], ids[200], 'missing-batch', 'cancelled-batch'])
    jobs.push(budget.run(id, () => assert.fail(`${id} must not run`)));
  await Promise.all(jobs);
  assert.equal(calls.size, ids.length);
  assert.ok([...calls.values()].every((count) => count === 1));
  assert.ok(peak <= 4);
  assert.equal(budget.heldTokens.size, 0);
  assert.deepEqual(await leases(), []);
  assert.deepEqual(
    await db.query('SELECT * FROM CronConcurrencyWaiters', {
      type: QueryTypes.SELECT,
    }),
    [],
  );
});

test('a later registration chunk failure rolls back the entire batch and permits a clean retry', async (t) => {
  const { db, budget, enqueue, leases } = await fixture(t, 4);
  const ids = Array.from({ length: 201 }, (_, i) => `rollback-${i}`);
  for (const id of ids) await enqueue(id);
  const query = db.query.bind(db);
  let chunks = 0;
  const mock = t.mock.method(db, 'query', async (sql, options) => {
    if (String(sql).startsWith('WITH incoming(') && ++chunks === 2)
      throw new Error('injected second chunk failure');
    return query(sql, options);
  });
  const results = await Promise.allSettled(ids.map((id) => budget.acquire(id)));
  assert.equal(chunks, 2, 'failure must occur after one successful chunk');
  assert.ok(
    results.every(
      (result) =>
        result.status === 'rejected' &&
        /second chunk failure/.test(result.reason.message),
    ),
  );
  mock.mock.restore();
  assert.equal(budget.heldTokens.size, 0);
  assert.deepEqual(await leases(), []);
  assert.deepEqual(
    await db.query('SELECT * FROM CronConcurrencyWaiters', {
      type: QueryTypes.SELECT,
    }),
    [],
  );
  let ran = false;
  await budget.run(ids[0], async () => {
    ran = true;
  });
  assert.equal(ran, true);
  assert.deepEqual(await leases(), []);
});

test('a fresh batch records shared occupancy while waiting, without rewriting unchanged samples', async (t) => {
  const { db, budget, enqueue } = await fixture(t, 1);
  await enqueue('a-holder');
  await enqueue('b-waiter');
  let release,
    started = false;
  const gate = new Promise((resolve) => (release = resolve));
  const first = budget.run('a-holder', async () => {
    started = true;
    await gate;
  });
  const second = budget.run('b-waiter', async () => {});
  t.after(async () => {
    release();
    await Promise.all([first, second]);
  });
  const read = async () =>
    (
      await db.query("SELECT * FROM CronTriggers WHERE id='b-waiter'", {
        type: QueryTypes.SELECT,
      })
    )[0];
  let row;
  for (let i = 0; i < 150; i++) {
    row = await read();
    if (row.queue_live_context) break;
    await sleep(10);
  }
  assert.equal(started, true);
  assert.equal(row.state, 'queued');
  assert.deepEqual(JSON.parse(row.queue_context), {
    queue: 'global',
    limit: 1,
    occupied: 1,
    holders: [{ id: 'a-holder', name: 'a-holder' }],
  });
  assert.equal(row.queue_context, row.queue_live_context);
  let writes = 0;
  db.options.logging = (sql) => {
    if (/UPDATE.*queue_live_context/.test(sql)) writes++;
  };
  await sleep(650);
  assert.equal(writes, 0);
  release();
  await Promise.all([first, second]);
});

test('global diagnostics include a different worker and retain its first sample through handoff', async (t) => {
  const { db, storage, budget, enqueue } = await fixture(t, 1);
  await enqueue('foreign-holder', 'system');
  await enqueue('waiting-node', 'node');
  const foreign = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  const other = new GlobalCronBudget(foreign);
  const token = await other.acquire('foreign-holder');
  const next = budget.acquire('waiting-node');
  let row;
  for (let i = 0; i < 150; i++) {
    [row] = await db.query(
      "SELECT * FROM CronTriggers WHERE id='waiting-node'",
      { type: QueryTypes.SELECT },
    );
    if (row.queue_live_context) break;
    await sleep(10);
  }
  assert.equal(
    JSON.parse(row.queue_live_context).holders[0].id,
    'foreign-holder',
  );
  assert.equal(JSON.parse(row.queue_live_context).queue, 'global');
  await other.release('foreign-holder', token);
  await budget.release('waiting-node', await next);
  await foreign.close();
});

for (const cancel of [false, true]) {
  test(
    `real background writers hold the global slot through ${
      cancel ? 'forced cancellation' : 'normal completion'
    }`,
    { timeout: 15000, skip: cancel && process.platform !== 'linux' },
    async (t) => {
      const { db, storage, tasks, history, budget, enqueue, leases } =
        await fixture(t, 1, true);
      const root = path.dirname(storage);
      const previousData = process.env.QL_DATA_DIR;
      process.env.QL_DATA_DIR = root;
      t.after(() => {
        if (previousData === undefined) delete process.env.QL_DATA_DIR;
        else process.env.QL_DATA_DIR = previousData;
      });
      await tasks.CrontabModel.create({
        id: 1,
        command: 'true',
        allow_multiple_instances: 1,
      });
      await enqueue('background');
      await enqueue('after-background', 'node');
      const ready = path.join(root, 'writer.pid');
      const proceed = path.join(root, 'continue');
      const log = path.join(root, 'background.log');
      const { shellQuote } = require('../../back/shared/shellQuote');
      const {
        spawnCronCommand,
        releaseCronCommand,
      } = require('../../back/cron/execution/cronCommandProcess');
      const writer = `import os,time,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nos.write(1,'唯一执行 中文🚀\\n'.encode())\nopen(${JSON.stringify(
        ready,
      )},'w').write(str(os.getpid()))\nwhile not os.path.exists(${JSON.stringify(
        proceed,
      )}):time.sleep(.01)\nos.write(2,'正常尾行\\n'.encode())\n`;
      let child,
        writerPid,
        nextRuns = 0;
      const first = budget.run('background', async () => {
        assert.equal(await history.start('background'), true);
        child = spawnCronCommand(
          `python3 -I -S -c ${shellQuote(writer)} &`,
          'background',
          undefined,
          log,
        );
        const closed = once(child, 'close');
        child.stdout.resume();
        child.stderr.resume();
        await once(child, 'spawn');
        assert.equal(
          await history.bindCommand('background', child.pid, 'background.log'),
          true,
        );
        await releaseCronCommand(child);
        const [code, signal] = await closed;
        await history.complete(
          'background',
          signal ? 'stopped' : 'finished',
          signal,
          code,
        );
      });
      first.catch(() => {});
      t.after(() => {
        child?.kill('SIGKILL');
        if (writerPid)
          try {
            process.kill(writerPid, 'SIGKILL');
          } catch (_) {}
      });
      for (let i = 0; i < 500; i++) {
        writerPid = Number(await fs.readFile(ready, 'utf8').catch(() => ''));
        if (writerPid) break;
        await sleep(10);
      }
      assert.ok(writerPid);
      // A replacement/foreign worker sees the same durable command reservation.
      const foreign = load('back/data/index.ts', {
        '../config/index': { dbPath: root },
      }).sequelize;
      const next = new GlobalCronBudget(foreign).run(
        'after-background',
        async () => {
          nextRuns++;
        },
      );
      await sleep(250);
      assert.equal(nextRuns, 0);
      assert.equal((await leases()).length, 1);
      if (cancel) {
        const { killTask } = require('../../back/config/util');
        const identity = systemOwner(child.pid);
        const [row] = await db.query(
          "SELECT instance_id FROM CronTriggers WHERE id='background'",
          { type: QueryTypes.SELECT },
        );
        await history.queueInstanceStop(
          row.instance_id,
          1,
          child.pid,
          undefined,
          identity,
        );
        await killTask(
          child.pid,
          true,
          () => assert.equal(systemOwner(child.pid), identity),
          (signal, targets) =>
            history.requestInstanceStop(
              row.instance_id,
              child.pid,
              signal,
              targets,
            ),
        );
        await history.stopVerifiedInstance(row.instance_id);
      } else await fs.writeFile(proceed, 'go');
      await Promise.all([first, next]);
      assert.equal(nextRuns, 1);
      assert.deepEqual(await leases(), []);
      assert.equal(
        await fs.readFile(log, 'utf8'),
        '唯一执行 中文🚀\n' + (cancel ? '' : '正常尾行\n'),
      );
      const [row] = await db.query(
        "SELECT state,counted FROM CronTriggers WHERE id='background'",
        { type: QueryTypes.SELECT },
      );
      assert.equal(row.state, cancel ? 'stopped' : 'finished');
      if (!cancel) assert.equal(row.counted, 1);
      await foreign.close();
    },
  );
}

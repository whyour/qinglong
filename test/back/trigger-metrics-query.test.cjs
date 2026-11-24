const assert = require('node:assert/strict');
const test = require('node:test');
const { Sequelize, QueryTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');

async function fixture(t) {
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => db.close());
  await db.query(`CREATE TABLE CronTriggers (
    state TEXT, observed_at INTEGER, scheduled_at INTEGER, started_at INTEGER,
    script_started_at INTEGER, dequeued_at INTEGER, queued_at INTEGER,
    queue_context TEXT, queue_live_context TEXT)`);
  await db.query('CREATE INDEX cron_trigger_day ON CronTriggers(observed_at)');
  const audits = [];
  const { TriggerQueries } = load('back/cron/queries/triggerQueries.ts', {
    '../scheduling/scheduleAudit': {
      auditSchedule: async (connection, since) => {
        assert.equal(connection, db);
        audits.push(['panel', since]);
        return { kind: 'panel' };
      },
    },
    '../scheduling/systemScheduleAudit': {
      systemScheduleAudit: async (connection, since) => {
        assert.equal(connection, db);
        audits.push(['system', since]);
        return { kind: 'system' };
      },
    },
  });
  const query = db.query.bind(db);
  let captured;
  db.query = (sql, options) => {
    if (sql.startsWith('WITH today')) captured = { sql, options };
    return query(sql, options);
  };
  return {
    db,
    queries: new TriggerQueries(db),
    audits,
    captured: () => captured,
  };
}

function expected(rows, since) {
  const today = rows.filter((r) => r.observed_at >= since);
  const deviations = today
    .filter((r) => r.scheduled_at != null)
    .map((r) => Math.abs(r.observed_at - r.scheduled_at));
  const scripts = today
    .filter(
      (r) =>
        r.scheduled_at != null &&
        r.script_started_at != null &&
        r.script_started_at >= r.scheduled_at,
    )
    .map((r) => r.script_started_at - r.scheduled_at);
  const waits = today
    .filter(
      (r) =>
        r.queued_at != null &&
        (r.dequeued_at ?? r.started_at) != null &&
        (r.dequeued_at ?? r.started_at) >= r.queued_at,
    )
    .map((r) => (r.dequeued_at ?? r.started_at) - r.queued_at);
  const p95 = (a) =>
    a.length ? a.sort((a, b) => a - b)[Math.ceil(a.length * 0.95) - 1] : null;
  return {
    observed: today.length,
    skipped: today.filter((r) => r.state === 'skipped').length,
    planned: deviations.length,
    onTime: today.filter(
      (r) =>
        r.started_at != null &&
        r.scheduled_at != null &&
        r.started_at <= r.scheduled_at + 5000,
    ).length,
    triggerOnTime: deviations.filter((n) => n <= 5000).length,
    triggerDeviationP95: p95(deviations),
    scriptSamples: scripts.length,
    scriptOnTime: scripts.filter((n) => n <= 5000).length,
    scriptStartP95: p95(scripts),
    samples: waits.length,
    waitP95: p95(waits),
    audit: { kind: 'panel' },
    systemAudit: { kind: 'system' },
  };
}

test('trigger metrics preserve exact counts and nearest-rank P95 across nulls, boundaries and states', async (t) => {
  const { db, queries, audits } = await fixture(t);
  const since = 100000;
  for (const count of [0, 1, 19, 20, 21, 99, 100, 101, 257]) {
    await db.query('DELETE FROM CronTriggers');
    const rows = Array.from({ length: count }, (_, i) => ({
      state: ['finished', 'skipped', 'unknown', 'queued', 'running', 'failed'][
        i % 6
      ],
      observed_at: since + [-1, 0, 1, 4999, 5000, 5001][i % 6],
      scheduled_at: i % 7 === 0 ? null : since + (i % 3),
      started_at:
        i % 5 === 0 ? null : since + [-1, 0, 4999, 5000, 5001, 9000][i % 6],
      script_started_at:
        i % 4 === 0 ? null : since + [-1, 0, 4999, 5000, 5001, 9000][i % 6],
      dequeued_at: i % 3 === 0 ? null : i % 3 === 1 ? 0 : since + 10,
      queued_at: i % 8 === 0 ? null : since - 10,
    }));
    for (const row of rows)
      await db.query(
        'INSERT INTO CronTriggers(state,observed_at,scheduled_at,started_at,script_started_at,dequeued_at,queued_at) VALUES($state,$observed_at,$scheduled_at,$started_at,$script_started_at,$dequeued_at,$queued_at)',
        { bind: row },
      );
    for (const cutoff of [since, since + 1, since + 20000])
      assert.deepEqual(
        await queries.metrics(cutoff),
        expected(rows, cutoff),
        `count=${count},cutoff=${cutoff}`,
      );
  }
  assert.equal(audits.length, 54);
  for (let i = 0; i < audits.length; i += 2)
    assert.deepEqual(audits[i + 1], ['system', audits[i][1]]);
});

test('actual metrics query reads the indexed trigger history once and reuses its narrow snapshot', async (t) => {
  const { db, queries, captured } = await fixture(t);
  await db.query(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1000)
    INSERT INTO CronTriggers SELECT 'finished',n,n,n+10,n+20,NULL,n,hex(zeroblob(1024)),hex(zeroblob(1024)) FROM seq`);
  assert.equal((await queries.metrics(1)).observed, 1000);
  const { sql, options } = captured();
  const plan = await db.query('EXPLAIN QUERY PLAN ' + sql, {
    ...options,
    type: QueryTypes.SELECT,
  });
  const details = plan.map((r) => r.detail);
  assert.equal(
    details.filter((s) => /SEARCH CronTriggers\b/.test(s)).length,
    1,
    details.join('\n'),
  );
  assert.ok(
    details.some((s) => s.includes('cron_trigger_day')),
    details.join('\n'),
  );
  assert.ok(
    details.some((s) => /MATERIALIZE today/.test(s)),
    details.join('\n'),
  );
});

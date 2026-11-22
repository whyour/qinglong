const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../helpers/load-security-module.cjs');
const {
  makeCommand,
  nodeCron,
} = require('../../back/cron/scheduling/cronScheduling');

function fixture(mode, failAt) {
  const events = [];
  const step = (name, ...args) => {
    events.push([name, ...args]);
    if (name === failAt) throw Error(`failed ${name}`);
  };
  const Service = load('back/services/cron.ts', {
    '../config/index': { crontabFile: '/unused' },
    '../config/util': {},
    '../data/cron': {
      CrontabModel: {
        sequelize: {},
        update: async (values, options) => step('saved', values, options.where),
      },
    },
    '../data/runningInstance': {},
    '../cron/execution/cronLimit': {},
    '../shared/logStreamManager': {},
    '../schedule/client': {
      readiness: { invalidate: () => step('invalidate') },
    },
    '../shared/utils': {
      writeFileWithLock: async (file, contents) =>
        step('write', file, contents),
    },
    '../cron/scheduling/systemScheduleAudit': {
      stageSystemPlan: async (db, rules) => {
        step('stage', rules);
        return 42;
      },
      confirmSystemPlan: async (db, plan) => step('confirm', plan),
      suspendSystemPlan: async () => step('suspend'),
    },
    child_process: { execFileSync: (...args) => step('install', ...args) },
    '../shared/i18n': { t: (value) => value },
  }).default;
  const service = new Service({ error: (...args) => step('error', ...args) });
  Object.defineProperty(service, 'schedulerMode', { value: mode });
  return { service, events };
}

test('system and node modes route extended cron once and keep portable rules in crontab', async () => {
  for (const mode of ['system', 'node']) {
    const { service, events } = fixture(mode);
    service.makeCommand = (row) => `task ${row.id}.js`;
    const rows = [
      { id: 'plain', schedule: '*/5 0-23 * * 1,3' },
      { id: 'spaces', schedule: '  0\t0 * * *  ' },
      { id: 'numeric-step', schedule: '0/5 * * * *' },
      { id: 'sunday-seven', schedule: '0 0 * * 7' },
      { id: 'day-step', schedule: '0 0 */2 * *' },
      { id: 'restricted-days', schedule: '0 0 1-31 * 1' },
      { id: 'restricted-week', schedule: '0 0 1 * 0-6' },
      { id: 'annually', schedule: '@annually' },
      { id: 'midnight', schedule: '@midnight' },
      { id: 'minutely', schedule: '@minutely' },
      { id: 'seconds', schedule: '0 0 * * * *' },
      { id: 'question', schedule: '0 0 * * ?' },
      { id: 'last', schedule: '0 0 L * *' },
      { id: 'nth', schedule: '0 0 * * 1#2' },
      { id: 'named', schedule: '0 0 * JAN MON' },
      { id: 'macro', schedule: '@daily' },
      { id: 'short', schedule: '*' },
      {
        id: 'extra',
        schedule: '* * * * *',
        extra_schedules: [{ schedule: '0 * * * *' }],
      },
      { id: 'wait', schedule: '* * * * *', max_queue_wait: 30 },
      { id: 'catchup', schedule: '* * * * *', catchup_seconds: 60 },
      { id: 'pending', schedule: '* * * * *', skip_if_pending: 1 },
      { id: 'once', schedule: '@once' },
      { id: 'boot', schedule: '@boot' },
    ];
    for (const row of rows) {
      const special = ['once', 'boot'].includes(row.id);
      const portable = ['plain', 'spaces'].includes(row.id);
      assert.equal(
        service.shouldUseCronClient(row),
        !special && (mode === 'node' || !portable),
        `${mode}: ${row.id}`,
      );
    }
    await service.setCrontab({ data: rows, total: rows.length });
    assert.deepEqual(
      events.map(([name]) => name),
      mode === 'system'
        ? ['stage', 'write', 'install', 'confirm']
        : ['suspend', 'write'],
    );
    const file = events.find(([name]) => name === 'write')[2];
    for (const id of rows
      .filter((row) => !['plain', 'spaces'].includes(row.id))
      .map((row) => row.id)) {
      const line = file
        .split('\n')
        .find((line) => line.endsWith(`task ${id}.js`));
      assert.ok(
        line.startsWith('# '),
        `${mode}: ${id} cannot also run from system crontab`,
      );
    }
    for (const id of ['plain', 'spaces']) {
      const line = file.split('\n').find((line) => line.includes(`ID=${id} `));
      assert.ok(!line.startsWith('# '));
      assert.ok(line.includes('QL_SYSTEM_DISPATCHED=$(date +\\%s)'));
      assert.ok(
        line.includes(
          'QL_TRIGGER_SOURCE=system bash "$QL_DIR/shell/system-cron.sh"',
        ),
      );
    }
  }
});

test('only acknowledged registrations become saved after system publication completes', async () => {
  const { service, events } = fixture('system');
  const rows = [
    { id: 1, name: 'portable', command: 'a.js', schedule: '* * * * *' },
    { id: 2, command: 'b.js', schedule: '@minutely' },
  ];
  await service.setCrontab({ data: rows, total: rows.length }, [1]);
  assert.deepEqual(
    events.map(([name]) => name),
    ['stage', 'write', 'install', 'confirm', 'saved'],
  );
  assert.deepEqual(events[0][1], [
    { id: 1, name: 'portable', schedule: '* * * * *' },
  ]);
  assert.deepEqual(events.at(-1), [
    'saved',
    { saved: true },
    { id: [1], saved: false },
  ]);
});

for (const mode of ['system', 'node']) {
  for (const phase of mode === 'system'
    ? ['stage', 'write', 'install', 'confirm']
    : ['suspend', 'write']) {
    test(`${mode} publication failure at ${phase} invalidates readiness without acknowledging schedules`, async () => {
      const { service, events } = fixture(mode, phase);
      const rows = [
        { id: 1, command: 'a.js', schedule: '* * * * *' },
        { id: 2, command: 'b.js', schedule: '* * * * *', isDisabled: 1 },
        { id: 3, command: 'c.js', schedule: '@minutely' },
        { id: 4, command: 'd.js', schedule: '@boot' },
      ];
      await assert.rejects(
        service.setCrontab({ data: rows, total: rows.length }, [1, 3]),
        (error) =>
          error.status === 503 && /旧规则可能仍在运行/.test(error.message),
      );
      const sequence =
        mode === 'system'
          ? ['stage', 'write', 'install', 'confirm']
          : ['suspend', 'write'];
      assert.deepEqual(
        events.map(([name]) => name),
        [
          ...sequence.slice(0, sequence.indexOf(phase) + 1),
          'error',
          'invalidate',
          ...(mode === 'system' ? ['saved'] : []),
        ],
      );
      if (mode === 'system') {
        assert.deepEqual(events.at(-1), [
          'saved',
          { saved: false },
          { id: [1, 2] },
        ]);
      }
    });
  }
}

test('manual and scheduled commands preserve the shell contract and Node registration fields', () => {
  const doc = {
    id: 7,
    name: 'task',
    command: 'ql repo https://example.test/repo',
    schedule: '* * * * *',
    log_name: "logs/it's a task",
    work_dir: "/scripts/it's here",
    task_before: 'echo before;\necho ready',
    task_after: 'echo done',
    extra_schedules: [{ schedule: '0 0 * * *' }],
    max_queue_wait: 30,
    catchup_seconds: 60,
    skip_if_pending: 1,
    recovery_from: 1234,
  };
  const scheduled = makeCommand(doc);
  assert.equal(
    scheduled,
    "QL_CRON_REVISION=1234 real_time=false no_tee=true ID=7 log_name='logs/it'\\''s a task' task_before='echo before;echo ready' task_after='echo done' work_dir='/scripts/it'\\''s here' ql repo https://example.test/repo",
  );
  assert.equal(
    makeCommand(doc, true),
    scheduled.replace('real_time=false', 'real_time=true'),
  );
  assert.deepEqual(nodeCron(doc, scheduled), {
    id: '7',
    name: 'task',
    command: scheduled,
    schedule: '* * * * *',
    extra_schedules: [{ schedule: '0 0 * * *' }],
    max_queue_wait: 30,
    catchup_seconds: 60,
    skip_if_pending: true,
    recovery_from: 1234,
  });
  assert.equal(
    makeCommand({ id: 8, command: 'script.js' }),
    'real_time=false no_tee=true ID=8 task script.js',
  );
  assert.equal(
    makeCommand({ id: 8, command: 'task script.js', log_name: '/dev/null' }),
    'real_time=false no_tee=true ID=8 log_name=/dev/null task script.js',
  );
});

test('scheduler mode honors explicit overrides and probes crond again for automatic selection', (t) => {
  const previous = process.env.QL_SCHEDULER;
  t.after(() => {
    if (previous === undefined) delete process.env.QL_SCHEDULER;
    else process.env.QL_SCHEDULER = previous;
  });
  let installed = true,
    probes = 0;
  const { schedulerMode } = load('back/cron/scheduling/cronScheduling.ts', {
    child_process: {
      execSync: (command, options) => {
        probes++;
        assert.equal(command, 'which crond');
        assert.deepEqual(options, { stdio: 'ignore' });
        if (!installed) throw Error('missing crond');
      },
    },
  });
  for (const mode of ['system', 'node']) {
    process.env.QL_SCHEDULER = mode;
    assert.equal(schedulerMode(), mode);
  }
  assert.equal(probes, 0);
  delete process.env.QL_SCHEDULER;
  assert.equal(schedulerMode(), 'system');
  installed = false;
  assert.equal(schedulerMode(), 'node');
  process.env.QL_SCHEDULER = 'auto';
  installed = true;
  assert.equal(schedulerMode(), 'system');
  assert.equal(probes, 3);
});

test('a gRPC worker still notifies its parent when system installation fails', async (t) => {
  const previousType = process.env.SERVICE_TYPE;
  const previousSend = process.send;
  const messages = [];
  process.env.SERVICE_TYPE = 'grpc';
  process.send = (message) => {
    messages.push(message);
    return true;
  };
  t.after(() => {
    if (previousType === undefined) delete process.env.SERVICE_TYPE;
    else process.env.SERVICE_TYPE = previousType;
    if (previousSend === undefined) delete process.send;
    else process.send = previousSend;
  });
  const { service } = fixture('system', 'install');
  await assert.rejects(
    service.setCrontab({
      data: [{ id: 1, command: 'a.js', schedule: '* * * * *' }],
      total: 1,
    }),
    (error) => error.status === 503,
  );
  assert.deepEqual(messages, ['crontab-install-failed']);
});

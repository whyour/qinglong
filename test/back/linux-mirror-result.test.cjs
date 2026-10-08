const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');

for (const scenario of [
  {
    name: 'stderr warning with exit zero',
    code: 'process.stderr.write("sudo: warning\\n")',
    saved: true,
  },
  {
    name: 'nonzero exit without stderr',
    code: 'process.exitCode = 7',
    saved: false,
  },
  {
    name: 'signal termination',
    code: 'process.kill(process.pid, "SIGTERM")',
    saved: false,
  },
  { name: 'spawn failure', shell: '/nonexistent-ql-test-shell', saved: false },
]) {
  test(`Linux mirror persistence follows the process result: ${scenario.name}`, async () => {
    const logger = { info() {}, error() {} };
    const ScheduleService = load('back/services/schedule.ts', {
      '../shared/cronScheduler': {},
      '../shared/pLimit': { runWithSystemLimit: async (_params, fn) => fn() },
      'cross-spawn': {
        spawn: () =>
          spawn(
            process.execPath,
            ['-e', scenario.code || ''],
            scenario.shell ? { shell: scenario.shell } : {},
          ),
      },
    }).default;
    const schedule = new ScheduleService(logger);
    let completion;
    const runTask = schedule.runTask.bind(schedule);
    schedule.runTask = (...args) => (completion = runTask(...args));
    const messages = [],
      writes = [];
    const SystemService = load('back/services/system.ts', {
      os: { platform: () => 'linux' },
      '../config': {},
      '../config/const': {},
      '../config/util': { updateLinuxMirrorFile: async () => 'fixture' },
      '../data/dependence': {},
      '../data/notify': {},
      '../data/system': {},
      '../schedule/client': {},
      '../shared/pLimit': {},
      '../shared/i18n': {},
      '../shared/schedulerMutationLock': {},
      './notify': class {},
      './schedule': ScheduleService,
      './sock': class {},
    }).default;
    const service = new SystemService(logger, schedule, {
      sendMessage: (message) => messages.push(message),
    });
    service.getSystemConfig = async () => ({ id: 1, info: { lang: 'en-US' } });
    service.updateAuthDb = async (doc) => writes.push(doc);
    let ended = 0;
    await service.updateLinuxMirror(
      { linuxMirror: 'https://mirror.example' },
      undefined,
      () => ended++,
    );
    const result = await completion;
    assert.equal(ended, 1);
    assert.equal(writes.length, scenario.saved ? 1 : 0);
    assert.ok(messages.some((message) => message.status === 'completed'));
    if (scenario.saved) {
      assert.equal(result.code, 0);
      assert.ok(
        messages.some((message) => message.message.includes('sudo: warning')),
      );
      assert.deepEqual(writes[0].info, {
        lang: 'en-US',
        linuxMirror: 'https://mirror.example',
      });
    }
  });
}

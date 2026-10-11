const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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

const hasApt = spawnSync('apt-get', ['--version']).status === 0;
for (const distribution of ['Debian', 'Ubuntu']) {
  for (const existingMirror of [false, true]) {
    test(
      `${distribution} mirror update rejects failed index downloads with ${
        existingMirror ? 'an existing' : 'an empty'
      } source`,
      { skip: !hasApt },
      async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-apt-result-'));
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const parts = path.join(root, 'parts');
        await fs.mkdir(parts);
        await fs.mkdir(path.join(root, 'lists', 'partial'), {
          recursive: true,
        });
        const source = path.join(root, 'sources.list');
        await fs.writeFile(
          source,
          'deb http://127.0.0.1:1/debian bookworm main\n',
        );
        // Load only fixture configuration, including all writable APT paths.
        const aptConfig = path.join(root, 'apt.conf');
        await fs.writeFile(
          aptConfig,
          `Dir::Etc::main "/dev/null";
Dir::Etc::parts "${parts}";
Dir::Etc::sourcelist "${source}";
Dir::Etc::sourceparts "${parts}";
Dir::State::lists "${path.join(root, 'lists')}";
Dir::Cache "${path.join(root, 'cache')}";
Dir::Log "${path.join(root, 'logs')}";
Acquire::Retries "0";
Acquire::http::Proxy "DIRECT";
Acquire::http::Timeout "1";
`,
        );
        const util = load('back/config/util.ts', {
          'fs/promises': {
            readFile: async (file) =>
              file === '/etc/os-release'
                ? distribution
                : existingMirror
                ? 'URIs: http://old.example/debian\n'
                : '',
          },
          os: { platform: () => 'linux' },
          './index': {},
          './const': {},
          './share': {},
          './container': { isInContainer: () => false },
          '../loaders/logger': {},
          '../shared/utils': {},
          '../shared/fileAccess': {},
          '../data/dependence': {},
        });
        const previousOS = process.env.QL_OS_TYPE;
        let command;
        try {
          process.env.QL_OS_TYPE = distribution.toLowerCase();
          command = await util.updateLinuxMirrorFile('http://127.0.0.1:1');
        } finally {
          if (previousOS === undefined) delete process.env.QL_OS_TYPE;
          else process.env.QL_OS_TYPE = previousOS;
        }
        // Exercise the generated updater without modifying host source files.
        const [program, ...args] = command
          .slice(command.lastIndexOf('&&') + 2)
          .trim()
          .split(/\s+/);
        assert.equal(program, 'apt-get');
        const options = {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, APT_CONFIG: aptConfig },
        };
        const baseline = spawnSync('apt-get', ['update'], options);
        assert.equal(baseline.status, 0, baseline.stderr);
        assert.match(baseline.stderr, /Failed to fetch/);
        const result = spawnSync(program, args, options);
        assert.equal(result.status, 100, result.stderr);
        assert.match(result.stderr, /Failed to fetch/);
      },
    );
  }
}

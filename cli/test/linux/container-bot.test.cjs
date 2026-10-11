const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { createContext } = require('../../dist/internal/runtime/context');
const { runContainer } = require('../../dist/internal/runtime/containerRuntime');
const { launchStartupHook } = require('../../dist/internal/maintenance/bootstrap');
const { launchBot } = require('../../dist/internal/maintenance/bot');

const live = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for fixture process');
}

test(
  'container stops its daemonized bot after installer exits and preserves another installation',
  { skip: process.platform !== 'linux', timeout: 20000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-container-bot-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const dir of [
      'data',
      'sample',
      'etc',
      'bin',
      'data/repo/dockerbot/.git',
      'data/repo/dockerbot/jbot',
      'data/repo/dockerbot/config',
      'other/data/jbot',
      'other/data/log',
    ])
      await fs.mkdir(path.join(root, dir), { recursive: true });
    for (const name of [
      'config.sample.sh',
      'task.sample.sh',
      'extra.sample.sh',
      'notify.py',
      'notify.js',
      'ql_sample.py',
      'ql_sample.js',
    ])
      await fs.writeFile(path.join(root, 'sample', name), '\n');
    await fs.writeFile(
      path.join(root, 'sample/config.sample.sh'),
      'AutoStartBot=true\n',
    );
    // Isolate package provisioning; execute the real installer, Python launcher
    // and detached admin entry against a local module that never uses Telegram.
    for (const name of ['apk', 'sudo', 'pip3'])
      await fs.writeFile(path.join(root, 'bin', name), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
    const python =
      'import os,time\nfrom pathlib import Path\nPath(os.environ["FIXTURE_PID"]).write_text(str(os.getpid()))\nwhile True: time.sleep(1)\n';
    await fs.writeFile(
      path.join(root, 'data/repo/dockerbot/jbot/__main__.py'),
      python,
    );
    await fs.writeFile(
      path.join(root, 'data/repo/dockerbot/jbot/requirements.txt'),
      '',
    );
    await fs.writeFile(
      path.join(root, 'data/repo/dockerbot/config/bot.json'),
      '{}',
    );
    await fs.writeFile(path.join(root, 'other/data/jbot/__main__.py'), python);
    const env = {
      PATH: `${root}/bin:${process.env.PATH}`,
      HOME: root,
      QL_OS_TYPE: 'alpine',
      QL_SCHEDULER: 'node',
      FIXTURE_PID: path.join(root, 'bot.pid'),
    };
    const context = createContext({ root }, env);
    const foreign = createContext(
      { root: path.join(root, 'other') },
      { ...env, FIXTURE_PID: path.join(root, 'foreign.pid') },
    );
    const foreignBot = await launchBot(foreign);
    let ownPid, installerPid;
    const controller = new AbortController();
    let running;
    t.after(async () => {
      controller.abort('SIGTERM');
      for (const pid of [ownPid, installerPid, foreignBot.pid])
        if (pid) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      await running?.catch(() => {});
    });
    running = runContainer(context, controller.signal, {
      systemDirectory: path.join(root, 'etc'),
      services: {
        start: async () => ({ manager: 'node' }),
        stop: async () => {},
        hook: async (runtime, action) => {
          installerPid = await launchStartupHook(runtime, action);
          return installerPid;
        },
      },
    });
    await until(
      async () => !!(await fs.stat(env.FIXTURE_PID).catch(() => false)),
    );
    ownPid = Number(await fs.readFile(env.FIXTURE_PID, 'utf8'));
    assert.ok(ownPid > 1);
    await until(() => installerPid && !live(installerPid));
    assert.equal(
      live(ownPid),
      true,
      'bot must outlive its completed installer',
    );
    controller.abort('SIGTERM');
    assert.equal(await running, 143);
    await until(() => !live(ownPid));
    assert.equal(
      live(foreignBot.pid),
      true,
      'other installation must remain running',
    );
  },
);

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createContext } = require('../../dist/local/context');
const {
  installAndStartBot,
  launchBot,
  stopBot,
} = require('../../dist/local/bot');
assert.equal(process.env.QL_PANEL_INTEGRATION, '1');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-bot-online-'));
  const foreignRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-bot-other-'));
  const source = path.join(root, 'source');
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PIP_DEFAULT_TIMEOUT: '30',
    PIP_RETRIES: '0',
  };
  const ctx = createContext({ root }, { ...env, BotRepoUrl: source });
  const other = createContext({ root: foreignRoot }, env);
  const program = (version) =>
    `import time, colorama\nprint('${version}:'+colorama.__version__,flush=True)\nwhile True: time.sleep(0.1)\n`;
  try {
    await fs.mkdir(path.join(source, 'jbot'), { recursive: true });
    await fs.mkdir(path.join(source, 'config'));
    await fs.writeFile(
      path.join(source, 'config/bot.json'),
      '{"fixture":"default"}',
    );
    await fs.writeFile(
      path.join(source, 'jbot/requirements.txt'),
      'colorama==0.4.6\n',
    );
    await fs.writeFile(path.join(source, 'jbot/__main__.py'), program('FIRST'));
    const git = (...args) =>
      execFileSync('git', ['-C', source, ...args], { stdio: 'ignore' });
    git('init', '-b', 'main');
    git('add', '.');
    git(
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture',
    );
    const first = await installAndStartBot(ctx);
    const oldPid = first.result.service.pid;
    assert.match(
      await fs.readFile(path.join(ctx.paths.dir_log, 'bot/nohup.log'), 'utf8'),
      /FIRST:0.4.6/,
    );
    await fs.mkdir(path.join(other.data, 'jbot'), { recursive: true });
    await fs.writeFile(
      path.join(other.data, 'jbot/__main__.py'),
      program('OTHER'),
    );
    const otherPid = (await launchBot(other)).pid;
    await fs.writeFile(
      path.join(ctx.paths.dir_config, 'bot.json'),
      '{"fixture":"preserve"}',
    );
    await fs.writeFile(
      path.join(first.repository, 'jbot/__main__.py'),
      program('SECOND'),
    );
    const second = await installAndStartBot(ctx);
    assert.notEqual(second.result.service.pid, oldPid);
    assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
    process.kill(otherPid, 0);
    assert.match(
      await fs.readFile(path.join(ctx.paths.dir_log, 'bot/nohup.log'), 'utf8'),
      /SECOND:0.4.6/,
    );
    assert.equal(
      await fs.readFile(path.join(ctx.paths.dir_config, 'bot.json'), 'utf8'),
      '{"fixture":"preserve"}',
    );
    await stopBot(ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(second.result.service.pid, 0), {
      code: 'ESRCH',
    });
    process.kill(otherPid, 0);
    console.log(
      JSON.stringify({
        dependencyInstalled: true,
        started: true,
        replaced: true,
        configurationPreserved: true,
        otherInstallationSurvived: true,
        stopped: true,
      }),
    );
  } finally {
    for (const context of [ctx, other]) {
      if (await fs.stat(context.data).catch(() => undefined))
        await stopBot(context);
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(foreignRoot, { recursive: true, force: true });
  }
})().catch(() => {
  console.error('Bot installation integration test failed; raw subprocess errors are omitted to protect environment credentials.');
  process.exitCode = 1;
});

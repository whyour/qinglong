const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

exports.verifyRepository = async function verifyRepository(api, cli) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-repository-gate-'));
  const repository = path.join(root, 'fixture');
  await fs.mkdir(repository);
  const git = (...args) =>
    execFileSync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-b', 'main');
  git('config', 'user.name', 'CLI fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(
    path.join(repository, 'job-wrong.js'),
    'console.log("WRONG_BRANCH")',
  );
  git('add', '.');
  git('commit', '-m', 'main');
  git('checkout', '-b', 'selected');
  await fs.rm(path.join(repository, 'job-wrong.js'));
  await fs.writeFile(
    path.join(repository, 'shared.js'),
    'module.exports="DEPENDENCY_OK";',
  );
  await fs.writeFile(
    path.join(repository, 'job-keep.js'),
    '// cron: 0 0 1 1 *\nconsole.log(require("./shared"));',
  );
  await fs.writeFile(
    path.join(repository, 'job-old.js'),
    '// cron: 0 0 1 1 *\nconsole.log("old");',
  );
  await fs.writeFile(
    path.join(repository, 'job-excluded.js'),
    'throw Error("excluded");',
  );
  git('add', '.');
  git('commit', '-m', 'selected');
  let subscription;
  const tasks = () =>
    cli(['task', 'list']).data.data.filter(
      (row) => row.sub_id === subscription.id,
    );
  try {
    subscription = (
      await api('subscriptions', 'POST', {
        name: 'CLI repository integration',
        alias: 'cli-repository-integration',
        type: 'public-repo',
        url: pathToFileURL(repository).href,
        branch: 'selected',
        whitelist: 'job-',
        blacklist: 'excluded',
        dependences: 'shared',
        extensions: 'js',
        schedule_type: 'crontab',
        schedule: '0 0 1 1 *',
        autoAddCron: true,
        autoDelCron: true,
      })
    ).data;
    const run = async (added, removed) => {
      cli(['subscription', 'run', String(subscription.id)]);
      let log = '';
      for (let i = 0; i < 80; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        log = cli(['subscription', 'logs', String(subscription.id)]).data;
        if (log.includes(`"added":${added},"removed":${removed}`)) return;
      }
      assert.fail(`Repository sync did not finish: ${log}`);
    };
    await run(2, 0);
    let rows = tasks();
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.command.endsWith('/job-old.js')));
    const keep = rows.find((row) => row.command.endsWith('/job-keep.js'));
    assert.ok(keep);
    const directory = path.dirname(`/ql/data/scripts/${keep.command.slice(5)}`);
    assert.match(
      await fs.readFile(path.join(directory, 'shared.js'), 'utf8'),
      /DEPENDENCY_OK/,
    );
    await assert.rejects(fs.access(path.join(directory, 'job-wrong.js')));
    await assert.rejects(fs.access(path.join(directory, 'job-excluded.js')));
    cli(['task', 'run', String(keep.id)]);
    let taskLog = '';
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      taskLog = cli(['task', 'logs', String(keep.id)]).data;
      if (taskLog.includes('DEPENDENCY_OK') && /完成|执行结束/.test(taskLog))
        break;
    }
    assert.match(taskLog, /DEPENDENCY_OK/);
    await fs.rm(path.join(repository, 'job-old.js'));
    await fs.writeFile(
      path.join(repository, 'job-new.js'),
      '// cron: 0 0 1 1 *\nconsole.log("new");',
    );
    git('add', '-A');
    git('commit', '-m', 'replace task');
    await run(1, 1);
    rows = tasks();
    assert.equal(rows.length, 2);
    assert.equal(
      rows.find((row) => row.command.endsWith('/job-keep.js')).id,
      keep.id,
    );
    assert.ok(rows.some((row) => row.command.endsWith('/job-new.js')));
    assert.ok(!rows.some((row) => row.command.endsWith('/job-old.js')));
    await assert.rejects(fs.access(path.join(directory, 'job-old.js')));
    return true;
  } finally {
    if (subscription) {
      const rows = tasks();
      if (rows.length)
        await api(
          'crons',
          'DELETE',
          rows.map((row) => row.id),
        );
      await api('subscriptions', 'DELETE', [subscription.id]);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
};

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');

exports.verifySubscription = async function verifySubscription(api, cli) {
  const marker = 'CLI_SUBSCRIPTION_PANEL_MARKER';
  const server = http.createServer((req, res) =>
    res.end(`// cron: 0 0 1 1 *\nconsole.log('${marker}');\n`),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let subscription;
  let generated = [];
  try {
    subscription = (
      await api('subscriptions', 'POST', {
        name: 'CLI raw integration',
        alias: 'cli-raw-integration',
        type: 'file',
        url: `http://127.0.0.1:${server.address().port}/fixture.js`,
        schedule_type: 'crontab',
        schedule: '0 0 1 1 *',
        autoAddCron: true,
        autoDelCron: false,
      })
    ).data;
    const id = String(subscription.id);
    assert.equal(cli(['subscription', 'run', id]).data.accepted, true);
    let log = '';
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      log = cli(['subscription', 'logs', id]).data;
      if (log.includes('"added":1')) break;
    }
    assert.match(log, /"added":1/, log);
    assert.doesNotMatch(log, /reporting failed/);
    generated = cli(['task', 'list']).data.data.filter(
      (row) => row.sub_id === subscription.id,
    );
    assert.equal(generated.length, 1);
    const task = generated[0];
    assert.match(task.command, /^task raw_/);
    assert.match(
      await fs.readFile(`/ql/data/scripts/${task.command.slice(5)}`, 'utf8'),
      new RegExp(marker),
    );
    cli(['task', 'run', String(task.id)]);
    let taskLog = '';
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      taskLog = cli(['task', 'logs', String(task.id)]).data;
      if (taskLog.includes(marker) && /完成|执行结束/.test(taskLog)) break;
    }
    assert.match(taskLog, new RegExp(marker));
    assert.match(taskLog, /完成|执行结束/);
    return true;
  } finally {
    if (generated.length)
      await api(
        'crons',
        'DELETE',
        generated.map((row) => row.id),
      );
    if (subscription) await api('subscriptions', 'DELETE', [subscription.id]);
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
};

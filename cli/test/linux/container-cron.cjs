// Run only in a fresh disposable panel started by dist/container.js, system mode.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createContext } = require('../../dist/internal/runtime/context');
const { LocalApi } = require('../../dist/internal/runtime/api');

(async () => {
  assert.equal(process.env.QL_PANEL_INTEGRATION, '1');
  assert.equal(process.env.QL_SCHEDULER, 'system');
  const api = new LocalApi(createContext({ root: '/ql' }, process.env));
  const filename = `container-cron-${randomUUID()}.js`;
  const script = path.join('/ql/data/scripts', filename);
  await fs.writeFile(
    script,
    `const fs=require('node:fs');const chain=[];let pid=process.pid;while(pid>0&&chain.length<12){try{const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0').filter(Boolean);chain.push({pid,argv});const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');pid=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);}catch{break}}console.log('CRON_ANCESTRY='+JSON.stringify(chain));\n`,
  );
  let task;
  try {
    task = (
      await api.call('crons', 'POST', {
        name: 'Disposable real crond fixture',
        command: `task ${filename}`,
        schedule: '* * * * *',
      })
    ).data;
    assert.ok(task.id);
    const table = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    assert.equal(table.status, 0, table.stderr);
    assert.ok(
      table.stdout
        .split('\n')
        .some((line) => !line.startsWith('#') && line.includes(filename)),
      'panel must install task in real crontab',
    );
    console.log(
      JSON.stringify({ event: 'waiting-for-crond', taskId: task.id }),
    );
    let chain;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const log = (await api.call(`crons/${task.id}/log`)).data;
      const match = typeof log === 'string' && log.match(/CRON_ANCESTRY=(.*)/);
      if (match) {
        chain = JSON.parse(match[1]);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(
      chain,
      'real minute tick must produce task output without a run API call',
    );
    assert.ok(
      chain.some(({ argv }) => path.basename(argv[0] || '') === 'crond'),
      'ancestry must include actual crond',
    );
    const runner = chain.find(
      ({ argv }) =>
        path.basename(argv[0] || '') === 'node' &&
        ['/root/bin/task', '/opt/qinglong-cli/bin/task'].includes(argv[1]),
    );
    assert.ok(runner, 'scheduled task must execute the selected Node wrapper');
    if (runner.argv[1] === '/root/bin/task') {
      assert.match(
        await fs.readFile(runner.argv[1], 'utf8'),
        /\/opt\/qinglong-cli\/dist\/task.js/,
      );
    } else {
      assert.equal(
        await fs.realpath(runner.argv[1]),
        '/opt/qinglong-cli/dist/task.js',
      );
    }
    assert.ok(
      chain.some(({ argv }) =>
        argv.includes('/opt/qinglong-cli/dist/container.js'),
      ),
      'scheduler must descend from the TS container entry',
    );
    console.log(
      JSON.stringify({
        realCrondMinuteTick: true,
        tsRunner: true,
        persistedLog: true,
        tsContainerAncestor: true,
      }),
    );
  } finally {
    if (task) await api.call('crons', 'DELETE', [task.id]);
    await fs.rm(script, { force: true });
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

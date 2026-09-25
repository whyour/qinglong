const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { createContext } = require('/opt/qinglong-cli/dist/local/context');
const { LocalApi } = require('/opt/qinglong-cli/dist/local/api');
assert.equal(process.env.QL_PANEL_INTEGRATION, '1');
(async () => {
  const api = new LocalApi(createContext({ root: '/ql' }, process.env));
  await fs.writeFile(
    '/ql/data/scripts/image-selection.js',
    'console.log("IMAGE_PARENT="+JSON.stringify(require("node:fs").readFileSync("/proc/"+process.ppid+"/cmdline","utf8").split("\\0")));',
  );
  const task = (
    await api.call('crons', 'POST', {
      name: 'image selection fixture',
      command: 'task image-selection.js',
      schedule: '0 0 1 1 *',
    })
  ).data;
  try {
    await api.call('crons/run', 'PUT', [task.id]);
    let log = '';
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      log = (await api.call(`crons/${task.id}/log`)).data;
      if (log.includes('IMAGE_PARENT=')) break;
    }
    const parent = JSON.parse(log.match(/IMAGE_PARENT=(.*)/)[1]);
    assert.match(parent[0], /(?:^|\/)node$/);
    assert.equal(parent[1], '/root/bin/task');
    assert.match(
      await fs.readFile('/root/bin/task', 'utf8'),
      /\/opt\/qinglong-cli\/dist\/task.js/,
    );
    const reload = spawnSync('ql', ['reload'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(reload.status, 0, reload.stderr);
    assert.equal(JSON.parse(reload.stdout).code, 200);
    let healthy = false;
    for (let i = 0; i < 50; i++) {
      try {
        healthy =
          (
            await (
              await fetch('http://127.0.0.1:5700/api/system', {
                signal: AbortSignal.timeout(1000),
              })
            ).json()
          ).code === 200;
      } catch {}
      if (healthy) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(healthy);
    const help = spawnSync('ql', ['--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /ql-compat/);
    console.log(
      JSON.stringify({
        packagedTaskScheduled: true,
        packagedReload: true,
        healthyAfterReload: true,
        selectionRetained: true,
      }),
    );
  } finally {
    await api.call('crons', 'DELETE', [task.id]);
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

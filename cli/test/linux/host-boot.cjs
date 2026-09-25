// Run as root only inside the disposable QEMU host-startup fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createContext } = require('../../dist/internal/runtime/context');
const { LocalApi } = require('../../dist/internal/runtime/api');

(async () => {
  assert.equal(process.env.QL_HOST_INTEGRATION, '1');
  const mode = process.argv[2];
  assert.ok(['before', 'after'].includes(mode));
  const stateFile = '/var/lib/ql-host-fixture.json';
  const boot = (
    await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')
  ).trim();
  const api = new LocalApi(createContext({ root: '/ql' }, process.env));
  const deadline = Date.now() + 45000;
  let system;
  while (Date.now() < deadline) {
    try {
      system = (await api.call('system')).data;
      break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(system, 'panel must become available without manual service start');
  const osRelease = await fs.readFile('/etc/os-release', 'utf8');
  const systemd = /^ID=(?:"?)(?:debian|ubuntu)(?:"?)$/m.test(osRelease);
  for (const service of mode === 'after' ? ['nginx', 'crond'] : ['crond'])
    execFileSync(
      systemd ? 'systemctl' : 'rc-service',
      systemd
        ? ['is-active', service === 'crond' ? 'cron' : service]
        : [service, 'status'],
      { stdio: 'pipe' },
    );
  const nginxPid = Number(
    (await fs.readFile(systemd ? '/run/nginx.pid' : '/run/nginx/nginx.pid', 'utf8')).trim(),
  );
  assert.ok(Number.isSafeInteger(nginxPid) && nginxPid > 1);
  process.kill(nginxPid, 0);
  assert.match(await fs.readFile(`/proc/${nginxPid}/comm`, 'utf8'), /^nginx/);
  if (mode === 'before') {
    const filename = `host-reboot-${randomUUID()}.js`;
    await fs.writeFile(
      `/ql/data/scripts/${filename}`,
      'console.log("HOST_REBOOT_TASK_OK:"+require("node:fs").readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim());',
    );
    const task = (
      await api.call('crons', 'POST', {
        name: 'Disposable host reboot task',
        command: `task ${filename}`,
        schedule: '* * * * *',
      })
    ).data;
    await fs.writeFile(stateFile, JSON.stringify({ boot, task, filename }), {
      mode: 0o600,
      flag: 'wx',
    });
    console.log(
      JSON.stringify({
        beforeBootId: boot,
        taskCreated: true,
        version: system.version,
      }),
    );
  } else {
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.notEqual(boot, state.boot, 'kernel boot ID must change');
    const task = (await api.call(`crons/${state.task.id}`)).data;
    assert.equal(task.command, state.task.command);
    let log = '';
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      log = (await api.call(`crons/${task.id}/log`)).data || '';
      if (
        log.includes(`HOST_REBOOT_TASK_OK:${boot}`) &&
        /完成|执行结束/.test(log)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(
      log.includes(`HOST_REBOOT_TASK_OK:${boot}`),
      'crond must run the retained task during this boot without a run API call',
    );
    assert.match(log, /完成|执行结束/);
    console.log(
      JSON.stringify({
        afterBootId: boot,
        automaticPanelStartup: true,
        initSystem: systemd ? 'systemd' : 'openrc',
        taskRetained: true,
        taskExecuted: true,
        nginxStarted: true,
        crondStarted: true,
        automaticMinuteTick: true,
        version: system.version,
      }),
    );
    await api.call('crons', 'DELETE', [task.id]);
    await fs.rm(`/ql/data/scripts/${state.filename}`);
    await fs.rm(stateFile);
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

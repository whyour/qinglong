// Used only after start --no-startup in a disposable container without its old entrypoint.
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(process.env.QL_PANEL_INTEGRATION, '1');
(async () => {
  const result = JSON.parse(fs.readFileSync('/tmp/start-result.json', 'utf8'));
  assert.equal(result.code, 200);
  assert.equal(result.data.mode, 'install');
  assert.equal(result.data.startup, 'skipped');
  assert.equal(result.data.service.manager, 'pm2');
  const response = await fetch('http://127.0.0.1:5700/api/system', {
    signal: AbortSignal.timeout(5000),
  });
  const system = await response.json();
  assert.equal(system.code, 200);
  assert.equal(system.data.isInitialized, false);
  const html = await (
    await fetch('http://127.0.0.1:5700/', { signal: AbortSignal.timeout(5000) })
  ).text();
  assert.match(html, /<div\s+id=["']root["']/);
  const saved = JSON.parse(fs.readFileSync('/root/.pm2/dump.pm2', 'utf8'));
  assert.ok(saved.some((app) => app.name === 'qinglong'));
  for (const file of ['config.sh', 'task_before.sh', 'task_after.sh'])
    assert.ok(fs.existsSync(`/ql/data/config/${file}`));
  console.log(
    JSON.stringify({
      install: true,
      startupRegistration: result.data.startup,
      healthy: true,
      initialized: false,
      pm2StateSaved: true,
      configurationPrepared: true,
    }),
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

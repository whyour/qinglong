// Assertions for the disposable online check/repair scenario in README.md.
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(process.env.QL_PANEL_INTEGRATION, '1');
const result = JSON.parse(
  fs.readFileSync('/tmp/check-repair-result.json', 'utf8'),
);
assert.equal(result.code, 200);
assert.equal(result.data.after.panel.healthy, true);
assert.equal(result.data.after.backend.healthy, true);
assert.equal(result.data.service.manager, 'pm2');
assert.ok(result.data.restored.includes('/ql/data/config/task_before.sh'));
assert.deepEqual(
  fs.readFileSync('/ql/data/config/task_before.sh'),
  fs.readFileSync('/ql/sample/task.sample.sh'),
);
assert.deepEqual(
  fs.readFileSync('/ql/data/config/config.sh'),
  fs.readFileSync('/tmp/expected-config.sh'),
);
assert.deepEqual(
  fs.readFileSync('/ql/data/scripts/sendNotify.js'),
  fs.readFileSync('/ql/sample/notify.js'),
);
assert.deepEqual(
  fs.readFileSync('/ql/data/scripts/notify.py'),
  fs.readFileSync('/ql/sample/notify.py'),
);
console.log(
  JSON.stringify({
    healthy: true,
    restoredHook: true,
    preservedConfiguration: true,
    refreshedNotifications: true,
    manager: result.data.service.manager,
  }),
);

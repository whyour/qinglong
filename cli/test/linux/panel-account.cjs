const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

exports.verifyAccountMaintenance = async function verifyAccountMaintenance(
  api,
) {
  const credentials = {
    username: `renamed-${randomUUID()}`,
    password: `--${randomUUID()}`,
  };
  const local = (action, value) => {
    const result = spawnSync(
      path.join(os.homedir(), 'bin/ql'),
      [action, ...(value ? [value] : [])],
      {
        env: { ...process.env, QL_DIR: '/ql' },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0, `${action} failed: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).data.completed, true);
  };
  const login = async () => {
    const response = await fetch('http://127.0.0.1:5700/api/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(5000),
    });
    return response.json();
  };
  local('resetname', credentials.username);
  local('resetpwd', credentials.password);
  assert.equal((await login()).code, 200, 'New credentials were not saved');
  await api('system/auth/reset', 'PUT', { retries: 4 });
  assert.notEqual(
    (await login()).code,
    200,
    'Fixture failed to activate login limit',
  );
  local('resetlet');
  assert.equal((await login()).code, 200, 'Login limit was not cleared');
  await api('system/auth/reset', 'PUT', { twoFactorActivated: true });
  assert.notEqual(
    (await login()).code,
    200,
    'Fixture failed to activate second factor',
  );
  local('resettfa');
  assert.equal((await login()).code, 200, 'Second factor was not cleared');
  return true;
};

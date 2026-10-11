const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('bot integration failure does not print environment-derived error details', async () => {
  const messages = [];
  const childProcess = { env: { QL_PANEL_INTEGRATION: '1', QL_CLIENT_SECRET: 'sensitive-marker' }, exitCode: 0 };
  const source = fs.readFileSync(path.join(__dirname, '../linux/bot-install.cjs'), 'utf8');
  vm.runInNewContext(source, {
    process: childProcess,
    console: { error: (message) => messages.push(message) },
    require: (name) => {
      if (name === 'node:fs/promises') return { mkdtemp: async () => '/fixture' };
      if (name === '../../dist/internal/runtime/context') return { createContext: () => { throw new Error(childProcess.env.QL_CLIENT_SECRET); } };
      if (name === '../../dist/internal/maintenance/bot') return {};
      return require(name);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(childProcess.exitCode, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /integration test failed/);
  assert.doesNotMatch(messages[0], /sensitive-marker/);
});

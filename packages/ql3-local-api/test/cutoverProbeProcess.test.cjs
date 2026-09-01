const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  LOCAL_API_PROCESS_CONFIG_SCHEMA,
} = require('../dist/production-process/config.js');
const {
  runProductionLocalApiCutoverProbe,
} = require('../dist/production-process/cutoverProbeProcess.js');

test('validates the Local API entry config before delegating to the frozen Application probe', async () => {
  const signals = Object.freeze({
    subscribe() {
      return () => {};
    },
  });
  const events = [];
  let calls = 0;
  const result = await runProductionLocalApiCutoverProbe(
    {
      configFilePath: '/srv/qinglong/private/api.json',
      signals,
      emit(event) {
        events.push(event);
      },
    },
    {
      readConfig(filePath) {
        assert.equal(filePath, '/srv/qinglong/private/api.json');
        return Object.freeze({
          schema: LOCAL_API_PROCESS_CONFIG_SCHEMA,
          deploymentRoot: '/srv/qinglong',
          applicationConfigFilePath: '/srv/qinglong/private/application.json',
          ownerPepperKeyringDirectory: '/srv/qinglong/private/owner-pepper',
          listener: Object.freeze({ host: '127.0.0.1', port: 5701 }),
        });
      },
      async runApplicationProbe(options) {
        calls += 1;
        assert.equal(
          options.configFilePath,
          '/srv/qinglong/private/application.json',
        );
        assert.equal(options.signals, signals);
        await options.emit({ event: 'cutover_probe_active' });
        return 'stopped';
      },
    },
  );
  assert.equal(result, 'stopped');
  assert.equal(calls, 1);
  assert.deepEqual(events, [{ event: 'cutover_probe_active' }]);
});

test('rejects malformed adapters before reading any authority', async () => {
  await assert.rejects(
    runProductionLocalApiCutoverProbe(
      {
        configFilePath: '/srv/qinglong/private/api.json',
        signals: Object.freeze({
          subscribe() {
            return () => {};
          },
        }),
        emit() {},
      },
      {},
    ),
    /adapters are invalid/,
  );
});

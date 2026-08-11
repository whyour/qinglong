const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  LOCAL_API_PROCESS_CONFIG_SCHEMA,
} = require('../dist/production-process/config.js');
const {
  runProductionLocalApiProcess,
} = require('../dist/production-process/processApplication.js');

test('injects the HTTP surface into exactly one Local Application process', async () => {
  const events = [];
  const signals = Object.freeze({ subscribe() { return () => {}; } });
  const emit = (event) => events.push(event);
  let applicationCalls = 0;
  const result = await runProductionLocalApiProcess(
    {
      configFilePath: '/srv/qinglong/private/api.json',
      signals,
      emit,
    },
    {
      readConfig(configFilePath) {
        assert.equal(configFilePath, '/srv/qinglong/private/api.json');
        return Object.freeze({
          schema: LOCAL_API_PROCESS_CONFIG_SCHEMA,
          deploymentRoot: '/srv/qinglong',
          applicationConfigFilePath:
            '/srv/qinglong/private/application.json',
          ownerPepperKeyringDirectory:
            '/srv/qinglong/private/owner-pepper',
          listener: Object.freeze({ host: '127.0.0.1', port: 5701 }),
        });
      },
      async runApplication(options) {
        applicationCalls += 1;
        assert.equal(
          options.configFilePath,
          '/srv/qinglong/private/application.json',
        );
        assert.equal(options.signals, signals);
        assert.equal(options.emit, emit);
        assert.equal(typeof options.productSurface.start, 'function');
        return 'stopped';
      },
    },
  );
  assert.equal(result, 'stopped');
  assert.equal(applicationCalls, 1);
  assert.deepEqual(events, []);
});

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  LOCAL_API_PROCESS_CONFIG_SCHEMA,
  LocalApiProcessConfigError,
  normalizeLocalApiProcessConfig,
} = require('../dist/production-process/config.js');

function candidate(overrides = {}) {
  return {
    schema: LOCAL_API_PROCESS_CONFIG_SCHEMA,
    deploymentRoot: '/srv/qinglong',
    applicationConfigFilePath: '/srv/qinglong/private/application.json',
    ownerPepperKeyringDirectory: '/srv/qinglong/private/owner-pepper',
    listener: { host: '127.0.0.1', port: 5701 },
    ...overrides,
  };
}

test('normalizes one exact loopback-only Local API process configuration', () => {
  assert.deepEqual(normalizeLocalApiProcessConfig(candidate()), candidate());
  assert.deepEqual(
    normalizeLocalApiProcessConfig(
      candidate({ listener: { host: '::1', port: 65535 } }),
    ).listener,
    { host: '::1', port: 65535 },
  );
});

test('rejects remote listeners, privileged ports and path authority escapes', () => {
  for (const value of [
    candidate({ listener: { host: '0.0.0.0', port: 5701 } }),
    candidate({ listener: { host: '127.0.0.1', port: 80 } }),
    candidate({ applicationConfigFilePath: '/srv/application.json' }),
    candidate({ ownerPepperKeyringDirectory: '/srv/qinglong' }),
    { ...candidate(), unexpected: true },
  ]) {
    assert.throws(
      () => normalizeLocalApiProcessConfig(value),
      LocalApiProcessConfigError,
    );
  }
});

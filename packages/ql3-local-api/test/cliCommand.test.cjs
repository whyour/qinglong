const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  localApiCliFailureFact,
  parseLocalApiCliCommand,
} = require('../dist/production-process/cliCommand.js');

test('parses only the normal API and frozen cutover-probe commands', () => {
  assert.deepEqual(parseLocalApiCliCommand(['--config', '/private/api.json']), {
    configFilePath: '/private/api.json',
    mode: 'api',
  });
  assert.deepEqual(
    parseLocalApiCliCommand([
      '--cutover-probe',
      '--config',
      '/private/api.json',
    ]),
    {
      configFilePath: '/private/api.json',
      mode: 'cutover_probe',
    },
  );
  for (const argv of [
    [],
    ['--cutover-probe', '/private/api.json'],
    ['--config', '/private/api.json', '--cutover-probe'],
    ['--cutover-probe', '--config', ''],
  ]) {
    assert.equal(parseLocalApiCliCommand(argv), null);
  }
});

test('publishes bounded Local API failure facts', () => {
  assert.deepEqual(
    localApiCliFailureFact(
      Object.assign(new Error('secret detail'), { code: 'QL3_TEST' }),
    ),
    {
      schemaVersion: 1,
      component: 'qinglong3-local-api',
      level: 'error',
      event: 'process_failed',
      name: 'Error',
      code: 'QL3_TEST',
    },
  );
});

const assert = require('node:assert/strict');
const test = require('node:test');

const configPath = require.resolve('../../ecosystem.config');

function loadConfig(containerValue) {
  if (containerValue === undefined) {
    delete process.env.QL_CONTAINER;
  } else {
    process.env.QL_CONTAINER = containerValue;
  }
  delete require.cache[configPath];
  return require(configPath).apps[0];
}

test('container logging goes to the container standard streams', () => {
  const app = loadConfig('true');
  assert.equal(app.out_file, '/proc/1/fd/1');
  assert.equal(app.error_file, '/proc/1/fd/2');
  assert.equal(app.time, false);
});

test('non-container installs keep the PM2 logging defaults', () => {
  const app = loadConfig(undefined);
  assert.equal(app.out_file, undefined);
  assert.equal(app.error_file, undefined);
  assert.equal(app.time, true);
});

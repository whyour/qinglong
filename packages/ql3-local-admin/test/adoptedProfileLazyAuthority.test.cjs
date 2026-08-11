const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('keeps adopted activation authority unloaded until the capability is enabled', () => {
  const entrypoint = path.resolve(
    __dirname,
    '../dist/adopted-profile/localAdoptedProfile.js',
  );
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(entrypoint)});
       const loaded = Object.keys(require.cache).filter((file) =>
         /[\\/]ql3-local-admin[\\/]dist[\\/](?:runtime|legacy-adoption[\\/])/.test(file),
       );
       process.stdout.write(JSON.stringify(loaded));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

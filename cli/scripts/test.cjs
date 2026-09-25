const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../test');
const files = [
  'remote',
  'internal',
  'shared',
  'compatibility',
  'integration',
].flatMap((group) =>
  fs
    .readdirSync(path.join(root, group))
    .filter((name) => name.endsWith('.test.cjs'))
    .sort()
    .map((name) => path.join(root, group, name)),
);
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

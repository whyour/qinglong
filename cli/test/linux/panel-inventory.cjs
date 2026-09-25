const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
(async () => {
  assert.equal(process.env.QL_PANEL_INTEGRATION, '1');
  assert.equal(process.env.QL_CLI_ROOT, '/opt/qinglong-cli');
  const file = `inventory-${randomUUID()}.js`;
  const target = path.join('/ql/data/scripts', file);
  await fs.writeFile(
    target,
    'throw Error("inventory must not execute");\nconst $ = new Env("Packaged inventory fixture");\n',
    { flag: 'wx' },
  );
  try {
    const result = JSON.parse(
      execFileSync(path.join(os.homedir(), 'bin/task'), ['--json'], {
        env: { ...process.env, QL_DIR: '/ql' },
        encoding: 'utf8',
        timeout: 10000,
      }),
    );
    assert.equal(result.code, 200);
    assert.deepEqual(
      result.data.scripts.find((row) => row.file === file),
      { file, name: 'Packaged inventory fixture' },
    );
    console.log(
      JSON.stringify({ packagedTaskInventory: true, scriptExecuted: false }),
    );
  } finally {
    await fs.rm(target);
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

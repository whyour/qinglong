const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// macOS has no production /proc identity. Tests with a fake identity provider
// still use real GNU utilities, so BSD semantics cannot mask Linux regressions.
function quotaEnvironment(directory) {
  if (process.platform !== 'darwin') return {};
  const bin = path.join(directory, 'quota-bin');
  fs.mkdirSync(bin, { mode: 0o700 });
  for (const [name, installed] of [['head', 'ghead'], ['stdbuf', 'stdbuf']]) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${installed}`], {
      encoding: 'utf8',
    });
    assert.equal(found.status, 0, `macOS launcher tests require coreutils ${installed}`);
    fs.symlinkSync(found.stdout.trim(), path.join(bin, name));
  }
  return { PATH: `${bin}:/usr/bin:/bin` };
}

module.exports = { quotaEnvironment };

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Run in new processes: a healthy parent can outlive a broken native runtime.
function probeNodeRuntime(executable = process.execPath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-node-url-'));
  const source = `
    const assert = require('node:assert/strict');
    const { pathToFileURL, fileURLToPath } = require('node:url');
    for (let i = 0; i < 1000; i++) {
      assert.equal(new URL('/任务?q=' + i, 'https://example.com').hostname, 'example.com');
      assert.equal(new URL('https://例子.测试').hostname, 'xn--fsqu00a.xn--0zwm56d');
      assert.equal(new URL('http://[::1]:5700').port, '5700');
      const filename = '/tmp/中文 path/' + i + '.cjs';
      assert.equal(fileURLToPath(pathToFileURL(filename)), filename);
    }
    console.log('QINGLONG_NODE_URL_OK');
  `;
  const file = path.join(directory, 'probe.cjs');
  fs.writeFileSync(file, source);
  try {
    for (let i = 0; i < 4; i++) {
      const args = process.execArgv.includes('--jitless') ? ['--jitless'] : [];
      args.push(...(i % 2 ? [file] : ['-e', source]));
      const child = spawnSync(executable, args, {
        encoding: 'utf8',
        // Multi-architecture CI runs this same probe through QEMU.
        timeout: 120000,
        maxBuffer: 65536,
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      assert.equal(
        child.status,
        0,
        `Node URL runtime probe failed (${i % 2 ? 'file' : 'eval'}): signal=${
          child.signal
        }; status=${child.status}; ${child.error?.message || child.stderr}`,
      );
      assert.match(child.stdout, /QINGLONG_NODE_URL_OK/);
    }
    return {
      ok: true,
      node: process.version,
      architecture: process.arch,
      ada: process.versions.ada,
      processes: 4,
      urlIterationsPerProcess: 1000,
      nodeSha256: createHash('sha256')
        .update(fs.readFileSync(executable))
        .digest('hex'),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { probeNodeRuntime };
if (require.main === module) console.log(JSON.stringify(probeNodeRuntime()));

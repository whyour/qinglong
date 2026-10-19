const test = require('node:test');
const assert = require('node:assert/strict');
const {
  serverRuntimeArgs,
} = require('../../cli/src/internal/maintenance/nodeRuntime.cjs');

test('server compatibility flags target ARMv6 Node 24 while retaining WebAssembly and the existing Node', () => {
  for (const [arch, armVersion, version, enabled] of [
    ['arm', '6', '24.18.1', true],
    ['arm', 6, '24.18.1', true],
    ['arm', 6, '20.18.1', false],
    ['arm', 6, '22.20.0', false],
    ['arm', 7, '24.18.1', false],
    ['arm64', undefined, '24.18.1', false],
    ['x64', undefined, '24.18.1', false],
  ]) {
    const flags = serverRuntimeArgs({
      arch,
      config: { variables: { arm_version: armVersion } },
      versions: { node: version },
    });
    assert.deepEqual(
      flags,
      enabled ? ['--no-opt', '--no-sparkplug', '--no-maglev'] : [],
    );
    assert.ok(!flags.includes('--jitless'));
  }
});

test('the normal PM2 application uses the same server arguments as prestart', () => {
  const app = require('../../ecosystem.config.js').apps.find(
    (x) => x.name === 'qinglong',
  );
  const flags = serverRuntimeArgs();
  assert.deepEqual(app.node_args || [], flags);
  if (!flags.length) assert.equal(app.node_args, undefined);
});

test('ARMv6 server flags retain real HTTP, fetch and undici parsing', () => {
  const { spawnSync } = require('node:child_process');
  const flags = serverRuntimeArgs({
    arch: 'arm',
    config: { variables: { arm_version: 6 } },
    versions: { node: '24.18.1' },
  });
  const result = spawnSync(
    process.execPath,
    [
      ...flags,
      '-e',
      `
    const http=require('http'),assert=require('assert/strict');
    assert.equal(typeof WebAssembly,'object');
    const server=http.createServer((req,res)=>res.end('parser-ok'));
    server.listen(0,'127.0.0.1',async()=>{
      try {
        const url='http://127.0.0.1:'+server.address().port;
        assert.equal(await (await fetch(url)).text(),'parser-ok');
        assert.equal(await (await require('undici').request(url)).body.text(),'parser-ok');
      } catch(e){console.error(e);process.exitCode=1;}
      finally{server.closeAllConnections();server.close();}
    });
  `,
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '' },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

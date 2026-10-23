const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { rebuildMigrationSqlite, assertArmv6Addon } = require('../../scripts/rebuild-migration-sqlite.cjs');

const armv6 = 'Tag_CPU_arch: v6\nTag_THUMB_ISA_use: Thumb-1\nTag_FP_arch: VFPv2\nTag_ABI_VFP_args: VFP registers\n';
const target = { arch: 'armv6', libc: 'musl' };

test('rejects the actual legacy ARMv7/Thumb-2/VFPv3 prebuild on ARM1176', () => {
  assert.throws(() => assertArmv6Addon('Tag_CPU_arch: v7\nTag_THUMB_ISA_use: Thumb-2\nTag_FP_arch: VFPv3-D16\nTag_ABI_VFP_args: VFP registers\n'), /ARMv6 hard-float/);
  for (const attributes of ['', armv6.replace('VFPv2', 'VFPv3'), armv6.replace('Thumb-1', 'Thumb-2'), armv6.replace('VFP registers', 'Base AAPCS')])
    assert.throws(() => assertArmv6Addon(attributes), /ARMv6 hard-float/);
  assert.doesNotThrow(() => assertArmv6Addon(armv6));
});

test('does not inspect or modify any other architecture, libc or Node version', async () => {
  for (const arch of ['x64', 'armv7', 'arm64', 'ia32', 's390x', 'ppc64'])
    for (const node of ['20.20.2', '22.17.0', '24.18.1'])
      assert.equal(await rebuildMigrationSqlite('/must-not-exist', { target: { arch, libc: 'musl' }, runtime: { versions: { node } }, run: () => { throw new Error('unexpected command'); } }), false);
  assert.equal(await rebuildMigrationSqlite('/must-not-exist', { target: { arch: 'armv6', libc: 'glibc' } }), false);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-bridge-armv6-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['node_modules/sqlite3', 'node_modules/@mapbox/node-pre-gyp/bin', 'node_modules/node-gyp/bin', 'runtime/include/node', 'runtime/bin'])
    await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(root + '/package.json', JSON.stringify({ qinglongMigrationBridge: { format: 1 }, dependencies: { sqlite3: 'legacy' } }));
  await fs.writeFile(root + '/pnpm-lock.yaml', 'fixed legacy lock');
  await fs.writeFile(root + '/node_modules/sqlite3/package.json', '{}');
  await fs.writeFile(root + '/node_modules/@mapbox/node-pre-gyp/bin/node-pre-gyp', '');
  await fs.writeFile(root + '/node_modules/node-gyp/bin/node-gyp.js', '');
  await fs.writeFile(root + '/runtime/include/node/node_version.h', '#define NODE_MAJOR_VERSION 24\n#define NODE_MINOR_VERSION 18\n#define NODE_PATCH_VERSION 1\n');
  return { root, runtime: { execPath: root + '/runtime/bin/node', versions: { node: '24.18.1' }, env: { PATH: '/qa/bin', NODE_OPTIONS: '--require=untrusted', CFLAGS: '-march=armv7' } } };
}

test('rebuilds only the bridge addon with matching local headers, bounded jobs and ARMv6 flags', async (t) => {
  const { root, runtime } = await fixture(t);
  const calls = [];
  await rebuildMigrationSqlite(root, { target, runtime, run: async (program, args, options) => {
    calls.push({ program, args, options });
    return { stdout: armv6 };
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].program, runtime.execPath);
  assert(calls[0].args.includes('--build-from-source'));
  assert(calls[0].args.includes('--napi_build_version=6'));
  assert(calls[0].args.includes('--nodedir=' + root + '/runtime'));
  assert.equal(calls[0].options.cwd, await fs.realpath(root + '/node_modules/sqlite3'));
  assert.equal(calls[0].options.env.MAKEFLAGS, '-j1');
  assert.equal(calls[0].options.env.NODE_OPTIONS, '--jitless --max-old-space-size=256');
  assert.equal(calls[0].options.env.CXXFLAGS, '-march=armv6 -mfpu=vfp -mfloat-abi=hard');
  assert.equal(calls[0].options.timeout, 1800000);
  assert.equal(calls[1].program, 'readelf');
  assert.equal(await fs.readFile(root + '/pnpm-lock.yaml', 'utf8'), 'fixed legacy lock');
});

for (const fault of ['runtime-package', 'headers', 'compiler', 'armv7-output', 'lock-change'])
  test('fails closed for bridge rebuild fault: ' + fault, async (t) => {
    const { root, runtime } = await fixture(t);
    if (fault === 'runtime-package') await fs.writeFile(root + '/package.json', JSON.stringify({ dependencies: { '@mikro-orm/sql': '7' } }));
    if (fault === 'headers') runtime.versions.node = '22.17.0';
    let commands = 0;
    await assert.rejects(rebuildMigrationSqlite(root, { target, runtime, run: async () => {
      commands++;
      if (fault === 'compiler') throw new Error('compiler failed');
      if (fault === 'lock-change') await fs.appendFile(root + '/pnpm-lock.yaml', 'changed');
      return { stdout: fault === 'armv7-output' ? armv6.replace('v6', 'v7') : armv6 };
    } }), /Only a legacy|matching the existing Node|compiler failed|ARMv6 hard-float|changed the frozen lockfile/);
    if (['runtime-package', 'headers'].includes(fault)) assert.equal(commands, 0);
  });

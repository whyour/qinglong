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

test('accepts the actual Alpine GCC ARMv6KZ CRT while retaining ARM1176 instruction limits', () => {
  const crt = 'Tag_CPU_name: "6KZ"\nTag_CPU_arch: v6KZ\nTag_ARM_ISA_use: Yes\nTag_THUMB_ISA_use: Thumb-1\nTag_FP_arch: VFPv2\nTag_ABI_VFP_args: VFP registers\n';
  for (const arch of ['v6KZ', 'v6ZK', 'v6K'])
    assert.doesNotThrow(() => assertArmv6Addon(crt.replace('v6KZ', arch)));
  for (const attributes of [crt.replace('v6KZ', 'v6T2'), crt.replace('v6KZ', 'v7'), crt.replace('Thumb-1', 'Thumb-2'), crt.replace('VFPv2', 'VFPv3-D16'), crt + 'Tag_Advanced_SIMD_arch: NEONv1\n'])
    assert.throws(() => assertArmv6Addon(attributes), /ARMv6 hard-float/);
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
  for (const name of ['node_modules/sqlite3', 'runtime/include/node', 'runtime/bin'])
    await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(root + '/package.json', JSON.stringify({ qinglongMigrationBridge: { format: 1 }, dependencies: { sqlite3: 'legacy' } }));
  await fs.writeFile(root + '/pnpm-lock.yaml', 'fixed legacy lock');
  await fs.writeFile(root + '/node_modules/sqlite3/package.json', '{}');
  await fs.writeFile(root + '/runtime/include/node/node_version.h', '#define NODE_MAJOR_VERSION 24\n#define NODE_MINOR_VERSION 18\n#define NODE_PATCH_VERSION 1\n');
  return { root, runtime: { execPath: root + '/runtime/bin/node', versions: { node: '24.18.1' }, env: { PATH: '/qa/bin', NODE_OPTIONS: '--require=untrusted', CFLAGS: '-march=armv7' } } };
}

test('uses frozen repair even when the legacy image has no optional node-gyp', async (t) => {
  const { root, runtime } = await fixture(t);
  const calls = [];
  let repaired = false;
  await rebuildMigrationSqlite(root, { target, runtime, repair: async (source, options) => {
    assert.equal(source, root);
    assert.equal(options.target, target);
    assert.equal(options.env, runtime.env);
    repaired = true;
  }, run: async (program, args, options) => {
    assert.equal(repaired, true);
    calls.push({ program, args, options });
    return { stdout: armv6 };
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, 'readelf');
  assert(calls[0].args[1].endsWith('/lib/binding/napi-v6-linux-arm/node_sqlite3.node'));
  assert.equal(await fs.readFile(root + '/pnpm-lock.yaml', 'utf8'), 'fixed legacy lock');
});

test('removes node-pre-gyp build directories and external compiler links while retaining the runtime addon', async (t) => {
  const { root, runtime } = await fixture(t);
  const sqlite = path.join(root, 'node_modules/sqlite3');
  const addon = path.join(sqlite, 'lib/binding/napi-v6-linux-arm/node_sqlite3.node');
  await fs.mkdir(path.dirname(addon), { recursive: true });
  await fs.writeFile(addon, 'compiled ARM1176 addon');
  const statics = path.join(root, 'static');
  await fs.mkdir(statics);
  const { inventory } = require('../../cli/src/internal/maintenance/platformBundle.cjs');
  for (const name of ['build', 'build-tmp-napi-v3', 'build-tmp-napi-v6']) {
    const directory = path.join(sqlite, name, 'node_gyp_bins');
    await fs.mkdir(directory, { recursive: true });
    await fs.symlink('/usr/bin/python3', path.join(directory, 'python3'));
  }
  await assert.rejects(inventory({ source: root, static: statics }), /Bundle link escapes/);
  await rebuildMigrationSqlite(root, {
    target, runtime,
    repair: async () => {},
    run: async () => ({ stdout: armv6 }),
  });
  assert.equal(await fs.readFile(addon, 'utf8'), 'compiled ARM1176 addon');
  for (const name of ['build', 'build-tmp-napi-v3', 'build-tmp-napi-v6'])
    await assert.rejects(fs.access(path.join(sqlite, name)), { code: 'ENOENT' });
  await inventory({ source: root, static: statics });
});

for (const fault of ['runtime-package', 'headers', 'compiler', 'armv7-output', 'lock-change'])
  test('fails closed for bridge rebuild fault: ' + fault, async (t) => {
    const { root, runtime } = await fixture(t);
    if (fault === 'runtime-package') await fs.writeFile(root + '/package.json', JSON.stringify({ dependencies: { '@mikro-orm/sql': '7' } }));
    if (fault === 'headers') runtime.versions.node = '22.17.0';
    let commands = 0;
    await assert.rejects(rebuildMigrationSqlite(root, { target, runtime, repair: async () => {
      commands++;
      if (fault === 'compiler') throw new Error('compiler failed');
      if (fault === 'lock-change') await fs.appendFile(root + '/pnpm-lock.yaml', 'changed');
    }, run: async () => {
      return { stdout: fault === 'armv7-output' ? armv6.replace('v6', 'v7') : armv6 };
    } }), /Only a legacy|matching the existing Node|compiler failed|ARMv6 hard-float|changed the frozen lockfile/);
    if (['runtime-package', 'headers'].includes(fault)) assert.equal(commands, 0);
  });

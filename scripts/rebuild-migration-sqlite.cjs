// The legacy image's generic ARM prebuild contains ARMv7 instructions. Rebuild
// only the first-hop bridge on the builder; never add sqlite3 to normal bundles
// or ask an ARMv6 device to compile it during the migration.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const bundle = require('../cli/src/internal/maintenance/platformBundle.cjs');

function assertArmv6Addon(attributes) {
  if (
    !/Tag_CPU_arch:\s+v6\s*$/m.test(attributes) ||
    /Tag_THUMB_ISA_use:\s+Thumb-2|Tag_FP_arch:\s+VFPv[3-9]/.test(attributes) ||
    !/Tag_ABI_VFP_args:\s+VFP registers/.test(attributes)
  )
    throw new Error('Legacy migration SQLite must use ARMv6 hard-float instructions');
}

async function rebuildMigrationSqlite(root, {
  target,
  run = promisify(execFile),
  runtime = process,
} = {}) {
  target ||= await bundle.runtimeTarget();
  if (target.arch !== 'armv6' || target.libc !== 'musl') return false;
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
  if (!pkg.qinglongMigrationBridge || !pkg.dependencies?.sqlite3)
    throw new Error('Only a legacy migration bridge may rebuild SQLite');
  const r = createRequire(path.join(root, 'package.json'));
  const sqlite = path.dirname(r.resolve('sqlite3/package.json'));
  const fromSqlite = createRequire(path.join(sqlite, 'package.json'));
  const preGyp = fromSqlite.resolve('@mapbox/node-pre-gyp/bin/node-pre-gyp');
  const nodeGyp = fromSqlite.resolve('node-gyp/bin/node-gyp.js');
  const prefix = path.resolve(path.dirname(runtime.execPath), '..');
  const header = await fs.readFile(path.join(prefix, 'include/node/node_version.h'), 'utf8');
  const version = ['MAJOR', 'MINOR', 'PATCH'].map((part) =>
    header.match(new RegExp(`#define\\s+NODE_${part}_VERSION\\s+(\\d+)`))?.[1],
  ).join('.');
  if (version !== runtime.versions.node)
    throw new Error('Migration SQLite requires headers matching the existing Node');
  const lock = await fs.readFile(path.join(root, 'pnpm-lock.yaml'));
  await run(runtime.execPath, [
    '--jitless', preGyp, 'rebuild', '--build-from-source',
    '--napi_build_version=6', `--nodedir=${prefix}`, '--jobs=1',
    '--arm_version=6', '--arm_fpu=vfp', '--arm_float_abi=hard',
  ], {
    cwd: sqlite,
    timeout: 1800000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: runtime.env.PATH,
      NODE_PATH: '',
      NODE_OPTIONS: '--jitless --max-old-space-size=256',
      npm_config_node_gyp: nodeGyp,
      npm_config_build_from_source: 'true',
      npm_config_force_process_config: 'true',
      npm_config_nodedir: prefix,
      npm_config_jobs: '1',
      MAKEFLAGS: '-j1',
      CFLAGS: '-march=armv6 -mfpu=vfp -mfloat-abi=hard',
      CXXFLAGS: '-march=armv6 -mfpu=vfp -mfloat-abi=hard',
    },
  });
  const addon = path.join(sqlite, 'lib/binding/napi-v6-linux-arm/node_sqlite3.node');
  const { stdout } = await run('readelf', ['-A', addon], { timeout: 30000 });
  assertArmv6Addon(stdout);
  if (!lock.equals(await fs.readFile(path.join(root, 'pnpm-lock.yaml'))))
    throw new Error('Migration SQLite rebuild changed the frozen lockfile');
  console.log('Legacy bridge SQLite rebuilt and verified for ARMv6 hard-float');
  return true;
}

module.exports = { rebuildMigrationSqlite, assertArmv6Addon };

// The legacy image's generic ARM prebuild contains ARMv7 instructions. Rebuild
// only the first-hop bridge on the builder; never add sqlite3 to normal bundles
// or ask an ARMv6 device to compile it during the migration.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const bundle = require('../cli/src/internal/maintenance/platformBundle.cjs');
const { repairDependencies } = require('../cli/src/internal/maintenance/upgradePrestart.cjs');

function assertArmv6Addon(attributes) {
  // Alpine's ARM CRT objects are ARMv6KZ (the ARM1176 architecture). Linking
  // them raises a base-v6 object's ELF tag without introducing ARMv7/Thumb-2.
  if (
    !/Tag_CPU_arch:\s+v6(?:K|KZ|ZK)?\s*$/m.test(attributes) ||
    /Tag_THUMB_ISA_use:\s+Thumb-2|Tag_FP_arch:\s+VFPv[3-9]|Tag_Advanced_SIMD_arch:\s+\S/.test(attributes) ||
    !/Tag_ABI_VFP_args:\s+VFP registers/.test(attributes)
  )
    throw new Error('Legacy migration SQLite must use ARMv6 hard-float instructions: ' +
      String(attributes).split('\n').filter((line) =>
        /Tag_(CPU_arch|THUMB_ISA_use|FP_arch|ABI_VFP_args|Advanced_SIMD_arch):/.test(line),
      ).slice(0, 5).map((line) => line.trim()).join('; '));
}

async function rebuildMigrationSqlite(root, {
  target,
  run = promisify(execFile),
  runtime = process,
  repair = repairDependencies,
} = {}) {
  target ||= await bundle.runtimeTarget();
  if (target.arch !== 'armv6' || target.libc !== 'musl') return false;
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
  if (!pkg.qinglongMigrationBridge || !pkg.dependencies?.sqlite3)
    throw new Error('Only a legacy migration bridge may rebuild SQLite');
  const prefix = path.resolve(path.dirname(runtime.execPath), '..');
  const header = await fs.readFile(path.join(prefix, 'include/node/node_version.h'), 'utf8');
  const version = ['MAJOR', 'MINOR', 'PATCH'].map((part) =>
    header.match(new RegExp(`#define\\s+NODE_${part}_VERSION\\s+(\\d+)`))?.[1],
  ).join('.');
  if (version !== runtime.versions.node)
    throw new Error('Migration SQLite requires headers matching the existing Node');
  const lock = await fs.readFile(path.join(root, 'pnpm-lock.yaml'));
  // The Node 18 legacy builder skipped node-gyp 12's optional dependency.
  // The existing frozen repair installs that locked graph using the current
  // Node, then forces an ARMv6 source build with local headers and one job.
  await repair(root, { target, env: runtime.env });
  // Repair replaces node_modules, so resolve its new layout after completion.
  const rebuilt = path.dirname(createRequire(path.join(root, 'package.json')).resolve('sqlite3/package.json'));
  const addon = path.join(rebuilt, 'lib/binding/napi-v6-linux-arm/node_sqlite3.node');
  const { stdout } = await run('readelf', ['-A', addon], { timeout: 30000 });
  assertArmv6Addon(stdout);
  if (!lock.equals(await fs.readFile(path.join(root, 'pnpm-lock.yaml'))))
    throw new Error('Migration SQLite rebuild changed the frozen lockfile');
  // node-pre-gyp copied the addon to lib/binding; compiler objects are not
  // needed on the small target device or in the transition download.
  await fs.rm(path.join(rebuilt, 'build'), { recursive: true, force: true });
  console.log('Legacy bridge SQLite rebuilt and verified for ARMv6 hard-float');
  return true;
}

module.exports = { rebuildMigrationSqlite, assertArmv6Addon };

#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const QL3_PACKAGE_NAME = /^@qinglong\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

class QingLong3PackageClosureBuildError extends Error {
  constructor(message) {
    super(`QingLong 3.0 package closure build failed: ${message}`);
    this.name = 'QingLong3PackageClosureBuildError';
  }
}

function resolveQingLong3Package(root, packageDirectory) {
  const packagesDirectory = path.join(root, 'packages');
  const relative = path.relative(packagesDirectory, packageDirectory);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    relative.includes(path.sep) ||
    !relative.startsWith('ql3-')
  ) {
    throw new QingLong3PackageClosureBuildError(
      'cwd must be one direct packages/ql3-* directory',
    );
  }
  const manifestPath = path.join(packageDirectory, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new QingLong3PackageClosureBuildError(
      `cannot read package manifest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!QL3_PACKAGE_NAME.test(manifest.name ?? '')) {
    throw new QingLong3PackageClosureBuildError(
      'manifest name must be one bounded @qinglong/* package name',
    );
  }
  if (manifest.scripts?.build !== 'tsc -p tsconfig.json') {
    throw new QingLong3PackageClosureBuildError(
      `${manifest.name} build must compile only itself`,
    );
  }
  return Object.freeze({
    name: manifest.name,
    packageDirectory,
  });
}

function createQingLong3PackageClosureBuildPlan(root, packageDirectory) {
  const packageRecord = resolveQingLong3Package(root, packageDirectory);
  return Object.freeze({
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: Object.freeze([
      '-r',
      '--workspace-concurrency=1',
      '--filter',
      `${packageRecord.name}...`,
      'run',
      'build',
    ]),
    cwd: root,
  });
}

function main() {
  if (process.env.npm_lifecycle_event === 'build') {
    throw new QingLong3PackageClosureBuildError(
      'closure helper cannot run from a package build script',
    );
  }
  const root = path.resolve(__dirname, '..');
  const plan = createQingLong3PackageClosureBuildPlan(root, process.cwd());
  const result = spawnSync(plan.command, plan.args, {
    cwd: plan.cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new QingLong3PackageClosureBuildError(
      `pnpm terminated by ${result.signal}`,
    );
  }
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

module.exports = {
  QingLong3PackageClosureBuildError,
  createQingLong3PackageClosureBuildPlan,
  resolveQingLong3Package,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

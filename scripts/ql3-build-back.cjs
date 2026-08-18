#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STATIC_ROOT = path.join(ROOT, 'static');
const TARGET = path.join(STATIC_ROOT, 'build');

class QingLong3BackendBuildError extends Error {
  constructor(message) {
    super(`QingLong backend build failed: ${message}`);
    this.name = 'QingLong3BackendBuildError';
  }
}

function assertWithinStatic(target, label) {
  const relative = path.relative(STATIC_ROOT, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new QingLong3BackendBuildError(`${label} escaped static root`);
  }
}

function listFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
      else {
        throw new QingLong3BackendBuildError(
          'staged output contains a non-regular entry',
        );
      }
    }
  }
  return files;
}

function sourceMapPlan(compiledBackend) {
  return listFiles(compiledBackend)
    .filter((filePath) => filePath.endsWith('.js.map'))
    .map((sourcePath) => {
      const relative = path.relative(compiledBackend, sourcePath);
      const destinationPath = path.join(TARGET, relative);
      const sourceMap = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
      if (!Array.isArray(sourceMap.sources)) {
        throw new QingLong3BackendBuildError(
          `source map ${relative} has no sources array`,
        );
      }
      return Object.freeze({
        sourcePath,
        destinationPath,
        sourceMap,
        absoluteSources: sourceMap.sources.map((source) => {
          if (typeof source !== 'string' || path.isAbsolute(source)) {
            throw new QingLong3BackendBuildError(
              `source map ${relative} contains an invalid source`,
            );
          }
          return path.resolve(path.dirname(sourcePath), source);
        }),
      });
    });
}

function rewriteSourceMaps(plans) {
  for (const plan of plans) {
    plan.sourceMap.sources = plan.absoluteSources.map((absoluteSource) =>
      path
        .relative(path.dirname(plan.destinationPath), absoluteSource)
        .split(path.sep)
        .join('/'),
    );
    fs.writeFileSync(plan.sourcePath, JSON.stringify(plan.sourceMap));
  }
}

function publishCompiledBackend(compiledBackend, stageRoot) {
  for (const required of [
    'app.js',
    'token.js',
    'runtime/adapters/local-process/localProcessExecutor.js',
  ]) {
    if (!fs.statSync(path.join(compiledBackend, required)).isFile()) {
      throw new QingLong3BackendBuildError(
        `compiled backend is missing ${required}`,
      );
    }
  }
  const maps = sourceMapPlan(compiledBackend);
  rewriteSourceMaps(maps);
  const backup = path.join(
    STATIC_ROOT,
    `.build-backup-${process.pid}-${Date.now()}`,
  );
  assertWithinStatic(TARGET, 'target');
  assertWithinStatic(backup, 'backup');
  let previousMoved = false;
  try {
    if (fs.existsSync(TARGET)) {
      fs.renameSync(TARGET, backup);
      previousMoved = true;
    }
    fs.renameSync(compiledBackend, TARGET);
  } catch (error) {
    if (!fs.existsSync(TARGET) && previousMoved && fs.existsSync(backup)) {
      fs.renameSync(backup, TARGET);
    }
    throw error;
  }
  if (previousMoved) fs.rmSync(backup, { recursive: true, force: true });
  fs.rmSync(stageRoot, { recursive: true, force: true });
}

function main() {
  fs.mkdirSync(STATIC_ROOT, { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(STATIC_ROOT, '.back-build-'));
  assertWithinStatic(stageRoot, 'stage');
  const output = path.join(stageRoot, 'output');
  try {
    const tsc = require.resolve('typescript/bin/tsc');
    const result = spawnSync(
      process.execPath,
      [tsc, '-p', 'back/tsconfig.json', '--outDir', output],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new QingLong3BackendBuildError(
        `TypeScript compiler exited with ${result.status}`,
      );
    }
    const compiledBackend = path.join(output, 'back');
    if (!fs.existsSync(compiledBackend)) {
      throw new QingLong3BackendBuildError(
        'TypeScript output did not contain the backend subtree',
      );
    }
    publishCompiledBackend(compiledBackend, stageRoot);
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  QingLong3BackendBuildError,
  assertWithinStatic,
  listFiles,
  publishCompiledBackend,
  rewriteSourceMaps,
  sourceMapPlan,
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

#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_LOCK_SAMPLES = 16;

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    json: false,
    lockSamples: DEFAULT_LOCK_SAMPLES,
  };
  for (const argument of argv) {
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator < 1) {
      throw new Error(`Unsupported argument: ${argument}`);
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (name === '--lock-samples') {
      options.lockSamples = positiveInteger(value, name);
    } else if (name === '--max-lock-p95-ms') {
      options.maxLockP95Ms = positiveNumber(value, name);
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }
  if (options.lockSamples > 1_000) {
    throw new Error('--lock-samples cannot exceed 1000');
  }
  return Object.freeze(options);
}

async function runBenchmark(options) {
  const {
    measureWorkflowAdmissionTransactions,
    setupScenario,
  } = require('../packages/ql3-local-sqlite/test/fixtures/pluginPackageWorkflowAdmissionCrashMatrixFixture.cjs');
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-workflow-lock-benchmark-'),
  );
  const databasePath = path.join(temporaryRoot, 'runtime.sqlite');
  const rssBeforeBytes = process.memoryUsage().rss;
  try {
    await setupScenario({ databasePath, profile: 'edge' });
    const report = await measureWorkflowAdmissionTransactions({
      databasePath,
      profile: 'edge',
      samples: options.lockSamples,
    });
    return Object.freeze({
      ...report,
      rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBeforeBytes),
      databaseBytes: fs.statSync(databasePath).size,
      storage: 'bounded_os_temporary_directory',
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('local Workflow resource benchmark requires Linux');
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) {
    throw new Error('local Workflow resource benchmark requires Node.js 24');
  }
  const options = parseArguments(process.argv.slice(2));
  const sqliteWriteLocks = await runBenchmark(options);
  const violations = [];
  if (
    options.maxLockP95Ms !== undefined &&
    sqliteWriteLocks.lockDurationMs.p95 > options.maxLockP95Ms
  ) {
    violations.push(
      `Workflow SQLite write lock p95 ${sqliteWriteLocks.lockDurationMs.p95}ms exceeded ${options.maxLockP95Ms}ms`,
    );
  }
  if (!sqliteWriteLocks.oneWriteTransactionPerWorkflow) {
    violations.push('Workflow admission did not use one write transaction');
  }
  if (
    sqliteWriteLocks.integrityCheck !== 'ok' ||
    sqliteWriteLocks.foreignKeyCheck !== 'ok'
  ) {
    violations.push('Workflow admission database integrity failed');
  }

  const report = {
    schemaVersion: 1,
    evidenceClass: 'ci_local_workflow_sqlite_write_lock_guard',
    profile: 'edge',
    generatedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
    },
    sqliteWriteLocks,
    gates: {
      maxLockP95Ms: options.maxLockP95Ms ?? null,
      passed: violations.length === 0,
      violations,
    },
  };
  process.stdout.write(
    `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`,
  );
  if (violations.length > 0) process.exitCode = 1;
}

module.exports = {
  parseArguments,
  runBenchmark,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `ql3 local Workflow resource benchmark failed: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

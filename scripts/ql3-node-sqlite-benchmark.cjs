#!/usr/bin/env node

// This benchmark intentionally uses direct node:sqlite statements. It validates
// the runtime/host boundary only; production repositories remain governed by
// the typed-schema and adapter decisions in ADR-0004.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const MIB = 1024 * 1024;
const DEFAULT_ITERATIONS = 250;
const DEFAULT_BATCH_SIZE = 10;

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    batchSize: DEFAULT_BATCH_SIZE,
    iterations: DEFAULT_ITERATIONS,
    json: false,
  };
  for (const argument of argv) {
    if (argument === '--') {
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    const [name, value] = argument.split('=', 2);
    if (value === undefined) {
      throw new Error(`Unsupported argument: ${argument}`);
    }
    if (name === '--iterations') {
      options.iterations = parsePositiveInteger(value, name);
    } else if (name === '--batch-size') {
      options.batchSize = parsePositiveInteger(value, name);
    } else if (name === '--max-transaction-p95-ms') {
      options.maxTransactionP95Ms = parsePositiveNumber(value, name);
    } else if (name === '--max-batch-stall-ms') {
      options.maxBatchStallMs = parsePositiveNumber(value, name);
    } else if (name === '--max-rss-delta-mb') {
      options.maxRssDeltaMb = parsePositiveNumber(value, name);
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }
  if (options.batchSize > options.iterations) {
    throw new Error('--batch-size cannot exceed --iterations');
  }
  return options;
}

function percentile(sortedValues, percentileValue) {
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil((percentileValue / 100) * sortedValues.length) - 1,
  );
  return sortedValues[Math.max(0, index)];
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function enforceThreshold(actual, maximum, label) {
  if (maximum !== undefined && actual > maximum) {
    throw new Error(`${label} ${round(actual)} exceeded limit ${maximum}`);
  }
}

function runBenchmark(options) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) {
    throw new Error('ql3-node-sqlite-benchmark requires Node.js 24 or newer');
  }
  const { DatabaseSync } = require('node:sqlite');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-db-bench-'));
  const databasePath = path.join(temporaryRoot, 'benchmark.sqlite');
  const rssBefore = process.memoryUsage().rss;
  const transactionDurations = [];
  const batchDurations = [];
  let database;

  try {
    database = new DatabaseSync(databasePath, {
      allowExtension: false,
      allowUnknownNamedParameters: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 1_000,
    });
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE benchmark_runs (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        event_sequence INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE benchmark_events (
        id INTEGER PRIMARY KEY,
        run_id INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE(run_id, sequence),
        FOREIGN KEY(run_id) REFERENCES benchmark_runs(id) ON DELETE CASCADE
      );
    `);
    const insertRun = database.prepare(
      'INSERT INTO benchmark_runs(id, status, version, event_sequence, created_at_ms) VALUES (?, ?, ?, ?, ?)',
    );
    const insertEvent = database.prepare(
      'INSERT INTO benchmark_events(id, run_id, sequence, type, payload, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const updateRun = database.prepare(
      'UPDATE benchmark_runs SET status = ?, version = ?, event_sequence = ? WHERE id = ? AND version = ?',
    );
    let batchStartedAt = performance.now();

    for (let index = 1; index <= options.iterations; index += 1) {
      const startedAt = performance.now();
      const now = 1_750_000_000_000 + index;
      database.exec('BEGIN IMMEDIATE');
      try {
        insertRun.run(index, 'created', 0, 0, now);
        insertEvent.run(
          index * 2 - 1,
          index,
          1,
          'run.created',
          '{"source":"node-sqlite-benchmark"}',
          now,
        );
        const update = updateRun.run('queued', 1, 2, index, 0);
        if (update.changes !== 1) {
          throw new Error('benchmark compare-and-set did not update one Run');
        }
        insertEvent.run(
          index * 2,
          index,
          2,
          'run.queued',
          '{}',
          now,
        );
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      transactionDurations.push(performance.now() - startedAt);

      if (index % options.batchSize === 0 || index === options.iterations) {
        batchDurations.push(performance.now() - batchStartedAt);
        batchStartedAt = performance.now();
      }
    }

    const integrity = database.prepare('PRAGMA integrity_check').get();
    if (integrity.integrity_check !== 'ok') {
      throw new Error(`integrity_check failed: ${integrity.integrity_check}`);
    }
    const runCount = database
      .prepare('SELECT COUNT(*) AS count FROM benchmark_runs')
      .get().count;
    const eventCount = database
      .prepare('SELECT COUNT(*) AS count FROM benchmark_events')
      .get().count;
    if (runCount !== options.iterations || eventCount !== options.iterations * 2) {
      throw new Error('benchmark row counts do not match committed transactions');
    }
    database.close();
    database = undefined;

    const sortedTransactions = [...transactionDurations].sort((a, b) => a - b);
    const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / MIB;
    const result = {
      node: process.version,
      arch: process.arch,
      platform: process.platform,
      iterations: options.iterations,
      batchSize: options.batchSize,
      journalMode: 'delete',
      synchronous: 'full',
      transactionMs: {
        p50: round(percentile(sortedTransactions, 50)),
        p95: round(percentile(sortedTransactions, 95)),
        p99: round(percentile(sortedTransactions, 99)),
        max: round(sortedTransactions[sortedTransactions.length - 1]),
      },
      maxBatchStallMs: round(Math.max(...batchDurations)),
      rssDeltaMb: round(rssDeltaMb),
      databaseBytes: fs.statSync(databasePath).size,
      integrityCheck: 'ok',
    };

    enforceThreshold(
      result.transactionMs.p95,
      options.maxTransactionP95Ms,
      'transaction p95 ms',
    );
    enforceThreshold(
      result.maxBatchStallMs,
      options.maxBatchStallMs,
      'batch stall ms',
    );
    enforceThreshold(result.rssDeltaMb, options.maxRssDeltaMb, 'RSS delta MiB');
    return result;
  } finally {
    if (database) {
      database.close();
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = runBenchmark(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      [
        `Node SQLite benchmark (${result.node}, ${result.arch})`,
        `transactions: ${result.iterations}`,
        `p50/p95/p99: ${result.transactionMs.p50}/${result.transactionMs.p95}/${result.transactionMs.p99} ms`,
        `max batch stall: ${result.maxBatchStallMs} ms`,
        `RSS delta: ${result.rssDeltaMb} MiB`,
        `database: ${result.databaseBytes} bytes`,
      ].join('\n') + '\n',
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

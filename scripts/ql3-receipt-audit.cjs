#!/usr/bin/env node

require('ts-node/register/transpile-only');

const fs = require('node:fs');
const path = require('node:path');
const {
  CompletionReceiptOrphanFileDirectory,
} = require('../back/runtime/adapters/fs/completionReceiptOrphanDirectory');
const {
  CompletionReceiptOrphanAuditor,
} = require('../back/runtime/application/completionReceiptOrphanAuditor');

const ATTEMPT_STATUSES = new Set([
  'claimed',
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);
const JOURNAL_STATES = new Set(['pending', 'quarantined']);

function numericArgument(name, value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    database: path.resolve(process.cwd(), 'data/db/database.sqlite'),
    root: path.resolve(process.cwd(), 'data/runtime/completion-receipts'),
    mode: 'audit',
    startShard: 0,
    shardCount: 8,
    maxEntriesPerShard: 32,
    minimumAgeMs: 5 * 60_000,
    json: false,
    failOnFindings: false,
  };
  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--quarantine') {
      options.mode = 'quarantine';
    } else if (argument === '--fail-on-findings') {
      options.failOnFindings = true;
    } else if (argument.startsWith('--database=')) {
      const value = argument.slice('--database='.length);
      if (!value) throw new Error('--database must not be empty');
      options.database = path.resolve(value);
    } else if (argument.startsWith('--root=')) {
      const value = argument.slice('--root='.length);
      if (!value) throw new Error('--root must not be empty');
      options.root = path.resolve(value);
    } else if (argument.startsWith('--start-shard=')) {
      const value = argument.slice('--start-shard='.length);
      if (!/^[0-9a-f]{2}$/.test(value)) {
        throw new Error('--start-shard must be two lowercase hex digits');
      }
      options.startShard = Number.parseInt(value, 16);
    } else if (argument.startsWith('--shards=')) {
      options.shardCount = numericArgument(
        '--shards',
        argument.slice('--shards='.length),
        1,
        32,
      );
    } else if (argument.startsWith('--entries-per-shard=')) {
      options.maxEntriesPerShard = numericArgument(
        '--entries-per-shard',
        argument.slice('--entries-per-shard='.length),
        1,
        64,
      );
    } else if (argument.startsWith('--minimum-age-ms=')) {
      options.minimumAgeMs = numericArgument(
        '--minimum-age-ms',
        argument.slice('--minimum-age-ms='.length),
        0,
        Number.MAX_SAFE_INTEGER,
      );
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }
  return options;
}

class SqliteCompletionReceiptOwnershipSource {
  constructor(database) {
    this.database = database;
  }

  async lookup(attemptIds) {
    const ownership = new Map();
    for (let offset = 0; offset < attemptIds.length; offset += 32) {
      const chunk = attemptIds.slice(offset, offset + 32);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => '?').join(', ');
      const journalRows = this.database
        .prepare(
          `SELECT attempt_id, state AS journal_state
             FROM CompletionReceiptJournals
            WHERE attempt_id IN (${placeholders})`,
        )
        .all(...chunk);
      for (const row of journalRows) {
        if (!JOURNAL_STATES.has(row.journal_state)) {
          throw new Error(
            `Receipt journal ${row.attempt_id} has an invalid state`,
          );
        }
        ownership.set(row.attempt_id, {
          attemptId: row.attempt_id,
          journalState: row.journal_state,
        });
      }
      const attemptRows = this.database
        .prepare(
          `SELECT id AS attempt_id, status AS attempt_status
             FROM RunAttempts
            WHERE id IN (${placeholders})`,
        )
        .all(...chunk);
      for (const row of attemptRows) {
        if (!ATTEMPT_STATUSES.has(row.attempt_status)) {
          throw new Error(
            `Run Attempt ${row.attempt_id} has an invalid status`,
          );
        }
        ownership.set(row.attempt_id, {
          ...ownership.get(row.attempt_id),
          attemptId: row.attempt_id,
          attemptStatus: row.attempt_status,
        });
      }
    }
    return ownership;
  }
}

function assertRequiredSchema(database) {
  const rows = database
    .prepare(
      `SELECT name
         FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('RunAttempts', 'CompletionReceiptJournals')`,
    )
    .all();
  const names = new Set(rows.map((row) => row.name));
  for (const required of ['RunAttempts', 'CompletionReceiptJournals']) {
    if (!names.has(required)) {
      throw new Error(
        `Database is not ready for receipt audit: missing ${required}`,
      );
    }
  }
}

function findingCount(report) {
  const findingCategories = new Set([
    'terminal_orphan',
    'unknown_receipt',
    'stale_temporary',
    'unknown_entry',
    'unsafe_entry',
  ]);
  return (
    report.entries.filter((entry) => findingCategories.has(entry.category))
      .length + report.overflowShards.length
  );
}

function renderText(report, options) {
  const lines = [
    `QingLong 3.0 receipt audit: ${report.mode}`,
    `root: ${options.root}`,
    `shards: ${report.startShard} -> ${report.nextShard}`,
    `scanned entries: ${report.scannedEntries}`,
    `overflow shards: ${report.overflowShards.join(', ') || 'none'}`,
  ];
  for (const [category, count] of Object.entries(report.counts)) {
    if (count > 0) lines.push(`${category}: ${count}`);
  }
  for (const entry of report.entries) {
    if (entry.action !== 'retained') {
      lines.push(
        `${JSON.stringify(`${entry.shard}/${entry.name}`)}: ${
          entry.category
        } (${entry.action})`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) {
    throw new Error('ql3-receipt-audit requires Node.js 24 or newer');
  }
  if (!fs.existsSync(options.database)) {
    throw new Error(`Database does not exist: ${options.database}`);
  }
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(options.database, {
    allowExtension: false,
    allowUnknownNamedParameters: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 1_000,
  });
  try {
    assertRequiredSchema(database);
    const auditor = new CompletionReceiptOrphanAuditor(
      new CompletionReceiptOrphanFileDirectory(options.root),
      new SqliteCompletionReceiptOwnershipSource(database),
    );
    const report = await auditor.run(options);
    process.stdout.write(
      options.json
        ? `${JSON.stringify({
            ...report,
            database: path.basename(options.database),
            root: options.root,
          })}\n`
        : renderText(report, options),
    );
    if (options.failOnFindings && findingCount(report) > 0) {
      process.exitCode = 1;
    }
  } finally {
    database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  SqliteCompletionReceiptOwnershipSource,
  assertRequiredSchema,
  findingCount,
  parseArguments,
  renderText,
};

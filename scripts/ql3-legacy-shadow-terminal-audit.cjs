#!/usr/bin/env node

require('ts-node/register/transpile-only');

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { QueryTypes, Sequelize } = require('sequelize');
const {
  LegacySequelizeShadowTerminalDifferenceSource,
} = require('../back/runtime/adapters/legacy-sequelize/legacyShadowTerminalDifferenceSource');
const {
  LegacyShadowTerminalDifferenceAuditor,
} = require('../back/runtime/application/legacyShadowTerminalDifferenceAuditor');
const {
  createLegacyLogArtifactId,
} = require('../back/runtime/compatibility/legacyTaskRevision');

const SUPPORTED_ORIGINS = new Set([
  'boot',
  'manual',
  'scheduled_node',
  'scheduled_system',
  'script',
  'subscription',
  'system',
]);

function numericArgument(name, value, minimum, maximum) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    database: path.resolve(process.cwd(), 'data/db/database.sqlite'),
    profile: 'edge',
    projectId: 'default',
    origins: [],
    minimumSettlingAgeMs: 5 * 60_000,
    correlationToleranceMs: 2_000,
    json: false,
    failOnDifference: false,
  };
  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--fail-on-difference') {
      options.failOnDifference = true;
    } else if (argument.startsWith('--database=')) {
      const value = argument.slice('--database='.length);
      if (!value) throw new Error('--database must not be empty');
      options.database = path.resolve(value);
    } else if (argument.startsWith('--profile=')) {
      const value = argument.slice('--profile='.length);
      if (value !== 'edge' && value !== 'standalone') {
        throw new Error('--profile must be edge or standalone');
      }
      options.profile = value;
    } else if (argument.startsWith('--project=')) {
      const value = argument.slice('--project='.length);
      if (!value || value.length > 128) {
        throw new Error('--project length must be between 1 and 128');
      }
      options.projectId = value;
    } else if (argument.startsWith('--origin=')) {
      const values = argument
        .slice('--origin='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (values.length === 0) throw new Error('--origin must not be empty');
      for (const value of values) {
        if (!SUPPORTED_ORIGINS.has(value)) {
          throw new Error(`unsupported Shadow origin: ${value}`);
        }
        if (!options.origins.includes(value)) options.origins.push(value);
      }
    } else if (argument.startsWith('--window-start-ms=')) {
      options.windowStartMs = numericArgument(
        '--window-start-ms',
        argument.slice('--window-start-ms='.length),
        0,
        Number.MAX_SAFE_INTEGER,
      );
    } else if (argument.startsWith('--window-end-ms=')) {
      options.windowEndMs = numericArgument(
        '--window-end-ms',
        argument.slice('--window-end-ms='.length),
        0,
        Number.MAX_SAFE_INTEGER,
      );
    } else if (argument.startsWith('--observed-at-ms=')) {
      options.observedAtMs = numericArgument(
        '--observed-at-ms',
        argument.slice('--observed-at-ms='.length),
        0,
        Number.MAX_SAFE_INTEGER,
      );
    } else if (argument.startsWith('--minimum-settling-age-ms=')) {
      options.minimumSettlingAgeMs = numericArgument(
        '--minimum-settling-age-ms',
        argument.slice('--minimum-settling-age-ms='.length),
        0,
        Number.MAX_SAFE_INTEGER,
      );
    } else if (argument.startsWith('--correlation-tolerance-ms=')) {
      options.correlationToleranceMs = numericArgument(
        '--correlation-tolerance-ms',
        argument.slice('--correlation-tolerance-ms='.length),
        0,
        60_000,
      );
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }
  if (options.origins.length === 0) {
    throw new Error('at least one --origin is required');
  }
  if (options.windowStartMs === undefined) {
    throw new Error('--window-start-ms is required');
  }
  if (options.windowEndMs === undefined) {
    throw new Error('--window-end-ms is required');
  }
  if (options.windowStartMs >= options.windowEndMs) {
    throw new Error('measurement window must be non-empty');
  }
  return options;
}

async function assertRequiredSchema(database) {
  const rows = await database.query(
    `SELECT name
       FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('Runs', 'RunAttempts', 'RunningInstances')`,
    { type: QueryTypes.SELECT },
  );
  const names = new Set(rows.map((row) => row.name));
  for (const required of ['Runs', 'RunAttempts', 'RunningInstances']) {
    if (!names.has(required)) {
      throw new Error(
        `Database is not ready for Legacy Shadow terminal audit: missing ${required}`,
      );
    }
  }
  const columns = await database
    .getQueryInterface()
    .describeTable('RunningInstances');
  for (const required of ['run_id', 'attempt_id']) {
    if (!columns[required]) {
      throw new Error(
        `Database is not ready for Legacy Shadow terminal audit: missing RunningInstances.${required}`,
      );
    }
  }
}

function renderText(report) {
  const lines = [
    'QingLong 3.0 Legacy Shadow terminal audit',
    `profile: ${report.profile}`,
    `window: [${report.window.startInclusiveMs}, ${report.window.endExclusiveMs})`,
    `window closed: ${report.window.closed}`,
    `coverage: ${report.coverage.direction} (${report.coverage.legacyWithoutShadow})`,
    `assessment: ${report.assessment}`,
    `pages/scanned: ${report.pages}/${report.scanned}`,
    `remaining: ${report.remaining}`,
    `evidence complete: ${report.evidenceComplete}`,
  ];
  for (const [category, count] of Object.entries(report.counts)) {
    if (count > 0) lines.push(`${category}: ${count}`);
  }
  if (report.terminalAgreementPermille !== undefined) {
    lines.push(
      `terminal agreement: ${report.terminalAgreementPermille}/1000`,
      `fully comparable: ${report.fullyComparablePermille}/1000`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) {
    throw new Error(
      'Legacy Shadow terminal audit requires Node.js 24 or newer',
    );
  }
  if (!fs.existsSync(options.database)) {
    throw new Error(`Database does not exist: ${options.database}`);
  }
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: options.database,
    logging: false,
    dialectOptions: { mode: sqlite3.OPEN_READONLY },
    pool: { max: 1, min: 0, idle: 1_000, acquire: 5_000 },
  });
  try {
    await assertRequiredSchema(database);
    const auditor = new LegacyShadowTerminalDifferenceAuditor(
      new LegacySequelizeShadowTerminalDifferenceSource(
        database,
        createLegacyLogArtifactId,
      ),
    );
    const report = await auditor.run(options);
    process.stdout.write(
      options.json ? `${JSON.stringify(report)}\n` : renderText(report),
    );
    if (options.failOnDifference && report.assessment !== 'matched') {
      process.exitCode = 1;
    }
  } finally {
    await database.close();
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
  assertRequiredSchema,
  parseArguments,
  renderText,
};

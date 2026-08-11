#!/usr/bin/env node

require('ts-node/register/transpile-only');

const fs = require('node:fs');
const path = require('node:path');
const { auditSqliteSchema } = require('../back/migrations/schemaAudit');

function parseArguments(argv) {
  const options = {
    database: undefined,
    failOnDrift: false,
    json: false,
  };
  const seen = new Set();
  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument === '--json') {
      if (seen.has('json')) throw new Error('--json must not be duplicated');
      seen.add('json');
      options.json = true;
    } else if (argument === '--fail-on-drift') {
      if (seen.has('fail-on-drift')) {
        throw new Error('--fail-on-drift must not be duplicated');
      }
      seen.add('fail-on-drift');
      options.failOnDrift = true;
    } else if (argument.startsWith('--database=')) {
      if (seen.has('database')) {
        throw new Error('--database must not be duplicated');
      }
      const database = argument.slice('--database='.length);
      if (!database) throw new Error('--database must not be empty');
      seen.add('database');
      options.database = path.resolve(database);
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }
  if (!options.database) {
    throw new Error('Legacy schema audit requires an explicit --database path');
  }
  return options;
}

function collectSnapshot(database) {
  const tableRows = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all();
  const indexRows = database
    .prepare(
      "SELECT tbl_name AS table_name, name FROM sqlite_master WHERE type = 'index' ORDER BY name",
    )
    .all();
  const indexesByTable = new Map();
  for (const row of indexRows) {
    const indexes = indexesByTable.get(row.table_name) || [];
    indexes.push(row.name);
    indexesByTable.set(row.table_name, indexes);
  }
  const tableInfo = database.prepare(
    'SELECT name FROM pragma_table_info(?) ORDER BY cid',
  );
  const tables = tableRows.map((row) => ({
    name: row.name,
    columns: tableInfo.all(row.name).map((column) => column.name),
    indexes: indexesByTable.get(row.name) || [],
  }));
  const migrationIds = tableRows.some(
    (table) => table.name === 'SchemaMigrations',
  )
    ? database
        .prepare('SELECT id FROM SchemaMigrations ORDER BY id')
        .all()
        .map((migration) => migration.id)
    : [];
  return { tables, migrationIds };
}

function renderText(report, databasePath) {
  const lines = [
    `QingLong 3.0 legacy/Shadow schema audit: ${path.basename(databasePath)}`,
    `compatible: ${report.compatible}`,
    `drift detected: ${report.driftDetected}`,
  ];
  for (const key of [
    'missingTables',
    'missingColumns',
    'missingIndexes',
    'missingMigrationIds',
    'unknownTables',
    'unknownColumns',
    'unknownIndexes',
    'extraMigrationIds',
  ]) {
    if (report[key].length > 0) {
      lines.push(`${key}: ${JSON.stringify(report[key])}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) {
    throw new Error('ql3-schema-audit requires Node.js 24 or newer');
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
  let report;
  try {
    report = auditSqliteSchema(collectSnapshot(database));
  } finally {
    database.close();
  }
  process.stdout.write(
    options.json
      ? `${JSON.stringify({
          schemaVersion: 1,
          mode: 'legacy-shadow',
          database: path.basename(options.database),
          ...report,
        })}\n`
      : renderText(report, options.database),
  );
  if (!report.compatible || (options.failOnDrift && report.driftDetected)) {
    process.exitCode = 1;
  }
}

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

module.exports = { collectSnapshot, parseArguments, renderText };

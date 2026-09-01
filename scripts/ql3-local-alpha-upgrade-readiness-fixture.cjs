#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function fail(message) {
  throw new Error(
    `QingLong Local Alpha upgrade readiness fixture failed: ${message}`,
  );
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) {
      fail(
        'usage: --output=/absolute/new/data-root [--shape=production|completion-ready]',
      );
    }
    values[match[1]] = match[2];
  }
  if (
    !values.output ||
    Object.keys(values).some((key) => !['output', 'shape'].includes(key)) ||
    (values.shape && !['production', 'completion-ready'].includes(values.shape))
  ) {
    fail(
      'usage: --output=/absolute/new/data-root [--shape=production|completion-ready]',
    );
  }
  const match = /^(\/.+)$/u.exec(values.output);
  if (!match) fail('output must be an absolute path');
  const output = path.resolve(match[1]);
  if (output !== match[1] || path.parse(output).root === output) {
    fail('output must be a normalized absolute non-root path');
  }
  return Object.freeze({ output, shape: values.shape || 'production' });
}

function writePrivate(filePath, contents) {
  fs.writeFileSync(filePath, contents, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function createLegacyDatabase(databasePath, shape) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE "Crontabs" (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255), command VARCHAR(255),
        schedule VARCHAR(255), timestamp VARCHAR(255), saved TINYINT(1), status DECIMAL,
        isSystem DECIMAL, pid DECIMAL, isDisabled DECIMAL, isPinned DECIMAL,
        log_path VARCHAR(255), labels JSON, last_running_time DECIMAL,
        last_execution_time DECIMAL, sub_id DECIMAL, extra_schedules JSON,
        task_before VARCHAR(255), task_after VARCHAR(255), log_name VARCHAR(255),
        allow_multiple_instances DECIMAL, work_dir VARCHAR(255),
        createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
      );
      CREATE TABLE "Dependences" (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255), type DECIMAL,
        timestamp VARCHAR(255), status DECIMAL, log JSON, remark VARCHAR(255),
        createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
      );
      CREATE TABLE "Apps" (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255), scopes JSON,
        client_id VARCHAR(255), client_secret VARCHAR(255), tokens JSON,
        createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
      );
      CREATE TABLE "Auths" (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ip VARCHAR(255), type VARCHAR(255),
        info JSON, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
      );
      CREATE TABLE "Envs" (
        id INTEGER PRIMARY KEY AUTOINCREMENT, value VARCHAR(255), timestamp VARCHAR(255),
        status DECIMAL, position DECIMAL, name VARCHAR(255), remarks VARCHAR(255),
        isPinned DECIMAL, labels JSON, createdAt DATETIME NOT NULL,
        updatedAt DATETIME NOT NULL
      );
      CREATE TABLE "Subscriptions" (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255), url VARCHAR(255),
        schedule VARCHAR(255), interval_schedule JSON, type VARCHAR(255),
        whitelist VARCHAR(255), blacklist VARCHAR(255), status DECIMAL,
        dependences VARCHAR(255), extensions VARCHAR(255), sub_before VARCHAR(255),
        sub_after VARCHAR(255), branch VARCHAR(255), pull_type VARCHAR(255),
        pull_option JSON, pid DECIMAL, is_disabled DECIMAL, log_path VARCHAR(255),
        schedule_type VARCHAR(255), alias VARCHAR(255), proxy VARCHAR(255),
        autoAddCron DECIMAL, autoDelCron DECIMAL, createdAt DATETIME NOT NULL,
        updatedAt DATETIME NOT NULL
      );
      CREATE TABLE "CrontabViews" (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255), position DECIMAL,
        isDisabled DECIMAL, filters JSON, sorts JSON, filterRelation VARCHAR(255),
        type DECIMAL, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
      );
      CREATE TABLE "CrontabStats" (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ref_id DECIMAL NOT NULL,
        date VARCHAR(255) NOT NULL, run_count DECIMAL, success_count DECIMAL,
        fail_count DECIMAL, total_time DECIMAL, max_time DECIMAL,
        createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
      );
      CREATE TABLE "RunningInstances" (
        id INTEGER PRIMARY KEY AUTOINCREMENT, cron_id DECIMAL NOT NULL,
        run_id VARCHAR(36), attempt_id VARCHAR(36), pid DECIMAL,
        log_path VARCHAR(255), started_at DECIMAL NOT NULL, finished_at DECIMAL,
        status DECIMAL NOT NULL, exit_code DECIMAL,
        createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
      );
      INSERT INTO "Crontabs" (
        id, name, command, schedule, status, isDisabled, isPinned, createdAt, updatedAt
      ) VALUES (
        1, 'Alpha upgrade readiness fixture', 'task /ql/scripts/alpha.sh',
        '0 0 * * *', 1, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "Envs" (
        id, name, value, status, position, isPinned, createdAt, updatedAt
      ) VALUES (
        1, 'ALPHA_READINESS_VALUE', 'synthetic-only', 0, 100, 0,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);
    if (shape === 'production') {
      database.exec(`
        CREATE TABLE "PluginOwnedState" (
          id INTEGER PRIMARY KEY, payload TEXT NOT NULL
        );
        INSERT INTO "PluginOwnedState" (id, payload)
          VALUES (1, '{"synthetic":true}');
      `);
    }
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o600);
}

function createFixture(output, shape = 'production') {
  if (!['production', 'completion-ready'].includes(shape)) {
    fail('fixture shape is invalid');
  }
  if (fs.existsSync(output)) fail('output must not already exist');
  fs.mkdirSync(output, { mode: 0o700 });
  for (const directory of ['config', 'scripts', 'db', 'upload', 'ssh.d']) {
    fs.mkdirSync(path.join(output, directory), { mode: 0o700 });
  }
  createLegacyDatabase(path.join(output, 'db', 'database.sqlite'), shape);
  writePrivate(
    path.join(output, 'config', 'config.sh'),
    "export ALPHA_READINESS_CONFIG='synthetic-only'\n",
  );
  writePrivate(
    path.join(output, 'scripts', 'alpha.sh'),
    "#!/bin/sh\nprintf '%s\\n' 'synthetic alpha readiness'\n",
  );
  writePrivate(
    path.join(output, 'upload', 'README.txt'),
    'synthetic fixture\n',
  );
  return Object.freeze({
    output,
    database: path.join(output, 'db', 'database.sqlite'),
    shape,
  });
}

function runCli(argv) {
  const options = parseArguments(argv);
  const result = createFixture(options.output, options.shape);
  process.stdout.write(`${JSON.stringify({ status: 'created', ...result })}\n`);
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'unknown failure'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ createFixture, parseArguments });

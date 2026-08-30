'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const {
  createFixture,
  parseArguments,
} = require('../../scripts/ql3-local-alpha-upgrade-readiness-fixture.cjs');

test('creates one private production-shaped QingLong 2.x readiness fixture', (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-alpha-upgrade-readiness-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'legacy-data');
  const result = createFixture(output);
  assert.equal(result.output, output);
  assert.equal(fs.statSync(output).mode & 0o777, 0o700);
  assert.equal(fs.statSync(result.database).mode & 0o777, 0o600);
  const database = new DatabaseSync(result.database, { readOnly: true });
  try {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);
    assert.deepEqual(tables, [
      'Apps',
      'Auths',
      'CrontabStats',
      'CrontabViews',
      'Crontabs',
      'Dependences',
      'Envs',
      'PluginOwnedState',
      'RunningInstances',
      'Subscriptions',
      'sqlite_sequence',
    ]);
  } finally {
    database.close();
  }
  assert.throws(() => createFixture(output), /must not already exist/);
});

test('requires one normalized absolute output path', () => {
  assert.equal(parseArguments(['--output=/tmp/ql3-legacy']), '/tmp/ql3-legacy');
  assert.throws(() => parseArguments([]), /usage/);
  assert.throws(() => parseArguments(['--output=relative']), /absolute path/);
  assert.throws(
    () => parseArguments(['--output=/tmp/../tmp/legacy']),
    /normalized absolute non-root path/,
  );
});

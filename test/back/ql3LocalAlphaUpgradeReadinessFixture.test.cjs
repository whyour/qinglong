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
    assert.deepEqual(
      database
        .prepare(
          'SELECT name, status, position, isPinned FROM Envs ORDER BY id',
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          name: 'ALPHA_READINESS_VALUE',
          status: 0,
          position: 100,
          isPinned: 0,
        },
      ],
    );
  } finally {
    database.close();
  }
  assert.throws(() => createFixture(output), /must not already exist/);
});

test('requires one normalized absolute output path', () => {
  assert.deepEqual(parseArguments(['--output=/tmp/ql3-legacy']), {
    output: '/tmp/ql3-legacy',
    shape: 'production',
  });
  assert.deepEqual(
    parseArguments([
      '--shape=completion-ready',
      '--output=/tmp/ql3-completion',
    ]),
    {
      output: '/tmp/ql3-completion',
      shape: 'completion-ready',
    },
  );
  assert.throws(() => parseArguments([]), /usage/);
  assert.throws(() => parseArguments(['--output=relative']), /absolute path/);
  assert.throws(
    () => parseArguments(['--output=/tmp/ql3-completion', '--shape=unsafe']),
    /usage/,
  );
  assert.throws(
    () => parseArguments(['--output=/tmp/../tmp/legacy']),
    /normalized absolute non-root path/,
  );
});

test('creates a completion-ready fixture without unadapted domains', (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-alpha-completion-ready-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'legacy-data');
  const result = createFixture(output, 'completion-ready');
  assert.equal(result.shape, 'completion-ready');
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
      'RunningInstances',
      'Subscriptions',
      'sqlite_sequence',
    ]);
  } finally {
    database.close();
  }
});

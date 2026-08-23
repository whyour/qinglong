const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  MAX_EDGE_LEGACY_ENVIRONMENT_ROWS,
  visitLegacyEnvironmentAdoption,
} = require('@qinglong/local-admin/reconciliation-secret-and-config-inspection');

function memoryDatabase(sql = '') {
  const database = new DatabaseSync(':memory:');
  if (sql) database.exec(sql);
  return database;
}

function inspect(database, profile = 'edge') {
  const rows = [];
  const candidates = [];
  const inventory = visitLegacyEnvironmentAdoption(database, {
    profile,
    visitRow: (row) => rows.push(row),
    visitCandidate: (candidate) => candidates.push(candidate),
  });
  return { inventory, rows, candidates };
}

test('treats an absent Envs table as a stable no-effect inventory', () => {
  const database = memoryDatabase(
    'CREATE TABLE "Crontabs" (id INTEGER PRIMARY KEY)',
  );
  try {
    const first = inspect(database);
    const second = inspect(database);
    assert.equal(first.inventory.tableState, 'absent');
    assert.equal(first.inventory.mutationReady, true);
    assert.equal(first.inventory.rowCount, 0);
    assert.equal(
      first.inventory.inventoryDigest,
      second.inventory.inventoryDigest,
    );
    assert.deepEqual(first.rows, []);
    assert.deepEqual(first.candidates, []);
  } finally {
    database.close();
  }
});

test('reproduces legacy ordering and joins active values without exposing them in diagnostics', () => {
  const database = memoryDatabase(`
    CREATE TABLE "Envs" (
      id INTEGER PRIMARY KEY,
      name TEXT,
      value TEXT,
      status INTEGER,
      position REAL,
      "isPinned" INTEGER,
      "createdAt" TEXT
    );
    INSERT INTO "Envs" VALUES
      (1, 'TOKEN', 'later-value', 0, 10, 0, '2026-01-01'),
      (2, 'TOKEN', 'pinned-value', 0, 1, 1, '2026-01-02'),
      (3, 'PLAIN', 'plain-value', 0, 9, 0, '2026-01-03'),
      (4, 'DISABLED', 'disabled-value', 1, 8, 0, '2026-01-04');
  `);
  try {
    const { inventory, rows, candidates } = inspect(database);
    assert.deepEqual(
      {
        rowCount: inventory.rowCount,
        activeRowCount: inventory.activeRowCount,
        disabledRowCount: inventory.disabledRowCount,
        activeGroupCount: inventory.activeGroupCount,
        bindingReadyCount: inventory.bindingReadyCount,
        preservationReadyCount: inventory.preservationReadyCount,
        mutationReady: inventory.mutationReady,
      },
      {
        rowCount: 4,
        activeRowCount: 3,
        disabledRowCount: 1,
        activeGroupCount: 2,
        bindingReadyCount: 2,
        preservationReadyCount: 1,
        mutationReady: true,
      },
    );
    assert.deepEqual(
      candidates.map(({ kind, environmentName, value }) => ({
        kind,
        environmentName,
        value,
      })),
      [
        {
          kind: 'active_binding',
          environmentName: 'PLAIN',
          value: 'plain-value',
        },
        {
          kind: 'active_binding',
          environmentName: 'TOKEN',
          value: 'pinned-value&later-value',
        },
        {
          kind: 'disabled_preservation',
          environmentName: 'DISABLED',
          value: 'disabled-value',
        },
      ],
    );
    const publicEvidence = JSON.stringify({ inventory, rows });
    for (const secret of [
      'later-value',
      'pinned-value',
      'plain-value',
      'disabled-value',
      'TOKEN',
      'PLAIN',
      'DISABLED',
    ]) {
      assert.equal(publicEvidence.includes(secret), false);
    }
    assert.equal(
      new Set(candidates.map((value) => value.candidateDigest)).size,
      3,
    );
  } finally {
    database.close();
  }
});

test('fails closed for malformed rows, reserved names and effective-value overflow', () => {
  const oversized = 'x'.repeat(12 * 1024);
  const database = memoryDatabase(`
    CREATE TABLE "Envs" (
      id INTEGER PRIMARY KEY,
      name TEXT,
      value TEXT,
      status INTEGER,
      position REAL,
      "isPinned" INTEGER,
      "createdAt" TEXT
    );
  `);
  const insert = database.prepare(
    'INSERT INTO "Envs" VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run(1, 'QL3_FORBIDDEN', 'secret-a', 0, 3, 0, '2026-01-01');
  insert.run(2, 'TOKEN', oversized, 0, 2, 0, '2026-01-02');
  insert.run(3, 'TOKEN', oversized, 0, 1, 0, '2026-01-03');
  insert.run(4, 'BROKEN', 'secret-b', 7, 0, 0, '2026-01-04');
  try {
    const { inventory, rows, candidates } = inspect(database);
    assert.equal(inventory.mutationReady, false);
    assert.equal(inventory.manualRowCount, 2);
    assert.equal(inventory.manualGroupCount, 2);
    assert.equal(inventory.bindingReadyCount, 0);
    assert.deepEqual(candidates, []);
    assert.deepEqual(
      rows.map(({ disposition, reasons }) => ({ disposition, reasons })),
      [
        { disposition: 'manual_required', reasons: ['name_invalid'] },
        { disposition: 'active_member', reasons: [] },
        { disposition: 'active_member', reasons: [] },
        { disposition: 'manual_required', reasons: ['status_invalid'] },
      ],
    );
    assert.equal(
      JSON.stringify({ inventory, rows }).includes('secret-a'),
      false,
    );
    assert.equal(
      JSON.stringify({ inventory, rows }).includes('secret-b'),
      false,
    );
  } finally {
    database.close();
  }
});

test('rejects unsupported schemas and over-budget Edge tables without scanning rows', () => {
  const unsupported = memoryDatabase(
    'CREATE TABLE "Envs" (id INTEGER PRIMARY KEY, name TEXT)',
  );
  try {
    const value = inspect(unsupported);
    assert.equal(value.inventory.tableState, 'unsupported_schema');
    assert.equal(value.inventory.mutationReady, false);
  } finally {
    unsupported.close();
  }

  const overBudget = memoryDatabase(`
    CREATE TABLE "Envs" (id INTEGER PRIMARY KEY, name TEXT, value TEXT);
    WITH RECURSIVE rows(id) AS (
      SELECT 1 UNION ALL SELECT id + 1 FROM rows
      WHERE id < ${MAX_EDGE_LEGACY_ENVIRONMENT_ROWS + 1}
    )
    INSERT INTO "Envs" SELECT id, 'TOKEN_' || id, 'value' FROM rows;
  `);
  try {
    const value = inspect(overBudget);
    assert.equal(value.inventory.tableState, 'budget_exceeded');
    assert.equal(
      value.inventory.rowCount,
      MAX_EDGE_LEGACY_ENVIRONMENT_ROWS + 1,
    );
    assert.equal(value.inventory.mutationReady, false);
    assert.deepEqual(value.rows, []);
    assert.deepEqual(value.candidates, []);
  } finally {
    overBudget.close();
  }
});

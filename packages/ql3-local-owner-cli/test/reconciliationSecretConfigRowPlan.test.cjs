const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  buildLocalReconciliationSecretConfigPlanReceipt,
  hashLocalReconciliationSecretConfigPlanFile,
  normalizeLocalReconciliationSecretConfigPlanReceipt,
  writeLocalReconciliationSecretConfigPlan,
} = require('../dist/deployment/reconciliation/application/secret-and-config/rowPlan');

const DIGEST = 'a'.repeat(64);
const HEADER = Object.freeze({
  schemaVersion: 1,
  kind: 'qinglong3-local-reconciliation-secret-config-plan-header',
  secretConfigId: '10000000-0000-4000-8000-000000000001',
  applicationId: '20000000-0000-4000-8000-000000000002',
  applicationPlanDigest: DIGEST,
  reviewDigest: 'b'.repeat(64),
  reviewAuthorizationDigest: 'c'.repeat(64),
  reviewDecisionSetDigest: 'd'.repeat(64),
  reviewDecisionFileDigest: 'e'.repeat(64),
  bundleDigest: 'f'.repeat(64),
  bundleFingerprintDigest: '1'.repeat(64),
  profile: 'edge',
  projectId: 'project-1',
  tableDisposition: 'manual_external',
  unadaptedLegacyConfigCount: 0,
  preparedHeadDigest: '2'.repeat(64),
  preparedAtMs: 1_780_000_000_000,
});

function databases() {
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(`
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
  const target = new DatabaseSync(':memory:');
  target.exec(`
    CREATE TABLE "QingLong3LocalSecretEnvelopes" (
      project_id TEXT NOT NULL,
      secret_name TEXT NOT NULL,
      version INTEGER NOT NULL,
      mutation_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (project_id, secret_name, version)
    );
    CREATE TABLE "QingLong3LegacyAdoptions" (
      mutation_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      plan_digest TEXT NOT NULL,
      inventory_digest TEXT NOT NULL,
      decision_digest TEXT NOT NULL,
      receipt_digest TEXT NOT NULL,
      authorization_file_digest TEXT NOT NULL,
      publication_digest TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      adopted_task_count INTEGER NOT NULL,
      adopted_trigger_count INTEGER NOT NULL,
      skipped_count INTEGER NOT NULL,
      audit_event_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
  `);
  return { legacy, target };
}

function insertAutomationAdoption(target, adoptedTaskCount = 1) {
  const mutationId = '30000000-0000-4000-8000-000000000003';
  target
    .prepare(
      `INSERT INTO "QingLong3LegacyAdoptions" VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      mutationId,
      '019b0000-0000-7000-8000-000000000001',
      HEADER.projectId,
      '3'.repeat(64),
      '4'.repeat(64),
      '5'.repeat(64),
      '6'.repeat(64),
      '7'.repeat(64),
      '8'.repeat(64),
      adoptedTaskCount,
      adoptedTaskCount,
      0,
      0,
      mutationId,
      HEADER.preparedAtMs,
    );
}

function writePlan(
  t,
  legacy,
  target,
  maxBytes = 8 * 1024 * 1024,
  header = HEADER,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-secret-plan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'plan.ndjson');
  const descriptor = fs.openSync(filePath, 'w+', 0o600);
  let result;
  try {
    result = writeLocalReconciliationSecretConfigPlan({
      descriptor,
      maxBytes,
      header,
      legacy,
      target,
    });
    fs.fsyncSync(descriptor);
    assert.equal(
      hashLocalReconciliationSecretConfigPlanFile(descriptor, result.fileBytes),
      result.fileDigest,
    );
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    result,
    serialized: fs.readFileSync(filePath, 'utf8'),
    records: fs
      .readFileSync(filePath, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line)),
  };
}

test('writes a content-free Env plan with separate active and disabled candidates', (t) => {
  const { legacy, target } = databases();
  t.after(() => legacy.close());
  t.after(() => target.close());
  legacy.exec(`
    INSERT INTO "Envs" VALUES
      (1, 'TOKEN', 'later-secret', 0, 10, 0, '2026-01-01'),
      (2, 'TOKEN', 'pinned-secret', 0, 1, 1, '2026-01-02'),
      (3, 'DISABLED_TOKEN', 'disabled-secret', 1, 0, 0, '2026-01-03');
  `);
  insertAutomationAdoption(target);

  const { result, records, serialized } = writePlan(t, legacy, target);
  assert.equal(result.footer.outcome, 'ready');
  assert.equal(result.footer.rowCount, 3);
  assert.equal(result.footer.eligibleBindingCount, 1);
  assert.equal(result.footer.eligiblePreservationCount, 1);
  assert.equal(result.footer.targetConflictCount, 0);
  assert.equal(result.footer.automationAdoptionRecordCount, 1);
  assert.equal(result.footer.adoptedLegacyTaskCount, 1);
  assert.match(result.footer.automationAdoptionSetDigest, /^[0-9a-f]{64}$/);
  const candidates = records.filter((record) =>
    record.kind.endsWith('-candidate'),
  );
  assert.deepEqual(
    candidates.map(({ candidateType, requirement, proposedSecretName }) => ({
      candidateType,
      requirement,
      prefix: proposedSecretName.replace(/[0-9a-f]{32}$/, ''),
    })),
    [
      {
        candidateType: 'active_binding',
        requirement: 'review_apply_binding',
        prefix: 'legacy-db-env-',
      },
      {
        candidateType: 'disabled_preservation',
        requirement: 'review_preserve_disabled',
        prefix: 'legacy-db-env-disabled-',
      },
    ],
  );
  for (const privateValue of [
    'TOKEN',
    'DISABLED_TOKEN',
    'later-secret',
    'pinned-secret',
    'disabled-secret',
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }

  const receipt = buildLocalReconciliationSecretConfigPlanReceipt(
    result.header,
    result.footer,
    result.fileBytes,
    result.fileDigest,
  );
  assert.deepEqual(
    normalizeLocalReconciliationSecretConfigPlanReceipt(receipt),
    receipt,
  );
  assert.throws(
    () =>
      normalizeLocalReconciliationSecretConfigPlanReceipt({
        ...receipt,
        eligibleBindingCount: 2,
      }),
    /receipt drifted/,
  );
});

test('captures a target Secret collision without reading plaintext', (t) => {
  const { legacy, target } = databases();
  t.after(() => legacy.close());
  t.after(() => target.close());
  legacy.exec(
    `INSERT INTO "Envs" VALUES
       (1, 'TOKEN', 'private-value', 0, 1, 0, '2026-01-01')`,
  );
  const initial = writePlan(t, legacy, target);
  const candidate = initial.records.find((record) =>
    record.kind.endsWith('-candidate'),
  );
  target
    .prepare(
      `INSERT INTO "QingLong3LocalSecretEnvelopes" VALUES
       (?, ?, 1, ?, ?, 'aes-256-gcm', ?, ?, ?, ?)`,
    )
    .run(
      HEADER.projectId,
      candidate.proposedSecretName,
      '30000000-0000-4000-8000-000000000003',
      'qlsk-test',
      Buffer.alloc(12, 1),
      Buffer.from('ciphertext'),
      Buffer.alloc(16, 2),
      HEADER.preparedAtMs,
    );

  const conflicted = writePlan(t, legacy, target);
  assert.equal(conflicted.result.footer.outcome, 'manual_required');
  assert.equal(conflicted.result.footer.eligibleBindingCount, 0);
  assert.equal(conflicted.result.footer.targetConflictCount, 1);
  const occupied = conflicted.records.find((record) =>
    record.kind.endsWith('-candidate'),
  );
  assert.equal(occupied.requirement, 'review_skip_conflict');
  assert.equal(occupied.target.state, 'occupied');
  assert.equal(occupied.target.version, 1);
  assert.match(occupied.target.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(conflicted.serialized.includes('private-value'), false);
  assert.equal(conflicted.serialized.includes('ciphertext'), false);
  assert.equal(conflicted.serialized.includes('qlsk-test'), false);
});

test('makes absent Envs no-effect and malformed Env manual', (t) => {
  const noEnvs = new DatabaseSync(':memory:');
  const { target } = databases();
  t.after(() => noEnvs.close());
  t.after(() => target.close());
  const empty = writePlan(t, noEnvs, target);
  assert.equal(empty.result.footer.outcome, 'no_effect');
  assert.equal(empty.result.footer.tableState, 'absent');

  const { legacy, target: secondTarget } = databases();
  t.after(() => legacy.close());
  t.after(() => secondTarget.close());
  legacy.exec(
    `INSERT INTO "Envs" VALUES
       (1, 'QL3_RESERVED', 'private-value', 0, 1, 0, '2026-01-01')`,
  );
  const manual = writePlan(t, legacy, secondTarget);
  assert.equal(manual.result.footer.outcome, 'manual_required');
  assert.equal(manual.result.footer.manualRowCount, 1);
  assert.equal(manual.result.footer.eligibleBindingCount, 0);
  assert.equal(manual.serialized.includes('QL3_RESERVED'), false);
  assert.equal(manual.serialized.includes('private-value'), false);
});

test('keeps active Env and historical Configs manual without adoption authority', (t) => {
  const { legacy, target } = databases();
  t.after(() => legacy.close());
  t.after(() => target.close());
  legacy.exec(
    `INSERT INTO "Envs" VALUES
       (1, 'TOKEN', 'private-value', 0, 1, 0, '2026-01-01')`,
  );
  const withoutAdoption = writePlan(t, legacy, target);
  assert.equal(withoutAdoption.result.footer.outcome, 'manual_required');
  assert.equal(withoutAdoption.result.footer.adoptedLegacyTaskCount, 0);
  assert.equal(withoutAdoption.serialized.includes('private-value'), false);

  insertAutomationAdoption(target);
  const withConfigs = writePlan(t, legacy, target, 8 * 1024 * 1024, {
    ...HEADER,
    unadaptedLegacyConfigCount: 1,
  });
  assert.equal(withConfigs.result.footer.outcome, 'manual_required');
  assert.equal(withConfigs.result.footer.unadaptedLegacyConfigCount, 1);
});

test('fails closed before exceeding the plan byte budget', (t) => {
  const { legacy, target } = databases();
  t.after(() => legacy.close());
  t.after(() => target.close());
  legacy.exec(`
    WITH RECURSIVE rows(id) AS (
      SELECT 1 UNION ALL SELECT id + 1 FROM rows WHERE id < 400
    )
    INSERT INTO "Envs"
      SELECT id, 'TOKEN_' || id, 'private-value', 0, id, 0, '2026-01-01'
      FROM rows
  `);
  assert.throws(
    () => writePlan(t, legacy, target, 64 * 1024),
    /exceeds profile byte budget/,
  );
});

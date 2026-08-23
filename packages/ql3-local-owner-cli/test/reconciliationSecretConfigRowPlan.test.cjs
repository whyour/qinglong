const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  LegacyAdoptionPublicationDigest,
  legacyAdoptionTaskProvenanceDigest,
} = require('@qinglong/local-sqlite/adoption-provenance');

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
    CREATE TABLE "QingLong3TaskDefinitions" (
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (project_id, task_id)
    );
    CREATE TABLE "QingLong3TaskDefinitionRevisions" (
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      mutation_id TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      PRIMARY KEY (project_id, task_id, revision)
    );
    CREATE TABLE "QingLong3PluginPackageTaskOwnerships" (
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      PRIMARY KEY (project_id, task_id)
    );
    CREATE TABLE "QingLong3Triggers" (
      project_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      PRIMARY KEY (project_id, trigger_id)
    );
    CREATE TABLE "QingLong3TriggerRevisions" (
      project_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      mutation_id TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      PRIMARY KEY (project_id, trigger_id, revision)
    );
    CREATE TABLE "QingLong3LocalTriggerSchedules" (
      project_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      trigger_revision INTEGER NOT NULL,
      PRIMARY KEY (project_id, trigger_id)
    );
    CREATE TABLE "QingLong3LegacyAdoptionTasks" (
      adoption_mutation_id TEXT NOT NULL,
      row_ordinal INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      task_mutation_id TEXT NOT NULL,
      task_content_digest TEXT NOT NULL,
      trigger_count INTEGER NOT NULL,
      item_digest TEXT NOT NULL,
      PRIMARY KEY (adoption_mutation_id, row_ordinal)
    );
    CREATE TABLE "QingLong3LegacyAdoptionTriggers" (
      adoption_mutation_id TEXT NOT NULL,
      row_ordinal INTEGER NOT NULL,
      trigger_ordinal INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      trigger_id TEXT NOT NULL,
      trigger_revision INTEGER NOT NULL,
      trigger_mutation_id TEXT NOT NULL,
      trigger_content_digest TEXT NOT NULL,
      item_digest TEXT NOT NULL,
      PRIMARY KEY (adoption_mutation_id, row_ordinal, trigger_ordinal)
    );
  `);
  return { legacy, target };
}

function insertAutomationAdoption(
  target,
  adoptedTaskCount = 1,
  withProvenance = true,
) {
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
  if (!withProvenance) return;
  const publication = new LegacyAdoptionPublicationDigest(mutationId);
  for (let rowOrdinal = 1; rowOrdinal <= adoptedTaskCount; rowOrdinal += 1) {
    const taskId = `legacy-cron:${rowOrdinal}`;
    const taskMutationId = `31000000-0000-4000-8000-${String(rowOrdinal).padStart(12, '0')}`;
    const sourceDigest = String(rowOrdinal % 10).repeat(64);
    const taskContentDigest = String((rowOrdinal + 1) % 10).repeat(64);
    const payload = {
      adoptionMutationId: mutationId,
      rowOrdinal,
      projectId: HEADER.projectId,
      sourceDigest,
      taskId,
      taskRevision: 1,
      taskMutationId,
      taskContentDigest,
      triggerCount: 0,
    };
    const itemDigest = legacyAdoptionTaskProvenanceDigest(payload);
    target
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitions" VALUES (?, ?, 1, ?, ?)`
      )
      .run(
        HEADER.projectId,
        taskId,
        HEADER.preparedAtMs,
        HEADER.preparedAtMs,
      );
    target
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitionRevisions" VALUES
         (?, ?, 1, ?, ?)`
      )
      .run(HEADER.projectId, taskId, taskMutationId, taskContentDigest);
    target
      .prepare(
        `INSERT INTO "QingLong3LegacyAdoptionTasks" VALUES
         (?, ?, ?, ?, ?, 1, ?, ?, 0, ?)`
      )
      .run(
        mutationId,
        rowOrdinal,
        HEADER.projectId,
        sourceDigest,
        taskId,
        taskMutationId,
        taskContentDigest,
        itemDigest,
      );
    publication.appendTask({
      rowOrdinal,
      sourceDigest,
      taskContentDigest,
      itemDigest,
    });
  }
  target
    .prepare(
      `UPDATE "QingLong3LegacyAdoptions"
       SET publication_digest = ?
       WHERE mutation_id = ?`,
    )
    .run(publication.digest(), mutationId);
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
  assert.equal(result.footer.adoptedLegacyTriggerCount, 0);
  assert.equal(result.footer.adoptionProvenanceTaskCount, 1);
  assert.equal(result.footer.adoptionProvenanceTriggerCount, 0);
  assert.equal(result.footer.automationAdoptionProvenanceState, 'complete');
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

  const tamperedPayload = {
    adoptionMutationId: '30000000-0000-4000-8000-000000000003',
    rowOrdinal: 1,
    projectId: HEADER.projectId,
    sourceDigest: '9'.repeat(64),
    taskId: 'legacy-cron:1',
    taskRevision: 1,
    taskMutationId: '31000000-0000-4000-8000-000000000001',
    taskContentDigest: '2'.repeat(64),
    triggerCount: 0,
  };
  target
    .prepare(
      `UPDATE "QingLong3LegacyAdoptionTasks"
       SET source_digest = ?, item_digest = ?
       WHERE adoption_mutation_id = ? AND row_ordinal = 1`,
    )
    .run(
      tamperedPayload.sourceDigest,
      legacyAdoptionTaskProvenanceDigest(tamperedPayload),
      tamperedPayload.adoptionMutationId,
    );
  const resealedItem = writePlan(t, legacy, target);
  assert.equal(resealedItem.result.footer.outcome, 'manual_required');
  assert.equal(
    resealedItem.result.footer.automationAdoptionProvenanceState,
    'drifted',
  );

  const originalPayload = { ...tamperedPayload, sourceDigest: '1'.repeat(64) };
  target
    .prepare(
      `UPDATE "QingLong3LegacyAdoptionTasks"
       SET source_digest = ?, item_digest = ?
       WHERE adoption_mutation_id = ? AND row_ordinal = 1`,
    )
    .run(
      originalPayload.sourceDigest,
      legacyAdoptionTaskProvenanceDigest(originalPayload),
      originalPayload.adoptionMutationId,
    );

  target.exec(
    `UPDATE "QingLong3TaskDefinitions"
     SET current_revision = 2
     WHERE project_id = 'project-1' AND task_id = 'legacy-cron:1'`,
  );
  const drifted = writePlan(t, legacy, target);
  assert.equal(drifted.result.footer.outcome, 'manual_required');
  assert.equal(
    drifted.result.footer.automationAdoptionProvenanceState,
    'drifted',
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

test('keeps pre-provenance Automation adoption records manual', (t) => {
  const { legacy, target } = databases();
  t.after(() => legacy.close());
  t.after(() => target.close());
  legacy.exec(
    `INSERT INTO "Envs" VALUES
       (1, 'TOKEN', 'private-value', 0, 1, 0, '2026-01-01')`,
  );
  insertAutomationAdoption(target, 1, false);

  const planned = writePlan(t, legacy, target);
  assert.equal(planned.result.footer.outcome, 'manual_required');
  assert.equal(planned.result.footer.automationAdoptionProvenanceState, 'missing');
  assert.equal(planned.result.footer.adoptionProvenanceTaskCount, 0);
  assert.equal(planned.serialized.includes('private-value'), false);
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

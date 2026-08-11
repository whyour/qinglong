const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  ToolInvocationArtifactConflictError,
  ToolInvocationArtifactUnavailableError,
  createToolInvocationInputArtifact,
  createToolInvocationPreviewArtifact,
} = require('@qinglong/runtime-core/tool-invocation-artifact');
const {
  LocalSqliteOperationAuthority,
} = require('../dist/authority/operationAuthority');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');
const {
  LocalSqliteToolInvocationArtifactRepository,
} = require('../dist/tool-execution/toolInvocationArtifactRepository');

const KEY = Buffer.alloc(32, 7);
const NONCE = Buffer.alloc(12, 9);
const INVOCATION_ACTION_DIGEST = 'a'.repeat(64);
const ACTION_DIGEST = 'b'.repeat(64);
const REDACTION_DIGEST = 'c'.repeat(64);

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function artifacts(index = 1, overrides = {}) {
  const input = {
    runId: `run-${String(index).padStart(3, '0')}`,
    token: 'secret-value',
  };
  const common = {
    projectId: 'project-001',
    actionRef: `tool-plan:${input.runId}`,
    sealedAtMs: 1_000 + index,
    ...overrides.common,
  };
  const inputArtifact = createToolInvocationInputArtifact(
    {
      artifactId: `artifact-input-${index}`,
      requestedBy: { type: 'user', id: 'usr-owner' },
      tool: { name: 'demo.compare', version: '1.0.0' },
      input,
      inputDigest: digest(input),
      invocationActionDigest: INVOCATION_ACTION_DIGEST,
      keyId: 'tool-key-test',
      key: KEY,
      ...common,
      ...overrides.input,
    },
    () => NONCE,
  );
  const previewArtifact = createToolInvocationPreviewArtifact({
    artifactId: `artifact-preview-${index}`,
    actionDigest: ACTION_DIGEST,
    redactionContractDigest: REDACTION_DIGEST,
    preview: {
      title: 'Compare Run',
      summary: 'Reads one bounded Run projection',
      fields: [
        { kind: 'identifier', label: 'Run', value: input.runId },
        { kind: 'redacted', label: 'Credential', value: null },
      ],
      warnings: [],
    },
    ...common,
    ...overrides.preview,
  });
  return { inputArtifact, previewArtifact };
}

async function harness() {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  client
    .prepare(
      `INSERT INTO "QingLong3Projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES ('project-001', 'Project', 'project-001', 'active', 1, 1, 1)`,
    )
    .run();
  const authority = new LocalSqliteOperationAuthority(client);
  return {
    client,
    repository: new LocalSqliteToolInvocationArtifactRepository(authority),
    close: () => authority.close(),
  };
}

test('atomically inserts and exactly replays one Artifact pair', async (t) => {
  const current = await harness();
  t.after(current.close);
  const pair = artifacts();
  assert.deepEqual(
    await current.repository.put(pair.inputArtifact, pair.previewArtifact),
    { status: 'inserted' },
  );
  assert.deepEqual(
    await current.repository.put(pair.inputArtifact, pair.previewArtifact),
    { status: 'existing' },
  );
  assert.deepEqual(
    await current.repository.findInput(pair.inputArtifact.artifactId),
    pair.inputArtifact,
  );
  assert.deepEqual(
    await current.repository.findPreview(pair.previewArtifact.artifactId),
    pair.previewArtifact,
  );
  assert.equal(
    JSON.stringify(
      current.client
        .prepare(
          `SELECT artifact_json FROM "ToolInvocationInputArtifacts"`,
        )
        .get(),
    ).includes('secret-value'),
    false,
  );
});

test('rejects pair drift and rolls back both rows', async (t) => {
  const current = await harness();
  t.after(current.close);
  const pair = artifacts();
  const detached = artifacts(2, {
    common: {
      projectId: 'project-001',
      actionRef: 'tool-plan:detached',
      sealedAtMs: 1_002,
    },
  });
  await assert.rejects(
    current.repository.put(pair.inputArtifact, detached.previewArtifact),
    ToolInvocationArtifactConflictError,
  );
  assert.equal(
    current.client
      .prepare(
        `SELECT count(*) AS count FROM "ToolInvocationInputArtifacts"`,
      )
      .get().count,
    0,
  );
  assert.equal(
    current.client
      .prepare(
        `SELECT count(*) AS count FROM "ToolInvocationPreviewArtifacts"`,
      )
      .get().count,
    0,
  );
});

test('fails closed when a stored projection is corrupted', async (t) => {
  const current = await harness();
  t.after(current.close);
  const pair = artifacts();
  await current.repository.put(pair.inputArtifact, pair.previewArtifact);
  current.client.exec('PRAGMA ignore_check_constraints = ON');
  current.client
    .prepare(
      `UPDATE "ToolInvocationInputArtifacts"
       SET input_digest = ?
       WHERE artifact_id = ?`,
    )
    .run('d'.repeat(64), pair.inputArtifact.artifactId);
  current.client.exec('PRAGMA ignore_check_constraints = OFF');
  await assert.rejects(
    current.repository.findInput(pair.inputArtifact.artifactId),
    ToolInvocationArtifactUnavailableError,
  );
});

test('publishes only the explicit adapter subpath', () => {
  const root = require('../dist');
  const subpath = require('@qinglong/local-sqlite/tool-invocation-artifact');
  assert.equal(
    root.LocalSqliteToolInvocationArtifactRepository,
    LocalSqliteToolInvocationArtifactRepository,
  );
  assert.equal(
    subpath.LocalSqliteToolInvocationArtifactRepository,
    LocalSqliteToolInvocationArtifactRepository,
  );
});

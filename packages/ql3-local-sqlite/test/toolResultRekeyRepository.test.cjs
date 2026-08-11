const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  BUILTIN_RUN_READ_TOOL,
  BUILTIN_RUN_READ_TOOL_DEFINITION,
} = require('@qinglong/runtime-core/builtin-run-read-tool');
const {
  TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
} = require('@qinglong/runtime-core/trusted-tool-execution');
const {
  TOOL_EXECUTION_RESULT_KEY_BINDING_SCHEMA,
  createToolExecutionResultArtifact,
  normalizeToolExecutionResultKeyBinding,
} = require('@qinglong/runtime-core/tool-execution-completion');
const {
  createToolResultKeyCatalogBootstrapCommand,
  createToolResultKeyRetirementCommand,
  createToolResultKeyRotationCommand,
  requireActiveToolResultKey,
  toolResultKeyCatalogFence,
  toolResultKeyMaterialProof,
} = require('@qinglong/runtime-core/tool-result-key-catalog');
const {
  ToolExecutionResultRekeyConflictError,
  createToolExecutionResultRekeyCommand,
  createToolResultKeyRetirementReceiptCommand,
} = require('@qinglong/runtime-core/tool-result-rekey');
const {
  ToolDefinitionRegistry,
} = require('@qinglong/runtime-core/tool-registry');
const {
  LocalSqliteToolResultKeyCatalogRepository,
} = require('@qinglong/local-sqlite/tool-result-key-catalog');
const {
  LocalSqliteToolResultRekeyRepository,
} = require('@qinglong/local-sqlite/tool-result-rekey');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');
const { LocalSqliteOperationAuthority } = require('../dist/authority/operationAuthority');

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);
const OUTPUT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-output-digest@v1\0',
);
const RESULT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-result-digest@v1\0',
);
const BINDING_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-result-key-binding-digest@v1\0',
);

function hash(domain, value) {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function output() {
  return {
    createdAtMs: 1_000,
    eventSequence: 3,
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    found: true,
    id: 'run-rekey-local-001',
    priority: 10,
    queuedAtMs: 1_100,
    startedAtMs: 1_200,
    status: 'succeeded',
    taskId: 'task-rekey-local-001',
    taskRevision: 'task-rekey-local-001@1',
    version: 2,
  };
}

function registry() {
  return new ToolDefinitionRegistry([BUILTIN_RUN_READ_TOOL_DEFINITION]);
}

function sourceArtifact() {
  const value = output();
  const unsigned = {
    schema: TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
    startId: 'tool-start-rekey-local-001',
    barrierDigest: 'a'.repeat(64),
    adapterDigest: 'b'.repeat(64),
    output: value,
    outputDigest: hash(OUTPUT_DIGEST_DOMAIN, value),
    completedAtMs: 1_500,
  };
  const result = {
    ...unsigned,
    resultDigest: hash(RESULT_DIGEST_DOMAIN, unsigned),
  };
  return createToolExecutionResultArtifact(
    {
      artifactId: 'artifact-result-rekey-local-001',
      projectId: 'project-rekey-local-001',
      runId: 'run-host-rekey-local-001',
      stepRunId: 'step-run-rekey-local-001',
      tool: BUILTIN_RUN_READ_TOOL,
      executionResult: result,
      keyId: 'result-key-a',
      key: KEY_A,
    },
    registry(),
    () => Buffer.alloc(12, 4),
  );
}

function sourceBinding(artifact, catalog) {
  const unsigned = {
    schema: TOOL_EXECUTION_RESULT_KEY_BINDING_SCHEMA,
    startId: artifact.startId,
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    catalogGeneration: catalog.generation,
    catalogDigest: catalog.catalogDigest,
    keyId: artifact.keyId,
    materialProof: toolResultKeyMaterialProof(artifact.keyId, KEY_A),
  };
  return normalizeToolExecutionResultKeyBinding({
    ...unsigned,
    bindingDigest: hash(BINDING_DIGEST_DOMAIN, unsigned),
  });
}

async function harness() {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  const authority = new LocalSqliteOperationAuthority(client);
  return {
    client,
    catalog: new LocalSqliteToolResultKeyCatalogRepository(authority),
    rekey: new LocalSqliteToolResultRekeyRepository(authority),
    close: () => authority.close(),
  };
}

function insertBinding(client, binding) {
  client.exec('PRAGMA foreign_keys = OFF');
  try {
    client
      .prepare(
        `INSERT INTO "ToolExecutionResultKeyBindings" (
           start_id, artifact_id, artifact_digest, catalog_authority,
           catalog_generation, catalog_digest, key_id, material_proof,
           binding_digest
         ) VALUES (?, ?, ?, 'trusted-tool-results', ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.startId,
        binding.artifactId,
        binding.artifactDigest,
        binding.catalogGeneration,
        binding.catalogDigest,
        binding.keyId,
        binding.materialProof,
        binding.bindingDigest,
      );
  } finally {
    client.exec('PRAGMA foreign_keys = ON');
  }
}

test('appends one SQLite rekey head and creates coverage-derived retirement evidence', async () => {
  const current = await harness();
  try {
    const first = await current.catalog.append(
      createToolResultKeyCatalogBootstrapCommand({
        keyId: 'result-key-a',
        materialProof: toolResultKeyMaterialProof('result-key-a', KEY_A),
        mutationId: 'result-key-bootstrap-local-a',
      }),
    );
    const artifact = sourceArtifact();
    const binding = sourceBinding(artifact, first.catalog);
    insertBinding(current.client, binding);
    const second = await current.catalog.append(
      createToolResultKeyRotationCommand(first.catalog, {
        keyId: 'result-key-b',
        materialProof: toolResultKeyMaterialProof('result-key-b', KEY_B),
        mutationId: 'result-key-rotate-local-b',
      }),
    );
    const receiptCommand = createToolResultKeyRetirementReceiptCommand({
      expectedCatalogGeneration: second.catalog.generation,
      expectedCatalogDigest: second.catalog.catalogDigest,
      keyId: 'result-key-a',
      mutationId: 'result-key-retirement-local-a',
    });
    await assert.rejects(
      current.rekey.create(receiptCommand),
      ToolExecutionResultRekeyConflictError,
    );
    await assert.rejects(
      current.catalog.append(
        createToolResultKeyRetirementCommand(second.catalog, {
          keyId: 'result-key-a',
          retirementReceiptDigest: 'f'.repeat(64),
          mutationId: 'result-key-retire-local-forged',
        }),
      ),
      /conflicts with durable state/,
    );

    const overlayCommand = createToolExecutionResultRekeyCommand({
      artifact,
      binding,
      previousOverlay: null,
      overlayId: 'result-rekey-overlay-local-001',
      mutationId: 'result-rekey-mutation-local-001',
      targetCatalogFence: toolResultKeyCatalogFence(
        second.catalog,
        requireActiveToolResultKey(second.catalog),
      ),
      targetKey: KEY_B,
      output: output(),
      rekeyedAtMs: 1_700,
      registry: registry(),
      nonceFactory: () => Buffer.alloc(12, 5),
    });
    const appended = await current.rekey.append(overlayCommand);
    assert.equal(appended.status, 'created');
    assert.deepEqual(await current.rekey.append(overlayCommand), {
      status: 'existing',
      overlay: appended.overlay,
    });
    assert.deepEqual(
      await current.rekey.findHeadByArtifactId(artifact.artifactId),
      appended.overlay,
    );

    const receipt = await current.rekey.create(receiptCommand);
    assert.equal(receipt.status, 'created');
    assert.equal(receipt.receipt.bindingCount, 1);
    assert.equal(receipt.receipt.overlayHeadCount, 1);
    assert.deepEqual(await current.rekey.create(receiptCommand), {
      status: 'existing',
      receipt: receipt.receipt,
    });
    assert.deepEqual(
      await current.rekey.findByDigest(receipt.receipt.receiptDigest),
      receipt.receipt,
    );
    const retired = await current.catalog.append(
      createToolResultKeyRetirementCommand(second.catalog, {
        keyId: 'result-key-a',
        retirementReceiptDigest: receipt.receipt.receiptDigest,
        mutationId: 'result-key-retire-local-a',
      }),
    );
    assert.equal(retired.status, 'created');
    assert.equal(
      retired.catalog.keys.find((entry) => entry.keyId === 'result-key-a')
        .state,
      'retired',
    );
  } finally {
    await current.close();
  }
});

test('keeps SQLite rekey authority behind its explicit subpath', () => {
  const root = require('../dist');
  const authority = require('@qinglong/local-sqlite/tool-result-rekey');
  assert.equal(root.LocalSqliteToolResultRekeyRepository, undefined);
  assert.equal(
    authority.LocalSqliteToolResultRekeyRepository,
    LocalSqliteToolResultRekeyRepository,
  );
});

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
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
const { openLocalSqliteClient } = require('../dist/storage/config');
const { migrateLocalSqlitePath } = require('../dist/migration/migration');
const { LocalSqliteOperationAuthority } = require('../dist/authority/operationAuthority');

const COVERAGE_COUNT = 129;
const CONCURRENT_REPLAYS = 8;
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

function output(index) {
  const suffix = String(index).padStart(3, '0');
  return {
    createdAtMs: 1_000 + index,
    eventSequence: 3,
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    found: true,
    id: `run-coverage-pressure-${suffix}`,
    priority: 10,
    queuedAtMs: 1_100 + index,
    startedAtMs: 1_200 + index,
    status: 'succeeded',
    taskId: `task-coverage-pressure-${suffix}`,
    taskRevision: `task-coverage-pressure-${suffix}@1`,
    version: 2,
  };
}

function registry() {
  return new ToolDefinitionRegistry([BUILTIN_RUN_READ_TOOL_DEFINITION]);
}

function nonce(index, marker) {
  const value = Buffer.alloc(12, marker);
  value.writeUInt32BE(index, 8);
  return value;
}

function sourceArtifact(index, definitions) {
  const suffix = String(index).padStart(3, '0');
  const value = output(index);
  const unsigned = {
    schema: TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
    startId: `tool-start-coverage-pressure-${suffix}`,
    barrierDigest: 'a'.repeat(64),
    adapterDigest: 'b'.repeat(64),
    output: value,
    outputDigest: hash(OUTPUT_DIGEST_DOMAIN, value),
    completedAtMs: 1_500 + index,
  };
  const result = {
    ...unsigned,
    resultDigest: hash(RESULT_DIGEST_DOMAIN, unsigned),
  };
  return createToolExecutionResultArtifact(
    {
      artifactId: `artifact-coverage-pressure-${suffix}`,
      projectId: 'project-coverage-pressure',
      runId: `run-host-coverage-pressure-${suffix}`,
      stepRunId: `step-run-coverage-pressure-${suffix}`,
      tool: BUILTIN_RUN_READ_TOOL,
      executionResult: result,
      keyId: 'result-key-a',
      key: KEY_A,
    },
    definitions,
    () => nonce(index, 4),
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

function insertBindings(client, bindings) {
  client.exec('PRAGMA foreign_keys = OFF');
  try {
    const insert = client.prepare(
      `INSERT INTO "ToolExecutionResultKeyBindings" (
         start_id, artifact_id, artifact_digest, catalog_authority,
         catalog_generation, catalog_digest, key_id, material_proof,
         binding_digest
       ) VALUES (?, ?, ?, 'trusted-tool-results', ?, ?, ?, ?, ?)`,
    );
    for (const binding of bindings) {
      insert.run(
        binding.startId,
        binding.artifactId,
        binding.artifactDigest,
        binding.catalogGeneration,
        binding.catalogDigest,
        binding.keyId,
        binding.materialProof,
        binding.bindingDigest,
      );
    }
  } finally {
    client.exec('PRAGMA foreign_keys = ON');
  }
}

async function exerciseProfile(profile) {
  const directory = await mkdtemp(
    join(tmpdir(), `ql3-result-coverage-${profile}-`),
  );
  const databasePath = join(directory, 'coverage.sqlite');
  let authority;
  try {
    await migrateLocalSqlitePath({ databasePath, profile });
    const client = openLocalSqliteClient(
      { databasePath, profile, busyTimeoutMs: 5_000 },
      false,
    );
    authority = new LocalSqliteOperationAuthority(client);
    const catalogs =
      new LocalSqliteToolResultKeyCatalogRepository(authority);
    const rekeys = new LocalSqliteToolResultRekeyRepository(authority);
    const first = await catalogs.append(
      createToolResultKeyCatalogBootstrapCommand({
        keyId: 'result-key-a',
        materialProof: toolResultKeyMaterialProof('result-key-a', KEY_A),
        mutationId: `coverage-pressure-${profile}-bootstrap-a`,
      }),
    );
    const definitions = registry();
    const artifacts = Array.from(
      { length: COVERAGE_COUNT },
      (_, index) => sourceArtifact(index, definitions),
    );
    const bindings = artifacts.map((artifact) =>
      sourceBinding(artifact, first.catalog),
    );
    insertBindings(client, bindings);
    const second = await catalogs.append(
      createToolResultKeyRotationCommand(first.catalog, {
        keyId: 'result-key-b',
        materialProof: toolResultKeyMaterialProof('result-key-b', KEY_B),
        mutationId: `coverage-pressure-${profile}-rotate-b`,
      }),
    );
    const fence = toolResultKeyCatalogFence(
      second.catalog,
      requireActiveToolResultKey(second.catalog),
    );
    const commands = artifacts.map((artifact, index) =>
      createToolExecutionResultRekeyCommand({
        artifact,
        binding: bindings[index],
        previousOverlay: null,
        overlayId: `coverage-pressure-${profile}-overlay-${String(
          index,
        ).padStart(3, '0')}`,
        mutationId: `coverage-pressure-${profile}-rekey-${String(
          index,
        ).padStart(3, '0')}`,
        targetCatalogFence: fence,
        targetKey: KEY_B,
        output: output(index),
        rekeyedAtMs: 2_000 + index,
        registry: definitions,
        nonceFactory: () => nonce(index, 5),
      }),
    );
    const appended = await Promise.all(
      commands.map((command) => rekeys.append(command)),
    );
    assert.equal(
      appended.filter((result) => result.status === 'created').length,
      COVERAGE_COUNT,
    );
    const replayed = await Promise.all(
      Array.from({ length: CONCURRENT_REPLAYS }, () =>
        rekeys.append(commands[0]),
      ),
    );
    assert.equal(
      replayed.every((result) => result.status === 'existing'),
      true,
    );

    const receiptCommand = createToolResultKeyRetirementReceiptCommand({
      expectedCatalogGeneration: second.catalog.generation,
      expectedCatalogDigest: second.catalog.catalogDigest,
      keyId: 'result-key-a',
      mutationId: `coverage-pressure-${profile}-receipt`,
    });
    const receipts = await Promise.all(
      Array.from({ length: CONCURRENT_REPLAYS }, () =>
        rekeys.create(receiptCommand),
      ),
    );
    assert.equal(
      receipts.filter((result) => result.status === 'created').length,
      1,
    );
    assert.equal(
      receipts.filter((result) => result.status === 'existing').length,
      CONCURRENT_REPLAYS - 1,
    );
    const receipt = receipts[0].receipt;
    assert.equal(receipt.bindingCount, COVERAGE_COUNT);
    assert.equal(receipt.overlayHeadCount, COVERAGE_COUNT);
    assert.equal(receipt.uncoveredBindingCount, 0);
    assert.equal(receipt.uncoveredOverlayHeadCount, 0);
    assert.equal(
      receipts.every(
        (result) =>
          result.receipt.receiptDigest === receipt.receiptDigest &&
          result.receipt.coverageDigest === receipt.coverageDigest,
      ),
      true,
    );

    const retireCommand = createToolResultKeyRetirementCommand(
      second.catalog,
      {
        keyId: 'result-key-a',
        retirementReceiptDigest: receipt.receiptDigest,
        mutationId: `coverage-pressure-${profile}-retire-a`,
      },
    );
    const retired = await Promise.all(
      Array.from({ length: CONCURRENT_REPLAYS }, () =>
        catalogs.append(retireCommand),
      ),
    );
    assert.equal(
      retired.filter((result) => result.status === 'created').length,
      1,
    );
    assert.equal(
      retired.filter((result) => result.status === 'existing').length,
      CONCURRENT_REPLAYS - 1,
    );
    assert.equal(
      retired.every(
        (result) =>
          result.catalog.catalogDigest === retired[0].catalog.catalogDigest &&
          result.catalog.keys.find((entry) => entry.keyId === 'result-key-a')
            .state === 'retired',
      ),
      true,
    );

    const facts = client
      .prepare(
        `SELECT
           (SELECT count(*) FROM "ToolExecutionResultKeyBindings")
             AS bindings,
           (SELECT count(*) FROM "ToolExecutionResultRekeyHeads")
             AS heads,
           (SELECT count(*) FROM "ToolResultKeyRetirementReceipts")
             AS receipts`,
      )
      .get();
    assert.equal(facts.bindings, COVERAGE_COUNT);
    assert.equal(facts.heads, COVERAGE_COUNT);
    assert.equal(facts.receipts, 1);
    assert.equal(
      client.prepare('PRAGMA integrity_check').get().integrity_check,
      'ok',
    );
  } finally {
    if (authority) await authority.close();
    await rm(directory, { force: true, recursive: true });
  }
}

for (const profile of ['edge', 'standalone']) {
  test(`converges ${profile} 129-row rekey and retirement pressure exactly once`, async () => {
    await exerciseProfile(profile);
  });
}

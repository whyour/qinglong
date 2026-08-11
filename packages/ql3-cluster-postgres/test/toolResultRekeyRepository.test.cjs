const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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
  createToolResultKeyRotationCommand,
  normalizeToolResultKeyCatalogRecord,
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
  PostgresToolResultRekeyReader,
} = require('@qinglong/cluster-postgres/runtime');
const {
  PostgresToolResultRekeyRepository,
} = require('@qinglong/cluster-postgres/tool-result-rekey');

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

function jsonb(value) {
  if (Array.isArray(value)) return value.map(jsonb);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, jsonb(value[key])]),
  );
}

function output() {
  return {
    createdAtMs: 1_000,
    eventSequence: 3,
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    found: true,
    id: 'run-rekey-postgres-001',
    priority: 10,
    queuedAtMs: 1_100,
    startedAtMs: 1_200,
    status: 'succeeded',
    taskId: 'task-rekey-postgres-001',
    taskRevision: 'task-rekey-postgres-001@1',
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
    startId: 'tool-start-rekey-postgres-001',
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
      artifactId: 'artifact-result-rekey-postgres-001',
      projectId: 'project-rekey-postgres-001',
      runId: 'run-host-rekey-postgres-001',
      stepRunId: 'step-run-rekey-postgres-001',
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

function catalogs() {
  const bootstrap = createToolResultKeyCatalogBootstrapCommand({
    keyId: 'result-key-a',
    materialProof: toolResultKeyMaterialProof('result-key-a', KEY_A),
    mutationId: 'result-key-bootstrap-postgres-a',
  });
  const first = normalizeToolResultKeyCatalogRecord({
    ...bootstrap.next,
    committedAtMs: 1_000,
  });
  const rotation = createToolResultKeyRotationCommand(first, {
    keyId: 'result-key-b',
    materialProof: toolResultKeyMaterialProof('result-key-b', KEY_B),
    mutationId: 'result-key-rotate-postgres-b',
  });
  return {
    first,
    second: normalizeToolResultKeyCatalogRecord({
      ...rotation.next,
      committedAtMs: 1_001,
    }),
  };
}

function overlayRow(overlay, commandDigest) {
  return {
    overlayId: overlay.overlayId,
    artifactId: overlay.sourceArtifact.artifactId,
    sourceBindingDigest: overlay.sourceBindingDigest,
    revision: String(overlay.revision),
    previousOverlayDigest: overlay.previousOverlayDigest,
    fromKeyId: overlay.fromKeyId,
    targetCatalogGeneration: String(overlay.targetCatalogFence.generation),
    targetCatalogDigest: overlay.targetCatalogFence.catalogDigest,
    targetKeyId: overlay.targetCatalogFence.keyId,
    targetMaterialProof: overlay.targetCatalogFence.materialProof,
    mutationId: overlay.mutationId,
    commandDigest,
    overlayDigest: overlay.overlayDigest,
    rekeyedAtMs: String(overlay.rekeyedAtMs),
    overlayJson: jsonb(overlay),
  };
}

function receiptRow(receipt, commandDigest) {
  return {
    receiptDigest: receipt.receiptDigest,
    catalogGeneration: String(receipt.catalogGeneration),
    catalogDigest: receipt.catalogDigest,
    keyId: receipt.keyId,
    materialProof: receipt.materialProof,
    mutationId: receipt.mutationId,
    commandDigest,
    bindingCount: String(receipt.bindingCount),
    overlayHeadCount: String(receipt.overlayHeadCount),
    uncoveredBindingCount: '0',
    uncoveredOverlayHeadCount: '0',
    coverageDigest: receipt.coverageDigest,
    createdAtMs: String(receipt.createdAtMs),
    receiptJson: jsonb(receipt),
  };
}

function harness(artifact, binding, catalog) {
  const calls = [];
  let overlayState = null;
  let overlayCommandDigest = null;
  let head = null;
  let receiptState = null;
  let receiptCommandDigest = null;
  let released = 0;
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (
        text.startsWith('BEGIN') ||
        text === 'COMMIT' ||
        text === 'ROLLBACK' ||
        text.includes("set_config('") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return { rows: [] };
      }
      if (
        text.startsWith(
          'INSERT INTO "ql3"."tool_execution_result_rekey_overlays"',
        )
      ) {
        overlayState = JSON.parse(values[15]);
        overlayCommandDigest = values[12];
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('tool_execution_result_rekey_overlays')) {
        if (!overlayState) return { rows: [] };
        if (text.includes('JOIN "ql3"."tool_execution_result_rekey_heads"')) {
          return {
            rows:
              head && values[0] === overlayState.sourceArtifact.artifactId
                ? [overlayRow(overlayState, overlayCommandDigest)]
                : [],
          };
        }
        const matches =
          values.length === 0 ||
          values.includes(overlayState.overlayId) ||
          values.includes(overlayState.overlayDigest) ||
          values.includes(overlayState.mutationId);
        return {
          rows: matches
            ? [overlayRow(overlayState, overlayCommandDigest)]
            : [],
        };
      }
      if (
        text.includes('tool_execution_result_key_bindings') &&
        text.includes('tool_execution_completions')
      ) {
        return {
          rows: [
            {
              bindingArtifactDigest: binding.artifactDigest,
              bindingKeyId: binding.keyId,
              bindingDigest: binding.bindingDigest,
              artifactDigest: artifact.artifactDigest,
              outputDigest: artifact.outputDigest,
              executionResultDigest: artifact.executionResultDigest,
            },
          ],
        };
      }
      if (
        text.includes('tool_execution_result_rekey_heads') &&
        text.includes('FOR UPDATE')
      ) {
        return {
          rows: head
            ? [
                {
                  revision: String(head.revision),
                  overlayDigest: head.overlayDigest,
                  targetKeyId: head.targetKeyId,
                },
              ]
            : [],
        };
      }
      if (text.includes('tool_result_key_catalog_generations')) {
        return { rows: [{ catalogJson: catalog }] };
      }
      if (
        text.startsWith(
          'INSERT INTO "ql3"."tool_execution_result_rekey_heads"',
        )
      ) {
        head = {
          revision: values[1],
          overlayDigest: values[3],
          targetKeyId: values[6],
        };
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('tool_result_key_retirement_receipts')) {
        if (text.startsWith('INSERT')) {
          receiptState = JSON.parse(values[12]);
          receiptCommandDigest = values[7];
          return { rows: [], rowCount: 1 };
        }
        const matches =
          receiptState &&
          (values.includes(receiptState.mutationId) ||
            values.includes(receiptState.receiptDigest));
        return {
          rows: matches
            ? [receiptRow(receiptState, receiptCommandDigest)]
            : [],
        };
      }
      if (
        text.includes('LEFT JOIN "ql3"."tool_execution_result_rekey_heads"')
      ) {
        return {
          rows: [
            {
              artifactId: artifact.artifactId,
              bindingDigest: binding.bindingDigest,
              bindingKeyId: binding.keyId,
              headOverlayDigest: head.overlayDigest,
              headTargetKeyId: head.targetKeyId,
              headTargetCatalogGeneration: String(catalog.generation),
              headTargetCatalogDigest: catalog.catalogDigest,
            },
          ],
        };
      }
      if (text.includes('clock_timestamp()')) {
        return { rows: [{ now: '1700000000000' }] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    release() {
      released += 1;
    },
  };
  const pool = {
    query: (text, values) => client.query(text, values),
    connect: async () => client,
  };
  return {
    calls,
    reader: new PostgresToolResultRekeyReader(pool),
    repository: new PostgresToolResultRekeyRepository(pool),
    released: () => released,
  };
}

test('serializes PostgreSQL rekey heads and coverage receipts behind the catalog lock', async () => {
  const { first, second } = catalogs();
  const artifact = sourceArtifact();
  const binding = sourceBinding(artifact, first);
  const current = harness(artifact, binding, second);
  assert.equal(
    await current.reader.findHeadByArtifactId(artifact.artifactId),
    null,
  );

  const overlayCommand = createToolExecutionResultRekeyCommand({
    artifact,
    binding,
    previousOverlay: null,
    overlayId: 'result-rekey-overlay-postgres-001',
    mutationId: 'result-rekey-mutation-postgres-001',
    targetCatalogFence: toolResultKeyCatalogFence(
      second,
      requireActiveToolResultKey(second),
    ),
    targetKey: KEY_B,
    output: output(),
    rekeyedAtMs: 1_700,
    registry: registry(),
    nonceFactory: () => Buffer.alloc(12, 5),
  });
  const appended = await current.repository.append(overlayCommand);
  assert.equal(appended.status, 'created');
  assert.deepEqual(await current.repository.append(overlayCommand), {
    status: 'existing',
    overlay: appended.overlay,
  });
  assert.deepEqual(
    await current.reader.findHeadByArtifactId(artifact.artifactId),
    appended.overlay,
  );

  const receiptCommand = createToolResultKeyRetirementReceiptCommand({
    expectedCatalogGeneration: second.generation,
    expectedCatalogDigest: second.catalogDigest,
    keyId: 'result-key-a',
    mutationId: 'result-key-retirement-postgres-a',
  });
  const receipt = await current.repository.create(receiptCommand);
  assert.equal(receipt.status, 'created');
  assert.equal(receipt.receipt.bindingCount, 1);
  assert.equal(receipt.receipt.overlayHeadCount, 1);
  assert.deepEqual(await current.repository.create(receiptCommand), {
    status: 'existing',
    receipt: receipt.receipt,
  });
  assert.deepEqual(
    await current.repository.findByDigest(receipt.receipt.receiptDigest),
    receipt.receipt,
  );
  assert.equal(current.released(), 4);

  const statements = current.calls.map(({ text }) => text);
  const advisory = statements.indexOf(
    'SELECT pg_advisory_xact_lock(190397473, 3)',
  );
  const overlayInsert = statements.findIndex((text) =>
    text.startsWith(
      'INSERT INTO "ql3"."tool_execution_result_rekey_overlays"',
    ),
  );
  assert.equal(advisory >= 0 && advisory < overlayInsert, true);
  const coverageCall = current.calls.find(({ text }) =>
    text.includes(
      'LEFT JOIN "ql3"."tool_execution_result_rekey_heads" AS head',
    ),
  );
  assert.deepEqual(coverageCall.values, ['result-key-a', '', 64]);
  const currentCatalogCalls = current.calls.filter(({ text }) =>
    text.includes('tool_result_key_catalog_generations'),
  );
  assert.equal(
    currentCatalogCalls.every(({ text }) => text.includes('LIMIT 1')),
    true,
  );
  assert.equal(
    current.calls.some(({ text }) => text.includes('FOR UPDATE OF binding')),
    false,
  );
});

test('rejects a stale PostgreSQL rekey head before writing an overlay', async () => {
  const { first, second } = catalogs();
  const artifact = sourceArtifact();
  const binding = sourceBinding(artifact, first);
  const current = harness(artifact, binding, second);
  const command = createToolExecutionResultRekeyCommand({
    artifact,
    binding,
    previousOverlay: null,
    overlayId: 'result-rekey-overlay-postgres-stale',
    mutationId: 'result-rekey-mutation-postgres-stale',
    targetCatalogFence: toolResultKeyCatalogFence(
      second,
      requireActiveToolResultKey(second),
    ),
    targetKey: KEY_B,
    output: output(),
    rekeyedAtMs: 1_700,
    registry: registry(),
    nonceFactory: () => Buffer.alloc(12, 6),
  });
  const drifted = {
    ...command,
    overlay: {
      ...command.overlay,
      fromKeyId: 'result-key-drift',
    },
  };
  assert.throws(
    () => current.repository.append(drifted),
    /rekey overlay digest does not match/,
  );
  await assert.rejects(
    current.reader.findHeadByArtifactId('../escape'),
    /source Artifact id is invalid/,
  );
});

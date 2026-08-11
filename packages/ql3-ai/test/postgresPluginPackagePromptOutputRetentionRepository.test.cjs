const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPluginPackagePromptOutputArtifact,
  pluginPackagePromptOutputArtifactReference,
} = require('../dist/prompt-output/pluginPackagePromptOutputArtifact.js');
const {
  PostgresPluginPackagePromptOutputGarbageCollector,
  PostgresPluginPackagePromptOutputRetentionRepository,
  assertPostgresPluginPackagePromptOutputMaintenanceReady,
} = require('../dist/prompt-output/storage/postgresPluginPackagePromptOutputRetentionRepository.js');
const {
  PostgresModelInvocationRepository,
} = require('../dist/model-invocation/postgresModelInvocationRepository.js');

function artifact() {
  return createPluginPackagePromptOutputArtifact(
    {
      projectId: 'project-a',
      runId: 'run-a',
      stepRunId: 'step-a',
      invocationId: 'invocation-a',
      requestedBy: { type: 'user', id: 'user-a' },
      result: {
        provider: 'openai-compatible',
        model: 'model-a',
        text: 'private PostgreSQL GC output',
        finishReason: 'stop',
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
      retentionPolicy: {
        revision: 'cluster-v1',
        retentionMs: 3_600_000,
      },
      keyId: 'cluster-key-1',
      key: Buffer.alloc(32, 7),
      sealedAtMs: 1_000,
    },
    () => Buffer.alloc(12, 9),
  );
}

function artifactRow(value) {
  return {
    artifactId: value.artifactId,
    projectId: value.projectId,
    runId: value.runId,
    stepRunId: value.stepRunId,
    invocationId: value.invocationId,
    requestedByType: value.requestedBy.type,
    requestedById: value.requestedBy.id,
    provider: value.provider,
    model: value.model,
    contentDigest: value.contentDigest,
    outputBytes: value.outputBytes,
    retentionPolicyRevision: value.retentionPolicy.revision,
    retentionMs: String(value.retentionPolicy.retentionMs),
    retentionPolicyDigest: value.retentionPolicyDigest,
    retentionEligibleAtMs: String(value.retentionEligibleAtMs),
    keyId: value.keyId,
    algorithm: value.algorithm,
    plaintextBytes: value.plaintextBytes,
    sealedAtMs: String(value.sealedAtMs),
    artifactDigest: value.artifactDigest,
    artifactJson: value,
  };
}

function tombstoneRow(value) {
  return {
    artifactId: value.reference.artifactId,
    projectId: value.reference.projectId,
    runId: value.reference.runId,
    stepRunId: value.reference.stepRunId,
    invocationId: value.reference.invocationId,
    artifactDigest: value.reference.artifactDigest,
    retentionPolicyDigest: value.reference.retentionPolicyDigest,
    retentionEligibleAtMs: String(value.reference.retentionEligibleAtMs),
    keyId: value.reference.keyId,
    tombstonedAtMs: String(value.tombstonedAtMs),
    tombstoneDigest: value.tombstoneDigest,
    tombstoneJson: value,
  };
}

function storagePool(initialArtifact, options = {}) {
  let storedArtifact = initialArtifact;
  let storedTombstone = null;
  const queries = [];
  const query = async (sql, parameters = []) => {
    queries.push({ sql, parameters });
    if (sql.includes('clock_timestamp()')) {
      return { rows: [{ observedAtMs: '4000000' }], rowCount: 1 };
    }
    if (
      sql.startsWith('SELECT artifact_id AS "artifactId"') &&
      sql.includes('retention_eligible_at_ms <=')
    ) {
      return {
        rows: storedArtifact ? [{ artifactId: storedArtifact.artifactId }] : [],
      };
    }
    if (
      sql.includes('model_invocation_prompt_output_artifacts') &&
      sql.includes('artifact_json AS "artifactJson"')
    ) {
      return {
        rows:
          storedArtifact && storedArtifact.artifactId === parameters[0]
            ? [artifactRow(storedArtifact)]
            : [],
      };
    }
    if (sql.includes('AS "completionOutcome"')) {
      return {
        rows: [
          {
            runStatus: options.runStatus ?? 'succeeded',
            stepStatus: 'succeeded',
            outputRef: storedArtifact?.artifactId,
            completionOutcome: 'succeeded',
            finalizationStatus: 'succeeded',
          },
        ],
      };
    }
    if (sql.includes('model_invocation_prompt_output_artifact_tombstones')) {
      if (sql.startsWith('SELECT artifact_id')) {
        return {
          rows:
            storedTombstone &&
            storedTombstone.reference.artifactId === parameters[0]
              ? [tombstoneRow(storedTombstone)]
              : [],
        };
      }
      if (sql.startsWith('INSERT INTO')) {
        storedTombstone = JSON.parse(parameters[11]);
        return { rows: [], rowCount: 1 };
      }
    }
    if (sql.startsWith('DELETE FROM')) {
      if (
        storedArtifact?.artifactId === parameters[0] &&
        storedArtifact.artifactDigest === parameters[1]
      ) {
        storedArtifact = null;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release() {} };
  return {
    queries,
    get artifact() {
      return storedArtifact;
    },
    get tombstone() {
      return storedTombstone;
    },
    query,
    async connect() {
      return client;
    },
  };
}

test('PostgreSQL GC uses database time and atomically replaces ciphertext with a content-free tombstone', async () => {
  const output = artifact();
  const pool = storagePool(output);
  const collector = new PostgresPluginPackagePromptOutputGarbageCollector({
    pool,
    policies: {
      async resolve() {
        return output.retentionPolicy;
      },
    },
    limit: 1,
  });

  assert.deepEqual(await collector.collect(), {
    scanned: 1,
    tombstoned: 1,
    skipped: 0,
    hasMore: false,
  });
  assert.equal(pool.artifact, null);
  assert.deepEqual(
    pool.tombstone.reference,
    pluginPackagePromptOutputArtifactReference(output),
  );
  assert.equal(
    JSON.stringify(pool.tombstone).includes(output.ciphertext),
    false,
  );
  assert.equal(
    JSON.stringify(pool.tombstone).includes('private PostgreSQL GC output'),
    false,
  );
  const insertIndex = pool.queries.findIndex(({ sql }) =>
    sql.startsWith('INSERT INTO'),
  );
  const deleteIndex = pool.queries.findIndex(({ sql }) =>
    sql.startsWith('DELETE FROM'),
  );
  assert.ok(insertIndex >= 0 && insertIndex < deleteIndex);
  assert.ok(
    pool.queries.some(({ sql }) =>
      sql.startsWith('BEGIN ISOLATION LEVEL SERIALIZABLE'),
    ),
  );
  assert.ok(
    pool.queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock')),
  );

  const retention = new PostgresPluginPackagePromptOutputRetentionRepository(
    pool,
  );
  const state = await retention.inspect({
    reference: pluginPackagePromptOutputArtifactReference(output),
    observedAtMs: 4_000_001,
  });
  assert.equal(state.state, 'tombstoned');
  assert.equal(state.tombstoneDigest, pool.tombstone.tombstoneDigest);

  const replay = new PostgresModelInvocationRepository(pool);
  assert.deepEqual(
    await replay.findPromptOutputArtifactTombstone(output.artifactId),
    pool.tombstone,
  );
});

test('PostgreSQL GC skips non-terminal or policy-drifted artifacts without deleting ciphertext', async () => {
  const output = artifact();
  const nonTerminal = storagePool(output, { runStatus: 'running' });
  const terminalCollector =
    new PostgresPluginPackagePromptOutputGarbageCollector({
      pool: nonTerminal,
      policies: {
        async resolve() {
          return output.retentionPolicy;
        },
      },
    });
  assert.deepEqual(await terminalCollector.collect(), {
    scanned: 1,
    tombstoned: 0,
    skipped: 1,
    hasMore: false,
  });
  assert.deepEqual(nonTerminal.artifact, output);
  assert.equal(nonTerminal.tombstone, null);

  const drifted = storagePool(output);
  const policyCollector = new PostgresPluginPackagePromptOutputGarbageCollector(
    {
      pool: drifted,
      policies: {
        async resolve() {
          return { revision: 'cluster-v2', retentionMs: 3_600_000 };
        },
      },
    },
  );
  assert.deepEqual(await policyCollector.collect(), {
    scanned: 1,
    tombstoned: 0,
    skipped: 1,
    hasMore: false,
  });
  assert.deepEqual(drifted.artifact, output);
});

test('PostgreSQL GC maintenance readiness requires the exact delete-only authority', async () => {
  const report = await assertPostgresPluginPackagePromptOutputMaintenanceReady({
    async query(sql) {
      assert.match(sql, /ql3_ai_maintenance/);
      return {
        rows: [
          {
            currentUser: 'ql3_ai_maintenance',
            maintenanceAuthority: true,
            schemaAuthority: true,
            artifactDeleteOnly: true,
            tombstoneAppendOnly: true,
            keyRetirementAppendOnly: true,
            keyRotationAppendOnly: true,
            terminalEvidenceReadOnly: true,
          },
        ],
      };
    },
  });
  assert.deepEqual(report, {
    currentUser: 'ql3_ai_maintenance',
    maintenanceAuthority: true,
    artifactDeleteOnly: true,
    tombstoneAppendOnly: true,
    keyRetirementAppendOnly: true,
    keyRotationAppendOnly: true,
    terminalEvidenceReadOnly: true,
  });
});

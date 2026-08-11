const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const {
  ToolInvocationArtifactConflictError,
  ToolInvocationArtifactUnavailableError,
  createToolInvocationInputArtifact,
  createToolInvocationPreviewArtifact,
} = require('@qinglong/runtime-core/tool-invocation-artifact');
const {
  PostgresToolInvocationArtifactRepository,
} = require('@qinglong/cluster-postgres/tool-invocation-artifact');

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
  return {
    inputArtifact: createToolInvocationInputArtifact(
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
    ),
    previewArtifact: createToolInvocationPreviewArtifact({
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
    }),
  };
}

function inputRow(artifact, overrides = {}) {
  return {
    artifactId: artifact.artifactId,
    projectId: artifact.projectId,
    actionRef: artifact.actionRef,
    inputDigest: artifact.inputDigest,
    invocationActionDigest: artifact.invocationActionDigest,
    artifactDigest: artifact.artifactDigest,
    keyId: artifact.keyId,
    algorithm: artifact.algorithm,
    plaintextBytes: String(artifact.plaintextBytes),
    sealedAtMs: String(artifact.sealedAtMs),
    artifactJson: artifact,
    ...overrides,
  };
}

function previewRow(artifact, overrides = {}) {
  return {
    artifactId: artifact.artifactId,
    projectId: artifact.projectId,
    actionRef: artifact.actionRef,
    actionDigest: artifact.actionDigest,
    previewDigest: artifact.previewDigest,
    redactionContractDigest: artifact.redactionContractDigest,
    artifactDigest: artifact.artifactDigest,
    byteLength: String(artifact.byteLength),
    sealedAtMs: String(artifact.sealedAtMs),
    artifactJson: artifact,
    ...overrides,
  };
}

function clientWith(handler) {
  const calls = [];
  let released = false;
  return {
    calls,
    get released() {
      return released;
    },
    async query(text, values = []) {
      calls.push({ text, values });
      if (
        text.startsWith('BEGIN') ||
        text.includes("set_config('") ||
        text === 'COMMIT' ||
        text === 'ROLLBACK'
      ) {
        return { rows: [] };
      }
      return handler(text, values, calls);
    },
    release() {
      released = true;
    },
  };
}

function repositoryFor(client, query = client.query.bind(client)) {
  return new PostgresToolInvocationArtifactRepository({
    query,
    async connect() {
      return client;
    },
  });
}

test('atomically inserts one Artifact pair without storing plaintext JSON', async () => {
  const pair = artifacts();
  const client = clientWith(async (sql) => {
    if (sql.startsWith('SELECT')) return { rows: [] };
    if (sql.startsWith('INSERT INTO')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  assert.deepEqual(
    await repositoryFor(client).put(
      pair.inputArtifact,
      pair.previewArtifact,
    ),
    { status: 'inserted' },
  );
  assert.equal(client.released, true);
  assert.equal(
    client.calls.filter(({ text }) => text.startsWith('INSERT INTO'))
      .length,
    2,
  );
  assert.equal(
    client.calls
      .filter(({ text }) => text.startsWith('INSERT INTO'))
      .some(({ values }) => values.some((value) =>
        String(value).includes('secret-value'),
      )),
    false,
  );
  assert.equal(
    client.calls.some(({ text }) => text === 'COMMIT'),
    true,
  );
  assert.equal(
    client.calls.some(({ text }) => text.includes('FOR SHARE')),
    false,
  );
});

test('exactly replays a complete pair and rejects partial durable state', async () => {
  const pair = artifacts();
  const exact = clientWith(async (sql) => {
    if (sql.includes('tool_invocation_input_artifacts')) {
      return { rows: [inputRow(pair.inputArtifact)] };
    }
    if (sql.includes('tool_invocation_preview_artifacts')) {
      return { rows: [previewRow(pair.previewArtifact)] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  assert.deepEqual(
    await repositoryFor(exact).put(
      pair.inputArtifact,
      pair.previewArtifact,
    ),
    { status: 'existing' },
  );
  assert.equal(
    exact.calls.some(({ text }) => text.startsWith('INSERT INTO')),
    false,
  );

  const partial = clientWith(async (sql) => {
    if (sql.includes('tool_invocation_input_artifacts')) {
      return { rows: [inputRow(pair.inputArtifact)] };
    }
    if (sql.includes('tool_invocation_preview_artifacts')) {
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  await assert.rejects(
    repositoryFor(partial).put(pair.inputArtifact, pair.previewArtifact),
    ToolInvocationArtifactConflictError,
  );
  assert.equal(
    partial.calls.some(({ text }) => text === 'ROLLBACK'),
    true,
  );
});

test('rejects detached pairs before opening a transaction', async () => {
  const first = artifacts();
  const detached = artifacts(2, {
    common: {
      projectId: 'project-001',
      actionRef: 'tool-plan:detached',
      sealedAtMs: 1_002,
    },
  });
  let connected = false;
  const repository = new PostgresToolInvocationArtifactRepository({
    async query() {
      throw new Error('unused');
    },
    async connect() {
      connected = true;
      throw new Error('unused');
    },
  });
  await assert.rejects(
    repository.put(first.inputArtifact, detached.previewArtifact),
    ToolInvocationArtifactConflictError,
  );
  assert.equal(connected, false);
});

test('converges a concurrent unique-key winner through exact replay', async () => {
  const pair = artifacts();
  const uniqueViolation = clientWith(async (sql) => {
    if (sql.startsWith('SELECT')) return { rows: [] };
    if (sql.startsWith('INSERT INTO')) {
      const error = new Error('duplicate key');
      error.code = '23505';
      throw error;
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const winner = clientWith(async (sql) => {
    if (sql.includes('tool_invocation_input_artifacts')) {
      return { rows: [inputRow(pair.inputArtifact)] };
    }
    if (sql.includes('tool_invocation_preview_artifacts')) {
      return { rows: [previewRow(pair.previewArtifact)] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const clients = [uniqueViolation, winner];
  let connections = 0;
  const repository = new PostgresToolInvocationArtifactRepository({
    async query() {
      throw new Error('unused');
    },
    async connect() {
      const client = clients[connections];
      connections += 1;
      return client;
    },
  });
  assert.deepEqual(
    await repository.put(pair.inputArtifact, pair.previewArtifact),
    { status: 'existing' },
  );
  assert.equal(connections, 2);
  assert.equal(
    uniqueViolation.calls.some(({ text }) => text === 'ROLLBACK'),
    true,
  );
  assert.equal(uniqueViolation.released, true);
  assert.equal(winner.released, true);
});

test('fails closed when a stored projection is corrupted', async () => {
  const pair = artifacts();
  const client = clientWith(async () => {
    throw new Error('unused');
  });
  const repository = repositoryFor(client, async (sql) => {
    if (sql.includes('tool_invocation_input_artifacts')) {
      return {
        rows: [
          inputRow(pair.inputArtifact, {
            inputDigest: 'd'.repeat(64),
          }),
        ],
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  await assert.rejects(
    repository.findInput(pair.inputArtifact.artifactId),
    ToolInvocationArtifactUnavailableError,
  );
});

test('publishes the explicit runtime adapter subpath', () => {
  const root = require('../dist');
  const runtime = require('../dist/entrypoints/runtime');
  const subpath = require('@qinglong/cluster-postgres/tool-invocation-artifact');
  assert.equal(
    root.PostgresToolInvocationArtifactRepository,
    PostgresToolInvocationArtifactRepository,
  );
  assert.equal(
    runtime.PostgresToolInvocationArtifactRepository,
    PostgresToolInvocationArtifactRepository,
  );
  assert.equal(
    subpath.PostgresToolInvocationArtifactRepository,
    PostgresToolInvocationArtifactRepository,
  );
});

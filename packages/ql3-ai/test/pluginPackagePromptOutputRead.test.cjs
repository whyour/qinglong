const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPluginPackagePromptOutputArtifact,
} = require('../dist/prompt-output/pluginPackagePromptOutputArtifact.js');
const {
  InvalidPluginPackagePromptOutputReadError,
  PluginPackagePromptOutputReadService,
  PluginPackagePromptOutputReadUnavailableError,
} = require('../dist/prompt-output/pluginPackagePromptOutputRead.js');

const NOW = 1_700_000_000_000;
const KEY = Buffer.alloc(32, 7);
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'user-a' }),
  authenticationId: 'auth-a',
  authenticatedAtMs: NOW - 1_000,
  expiresAtMs: NOW + 60_000,
  assurance: 'multi_factor',
});
const RESULT = Object.freeze({
  provider: 'openai-compatible',
  model: 'bounded-model',
  text: 'private durable output',
  finishReason: 'stop',
  usage: Object.freeze({
    inputTokens: 5,
    outputTokens: 3,
    totalTokens: 8,
    costMicros: 11,
  }),
});

function artifact() {
  return createPluginPackagePromptOutputArtifact(
    {
      projectId: 'project-a',
      runId: 'run-a',
      stepRunId: 'step-a',
      invocationId: 'invocation-a',
      requestedBy: PRINCIPAL.subject,
      result: RESULT,
      retentionPolicy: { revision: 'retention-v1', retentionMs: 86_400_000 },
      keyId: 'prompt-key-1',
      key: Buffer.from(KEY),
      sealedAtMs: NOW - 1_000,
    },
    () => Buffer.alloc(12, 9),
  );
}

function harness(overrides = {}) {
  const stored = artifact();
  const calls = [];
  let resolvedKey;
  const service = new PluginPackagePromptOutputReadService({
    artifacts: {
      async find(id) {
        calls.push(`find:${id}`);
        return stored;
      },
      async put() {
        throw new Error('unreachable');
      },
    },
    authorizer: {
      async authorize(request) {
        calls.push(`authorize:${request.artifactId}`);
        return { effect: 'allow' };
      },
    },
    retention: {
      async inspect(request) {
        calls.push(`retention:${request.reference.artifactId}`);
        return { state: 'retained' };
      },
    },
    keys: {
      async active() {
        throw new Error('read must not request active key');
      },
      async resolve(keyId) {
        calls.push(`key:${keyId}`);
        resolvedKey = Buffer.from(KEY);
        return { keyId, key: resolvedKey };
      },
    },
    now: () => NOW,
    ...overrides,
  });
  return { service, stored, calls, resolvedKey: () => resolvedKey };
}

function command(stored, overrides = {}) {
  return {
    principal: PRINCIPAL,
    projectId: stored.projectId,
    runId: stored.runId,
    artifactId: stored.artifactId,
    artifactDigest: stored.artifactDigest,
    ...overrides,
  };
}

test('reads only after metadata, policy and retention and wipes resolved key', async () => {
  const state = harness();
  const result = await state.service.read(command(state.stored));

  assert.equal(result.status, 'available');
  assert.deepEqual(result.result, RESULT);
  assert.equal(result.reference.artifactDigest, state.stored.artifactDigest);
  assert.deepEqual(state.calls, [
    `find:${state.stored.artifactId}`,
    `authorize:${state.stored.artifactId}`,
    `retention:${state.stored.artifactId}`,
    'key:prompt-key-1',
  ]);
  assert.equal(
    state.resolvedKey().every((byte) => byte === 0),
    true,
  );
});

test('masks absent and identity-drifted Artifacts before policy or key access', async () => {
  const missingCalls = [];
  const missing = harness({
    artifacts: {
      async find() {
        missingCalls.push('find');
        return null;
      },
      async put() {
        throw new Error('unreachable');
      },
    },
  });
  assert.equal(
    (await missing.service.read(command(missing.stored))).status,
    'not_found',
  );
  assert.deepEqual(missingCalls, ['find']);

  const drift = harness();
  assert.equal(
    (
      await drift.service.read(
        command(drift.stored, { projectId: 'project-b' }),
      )
    ).status,
    'not_found',
  );
  assert.deepEqual(drift.calls, [`find:${drift.stored.artifactId}`]);
});

test('masks policy denial and tombstone without resolving key material', async () => {
  const denied = harness({
    authorizer: {
      async authorize() {
        return { effect: 'deny', reasonCode: 'artifact_read_denied' };
      },
    },
  });
  assert.equal(
    (await denied.service.read(command(denied.stored))).status,
    'not_found',
  );
  assert.equal(
    denied.calls.some((call) => call.startsWith('key:')),
    false,
  );

  const tombstoned = harness({
    retention: {
      async inspect() {
        return {
          state: 'tombstoned',
          tombstonedAtMs: NOW - 1,
          tombstoneDigest: 'a'.repeat(64),
        };
      },
    },
  });
  assert.equal(
    (await tombstoned.service.read(command(tombstoned.stored))).status,
    'not_found',
  );
  assert.equal(
    tombstoned.calls.some((call) => call.startsWith('key:')),
    false,
  );
});

test('fails closed for invalid requests, corrupt decisions and missing keys', async () => {
  const invalid = harness();
  await assert.rejects(
    invalid.service.read(command(invalid.stored, { artifactDigest: 'bad' })),
    InvalidPluginPackagePromptOutputReadError,
  );
  assert.deepEqual(invalid.calls, []);

  const corruptDecision = harness({
    authorizer: {
      async authorize() {
        return { effect: 'allow', widened: true };
      },
    },
  });
  await assert.rejects(
    corruptDecision.service.read(command(corruptDecision.stored)),
    PluginPackagePromptOutputReadUnavailableError,
  );

  const missingKey = harness({
    keys: {
      async active() {
        throw new Error('unreachable');
      },
      async resolve() {
        return null;
      },
    },
  });
  await assert.rejects(
    missingKey.service.read(command(missingKey.stored)),
    PluginPackagePromptOutputReadUnavailableError,
  );
});

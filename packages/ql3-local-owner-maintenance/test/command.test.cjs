const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  LocalOwnerGcCliConfigurationError,
  createLocalOwnerGcCommandRunner,
} = require('@qinglong/local-owner-maintenance/command');
const {
  pluginPackagePromptOutputArtifactRetentionPolicyDigest,
} = require('../../ql3-ai/dist/prompt-output/pluginPackagePromptOutputArtifact');

function privateCommand(t, value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-owner-gc-cli-'));
  const filePath = path.join(root, 'command.json');
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return filePath;
}

function acknowledgementCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'owner.delivery-acknowledgement.compact',
    options: {
      databasePath: '/private/ql3.sqlite',
      profile: 'edge',
      secretDeliveryDirectory: '/private/secrets',
      retentionPolicy: {
        version: 1,
        replayRetentionMs: 2_592_000_000,
        auditRetentionMs: 2_592_000_000,
      },
    },
    request: {
      mutationId: '00000000-0000-4000-8000-000000000a02',
      requestId: 'gc-a02',
      acknowledgementMutationId: '00000000-0000-4000-8000-000000000a01',
      expectedKind: 'credential',
      expectedDeliveryDigest: 'd'.repeat(64),
    },
    ...overrides,
  };
}

function dependencies(state) {
  return {
    async openAcknowledgementGc(options) {
      state.ackOptions = options;
      return {
        profile: 'edge',
        async compact(request) {
          state.ackRequest = request;
          return {
            status: 'inserted',
            record: {
              mutationId: request.mutationId,
              requestId: request.requestId,
              acknowledgementMutationId: request.acknowledgementMutationId,
              acknowledgementKind: request.expectedKind,
              deliveryDigest: request.expectedDeliveryDigest,
              acknowledgedAtMs: 100,
              acknowledgementSemanticDigest: 'a'.repeat(64),
              bridgeClearEvidenceDigest: 'b'.repeat(64),
              retentionPolicy: options.retentionPolicy,
              retentionPolicyDigest: 'c'.repeat(64),
              retentionEligibleAtMs: 200,
              compactedAtMs: 300,
            },
          };
        },
        async close() {
          state.ackClosed = true;
        },
      };
    },
    async openPepperMaterialGc(options) {
      state.pepperOptions = options;
      return {
        profile: 'standalone',
        async collect(request) {
          state.pepperRequest = request;
          return {
            status: 'existing',
            record: {
              prepareMutationId: request.prepareMutationId,
              prepareRequestId: request.prepareRequestId,
              pepperKeyId: request.pepperKeyId,
              materialDigest: 'a'.repeat(64),
              backupMaterialDigest: 'b'.repeat(64),
              activePepperKeyId: 'active-v2',
              activeGeneration: 2,
              activeMaterialDigest: 'c'.repeat(64),
              retentionPolicy: options.retentionPolicy,
              retentionPolicyDigest: 'd'.repeat(64),
              referencesInspectedAtMs: 100,
              retentionEligibleAtMs: 200,
              preparedAtMs: 300,
              state: 'completed',
              completeMutationId: request.completeMutationId,
              completeRequestId: request.completeRequestId,
              destructionProofDigest: 'e'.repeat(64),
              completedAtMs: 400,
            },
            runtimeMaterial: {},
            backupMaterial: {},
          };
        },
        async close() {
          state.pepperClosed = true;
        },
      };
    },
    async openPromptOutputGc(options) {
      state.promptOptions = options;
      return {
        profile: options.profile,
        async collect() {
          state.promptCollected = true;
          return {
            scanned: 3,
            tombstoned: 2,
            skipped: 1,
            hasMore: false,
          };
        },
        async close() {
          state.promptClosed = true;
        },
      };
    },
    async openPromptOutputKeyRetirement(options) {
      state.promptKeyOptions = options;
      return {
        profile: options.profile,
        async retire(request) {
          state.promptKeyRequest = request;
          return {
            status: 'completed',
            keyId: request.keyId,
            retirementId: request.retirementId,
            preparationDigest: 'e'.repeat(64),
            completionDigest: 'f'.repeat(64),
            completedAtMs: 500,
          };
        },
        async close() {
          state.promptKeyClosed = true;
        },
      };
    },
  };
}

test('runs acknowledgement compaction from one private durable command file', async (t) => {
  const state = {};
  const command = acknowledgementCommand();
  const result = await createLocalOwnerGcCommandRunner(dependencies(state)).run(
    privateCommand(t, command),
  );
  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: command.operation,
    status: 'inserted',
    gcMutationId: command.request.mutationId,
    acknowledgementMutationId: command.request.acknowledgementMutationId,
    acknowledgementKind: 'credential',
    retentionEligibleAtMs: 200,
    compactedAtMs: 300,
  });
  assert.deepEqual(state.ackOptions, command.options);
  assert.deepEqual(state.ackRequest, command.request);
  assert.equal(state.ackClosed, true);
});

test('runs pepper material collection without exposing destruction digests', async (t) => {
  const state = {};
  const command = {
    schemaVersion: 1,
    operation: 'owner.pepper-material.collect',
    options: {
      databasePath: '/private/ql3.sqlite',
      profile: 'standalone',
      keyringDirectory: '/private/keyring',
      backupDirectory: '/backup/keyring',
      retentionPolicy: {
        version: 1,
        acknowledgementRetentionMs: 604_800_000,
        auditRetentionMs: 2_592_000_000,
        backupRetentionMs: 2_592_000_000,
      },
    },
    request: {
      prepareMutationId: '00000000-0000-4000-8000-000000000b01',
      prepareRequestId: 'gc-b01',
      completeMutationId: '00000000-0000-4000-8000-000000000b02',
      completeRequestId: 'gc-b02',
      pepperKeyId: 'retired-v1',
    },
  };
  const result = await createLocalOwnerGcCommandRunner(dependencies(state)).run(
    privateCommand(t, command),
  );
  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: command.operation,
    status: 'existing',
    prepareMutationId: command.request.prepareMutationId,
    completeMutationId: command.request.completeMutationId,
    pepperKeyId: command.request.pepperKeyId,
    state: 'completed',
    completedAtMs: 400,
  });
  assert.equal('destructionProofDigest' in result, false);
  assert.equal(state.pepperClosed, true);
});

test('runs one bounded Prompt output collection without returning policy data', async (t) => {
  const state = {};
  const policy = { revision: 'retention-v1', retentionMs: 3_600_000 };
  const command = {
    schemaVersion: 1,
    operation: 'owner.prompt-output.collect',
    options: {
      databasePath: '/private/ql3.sqlite',
      profile: 'edge',
      limit: 4,
      retentionPolicyCatalog: {
        schemaVersion: 1,
        policies: [
          {
            projectId: 'project-a',
            policy,
            policyDigest:
              pluginPackagePromptOutputArtifactRetentionPolicyDigest(policy),
          },
        ],
      },
    },
    request: {},
  };
  const result = await createLocalOwnerGcCommandRunner(dependencies(state)).run(
    privateCommand(t, command),
  );
  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: command.operation,
    scanned: 3,
    tombstoned: 2,
    skipped: 1,
    hasMore: false,
  });
  assert.deepEqual(state.promptOptions, command.options);
  assert.equal(state.promptCollected, true);
  assert.equal(state.promptClosed, true);
  assert.equal('retentionPolicyCatalog' in result, false);
});

test('retires one Prompt output key without returning key material', async (t) => {
  const state = {};
  const command = {
    schemaVersion: 1,
    operation: 'owner.prompt-output-key.retire',
    options: {
      databasePath: '/private/ql3.sqlite',
      profile: 'edge',
      keyringPath: '/private/prompt-output-keyring.json',
    },
    request: {
      keyId: 'qlpo-retired',
      retirementId: 'retirement-a',
      requestId: 'request-a',
      mutationId: 'mutation-a',
    },
  };
  const result = await createLocalOwnerGcCommandRunner(dependencies(state)).run(
    privateCommand(t, command),
  );
  assert.deepEqual(result, {
    schemaVersion: 1,
    operation: command.operation,
    status: 'completed',
    keyId: command.request.keyId,
    retirementId: command.request.retirementId,
    preparationDigest: 'e'.repeat(64),
    completionDigest: 'f'.repeat(64),
    completedAtMs: 500,
  });
  assert.deepEqual(state.promptKeyOptions, command.options);
  assert.deepEqual(state.promptKeyRequest, command.request);
  assert.equal(state.promptKeyClosed, true);
  assert.equal(JSON.stringify(result).includes('material'), false);
});

test('rejects widened or non-private command files before opening authority', async (t) => {
  const state = {};
  const runner = createLocalOwnerGcCommandRunner(dependencies(state));
  const widened = privateCommand(t, acknowledgementCommand({ now: 1 }));
  await assert.rejects(runner.run(widened), LocalOwnerGcCliConfigurationError);
  const broad = privateCommand(t, acknowledgementCommand());
  fs.chmodSync(broad, 0o644);
  await assert.rejects(runner.run(broad), LocalOwnerGcCliConfigurationError);
  assert.equal(state.ackOptions, undefined);
  assert.equal(state.pepperOptions, undefined);
  assert.equal(state.promptOptions, undefined);
});

test('binary has a bounded command-file-only interface', () => {
  const help = spawnSync(
    process.execPath,
    [path.join(__dirname, '../dist/cli.js'), '--help'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-owner-gc run --command-file /);
  assert.equal(help.stderr, '');
  const invalid = spawnSync(
    process.execPath,
    [path.join(__dirname, '../dist/cli.js'), 'run'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(invalid.status, 64);
  assert.equal(invalid.stdout, '');
  assert.equal(
    JSON.parse(invalid.stderr).code,
    'LOCAL_OWNER_GC_CLI_USAGE_INVALID',
  );
});

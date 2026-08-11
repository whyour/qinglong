const assert = require('node:assert/strict');
const { chmod, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  ProductionClusterAiConfigError,
  loadProductionClusterAiConfig,
  startProductionClusterAiControlApplication,
} = require('@qinglong/cluster-control/ai-production');
const {
  canonicalPluginPackagePromptOutputKeyringManifest,
  PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA,
} = require('@qinglong/ai/plugin-package-prompt-output-keyring-manifest');

function enabledEnvironment(overrides = {}) {
  return {
    QL3_CLUSTER_AI_ENABLED: 'true',
    QL3_CLUSTER_AI_PROVIDER_AUTHORITY_FILE: '/var/run/qinglong/ai/providers.json',
    QL3_CLUSTER_AI_SECRET_ROOT: '/var/run/qinglong/ai/provider-secrets',
    ...overrides,
  };
}

function controlConfig() {
  return {
    enabled: true,
    profile: 'cluster-control',
    http: { host: '127.0.0.1', port: 5800 },
    database: {
      connection: {
        host: '127.0.0.1',
        port: 5432,
        database: 'qinglong',
        user: 'ql3_runtime',
        password: 'test-only',
        tls: { mode: 'disable' },
      },
      pool: { maxConnections: 8 },
    },
    security: { apiCredentialPepper: 'test-only' },
  };
}

test('AI config is fail-closed and bounded behind the explicit process flag', () => {
  assert.throws(
    () => loadProductionClusterAiConfig({}),
    (error) =>
      error instanceof ProductionClusterAiConfigError &&
      error.code === 'QL3_CLUSTER_AI_CONFIG_INVALID',
  );
  assert.deepEqual(loadProductionClusterAiConfig(enabledEnvironment()), {
    enabled: true,
    providerAuthorityFile: '/var/run/qinglong/ai/providers.json',
    secretRootDirectory: '/var/run/qinglong/ai/provider-secrets',
    maxConcurrent: 4,
    recoveryLimit: 32,
    databaseMaxConnections: 4,
  });
  assert.throws(
    () =>
      loadProductionClusterAiConfig(
        enabledEnvironment({ QL3_CLUSTER_AI_MAX_CONCURRENT: '65' }),
      ),
    /between 1 and 64/,
  );
  assert.throws(
    () =>
      loadProductionClusterAiConfig(
        enabledEnvironment({
          QL3_CLUSTER_AI_PROMPT_OUTPUT_ENABLED: 'true',
        }),
      ),
    /QL3_CLUSTER_AI_PROMPT_OUTPUT_KEYRING_ROOT is invalid/,
  );
});

test('explicit AI composition injects one reviewed Prompt capability and drains it after HTTP control', async () => {
  const secretRoot = await mkdtemp(join(tmpdir(), 'ql3-cluster-ai-secret-'));
  const events = [];
  const promptCatalog = Object.freeze({ inspect() {} });
  const promptExecutions = Object.freeze({ execute() {} });
  const promptExecutionInspections = Object.freeze({ inspectAuthorized() {} });
  let promptOptions;
  let controlOptions;
  const neverUnavailable = new Promise(() => {});
  try {
    const application = await startProductionClusterAiControlApplication({
      control: { config: controlConfig() },
      ai: {
        enabled: true,
        providerAuthorityFile: '/unused/providers.json',
        secretRootDirectory: secretRoot,
        maxConcurrent: 3,
        recoveryLimit: 11,
        databaseMaxConnections: 2,
      },
      audit() {},
      async bootstrapPrompt(options) {
        promptOptions = options;
        return {
          status: 'active',
          profile: 'cluster',
          readiness: {},
          capability: {},
          prompts: {},
          promptCatalog,
          promptExecutions,
          promptExecutionInspections,
          async stop() {
            events.push('stop-prompt');
            return 'stopped';
          },
        };
      },
      async startControl(options) {
        controlOptions = options;
        return {
          status: 'active',
          address: { host: '127.0.0.1', port: 5800 },
          evidence: {},
          recovery: { safe: true, remaining: 0, failed: 0 },
          unavailable: neverUnavailable,
          availabilityStatus() {
            return 'ready';
          },
          async stop() {
            events.push('stop-control');
            return 'stopped';
          },
        };
      },
    });

    assert.equal(application.status, 'active');
    assert.equal(application.availabilityStatus(), 'ready');
    assert.equal(promptOptions.enabled, true);
    assert.equal(promptOptions.maxConcurrent, 3);
    assert.equal(promptOptions.recoveryLimit, 11);
    assert.equal(controlOptions.promptCatalog.capability, promptCatalog);
    assert.equal(controlOptions.promptExecution.capability, promptExecutions);
    assert.equal(
      controlOptions.promptExecutionInspection.capability,
      promptExecutionInspections,
    );
    assert.equal('promptOutputRead' in controlOptions, false);
    assert.equal(await application.stop(), 'stopped');
    assert.equal(await application.stop(), 'stopped');
    assert.deepEqual(events, ['stop-control', 'stop-prompt']);
  } finally {
    await rm(secretRoot, { recursive: true, force: true });
  }
});

test('output-enabled AI composition wires exact and request-keyed protected reads', async () => {
  const secretRoot = await mkdtemp(join(tmpdir(), 'ql3-cluster-ai-secret-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'ql3-cluster-ai-output-'));
  const manifest = canonicalPluginPackagePromptOutputKeyringManifest({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA,
    generation: 1,
    activeKeyId: 'prompt-key-1',
    keys: { 'prompt-key-1': Buffer.alloc(32, 7).toString('base64url') },
    retirements: {},
  });
  await writeFile(join(outputRoot, 'keyring.json'), manifest, { mode: 0o440 });
  await chmod(join(outputRoot, 'keyring.json'), 0o440);
  let promptOptions;
  let controlOptions;
  const promptOutputs = Object.freeze({ read() {} });
  const promptExecutionOutputs = Object.freeze({ read() {} });
  try {
    const application = await startProductionClusterAiControlApplication({
      control: { config: controlConfig() },
      ai: {
        enabled: true,
        providerAuthorityFile: '/unused/providers.json',
        secretRootDirectory: secretRoot,
        promptOutputKeyringRootDirectory: outputRoot,
        maxConcurrent: 1,
        recoveryLimit: 1,
        databaseMaxConnections: 1,
      },
      audit() {},
      async bootstrapPrompt(options) {
        promptOptions = options;
        return {
          status: 'active',
          profile: 'cluster',
          readiness: {},
          capability: {},
          prompts: {},
          promptCatalog: { inspect() {} },
          promptExecutions: { execute() {} },
          promptExecutionInspections: { inspectAuthorized() {} },
          promptOutputs,
          promptExecutionOutputs,
          async stop() { return 'stopped'; },
        };
      },
      async startControl(options) {
        controlOptions = options;
        return {
          status: 'active',
          address: { host: '127.0.0.1', port: 5800 },
          evidence: {},
          recovery: { safe: true, remaining: 0, failed: 0 },
          unavailable: new Promise(() => {}),
          availabilityStatus() { return 'ready'; },
          async stop() { return 'stopped'; },
        };
      },
    });
    assert.equal(typeof promptOptions.promptOutputKeys.resolve, 'function');
    assert.equal(
      typeof promptOptions.promptOutputRead.authorizer.authorize,
      'function',
    );
    assert.equal(controlOptions.promptOutputRead.capability, promptOutputs);
    assert.equal(
      controlOptions.promptExecutionOutputRead.capability,
      promptExecutionOutputs,
    );
    assert.equal(await application.stop(), 'stopped');
  } finally {
    manifest.fill(0);
    await rm(secretRoot, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('AI composition fails closed and drains a non-active Prompt bootstrap', async () => {
  const secretRoot = await mkdtemp(join(tmpdir(), 'ql3-cluster-ai-secret-'));
  let stops = 0;
  try {
    await assert.rejects(
      startProductionClusterAiControlApplication({
        control: { config: controlConfig() },
        ai: {
          enabled: true,
          providerAuthorityFile: '/unused/providers.json',
          secretRootDirectory: secretRoot,
          maxConcurrent: 1,
          recoveryLimit: 1,
          databaseMaxConnections: 1,
        },
        audit() {},
        async bootstrapPrompt() {
          return {
            status: 'disabled',
            profile: 'cluster',
            async stop() {
              stops += 1;
              return 'stopped';
            },
          };
        },
        async startControl() {
          throw new Error('control must not start');
        },
      }),
      /Prompt application did not activate/,
    );
    assert.equal(stops, 1);
  } finally {
    await rm(secretRoot, { recursive: true, force: true });
  }
});

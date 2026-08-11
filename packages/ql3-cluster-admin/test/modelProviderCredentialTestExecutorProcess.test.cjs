const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const test = require('node:test');

const {
  createModelProviderCredentialTestAllowlist,
  createModelProviderCredentialTestExecution,
  createModelProviderCredentialTestPlan,
  createModelProviderCredentialTestResult,
} = require('@qinglong/ai/model-provider-credential-test-connection');
const {
  ModelProviderCredentialTestExecutorProcessConfigError,
  loadModelProviderCredentialTestExecutorProcessConfig,
  runModelProviderCredentialTestExecutorProcess,
} = require('@qinglong/cluster-admin/model-provider-credential-test-executor-process');

const COMMAND = Object.freeze({
  schemaVersion: 1,
  executionId: '319f7094-a853-4f3b-82ab-dfa08e6bd1c4',
  testId: '419f7094-a853-4f3b-82ab-dfa08e6bd1c5',
});
const CLI = resolve(
  __dirname,
  '../dist/model-provider-credential/modelProviderCredentialTestExecutorCli.js',
);

function environment(overrides = {}) {
  return {
    QL3_MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTOR_ENABLED: 'true',
    QL3_PROFILE: 'cluster-admin',
    QL3_MODEL_PROVIDER_CREDENTIAL_TEST_COMMAND_FILE:
      '/run/ql3-provider-test/command.json',
    QL3_MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_FILE:
      '/run/ql3-provider-test/allowlist.json',
    QL3_MODEL_PROVIDER_CREDENTIAL_TEST_SECRET_ROOT:
      '/run/ql3-provider-test/secrets',
    QL3_POSTGRES_AI_CREDENTIAL_TESTER_URL:
      'postgresql://ql3_ai_credential_tester:secret@postgres.example.test/ql3',
    QL3_POSTGRES_AI_CREDENTIAL_TESTER_TLS_MODE: 'disable',
    QL3_POSTGRES_AI_CREDENTIAL_TESTER_ALLOW_INSECURE: 'true',
    ...overrides,
  };
}

function evidence() {
  return {
    ready: true,
    currentUser: 'ql3_ai_credential_tester',
    migrationIds: ['pg-9015-ai-model-provider-credential-test-connection'],
    writablePrimary: true,
    testerAuthority: true,
    leastPrivilege: true,
  };
}

function testData() {
  const allowlist = createModelProviderCredentialTestAllowlist({
    revision: 'catalog-v1',
    providers: [
      {
        provider: 'openai-compatible',
        adapter: 'openai-compatible',
        baseUrl: 'https://provider.example.test/v1/',
        revision: 'endpoint-v1',
        deadlineMs: 5_000,
        maxResponseBytes: 64 * 1_024,
        maxModels: 64,
        maxCostMicrousd: 0,
        retryLimit: 0,
      },
    ],
  });
  const plan = createModelProviderCredentialTestPlan({
    testId: COMMAND.testId,
    requestId: 'test-request-1',
    projectId: 'project-a',
    provider: 'openai-compatible',
    endpoint: allowlist.providers[0],
    requestedBy: { type: 'user', id: 'owner-a' },
    fence: { projectVersion: 3, bindingVersion: 7 },
    plannedAtMs: 100,
    expiresAtMs: 60_100,
  });
  const execution = createModelProviderCredentialTestExecution({
    executionId: COMMAND.executionId,
    testId: COMMAND.testId,
    planDigest: plan.planDigest,
    startedAtMs: 200,
  });
  const result = createModelProviderCredentialTestResult({
    executionId: COMMAND.executionId,
    testId: COMMAND.testId,
    planDigest: plan.planDigest,
    outcome: 'reachable',
    modelCount: 2,
    durationMs: 40,
    completedAtMs: 240,
  });
  return { allowlist, plan, execution, result };
}

test('disabled one-shot tester reads no database, file or Secret authority', async () => {
  const reads = [];
  const disabled = new Proxy(
    { QL3_MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTOR_ENABLED: 'false' },
    {
      get(target, property) {
        reads.push(property);
        if (
          property === 'QL3_MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTOR_ENABLED'
        ) {
          return target[property];
        }
        throw new Error(`unexpected read: ${String(property)}`);
      },
    },
  );
  const result = await runModelProviderCredentialTestExecutorProcess({
    environment: disabled,
  });
  assert.deepEqual(result, { status: 'disabled' });
  assert.deepEqual(reads, [
    'QL3_MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTOR_ENABLED',
  ]);
});

test('loads a bounded single-connection tester configuration', () => {
  const config = loadModelProviderCredentialTestExecutorProcessConfig(
    environment({
      QL3_MODEL_PROVIDER_CREDENTIAL_TEST_DENY_CANARY_HOST:
        'kubernetes.default.svc',
      QL3_MODEL_PROVIDER_CREDENTIAL_TEST_DENY_CANARY_PORT: '443',
    }),
  );
  assert.equal(config.enabled, true);
  assert.equal(config.profile, 'cluster-admin');
  assert.equal(config.database.pool.maxConnections, 1);
  assert.equal(
    config.database.pool.applicationName,
    'qinglong3-ai-credential-tester',
  );
  assert.equal(config.database.connection.tls.mode, 'disable');
  assert.deepEqual(config.networkPolicyDenyCanary, {
    host: 'kubernetes.default.svc',
    port: 443,
  });
  assert.equal(config.database.connection.applicationName, undefined);
});

test('rejects profile, path, pool and implicit TLS widening', () => {
  for (const candidate of [
    environment({ QL3_PROFILE: 'cluster-control' }),
    environment({
      QL3_MODEL_PROVIDER_CREDENTIAL_TEST_COMMAND_FILE: 'command.json',
    }),
    environment({ QL3_POSTGRES_AI_CREDENTIAL_TESTER_POOL_MAX: '2' }),
    environment({
      QL3_POSTGRES_AI_CREDENTIAL_TESTER_ALLOW_INSECURE: 'false',
    }),
    environment({
      QL3_MODEL_PROVIDER_CREDENTIAL_TEST_DENY_CANARY_HOST:
        'kubernetes.default.svc',
    }),
    environment({
      QL3_MODEL_PROVIDER_CREDENTIAL_TEST_DENY_CANARY_HOST:
        'kubernetes.default.svc',
      QL3_MODEL_PROVIDER_CREDENTIAL_TEST_DENY_CANARY_PORT: '70000',
    }),
  ]) {
    assert.throws(
      () => loadModelProviderCredentialTestExecutorProcessConfig(candidate),
      ModelProviderCredentialTestExecutorProcessConfigError,
    );
  }
});

test('composes one execution, exact readiness and guaranteed database close', async () => {
  const data = testData();
  const pool = { async query() {}, async connect() {} };
  const calls = [];
  let closed = 0;
  const processResult = await runModelProviderCredentialTestExecutorProcess({
    environment: environment(),
    command: COMMAND,
    allowlist: data.allowlist,
    async openDatabase() {
      calls.push('open');
      return {
        pool,
        async close() {
          calls.push('close');
          closed += 1;
        },
      };
    },
    async assertReady(candidate) {
      calls.push('ready');
      assert.equal(candidate, pool);
      return evidence();
    },
    secrets: {
      async verify() {},
      async resolveProjectSecretMaterial() {
        throw new Error('injected executor must own secret use');
      },
    },
    executor: {
      async execute(input) {
        calls.push('execute');
        assert.deepEqual(input, {
          executionId: COMMAND.executionId,
          testId: COMMAND.testId,
          allowlist: data.allowlist,
        });
        return {
          status: 'completed',
          plan: data.plan,
          execution: data.execution,
          result: data.result,
        };
      },
    },
  });
  assert.equal(processResult.status, 'completed');
  assert.equal(processResult.test.result.modelCount, 2);
  assert.equal(closed, 1);
  assert.deepEqual(calls, ['open', 'ready', 'execute', 'close']);
  assert.doesNotMatch(JSON.stringify(processResult), /secretRef|token/i);
});

test('closes the tester database when execution fails', async () => {
  const data = testData();
  let closed = 0;
  const failure = new Error('execution failed');
  await assert.rejects(
    runModelProviderCredentialTestExecutorProcess({
      environment: environment(),
      command: COMMAND,
      allowlist: data.allowlist,
      async openDatabase() {
        return {
          pool: { async query() {}, async connect() {} },
          async close() {
            closed += 1;
          },
        };
      },
      async assertReady() {
        return evidence();
      },
      secrets: {
        async verify() {},
        async resolveProjectSecretMaterial() {},
      },
      executor: {
        async execute() {
          throw failure;
        },
      },
    }),
    failure,
  );
  assert.equal(closed, 1);
});

test('CLI emits only content-free stable facts', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.equal(help.stdout, 'Usage: ql3-provider-credential-test-execute\n');

  const disabled = spawnSync(process.execPath, [CLI], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QL3_MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTOR_ENABLED: 'false',
    },
  });
  assert.equal(disabled.status, 0);
  assert.deepEqual(JSON.parse(disabled.stdout), {
    schemaVersion: 1,
    component: 'qinglong3-model-provider-credential-test-executor',
    event: 'execution_disabled',
  });
  assert.doesNotMatch(disabled.stdout + disabled.stderr, /secret|token/i);
});

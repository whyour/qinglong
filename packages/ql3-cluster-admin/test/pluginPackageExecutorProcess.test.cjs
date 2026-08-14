const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterPluginPackageExecutorProcessConfigError,
  loadClusterPluginPackageExecutorProcessConfig,
  runClusterPluginPackageExecutorProcess,
} = require('@qinglong/cluster-admin/plugin-package-executor-process');

function environment(overrides = {}) {
  return {
    QL3_PLUGIN_PACKAGE_EXECUTOR_ENABLED: 'true',
    QL3_PLUGIN_PACKAGE_EXECUTOR_OWNER: 'cluster_package_executor_1',
    QL3_PLUGIN_PACKAGE_EXECUTOR_APPROVAL_BATCH_SIZE: '4',
    QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_BATCH_SIZE: '4',
    QL3_PLUGIN_PACKAGE_EXECUTOR_MAX_BATCHES: '2',
    QL3_PLUGIN_PACKAGE_EXECUTOR_LEASE_DURATION_MS: '600000',
    QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_PAGE_SIZE: '8',
    QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_MAX_PAGES: '4',
    QL3_PLUGIN_PACKAGE_EXECUTOR_SECRET_ROOT:
      '/var/run/secrets/qinglong3/plugin-package-values',
    QL3_POSTGRES_PACKAGE_EXECUTOR_URL:
      'postgresql://ql3_package_executor:secret@postgres/qinglong',
    QL3_POSTGRES_TLS_MODE: 'disable',
    QL3_POSTGRES_ALLOW_INSECURE: 'true',
    ...overrides,
  };
}

function actionControllerEnvironment(overrides = {}) {
  return environment({
    QL3_PLUGIN_PACKAGE_EXECUTOR_SECRET_ROOT: undefined,
    QL3_PLUGIN_PACKAGE_SECRET_ACTION_CONTROLLER_ENABLED: 'true',
    QL3_PLUGIN_PACKAGE_SECRET_ACTION_CONTROLLER_LIMIT: '6',
    QL3_PLUGIN_PACKAGE_SECRET_ACTION_IMAGE:
      'registry.example.com/qinglong/qinglong3-cluster-admin@sha256:' +
      'c'.repeat(64),
    QL3_PLUGIN_PACKAGE_SECRET_ACTION_POSTGRES_CA_SECRET:
      'ql3-cluster-plugin-package-executor',
    QL3_PLUGIN_PACKAGE_SECRET_ACTION_POSTGRES_CA_KEY: 'postgres-ca.crt',
    QL3_PLUGIN_PACKAGE_SECRET_ACTION_POSTGRES_SERVERNAME:
      'postgres.qinglong3-system.svc',
    QL3_PLUGIN_PACKAGE_SECRET_ACTION_POSTGRES_URL_SECRET:
      'ql3-cluster-plugin-package-executor',
    QL3_PLUGIN_PACKAGE_SECRET_ACTION_POSTGRES_URL_KEY:
      'postgres-package-executor-url',
    ...overrides,
  });
}

test('disabled executor opens no PostgreSQL authority', async () => {
  let opened = 0;
  const result = await runClusterPluginPackageExecutorProcess({
    environment: { QL3_PLUGIN_PACKAGE_EXECUTOR_ENABLED: 'false' },
    async openDatabase() {
      opened += 1;
      throw new Error('must not open');
    },
  });
  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(opened, 0);
});

test('loads bounded low-footprint Package-executor configuration', () => {
  const config = loadClusterPluginPackageExecutorProcessConfig(environment());
  assert.equal(config.enabled, true);
  assert.equal(config.owner, 'cluster_package_executor_1');
  assert.equal(config.approvalBatchSize, 4);
  assert.equal(config.dispatchBatchSize, 4);
  assert.equal(config.maxBatches, 2);
  assert.equal(config.revocationPageSize, 8);
  assert.equal(config.revocationMaxPages, 4);
  assert.equal(config.dispatchId, null);
  assert.equal(
    config.secretProjectionRoot,
    '/var/run/secrets/qinglong3/plugin-package-values',
  );
  assert.equal(config.database.pool.maxConnections, 2);
  assert.equal(config.database.connection.tls.mode, 'disable');
});

test('loads one bounded action-scoped dispatch without widening batch limits', () => {
  const config = loadClusterPluginPackageExecutorProcessConfig(
    environment({
      QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_ID: 'dispatch.secret-binding.42',
      QL3_PLUGIN_PACKAGE_EXECUTOR_APPROVAL_BATCH_SIZE: undefined,
      QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_BATCH_SIZE: undefined,
      QL3_PLUGIN_PACKAGE_EXECUTOR_MAX_BATCHES: undefined,
    }),
  );
  assert.equal(config.enabled, true);
  assert.equal(config.dispatchId, 'dispatch.secret-binding.42');
  assert.equal(config.approvalBatchSize, 8);
  assert.equal(config.dispatchBatchSize, 8);
  assert.equal(config.maxBatches, 4);
});

test('loads a bounded digest-pinned Kubernetes Secret action controller', () => {
  const config = loadClusterPluginPackageExecutorProcessConfig(
    actionControllerEnvironment(),
  );
  assert.equal(config.enabled, true);
  assert.equal(config.secretProjectionRoot, null);
  assert.equal(config.kubernetesSecretActions.limit, 6);
  assert.equal(
    config.kubernetesSecretActions.job.serviceAccountName,
    'ql3-plugin-package-secret-action',
  );
  assert.equal(
    config.kubernetesSecretActions.job.postgres.connection.mode,
    'url',
  );
  assert.equal(
    config.kubernetesSecretActions.job.postgres.connection.secretName,
    'ql3-cluster-plugin-package-executor',
  );
});

test('action-scoped mode skips every Approval consumer and shared queue scan', async () => {
  const calls = [];
  const pool = {};
  const readiness = {
    ready: true,
    writablePrimary: true,
    serverVersionNum: 180004,
    serverMajor: 18,
    currentUser: 'ql3_package_executor',
    contractName: 'control-core',
    contractVersion: 62,
    migrationIds: ['pg-0063-plugin-package-secret-binding-transition-receipts'],
  };
  const rejectConsumer = async () => {
    throw new Error('action-scoped executor must not consume approvals');
  };
  const result = await runClusterPluginPackageExecutorProcess({
    environment: environment({
      QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_ID: 'dispatch.secret-binding.42',
    }),
    async openDatabase() {
      calls.push('open');
      return {
        pool,
        async close() {
          calls.push('close');
        },
      };
    },
    async assertReady(candidate) {
      assert.equal(candidate, pool);
      calls.push('ready');
      return readiness;
    },
    consumeApprovals: rejectConsumer,
    consumeTrustTransitionApprovals: rejectConsumer,
    consumeSecretBindingApprovals: rejectConsumer,
    consumeSecretBindingTransitionApprovals: rejectConsumer,
    createDispatcher(options) {
      assert.equal(options.pool, pool);
      assert.equal(typeof options.secretExistenceInspector.assertExists, 'function');
      return {
        async dispatchBatch() {
          throw new Error('action-scoped executor must not scan the queue');
        },
        async dispatchById({ dispatchId }) {
          calls.push(`dispatch:${dispatchId}`);
          return {
            scanned: 1,
            claimed: 1,
            started: 1,
            succeeded: 1,
            failed: 0,
            blocked: 0,
            retrying: 0,
            deferred: 0,
            recoveryRequired: 0,
            alreadyTerminal: 0,
            unavailable: 0,
            truncated: false,
          };
        },
      };
    },
  });
  assert.deepEqual(calls, [
    'open',
    'ready',
    'dispatch:dispatch.secret-binding.42',
    'close',
  ]);
  assert.equal(result.status, 'completed');
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].approvals.scanned, 0);
  assert.equal(result.batches[0].dispatch.succeeded, 1);
});

test('batch mode consumes approvals before reconciling exact Secret action Jobs', async () => {
  const calls = [];
  const pool = {
    async query() {
      throw new Error('repositories are injected behind the controller factory');
    },
    async connect() {
      throw new Error('repositories are injected behind the controller factory');
    },
  };
  const approvalSummary = {
    scanned: 0,
    consumed: 0,
    existing: 0,
    expired: 0,
    blocked: 0,
  };
  const readiness = {
    ready: true,
    writablePrimary: true,
    serverVersionNum: 180004,
    serverMajor: 18,
    currentUser: 'ql3_package_executor',
    contractName: 'control-core',
    contractVersion: 62,
    migrationIds: ['pg-0063-plugin-package-secret-binding-transition-receipts'],
  };
  const result = await runClusterPluginPackageExecutorProcess({
    environment: actionControllerEnvironment(),
    async openDatabase() {
      calls.push('open');
      return {
        pool,
        async close() {
          calls.push('close');
        },
      };
    },
    async assertReady() {
      calls.push('ready');
      return readiness;
    },
    async consumeApprovals() {
      calls.push('publisher-approvals');
      return approvalSummary;
    },
    async consumeTrustTransitionApprovals() {
      calls.push('trust-approvals');
      return approvalSummary;
    },
    async consumeSecretBindingApprovals() {
      calls.push('binding-approvals');
      return { ...approvalSummary, scanned: 1, consumed: 1 };
    },
    async consumeSecretBindingTransitionApprovals() {
      calls.push('transition-approvals');
      return approvalSummary;
    },
    async createSecretActionController(options) {
      assert.equal(options.job.image.endsWith('c'.repeat(64)), true);
      assert.equal(typeof options.executions.completeExecution, 'function');
      assert.equal(typeof options.bindings.find, 'function');
      assert.equal(typeof options.transitionReceipts.find, 'function');
      calls.push('controller-open');
      return {
        controller: {
          async reconcile({ limit }) {
            calls.push(`reconcile:${limit}`);
            return {
              scanned: 1,
              created: 1,
              existing: 0,
              active: 0,
              recoveredSucceeded: 0,
              recoveredFailed: 0,
              recoveredBlocked: 0,
              recoveryRequired: 0,
              unavailable: 0,
              truncated: false,
            };
          },
        },
        dispose() {
          calls.push('controller-close');
        },
      };
    },
    createDispatcher() {
      return {
        async dispatchById() {
          throw new Error('batch mode must not exact dispatch');
        },
        async dispatchBatch() {
          calls.push('dispatch-batch');
          return {
            scanned: 0,
            claimed: 0,
            started: 0,
            succeeded: 0,
            failed: 0,
            blocked: 0,
            retrying: 0,
            deferred: 0,
            recoveryRequired: 0,
            alreadyTerminal: 0,
            unavailable: 0,
            truncated: false,
          };
        },
      };
    },
  });
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].secretActionJobs.created, 1);
  assert.deepEqual(calls, [
    'open',
    'ready',
    'publisher-approvals',
    'trust-approvals',
    'binding-approvals',
    'transition-approvals',
    'controller-open',
    'reconcile:6',
    'dispatch-batch',
    'controller-close',
    'close',
  ]);
});

test('rejects implicit insecure PostgreSQL and unbounded work', () => {
  for (const invalid of [
    environment({ QL3_POSTGRES_ALLOW_INSECURE: undefined }),
    environment({ QL3_PLUGIN_PACKAGE_EXECUTOR_MAX_BATCHES: '65' }),
    environment({ QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_PAGE_SIZE: '129' }),
    environment({ QL3_PLUGIN_PACKAGE_EXECUTOR_OWNER: 'not safe' }),
    environment({ QL3_PLUGIN_PACKAGE_EXECUTOR_SECRET_ROOT: 'relative/path' }),
    environment({
      QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_ID: 'dispatch id with spaces',
    }),
    actionControllerEnvironment({
      QL3_PLUGIN_PACKAGE_SECRET_ACTION_IMAGE: 'tag-only:latest',
    }),
    actionControllerEnvironment({
      QL3_PLUGIN_PACKAGE_SECRET_ACTION_POSTGRES_URL_SECRET: undefined,
    }),
  ]) {
    assert.throws(
      () => loadClusterPluginPackageExecutorProcessConfig(invalid),
      ClusterPluginPackageExecutorProcessConfigError,
    );
  }
});

test('keeps executor authority off the cluster-admin root', () => {
  const root = require('@qinglong/cluster-admin');
  const manifest = require('../package.json');
  assert.equal(root.runClusterPluginPackageExecutorProcess, undefined);
  assert.equal(
    manifest.bin['ql3-plugin-package-execute'],
    'dist/plugin-package/executor/pluginPackageExecutorCli.js',
  );
});

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chmod, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const {
  ClusterWorkerCredentialExecutorProcessConfigError,
  loadClusterWorkerCredentialExecutorProcessConfig,
  runClusterWorkerCredentialExecutorProcess,
} = require('@qinglong/cluster-admin/worker-credential-executor-process');

const COMMAND = Object.freeze({
  schemaVersion: 1,
  actionRef: 'worker-credential:delivery-7',
  approvalRequestId: 'approval-7',
  consumptionId: 'consumption-7',
  dispatchId: 'dispatch-7',
  auditEventId: 'audit-7',
});
const CLI = resolve(__dirname, '../dist/worker-credential/workerCredentialExecutorCli.js');

function enabledEnvironment(paths, overrides = {}) {
  return {
    QL3_WORKER_CREDENTIAL_EXECUTOR_ENABLED: 'true',
    QL3_PROFILE: 'cluster-admin',
    QL3_WORKER_CREDENTIAL_EXECUTOR_COMMAND_FILE: paths.commandFile,
    QL3_WORKER_CREDENTIAL_EXECUTOR_PEPPER_FILE: paths.pepperFile,
    QL3_WORKER_CREDENTIAL_EXECUTOR_CLUSTER_IDENTITY: 'cluster-primary',
    QL3_WORKER_CREDENTIAL_EXECUTOR_STAGE_NAMESPACE: 'qinglong3-stage',
    QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_NAMESPACE: 'qinglong3-worker',
    QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_SECRET: 'worker-credential',
    QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_DEPLOYMENT: 'worker-runtime',
    QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_DATA_KEY: 'credential',
    QL3_WORKER_CREDENTIAL_EXECUTOR_DELIVERY_SERVICE_ACCOUNT:
      'worker-credential-delivery',
    QL3_WORKER_CREDENTIAL_EXECUTOR_IDENTITY_SECRET: 'cluster-identity',
    QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_URL:
      'postgresql://worker_executor:secret@postgres.example.test/ql3',
    QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_TLS_MODE: 'disable',
    QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_ALLOW_INSECURE: 'true',
    ...overrides,
  };
}

async function authorityFixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ql3-worker-executor-'));
  const paths = {
    commandFile: join(directory, 'command.json'),
    pepperFile: join(directory, 'pepper'),
  };
  try {
    await writeFile(paths.commandFile, `${JSON.stringify(COMMAND)}\n`, {
      mode: options.commandMode ?? 0o440,
    });
    await writeFile(
      paths.pepperFile,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      { mode: options.pepperMode ?? 0o440 },
    );
    await chmod(paths.commandFile, options.commandMode ?? 0o440);
    await chmod(paths.pepperFile, options.pepperMode ?? 0o440);
    return await run(paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('disabled Worker executor reads no profile, files or authorities', async () => {
  const reads = [];
  const environment = new Proxy(
    { QL3_WORKER_CREDENTIAL_EXECUTOR_ENABLED: 'false' },
    {
      get(target, property) {
        reads.push(property);
        if (property === 'QL3_WORKER_CREDENTIAL_EXECUTOR_ENABLED') {
          return target[property];
        }
        throw new Error(`disabled config read ${String(property)}`);
      },
    },
  );
  let created = 0;
  let executed = 0;
  const result = await runClusterWorkerCredentialExecutorProcess({
    environment,
    async createKubernetesAuthority() {
      created += 1;
      throw new Error('must not create');
    },
    async execute() {
      executed += 1;
      throw new Error('must not execute');
    },
  });
  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(created, 0);
  assert.equal(executed, 0);
  assert.deepEqual(reads, ['QL3_WORKER_CREDENTIAL_EXECUTOR_ENABLED']);
});

test('loads one explicit caller-driven executor configuration', () => {
  const config = loadClusterWorkerCredentialExecutorProcessConfig(
    enabledEnvironment({
      commandFile: '/run/ql3-worker-executor/command.json',
      pepperFile: '/run/ql3-worker-executor/pepper',
    }),
  );
  assert.equal(config.enabled, true);
  assert.equal(config.profile, 'cluster-admin');
  assert.equal(config.database.connection.tls.mode, 'disable');
  assert.equal(config.database.pool.maxConnections, 1);
  assert.equal(
    config.database.pool.applicationName,
    'qinglong3-worker-credential-executor',
  );
  assert.deepEqual(config.delivery, {
    clusterIdentity: 'cluster-primary',
    stageNamespace: 'qinglong3-stage',
    namespace: 'qinglong3-worker',
    targetSecretName: 'worker-credential',
    targetDeploymentName: 'worker-runtime',
    targetDataKey: 'credential',
  });
});

test('rejects profile drift, relative authority files and implicit insecure database', () => {
  const paths = {
    commandFile: '/run/ql3-worker-executor/command.json',
    pepperFile: '/run/ql3-worker-executor/pepper',
  };
  for (const environment of [
    enabledEnvironment(paths, { QL3_PROFILE: 'cluster-control' }),
    enabledEnvironment(paths, {
      QL3_WORKER_CREDENTIAL_EXECUTOR_COMMAND_FILE: 'command.json',
    }),
    enabledEnvironment(paths, {
      QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_ALLOW_INSECURE: 'false',
    }),
    enabledEnvironment(paths, {
      QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_NAMESPACE: 'INVALID_NAMESPACE',
    }),
  ]) {
    assert.throws(
      () => loadClusterWorkerCredentialExecutorProcessConfig(environment),
      ClusterWorkerCredentialExecutorProcessConfigError,
    );
  }
});

test('composes exact one-shot execution and always disposes issuer authority', async () => {
  await authorityFixture(async (paths) => {
    const session = { async withDelivery() {} };
    const confirmAuthorization = async () => {};
    const openDatabase = async () => {
      throw new Error('injected executor owns database use');
    };
    let disposed = 0;
    let observed;
    const run = Object.freeze({
      database: { ready: true },
      approval: { dispatchId: COMMAND.dispatchId },
      execution: { status: 'completed' },
      result: { status: 'published' },
      tokenRequest: { issued: true },
    });
    const result = await runClusterWorkerCredentialExecutorProcess({
      environment: enabledEnvironment(paths),
      openDatabase,
      kubernetesAuthority: {
        session,
        confirmAuthorization,
        dispose() {
          disposed += 1;
        },
      },
      async execute(options) {
        observed = options;
        return run;
      },
      now: () => 7_000,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.run, run);
    assert.deepEqual(result.command, COMMAND);
    assert.equal(disposed, 1);
    assert.equal(observed.openDatabase, openDatabase);
    assert.equal(observed.tokenRequestSession, session);
    assert.equal(observed.confirmAuthorization, confirmAuthorization);
    assert.equal(observed.workerCredentialPepper.length, 43);
    assert.equal(observed.actionRef, COMMAND.actionRef);
    assert.equal(observed.approvalRequestId, COMMAND.approvalRequestId);
    assert.equal(observed.consumptionId, COMMAND.consumptionId);
    assert.equal(observed.dispatchId, COMMAND.dispatchId);
    assert.equal(observed.auditEventId, COMMAND.auditEventId);
    assert.equal(observed.now(), 7_000);
  });
});

test('preserves execution and issuer-disposal failures together', async () => {
  await authorityFixture(async (paths) => {
    const executionFailure = new Error('execution failed');
    const disposalFailure = new Error('disposal failed');
    await assert.rejects(
      runClusterWorkerCredentialExecutorProcess({
        environment: enabledEnvironment(paths),
        kubernetesAuthority: {
          session: { async withDelivery() {} },
          async confirmAuthorization() {},
          dispose() {
            throw disposalFailure;
          },
        },
        async execute() {
          throw executionFailure;
        },
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.deepEqual(error.errors, [executionFailure, disposalFailure]);
        return true;
      },
    );
  });
});

test('rejects expanded commands and publicly readable pepper material', async () => {
  await authorityFixture(
    async (paths) => {
      await assert.rejects(
        runClusterWorkerCredentialExecutorProcess({
          environment: enabledEnvironment(paths),
          kubernetesAuthority: {
            session: { async withDelivery() {} },
            async confirmAuthorization() {},
            dispose() {},
          },
          async execute() {
            throw new Error('must not execute');
          },
        }),
        ClusterWorkerCredentialExecutorProcessConfigError,
      );
    },
    { pepperMode: 0o444 },
  );

  await authorityFixture(async (paths) => {
    await chmod(paths.commandFile, 0o640);
    await writeFile(
      paths.commandFile,
      `${JSON.stringify({ ...COMMAND, unexpected: true })}\n`,
      { mode: 0o440 },
    );
    await chmod(paths.commandFile, 0o440);
    await assert.rejects(
      runClusterWorkerCredentialExecutorProcess({
        environment: enabledEnvironment(paths),
        kubernetesAuthority: {
          session: { async withDelivery() {} },
          async confirmAuthorization() {},
          dispose() {},
        },
        async execute() {
          throw new Error('must not execute');
        },
      }),
      ClusterWorkerCredentialExecutorProcessConfigError,
    );
  });
});

test('CLI exposes no authority paths or secret-bearing failure details', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.equal(help.stdout, 'Usage: ql3-worker-credential-execute\n');
  assert.equal(help.stderr, '');

  const disabled = spawnSync(process.execPath, [CLI], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QL3_WORKER_CREDENTIAL_EXECUTOR_ENABLED: 'false',
    },
  });
  assert.equal(disabled.status, 0);
  assert.deepEqual(JSON.parse(disabled.stdout), {
    schemaVersion: 1,
    component: 'qinglong3-worker-credential-executor',
    event: 'execution_disabled',
  });
  assert.equal(disabled.stderr, '');

  const failure = spawnSync(process.execPath, [CLI], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QL3_WORKER_CREDENTIAL_EXECUTOR_ENABLED: 'true',
      QL3_PROFILE: 'cluster-admin',
    },
  });
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  const fact = JSON.parse(failure.stderr);
  assert.deepEqual(Object.keys(fact).sort(), [
    'code',
    'component',
    'event',
    'name',
    'schemaVersion',
  ]);
  assert.equal(
    fact.code,
    'QL3_WORKER_CREDENTIAL_EXECUTOR_PROCESS_CONFIG_INVALID',
  );
  assert.equal(failure.stderr.includes('/'), false);
  assert.equal(failure.stderr.includes('pepper'), false);
});

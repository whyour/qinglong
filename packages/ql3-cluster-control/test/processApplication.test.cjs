const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterControlProcessError,
  runProductionClusterControlProcess,
} = require('@qinglong/cluster-control/process');

const BASE_ENV = Object.freeze({
  QL3_CLUSTER_CONTROL_ENABLED: 'true',
  QL_DEPLOYMENT_PROFILE: 'cluster-control',
  QL3_CLUSTER_REPLICA_ID: 'cluster-control-0',
  QL3_POSTGRES_RUNTIME_URL:
    'postgresql://ql3_runtime:do-not-log@postgres-rw.internal:5432/qinglong',
  QL3_POSTGRES_TLS_SERVERNAME: 'postgres-rw.internal',
  QL3_API_CREDENTIAL_PEPPER: 'A'.repeat(43),
});
const NEVER_UNAVAILABLE = new Promise(() => {});

function signalSource(events, signal = 'SIGTERM') {
  return {
    subscribe(listener) {
      events.push('subscribe');
      queueMicrotask(() => listener(signal));
      return () => events.push('unsubscribe');
    },
  };
}

test('runs one production replica and drains it on the first signal', async () => {
  const events = [];
  const facts = [];
  const result = await runProductionClusterControlProcess({
    environment: BASE_ENV,
    signals: signalSource(events),
    emit(record) {
      facts.push(record);
    },
    async start(options) {
      events.push('start');
      assert.equal(options.config.enabled, true);
      assert.equal(options.config.profile, 'cluster-control');
      assert.equal(options.recovery.ownerId, 'cluster-control-0');
      assert.equal(options.scheduler.ownerId, 'cluster-control-0');
      await options.audit({
        state: 'active',
        contractName: 'qinglong-cluster-control',
        contractVersion: 16,
        serverMajor: 18,
        migrationCount: 16,
      });
      options.scheduler.onDiagnostic(
        Object.assign(new Error('must-not-be-logged'), {
          code: 'ECONNRESET',
        }),
      );
      return {
        status: 'active',
        address: { host: '0.0.0.0', port: 5800 },
        evidence: {
          contractName: 'qinglong-cluster-control',
          contractVersion: 16,
          serverMajor: 18,
          migrationIds: [],
        },
        recovery: { safe: true, remaining: 0, failed: 0 },
        unavailable: NEVER_UNAVAILABLE,
        availabilityStatus: () => 'ready',
        async stop() {
          events.push('stop');
          return 'stopped';
        },
      };
    },
  });

  assert.equal(result, 'stopped');
  assert.deepEqual(events, ['subscribe', 'start', 'stop', 'unsubscribe']);
  assert.equal(
    facts.some((fact) => fact.event === 'activation'),
    true,
  );
  assert.equal(
    facts.some((fact) => fact.event === 'listening'),
    true,
  );
  assert.equal(
    facts.some(
      (fact) =>
        fact.event === 'shutdown_requested' && fact.signal === 'SIGTERM',
    ),
    true,
  );
  assert.equal(facts.at(-1).event, 'stopped');
  assert.equal(facts.at(-1).stopResult, 'stopped');
  const serialized = JSON.stringify(facts);
  assert.equal(serialized.includes('do-not-log'), false);
  assert.equal(serialized.includes(BASE_ENV.QL3_API_CREDENTIAL_PEPPER), false);
  assert.equal(serialized.includes('must-not-be-logged'), false);
  assert.equal(serialized.includes('ECONNRESET'), true);
});

test('fails closed before startup for a disabled profile or invalid replica id', async () => {
  let starts = 0;
  for (const environment of [
    {
      QL3_CLUSTER_CONTROL_ENABLED: 'false',
      QL_DEPLOYMENT_PROFILE: 'standalone',
    },
    { ...BASE_ENV, QL3_CLUSTER_REPLICA_ID: 'unsafe replica' },
  ]) {
    await assert.rejects(
      runProductionClusterControlProcess({
        environment,
        signals: {
          subscribe() {
            return () => {};
          },
        },
        emit() {},
        async start() {
          starts += 1;
          throw new Error('must not start');
        },
      }),
      ClusterControlProcessError,
    );
  }
  assert.equal(starts, 0);
});

test('propagates timed-out drain and always releases signal ownership', async () => {
  const events = [];
  const result = await runProductionClusterControlProcess({
    environment: BASE_ENV,
    signals: signalSource(events, 'SIGINT'),
    emit() {},
    async start() {
      return {
        status: 'active',
        address: { host: '127.0.0.1', port: 5800 },
        evidence: {
          contractName: 'qinglong-cluster-control',
          contractVersion: 16,
          serverMajor: 18,
          migrationIds: [],
        },
        recovery: { safe: true, remaining: 0, failed: 0 },
        unavailable: NEVER_UNAVAILABLE,
        availabilityStatus: () => 'ready',
        async stop() {
          events.push('stop');
          return 'timed_out';
        },
      };
    },
  });
  assert.equal(result, 'timed_out');
  assert.deepEqual(events, ['subscribe', 'stop', 'unsubscribe']);
});

test('starts the optional Worker listener and closes its lazy Artifact binding', async () => {
  const events = [];
  const facts = [];
  const artifactStore = {
    async put() {},
    async inspect() {},
    async retire() {},
  };
  const environment = {
    ...BASE_ENV,
    QL3_WORKER_INGRESS_ENABLED: 'true',
    QL3_POSTGRES_WORKER_INGRESS_URL:
      'postgresql://ql3_worker_ingress:secret@postgres-rw.internal:5432/qinglong',
    QL3_WORKER_INGRESS_POSTGRES_TLS_SERVERNAME: 'postgres-rw.internal',
    QL3_WORKER_CREDENTIAL_PEPPER: 'A'.repeat(43),
    QL3_WORKER_INGRESS_TLS_PRIVATE_KEY_FILE: '/run/worker/tls.key',
    QL3_WORKER_INGRESS_TLS_CERTIFICATE_FILE: '/run/worker/tls.crt',
    QL3_WORKER_INGRESS_TLS_CLIENT_CA_FILE: '/run/worker/client-ca.crt',
    QL3_WORKER_ARTIFACT_S3_BUCKET: 'qinglong-worker-artifacts',
    QL3_WORKER_ARTIFACT_S3_REGION: 'us-east-1',
  };
  const result = await runProductionClusterControlProcess({
    environment,
    signals: signalSource(events),
    emit(record) {
      facts.push(record);
    },
    async createWorkerArtifactBinding(config) {
      events.push(`artifact:${config.bucket}:${config.region}`);
      return {
        store: artifactStore,
        async close() {
          events.push('close-artifact');
        },
      };
    },
    async start(options) {
      events.push('start');
      assert.equal(options.workerIngress.config.enabled, true);
      assert.equal(options.workerIngress.artifactStore, artifactStore);
      assert.equal(options.logRetention.store, artifactStore);
      assert.equal(options.logRetention.ownerId, 'cluster-control-0');
      assert.equal(options.logRetention.claimLimit, 4);
      options.logRetention.onDiagnostic(
        Object.assign(new Error('must-not-be-logged'), {
          code: 'S3Unavailable',
        }),
      );
      options.workerIngress.onCancellationDispatch({ status: 'dispatched' });
      options.workerIngress.onCancellationDispatchDiagnostic(
        Object.assign(new Error('must-not-be-logged'), {
          code: 'CANCEL_DISPATCH_UNAVAILABLE',
        }),
      );
      return {
        status: 'active',
        address: { host: '0.0.0.0', port: 5800 },
        evidence: {
          contractName: 'qinglong-cluster-control',
          contractVersion: 16,
          serverMajor: 18,
          migrationIds: [],
        },
        recovery: { safe: true, remaining: 0, failed: 0 },
        unavailable: NEVER_UNAVAILABLE,
        availabilityStatus: () => 'ready',
        async stop() {
          events.push('stop');
          return 'stopped';
        },
      };
    },
  });
  assert.equal(result, 'stopped');
  assert.deepEqual(events, [
    'subscribe',
    'artifact:qinglong-worker-artifacts:us-east-1',
    'start',
    'stop',
    'unsubscribe',
    'close-artifact',
  ]);
  assert.equal(
    facts.some((fact) => fact.event === 'worker_ingress_listening'),
    true,
  );
  assert.equal(
    facts.some(
      (fact) =>
        fact.event === 'runtime_diagnostic' &&
        fact.diagnostic.scope === 'log-retention' &&
        fact.diagnostic.code === 'S3Unavailable' &&
        JSON.stringify(fact).includes('must-not-be-logged') === false,
    ),
    true,
  );
  assert.equal(
    facts.some(
      (fact) =>
        fact.event === 'cancellation_dispatch' &&
        fact.level === 'info' &&
        fact.cancellationDispatch.status === 'dispatched',
    ),
    true,
  );
  assert.equal(
    facts.some(
      (fact) =>
        fact.event === 'runtime_diagnostic' &&
        fact.diagnostic.scope === 'cancellation-dispatch' &&
        fact.diagnostic.code === 'CANCEL_DISPATCH_UNAVAILABLE' &&
        JSON.stringify(fact).includes('must-not-be-logged') === false,
    ),
    true,
  );
});

test('creates the configured mounted Secret provider before Worker activation', async () => {
  const events = [];
  const artifactStore = {
    async put() {},
    async inspect() {},
    async retire() {},
  };
  const provider = { async resolve() {} };
  const result = await runProductionClusterControlProcess({
    environment: {
      ...BASE_ENV,
      QL3_WORKER_INGRESS_ENABLED: 'true',
      QL3_POSTGRES_WORKER_INGRESS_URL:
        'postgresql://ql3_worker_ingress:secret@postgres-rw.internal:5432/qinglong',
      QL3_WORKER_INGRESS_POSTGRES_TLS_SERVERNAME: 'postgres-rw.internal',
      QL3_WORKER_CREDENTIAL_PEPPER: 'A'.repeat(43),
      QL3_WORKER_INGRESS_TLS_PRIVATE_KEY_FILE: '/run/worker/tls.key',
      QL3_WORKER_INGRESS_TLS_CERTIFICATE_FILE: '/run/worker/tls.crt',
      QL3_WORKER_INGRESS_TLS_CLIENT_CA_FILE: '/run/worker/client-ca.crt',
      QL3_WORKER_ARTIFACT_S3_BUCKET: 'qinglong-worker-artifacts',
      QL3_WORKER_ARTIFACT_S3_REGION: 'us-east-1',
      QL3_WORKER_SECRET_PROVIDER: 'mounted-files',
      QL3_WORKER_SECRET_ROOT_DIRECTORY: '/run/worker/values',
    },
    signals: signalSource(events),
    emit() {},
    async createWorkerArtifactBinding() {
      events.push('artifact');
      return {
        store: artifactStore,
        async close() {
          events.push('close-artifact');
        },
      };
    },
    async createWorkerSecretProvider(config) {
      events.push(`secret:${config.provider}:${config.rootDirectory}`);
      return provider;
    },
    async start(options) {
      events.push('start');
      assert.equal(options.workerIngress.secretProvider, provider);
      return {
        status: 'active',
        address: { host: '0.0.0.0', port: 5800 },
        evidence: {
          contractName: 'qinglong-cluster-control',
          contractVersion: 16,
          serverMajor: 18,
          migrationIds: [],
        },
        recovery: { safe: true, remaining: 0, failed: 0 },
        unavailable: NEVER_UNAVAILABLE,
        availabilityStatus: () => 'ready',
        async stop() {
          events.push('stop');
          return 'stopped';
        },
      };
    },
  });
  assert.equal(result, 'stopped');
  assert.deepEqual(events, [
    'subscribe',
    'artifact',
    'secret:mounted-files:/run/worker/values',
    'start',
    'stop',
    'unsubscribe',
    'close-artifact',
  ]);
});

test('fails the process after a database fence drains the active application', async () => {
  const events = [];
  const facts = [];
  let reportUnavailable;
  const unavailable = new Promise((resolve) => {
    reportUnavailable = resolve;
  });
  const running = runProductionClusterControlProcess({
    environment: BASE_ENV,
    signals: {
      subscribe() {
        events.push('subscribe');
        return () => events.push('unsubscribe');
      },
    },
    emit(record) {
      facts.push(record);
    },
    async start() {
      queueMicrotask(() =>
        reportUnavailable(
          Object.assign(new Error('must-not-escape-database-detail'), {
            code: '57P01',
          }),
        ),
      );
      return {
        status: 'active',
        address: { host: '127.0.0.1', port: 5800 },
        evidence: {
          contractName: 'qinglong-cluster-control',
          contractVersion: 52,
          serverMajor: 18,
          migrationIds: [],
        },
        recovery: { safe: true, remaining: 0, failed: 0 },
        unavailable,
        availabilityStatus: () => 'unavailable',
        async stop() {
          events.push('stop');
          return 'stopped';
        },
      };
    },
  });

  await assert.rejects(
    running,
    (error) => error?.code === 'CLUSTER_CONTROL_DATABASE_UNAVAILABLE',
  );
  assert.deepEqual(events, ['subscribe', 'stop', 'unsubscribe']);
  assert.equal(
    facts.some(
      ({ event, diagnostic }) =>
        event === 'database_unavailable' &&
        diagnostic?.scope === 'database' &&
        diagnostic?.code === '57P01',
    ),
    true,
  );
  assert.equal(
    facts.some(({ event }) => event === 'shutdown_requested'),
    false,
  );
  assert.equal(facts.at(-1).event, 'stopped');
  assert.equal(
    JSON.stringify(facts).includes('must-not-escape-database-detail'),
    false,
  );
});

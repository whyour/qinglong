'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterRunManagementProcessConfigError,
  loadClusterRunManagementProcessConfig,
  startClusterRunManagementProcess,
} = require('@qinglong/cluster-admin/run-management-process');

function enabled(overrides = {}) {
  return {
    QL3_RUN_MANAGEMENT_ENABLED: 'true',
    QL3_PROFILE: 'cluster-admin',
    QL3_RUN_MANAGEMENT_TLS_CERT_FILE: '/run/ql3/run/tls.crt',
    QL3_RUN_MANAGEMENT_TLS_KEY_FILE: '/run/ql3/run/tls.key',
    QL3_RUN_MANAGEMENT_CLIENT_CA_FILE: '/run/ql3/run/client-ca.crt',
    QL3_RUN_MANAGEMENT_CLIENT_CRL_FILE: '/run/ql3/run/client.crl',
    QL3_RUN_MANAGEMENT_IDENTITY_KEYSET_FILE: '/run/ql3/run/identity.json',
    QL3_POSTGRES_RUN_MANAGER_HOST: 'postgres.qinglong3-system.svc',
    QL3_POSTGRES_RUN_MANAGER_DATABASE: 'qinglong3',
    QL3_POSTGRES_RUN_MANAGER_USER: 'ql3_run_manager',
    QL3_POSTGRES_RUN_MANAGER_PASSWORD: 'secret',
    QL3_POSTGRES_RUN_MANAGER_TLS_SERVERNAME: 'postgres.qinglong3-system.svc',
    ...overrides,
  };
}

test('disabled Run manager acquires no PostgreSQL or file authority', async () => {
  let opened = false;
  const runtime = await startClusterRunManagementProcess({
    environment: {},
    openDatabase: async () => {
      opened = true;
      throw new Error('must not open');
    },
  });
  assert.equal(runtime.status, 'disabled');
  assert.equal(opened, false);
  await runtime.close();
});

test('loads a bounded opt-in Run-only process configuration', () => {
  const config = loadClusterRunManagementProcessConfig(enabled());
  assert.equal(config.enabled, true);
  assert.equal(config.port, 8448);
  assert.equal(config.http.maxConcurrentRequests, 16);
  assert.equal(config.database.pool.maxConnections, 2);
  assert.equal(config.database.connection.user, 'ql3_run_manager');
  assert.deepEqual(config.database.connection.tls, {
    mode: 'verify-full',
    servername: 'postgres.qinglong3-system.svc',
  });
});

test('rejects profile drift and implicit insecure PostgreSQL', () => {
  assert.throws(
    () => loadClusterRunManagementProcessConfig(enabled({ QL3_PROFILE: 'cluster-control' })),
    ClusterRunManagementProcessConfigError,
  );
  assert.throws(
    () =>
      loadClusterRunManagementProcessConfig(
        enabled({
          QL3_POSTGRES_RUN_MANAGER_TLS_MODE: 'disable',
          QL3_POSTGRES_RUN_MANAGER_TLS_SERVERNAME: undefined,
        }),
      ),
    ClusterRunManagementProcessConfigError,
  );
});

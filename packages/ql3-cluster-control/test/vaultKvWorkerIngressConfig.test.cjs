'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const {
  ClusterWorkerIngressConfigError,
  loadClusterWorkerIngressConfig,
} = require('@qinglong/cluster-control/worker-ingress-config');

const FIXTURES = path.join(__dirname, 'fixtures', 'mtls');
const BASE_ENV = Object.freeze({
  QL3_WORKER_INGRESS_ENABLED: 'true',
  QL_DEPLOYMENT_PROFILE: 'cluster-control',
  QL3_POSTGRES_WORKER_INGRESS_URL:
    'postgresql://ql3_worker_ingress:secret@database.internal:5432/qinglong',
  QL3_WORKER_INGRESS_POSTGRES_TLS_SERVERNAME: 'database.internal',
  QL3_WORKER_CREDENTIAL_PEPPER: 'A'.repeat(43),
  QL3_WORKER_ARTIFACT_S3_BUCKET: 'qinglong-worker-artifacts',
  QL3_WORKER_ARTIFACT_S3_REGION: 'us-east-1',
  QL3_WORKER_INGRESS_TLS_PRIVATE_KEY_FILE: path.join(
    FIXTURES,
    'server-key.pem',
  ),
  QL3_WORKER_INGRESS_TLS_CERTIFICATE_FILE: path.join(
    FIXTURES,
    'server-cert.pem',
  ),
  QL3_WORKER_INGRESS_TLS_CLIENT_CA_FILE: path.join(FIXTURES, 'ca-cert.pem'),
});

test('loads the explicit Vault KV v2 Worker Secret provider', () => {
  const config = loadClusterWorkerIngressConfig({
    ...BASE_ENV,
    QL3_WORKER_SECRET_PROVIDER: 'vault-kv-v2',
    QL3_WORKER_SECRET_VAULT_ENDPOINT: 'https://vault.internal:8200',
    QL3_WORKER_SECRET_VAULT_CA_FILE: '/run/vault/trust/ca.pem',
    QL3_WORKER_SECRET_VAULT_TOKEN_FILE: '/run/vault/auth/token',
    QL3_WORKER_SECRET_VAULT_KV_MOUNT: 'worker-secrets',
    QL3_WORKER_SECRET_VAULT_PATH_PREFIX: 'values/production',
    QL3_WORKER_SECRET_VAULT_EXPECTED_POLICY: 'ql3-worker-secret-read',
    QL3_WORKER_SECRET_VAULT_MAX_TOKEN_TTL_SECONDS: '600',
    QL3_WORKER_SECRET_VAULT_REQUEST_TIMEOUT_MS: '4000',
    QL3_WORKER_SECRET_VAULT_MAX_CONCURRENCY: '3',
    QL3_WORKER_SECRET_VAULT_NAMESPACE: 'organization/team-a',
  });
  assert.deepEqual(config.secret, {
    provider: 'vault-kv-v2',
    endpoint: 'https://vault.internal:8200/',
    caFile: '/run/vault/trust/ca.pem',
    tokenFile: '/run/vault/auth/token',
    kvMount: 'worker-secrets',
    pathPrefix: 'values/production',
    expectedPolicy: 'ql3-worker-secret-read',
    maximumTokenTtlSeconds: 600,
    requestTimeoutMs: 4000,
    maximumConcurrency: 3,
    namespace: 'organization/team-a',
  });
});

test('rejects incomplete or non-HTTPS Vault Worker Secret configuration', () => {
  const base = {
    ...BASE_ENV,
    QL3_WORKER_SECRET_PROVIDER: 'vault-kv-v2',
    QL3_WORKER_SECRET_VAULT_ENDPOINT: 'https://vault.internal:8200',
    QL3_WORKER_SECRET_VAULT_CA_FILE: '/run/vault/trust/ca.pem',
    QL3_WORKER_SECRET_VAULT_TOKEN_FILE: '/run/vault/auth/token',
    QL3_WORKER_SECRET_VAULT_KV_MOUNT: 'worker-secrets',
    QL3_WORKER_SECRET_VAULT_PATH_PREFIX: 'values/production',
    QL3_WORKER_SECRET_VAULT_EXPECTED_POLICY: 'ql3-worker-secret-read',
  };
  for (const environment of [
    { ...base, QL3_WORKER_SECRET_VAULT_ENDPOINT: 'http://vault.internal' },
    { ...base, QL3_WORKER_SECRET_VAULT_CA_FILE: 'relative.pem' },
    { ...base, QL3_WORKER_SECRET_VAULT_TOKEN_FILE: undefined },
    { ...base, QL3_WORKER_SECRET_VAULT_MAX_TOKEN_TTL_SECONDS: '3601' },
    { ...base, QL3_WORKER_SECRET_VAULT_MAX_CONCURRENCY: '9' },
  ]) {
    assert.throws(
      () => loadClusterWorkerIngressConfig(environment),
      ClusterWorkerIngressConfigError,
    );
  }
});

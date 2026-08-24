'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  auditVaultKvWorkerSecretDeployment,
} = require('../../scripts/ql3-vault-kv-worker-secret-deployment-audit.cjs');

const ROOT = path.resolve(__dirname, '../..');

test('accepts the exact direct Vault KV deployment overlay', () => {
  assert.deepEqual(auditVaultKvWorkerSecretDeployment({ root: ROOT }), {
    schemaVersion: 1,
    provider: 'vault-kv-v2',
    mountedValueProjection: false,
    findings: [],
    compatible: true,
  });
});

test('rejects a restored mounted-value projection or broad token TTL', () => {
  const readFile = (file, encoding) => {
    const source = fs.readFileSync(file, encoding);
    if (!file.endsWith('deployment-patch.yaml')) return source;
    return source
      .replace(
        "QL3_WORKER_SECRET_VAULT_MAX_TOKEN_TTL_SECONDS\n              value: '900'",
        "QL3_WORKER_SECRET_VAULT_MAX_TOKEN_TTL_SECONDS\n              value: '3600'",
      )
      .replace(
        '- name: worker-secret-values\n              $patch: delete',
        '- name: worker-secret-values\n              mountPath: /run/values',
      );
  };
  const result = auditVaultKvWorkerSecretDeployment({ root: ROOT, readFile });
  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.findings.map(({ code }) => code),
    [
      'QL3_VAULT_KV_WORKER_SECRET_ENVIRONMENT_INVALID',
      'QL3_VAULT_KV_WORKER_SECRET_PROJECTION_INVALID',
    ],
  );
});

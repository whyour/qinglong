'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ClusterPluginPackageInstallationProductError,
  createPluginPackageInstallationInspectionCommand,
  createPluginPackageInstallationListCommand,
  projectPluginPackageInstallationInspection,
  projectPluginPackageInstallationList,
} = require('../dist/plugin-package/management/pluginPackageInstallationProduct.js');

function installation(overrides = {}) {
  return {
    installationId: 'installation-sensitive',
    projectId: 'project-main',
    packageName: 'ops-package',
    packageVersion: '3.1.0',
    operation: 'upgrade',
    state: 'active',
    targetGeneration: 4,
    activeLockDigest: 'a'.repeat(64),
    previousActiveLockDigest: 'b'.repeat(64),
    recoveryAction: 'none',
    availability: 'active',
    quarantineReason: null,
    quarantineAuthorizationMode: null,
    quarantineEventDigest: null,
    quarantinedAtMs: null,
    withdrawalStatus: null,
    withdrawalReceiptDigest: null,
    withdrawalCommittedAtMs: null,
    failureReason: null,
    failedFrom: null,
    failedAtMs: null,
    version: 7,
    createdAtMs: 100,
    updatedAtMs: 200,
    recordDigest: 'c'.repeat(64),
    ...overrides,
  };
}

test('builds fixed bounded installation observation commands', () => {
  assert.deepEqual(
    createPluginPackageInstallationListCommand(
      'project-main',
      'after-package',
      () => 'inspection-list',
    ),
    {
      schemaVersion: 1,
      operation: 'plugin-package.installation.list',
      request: {
        projectId: 'project-main',
        limit: 16,
        after: { packageName: 'after-package' },
        inspectionId: 'inspection-list',
      },
    },
  );
  assert.deepEqual(
    createPluginPackageInstallationInspectionCommand(
      'project-main',
      'ops-package',
      () => 'inspection-one',
    ),
    {
      schemaVersion: 1,
      operation: 'plugin-package.installation.inspect',
      request: {
        projectId: 'project-main',
        packageName: 'ops-package',
        inspectionId: 'inspection-one',
      },
    },
  );
});

test('projects installation facts without transport or durable identifiers', () => {
  const fact = projectPluginPackageInstallationList('project-main', {
    schemaVersion: 1,
    requestId: 'transport-request-sensitive',
    result: {
      operation: 'plugin-package.installation.list',
      installations: [installation()],
      truncated: true,
      next: { packageName: 'ops-package' },
    },
  });

  assert.deepEqual(fact, {
    schema: 'qinglong/plugin-package-installation-list@v1',
    projectId: 'project-main',
    count: 1,
    installations: [
      {
        packageName: 'ops-package',
        packageVersion: '3.1.0',
        installOperation: 'upgrade',
        state: 'active',
        targetGeneration: 4,
        recoveryAction: 'none',
        availability: 'active',
        quarantineReason: null,
        failureReason: null,
        version: 7,
        createdAtMs: 100,
        updatedAtMs: 200,
      },
    ],
    truncated: true,
    nextAfterPackageName: 'ops-package',
  });
  const encoded = JSON.stringify(fact);
  for (const secret of [
    'installation-sensitive',
    'transport-request-sensitive',
    'activeLockDigest',
    'recordDigest',
  ]) {
    assert.equal(encoded.includes(secret), false);
  }
});

test('inspection binds the selected package and fails closed on drift', () => {
  const response = {
    schemaVersion: 1,
    requestId: 'request-one',
    result: {
      operation: 'plugin-package.installation.inspect',
      installation: installation(),
    },
  };
  assert.equal(
    projectPluginPackageInstallationInspection(
      'project-main',
      'ops-package',
      response,
    ).found,
    true,
  );
  assert.throws(
    () =>
      projectPluginPackageInstallationInspection(
        'project-main',
        'other-package',
        response,
      ),
    ClusterPluginPackageInstallationProductError,
  );
  assert.throws(
    () =>
      projectPluginPackageInstallationInspection(
        'project-main',
        'ops-package',
        {
          ...response,
          result: {
            ...response.result,
            installation: installation({
              recoveryAction: 'run-arbitrary-code',
            }),
          },
        },
      ),
    ClusterPluginPackageInstallationProductError,
  );
});

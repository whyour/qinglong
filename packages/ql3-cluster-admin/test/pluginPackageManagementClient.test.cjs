const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { createServer } = require('node:https');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const {
  ClusterPluginPackageManagementClientConfigurationError,
  ClusterPluginPackageManagementClientRemoteError,
  ClusterPluginPackageManagementClientRequestError,
  executeClusterPluginPackageManagementClient,
} = require('@qinglong/cluster-admin/plugin-package-management-client');

const CA_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/ca-cert.pem',
);
const SERVER_KEY = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-key.pem',
);
const SERVER_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-cert.pem',
);
const CLIENT_CLI = resolve(
  __dirname,
  '../dist/plugin-package/management/pluginPackageManagementClientCli.js',
);
const ASSERTION = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.c2ln';

function inspectCommand(operation = 'plugin-package.inspect') {
  return {
    schemaVersion: 1,
    operation,
    request: {
      actionRef: 'package:cluster-monitor:1',
      approvalRequestId: 'approval-cluster-monitor-1',
      inspectionId: 'inspection-cluster-monitor-1',
    },
  };
}

function commands() {
  const decision = {
    actionRef: 'package:cluster-monitor:1',
    approvalRequestId: 'approval-cluster-monitor-1',
    expectedVersion: 1,
    decisionId: 'decision-cluster-monitor-1',
    auditEventId: 'audit-cluster-monitor-decision-1',
    decision: 'approved',
    reasonCode: 'reviewed',
  };
  const inspection = inspectCommand().request;
  return [
    {
      schemaVersion: 1,
      operation: 'plugin-package.propose',
      request: {
        actionRef: 'package:cluster-monitor:1',
        approvalRequestId: 'approval-cluster-monitor-1',
        proposalAuditEventId: 'audit-cluster-monitor-proposal-1',
        approvalAuditEventId: 'audit-cluster-monitor-approval-1',
        actionInput: {},
      },
    },
    {
      schemaVersion: 1,
      operation: 'plugin-package.decide',
      request: decision,
    },
    inspectCommand(),
    {
      schemaVersion: 1,
      operation: 'plugin-package.lifecycle.propose',
      request: {
        actionRef: 'lifecycle:cluster-monitor:disable:1',
        approvalRequestId: 'approval-lifecycle-cluster-monitor-1',
        approvalAuditEventId: 'audit-lifecycle-approval-1',
      },
    },
    {
      schemaVersion: 1,
      operation: 'plugin-package.lifecycle.decide',
      request: {
        ...decision,
        actionRef: 'lifecycle:cluster-monitor:disable:1',
        approvalRequestId: 'approval-lifecycle-cluster-monitor-1',
      },
    },
    {
      schemaVersion: 1,
      operation: 'plugin-package.lifecycle.inspect',
      request: {
        actionRef: 'lifecycle:cluster-monitor:disable:1',
        approvalRequestId: 'approval-lifecycle-cluster-monitor-1',
        inspectionId: 'inspection-lifecycle-cluster-monitor-1',
      },
    },
    {
      schemaVersion: 1,
      operation: 'plugin-package.installation.inspect',
      request: {
        projectId: 'project-1',
        packageName: 'cluster-monitor',
        inspectionId: 'inspection-installation-1',
      },
    },
    {
      schemaVersion: 1,
      operation: 'plugin-package.installation.list',
      request: {
        projectId: 'project-1',
        limit: 8,
        inspectionId: 'inspection-installation-list-1',
      },
    },
    {
      schemaVersion: 1,
      operation: 'plugin-package.publisher-revocation.propose',
      request: {
        actionRef: 'publisher:example:revocation:1',
        approvalRequestId: 'approval-publisher-revocation-1',
        proposalAuditEventId: 'audit-publisher-revocation-proposal-1',
        approvalAuditEventId: 'audit-publisher-revocation-approval-1',
        publisher: 'example',
        keyId: 'publisher-key-1',
        authorizationMode: 'dual_control',
        reasonCode: 'suspected_key_compromise',
      },
    },
    {
      schemaVersion: 1,
      operation: 'plugin-package.publisher-revocation.decide',
      request: decision,
    },
    {
      schemaVersion: 1,
      operation: 'plugin-package.publisher-revocation.inspect',
      request: inspection,
    },
    {
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust-transition.propose',
      request: {
        actionRef: 'publisher:example:transition:1',
        approvalRequestId: 'approval-publisher-transition-1',
        proposalAuditEventId: 'audit-publisher-transition-proposal-1',
        approvalAuditEventId: 'audit-publisher-transition-approval-1',
        mode: 'overlap_add',
        publisher: 'example',
        keyId: 'publisher-key-2',
      },
    },
    {
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust-transition.decide',
      request: decision,
    },
    {
      schemaVersion: 1,
      operation: 'plugin-package.publisher-trust-transition.inspect',
      request: inspection,
    },
  ];
}

function approvalSummary() {
  return {
    id: 'approval-cluster-monitor-1',
    projectId: 'project-1',
    version: 2,
    state: 'approved',
    risk: 'high',
    decisionMode: 'separation_of_duty',
    requestedAtMs: 1_000,
    expiresAtMs: 10_000,
    decision: 'approved',
    decisionReasonCode: 'reviewed',
    decidedAtMs: 2_000,
    dispatchId: null,
    consumedAtMs: null,
    actionDigest: 'action-digest-1',
    previewDigest: 'preview-digest-1',
  };
}

function proposalSummary(operation) {
  const common = {
    actionRef: 'package:cluster-monitor:1',
    projectId: 'project-1',
    actionDigest: 'action-digest-1',
    previewDigest: 'preview-digest-1',
    proposalDigest: 'proposal-digest-1',
    createdAtMs: 1_000,
  };
  if (operation.startsWith('plugin-package.publisher-trust-transition.')) {
    return {
      ...common,
      trustAuthorityId: 'cluster',
      trustGeneration: 2,
      mode: 'overlap_add',
      publisher: 'example',
      keyId: 'publisher-key-2',
      previousTrustDigest: 'trust-digest-1',
      currentTrustDigest: 'trust-digest-2',
    };
  }
  if (operation.startsWith('plugin-package.publisher-revocation.')) {
    return {
      ...common,
      trustAuthorityId: 'cluster',
      trustGeneration: 2,
      publisher: 'example',
      keyId: 'publisher-key-1',
      previousTrustDigest: 'trust-digest-1',
      currentTrustDigest: 'trust-digest-2',
      authorizationMode: 'dual_control',
      reasonCode: 'suspected_key_compromise',
    };
  }
  return {
    ...common,
    packageName: '@example/cluster-monitor',
    packageVersion: '1.0.0',
    operation: 'install',
    sourceKind: 'oci',
    architecture: 'arm64',
    deploymentProfile: 'cluster',
    targetGeneration: 1,
  };
}

function installationSummary() {
  return {
    installationId: 'install-cluster-monitor-1',
    projectId: 'project-1',
    packageName: 'cluster-monitor',
    packageVersion: '1.0.0',
    operation: 'install',
    state: 'active',
    targetGeneration: 1,
    activeLockDigest: 'a'.repeat(64),
    previousActiveLockDigest: null,
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
    version: 4,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    recordDigest: 'b'.repeat(64),
  };
}

function lifecyclePlanSummary() {
  return {
    actionRef: 'lifecycle:cluster-monitor:disable:1',
    planDigest: '1'.repeat(64),
    plannedAtMs: 1_000,
    expiresAtMs: 10_000,
    action: 'disable',
    projectId: 'project-1',
    packageName: 'cluster-monitor',
    installationId: 'install-cluster-monitor-1',
    lockDigest: '2'.repeat(64),
    installVersion: 4,
    installRecordDigest: '3'.repeat(64),
    expected: {
      version: 0,
      disposition: 'active',
      eventDigest: null,
    },
    generationDigest: '4'.repeat(64),
    materializedRevisionDigest: '5'.repeat(64),
    currentToolSnapshotDigest: '6'.repeat(64),
    taskIds: ['collect'],
    resourceCounts: { tasks: 1, tools: 0, workflows: 0, prompts: 0 },
    referenceGraphDigest: '7'.repeat(64),
    blockingReferences: [],
    impactDigest: '8'.repeat(64),
  };
}

function successfulResult(operation) {
  if (operation === 'plugin-package.installation.inspect') {
    return {
      schemaVersion: 1,
      operation,
      installation: installationSummary(),
    };
  }
  if (operation === 'plugin-package.installation.list') {
    return {
      schemaVersion: 1,
      operation,
      installations: [installationSummary()],
      truncated: false,
      next: null,
    };
  }
  if (operation === 'plugin-package.lifecycle.propose') {
    return {
      schemaVersion: 1,
      operation,
      approvalStatus: 'created',
      plan: lifecyclePlanSummary(),
      approval: approvalSummary(),
    };
  }
  if (operation === 'plugin-package.lifecycle.inspect') {
    return {
      schemaVersion: 1,
      operation,
      plan: lifecyclePlanSummary(),
      approval: approvalSummary(),
      stale: false,
    };
  }
  if (operation.endsWith('.propose')) {
    return {
      schemaVersion: 1,
      operation,
      proposalStatus: 'created',
      approvalStatus: 'created',
      proposal: proposalSummary(operation),
      approval: approvalSummary(),
    };
  }
  if (operation.endsWith('.decide')) {
    return {
      schemaVersion: 1,
      operation,
      status: 'decided',
      approval: approvalSummary(),
    };
  }
  return {
    schemaVersion: 1,
    operation,
    proposal: null,
    approval: null,
  };
}

function privateWrite(path, value) {
  writeFileSync(
    path,
    typeof value === 'string' ? value : JSON.stringify(value),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

function createClientFiles(port, command = inspectCommand()) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'ql3-management-client-')),
  );
  const configFile = join(directory, 'client.json');
  const commandFile = join(directory, 'command.json');
  const assertionFile = join(directory, 'assertion.jwt');
  privateWrite(configFile, {
    schemaVersion: 1,
    endpoint: `https://localhost:${port}/api/v3/plugin-packages/management`,
    servername: 'localhost',
    caFile: CA_CERT,
    requestTimeoutMs: 1_000,
  });
  privateWrite(commandFile, command);
  privateWrite(assertionFile, ASSERTION);
  return {
    directory,
    paths: { configFile, commandFile, assertionFile },
  };
}

async function startServer(handler) {
  const server = createServer(
    {
      key: readFileSync(SERVER_KEY),
      cert: readFileSync(SERVER_CERT),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    handler,
  );
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return {
    server,
    port: server.address().port,
    close: () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

function sendJson(response, statusCode, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    ...headers,
  });
  response.end(body);
}

test('sends one TLS 1.3 management command and validates the low-sensitive result', async () => {
  const received = [];
  const fixture = await startServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => {
      received.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        acceptEncoding: request.headers['accept-encoding'],
        protocol: request.socket.getProtocol(),
        command: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      sendJson(response, 200, {
        schemaVersion: 1,
        requestId: 'request-client-1',
        result: {
          schemaVersion: 1,
          operation: 'plugin-package.inspect',
          proposal: null,
          approval: null,
        },
      });
    });
  });
  const files = createClientFiles(fixture.port);
  try {
    const result = await executeClusterPluginPackageManagementClient(
      files.paths,
    );
    assert.equal(result.requestId, 'request-client-1');
    assert.equal(result.result.operation, 'plugin-package.inspect');
    assert.deepEqual(received, [
      {
        method: 'POST',
        path: '/api/v3/plugin-packages/management',
        authorization: `Bearer ${ASSERTION}`,
        acceptEncoding: 'identity',
        protocol: 'TLSv1.3',
        command: inspectCommand(),
      },
    ]);
  } finally {
    await fixture.close();
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test('permits and validates exactly the fourteen public management operations', async () => {
  const received = [];
  const fixture = await startServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => {
      const operation = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ).operation;
      received.push(operation);
      sendJson(response, 200, {
        schemaVersion: 1,
        requestId: `request-operation-${received.length}`,
        result: successfulResult(operation),
      });
    });
  });
  const files = createClientFiles(fixture.port);
  try {
    for (const command of commands()) {
      privateWrite(files.paths.commandFile, command);
      const result = await executeClusterPluginPackageManagementClient(
        files.paths,
      );
      assert.equal(result.result.operation, command.operation);
    }
    assert.deepEqual(
      received,
      commands().map((command) => command.operation),
    );
    privateWrite(files.paths.commandFile, {
      schemaVersion: 1,
      operation: 'plugin-package.execute',
      request: {},
    });
    await assert.rejects(
      executeClusterPluginPackageManagementClient(files.paths),
      (error) => {
        assert.equal(
          error.code,
          'CLUSTER_PLUGIN_PACKAGE_TRANSPORT_REQUEST_INVALID',
        );
        return true;
      },
    );
    assert.equal(received.length, 14);
  } finally {
    await fixture.close();
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects installation inventory responses outside the requested project and keyset', async () => {
  const responses = [
    {
      installations: [
        { ...installationSummary(), projectId: 'another-project' },
      ],
      truncated: false,
      next: null,
    },
    {
      installations: [installationSummary(), installationSummary()],
      truncated: false,
      next: null,
    },
    {
      installations: [installationSummary()],
      truncated: true,
      next: { packageName: 'another-package' },
    },
    {
      installations: [
        {
          ...installationSummary(),
          availability: 'quarantined',
          quarantineReason: 'confirmed_key_compromise',
        },
      ],
      truncated: false,
      next: null,
    },
  ];
  const fixture = await startServer((_request, response) => {
    sendJson(response, 200, {
      schemaVersion: 1,
      requestId: `request-invalid-inventory-${responses.length}`,
      result: {
        schemaVersion: 1,
        operation: 'plugin-package.installation.list',
        ...responses.shift(),
      },
    });
  });
  const command = {
    schemaVersion: 1,
    operation: 'plugin-package.installation.list',
    request: {
      projectId: 'project-1',
      limit: 2,
      inspectionId: 'inspection-invalid-inventory-1',
    },
  };
  const files = createClientFiles(fixture.port, command);
  try {
    for (let index = 0; index < 4; index += 1) {
      await assert.rejects(
        executeClusterPluginPackageManagementClient(files.paths),
        ClusterPluginPackageManagementClientRequestError,
      );
    }
  } finally {
    await fixture.close();
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects non-private, symlinked, and non-exact input files before transport', async () => {
  const files = createClientFiles(443);
  try {
    chmodSync(files.paths.assertionFile, 0o644);
    await assert.rejects(
      executeClusterPluginPackageManagementClient(files.paths),
      ClusterPluginPackageManagementClientConfigurationError,
    );
    chmodSync(files.paths.assertionFile, 0o600);

    const commandLink = join(files.directory, 'command-link.json');
    symlinkSync(files.paths.commandFile, commandLink);
    await assert.rejects(
      executeClusterPluginPackageManagementClient({
        ...files.paths,
        commandFile: commandLink,
      }),
      ClusterPluginPackageManagementClientConfigurationError,
    );

    privateWrite(files.paths.configFile, {
      schemaVersion: 1,
      endpoint: 'https://localhost/api/v3/plugin-packages/management',
      servername: 'localhost',
      caFile: CA_CERT,
      requestTimeoutMs: 1_000,
      proxy: 'https://proxy.invalid',
    });
    await assert.rejects(
      executeClusterPluginPackageManagementClient(files.paths),
      ClusterPluginPackageManagementClientConfigurationError,
    );
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test('does not follow redirects and rejects malformed, oversized, and timed-out responses', async () => {
  let behavior = 'remote-error';
  let hits = 0;
  const fixture = await startServer((_request, response) => {
    hits += 1;
    if (behavior === 'remote-error') {
      sendJson(
        response,
        409,
        {
          schemaVersion: 1,
          requestId: 'request-rejected-1',
          error: { code: 'test_rejection' },
        },
        { 'retry-after': '7' },
      );
      return;
    }
    if (behavior === 'redirect') {
      sendJson(
        response,
        302,
        {
          schemaVersion: 1,
          requestId: 'request-redirect-1',
          error: { code: 'redirected' },
        },
        { location: 'https://example.invalid/' },
      );
      return;
    }
    if (behavior === 'wrong-content-type') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('no');
      return;
    }
    if (behavior === 'oversized') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(Buffer.alloc(128 * 1024 + 1, 0x61));
      return;
    }
    if (behavior === 'truncated') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': '100',
      });
      response.write('{"');
      response.destroy();
    }
  });
  const files = createClientFiles(fixture.port);
  try {
    await assert.rejects(
      executeClusterPluginPackageManagementClient(files.paths),
      (error) => {
        assert.equal(
          error instanceof ClusterPluginPackageManagementClientRemoteError,
          true,
        );
        assert.equal(error.statusCode, 409);
        assert.equal(error.responseCode, 'test_rejection');
        assert.equal(error.requestId, 'request-rejected-1');
        assert.equal(error.retryAfterSeconds, 7);
        return true;
      },
    );

    behavior = 'redirect';
    await assert.rejects(
      executeClusterPluginPackageManagementClient(files.paths),
      ClusterPluginPackageManagementClientRequestError,
    );
    assert.equal(hits, 2);

    behavior = 'wrong-content-type';
    await assert.rejects(
      executeClusterPluginPackageManagementClient(files.paths),
      ClusterPluginPackageManagementClientRequestError,
    );

    behavior = 'oversized';
    await assert.rejects(
      executeClusterPluginPackageManagementClient(files.paths),
      ClusterPluginPackageManagementClientRequestError,
    );

    behavior = 'truncated';
    await assert.rejects(
      executeClusterPluginPackageManagementClient(files.paths),
      ClusterPluginPackageManagementClientRequestError,
    );

    behavior = 'timeout';
    await assert.rejects(
      executeClusterPluginPackageManagementClient(files.paths),
      ClusterPluginPackageManagementClientRequestError,
    );
    assert.equal(hits, 6);
  } finally {
    await fixture.close();
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test('CLI accepts path-only arguments and never reports secret content or paths', () => {
  const files = createClientFiles(443);
  try {
    privateWrite(files.paths.assertionFile, 'top-secret-assertion');
    const result = spawnSync(
      process.execPath,
      [
        CLIENT_CLI,
        `--config=${files.paths.configFile}`,
        `--command=${files.paths.commandFile}`,
        `--assertion=${files.paths.assertionFile}`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const fact = JSON.parse(result.stderr);
    assert.deepEqual(fact, {
      schemaVersion: 1,
      component: 'qinglong3-plugin-package-management-client',
      event: 'command_failed',
      code: 'QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_CONFIG_INVALID',
    });
    assert.equal(result.stderr.includes('top-secret-assertion'), false);
    assert.equal(result.stderr.includes(files.directory), false);

    const help = spawnSync(process.execPath, [CLIENT_CLI, '--help'], {
      encoding: 'utf8',
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: ql3-plugin-package-client /);
    assert.equal(help.stderr, '');
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});

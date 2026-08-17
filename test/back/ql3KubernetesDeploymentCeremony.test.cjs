'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  COMMAND_SCHEMA,
  FIELD_MANAGER,
  HEAD_DATA_KEY,
  HEAD_NAME,
  PREFLIGHT_SCHEMA,
  RECEIPT_SCHEMA,
  RETIREMENT_PREFLIGHT_SCHEMA,
  RETIREMENT_RECEIPT_SCHEMA,
  canonicalJson,
  executeCommand,
  parseCommand,
  validateLockReport,
} = require('../../scripts/lib/ql3-kubernetes-deployment-ceremony.cjs');
const {
  commandFile,
} = require('../../scripts/ql3-kubernetes-deployment-ceremony.cjs');

const CLUSTER_UID = '123e4567-e89b-42d3-a456-426614174000';
const RELEASE_SET_DIGEST = digest('release-set');
const CATALOG_MANIFEST_DIGEST = digest('catalog-manifest');
const CATALOG_REPORT_DIGEST = digest('catalog-report');
const SOURCE_REVISION = 'd'.repeat(40);
const VERSION = '3.0.0-alpha.0';
const CONTEXT = 'qinglong-production';
const REFERENCES = Object.freeze({
  control: image('qinglong3-cluster-control', '1'),
  'control-ai': image('qinglong3-cluster-control-ai', '2'),
  admin: image('qinglong3-cluster-admin', '3'),
  worker: image('qinglong3-worker', '4'),
});

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function image(repository, digit) {
  return `ghcr.io/qinglong-release/${repository}@sha256:${digit.repeat(64)}`;
}

function annotations(version = VERSION) {
  return {
    'qinglong.io/release-set-digest': RELEASE_SET_DIGEST,
    'qinglong.io/release-catalog-manifest-digest': CATALOG_MANIFEST_DIGEST,
    'qinglong.io/release-catalog-report-digest': CATALOG_REPORT_DIGEST,
    'qinglong.io/release-source-revision': SOURCE_REVISION,
    'qinglong.io/release-version': version,
  };
}

function manifest({ version = VERSION, extraResource = false } = {}) {
  const metadata = (name) => ({
    name,
    namespace: 'qinglong-system',
    annotations: annotations(version),
  });
  const deployment = (name, containerName, reference) => ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: metadata(name),
    spec: {
      selector: { matchLabels: { app: name } },
      template: {
        metadata: {
          labels: { app: name },
          annotations: annotations(version),
        },
        spec: { containers: [{ name: containerName, image: reference }] },
      },
    },
  });
  const resources = [
    deployment('ql3-control', 'control', REFERENCES.control),
    deployment('ql3-control-ai', 'control-ai', REFERENCES['control-ai']),
    {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: metadata('ql3-admin'),
      spec: {
        template: {
          metadata: { annotations: annotations(version) },
          spec: {
            restartPolicy: 'Never',
            containers: [{ name: 'admin', image: REFERENCES.admin }],
          },
        },
      },
    },
    deployment('ql3-worker', 'worker', REFERENCES.worker),
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: metadata('ql3-plugin-package-secret-action-admission'),
      data: { image: REFERENCES.admin },
    },
  ];
  if (extraResource) {
    resources.push({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: metadata('ql3-extra-release-resource'),
      data: { purpose: 'resource-inventory-closure-test' },
    });
  }
  return `${resources
    .map((resource) => JSON.stringify(resource))
    .join('\n---\n')}\n`;
}

function lockReport(manifestContents = manifest(), version = VERSION) {
  const resources = [];
  yaml.loadAll(manifestContents, (resource) => resources.push(resource));
  const unsigned = {
    schemaVersion: 1,
    schema: 'qinglong/kubernetes-deployment-lock@v2',
    release: {
      version,
      sourceRevision: SOURCE_REVISION,
      sourceRef: `refs/tags/v${version}`,
      scope: 'cluster',
    },
    releaseSetDigest: RELEASE_SET_DIGEST,
    catalog: {
      schema: 'qinglong/release-catalog-consumption-ceremony@v1',
      sourceRepository: 'qinglong-release/qinglong',
      workflowIdentity: `https://github.com/qinglong-release/qinglong/.github/workflows/ql3-image-release.yml@refs/tags/v${version}`,
      immutableReference: `ghcr.io/qinglong-release/qinglong3-release-catalog@${CATALOG_MANIFEST_DIGEST}`,
      manifestDigest: CATALOG_MANIFEST_DIGEST,
      consumptionReportDigest: CATALOG_REPORT_DIGEST,
      releaseSetDigest: RELEASE_SET_DIGEST,
      discoveryTagAuthority: 'none',
    },
    deploymentFamily: 'cluster',
    requiredImages: ['control', 'control-ai', 'admin', 'worker'],
    imageOccurrences: [
      { name: 'control', reference: REFERENCES.control, count: 1 },
      {
        name: 'control-ai',
        reference: REFERENCES['control-ai'],
        count: 1,
      },
      { name: 'admin', reference: REFERENCES.admin, count: 2 },
      { name: 'worker', reference: REFERENCES.worker, count: 1 },
    ],
    manifest: {
      inputDigest: digest('source-render'),
      outputDigest: digest(manifestContents),
      resources: resources.length,
      changedResources: 5,
      admissionAuthorityCount: 1,
    },
    verification: {
      releaseSet: 'standalone_structure_identity_and_self_digest',
      sourceRecordsReplayed: false,
      catalogConsumption: 'offline_reconstructed',
      externalToolResultsReplayed: false,
      unknownImageAuthorities: 0,
      mutableQingLongImages: 0,
      networkAccess: false,
      kubernetesMutation: false,
    },
  };
  return {
    ...unsigned,
    lockDigest: digest(JSON.stringify(unsigned)),
  };
}

function fixture(t, options = {}) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-kubernetes-deployment-')),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestContents = manifest(options);
  const lockedManifest = privateFile(
    directory,
    'locked.yaml',
    manifestContents,
  );
  const report = lockReport(manifestContents, options.version ?? VERSION);
  const lockReportPath = privateFile(
    directory,
    'lock.json',
    canonicalJson(report),
  );
  const kubectl = privateFile(
    directory,
    'kubectl',
    '#!/bin/sh\nexit 97\n',
    0o700,
  );
  const curl = privateFile(directory, 'curl', '#!/bin/sh\nexit 96\n', 0o700);
  const kubeconfig = privateFile(
    directory,
    'kubeconfig.yaml',
    `apiVersion: v1
kind: Config
current-context: ${CONTEXT}
clusters:
  - name: ql3
    cluster:
      server: https://cluster.example.test
      certificate-authority-data: Y2E=
contexts:
  - name: ${CONTEXT}
    context:
      cluster: ql3
      user: operator
users:
  - name: operator
    user:
      token: bounded-test-token
`,
  );
  return {
    directory,
    lockedManifest,
    lockReportPath,
    kubectl,
    curl,
    kubeconfig,
    report,
    manifestContents,
  };
}

function privateFile(directory, name, contents, mode = 0o600) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, contents, { mode });
  return target;
}

function fileDigest(filePath) {
  return digest(fs.readFileSync(filePath));
}

function writeCommand(directory, name, operation, request) {
  const value = {
    schemaVersion: 1,
    schema: COMMAND_SCHEMA,
    operation,
    request,
  };
  return privateFile(directory, name, canonicalJson(value));
}

function commonRequest(fixtureValue) {
  return {
    lockedManifest: {
      path: fixtureValue.lockedManifest,
      expectedDigest: fixtureValue.report.manifest.outputDigest,
    },
    lockReport: {
      path: fixtureValue.lockReportPath,
      expectedDigest: fixtureValue.report.lockDigest,
    },
    kubectl: {
      path: fixtureValue.kubectl,
      expectedDigest: fileDigest(fixtureValue.kubectl),
    },
    kubeconfig: {
      path: fixtureValue.kubeconfig,
      expectedDigest: fileDigest(fixtureValue.kubeconfig),
    },
    context: CONTEXT,
    expectedClusterUid: CLUSTER_UID,
    transitionKind: 'install',
    expectedHead: {
      generation: 0,
      deploymentDigest: null,
      lockDigest: null,
      stateDigest: null,
    },
  };
}

function successfulRunner(calls, server = {}, manifestContents = manifest()) {
  server.head ??= null;
  server.resourceVersion ??= 0;
  const runner = (_executable, args, input) => {
    calls.push({ args: [...args], input });
    if (args.includes('get') && args.includes('-f=-')) {
      return {
        status: 0,
        stdout: convergenceList(manifestContents),
        stderr: '',
      };
    }
    if (args.includes('get') && args.includes(HEAD_NAME)) {
      return {
        status: 0,
        stdout: server.head === null ? '' : JSON.stringify(server.head),
        stderr: '',
      };
    }
    if (args.includes('get') && args.includes('kube-system')) {
      return { status: 0, stdout: CLUSTER_UID, stderr: '' };
    }
    if (args.includes('--dry-run=server')) {
      return { status: 0, stdout: 'deployment.apps/ql3-control\n', stderr: '' };
    }
    if (args.includes('create') || args.includes('replace')) {
      const configMap = JSON.parse(input);
      if (
        (args.includes('create') && server.head !== null) ||
        (args.includes('replace') &&
          (server.head === null ||
            configMap.metadata.resourceVersion !==
              server.head.metadata.resourceVersion))
      ) {
        return { status: 1, stdout: '', stderr: 'conflict' };
      }
      server.resourceVersion += 1;
      server.head = {
        ...configMap,
        metadata: {
          ...configMap.metadata,
          resourceVersion: String(server.resourceVersion),
          uid: '123e4567-e89b-42d3-a456-426614174099',
        },
      };
      return { status: 0, stdout: JSON.stringify(server.head), stderr: '' };
    }
    return { status: 0, stdout: 'deployment.apps/ql3-control\n', stderr: '' };
  };
  runner.server = server;
  return runner;
}

function convergenceList(manifestContents = manifest()) {
  const resources = [];
  yaml.loadAll(manifestContents, (resource) => resources.push(resource));
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'List',
    items: resources.map((resource, index) => ({
      ...resource,
      metadata: {
        ...resource.metadata,
        uid: `123e4567-e89b-42d3-a456-4266141741${String(index).padStart(
          2,
          '0',
        )}`,
        resourceVersion: String(index + 1),
        managedFields: [
          {
            manager: FIELD_MANAGER,
            operation: 'Apply',
            apiVersion: resource.apiVersion,
          },
        ],
      },
    })),
  });
}

function prepare(t) {
  const value = fixture(t);
  const output = path.join(value.directory, 'preflight.json');
  const command = writeCommand(
    value.directory,
    'preflight-command.json',
    'cluster.deployment.preflight',
    {
      preflightId: '123e4567-e89b-42d3-a456-426614174001',
      ...commonRequest(value),
      output,
    },
  );
  const calls = [];
  const runner = successfulRunner(calls, {}, value.manifestContents);
  const report = executeCommand(command, {
    runProcess: runner,
  });
  return {
    ...value,
    preflightCommand: command,
    preflightPath: output,
    preflight: report,
    calls,
    runner,
  };
}

function expectedFromReceipt(receipt) {
  return {
    generation: receipt.deploymentHead.generation,
    deploymentDigest: receipt.deploymentHead.deploymentDigest,
    lockDigest: receipt.deploymentHead.lockDigest,
    stateDigest: receipt.deploymentHead.stateDigest,
  };
}

function performTransition(
  value,
  runner,
  transitionKind,
  expectedHead,
  suffix,
) {
  const preflightPath = path.join(value.directory, `${suffix}-preflight.json`);
  const preflightCommand = writeCommand(
    value.directory,
    `${suffix}-preflight-command.json`,
    'cluster.deployment.preflight',
    {
      preflightId: crypto.randomUUID(),
      ...commonRequest(value),
      transitionKind,
      expectedHead,
      output: preflightPath,
    },
  );
  const preflight = executeCommand(preflightCommand, { runProcess: runner });
  const receiptPath = path.join(value.directory, `${suffix}-receipt.json`);
  const applyCommand = writeCommand(
    value.directory,
    `${suffix}-apply-command.json`,
    'cluster.deployment.apply',
    {
      mutationId: crypto.randomUUID(),
      preflight: {
        path: preflightPath,
        expectedDigest: preflight.preflightDigest,
      },
      ...commonRequest(value),
      transitionKind,
      expectedHead,
      output: receiptPath,
    },
  );
  return {
    preflight,
    preflightPath,
    applyCommand,
    receiptPath,
    receipt: executeCommand(applyCommand, { runProcess: runner }),
  };
}

const RETIREMENT_TARGET = Object.freeze({
  apiVersion: 'v1',
  kind: 'ConfigMap',
  namespace: 'qinglong-system',
  name: 'ql3-extra-release-resource',
});

function retirementRequest(value, expectedHead) {
  return {
    lockedManifest: {
      path: value.lockedManifest,
      expectedDigest: value.report.manifest.outputDigest,
    },
    lockReport: {
      path: value.lockReportPath,
      expectedDigest: value.report.lockDigest,
    },
    kubectl: {
      path: value.kubectl,
      expectedDigest: fileDigest(value.kubectl),
    },
    curl: {
      path: value.curl,
      expectedDigest: fileDigest(value.curl),
    },
    kubeconfig: {
      path: value.kubeconfig,
      expectedDigest: fileDigest(value.kubeconfig),
    },
    context: CONTEXT,
    expectedClusterUid: CLUSTER_UID,
    expectedHead,
    targets: [RETIREMENT_TARGET],
  };
}

function apiObjectPath(resource) {
  const namespace = encodeURIComponent(resource.metadata.namespace);
  const name = encodeURIComponent(resource.metadata.name);
  if (resource.apiVersion === 'v1' && resource.kind === 'ConfigMap') {
    return `/api/v1/namespaces/${namespace}/configmaps/${name}`;
  }
  throw new Error('unsupported fake API resource');
}

class FakeRetirementApi {
  constructor(manifestContents) {
    this.objects = new Map();
    this.requests = [];
    this.loseNextDeleteResponse = false;
    const list = JSON.parse(convergenceList(manifestContents));
    for (const resource of list.items) {
      if (resource.apiVersion === 'v1' && resource.kind === 'ConfigMap') {
        this.objects.set(apiObjectPath(resource), resource);
      }
    }
  }

  request(method, requestPath, body) {
    this.requests.push({ method, requestPath, body });
    if (method === 'GET' && requestPath === '/api/v1') {
      return {
        status: 200,
        body: JSON.stringify({
          groupVersion: 'v1',
          resources: [
            {
              name: 'configmaps',
              namespaced: true,
              kind: 'ConfigMap',
              verbs: ['delete', 'get', 'list'],
            },
          ],
        }),
      };
    }
    const live = this.objects.get(requestPath);
    if (method === 'GET') {
      return live === undefined
        ? { status: 404, body: JSON.stringify({ kind: 'Status' }) }
        : { status: 200, body: JSON.stringify(live) };
    }
    if (method !== 'DELETE') throw new Error('unexpected fake API method');
    if (live === undefined) {
      return { status: 404, body: JSON.stringify({ kind: 'Status' }) };
    }
    if (
      body?.preconditions?.uid !== live.metadata.uid ||
      body?.preconditions?.resourceVersion !== live.metadata.resourceVersion
    ) {
      return { status: 409, body: JSON.stringify({ kind: 'Status' }) };
    }
    if (body.dryRun?.includes('All')) {
      return { status: 200, body: JSON.stringify({ kind: 'Status' }) };
    }
    this.objects.delete(requestPath);
    if (this.loseNextDeleteResponse) {
      this.loseNextDeleteResponse = false;
      throw new Error('simulated response loss');
    }
    return { status: 200, body: JSON.stringify({ kind: 'Status' }) };
  }
}

function prepareRetirement(t) {
  const value = fixture(t, { extraResource: true });
  const runner = successfulRunner([], {}, value.manifestContents);
  const installed = performTransition(
    value,
    runner,
    'install',
    commonRequest(value).expectedHead,
    'retirement-install',
  );
  const expectedHead = expectedFromReceipt(installed.receipt);
  const api = new FakeRetirementApi(value.manifestContents);
  const preflightPath = path.join(value.directory, 'retirement-preflight.json');
  const preflightCommand = writeCommand(
    value.directory,
    'retirement-preflight-command.json',
    'cluster.deployment.retirement.preflight',
    {
      preflightId: crypto.randomUUID(),
      ...retirementRequest(value, expectedHead),
      output: preflightPath,
    },
  );
  const preflight = executeCommand(preflightCommand, {
    runProcess: runner,
    retirementApi: api,
  });
  return {
    ...value,
    runner,
    installed,
    expectedHead,
    api,
    preflight,
    preflightPath,
    preflightCommand,
  };
}

function retirementApplyCommand(value, suffix = 'retirement') {
  const receiptPath = path.join(value.directory, `${suffix}-receipt.json`);
  const applyCommand = writeCommand(
    value.directory,
    `${suffix}-apply-command.json`,
    'cluster.deployment.retirement.apply',
    {
      mutationId: crypto.randomUUID(),
      preflight: {
        path: value.preflightPath,
        expectedDigest: value.preflight.preflightDigest,
      },
      ...retirementRequest(value, value.expectedHead),
      output: receiptPath,
    },
  );
  return { applyCommand, receiptPath };
}

test('preflight binds one catalog lock to one Kubernetes target without mutation', (t) => {
  const value = prepare(t);
  assert.equal(value.preflight.schema, PREFLIGHT_SCHEMA);
  assert.equal(value.preflight.lock.lockDigest, value.report.lockDigest);
  assert.equal(
    value.preflight.lock.manifestDigest,
    value.report.manifest.outputDigest,
  );
  assert.equal(value.preflight.target.clusterUid, CLUSTER_UID);
  assert.equal(value.preflight.target.fieldManager, FIELD_MANAGER);
  assert.equal(value.preflight.verification.serverSideDryRun, true);
  assert.equal(value.preflight.verification.kubernetesMutation, false);
  assert.deepEqual(
    value.preflight.steps.map(({ name }) => name),
    ['cluster_identity_before', 'deployment_head_read', 'server_side_dry_run'],
  );
  assert.equal(fs.statSync(value.preflightPath).mode & 0o777, 0o600);
  assert.equal(value.calls.length, 3);
  assert.equal(value.calls[0].args.includes('get'), true);
  assert.equal(value.calls[1].args.includes(HEAD_NAME), true);
  assert.equal(value.calls[2].args.includes('--dry-run=server'), true);
  assert.equal(
    value.calls[2].args.includes(`--field-manager=${FIELD_MANAGER}`),
    true,
  );
  assert.equal(value.calls[2].input, manifest());
});

test('preflight rejects lock, manifest and annotation drift before network access', (t) => {
  const cases = [
    (target) => fs.appendFileSync(target.lockedManifest, '\n'),
    (target) => {
      const drifted = { ...target.report, lockDigest: digest('forged') };
      fs.writeFileSync(target.lockReportPath, canonicalJson(drifted));
    },
    (target) => {
      const driftedManifest = manifest().replace(
        CATALOG_REPORT_DIGEST,
        digest('different-catalog-report'),
      );
      fs.writeFileSync(target.lockedManifest, driftedManifest);
      const report = lockReport(driftedManifest);
      fs.writeFileSync(target.lockReportPath, canonicalJson(report));
      target.report = report;
    },
    (target) => {
      const implicitNamespaceManifest = manifest().replace(
        '"namespace":"qinglong-system",',
        '',
      );
      fs.writeFileSync(target.lockedManifest, implicitNamespaceManifest);
      const report = lockReport(implicitNamespaceManifest);
      fs.writeFileSync(target.lockReportPath, canonicalJson(report));
      target.report = report;
    },
  ];
  for (const [index, mutate] of cases.entries()) {
    const fresh = fixture(t);
    mutate(fresh);
    const output = path.join(fresh.directory, `rejected-${index}.json`);
    const request = commonRequest(fresh);
    request.lockedManifest.expectedDigest = fresh.report.manifest.outputDigest;
    request.lockReport.expectedDigest = fresh.report.lockDigest;
    const command = writeCommand(
      fresh.directory,
      `rejected-command-${index}.json`,
      'cluster.deployment.preflight',
      {
        preflightId: `123e4567-e89b-42d3-a456-42661417400${index + 2}`,
        ...request,
        output,
      },
    );
    let calls = 0;
    assert.throws(
      () =>
        executeCommand(command, {
          runProcess() {
            calls += 1;
            return { status: 0, stdout: CLUSTER_UID, stderr: '' };
          },
        }),
      /deployment ceremony failed/,
    );
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(output), false);
  }
});

test('preflight rejects the wrong cluster and rejected server dry-run', (t) => {
  for (const failure of ['identity', 'dry-run']) {
    const value = fixture(t);
    const output = path.join(value.directory, `${failure}.json`);
    const command = writeCommand(
      value.directory,
      `${failure}-command.json`,
      'cluster.deployment.preflight',
      {
        preflightId:
          failure === 'identity'
            ? '123e4567-e89b-42d3-a456-426614174010'
            : '123e4567-e89b-42d3-a456-426614174011',
        ...commonRequest(value),
        output,
      },
    );
    const base = successfulRunner([]);
    assert.throws(() =>
      executeCommand(command, {
        runProcess(executable, args, input) {
          if (args.includes('get') && args.includes('kube-system')) {
            return {
              status: 0,
              stdout:
                failure === 'identity' ? crypto.randomUUID() : CLUSTER_UID,
              stderr: '',
            };
          }
          if (failure === 'dry-run' && args.includes('--dry-run=server')) {
            return {
              status: 1,
              stdout: '',
              stderr: 'redacted admission error',
            };
          }
          return base(executable, args, input);
        },
      }),
    );
    assert.equal(fs.existsSync(output), false);
  }
});

test('kubeconfig executable authentication and weak private files fail closed', (t) => {
  for (const mode of ['exec', 'public']) {
    const value = fixture(t);
    if (mode === 'exec') {
      fs.writeFileSync(
        value.kubeconfig,
        fs
          .readFileSync(value.kubeconfig, 'utf8')
          .replace(
            'token: bounded-test-token',
            'exec:\n        command: owned',
          ),
      );
    } else {
      fs.chmodSync(value.kubeconfig, 0o644);
    }
    const output = path.join(value.directory, `${mode}.json`);
    const command = writeCommand(
      value.directory,
      `${mode}-command.json`,
      'cluster.deployment.preflight',
      {
        preflightId:
          mode === 'exec'
            ? '123e4567-e89b-42d3-a456-426614174020'
            : '123e4567-e89b-42d3-a456-426614174021',
        ...commonRequest(value),
        output,
      },
    );
    let calls = 0;
    assert.throws(() =>
      executeCommand(command, {
        runProcess() {
          calls += 1;
          return { status: 0, stdout: CLUSTER_UID, stderr: '' };
        },
      }),
    );
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(output), false);
  }
});

test('apply revalidates preflight, mutates explicitly and proves convergence', (t) => {
  const value = prepare(t);
  const receiptPath = path.join(value.directory, 'receipt.json');
  const applyCommand = writeCommand(
    value.directory,
    'apply-command.json',
    'cluster.deployment.apply',
    {
      mutationId: '123e4567-e89b-42d3-a456-426614174030',
      preflight: {
        path: value.preflightPath,
        expectedDigest: value.preflight.preflightDigest,
      },
      ...commonRequest(value),
      output: receiptPath,
    },
  );
  const calls = [];
  value.calls.length = 0;
  const receipt = executeCommand(applyCommand, {
    runProcess(executable, args, input) {
      calls.push({ args: [...args], input });
      return value.runner(executable, args, input);
    },
  });
  assert.equal(receipt.schema, RECEIPT_SCHEMA);
  assert.equal(receipt.preflightDigest, value.preflight.preflightDigest);
  assert.equal(receipt.verification.kubernetesMutation, true);
  assert.equal(receipt.verification.crossResourceAtomicity, false);
  assert.equal(
    receipt.verification.recovery,
    'resume_exact_transition_from_target_head',
  );
  assert.deepEqual(
    receipt.steps.map(({ name }) => name),
    [
      'cluster_identity_before',
      'server_side_dry_run',
      'server_side_apply',
      'server_side_convergence_read',
      'cluster_identity_after',
    ],
  );
  assert.equal(calls.length, 8);
  assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);

  const auditCommand = writeCommand(
    value.directory,
    'audit-command.json',
    'cluster.deployment.receipt.audit',
    {
      applyCommand: {
        path: applyCommand,
        expectedDigest: fileDigest(applyCommand),
      },
      receipt: { path: receiptPath, expectedDigest: receipt.receiptDigest },
    },
  );
  assert.deepEqual(executeCommand(auditCommand), {
    compatible: true,
    deploymentFamily: 'cluster',
    mutationId: receipt.mutationId,
    receiptDigest: receipt.receiptDigest,
    preflightDigest: receipt.preflightDigest,
    transitionKind: 'install',
    lockDigest: value.report.lockDigest,
    manifestDigest: value.report.manifest.outputDigest,
    deploymentGeneration: 1,
    deploymentDigest: receipt.deploymentHead.deploymentDigest,
    deploymentHeadStateDigest: receipt.deploymentHead.stateDigest,
    resourceCount: 5,
    clusterUid: CLUSTER_UID,
    externalResultsReplayed: false,
    kubernetesMutation: false,
  });

  let replayCalls = 0;
  assert.equal(
    executeCommand(applyCommand, {
      runProcess(executable, args, input) {
        replayCalls += 1;
        return value.runner(executable, args, input);
      },
    }).receiptDigest,
    receipt.receiptDigest,
  );
  assert.equal(replayCalls, 1);
});

test('apply failure or post-apply drift never publishes a success receipt', (t) => {
  for (const failure of ['apply', 'convergence', 'identity-after']) {
    const value = prepare(t);
    const receiptPath = path.join(value.directory, `${failure}-receipt.json`);
    const applyCommand = writeCommand(
      value.directory,
      `${failure}-apply-command.json`,
      'cluster.deployment.apply',
      {
        mutationId:
          failure === 'apply'
            ? '123e4567-e89b-42d3-a456-426614174040'
            : failure === 'convergence'
            ? '123e4567-e89b-42d3-a456-426614174041'
            : '123e4567-e89b-42d3-a456-426614174042',
        preflight: {
          path: value.preflightPath,
          expectedDigest: value.preflight.preflightDigest,
        },
        ...commonRequest(value),
        output: receiptPath,
      },
    );
    let identityCount = 0;
    const base = value.runner;
    assert.throws(() =>
      executeCommand(applyCommand, {
        runProcess(executable, args, input) {
          if (args.includes('get') && args.includes('-f=-')) {
            return {
              status: failure === 'convergence' ? 1 : 0,
              stdout: failure === 'convergence' ? '' : convergenceList(),
              stderr:
                failure === 'convergence' ? 'redacted convergence error' : '',
            };
          }
          if (args.includes('get') && args.includes('kube-system')) {
            identityCount += 1;
            return {
              status: 0,
              stdout:
                failure === 'identity-after' && identityCount === 2
                  ? crypto.randomUUID()
                  : CLUSTER_UID,
              stderr: '',
            };
          }
          if (args.includes('--dry-run=server')) {
            return { status: 0, stdout: 'dry-run', stderr: '' };
          }
          if (failure === 'apply' && args.includes('apply')) {
            return {
              status: 1,
              stdout: '',
              stderr: 'redacted apply error',
            };
          }
          return base(executable, args, input);
        },
      }),
    );
    assert.equal(fs.existsSync(receiptPath), false);
  }
});

test('apply resumes the exact applying intent from the target head', (t) => {
  const value = prepare(t);
  const receiptPath = path.join(value.directory, 'resumed-receipt.json');
  const applyCommand = writeCommand(
    value.directory,
    'resumed-apply-command.json',
    'cluster.deployment.apply',
    {
      mutationId: '123e4567-e89b-42d3-a456-426614174043',
      preflight: {
        path: value.preflightPath,
        expectedDigest: value.preflight.preflightDigest,
      },
      ...commonRequest(value),
      output: receiptPath,
    },
  );
  let rejected = false;
  assert.throws(() =>
    executeCommand(applyCommand, {
      runProcess(executable, args, input) {
        if (
          !rejected &&
          args.includes('apply') &&
          !args.includes('--dry-run=server')
        ) {
          rejected = true;
          return { status: 1, stdout: '', stderr: 'transient rejection' };
        }
        return value.runner(executable, args, input);
      },
    }),
  );
  assert.equal(fs.existsSync(receiptPath), false);
  assert.equal(
    JSON.parse(value.runner.server.head.data[HEAD_DATA_KEY]).phase,
    'applying',
  );
  const receipt = executeCommand(applyCommand, {
    runProcess: value.runner,
  });
  assert.equal(receipt.deploymentHead.generation, 1);
  assert.equal(
    JSON.parse(value.runner.server.head.data[HEAD_DATA_KEY]).phase,
    'committed',
  );
});

test('a stale preflight cannot overtake a committed deployment intent', (t) => {
  const value = prepare(t);
  const competingPreflightPath = path.join(
    value.directory,
    'competing-preflight.json',
  );
  const competingPreflightCommand = writeCommand(
    value.directory,
    'competing-preflight-command.json',
    'cluster.deployment.preflight',
    {
      preflightId: '123e4567-e89b-42d3-a456-426614174044',
      ...commonRequest(value),
      output: competingPreflightPath,
    },
  );
  const competingPreflight = executeCommand(competingPreflightCommand, {
    runProcess: value.runner,
  });
  const winner = performTransition(
    value,
    value.runner,
    'install',
    commonRequest(value).expectedHead,
    'winner',
  );
  assert.equal(winner.receipt.deploymentHead.generation, 1);
  const staleReceipt = path.join(value.directory, 'stale-receipt.json');
  const staleApply = writeCommand(
    value.directory,
    'stale-apply-command.json',
    'cluster.deployment.apply',
    {
      mutationId: '123e4567-e89b-42d3-a456-426614174045',
      preflight: {
        path: competingPreflightPath,
        expectedDigest: competingPreflight.preflightDigest,
      },
      ...commonRequest(value),
      output: staleReceipt,
    },
  );
  assert.throws(() => executeCommand(staleApply, { runProcess: value.runner }));
  assert.equal(fs.existsSync(staleReceipt), false);
});

test('upgrade fails closed when its target omits an active resource', (t) => {
  const server = {};
  const installValue = fixture(t, { version: '3.0.0-alpha.0' });
  const installRunner = successfulRunner(
    [],
    server,
    installValue.manifestContents,
  );
  const installed = performTransition(
    installValue,
    installRunner,
    'install',
    commonRequest(installValue).expectedHead,
    'inventory-install',
  );
  const expandedValue = fixture(t, {
    version: '3.0.0-alpha.1',
    extraResource: true,
  });
  const expandedRunner = successfulRunner(
    [],
    server,
    expandedValue.manifestContents,
  );
  const expanded = performTransition(
    expandedValue,
    expandedRunner,
    'upgrade',
    expectedFromReceipt(installed.receipt),
    'inventory-expand',
  );
  assert.equal(expanded.receipt.resourceInventory.length, 6);

  const reducedValue = fixture(t, { version: '3.0.0-alpha.2' });
  const reducedRunner = successfulRunner(
    [],
    server,
    reducedValue.manifestContents,
  );
  const reducedPreflightPath = path.join(
    reducedValue.directory,
    'inventory-reduce-preflight.json',
  );
  const reducedPreflight = writeCommand(
    reducedValue.directory,
    'inventory-reduce-preflight-command.json',
    'cluster.deployment.preflight',
    {
      preflightId: crypto.randomUUID(),
      ...commonRequest(reducedValue),
      transitionKind: 'upgrade',
      expectedHead: expectedFromReceipt(expanded.receipt),
      output: reducedPreflightPath,
    },
  );
  assert.throws(() =>
    executeCommand(reducedPreflight, { runProcess: reducedRunner }),
  );
  assert.equal(fs.existsSync(reducedPreflightPath), false);
});

test('rollback restores only the exact previous lock with unchanged inventory', (t) => {
  const server = {};
  const installValue = fixture(t, { version: '3.0.0-alpha.0' });
  const installRunner = successfulRunner(
    [],
    server,
    installValue.manifestContents,
  );
  const installed = performTransition(
    installValue,
    installRunner,
    'install',
    commonRequest(installValue).expectedHead,
    'rollback-install',
  );
  const upgradeValue = fixture(t, { version: '3.0.0-alpha.1' });
  const upgradeRunner = successfulRunner(
    [],
    server,
    upgradeValue.manifestContents,
  );
  const upgraded = performTransition(
    upgradeValue,
    upgradeRunner,
    'upgrade',
    expectedFromReceipt(installed.receipt),
    'rollback-upgrade',
  );
  const rolledBack = performTransition(
    installValue,
    installRunner,
    'rollback',
    expectedFromReceipt(upgraded.receipt),
    'rollback-restore',
  );
  assert.equal(rolledBack.receipt.transitionKind, 'rollback');
  assert.equal(rolledBack.receipt.deploymentHead.generation, 3);
  assert.equal(
    rolledBack.receipt.lock.lockDigest,
    installed.receipt.lock.lockDigest,
  );
  assert.deepEqual(
    rolledBack.receipt.resourceInventory,
    installed.receipt.resourceInventory,
  );
});

test('receipt audit rejects a different command or recomputed receipt', (t) => {
  const value = prepare(t);
  const receiptPath = path.join(value.directory, 'receipt.json');
  const applyCommand = writeCommand(
    value.directory,
    'apply-command.json',
    'cluster.deployment.apply',
    {
      mutationId: '123e4567-e89b-42d3-a456-426614174050',
      preflight: {
        path: value.preflightPath,
        expectedDigest: value.preflight.preflightDigest,
      },
      ...commonRequest(value),
      output: receiptPath,
    },
  );
  const receipt = executeCommand(applyCommand, {
    runProcess: successfulRunner([]),
  });
  const forged = { ...receipt, mutationId: crypto.randomUUID() };
  const { receiptDigest: ignored, ...unsigned } = forged;
  forged.receiptDigest = digest(JSON.stringify(unsigned));
  fs.writeFileSync(receiptPath, canonicalJson(forged));
  const auditCommand = writeCommand(
    value.directory,
    'audit-command.json',
    'cluster.deployment.receipt.audit',
    {
      applyCommand: {
        path: applyCommand,
        expectedDigest: fileDigest(applyCommand),
      },
      receipt: { path: receiptPath, expectedDigest: receipt.receiptDigest },
    },
  );
  assert.throws(() => executeCommand(auditCommand));
});

test('retirement preflight binds exact UID and resourceVersion without mutation', (t) => {
  const value = prepareRetirement(t);
  assert.equal(value.preflight.schema, RETIREMENT_PREFLIGHT_SCHEMA);
  assert.deepEqual(value.preflight.activeResourceInventory.length, 6);
  assert.deepEqual(value.preflight.survivorResourceInventory.length, 5);
  assert.deepEqual(value.preflight.retirementTargets[0], {
    ...RETIREMENT_TARGET,
    uid: '123e4567-e89b-42d3-a456-426614174105',
    resourceVersion: '6',
  });
  assert.equal(value.preflight.verification.kubernetesMutation, false);
  const deletes = value.api.requests.filter(
    (request) => request.method === 'DELETE',
  );
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].body.preconditions, {
    uid: value.preflight.retirementTargets[0].uid,
    resourceVersion: value.preflight.retirementTargets[0].resourceVersion,
  });
  assert.deepEqual(deletes[0].body.dryRun, ['All']);
  assert.equal(
    value.api.objects.has(
      apiObjectPath({
        ...RETIREMENT_TARGET,
        metadata: {
          namespace: RETIREMENT_TARGET.namespace,
          name: RETIREMENT_TARGET.name,
        },
      }),
    ),
    true,
  );
});

test('retirement applies preconditioned deletion, closes inventory and audits receipt', (t) => {
  const value = prepareRetirement(t);
  const { applyCommand, receiptPath } = retirementApplyCommand(value);
  const receipt = executeCommand(applyCommand, {
    runProcess: value.runner,
    retirementApi: value.api,
  });
  assert.equal(receipt.schema, RETIREMENT_RECEIPT_SCHEMA);
  assert.equal(receipt.resourceInventory.length, 5);
  assert.equal(receipt.retiredResources.length, 1);
  assert.equal(
    receipt.verification.uidResourceVersionDeletePreconditions,
    true,
  );
  assert.equal(receipt.verification.deletionAbsenceConfirmed, true);
  assert.equal(receipt.deploymentHead.generation, 2);
  assert.equal(
    JSON.parse(value.runner.server.head.data[HEAD_DATA_KEY]).transition.kind,
    'retire',
  );
  const actualDelete = value.api.requests.find(
    (request) =>
      request.method === 'DELETE' && request.body?.dryRun === undefined,
  );
  assert.deepEqual(actualDelete.body.preconditions, {
    uid: receipt.retiredResources[0].uid,
    resourceVersion: receipt.retiredResources[0].resourceVersion,
  });

  const auditCommand = writeCommand(
    value.directory,
    'retirement-audit-command.json',
    'cluster.deployment.retirement.receipt.audit',
    {
      applyCommand: {
        path: applyCommand,
        expectedDigest: fileDigest(applyCommand),
      },
      receipt: { path: receiptPath, expectedDigest: receipt.receiptDigest },
    },
  );
  const audit = executeCommand(auditCommand);
  assert.equal(audit.compatible, true);
  assert.equal(audit.transitionKind, 'retire');
  assert.equal(audit.retiredResourceCount, 1);
  assert.equal(audit.resourceCount, 5);
  assert.equal(audit.kubernetesMutation, false);
});

test('retirement rejects a replacement UID before acquiring the deployment head', (t) => {
  const value = prepareRetirement(t);
  const { applyCommand, receiptPath } = retirementApplyCommand(
    value,
    'replacement',
  );
  const requestPath = [...value.api.objects.keys()].find((candidate) =>
    candidate.endsWith('/ql3-extra-release-resource'),
  );
  const live = value.api.objects.get(requestPath);
  value.api.objects.set(requestPath, {
    ...live,
    metadata: { ...live.metadata, uid: crypto.randomUUID() },
  });
  assert.throws(() =>
    executeCommand(applyCommand, {
      runProcess: value.runner,
      retirementApi: value.api,
    }),
  );
  assert.equal(fs.existsSync(receiptPath), false);
  const head = JSON.parse(value.runner.server.head.data[HEAD_DATA_KEY]);
  assert.equal(head.phase, 'committed');
  assert.equal(head.generation, 1);
});

test('retirement resumes exact intent after a lost delete response', (t) => {
  const value = prepareRetirement(t);
  const { applyCommand, receiptPath } = retirementApplyCommand(
    value,
    'response-loss',
  );
  value.api.loseNextDeleteResponse = true;
  assert.throws(() =>
    executeCommand(applyCommand, {
      runProcess: value.runner,
      retirementApi: value.api,
    }),
  );
  assert.equal(fs.existsSync(receiptPath), false);
  assert.equal(
    JSON.parse(value.runner.server.head.data[HEAD_DATA_KEY]).phase,
    'applying',
  );
  const receipt = executeCommand(applyCommand, {
    runProcess: value.runner,
    retirementApi: value.api,
  });
  assert.equal(receipt.deploymentHead.generation, 2);
  assert.equal(receipt.resourceInventory.length, 5);
  assert.equal(
    JSON.parse(value.runner.server.head.data[HEAD_DATA_KEY]).phase,
    'committed',
  );
});

test('rollback may restore the exact inventory retired at the same release version', (t) => {
  const value = prepareRetirement(t);
  const { applyCommand } = retirementApplyCommand(value, 'restore-source');
  const retired = executeCommand(applyCommand, {
    runProcess: value.runner,
    retirementApi: value.api,
  });
  const restored = performTransition(
    value,
    value.runner,
    'rollback',
    expectedFromReceipt(retired),
    'retirement-restore',
  );
  assert.equal(restored.receipt.transitionKind, 'rollback');
  assert.equal(restored.receipt.deploymentHead.generation, 3);
  assert.equal(restored.receipt.resourceInventory.length, 6);
  assert.deepEqual(
    restored.receipt.resourceInventory,
    value.installed.receipt.resourceInventory,
  );
});

test('command surface is closed and lock reports require exact canonical identity', () => {
  assert.equal(
    commandFile(['--command-file=/private/command.json']),
    '/private/command.json',
  );
  assert.throws(() => commandFile([]));
  assert.throws(() => commandFile(['--command-file=a', '--extra=b']));
  assert.throws(() =>
    parseCommand({
      schemaVersion: 1,
      schema: COMMAND_SCHEMA,
      operation: 'cluster.deployment.apply-now',
      request: {},
    }),
  );
  const report = lockReport();
  assert.equal(validateLockReport(report).report.lockDigest, report.lockDigest);
  const drifted = JSON.parse(JSON.stringify(report));
  drifted.catalog.discoveryTagAuthority = 'fallback';
  const { lockDigest: ignored, ...unsigned } = drifted;
  drifted.lockDigest = digest(JSON.stringify(unsigned));
  assert.throws(() => validateLockReport(drifted));
});

test('repository exposes the reviewed ceremony and removes the bare apply handoff', () => {
  const root = path.resolve(__dirname, '../..');
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageManifest.scripts['cluster-deployment:ql3'],
    'node scripts/ql3-kubernetes-deployment-ceremony.cjs',
  );
  assert.equal(
    packageManifest.scripts['test:cluster-deployment-live:ql3'],
    'node scripts/ql3-kubernetes-deployment-live-contract.cjs',
  );
  const operations = fs.readFileSync(
    path.join(root, 'docs/operations/ql3-release-set-deployment.md'),
    'utf8',
  );
  assert.match(operations, /cluster\.deployment\.preflight/);
  assert.match(operations, /cluster\.deployment\.apply/);
  assert.match(operations, /cluster\.deployment\.receipt\.audit/);
  assert.match(operations, /qinglong3-catalog-lock/);
  assert.equal(
    operations.includes('才由有权限的独立步骤执行 `kubectl apply'),
    false,
  );
});

test('CI runs the isolated deployment and retirement live contract', () => {
  const root = path.resolve(__dirname, '../..');
  const workflowPath = path.join(
    root,
    '.github/workflows/ql3-kubernetes-deployment-live.yml',
  );
  const workflowSource = fs.readFileSync(workflowPath, 'utf8');
  const workflow = yaml.load(workflowSource);
  const job = workflow.jobs?.['kubernetes-deployment-live'];
  assert.equal(job?.['runs-on'], 'ubuntu-24.04');
  assert.equal(job?.['timeout-minutes'], 25);
  assert.match(workflowSource, /rancher\/k3s:v1\.34\.3-k3s1/u);
  assert.match(workflowSource, /kubectl v1\.34\.3/u);
  assert.match(
    workflowSource,
    /node --test test\/back\/ql3KubernetesDeploymentCeremony\.test\.cjs/u,
  );
  assert.match(
    workflowSource,
    /node scripts\/ql3-kubernetes-deployment-live-contract\.cjs/u,
  );
  assert.match(workflowSource, /uidResourceVersionDeletePreconditions/u);
  assert.match(workflowSource, /ql3-deploy-live-/u);
});

test('live contract never resolves curl through the Docker kubectl fallback', function liveToolResolutionKeepsCurlDistinct() {
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(
    path.join(root, 'scripts/ql3-kubernetes-deployment-live-contract.cjs'),
    'utf8',
  );
  assert.match(
    source,
    /const candidates = \[\s*input,\s*\.\.\.\(input === 'kubectl'\s*\? \['\/Applications\/Docker\.app\/Contents\/Resources\/bin\/kubectl'\]\s*: \[\]\),\s*\.\.\.\(process\.env\.PATH/u,
  );
});

test('private retirement proxy rejects every unrelated mutation method', function privateRetirementProxyRejectsUnrelatedMutations() {
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(
    path.join(root, 'scripts/lib/ql3-kubernetes-deployment-ceremony.cjs'),
    'utf8',
  );
  assert.match(
    source,
    /--reject-methods=\^\(POST\|PUT\|PATCH\|CONNECT\|OPTIONS\|TRACE\)\$/u,
  );
  assert.equal(source.includes('--reject-methods=POST,PUT,PATCH'), false);
});

test('thin CLI uses the pinned executable and keeps failures low-sensitive', (t) => {
  const value = fixture(t);
  fs.writeFileSync(
    value.kubectl,
    `#!${process.execPath}
'use strict';
const args = process.argv.slice(2);
if (args.includes('get') && args.includes('-f=-')) process.stdout.write(${JSON.stringify(
      convergenceList(),
    )});
else if (args.includes('get') && args.includes(${JSON.stringify(
      HEAD_NAME,
    )})) process.stdout.write('');
else if (args.includes('get')) process.stdout.write(${JSON.stringify(
      CLUSTER_UID,
    )});
else if (args.includes('--dry-run=server')) process.stdout.write('deployment.apps/ql3-control\\n');
else process.exitCode = 91;
`,
    { mode: 0o700 },
  );
  const output = path.join(value.directory, 'cli-preflight.json');
  const command = writeCommand(
    value.directory,
    'cli-command.json',
    'cluster.deployment.preflight',
    {
      preflightId: '123e4567-e89b-42d3-a456-426614174060',
      ...commonRequest(value),
      output,
    },
  );
  const cli = path.resolve(
    __dirname,
    '../../scripts/ql3-kubernetes-deployment-ceremony.cjs',
  );
  const accepted = spawnSync(
    process.execPath,
    [cli, `--command-file=${command}`],
    { encoding: 'utf8' },
  );
  assert.equal(
    accepted.status,
    0,
    JSON.stringify({ stdout: accepted.stdout, stderr: accepted.stderr }),
  );
  assert.equal(accepted.stderr, '');
  assert.equal(JSON.parse(accepted.stdout).schema, PREFLIGHT_SCHEMA);

  fs.chmodSync(value.kubeconfig, 0o644);
  const rejected = spawnSync(
    process.execPath,
    [cli, `--command-file=${command}`],
    { encoding: 'utf8' },
  );
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.deepEqual(JSON.parse(rejected.stderr), {
    schemaVersion: 1,
    component: 'qinglong3-kubernetes-deployment-ceremony',
    code: 'QL3_KUBERNETES_DEPLOYMENT_CEREMONY_FAILED',
    message: 'QingLong 3 Kubernetes deployment ceremony failed',
  });
  assert.equal(rejected.stderr.includes(value.directory), false);
  assert.equal(rejected.stderr.includes(CONTEXT), false);
});

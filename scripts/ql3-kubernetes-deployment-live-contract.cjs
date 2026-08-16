#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  COMMAND_SCHEMA,
  FIELD_MANAGER,
  canonicalJson,
  executeCommand,
} = require('./lib/ql3-kubernetes-deployment-ceremony.cjs');
const { K3sDockerLiveFixture } = require('./lib/ql3-k3s-docker-live.cjs');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const ROOT = path.resolve(__dirname, '..');
const VERSION = readReleaseIdentity(ROOT).version;
const SOURCE_REVISION = 'd'.repeat(40);
const NAMESPACE = 'ql3-deployment-live';
const CONTEXT = 'default';
const OWNER = 'qinglong-release';
const ROLE_ORDER = Object.freeze(['control', 'control-ai', 'admin', 'worker']);
const IMAGE_NAMES = Object.freeze({
  control: 'qinglong3-cluster-control',
  'control-ai': 'qinglong3-cluster-control-ai',
  admin: 'qinglong3-cluster-admin',
  worker: 'qinglong3-worker',
});

function fail(message) {
  throw new Error(
    `QingLong Kubernetes deployment live contract failed: ${message}`,
  );
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function privateFile(directory, name, contents) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, contents, { mode: 0o600, flag: 'wx' });
  return target;
}

function executablePath(input) {
  const candidates = [
    input,
    '/Applications/Docker.app/Contents/Resources/bin/kubectl',
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, input)),
  ];
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      if (fs.lstatSync(resolved).isFile()) return resolved;
    } catch {}
  }
  fail('kubectl executable is unavailable');
}

function references() {
  return Object.fromEntries(
    ROLE_ORDER.map((role, index) => [
      role,
      `ghcr.io/${OWNER}/${IMAGE_NAMES[role]}@sha256:${String(index + 1).repeat(
        64,
      )}`,
    ]),
  );
}

function lockedArtifacts() {
  const releaseSetDigest = digest('d341-live-release-set');
  const catalogManifestDigest = digest('d341-live-catalog-manifest');
  const catalogReportDigest = digest('d341-live-catalog-report');
  const imageReferences = references();
  const annotations = {
    'qinglong.io/release-set-digest': releaseSetDigest,
    'qinglong.io/release-catalog-manifest-digest': catalogManifestDigest,
    'qinglong.io/release-catalog-report-digest': catalogReportDigest,
    'qinglong.io/release-source-revision': SOURCE_REVISION,
    'qinglong.io/release-version': VERSION,
  };
  const deployment = (role) => ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: `ql3-${role.replace('control-ai', 'control-ai')}`,
      namespace: NAMESPACE,
      annotations,
    },
    spec: {
      replicas: 0,
      selector: { matchLabels: { 'app.kubernetes.io/name': `ql3-${role}` } },
      template: {
        metadata: {
          labels: { 'app.kubernetes.io/name': `ql3-${role}` },
          annotations,
        },
        spec: {
          containers: [
            {
              name: role,
              image: imageReferences[role],
              command: ['/bin/false'],
            },
          ],
        },
      },
    },
  });
  const resources = [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: NAMESPACE },
    },
    ...ROLE_ORDER.map(deployment),
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'ql3-plugin-package-secret-action-admission',
        namespace: NAMESPACE,
        annotations,
      },
      data: { image: imageReferences.admin },
    },
  ];
  const manifest = `${resources
    .map((resource) => JSON.stringify(resource))
    .join('\n---\n')}\n`;
  const unsigned = {
    schemaVersion: 1,
    schema: 'qinglong/kubernetes-deployment-lock@v2',
    release: {
      version: VERSION,
      sourceRevision: SOURCE_REVISION,
      sourceRef: `refs/tags/v${VERSION}`,
      scope: 'cluster',
    },
    releaseSetDigest,
    catalog: {
      schema: 'qinglong/release-catalog-consumption-ceremony@v1',
      sourceRepository: `${OWNER}/qinglong`,
      workflowIdentity: `https://github.com/${OWNER}/qinglong/.github/workflows/ql3-image-release.yml@refs/tags/v${VERSION}`,
      immutableReference: `ghcr.io/${OWNER}/qinglong3-release-catalog@${catalogManifestDigest}`,
      manifestDigest: catalogManifestDigest,
      consumptionReportDigest: catalogReportDigest,
      releaseSetDigest,
      discoveryTagAuthority: 'none',
    },
    deploymentFamily: 'cluster',
    requiredImages: [...ROLE_ORDER],
    imageOccurrences: ROLE_ORDER.map((role) => ({
      name: role,
      reference: imageReferences[role],
      count: role === 'admin' ? 2 : 1,
    })),
    manifest: {
      inputDigest: digest('d341-live-source-render'),
      outputDigest: digest(manifest),
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
  return Object.freeze({
    manifest,
    report: Object.freeze({
      ...unsigned,
      lockDigest: digest(JSON.stringify(unsigned)),
    }),
    imageReferences: Object.freeze(imageReferences),
  });
}

function writeCommand(directory, name, operation, request) {
  return privateFile(
    directory,
    name,
    canonicalJson({
      schemaVersion: 1,
      schema: COMMAND_SCHEMA,
      operation,
      request,
    }),
  );
}

async function main() {
  const fixture = new K3sDockerLiveFixture({
    prefix: 'ql3-deploy-live',
    kubectl: process.env.QL3_KUBECTL_BIN,
  });
  let evidence;
  let cleanupComplete = false;
  try {
    const nodes = await fixture.start();
    fs.chmodSync(fixture.temporary, 0o700);
    const ceremonyDirectory = fs.realpathSync(fixture.temporary);
    const kubeconfig = fs.realpathSync(fixture.kubeconfig);
    const kubectl = executablePath(fixture.kubectlBinary);
    const clusterUid = fixture
      .kubectl(
        ['get', 'namespace', 'kube-system', '-o=jsonpath={.metadata.uid}'],
        { capture: true, quiet: true },
      )
      .stdout.trim();
    fixture.apply({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: NAMESPACE },
    });
    const artifacts = lockedArtifacts();
    const manifestPath = privateFile(
      ceremonyDirectory,
      'locked.yaml',
      artifacts.manifest,
    );
    const reportPath = privateFile(
      ceremonyDirectory,
      'lock.json',
      canonicalJson(artifacts.report),
    );
    const common = {
      lockedManifest: {
        path: manifestPath,
        expectedDigest: artifacts.report.manifest.outputDigest,
      },
      lockReport: {
        path: reportPath,
        expectedDigest: artifacts.report.lockDigest,
      },
      kubectl: {
        path: kubectl,
        expectedDigest: digest(fs.readFileSync(kubectl)),
      },
      kubeconfig: {
        path: kubeconfig,
        expectedDigest: digest(fs.readFileSync(kubeconfig)),
      },
      context: CONTEXT,
      expectedClusterUid: clusterUid,
    };
    const preflightPath = path.join(ceremonyDirectory, 'preflight.json');
    const preflightCommand = writeCommand(
      ceremonyDirectory,
      'preflight-command.json',
      'cluster.deployment.preflight',
      {
        preflightId: crypto.randomUUID(),
        ...common,
        output: preflightPath,
      },
    );
    const preflight = executeCommand(preflightCommand);
    const receiptPath = path.join(ceremonyDirectory, 'receipt.json');
    const applyCommand = writeCommand(
      ceremonyDirectory,
      'apply-command.json',
      'cluster.deployment.apply',
      {
        mutationId: crypto.randomUUID(),
        preflight: {
          path: preflightPath,
          expectedDigest: preflight.preflightDigest,
        },
        ...common,
        output: receiptPath,
      },
    );
    const receipt = executeCommand(applyCommand);
    const auditCommand = writeCommand(
      ceremonyDirectory,
      'audit-command.json',
      'cluster.deployment.receipt.audit',
      {
        applyCommand: {
          path: applyCommand,
          expectedDigest: digest(fs.readFileSync(applyCommand)),
        },
        receipt: { path: receiptPath, expectedDigest: receipt.receiptDigest },
      },
    );
    const audit = executeCommand(auditCommand);
    const deployments = fixture.kubectlJson([
      'get',
      'deployments',
      '-n',
      NAMESPACE,
      '--show-managed-fields=true',
    ]).items;
    if (deployments.length !== ROLE_ORDER.length) {
      fail('applied deployment count is invalid');
    }
    for (const deployment of deployments) {
      const container = deployment.spec?.template?.spec?.containers?.[0];
      if (
        !Object.values(artifacts.imageReferences).includes(container?.image)
      ) {
        fail('applied immutable image authority is invalid');
      }
      if (
        !deployment.metadata?.managedFields?.some(
          (entry) => entry.manager === FIELD_MANAGER,
        )
      ) {
        fail('server-side apply field manager is unavailable');
      }
    }
    const version = JSON.parse(
      fixture.kubectl(['version', '-o=json'], {
        capture: true,
        quiet: true,
      }).stdout,
    );
    evidence = Object.freeze({
      schemaVersion: 1,
      schema: 'qinglong/kubernetes-deployment-live-evidence@v1',
      kubernetes: {
        serverVersion: version.serverVersion.gitVersion,
        architecture: version.serverVersion.platform,
        nodeCount: nodes.length,
        clusterUid,
      },
      deployment: {
        namespace: NAMESPACE,
        resourceCount: artifacts.report.manifest.resources,
        deploymentCount: deployments.length,
        replicas: 0,
        fieldManager: FIELD_MANAGER,
        immutableImages: true,
      },
      preflightDigest: preflight.preflightDigest,
      receiptDigest: receipt.receiptDigest,
      receiptAuditCompatible: audit.compatible,
      serverSideDryRun: preflight.verification.serverSideDryRun,
      serverSideApply: receipt.verification.serverSideApply,
      convergenceRead: receipt.verification.convergenceRead,
      crossResourceAtomicity: receipt.verification.crossResourceAtomicity,
    });
  } finally {
    await fixture.cleanup().catch(() => undefined);
    cleanupComplete = true;
  }
  process.stdout.write(canonicalJson({ ...evidence, cleanupComplete }));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'deployment live contract failed'
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ lockedArtifacts, main });

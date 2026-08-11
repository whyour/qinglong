#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SELECTION_DIRECTORY =
  'deploy/kubernetes/ql3-cluster/operators/cert-manager';
const BARMAN_LOCK =
  'deploy/kubernetes/ql3-cluster/operators/barman-cloud/plugin-lock.json';
const RELEASE_BLOCKERS = Object.freeze([
  'live-cert-manager-api-and-plugin-mtls-rotation-evidence',
]);
const RELEASE_MANIFEST_SHA256 =
  '7ee74ba06845213e96d8ceaff3d20dd51e682765c1418eddda4e8780ba082261';
const IMAGES = Object.freeze([
  Object.freeze({
    name: 'controller',
    manifestReference: 'quay.io/jetstack/cert-manager-controller:v1.20.3',
    image:
      'quay.io/jetstack/cert-manager-controller:v1.20.3@sha256:6c13d61e0348a5bc3477f8ea9a928624300b30d19b1c72a7d2b90372fc713db4',
    platforms: Object.freeze({
      'linux/amd64':
        'sha256:1e4af57beb469cc3bb0fb48b9201caea2723819b9ffd3c3ea98568f55b4dd38b',
      'linux/arm64':
        'sha256:af62a025ae4f8fd03209b5e0760868296bad5a9370aab0c91ad3b5476bcb282d',
    }),
  }),
  Object.freeze({
    name: 'cainjector',
    manifestReference: 'quay.io/jetstack/cert-manager-cainjector:v1.20.3',
    image:
      'quay.io/jetstack/cert-manager-cainjector:v1.20.3@sha256:06ad347fe0dc2eb84cc355c26f6752e05e87dceb6447f5cd29b963dd66dfd8bd',
    platforms: Object.freeze({
      'linux/amd64':
        'sha256:a2b12d27950d1603d2c8168c3ccd95d07b93ce6ec4b530316196a31db592a9c0',
      'linux/arm64':
        'sha256:3c052c134ad1b93122b957f4d214aaa9d85a37b5ff15acc5b4d86f50e3ed822e',
    }),
  }),
  Object.freeze({
    name: 'webhook',
    manifestReference: 'quay.io/jetstack/cert-manager-webhook:v1.20.3',
    image:
      'quay.io/jetstack/cert-manager-webhook:v1.20.3@sha256:a61e817632cebed3bb59a189327e786fa3fdd7597167d994a1848d98fd55848f',
    platforms: Object.freeze({
      'linux/amd64':
        'sha256:953a97df613f7da7eda8ce4b1c8d8e6b50963db0800fab595d040db6eb5cb060',
      'linux/arm64':
        'sha256:7c510875e038f79f7fba707b5f86d8736777a4dfefcd42179b08844ee75e685b',
    }),
  }),
]);

function finding(code, detail) {
  return Object.freeze({ code, detail });
}

function exactJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function auditCertManagerSelection(options = {}) {
  const root = path.resolve(options.root ?? path.join(__dirname, '..'));
  const readFile = options.readFile ?? fs.readFileSync;
  const readDirectory = options.readDirectory ?? fs.readdirSync;
  const findings = [];

  try {
    const directory = path.join(root, SELECTION_DIRECTORY);
    const entries = [...readDirectory(directory)].sort();
    if (!exactJson(entries, ['selection-lock.json'])) {
      findings.push(
        finding(
          'QL3_CERT_MANAGER_INSTALLER_UNVERIFIED',
          'the selection directory must remain a lock-only input; installers are fetched and digest verified at deployment time',
        ),
      );
    }

    const selection = JSON.parse(
      readFile(path.join(directory, 'selection-lock.json'), 'utf8'),
    );
    if (
      selection?.schemaVersion !== 1 ||
      selection?.observedAt !== '2026-08-03' ||
      selection?.certManager?.version !== '1.20.3' ||
      selection?.certManager?.releaseManifest !==
        'https://github.com/cert-manager/cert-manager/releases/download/v1.20.3/cert-manager.yaml' ||
      selection?.certManager?.status !== 'supply-chain-verified'
    ) {
      findings.push(
        finding(
          'QL3_CERT_MANAGER_SELECTION',
          'cert-manager must remain fixed to the reviewed v1.20.3 selection until a new Kubernetes compatibility review',
        ),
      );
    }
    if (
      selection?.compatibility?.reviewedKubernetes !== '1.32.8' ||
      selection?.compatibility?.supportedKubernetesMin !== '1.32' ||
      selection?.compatibility?.supportedKubernetesMax !== '1.35' ||
      selection?.compatibility?.newerMinorRejected !==
        '1.21.0 requires Kubernetes 1.33 or newer'
    ) {
      findings.push(
        finding(
          'QL3_CERT_MANAGER_KUBERNETES_COMPATIBILITY',
          'the certificate controller selection must stay compatible with the locked Kubernetes 1.32.8 live gate',
        ),
      );
    }
    if (
      selection?.certManager?.releaseManifestSha256 !==
        RELEASE_MANIFEST_SHA256 ||
      !exactJson(selection?.certManager?.images, IMAGES) ||
      selection?.releaseReady !== false ||
      !exactJson(selection?.releaseBlockers, RELEASE_BLOCKERS)
    ) {
      findings.push(
        finding(
          'QL3_CERT_MANAGER_PREMATURE_RELEASE',
          'the exact release SHA and OCI platform digests must stay locked while live API and rotation evidence remains an explicit release blocker',
        ),
      );
    }
    if (
      selection?.scope?.profile !== 'cluster-only' ||
      selection?.scope?.installNamespace !== 'cert-manager' ||
      selection?.scope?.consumerNamespace !== 'cnpg-system' ||
      selection?.scope?.requiredBy !== 'barman-cloud.cloudnative-pg.io@0.13.0'
    ) {
      findings.push(
        finding(
          'QL3_CERT_MANAGER_SCOPE',
          'cert-manager must remain cluster-only and separate from the Barman plugin namespace',
        ),
      );
    }

    const pluginTls = selection?.pluginTls;
    const certificates = pluginTls?.certificates;
    if (
      !exactJson(pluginTls?.issuer, {
        apiVersion: 'cert-manager.io/v1',
        kind: 'Issuer',
        name: 'selfsigned-issuer',
        namespace: 'cnpg-system',
        type: 'SelfSigned',
      }) ||
      !exactJson(certificates, [
        {
          name: 'barman-cloud-client',
          secretName: 'barman-cloud-client-tls',
          commonName: 'barman-cloud-client',
          usages: ['client auth'],
          duration: '2160h',
          renewBefore: '360h',
        },
        {
          name: 'barman-cloud-server',
          secretName: 'barman-cloud-server-tls',
          commonName: 'barman-cloud',
          dnsNames: ['barman-cloud'],
          usages: ['server auth'],
          duration: '2160h',
          renewBefore: '360h',
        },
      ])
    ) {
      findings.push(
        finding(
          'QL3_CERT_MANAGER_PLUGIN_TLS',
          'the Barman client/server certificate identities, usages and rotation window must match the reviewed release contract',
        ),
      );
    }

    const barman = JSON.parse(readFile(path.join(root, BARMAN_LOCK), 'utf8'));
    if (
      !exactJson(barman?.certificateAuthority, {
        mode: 'cert-manager',
        version: '1.20.3',
        selectionLock:
          'deploy/kubernetes/ql3-cluster/operators/cert-manager/selection-lock.json',
        releaseManifestUses: 'cert-manager.io/v1',
        requiredSecrets: ['barman-cloud-client-tls', 'barman-cloud-server-tls'],
        status: 'supply-chain-verified',
      })
    ) {
      findings.push(
        finding(
          'QL3_CERT_MANAGER_BARMAN_BINDING',
          'the Barman candidate must bind the exact supply-chain-verified certificate authority without claiming live readiness',
        ),
      );
    }
  } catch (error) {
    findings.push(
      finding(
        'QL3_CERT_MANAGER_SELECTION_AUDIT_UNAVAILABLE',
        error instanceof Error ? error.message : 'unknown audit failure',
      ),
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    certManagerVersion: '1.20.3',
    kubernetesVersion: '1.32.8',
    releaseReady: false,
    releaseBlockers: RELEASE_BLOCKERS,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

if (require.main === module) {
  const report = auditCertManagerSelection();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = {
  auditCertManagerSelection,
};

#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOCK_DIRECTORY = 'deploy/kubernetes/ql3-cluster/operators/barman-cloud';
const RELEASE_MANIFEST =
  'https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.13.0/manifest.yaml';
const RELEASE_MANIFEST_SHA256 =
  'd2e71e7b06822448f1a421f05781846cfdb9cc621e7ef32eef5e20c5133213b0';
const RELEASE_BLOCKERS = Object.freeze([
  'live-object-store-backup-wal-latest-restore-pitr-evidence',
]);
const CONTROLLER = Object.freeze({
  manifestReference: 'ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.13.0',
  image:
    'ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.13.0@sha256:71589dbac582333442812b07b31f7ea4d00324a8358aac7ca507dabf9f4b6c96',
  platforms: Object.freeze({
    'linux/amd64':
      'sha256:417449fe4f6f0a56acdeb30e4131930815f2b46b9afeb808059b57aa8b4c2ef5',
    'linux/arm64':
      'sha256:de612e3ad8633a198b91ffbea53848407424155daf2183d656490d843a83b100',
  }),
});
const SIDECAR = Object.freeze({
  manifestReference:
    'ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.13.0',
  image:
    'ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.13.0@sha256:990361af3319f9e23aafa0f6d7981f99bf1f69b4e6a85cf1bc7d71d6f09bb288',
  platforms: Object.freeze({
    'linux/amd64':
      'sha256:15cb1a01e7c5235eedac2061cab8208e5f7c39dbda292f9c2d4ddaa0c1f211e6',
    'linux/arm64':
      'sha256:f53e168e341661cd76334215ead9dfd69f06117685d3232206192cf25218da71',
  }),
});

function finding(code, detail) {
  return Object.freeze({ code, detail });
}

function exactJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function auditBarmanCloudSupplyChain(options = {}) {
  const root = path.resolve(options.root ?? path.join(__dirname, '..'));
  const readFile = options.readFile ?? fs.readFileSync;
  const readDirectory = options.readDirectory ?? fs.readdirSync;
  const findings = [];

  try {
    const directory = path.join(root, LOCK_DIRECTORY);
    const entries = [...readDirectory(directory)].sort();
    if (!exactJson(entries, ['plugin-lock.json'])) {
      findings.push(
        finding(
          'QL3_BARMAN_INSTALLER_UNREVIEWED',
          'the candidate lock directory must not contain an install manifest before the certificate authority and image rewrite are reviewed',
        ),
      );
    }

    const lock = JSON.parse(
      readFile(path.join(directory, 'plugin-lock.json'), 'utf8'),
    );
    if (
      lock?.schemaVersion !== 1 ||
      lock?.observedAt !== '2026-08-03' ||
      lock?.plugin?.name !== 'barman-cloud.cloudnative-pg.io' ||
      lock?.plugin?.version !== '0.13.0' ||
      lock?.compatibility?.cloudNativePg !== '>=1.26.0' ||
      lock?.compatibility?.reviewedCloudNativePg !== '1.30.0'
    ) {
      findings.push(
        finding(
          'QL3_BARMAN_LOCK_ENVELOPE',
          'the plugin candidate must stay bound to the reviewed Barman and CloudNativePG versions',
        ),
      );
    }
    if (
      lock?.plugin?.releaseManifest !== RELEASE_MANIFEST ||
      lock?.plugin?.releaseManifestSha256 !== RELEASE_MANIFEST_SHA256
    ) {
      findings.push(
        finding(
          'QL3_BARMAN_RELEASE_ASSET',
          'the official release manifest URL and observed SHA-256 must be exact',
        ),
      );
    }
    if (!exactJson(lock?.plugin?.controller, CONTROLLER)) {
      findings.push(
        finding(
          'QL3_BARMAN_CONTROLLER_IMAGE',
          'the controller index and native amd64/arm64 manifests must remain digest locked',
        ),
      );
    }
    if (!exactJson(lock?.plugin?.sidecar, SIDECAR)) {
      findings.push(
        finding(
          'QL3_BARMAN_SIDECAR_IMAGE',
          'the PostgreSQL sidecar index and native amd64/arm64 manifests must remain digest locked',
        ),
      );
    }
    if (
      lock?.certificateAuthority?.mode !== 'cert-manager' ||
      lock?.certificateAuthority?.version !== '1.20.3' ||
      lock?.certificateAuthority?.selectionLock !==
        'deploy/kubernetes/ql3-cluster/operators/cert-manager/selection-lock.json' ||
      lock?.certificateAuthority?.releaseManifestUses !==
        'cert-manager.io/v1' ||
      !exactJson(lock?.certificateAuthority?.requiredSecrets, [
        'barman-cloud-client-tls',
        'barman-cloud-server-tls',
      ]) ||
      lock?.certificateAuthority?.status !== 'supply-chain-verified'
    ) {
      findings.push(
        finding(
          'QL3_BARMAN_CERTIFICATE_GATE',
          'the certificate authority dependency must remain supply-chain locked while live readiness fails closed independently',
        ),
      );
    }
    if (
      lock?.releaseReady !== false ||
      !exactJson(lock?.releaseBlockers, RELEASE_BLOCKERS)
    ) {
      findings.push(
        finding(
          'QL3_BARMAN_PREMATURE_RELEASE',
          'the candidate lock cannot become release-ready before certificate supply-chain and live restore evidence exist',
        ),
      );
    }
  } catch (error) {
    findings.push(
      finding(
        'QL3_BARMAN_SUPPLY_CHAIN_AUDIT_UNAVAILABLE',
        error instanceof Error ? error.message : 'unknown audit failure',
      ),
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    pluginVersion: '0.13.0',
    controller: CONTROLLER.image,
    sidecar: SIDECAR.image,
    releaseReady: false,
    releaseBlockers: RELEASE_BLOCKERS,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

if (require.main === module) {
  const report = auditBarmanCloudSupplyChain();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = {
  auditBarmanCloudSupplyChain,
};

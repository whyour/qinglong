#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const COMPONENT_DIRECTORY =
  'deploy/kubernetes/ql3-cluster/components/barman-cloud-backup';
const RESTORE_DIRECTORY =
  'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg-restore';
const PLUGIN_NAME = 'barman-cloud.cloudnative-pg.io';
const BACKUP_OBJECT_STORE = 'ql3-postgres-backup';
const RECOVERY_OBJECT_STORE = 'ql3-postgres-recovery-source';
const POSTGRES_IMAGE =
  'ghcr.io/cloudnative-pg/postgresql:18.4-minimal-trixie@sha256:24d229d801663f95b584416f8ebdfad4849b1a3fa4cfcf95a7f026df7aa6e22d';

function finding(code, detail) {
  return Object.freeze({ code, detail });
}

function readYaml(readFile, root, relativePath) {
  return yaml.load(readFile(path.join(root, relativePath), 'utf8'));
}

function exactPlugin(plugin, objectStore) {
  return (
    plugin?.name === PLUGIN_NAME &&
    plugin?.isWALArchiver === true &&
    plugin?.parameters?.barmanObjectName === objectStore &&
    Object.keys(plugin.parameters).length === 1
  );
}

function exactRecoveryPlugin(plugin) {
  return (
    plugin?.name === PLUGIN_NAME &&
    plugin?.parameters?.barmanObjectName === RECOVERY_OBJECT_STORE &&
    plugin?.parameters?.serverName === 'ql3-postgres' &&
    Object.keys(plugin.parameters).length === 2
  );
}

function assertComponent(readFile, root, findings) {
  const kustomization = readYaml(
    readFile,
    root,
    `${COMPONENT_DIRECTORY}/kustomization.yaml`,
  );
  if (
    kustomization?.apiVersion !== 'kustomize.config.k8s.io/v1alpha1' ||
    kustomization?.kind !== 'Component' ||
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(['scheduled-backup.yaml']) ||
    JSON.stringify(kustomization?.patches) !==
      JSON.stringify([{ path: 'cluster-plugin-patch.yaml' }])
  ) {
    findings.push(
      finding(
        'QL3_CNPG_BACKUP_COMPONENT',
        'the backup capability must remain an explicit cluster-only Kustomize Component',
      ),
    );
  }
  const serialized = JSON.stringify(kustomization);
  if (
    serialized.includes('object-store') ||
    serialized.includes('private-overlay')
  ) {
    findings.push(
      finding(
        'QL3_CNPG_BACKUP_PRIVATE_INPUT',
        'provider ObjectStore examples and private overlays must never be applied by the shared Component',
      ),
    );
  }
}

function assertWalAndSchedule(readFile, root, findings) {
  const patch = readYaml(
    readFile,
    root,
    `${COMPONENT_DIRECTORY}/cluster-plugin-patch.yaml`,
  );
  if (
    patch?.apiVersion !== 'postgresql.cnpg.io/v1' ||
    patch?.kind !== 'Cluster' ||
    patch?.metadata?.name !== 'ql3-postgres' ||
    patch?.spec?.plugins?.length !== 1 ||
    !exactPlugin(patch.spec.plugins[0], BACKUP_OBJECT_STORE) ||
    patch?.spec?.backup !== undefined
  ) {
    findings.push(
      finding(
        'QL3_CNPG_WAL_ARCHIVER',
        'the source cluster must use exactly one CNPG-I Barman WAL archiver and no deprecated in-tree backup',
      ),
    );
  }

  const schedule = readYaml(
    readFile,
    root,
    `${COMPONENT_DIRECTORY}/scheduled-backup.yaml`,
  );
  if (
    schedule?.apiVersion !== 'postgresql.cnpg.io/v1' ||
    schedule?.kind !== 'ScheduledBackup' ||
    schedule?.metadata?.name !== 'ql3-postgres-daily' ||
    schedule?.metadata?.namespace !== 'qinglong3-system' ||
    schedule?.spec?.schedule !== '0 0 0 * * *' ||
    schedule?.spec?.backupOwnerReference !== 'self' ||
    schedule?.spec?.immediate !== false ||
    schedule?.spec?.suspend !== false ||
    schedule?.spec?.target !== 'prefer-standby' ||
    schedule?.spec?.cluster?.name !== 'ql3-postgres' ||
    schedule?.spec?.method !== 'plugin' ||
    schedule?.spec?.pluginConfiguration?.name !== PLUGIN_NAME ||
    Object.keys(schedule?.spec?.pluginConfiguration || {}).length !== 1
  ) {
    findings.push(
      finding(
        'QL3_CNPG_BASE_BACKUP_SCHEDULE',
        'daily standby-preferred base backups must use the CNPG-I plugin explicitly',
      ),
    );
  }
}

function assertObjectStoreExample(readFile, root, findings) {
  const objectStore = readYaml(
    readFile,
    root,
    `${COMPONENT_DIRECTORY}/object-store.s3.example.yaml`,
  );
  const configuration = objectStore?.spec?.configuration;
  if (
    objectStore?.apiVersion !== 'barmancloud.cnpg.io/v1' ||
    objectStore?.kind !== 'ObjectStore' ||
    objectStore?.metadata?.name !== BACKUP_OBJECT_STORE ||
    objectStore?.metadata?.namespace !== 'qinglong3-system' ||
    objectStore?.spec?.retentionPolicy !== '30d' ||
    !configuration?.destinationPath?.startsWith(
      's3://REPLACE_WITH_VERSIONED_LOCKED_BUCKET/',
    ) ||
    !configuration?.endpointURL?.startsWith('https://REPLACE_WITH_') ||
    configuration?.s3Credentials?.accessKeyId?.name !==
      'ql3-postgres-backup-object-store' ||
    configuration?.s3Credentials?.accessKeyId?.key !== 'ACCESS_KEY_ID' ||
    configuration?.s3Credentials?.secretAccessKey?.name !==
      'ql3-postgres-backup-object-store' ||
    configuration?.s3Credentials?.secretAccessKey?.key !==
      'ACCESS_SECRET_KEY' ||
    configuration?.wal?.compression !== 'lz4' ||
    configuration?.wal?.encryption !== 'AES256' ||
    configuration?.wal?.maxParallel !== 2 ||
    configuration?.data?.compression !== 'lz4' ||
    configuration?.data?.encryption !== 'AES256'
  ) {
    findings.push(
      finding(
        'QL3_CNPG_OBJECT_STORE_CONTRACT',
        'the private ObjectStore schema must require HTTPS, placeholders, retention, encryption and bounded compression/concurrency',
      ),
    );
  }
  if (
    JSON.stringify(objectStore).includes('REPLACE_WITH_SECRET_MANAGER_VALUE') ||
    objectStore?.stringData ||
    objectStore?.data
  ) {
    findings.push(
      finding(
        'QL3_CNPG_OBJECT_STORE_SECRET_BOUNDARY',
        'the ObjectStore example may reference credentials but must not contain secret material',
      ),
    );
  }
}

function assertRestore(readFile, root, findings) {
  const kustomization = readYaml(
    readFile,
    root,
    `${RESTORE_DIRECTORY}/kustomization.yaml`,
  );
  if (
    kustomization?.kind !== 'Kustomization' ||
    kustomization?.namespace !== 'qinglong3-system' ||
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(['restore-cluster.yaml'])
  ) {
    findings.push(
      finding(
        'QL3_CNPG_RESTORE_OPERATION',
        'restore must remain a separate explicit operation with no provider ObjectStore example applied',
      ),
    );
  }

  const cluster = readYaml(
    readFile,
    root,
    `${RESTORE_DIRECTORY}/restore-cluster.yaml`,
  );
  const spec = cluster?.spec;
  const origin = spec?.externalClusters?.[0];
  if (
    cluster?.apiVersion !== 'postgresql.cnpg.io/v1' ||
    cluster?.kind !== 'Cluster' ||
    cluster?.metadata?.name !== 'ql3-postgres-restore' ||
    cluster?.metadata?.annotations?.['cnpg.io/skipEmptyWalArchiveCheck'] !==
      undefined ||
    spec?.instances !== 3 ||
    spec?.imageName !== POSTGRES_IMAGE ||
    spec?.enableSuperuserAccess !== false ||
    spec?.bootstrap?.recovery?.source !== 'ql3-postgres-origin' ||
    Object.keys(spec?.bootstrap?.recovery || {}).length !== 1 ||
    spec?.externalClusters?.length !== 1 ||
    origin?.name !== 'ql3-postgres-origin' ||
    !exactRecoveryPlugin(origin?.plugin) ||
    spec?.plugins !== undefined
  ) {
    findings.push(
      finding(
        'QL3_CNPG_RESTORE_ISOLATION',
        'recovery must bootstrap a distinct digest-pinned cluster from a read-only source without archive-check bypass or source-store writes',
      ),
    );
  }
  if (
    spec?.postgresql?.parameters?.synchronous_commit !== 'remote_apply' ||
    spec?.postgresql?.synchronous?.method !== 'any' ||
    spec?.postgresql?.synchronous?.number !== 1 ||
    spec?.postgresql?.synchronous?.dataDurability !== 'required' ||
    spec?.postgresql?.synchronous?.failoverQuorum !== true ||
    spec?.affinity?.podAntiAffinityType !== 'required' ||
    spec?.affinity?.topologyKey !== 'kubernetes.io/hostname' ||
    JSON.stringify(spec?.managed?.services?.disabledDefaultServices) !==
      JSON.stringify(['r', 'ro'])
  ) {
    findings.push(
      finding(
        'QL3_CNPG_RESTORE_HA',
        'the restored cluster must re-enter the reviewed three-node synchronous HA envelope',
      ),
    );
  }

  const sourceStore = readYaml(
    readFile,
    root,
    `${RESTORE_DIRECTORY}/object-store.s3.example.yaml`,
  );
  const sourceConfiguration = sourceStore?.spec?.configuration;
  if (
    sourceStore?.metadata?.name !== RECOVERY_OBJECT_STORE ||
    sourceConfiguration?.s3Credentials?.accessKeyId?.name !==
      'ql3-postgres-restore-object-store' ||
    sourceConfiguration?.s3Credentials?.secretAccessKey?.name !==
      'ql3-postgres-restore-object-store' ||
    sourceConfiguration?.wal?.maxParallel !== 4 ||
    sourceConfiguration?.serverName !== undefined ||
    sourceStore?.spec?.retentionPolicy !== undefined ||
    sourceConfiguration?.data !== undefined
  ) {
    findings.push(
      finding(
        'QL3_CNPG_RECOVERY_SOURCE',
        'the recovery ObjectStore must use a distinct credential authority and remain excluded from retention/write policy',
      ),
    );
  }
}

function auditCloudNativePgBackup(options = {}) {
  const root = path.resolve(options.root ?? path.join(__dirname, '..'));
  const readFile = options.readFile ?? fs.readFileSync;
  const findings = [];
  try {
    assertComponent(readFile, root, findings);
    assertWalAndSchedule(readFile, root, findings);
    assertObjectStoreExample(readFile, root, findings);
    assertRestore(readFile, root, findings);
  } catch (error) {
    findings.push(
      finding(
        'QL3_CNPG_BACKUP_AUDIT_UNAVAILABLE',
        error instanceof Error ? error.message : 'unknown audit failure',
      ),
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    plugin: PLUGIN_NAME,
    sourceCluster: 'ql3-postgres',
    restoreCluster: 'ql3-postgres-restore',
    baseBackupSchedule: '0 0 0 * * *',
    retentionPolicy: '30d',
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

if (require.main === module) {
  const report = auditCloudNativePgBackup();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = {
  BACKUP_OBJECT_STORE,
  PLUGIN_NAME,
  RECOVERY_OBJECT_STORE,
  auditCloudNativePgBackup,
};

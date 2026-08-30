import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { currentIdentity } from '../foundation/contract';
import { LocalDeploymentConfigurationError } from '../foundation/error';
import {
  ensurePrivateDirectory,
  preflightPublishedFile,
  publishExactFile,
  validatePrivateDirectory,
} from '../foundation/files';
import {
  normalizeLocalDeploymentAdoptedBundleCommand,
  type LocalDeploymentAdoptedBundleCommand,
  type LocalDeploymentAdoptedBundleOperation,
} from './contract';
import {
  renderLocalDeploymentAdoptedBundleMaterial,
  verifyLocalDeploymentAdoptedEvidence,
} from './material';

export interface LocalDeploymentAdoptedBundleResult {
  readonly schemaVersion: 1;
  readonly operation: LocalDeploymentAdoptedBundleOperation;
  readonly status: 'prepared' | 'existing' | 'verified';
  readonly bundleId: string;
  readonly bundleDigest: string;
  readonly profile: 'edge' | 'standalone';
  readonly service: Readonly<{
    kind: 'systemd' | 'openrc' | 'compose' | 'docker-target';
    status: 'prepared' | 'existing' | 'verified';
  }>;
  readonly applicationConfiguration: Readonly<{
    schema: 'qinglong/local-application-process@v4';
    status: 'prepared' | 'existing' | 'verified';
  }>;
  readonly directories: Readonly<{
    created: number;
    existing: number;
  }>;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function validatePrivateFile(
  filePath: string,
  uid: number,
  gid: number,
  label: string,
): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      stat.gid !== gid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size < 2 ||
      fs.realpathSync(filePath) !== filePath
    ) {
      configurationError(`${label} identity is invalid`);
    }
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    configurationError(`${label} is unavailable`, error);
  }
}

function stagePath(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.ql3-deploy-stage`,
  );
}

function verifyPublishedFile(
  filePath: string,
  expected: string,
  mode: number,
  uid: number,
  gid: number,
  label: string,
): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      stat.gid !== gid ||
      (stat.mode & 0o777) !== mode ||
      stat.nlink !== 1 ||
      stat.size !== Buffer.byteLength(expected, 'utf8') ||
      fs.realpathSync(filePath) !== filePath ||
      fs.existsSync(stagePath(filePath)) ||
      fs.readFileSync(filePath, 'utf8') !== expected
    ) {
      configurationError(`${label} terminal material drifted`);
    }
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    configurationError(`${label} cannot be verified`, error);
  }
}

function rejectAlternateDescriptors(
  selectedPath: string,
  serviceRoot: string,
): void {
  for (const fileName of [
    'qinglong3.service',
    'qinglong3.openrc',
    'compose.yaml',
    'docker-target.json',
  ]) {
    const candidate = path.join(serviceRoot, fileName);
    if (candidate !== selectedPath && fs.existsSync(candidate)) {
      configurationError('an alternate service descriptor already exists');
    }
  }
}

function validateExistingPrerequisites(
  root: string,
  serviceRoot: string,
  ownerPepperKeyring: string,
  ownerPepperBackup: string,
  secretKeyring: string,
  commitmentRoot: string,
  uid: number,
  gid: number,
): void {
  validatePrivateDirectory(root, uid, 'deploymentRoot');
  validatePrivateDirectory(
    ownerPepperKeyring,
    uid,
    'ownerPepperKeyringDirectory',
  );
  validatePrivateDirectory(
    ownerPepperBackup,
    uid,
    'ownerPepperBackupDirectory',
  );
  validatePrivateDirectory(serviceRoot, uid, 'serviceDescriptorRoot');
  validatePrivateDirectory(
    path.join(serviceRoot, 'cutovers'),
    uid,
    'cutoverRoot',
  );
  validatePrivateDirectory(commitmentRoot, uid, 'cutoverJournalRoot');
  validatePrivateFile(secretKeyring, uid, gid, 'localSecretKeyring');
}

export function prepareLocalDeploymentAdoptedBundle(
  input: unknown,
): Readonly<LocalDeploymentAdoptedBundleResult> {
  const command = normalizeLocalDeploymentAdoptedBundleCommand(
    input,
    'local.deployment.adopted.prepare',
  );
  const identity = currentIdentity();
  const evidence = verifyLocalDeploymentAdoptedEvidence(
    command,
    identity.uid,
    identity.gid,
  );
  const material = renderLocalDeploymentAdoptedBundleMaterial(
    command,
    evidence,
    identity.uid,
    identity.gid,
  );
  validateExistingPrerequisites(
    command.options.deploymentRoot,
    material.paths.service,
    material.paths.ownerPepperKeyring,
    material.paths.ownerPepperBackup,
    material.paths.secretKeyring,
    path.dirname(command.request.cutover.commitmentPath),
    identity.uid,
    identity.gid,
  );
  rejectAlternateDescriptors(material.paths.descriptor, material.paths.service);
  if (
    command.options.service.kind !== 'compose' &&
    (fs.existsSync(material.paths.composeSelection) ||
      fs.existsSync(material.paths.composeRevisions))
  ) {
    configurationError('process service cannot inherit Compose material');
  }
  preflightPublishedFile(
    material.paths.applicationConfig,
    material.applicationConfig,
    0o600,
    identity.uid,
    'adopted application configuration',
  );
  preflightPublishedFile(
    material.paths.descriptor,
    material.descriptor.contents,
    material.descriptor.mode,
    identity.uid,
    'adopted service descriptor',
  );
  preflightPublishedFile(
    material.paths.bundleReceipt,
    material.receiptContents,
    0o600,
    identity.uid,
    'adopted bundle receipt',
  );
  if (material.targetBaseline !== null) {
    preflightPublishedFile(
      material.paths.targetBaseline,
      material.targetBaseline,
      0o600,
      identity.uid,
      'adopted target baseline',
    );
  } else if (fs.existsSync(material.paths.targetBaseline)) {
    configurationError('process service cannot inherit a target baseline');
  }
  if (material.composeSelection !== null) {
    preflightPublishedFile(
      material.paths.composeRevision,
      material.composeSelection,
      0o600,
      identity.uid,
      'initial adopted compose revision',
    );
    preflightPublishedFile(
      material.paths.composeSelection,
      material.composeSelection,
      0o600,
      identity.uid,
      'active adopted compose selection',
    );
  }
  const directoryPaths = [
    [material.paths.receipts, 'receiptRoot'],
    [material.paths.artifacts, 'artifactRoot'],
    [material.paths.pluginStaging, 'pluginStagingRoot'],
    [material.paths.pluginActivation, 'pluginActivationRoot'],
    ...(material.composeSelection === null
      ? []
      : ([
          [material.paths.composeRevisions, 'composeRevisionRoot'],
          [material.paths.composeRollouts, 'composeRolloutRoot'],
          [material.paths.composeRolloutBackups, 'composeRolloutBackupRoot'],
          [material.paths.composeRestores, 'composeRestoreRoot'],
          [
            material.paths.composeRestoreSafeguards,
            'composeRestoreSafeguardRoot',
          ],
          [
            material.paths.composeEvidenceCollections,
            'composeEvidenceCollectionRoot',
          ],
          [
            material.paths.composeCollectedEvidence,
            'composeCollectedEvidenceRoot',
          ],
          [
            material.paths.composeCollectedRolloutBackups,
            'composeCollectedRolloutBackupRoot',
          ],
          [
            material.paths.composeCollectedRestoreSafeguards,
            'composeCollectedRestoreSafeguardRoot',
          ],
        ] as const)),
  ] as const;
  const directoryStatuses = directoryPaths.map(([directory, label]) =>
    ensurePrivateDirectory(directory, identity.uid, label),
  );
  const applicationStatus = publishExactFile(
    material.paths.applicationConfig,
    material.applicationConfig,
    0o600,
    identity.uid,
    'adopted application configuration',
  );
  const serviceStatus = publishExactFile(
    material.paths.descriptor,
    material.descriptor.contents,
    material.descriptor.mode,
    identity.uid,
    'adopted service descriptor',
  );
  const composeRevisionStatus =
    material.composeSelection === null
      ? 'existing'
      : publishExactFile(
          material.paths.composeRevision,
          material.composeSelection,
          0o600,
          identity.uid,
          'initial adopted compose revision',
        );
  const composeSelectionStatus =
    material.composeSelection === null
      ? 'existing'
      : publishExactFile(
          material.paths.composeSelection,
          material.composeSelection,
          0o600,
          identity.uid,
          'active adopted compose selection',
        );
  const receiptStatus = publishExactFile(
    material.paths.bundleReceipt,
    material.receiptContents,
    0o600,
    identity.uid,
    'adopted bundle receipt',
  );
  const baselineStatus =
    material.targetBaseline === null
      ? 'existing'
      : publishExactFile(
          material.paths.targetBaseline,
          material.targetBaseline,
          0o600,
          identity.uid,
          'adopted target baseline',
        );
  const createdDirectories = directoryStatuses.filter(
    (status) => status === 'prepared',
  ).length;
  const prepared =
    createdDirectories > 0 ||
    applicationStatus === 'prepared' ||
    serviceStatus === 'prepared' ||
    composeRevisionStatus === 'prepared' ||
    composeSelectionStatus === 'prepared' ||
    baselineStatus === 'prepared' ||
    receiptStatus === 'prepared';
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.adopted.prepare' as const,
    status: prepared ? ('prepared' as const) : ('existing' as const),
    bundleId: command.request.bundleId,
    bundleDigest: material.receipt.bundleDigest,
    profile: command.options.profile,
    service: Object.freeze({
      kind: command.options.service.kind,
      status: serviceStatus,
    }),
    applicationConfiguration: Object.freeze({
      schema: 'qinglong/local-application-process@v4' as const,
      status: applicationStatus,
    }),
    directories: Object.freeze({
      created: createdDirectories,
      existing: directoryStatuses.length - createdDirectories,
    }),
  });
}

export function verifyLocalDeploymentAdoptedBundle(
  input: unknown,
): Readonly<LocalDeploymentAdoptedBundleResult> {
  const command = normalizeLocalDeploymentAdoptedBundleCommand(
    input,
    'local.deployment.adopted.verify',
  );
  const identity = currentIdentity();
  const evidence = verifyLocalDeploymentAdoptedEvidence(
    command,
    identity.uid,
    identity.gid,
  );
  const material = renderLocalDeploymentAdoptedBundleMaterial(
    command,
    evidence,
    identity.uid,
    identity.gid,
  );
  validateExistingPrerequisites(
    command.options.deploymentRoot,
    material.paths.service,
    material.paths.ownerPepperKeyring,
    material.paths.ownerPepperBackup,
    material.paths.secretKeyring,
    path.dirname(command.request.cutover.commitmentPath),
    identity.uid,
    identity.gid,
  );
  rejectAlternateDescriptors(material.paths.descriptor, material.paths.service);
  for (const [directory, label] of [
    [material.paths.receipts, 'receiptRoot'],
    [material.paths.artifacts, 'artifactRoot'],
    [material.paths.pluginStaging, 'pluginStagingRoot'],
    [material.paths.pluginActivation, 'pluginActivationRoot'],
    ...(material.composeSelection === null
      ? []
      : ([
          [material.paths.composeRevisions, 'composeRevisionRoot'],
          [material.paths.composeRollouts, 'composeRolloutRoot'],
          [material.paths.composeRolloutBackups, 'composeRolloutBackupRoot'],
          [material.paths.composeRestores, 'composeRestoreRoot'],
          [
            material.paths.composeRestoreSafeguards,
            'composeRestoreSafeguardRoot',
          ],
          [
            material.paths.composeEvidenceCollections,
            'composeEvidenceCollectionRoot',
          ],
          [
            material.paths.composeCollectedEvidence,
            'composeCollectedEvidenceRoot',
          ],
          [
            material.paths.composeCollectedRolloutBackups,
            'composeCollectedRolloutBackupRoot',
          ],
          [
            material.paths.composeCollectedRestoreSafeguards,
            'composeCollectedRestoreSafeguardRoot',
          ],
        ] as const)),
  ] as const) {
    validatePrivateDirectory(directory, identity.uid, label);
  }
  verifyPublishedFile(
    material.paths.applicationConfig,
    material.applicationConfig,
    0o600,
    identity.uid,
    identity.gid,
    'adopted application configuration',
  );
  verifyPublishedFile(
    material.paths.descriptor,
    material.descriptor.contents,
    material.descriptor.mode,
    identity.uid,
    identity.gid,
    'adopted service descriptor',
  );
  verifyPublishedFile(
    material.paths.bundleReceipt,
    material.receiptContents,
    0o600,
    identity.uid,
    identity.gid,
    'adopted bundle receipt',
  );
  if (material.targetBaseline !== null) {
    verifyPublishedFile(
      material.paths.targetBaseline,
      material.targetBaseline,
      0o600,
      identity.uid,
      identity.gid,
      'adopted target baseline',
    );
  } else if (fs.existsSync(material.paths.targetBaseline)) {
    configurationError('process service cannot inherit a target baseline');
  }
  if (material.composeSelection !== null) {
    verifyPublishedFile(
      material.paths.composeRevision,
      material.composeSelection,
      0o600,
      identity.uid,
      identity.gid,
      'initial adopted compose revision',
    );
    verifyPublishedFile(
      material.paths.composeSelection,
      material.composeSelection,
      0o600,
      identity.uid,
      identity.gid,
      'active adopted compose selection',
    );
  } else if (
    fs.existsSync(material.paths.composeSelection) ||
    fs.existsSync(material.paths.composeRevisions)
  ) {
    configurationError('process service cannot inherit Compose material');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.adopted.verify' as const,
    status: 'verified' as const,
    bundleId: command.request.bundleId,
    bundleDigest: material.receipt.bundleDigest,
    profile: command.options.profile,
    service: Object.freeze({
      kind: command.options.service.kind,
      status: 'verified' as const,
    }),
    applicationConfiguration: Object.freeze({
      schema: 'qinglong/local-application-process@v4' as const,
      status: 'verified' as const,
    }),
    directories: Object.freeze({
      created: 0,
      existing: material.composeSelection === null ? 4 : 13,
    }),
  });
}

export function runLocalDeploymentAdoptedBundleCommandFile(
  filePath: string,
  operation: LocalDeploymentAdoptedBundleOperation,
): Readonly<LocalDeploymentAdoptedBundleResult> {
  const input = readPrivateLocalCommandFile(filePath);
  return operation === 'local.deployment.adopted.prepare'
    ? prepareLocalDeploymentAdoptedBundle(input)
    : verifyLocalDeploymentAdoptedBundle(input);
}

export type { LocalDeploymentAdoptedBundleCommand };

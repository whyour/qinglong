import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LocalDeploymentConfigurationError } from '../foundation/error';
import { cutoverDigest } from '../cutover/targetEvidence';
import type { LocalReconciliationCapturePrepareCommand } from './contract';

const MAX_LINEAGE_FILE_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LocalReconciliationLineageProjection {
  readonly applicationConfigDigest: string;
  readonly activationDigest: string;
  readonly adoptionManifestDigest: string;
  readonly commitmentDigest: string;
  readonly legacyDataApplicationCommitDigest: string;
  readonly legacyDataApplicationReceiptDigest: string;
  readonly adoptedBundleDigest: string;
  readonly sourceSha256: string;
  readonly targetSha256: string;
  readonly recoverySha256: string;
  readonly projectionDigest: string;
}

interface PrivateJsonMaterial {
  readonly value: unknown;
  readonly sha256: string;
}

interface LocalDataApplicationEvidence {
  readonly profile: 'edge' | 'standalone';
  readonly commitDigest: string;
  readonly receiptDigest: string;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    configurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError(`${label} shape is invalid`);
  }
}

function sameStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function privateJsonMaterial(
  filePath: string,
  uid: number,
  label: string,
): Readonly<PrivateJsonMaterial> {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const pathStat = fs.lstatSync(filePath, { bigint: true });
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !sameStat(pathStat, opened) ||
      opened.uid !== BigInt(uid) ||
      opened.nlink !== 1n ||
      (opened.mode & 0o077n) !== 0n ||
      opened.size < 2n ||
      opened.size > BigInt(MAX_LINEAGE_FILE_BYTES) ||
      fs.realpathSync(filePath) !== filePath
    ) {
      configurationError(`${label} identity is invalid`);
    }
    bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (offset !== bytes.byteLength || !sameStat(opened, after)) {
      configurationError(`${label} changed while reading`);
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
    } catch (error) {
      configurationError(`${label} is not valid UTF-8 JSON`, error);
    }
    return Object.freeze({
      value,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError(`${label} cannot be read`, error);
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function documentDigest(
  value: unknown,
  digestKey: string,
  label: string,
): Readonly<{ document: Record<string, unknown>; digest: string }> {
  const document = object(value, label);
  const claimed = document[digestKey];
  const payload = { ...document };
  delete payload[digestKey];
  if (
    typeof claimed !== 'string' ||
    !DIGEST_PATTERN.test(claimed) ||
    cutoverDigest(payload) !== claimed
  ) {
    configurationError(`${label} digest drifted`);
  }
  return Object.freeze({ document, digest: claimed });
}

function textDigest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeLocalDataApplicationEvidence(
  value: unknown,
): Readonly<LocalDataApplicationEvidence> {
  const commit = object(value, 'legacy data application commitment');
  exact(
    commit,
    [
      'commitDigest',
      'committedAtMs',
      'environmentSecretCount',
      'kind',
      'modelDigest',
      'mutationId',
      'profile',
      'projectIdDigest',
      'publicationDigest',
      'receiptDigest',
      'reclamation',
      'schemaVersion',
      'secretCount',
      'sourceStageManifestDigest',
      'sshSecretCount',
      'state',
      'transformationDigest',
    ],
    'legacy data application commitment',
  );
  const reclamation = object(
    commit.reclamation,
    'legacy data application reclamation',
  );
  exact(
    reclamation,
    ['modelRemoved', 'physicalErasureGuaranteed', 'plaintextFilesRemoved'],
    'legacy data application reclamation',
  );
  const digests = [
    commit.projectIdDigest,
    commit.sourceStageManifestDigest,
    commit.transformationDigest,
    commit.modelDigest,
    commit.publicationDigest,
    commit.receiptDigest,
  ];
  if (
    commit.schemaVersion !== 1 ||
    commit.kind !== 'qinglong3-legacy-data-directory-application' ||
    commit.state !== 'committed' ||
    typeof commit.mutationId !== 'string' ||
    !UUID_V4_PATTERN.test(commit.mutationId) ||
    (commit.profile !== 'edge' && commit.profile !== 'standalone') ||
    digests.some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    !Number.isSafeInteger(commit.secretCount) ||
    (commit.secretCount as number) < 0 ||
    !Number.isSafeInteger(commit.environmentSecretCount) ||
    (commit.environmentSecretCount as number) < 0 ||
    !Number.isSafeInteger(commit.sshSecretCount) ||
    (commit.sshSecretCount as number) < 0 ||
    (commit.secretCount as number) !==
      (commit.environmentSecretCount as number) +
        (commit.sshSecretCount as number) ||
    !Number.isSafeInteger(commit.committedAtMs) ||
    (commit.committedAtMs as number) < 0 ||
    reclamation.modelRemoved !== true ||
    reclamation.plaintextFilesRemoved !== true ||
    reclamation.physicalErasureGuaranteed !== false
  ) {
    configurationError('legacy data application commitment values are invalid');
  }
  const payload = {
    schemaVersion: 1,
    kind: 'qinglong3-legacy-data-directory-application',
    state: 'committed',
    mutationId: commit.mutationId,
    profile: commit.profile,
    projectIdDigest: commit.projectIdDigest,
    sourceStageManifestDigest: commit.sourceStageManifestDigest,
    transformationDigest: commit.transformationDigest,
    modelDigest: commit.modelDigest,
    publicationDigest: commit.publicationDigest,
    receiptDigest: commit.receiptDigest,
    secretCount: commit.secretCount,
    environmentSecretCount: commit.environmentSecretCount,
    sshSecretCount: commit.sshSecretCount,
    committedAtMs: commit.committedAtMs,
    reclamation: {
      modelRemoved: true,
      plaintextFilesRemoved: true,
      physicalErasureGuaranteed: false,
    },
  };
  if (
    typeof commit.commitDigest !== 'string' ||
    !DIGEST_PATTERN.test(commit.commitDigest) ||
    textDigest(JSON.stringify(payload)) !== commit.commitDigest
  ) {
    configurationError('legacy data application commitment digest drifted');
  }
  return Object.freeze({
    profile: commit.profile,
    commitDigest: commit.commitDigest,
    receiptDigest: commit.receiptDigest as string,
  });
}

export function proveLocalReconciliationLineage(
  command: Readonly<LocalReconciliationCapturePrepareCommand>,
  uid: number,
): Readonly<LocalReconciliationLineageProjection> {
  if (
    command.request.applicationConfigPath !==
    path.join(command.options.deploymentRoot, 'local-application.json')
  ) {
    configurationError('application configuration path is not authoritative');
  }
  const applicationMaterial = privateJsonMaterial(
    command.request.applicationConfigPath,
    uid,
    'application configuration',
  );
  const application = object(
    applicationMaterial.value,
    'application configuration',
  );
  const storage = object(application.storage, 'application storage');
  const cutover = object(application.cutover, 'application cutover');
  const dataApplication = object(
    application.legacyDataApplication,
    'legacy data application',
  );
  exact(
    dataApplication,
    ['commitPath', 'expectedCommitDigest', 'expectedReceiptDigest'],
    'legacy data application',
  );
  const commitmentPath = path.join(
    command.options.deploymentRoot,
    'service',
    'cutovers',
    command.request.cutoverId,
    '0002-legacy-stopped.json',
  );
  if (
    application.schema !== 'qinglong/local-application-process@v4' ||
    application.profile !== command.request.profile ||
    application.instanceId !== command.request.instanceId ||
    storage.mode !== 'adopted' ||
    storage.sourcePath !== command.request.legacySourcePath ||
    storage.targetPath !== command.request.targetDatabasePath ||
    storage.recoveryPath !== command.request.recoveryPath ||
    storage.activationPath !== command.request.activationPath ||
    storage.expectedActivationDigest !==
      command.request.expectedActivationDigest ||
    cutover.cutoverId !== command.request.cutoverId ||
    cutover.commitmentPath !== commitmentPath ||
    typeof cutover.expectedCommitmentDigest !== 'string' ||
    !DIGEST_PATTERN.test(cutover.expectedCommitmentDigest) ||
    typeof storage.manifestPath !== 'string' ||
    !path.isAbsolute(storage.manifestPath) ||
    path.normalize(storage.manifestPath) !== storage.manifestPath ||
    typeof dataApplication.commitPath !== 'string' ||
    !path.isAbsolute(dataApplication.commitPath) ||
    path.normalize(dataApplication.commitPath) !== dataApplication.commitPath ||
    typeof dataApplication.expectedCommitDigest !== 'string' ||
    !DIGEST_PATTERN.test(dataApplication.expectedCommitDigest) ||
    typeof dataApplication.expectedReceiptDigest !== 'string' ||
    !DIGEST_PATTERN.test(dataApplication.expectedReceiptDigest)
  ) {
    configurationError('application lineage binding drifted');
  }

  const activation = documentDigest(
    privateJsonMaterial(command.request.activationPath, uid, 'activation')
      .value,
    'activationDigest',
    'activation',
  );
  if (
    activation.document.schemaVersion !== 1 ||
    activation.document.kind !== 'qinglong3-local-sqlite-activation' ||
    activation.document.state !== 'prepared' ||
    activation.document.profile !== command.request.profile ||
    activation.digest !== command.request.expectedActivationDigest ||
    activation.document.sourcePathDigest !==
      textDigest(command.request.legacySourcePath) ||
    activation.document.targetPathDigest !==
      textDigest(command.request.targetDatabasePath) ||
    typeof activation.document.adoptionManifestDigest !== 'string' ||
    !DIGEST_PATTERN.test(activation.document.adoptionManifestDigest) ||
    typeof activation.document.sourceSha256 !== 'string' ||
    !DIGEST_PATTERN.test(activation.document.sourceSha256) ||
    typeof activation.document.targetSha256 !== 'string' ||
    !DIGEST_PATTERN.test(activation.document.targetSha256) ||
    typeof activation.document.recoverySha256 !== 'string' ||
    !DIGEST_PATTERN.test(activation.document.recoverySha256)
  ) {
    configurationError('activation lineage drifted');
  }

  const manifest = documentDigest(
    privateJsonMaterial(
      storage.manifestPath as string,
      uid,
      'adoption manifest',
    ).value,
    'manifestDigest',
    'adoption manifest',
  );
  if (manifest.digest !== activation.document.adoptionManifestDigest) {
    configurationError('adoption manifest lineage drifted');
  }

  const commitment = documentDigest(
    privateJsonMaterial(commitmentPath, uid, 'legacy silence commitment').value,
    'commitmentDigest',
    'legacy silence commitment',
  );
  if (
    commitment.document.schemaVersion !== 1 ||
    commitment.document.kind !== 'qinglong3-local-legacy-silence-commitment' ||
    commitment.document.state !== 'legacy_stopped' ||
    commitment.document.cutoverId !== command.request.cutoverId ||
    commitment.document.profile !== command.request.profile ||
    commitment.document.instanceId !== command.request.instanceId ||
    commitment.document.activationDigest !== activation.digest ||
    commitment.digest !== cutover.expectedCommitmentDigest
  ) {
    configurationError('legacy silence lineage drifted');
  }

  const dataCommit = normalizeLocalDataApplicationEvidence(
    privateJsonMaterial(
      dataApplication.commitPath as string,
      uid,
      'legacy data application commitment',
    ).value,
  );
  if (
    dataCommit.profile !== command.request.profile ||
    dataCommit.commitDigest !== dataApplication.expectedCommitDigest ||
    dataCommit.receiptDigest !== dataApplication.expectedReceiptDigest
  ) {
    configurationError('legacy data application receipt drifted');
  }

  const adoptedBundle = documentDigest(
    privateJsonMaterial(
      path.join(
        command.options.deploymentRoot,
        'service',
        'adopted-bundle.json',
      ),
      uid,
      'adopted bundle receipt',
    ).value,
    'bundleDigest',
    'adopted bundle receipt',
  );
  if (
    adoptedBundle.document.schemaVersion !== 1 ||
    adoptedBundle.document.kind !==
      'qinglong3-local-adopted-deployment-bundle' ||
    adoptedBundle.document.state !== 'prepared' ||
    adoptedBundle.document.profile !== command.request.profile ||
    adoptedBundle.document.instanceId !== command.request.instanceId ||
    adoptedBundle.document.cutoverId !== command.request.cutoverId ||
    adoptedBundle.document.applicationConfigDigest !==
      applicationMaterial.sha256 ||
    adoptedBundle.document.activationDigest !== activation.digest ||
    adoptedBundle.document.commitmentDigest !== commitment.digest ||
    adoptedBundle.document.legacyDataApplicationCommitDigest !==
      dataCommit.commitDigest ||
    adoptedBundle.document.legacyDataApplicationReceiptDigest !==
      dataCommit.receiptDigest ||
    adoptedBundle.document.manifestDigest !== manifest.digest ||
    adoptedBundle.document.sourcePathDigest !==
      textDigest(command.request.legacySourcePath) ||
    adoptedBundle.document.sourceSha256 !== activation.document.sourceSha256 ||
    adoptedBundle.document.recoverySha256 !== activation.document.recoverySha256
  ) {
    configurationError('adopted bundle lineage drifted');
  }

  const payload = Object.freeze({
    applicationConfigDigest: applicationMaterial.sha256,
    activationDigest: activation.digest,
    adoptionManifestDigest: manifest.digest,
    commitmentDigest: commitment.digest,
    legacyDataApplicationCommitDigest: dataCommit.commitDigest,
    legacyDataApplicationReceiptDigest: dataCommit.receiptDigest,
    adoptedBundleDigest: adoptedBundle.digest,
    sourceSha256: activation.document.sourceSha256 as string,
    targetSha256: activation.document.targetSha256 as string,
    recoverySha256: activation.document.recoverySha256 as string,
  });
  return Object.freeze({
    ...payload,
    projectionDigest: cutoverDigest(payload),
  });
}

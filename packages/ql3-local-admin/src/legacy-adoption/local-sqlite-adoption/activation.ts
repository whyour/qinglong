import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import {
  DIGEST_PATTERN,
  MAX_MANIFEST_BYTES,
  LocalSqliteAdoptionError,
  type AcquireLocalSqliteActivationOptions,
  type FileIdentity,
  type LocalSqliteActivation,
  type LocalSqliteActivationFence,
  type LocalSqliteActivationPayload,
  type LocalSqliteAdoptionManifest,
  type PrepareLocalSqliteActivationOptions,
} from './contracts';
import {
  assertAbsolutePath,
  assertClock,
  assertDistinctPaths,
  assertMissing,
  assertProfile,
  assertRealParent,
  assertRegularFile,
  fileIdentity,
  sha256File,
  sha256Text,
  writeManifestAtomically,
} from './filesystem';
import {
  acquireSourceWriteFence,
  releaseSourceWriteFence,
  verifySourceSnapshotWhileFenced,
} from './sourceFence';
import { verifyLocalSqliteAdoptionInternal } from './staging';

function parseActivation(value: unknown): LocalSqliteActivation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalSqliteAdoptionError('activation document is invalid');
  }
  const activation = value as Partial<LocalSqliteActivation>;
  const keys = Object.keys(activation).sort();
  const expectedKeys = [
    'activationDigest',
    'adoptionManifestDigest',
    'createdAtMs',
    'kind',
    'planDigest',
    'profile',
    'recoverySha256',
    'schemaVersion',
    'sourcePathDigest',
    'sourceSha256',
    'state',
    'targetDevice',
    'targetInode',
    'targetPathDigest',
    'targetSha256',
  ].sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    activation.schemaVersion !== 1 ||
    activation.kind !== 'qinglong3-local-sqlite-activation' ||
    activation.state !== 'prepared' ||
    !Number.isSafeInteger(activation.createdAtMs) ||
    (activation.createdAtMs as number) < 0 ||
    !DIGEST_PATTERN.test(activation.activationDigest ?? '') ||
    !DIGEST_PATTERN.test(activation.adoptionManifestDigest ?? '') ||
    !DIGEST_PATTERN.test(activation.planDigest ?? '') ||
    !DIGEST_PATTERN.test(activation.sourcePathDigest ?? '') ||
    !DIGEST_PATTERN.test(activation.sourceSha256 ?? '') ||
    !DIGEST_PATTERN.test(activation.recoverySha256 ?? '') ||
    !DIGEST_PATTERN.test(activation.targetSha256 ?? '') ||
    !DIGEST_PATTERN.test(activation.targetPathDigest ?? '') ||
    !/^(?:0|[1-9]\d*)$/.test(activation.targetDevice ?? '') ||
    !/^(?:0|[1-9]\d*)$/.test(activation.targetInode ?? '')
  ) {
    throw new LocalSqliteAdoptionError('activation document shape is invalid');
  }
  assertProfile(activation.profile);
  const { activationDigest, ...payload } = activation as LocalSqliteActivation;
  if (sha256Text(JSON.stringify(payload)) !== activationDigest) {
    throw new LocalSqliteAdoptionError('activation digest does not match');
  }
  return activation as LocalSqliteActivation;
}

async function readActivation(
  activationPath: string,
): Promise<LocalSqliteActivation> {
  assertAbsolutePath(activationPath, 'activationPath');
  assertRealParent(activationPath, 'activation');
  assertRegularFile(activationPath, 'activation');
  const stat = fs.statSync(activationPath);
  if (
    stat.size < 1 ||
    stat.size > MAX_MANIFEST_BYTES ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new LocalSqliteAdoptionError(
      'activation file size or mode is invalid',
    );
  }
  try {
    return parseActivation(
      JSON.parse(await fs.promises.readFile(activationPath, 'utf8')),
    );
  } catch (error) {
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError('activation JSON is invalid', error);
  }
}

function assertActivationMatchesAdoption(
  activation: LocalSqliteActivation,
  adoption: LocalSqliteAdoptionManifest,
): void {
  if (
    activation.profile !== adoption.profile ||
    activation.adoptionManifestDigest !== adoption.manifestDigest ||
    activation.planDigest !== adoption.planDigest ||
    activation.sourcePathDigest !== adoption.source.pathDigest ||
    activation.recoverySha256 !== adoption.recovery.sha256 ||
    activation.targetSha256 !== adoption.target.sha256
  ) {
    throw new LocalSqliteAdoptionError(
      'activation does not match the staged adoption',
    );
  }
}

function assertActivationMatchesTarget(
  activation: LocalSqliteActivation,
  targetIdentity: FileIdentity,
): void {
  if (
    activation.targetPathDigest !== targetIdentity.pathDigest ||
    activation.targetDevice !== targetIdentity.device ||
    activation.targetInode !== targetIdentity.inode
  ) {
    throw new LocalSqliteAdoptionError(
      'target database identity does not match the activation',
    );
  }
}

function assertActivatedTargetPath(
  activation: LocalSqliteActivation,
  targetPath: string,
): void {
  assertRealParent(targetPath, 'target');
  assertRegularFile(targetPath, 'target');
  assertActivationMatchesTarget(activation, fileIdentity(targetPath));
}

export async function prepareLocalSqliteActivation(
  options: PrepareLocalSqliteActivationOptions,
): Promise<LocalSqliteActivation> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new LocalSqliteAdoptionError(
      'activation preparation options are invalid',
    );
  }
  for (const [label, value] of [
    ['sourcePath', options.sourcePath],
    ['targetPath', options.targetPath],
    ['recoveryPath', options.recoveryPath],
    ['manifestPath', options.manifestPath],
    ['activationPath', options.activationPath],
  ] as const) {
    assertAbsolutePath(value, label);
  }
  if (!DIGEST_PATTERN.test(options.expectedManifestDigest)) {
    throw new LocalSqliteAdoptionError('expectedManifestDigest is invalid');
  }
  assertDistinctPaths([
    options.sourcePath,
    options.targetPath,
    options.recoveryPath,
    options.manifestPath,
    options.activationPath,
  ]);
  assertRealParent(options.activationPath, 'activation');
  assertMissing(options.activationPath, 'activation');
  const verified = await verifyLocalSqliteAdoptionInternal(options, true);
  const adoption = verified.manifest;
  if (adoption.manifestDigest !== options.expectedManifestDigest) {
    throw new LocalSqliteAdoptionError(
      'staged adoption no longer matches the reviewed manifest',
    );
  }
  const fence = acquireSourceWriteFence(options.sourcePath);
  let targetFence: DatabaseSync | undefined;
  try {
    targetFence = acquireSourceWriteFence(
      options.targetPath,
      undefined,
      'target database',
    );
    await verifySourceSnapshotWhileFenced(
      options.sourcePath,
      options.recoveryPath,
      adoption,
    );
    const sourceSha256 = await sha256File(options.sourcePath);
    const activationVerified = await verifyLocalSqliteAdoptionInternal(
      options,
      true,
    );
    if (
      activationVerified.manifest.manifestDigest !== adoption.manifestDigest
    ) {
      throw new LocalSqliteAdoptionError(
        'staged adoption changed during activation preparation',
      );
    }
    const payload: LocalSqliteActivationPayload = Object.freeze({
      schemaVersion: 1,
      kind: 'qinglong3-local-sqlite-activation',
      state: 'prepared',
      profile: adoption.profile,
      createdAtMs: assertClock(options.clock ?? Date.now),
      adoptionManifestDigest: adoption.manifestDigest,
      planDigest: adoption.planDigest,
      sourcePathDigest: adoption.source.pathDigest,
      sourceSha256,
      recoverySha256: adoption.recovery.sha256,
      targetSha256: adoption.target.sha256,
      targetPathDigest: activationVerified.targetIdentity.pathDigest,
      targetDevice: activationVerified.targetIdentity.device,
      targetInode: activationVerified.targetIdentity.inode,
    });
    const activation = Object.freeze({
      ...payload,
      activationDigest: sha256Text(JSON.stringify(payload)),
    });
    await writeManifestAtomically(options.activationPath, activation);
    return activation;
  } catch (error) {
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError('activation preparation failed', error);
  } finally {
    if (targetFence) releaseSourceWriteFence(targetFence);
    releaseSourceWriteFence(fence);
  }
}

export async function acquireLocalSqliteActivation(
  options: AcquireLocalSqliteActivationOptions,
): Promise<LocalSqliteActivationFence> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new LocalSqliteAdoptionError(
      'activation acquisition options are invalid',
    );
  }
  for (const [label, value] of [
    ['sourcePath', options.sourcePath],
    ['targetPath', options.targetPath],
    ['recoveryPath', options.recoveryPath],
    ['manifestPath', options.manifestPath],
    ['activationPath', options.activationPath],
  ] as const) {
    assertAbsolutePath(value, label);
  }
  if (!DIGEST_PATTERN.test(options.expectedActivationDigest)) {
    throw new LocalSqliteAdoptionError('expectedActivationDigest is invalid');
  }
  assertDistinctPaths([
    options.sourcePath,
    options.targetPath,
    options.recoveryPath,
    options.manifestPath,
    options.activationPath,
  ]);
  const activation = await readActivation(options.activationPath);
  if (activation.activationDigest !== options.expectedActivationDigest) {
    throw new LocalSqliteAdoptionError(
      'activation no longer matches the reviewed digest',
    );
  }
  const verified = await verifyLocalSqliteAdoptionInternal(options, false);
  const adoption = verified.manifest;
  assertActivationMatchesAdoption(activation, adoption);
  assertActivationMatchesTarget(activation, verified.targetIdentity);
  const fence = acquireSourceWriteFence(
    options.sourcePath,
    options.busyTimeoutMs,
  );
  try {
    await verifySourceSnapshotWhileFenced(
      options.sourcePath,
      options.recoveryPath,
      adoption,
    );
    if ((await sha256File(options.sourcePath)) !== activation.sourceSha256) {
      throw new LocalSqliteAdoptionError(
        'legacy source bytes changed after activation preparation',
      );
    }
  } catch (error) {
    releaseSourceWriteFence(fence);
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError('activation acquisition failed', error);
  }
  let releasePromise: Promise<'released'> | undefined;
  return Object.freeze({
    activation,
    adoption,
    state: 'fenced' as const,
    assertTargetIdentity() {
      assertActivatedTargetPath(activation, options.targetPath);
    },
    release() {
      if (releasePromise) return releasePromise;
      releasePromise = Promise.resolve().then(() => {
        releaseSourceWriteFence(fence);
        return 'released' as const;
      });
      return releasePromise;
    },
  });
}

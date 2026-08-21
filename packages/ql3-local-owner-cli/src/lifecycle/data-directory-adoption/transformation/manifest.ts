import fs from 'node:fs';
import path from 'node:path';

import { LocalDataDirectoryAdoptionConfigurationError } from '../contract';
import { assertPrivateDirectory, sameStat, sortedNames } from '../filesystem';
import { sha256Text } from '../manifest';
import {
  readStablePrivateUtf8File,
  type TransformationAuthority,
} from './files';
import {
  verifyTransformationModel,
  type LocalDataDirectoryTransformationManifest,
  type TransformationModelEvidence,
  type TransformationSourceEvidence,
} from './model';

export const TRANSFORMATION_MANIFEST_NAME = 'manifest.json';
const MAX_MANIFEST_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_NAMES = Object.freeze(['config', 'keyv', 'ssh'] as const);

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function treeEvidence(
  value: unknown,
  extraKeys: readonly string[],
): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'bytes',
      'digest',
      'directories',
      'entries',
      'files',
      ...extraKeys,
    ])
  ) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    [
      candidate.entries,
      candidate.directories,
      candidate.files,
      candidate.bytes,
      ...extraKeys.map((key) => candidate[key]),
    ].every(safeCount) &&
    candidate.entries ===
      (candidate.directories as number) + (candidate.files as number) &&
    typeof candidate.digest === 'string' &&
    DIGEST_PATTERN.test(candidate.digest)
  );
}

function sourceEvidence(
  value: unknown,
  expectedName: (typeof SOURCE_NAMES)[number],
): value is TransformationSourceEvidence {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'assessment',
      'bytes',
      'digest',
      'directories',
      'entries',
      'files',
      'name',
      'present',
    ])
  ) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    treeEvidence(
      {
        bytes: candidate.bytes,
        digest: candidate.digest,
        directories: candidate.directories,
        entries: candidate.entries,
        files: candidate.files,
      },
      [],
    ) &&
    candidate.name === expectedName &&
    typeof candidate.present === 'boolean' &&
    (candidate.assessment === 'ready' ||
      candidate.assessment === 'manual_required') &&
    (candidate.present || candidate.entries === 0)
  );
}

function parseManifest(
  value: unknown,
): LocalDataDirectoryTransformationManifest {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'assessment',
      'createdAtMs',
      'kind',
      'model',
      'profile',
      'projectIdDigest',
      'schemaVersion',
      'sourceStageManifestDigest',
      'sources',
      'state',
      'transformationDigest',
      'transformationRootPathDigest',
    ])
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation manifest shape is invalid',
    );
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.kind !== 'qinglong3-legacy-data-directory-transformation' ||
    candidate.state !== 'prepared' ||
    (candidate.profile !== 'edge' && candidate.profile !== 'standalone') ||
    (candidate.assessment !== 'ready' &&
      candidate.assessment !== 'manual_required') ||
    !safeCount(candidate.createdAtMs) ||
    ![
      candidate.projectIdDigest,
      candidate.sourceStageManifestDigest,
      candidate.transformationDigest,
      candidate.transformationRootPathDigest,
    ].every(
      (digest) => typeof digest === 'string' && DIGEST_PATTERN.test(digest),
    ) ||
    !Array.isArray(candidate.sources) ||
    candidate.sources.length !== SOURCE_NAMES.length ||
    !candidate.sources.every((entry, index) =>
      sourceEvidence(entry, SOURCE_NAMES[index]!),
    ) ||
    !treeEvidence(candidate.model, [
      'environmentSecrets',
      'manualCategories',
      'sshSecrets',
    ])
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation manifest value is invalid',
    );
  }
  const { transformationDigest, ...payload } =
    candidate as unknown as LocalDataDirectoryTransformationManifest;
  if (sha256Text(JSON.stringify(payload)) !== transformationDigest) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation manifest digest does not match',
    );
  }
  return candidate as unknown as LocalDataDirectoryTransformationManifest;
}

function readManifest(
  root: string,
  uid: number,
): Readonly<LocalDataDirectoryTransformationManifest> {
  try {
    return parseManifest(
      JSON.parse(
        readStablePrivateUtf8File(
          path.join(root, TRANSFORMATION_MANIFEST_NAME),
          uid,
          MAX_MANIFEST_BYTES,
          'transformation manifest',
        ),
      ),
    );
  } catch (error) {
    if (error instanceof LocalDataDirectoryAdoptionConfigurationError) {
      throw error;
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation manifest JSON is invalid',
      error,
    );
  }
}

export function verifyStaticTransformation(options: {
  readonly authority: Readonly<TransformationAuthority>;
  readonly profile: 'edge' | 'standalone';
  readonly projectId: string;
  readonly sourceStageManifestDigest: string;
  readonly expectedTransformationDigest: string;
}): Readonly<LocalDataDirectoryTransformationManifest> {
  const before = assertPrivateDirectory(
    options.authority.transformationRoot,
    options.authority.uid,
    'transformationRoot',
  );
  if (
    JSON.stringify(sortedNames(options.authority.transformationRoot)) !==
    JSON.stringify([TRANSFORMATION_MANIFEST_NAME, 'model'].sort())
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation root is incomplete or contains unexpected entries',
    );
  }
  const manifest = readManifest(
    options.authority.transformationRoot,
    options.authority.uid,
  );
  if (
    manifest.transformationDigest !== options.expectedTransformationDigest ||
    manifest.profile !== options.profile ||
    manifest.projectIdDigest !== sha256Text(options.projectId) ||
    manifest.sourceStageManifestDigest !== options.sourceStageManifestDigest ||
    manifest.transformationRootPathDigest !==
      sha256Text(options.authority.transformationRoot)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation manifest authority binding is invalid',
    );
  }
  verifyTransformationModel({
    modelRoot: path.join(options.authority.transformationRoot, 'model'),
    uid: options.authority.uid,
    projectId: options.projectId,
    profile: options.profile,
    expected: manifest.model as Readonly<TransformationModelEvidence>,
  });
  if (
    !sameStat(
      before,
      fs.lstatSync(options.authority.transformationRoot, { bigint: true }),
    )
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation root changed during verification',
    );
  }
  return manifest;
}

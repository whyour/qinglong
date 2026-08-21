import { createHash } from 'node:crypto';

import type { LocalDataDirectoryAdoptionRecord } from './dataDirectoryAdoptionDatabase';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const LOCAL_DATA_DIRECTORY_APPLICATION_COMMIT_KIND =
  'qinglong3-legacy-data-directory-application' as const;

export interface LocalDataDirectoryApplicationCommitPayload {
  readonly schemaVersion: 1;
  readonly kind: typeof LOCAL_DATA_DIRECTORY_APPLICATION_COMMIT_KIND;
  readonly state: 'committed';
  readonly mutationId: string;
  readonly profile: 'edge' | 'standalone';
  readonly projectIdDigest: string;
  readonly sourceStageManifestDigest: string;
  readonly transformationDigest: string;
  readonly modelDigest: string;
  readonly publicationDigest: string;
  readonly receiptDigest: string;
  readonly secretCount: number;
  readonly environmentSecretCount: number;
  readonly sshSecretCount: number;
  readonly committedAtMs: number;
  readonly reclamation: Readonly<{
    modelRemoved: true;
    plaintextFilesRemoved: true;
    physicalErasureGuaranteed: false;
  }>;
}

export interface LocalDataDirectoryApplicationCommit
  extends LocalDataDirectoryApplicationCommitPayload {
  readonly commitDigest: string;
}

export class LocalDataDirectoryApplicationCommitError extends TypeError {
  readonly code = 'LOCAL_DATA_DIRECTORY_APPLICATION_COMMIT_INVALID';

  constructor(message: string) {
    super(`Local data directory application commit is invalid: ${message}`);
    this.name = 'LocalDataDirectoryApplicationCommitError';
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new LocalDataDirectoryApplicationCommitError(
      `${label} must be an object`,
    );
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
    throw new LocalDataDirectoryApplicationCommitError(
      `${label} shape is invalid`,
    );
  }
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LocalDataDirectoryApplicationCommitError(`${label} is invalid`);
  }
  return value as number;
}

export function localDataDirectoryApplicationCommitDigest(
  payload: Readonly<LocalDataDirectoryApplicationCommitPayload>,
): string {
  return digest(JSON.stringify(payload));
}

export function normalizeLocalDataDirectoryApplicationCommit(
  value: unknown,
): Readonly<LocalDataDirectoryApplicationCommit> {
  const commit = record(value, 'commit');
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
    'commit',
  );
  const reclamation = record(commit.reclamation, 'reclamation');
  exact(
    reclamation,
    ['modelRemoved', 'physicalErasureGuaranteed', 'plaintextFilesRemoved'],
    'reclamation',
  );
  const secretCount = count(commit.secretCount, 'secretCount');
  const environmentSecretCount = count(
    commit.environmentSecretCount,
    'environmentSecretCount',
  );
  const sshSecretCount = count(commit.sshSecretCount, 'sshSecretCount');
  const digestValues = [
    commit.projectIdDigest,
    commit.sourceStageManifestDigest,
    commit.transformationDigest,
    commit.modelDigest,
    commit.publicationDigest,
    commit.receiptDigest,
  ];
  if (
    commit.schemaVersion !== 1 ||
    commit.kind !== LOCAL_DATA_DIRECTORY_APPLICATION_COMMIT_KIND ||
    commit.state !== 'committed' ||
    typeof commit.mutationId !== 'string' ||
    !UUID_V4_PATTERN.test(commit.mutationId) ||
    (commit.profile !== 'edge' && commit.profile !== 'standalone') ||
    digestValues.some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    secretCount !== environmentSecretCount + sshSecretCount ||
    !Number.isSafeInteger(commit.committedAtMs) ||
    (commit.committedAtMs as number) < 0 ||
    reclamation.modelRemoved !== true ||
    reclamation.plaintextFilesRemoved !== true ||
    reclamation.physicalErasureGuaranteed !== false
  ) {
    throw new LocalDataDirectoryApplicationCommitError(
      'commit values are invalid',
    );
  }
  const payload: LocalDataDirectoryApplicationCommitPayload = {
    schemaVersion: 1,
    kind: LOCAL_DATA_DIRECTORY_APPLICATION_COMMIT_KIND,
    state: 'committed',
    mutationId: commit.mutationId,
    profile: commit.profile,
    projectIdDigest: commit.projectIdDigest as string,
    sourceStageManifestDigest: commit.sourceStageManifestDigest as string,
    transformationDigest: commit.transformationDigest as string,
    modelDigest: commit.modelDigest as string,
    publicationDigest: commit.publicationDigest as string,
    receiptDigest: commit.receiptDigest as string,
    secretCount,
    environmentSecretCount,
    sshSecretCount,
    committedAtMs: commit.committedAtMs as number,
    reclamation: Object.freeze({
      modelRemoved: true,
      plaintextFilesRemoved: true,
      physicalErasureGuaranteed: false,
    }),
  };
  if (
    typeof commit.commitDigest !== 'string' ||
    !DIGEST_PATTERN.test(commit.commitDigest) ||
    localDataDirectoryApplicationCommitDigest(payload) !== commit.commitDigest
  ) {
    throw new LocalDataDirectoryApplicationCommitError(
      'commit digest is invalid',
    );
  }
  return Object.freeze({ ...payload, commitDigest: commit.commitDigest });
}

export function createLocalDataDirectoryApplicationCommit(
  adoption: Readonly<LocalDataDirectoryAdoptionRecord>,
): Readonly<LocalDataDirectoryApplicationCommit> {
  const payload: LocalDataDirectoryApplicationCommitPayload = {
    schemaVersion: 1,
    kind: LOCAL_DATA_DIRECTORY_APPLICATION_COMMIT_KIND,
    state: 'committed',
    mutationId: adoption.mutationId,
    profile: adoption.profile,
    projectIdDigest: digest(adoption.projectId),
    sourceStageManifestDigest: adoption.sourceStageManifestDigest,
    transformationDigest: adoption.transformationDigest,
    modelDigest: adoption.modelDigest,
    publicationDigest: adoption.publicationDigest,
    receiptDigest: adoption.receiptDigest,
    secretCount: adoption.receipt.secretCount,
    environmentSecretCount: adoption.receipt.environmentSecretCount,
    sshSecretCount: adoption.receipt.sshSecretCount,
    committedAtMs: adoption.committedAtMs,
    reclamation: Object.freeze({
      modelRemoved: true,
      plaintextFilesRemoved: true,
      physicalErasureGuaranteed: false,
    }),
  };
  return Object.freeze({
    ...payload,
    commitDigest: localDataDirectoryApplicationCommitDigest(payload),
  });
}

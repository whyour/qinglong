import fs from 'node:fs';
import path from 'node:path';

import {
  createLocalDataDirectoryApplicationCommit,
  createLocalDataDirectorySourceNameDigest,
  type LocalDataDirectoryApplicationCommit,
  type LocalDataDirectoryAdoptionRecord,
} from '@qinglong/local-sqlite/data-directory-adoption';

import { LocalDataDirectoryAdoptionConfigurationError } from '../contract';
import {
  assertPrivateDirectory,
  sameStat,
  sortedNames,
  syncDirectory,
} from '../filesystem';
import {
  readStablePrivateUtf8File,
  writePrivateJson,
  type TransformationAuthority,
} from '../transformation/files';
import { verifyTransformationModel } from '../transformation/model';
import { verifyTransformationManifestBinding } from '../transformation/manifest';

export const APPLICATION_COMMIT_NAME = 'commit.json';
const COMMIT_INCOMPLETE_NAME = '.commit-incomplete';
const RECLAIMING_MODEL_NAME = '.reclaiming-model';
const MODEL_NAME = 'model';
const MAX_JSON_BYTES = 1024 * 1024;
const ZERO_CHUNK = Buffer.alloc(64 * 1024);

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function readJson(filePath: string, uid: number, label: string): unknown {
  try {
    return JSON.parse(
      readStablePrivateUtf8File(filePath, uid, MAX_JSON_BYTES, label),
    );
  } catch (error) {
    if (error instanceof LocalDataDirectoryAdoptionConfigurationError) {
      throw error;
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      `${label} JSON is invalid`,
      error,
    );
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyMarker(
  root: string,
  uid: number,
  adoption: Readonly<LocalDataDirectoryAdoptionRecord>,
): void {
  const marker = readJson(
    path.join(root, COMMIT_INCOMPLETE_NAME),
    uid,
    'application recovery marker',
  );
  if (
    !marker ||
    typeof marker !== 'object' ||
    Array.isArray(marker) ||
    !exactKeys(marker, [
      'kind',
      'mutationId',
      'receiptDigest',
      'schemaVersion',
      'transformationDigest',
    ])
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'application recovery marker shape is invalid',
    );
  }
  const candidate = marker as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.kind !==
      'qinglong3-legacy-data-directory-application-incomplete' ||
    candidate.mutationId !== adoption.mutationId ||
    candidate.transformationDigest !== adoption.transformationDigest ||
    candidate.receiptDigest !== adoption.receiptDigest
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'application recovery marker does not match the committed database',
    );
  }
}

function verifyCommit(
  authority: Readonly<TransformationAuthority>,
  adoption: Readonly<LocalDataDirectoryAdoptionRecord>,
): Readonly<LocalDataDirectoryApplicationCommit> {
  const actual = readJson(
    path.join(authority.transformationRoot, APPLICATION_COMMIT_NAME),
    authority.uid,
    'application commit',
  );
  const expected = createLocalDataDirectoryApplicationCommit(adoption);
  if (!sameJson(actual, expected)) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'application commit does not match the durable database receipt',
    );
  }
  return expected;
}

function assertPreparedMatches(
  modelRoot: string,
  authority: Readonly<TransformationAuthority>,
  adoption: Readonly<LocalDataDirectoryAdoptionRecord>,
): void {
  const manifest = verifyTransformationManifestBinding({
    authority,
    profile: adoption.profile,
    projectId: adoption.projectId,
    sourceStageManifestDigest: adoption.sourceStageManifestDigest,
    expectedTransformationDigest: adoption.transformationDigest,
  });
  const prepared = verifyTransformationModel({
    modelRoot,
    uid: authority.uid,
    projectId: adoption.projectId,
    profile: adoption.profile,
    expected: manifest.model,
  });
  if (
    manifest.assessment !== 'ready' ||
    manifest.model.manualCategories !== 0 ||
    !sameJson(prepared.model, adoption.model) ||
    prepared.secrets.length !== adoption.secrets.length ||
    prepared.secrets.some((secret, index) => {
      const stored = adoption.secrets[index];
      return (
        !stored ||
        stored.ordinal !== index + 1 ||
        stored.kind !== secret.kind ||
        stored.sourceNameDigest !==
          createLocalDataDirectorySourceNameDigest(
            secret.kind,
            secret.sourceName,
          ) ||
        stored.secretName !== secret.targetName ||
        stored.valueFile !== secret.valueFile ||
        stored.valueDigest !== secret.valueDigest
      );
    })
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'prepared model does not match the committed database receipt',
    );
  }
}

function privateEntry(
  entryPath: string,
  uid: number,
  kind: 'file' | 'directory',
): fs.BigIntStats {
  const stat = fs.lstatSync(entryPath, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(uid) ||
    (stat.mode & 0o777n) !== (kind === 'file' ? 0o600n : 0o700n) ||
    (kind === 'file'
      ? !stat.isFile() || stat.nlink !== 1n
      : !stat.isDirectory())
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'reclaiming model identity or mode is invalid',
    );
  }
  return stat;
}

function overwriteAndUnlink(filePath: string, uid: number): void {
  const expected = privateEntry(filePath, uid, 'file');
  if (expected.size < 0n || expected.size > BigInt(32 * 1024)) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'reclaiming Secret file size is invalid',
    );
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(expected, opened)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'reclaiming Secret identity changed before overwrite',
      );
    }
    let remaining = Number(opened.size);
    let offset = 0;
    while (remaining > 0) {
      const count = Math.min(remaining, ZERO_CHUNK.length);
      const written = fs.writeSync(descriptor, ZERO_CHUNK, 0, count, offset);
      if (written < 1) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'reclaiming Secret overwrite made no progress',
        );
      }
      remaining -= written;
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.unlinkSync(filePath);
}

function reclaimRenamedModel(
  root: string,
  uid: number,
  adoption: Readonly<LocalDataDirectoryAdoptionRecord>,
): void {
  const modelRoot = path.join(root, RECLAIMING_MODEL_NAME);
  privateEntry(modelRoot, uid, 'directory');
  const allowedRootFiles = new Set([
    'config.json',
    'keyv.json',
    'manual-review.json',
    'secret-imports.json',
    'ssh.json',
    'secret-values',
  ]);
  if (sortedNames(modelRoot).some((name) => !allowedRootFiles.has(name))) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'reclaiming model contains an unexpected entry',
    );
  }
  const secretRoot = path.join(modelRoot, 'secret-values');
  if (fs.existsSync(secretRoot)) {
    privateEntry(secretRoot, uid, 'directory');
    const expectedFiles = new Set(
      adoption.secrets.map(({ valueFile }) => path.basename(valueFile)),
    );
    const actualFiles = sortedNames(secretRoot);
    if (actualFiles.some((name) => !expectedFiles.has(name))) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'reclaiming Secret directory contains an unexpected entry',
      );
    }
    for (const name of actualFiles) {
      overwriteAndUnlink(path.join(secretRoot, name), uid);
    }
    fs.rmdirSync(secretRoot);
    syncDirectory(modelRoot);
  }
  for (const name of [
    'config.json',
    'keyv.json',
    'ssh.json',
    'manual-review.json',
    'secret-imports.json',
  ]) {
    const filePath = path.join(modelRoot, name);
    if (!fs.existsSync(filePath)) continue;
    privateEntry(filePath, uid, 'file');
    fs.unlinkSync(filePath);
  }
  syncDirectory(modelRoot);
  if (sortedNames(modelRoot).length !== 0) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'reclaiming model could not be emptied',
    );
  }
  fs.rmdirSync(modelRoot);
  syncDirectory(root);
}

export function reclaimCommittedTransformationModel(options: {
  readonly authority: Readonly<TransformationAuthority>;
  readonly adoption: Readonly<LocalDataDirectoryAdoptionRecord>;
}): Readonly<LocalDataDirectoryApplicationCommit> {
  const { authority, adoption } = options;
  const root = authority.transformationRoot;
  const before = assertPrivateDirectory(
    root,
    authority.uid,
    'transformationRoot',
  );
  verifyTransformationManifestBinding({
    authority,
    profile: adoption.profile,
    projectId: adoption.projectId,
    sourceStageManifestDigest: adoption.sourceStageManifestDigest,
    expectedTransformationDigest: adoption.transformationDigest,
  });
  const initialNames = sortedNames(root);
  const allowedNames = new Set([
    'manifest.json',
    APPLICATION_COMMIT_NAME,
    COMMIT_INCOMPLETE_NAME,
    MODEL_NAME,
    RECLAIMING_MODEL_NAME,
  ]);
  if (
    initialNames.some((name) => !allowedNames.has(name)) ||
    !initialNames.includes('manifest.json') ||
    (initialNames.includes(MODEL_NAME) &&
      initialNames.includes(RECLAIMING_MODEL_NAME))
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'application recovery root shape is invalid',
    );
  }
  if (!initialNames.includes(COMMIT_INCOMPLETE_NAME)) {
    if (
      initialNames.includes(APPLICATION_COMMIT_NAME) &&
      !initialNames.includes(MODEL_NAME) &&
      !initialNames.includes(RECLAIMING_MODEL_NAME)
    ) {
      return verifyCommit(authority, adoption);
    }
    writePrivateJson(path.join(root, COMMIT_INCOMPLETE_NAME), {
      schemaVersion: 1,
      kind: 'qinglong3-legacy-data-directory-application-incomplete',
      mutationId: adoption.mutationId,
      transformationDigest: adoption.transformationDigest,
      receiptDigest: adoption.receiptDigest,
    });
    syncDirectory(root);
  }
  verifyMarker(root, authority.uid, adoption);

  const modelRoot = path.join(root, MODEL_NAME);
  const reclaimingRoot = path.join(root, RECLAIMING_MODEL_NAME);
  if (fs.existsSync(modelRoot)) {
    assertPreparedMatches(modelRoot, authority, adoption);
    if (fs.existsSync(reclaimingRoot)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'multiple application model recovery roots exist',
      );
    }
    fs.renameSync(modelRoot, reclaimingRoot);
    syncDirectory(root);
  }
  if (fs.existsSync(reclaimingRoot)) {
    reclaimRenamedModel(root, authority.uid, adoption);
  }

  const commitPath = path.join(root, APPLICATION_COMMIT_NAME);
  if (!fs.existsSync(commitPath)) {
    writePrivateJson(
      commitPath,
      createLocalDataDirectoryApplicationCommit(adoption),
    );
    syncDirectory(root);
  }
  const commit = verifyCommit(authority, adoption);
  fs.unlinkSync(path.join(root, COMMIT_INCOMPLETE_NAME));
  syncDirectory(root);
  if (
    JSON.stringify(sortedNames(root)) !==
    JSON.stringify([APPLICATION_COMMIT_NAME, 'manifest.json'].sort())
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'committed transformation root contains unexpected entries',
    );
  }
  const after = fs.lstatSync(root, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.uid !== after.uid ||
    (after.mode & 0o777n) !== 0o700n
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation root identity changed during application cleanup',
    );
  }
  return commit;
}

export function verifyCommittedTransformationModel(options: {
  readonly authority: Readonly<TransformationAuthority>;
  readonly adoption: Readonly<LocalDataDirectoryAdoptionRecord>;
  readonly expectedReceiptDigest: string;
}): Readonly<LocalDataDirectoryApplicationCommit> {
  if (
    options.adoption.receiptDigest !== options.expectedReceiptDigest ||
    JSON.stringify(sortedNames(options.authority.transformationRoot)) !==
      JSON.stringify([APPLICATION_COMMIT_NAME, 'manifest.json'].sort())
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'committed transformation evidence is incomplete',
    );
  }
  verifyTransformationManifestBinding({
    authority: options.authority,
    profile: options.adoption.profile,
    projectId: options.adoption.projectId,
    sourceStageManifestDigest: options.adoption.sourceStageManifestDigest,
    expectedTransformationDigest: options.adoption.transformationDigest,
  });
  return verifyCommit(options.authority, options.adoption);
}

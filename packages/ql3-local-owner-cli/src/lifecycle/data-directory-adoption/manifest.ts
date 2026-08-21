import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LocalDataDirectoryAdoptionConfigurationError } from './contract';
import {
  assertPrivateDirectory,
  sameStat,
  sortedNames,
  stableFileDigest,
  type RootAuthority,
} from './filesystem';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RELATIVE_PATH_BYTES = 4_096;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const MANIFEST_NAME = 'manifest.json';

export const PAYLOAD_GROUPS = Object.freeze([
  Object.freeze({
    name: 'copy_reviewed' as const,
    directoryName: 'copy-reviewed',
    categories: Object.freeze(['scripts', 'upload'] as const),
  }),
  Object.freeze({
    name: 'transform_input' as const,
    directoryName: 'transform-input',
    categories: Object.freeze(['config', 'db', 'ssh.d'] as const),
  }),
]);

type PayloadGroupName = (typeof PAYLOAD_GROUPS)[number]['name'];

export interface LocalDataDirectoryPayloadEvidence {
  readonly name: PayloadGroupName;
  readonly categories: readonly string[];
  readonly entries: number;
  readonly directories: number;
  readonly files: number;
  readonly bytes: number;
  readonly digest: string;
}

export interface LocalDataDirectoryAdoptionManifestPayload {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-data-directory-adoption';
  readonly state: 'staged';
  readonly profile: 'edge' | 'standalone';
  readonly createdAtMs: number;
  readonly planDigest: string;
  readonly sqliteActivationDigest: string;
  readonly sqliteAdoptionManifestDigest: string;
  readonly dataRootPathDigest: string;
  readonly stagingRootPathDigest: string;
  readonly payload: readonly LocalDataDirectoryPayloadEvidence[];
}

export interface LocalDataDirectoryAdoptionManifest
  extends LocalDataDirectoryAdoptionManifestPayload {
  readonly manifestDigest: string;
}

interface MutablePayloadSummary {
  entries: number;
  directories: number;
  files: number;
  bytes: number;
}

export function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function assertRelativePath(value: string): void {
  if (
    value.length < 1 ||
    path.isAbsolute(value) ||
    value === '..' ||
    value.startsWith(`..${path.sep}`) ||
    Buffer.byteLength(value, 'utf8') > MAX_RELATIVE_PATH_BYTES
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'payload relative path is invalid or too long',
    );
  }
}

function payloadEvidence(
  groupRoot: string,
  group: (typeof PAYLOAD_GROUPS)[number],
  uid: number,
): Readonly<LocalDataDirectoryPayloadEvidence> {
  assertPrivateDirectory(groupRoot, uid, 'payload group');
  const allowed = new Set<string>(group.categories);
  const summary: MutablePayloadSummary = {
    entries: 0,
    directories: 0,
    files: 0,
    bytes: 0,
  };
  const hash = crypto.createHash('sha256');
  const visit = (directoryPath: string, expected: fs.BigIntStats): void => {
    for (const name of sortedNames(directoryPath)) {
      const entryPath = path.join(directoryPath, name);
      const relative = path.relative(groupRoot, entryPath);
      assertRelativePath(relative);
      if (directoryPath === groupRoot && !allowed.has(name)) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'staged payload contains an unexpected category',
        );
      }
      const stat = fs.lstatSync(entryPath, { bigint: true });
      summary.entries += 1;
      if (
        stat.isSymbolicLink() ||
        stat.uid !== BigInt(uid) ||
        (stat.mode & 0o777n) !== (stat.isDirectory() ? 0o700n : 0o600n)
      ) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'staged payload identity or mode is invalid',
        );
      }
      const canonicalRelative = relative.split(path.sep).join('/');
      if (stat.isDirectory()) {
        summary.directories += 1;
        hash.update(
          `${JSON.stringify({
            relative: canonicalRelative,
            kind: 'directory',
          })}\n`,
          'utf8',
        );
        visit(entryPath, stat);
      } else if (stat.isFile() && stat.nlink === 1n) {
        if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new LocalDataDirectoryAdoptionConfigurationError(
            'staged payload file size is unsupported',
          );
        }
        const bytes = Number(stat.size);
        if (!Number.isSafeInteger(summary.bytes + bytes)) {
          throw new LocalDataDirectoryAdoptionConfigurationError(
            'staged payload byte total is unsupported',
          );
        }
        summary.files += 1;
        summary.bytes += bytes;
        hash.update(
          `${JSON.stringify({
            relative: canonicalRelative,
            kind: 'file',
            bytes,
            contentDigest: stableFileDigest(entryPath, stat),
          })}\n`,
          'utf8',
        );
      } else {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'staged payload entry kind is invalid',
        );
      }
    }
    if (!sameStat(expected, fs.lstatSync(directoryPath, { bigint: true }))) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'staged payload directory changed during verification',
      );
    }
  };
  visit(groupRoot, fs.lstatSync(groupRoot, { bigint: true }));
  return Object.freeze({
    name: group.name,
    categories: group.categories,
    ...summary,
    digest: hash.digest('hex'),
  });
}

export function inspectPayload(
  stagingRoot: string,
  uid: number,
): readonly LocalDataDirectoryPayloadEvidence[] {
  const payloadRoot = path.join(stagingRoot, 'payload');
  const payloadRootBefore = assertPrivateDirectory(
    payloadRoot,
    uid,
    'payload root',
  );
  const expectedGroupNames = PAYLOAD_GROUPS.map((group) => group.directoryName);
  if (
    JSON.stringify(sortedNames(payloadRoot)) !==
    JSON.stringify(
      [...expectedGroupNames].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    )
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'payload group set is invalid',
    );
  }
  const evidence = Object.freeze(
    PAYLOAD_GROUPS.map((group) =>
      payloadEvidence(path.join(payloadRoot, group.directoryName), group, uid),
    ),
  );
  if (
    !sameStat(payloadRootBefore, fs.lstatSync(payloadRoot, { bigint: true }))
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'payload root changed during verification',
    );
  }
  return evidence;
}

function parsePayloadEvidence(
  value: unknown,
): LocalDataDirectoryPayloadEvidence {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'bytes',
      'categories',
      'digest',
      'directories',
      'entries',
      'files',
      'name',
    ])
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'manifest payload evidence shape is invalid',
    );
  }
  const candidate = value as Partial<LocalDataDirectoryPayloadEvidence>;
  const group = PAYLOAD_GROUPS.find((entry) => entry.name === candidate.name);
  if (
    !group ||
    JSON.stringify(candidate.categories) !== JSON.stringify(group.categories) ||
    !DIGEST_PATTERN.test(candidate.digest ?? '') ||
    ![
      candidate.entries,
      candidate.directories,
      candidate.files,
      candidate.bytes,
    ].every(
      (number) => Number.isSafeInteger(number) && (number as number) >= 0,
    ) ||
    candidate.entries !==
      (candidate.directories as number) + (candidate.files as number)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'manifest payload evidence is invalid',
    );
  }
  return value as LocalDataDirectoryPayloadEvidence;
}

function parseManifest(value: unknown): LocalDataDirectoryAdoptionManifest {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'createdAtMs',
      'dataRootPathDigest',
      'kind',
      'manifestDigest',
      'payload',
      'planDigest',
      'profile',
      'schemaVersion',
      'sqliteActivationDigest',
      'sqliteAdoptionManifestDigest',
      'stagingRootPathDigest',
      'state',
    ])
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staging manifest shape is invalid',
    );
  }
  const manifest = value as Partial<LocalDataDirectoryAdoptionManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'qinglong3-legacy-data-directory-adoption' ||
    manifest.state !== 'staged' ||
    (manifest.profile !== 'edge' && manifest.profile !== 'standalone') ||
    !Number.isSafeInteger(manifest.createdAtMs) ||
    (manifest.createdAtMs as number) < 0 ||
    ![
      manifest.manifestDigest,
      manifest.planDigest,
      manifest.sqliteActivationDigest,
      manifest.sqliteAdoptionManifestDigest,
      manifest.dataRootPathDigest,
      manifest.stagingRootPathDigest,
    ].every(
      (digest) => typeof digest === 'string' && DIGEST_PATTERN.test(digest),
    ) ||
    !Array.isArray(manifest.payload) ||
    manifest.payload.length !== PAYLOAD_GROUPS.length
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staging manifest value is invalid',
    );
  }
  const parsedPayload = manifest.payload.map(parsePayloadEvidence);
  if (
    JSON.stringify(parsedPayload.map((entry) => entry.name)) !==
    JSON.stringify(PAYLOAD_GROUPS.map((entry) => entry.name))
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staging manifest payload order is invalid',
    );
  }
  const { manifestDigest, ...payload } =
    manifest as LocalDataDirectoryAdoptionManifest;
  if (sha256Text(JSON.stringify(payload)) !== manifestDigest) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staging manifest digest does not match',
    );
  }
  return manifest as LocalDataDirectoryAdoptionManifest;
}

function readManifest(
  stagingRoot: string,
  uid: number,
): Readonly<LocalDataDirectoryAdoptionManifest> {
  const manifestPath = path.join(stagingRoot, MANIFEST_NAME);
  const stat = fs.lstatSync(manifestPath, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(uid) ||
    (stat.mode & 0o777n) !== 0o600n ||
    stat.size < 1n ||
    stat.size > BigInt(MAX_MANIFEST_BYTES)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staging manifest identity, mode, or size is invalid',
    );
  }
  const descriptor = fs.openSync(
    manifestPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(stat, before)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'staging manifest identity changed before reading',
      );
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    if (!sameStat(before, fs.fstatSync(descriptor, { bigint: true }))) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'staging manifest changed while reading',
      );
    }
    return parseManifest(JSON.parse(content));
  } catch (error) {
    if (error instanceof LocalDataDirectoryAdoptionConfigurationError) {
      throw error;
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staging manifest JSON is invalid',
      error,
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertCompleteRoot(stagingRoot: string): void {
  if (
    JSON.stringify(sortedNames(stagingRoot)) !==
    JSON.stringify([MANIFEST_NAME, 'payload'].sort())
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staging root is incomplete or contains unexpected entries',
    );
  }
}

export function verifyStaticStage(
  authority: Readonly<RootAuthority>,
  expectedManifestDigest: string,
): Readonly<LocalDataDirectoryAdoptionManifest> {
  const rootBefore = assertPrivateDirectory(
    authority.stagingRoot,
    authority.uid,
    'stagingRoot',
  );
  assertCompleteRoot(authority.stagingRoot);
  const manifest = readManifest(authority.stagingRoot, authority.uid);
  if (manifest.manifestDigest !== expectedManifestDigest) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staging manifest no longer matches the reviewed digest',
    );
  }
  if (
    manifest.dataRootPathDigest !== sha256Text(authority.dataRoot) ||
    manifest.stagingRootPathDigest !== sha256Text(authority.stagingRoot)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staging manifest path binding is invalid',
    );
  }
  const actualPayload = inspectPayload(authority.stagingRoot, authority.uid);
  if (JSON.stringify(actualPayload) !== JSON.stringify(manifest.payload)) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staged payload no longer matches the manifest',
    );
  }
  if (
    !sameStat(rootBefore, fs.lstatSync(authority.stagingRoot, { bigint: true }))
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'staging root changed during verification',
    );
  }
  return manifest;
}

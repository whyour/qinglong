/** Private staged Prompt Output key rotation input authority boundary. */
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';

import type { ClusterPromptOutputKubernetesSecretKeyringOptions } from './promptOutputKubernetesSecretKeyring';

const MAX_COMMAND_FILE_BYTES = 16 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface ClusterPromptOutputKeyRotationCommand {
  readonly schemaVersion: 1;
  readonly operation: 'cluster.prompt-output-key.rotate';
  readonly kubernetes: ClusterPromptOutputKubernetesSecretKeyringOptions;
  readonly stagedMaterialFile: string;
  readonly request: Readonly<{
    rotationId: string;
    requestId: string;
    mutationId: string;
    expectedActiveKeyId: string;
    expectedCatalogDigest: string;
    newKeyId: string;
  }>;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function absoluteFilePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function readClusterPromptOutputKeyRotationCommand(
  filePathValue: string,
): Readonly<ClusterPromptOutputKeyRotationCommand> {
  const filePath = absoluteFilePath(
    filePathValue,
    'Rotation command file path',
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_COMMAND_FILE_BYTES) {
      throw new TypeError('Rotation command file is invalid');
    }
    const parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !exactKeys(parsed, [
        'kubernetes',
        'operation',
        'request',
        'schemaVersion',
        'stagedMaterialFile',
      ])
    ) {
      throw new TypeError('Rotation command shape is invalid');
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.schemaVersion !== 1 ||
      candidate.operation !== 'cluster.prompt-output-key.rotate' ||
      !candidate.kubernetes ||
      typeof candidate.kubernetes !== 'object' ||
      Array.isArray(candidate.kubernetes) ||
      !candidate.request ||
      typeof candidate.request !== 'object' ||
      Array.isArray(candidate.request)
    ) {
      throw new TypeError('Rotation command value is invalid');
    }
    const kubernetes = candidate.kubernetes as Record<string, unknown>;
    const request = candidate.request as Record<string, unknown>;
    if (
      !exactKeys(kubernetes, [
        'dataKey',
        'expectedSecretUid',
        'namespace',
        'secretName',
      ]) ||
      !exactKeys(request, [
        'expectedActiveKeyId',
        'expectedCatalogDigest',
        'mutationId',
        'newKeyId',
        'requestId',
        'rotationId',
      ]) ||
      ![
        request.rotationId,
        request.requestId,
        request.mutationId,
        request.expectedActiveKeyId,
        request.newKeyId,
      ].every((value) => typeof value === 'string' && ID.test(value)) ||
      typeof request.expectedCatalogDigest !== 'string' ||
      !DIGEST.test(request.expectedCatalogDigest)
    ) {
      throw new TypeError('Rotation command nested value is invalid');
    }
    const stagedMaterialFile = absoluteFilePath(
      candidate.stagedMaterialFile,
      'Staged material file path',
    );
    return Object.freeze({
      ...(parsed as ClusterPromptOutputKeyRotationCommand),
      stagedMaterialFile,
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readClusterPromptOutputKeyRotationMaterial(
  filePathValue: string,
): Buffer {
  const filePath = absoluteFilePath(filePathValue, 'Staged material file path');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== 32 ||
      (before.mode & 0o222) !== 0 ||
      (before.mode & 0o111) !== 0 ||
      (before.mode & 0o007) !== 0 ||
      (before.mode & 0o440) === 0
    ) {
      throw new TypeError('Staged rotation material is unavailable');
    }
    const material = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      material.byteLength !== 32 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      material.fill(0);
      throw new TypeError('Staged rotation material changed during read');
    }
    return material;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

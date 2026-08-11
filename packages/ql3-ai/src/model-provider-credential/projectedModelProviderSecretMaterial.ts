import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, relative } from 'node:path';

import { parseSecretRef } from '@qinglong/runtime-core/secret-reference';

import {
  MAX_MODEL_PROVIDER_AUTHORIZATION_BYTES,
  type ModelProviderSecretMaterial,
  type ModelProviderSecretMaterialProvider,
  type ModelProviderSecretMaterialRequest,
} from './providerCredential';

const MAX_ROOT_DIRECTORY_BYTES = 4096;
const SECRET_FILE_NAME = /^[0-9a-f]{64}$/;

export interface ProjectedModelProviderSecretMaterialOptions {
  /**
   * Direct read-only volume root. Each key is the lowercase SHA-256 of one
   * canonical SecretRef. Kubernetes atomic-writer symlinks are accepted only
   * when their resolved regular file remains below this root.
   */
  readonly rootDirectory: string;
}

export class ProjectedModelProviderSecretMaterialUnavailableError extends Error {
  readonly code = 'PROJECTED_MODEL_PROVIDER_SECRET_MATERIAL_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Projected model provider Secret material is unavailable', options);
    this.name = 'ProjectedModelProviderSecretMaterialUnavailableError';
  }
}

function unavailable(
  cause?: unknown,
): ProjectedModelProviderSecretMaterialUnavailableError {
  return new ProjectedModelProviderSecretMaterialUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function rootDirectory(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    parse(value).root === value ||
    normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_ROOT_DIRECTORY_BYTES
  ) {
    throw unavailable();
  }
  return value;
}

function remainsBelow(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return (
    suffix.length > 0 &&
    !isAbsolute(suffix) &&
    suffix !== '..' &&
    !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

async function resolvedRoot(configuredRoot: string): Promise<string> {
  try {
    const stat = await lstat(configuredRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    return await realpath(configuredRoot);
  } catch (cause) {
    throw cause instanceof ProjectedModelProviderSecretMaterialUnavailableError
      ? cause
      : unavailable(cause);
  }
}

export function projectedModelProviderSecretFileName(
  secretRef: string,
): string {
  try {
    parseSecretRef(secretRef);
  } catch (cause) {
    throw unavailable(cause);
  }
  const result = createHash('sha256').update(secretRef, 'utf8').digest('hex');
  if (!SECRET_FILE_NAME.test(result)) throw unavailable();
  return result;
}

function normalizeRequest(
  value: Readonly<ModelProviderSecretMaterialRequest>,
): Readonly<ModelProviderSecretMaterialRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw unavailable();
  }
  const expected = ['projectId', 'secretRef'];
  if (value.signal !== undefined) expected.push('signal');
  if (
    Object.keys(value).sort().join('\0') !== expected.sort().join('\0') ||
    typeof value.projectId !== 'string' ||
    value.projectId.length < 1 ||
    Buffer.byteLength(value.projectId, 'utf8') > 128 ||
    (value.signal !== undefined && typeof value.signal.aborted !== 'boolean')
  ) {
    throw unavailable();
  }
  try {
    if (parseSecretRef(value.secretRef).projectId !== value.projectId) {
      throw unavailable();
    }
  } catch (cause) {
    throw cause instanceof ProjectedModelProviderSecretMaterialUnavailableError
      ? cause
      : unavailable(cause);
  }
  if (value.signal?.aborted) throw unavailable(value.signal.reason);
  return Object.freeze({
    projectId: value.projectId,
    secretRef: value.secretRef,
    ...(value.signal === undefined ? {} : { signal: value.signal }),
  });
}

async function readMaterial(
  configuredRoot: string,
  secretRef: string,
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer | undefined;
  try {
    const root = await resolvedRoot(configuredRoot);
    const candidate = join(
      root,
      projectedModelProviderSecretFileName(secretRef),
    );
    const target = await realpath(candidate);
    if (!remainsBelow(root, target)) throw unavailable();
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > MAX_MODEL_PROVIDER_AUTHORIZATION_BYTES ||
      (before.mode & 0o222) !== 0 ||
      (before.mode & 0o111) !== 0 ||
      (before.mode & 0o007) !== 0 ||
      (before.mode & 0o440) === 0
    ) {
      throw unavailable();
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      (await realpath(candidate)) !== target ||
      (await realpath(configuredRoot)) !== root
    ) {
      throw unavailable();
    }
    const owned = bytes;
    bytes = undefined;
    return owned;
  } catch (cause) {
    throw cause instanceof ProjectedModelProviderSecretMaterialUnavailableError
      ? cause
      : unavailable(cause);
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Zero-client, zero-cache Cluster material provider for Kubernetes Secret,
 * CSI, or Secret-operator projections. Every authorization reopens exactly one
 * bounded file, so an atomic projection replacement rotates an unpinned
 * SecretRef without a watcher, timer, API credential, or process restart.
 */
export class ProjectedModelProviderSecretMaterialProvider
  implements ModelProviderSecretMaterialProvider
{
  readonly #rootDirectory: string;

  constructor(options: ProjectedModelProviderSecretMaterialOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw unavailable();
    }
    this.#rootDirectory = rootDirectory(options.rootDirectory);
  }

  async verify(): Promise<void> {
    await resolvedRoot(this.#rootDirectory);
  }

  async resolveProjectSecretMaterial(
    requestValue: Readonly<ModelProviderSecretMaterialRequest>,
  ): Promise<Readonly<ModelProviderSecretMaterial>> {
    const request = normalizeRequest(requestValue);
    const bytes = await readMaterial(this.#rootDirectory, request.secretRef);
    if (request.signal?.aborted) {
      bytes.fill(0);
      throw unavailable(request.signal.reason);
    }
    let disposed = false;
    return Object.freeze({
      secretRef: request.secretRef,
      bytes,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        bytes.fill(0);
      },
    });
  }
}

export async function createProjectedModelProviderSecretMaterialProvider(
  options: ProjectedModelProviderSecretMaterialOptions,
): Promise<Readonly<ProjectedModelProviderSecretMaterialProvider>> {
  const provider = new ProjectedModelProviderSecretMaterialProvider(options);
  await provider.verify();
  return provider;
}

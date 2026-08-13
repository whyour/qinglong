import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, relative } from 'node:path';

import { secretProjectionFileName } from '@qinglong/runtime-core/secret-projection';
import { parseSecretRef } from '@qinglong/runtime-core/secret-reference';

const MAX_SECRET_ROOT_BYTES = 4096;

export interface PluginPackageSecretExistenceInspector {
  assertExists(secretRefs: readonly string[]): Promise<void>;
}

export interface ProjectedPluginPackageSecretExistenceInspectorOptions {
  readonly rootDirectory: string;
}

export class ProjectedPluginPackageSecretExistenceError extends Error {
  readonly code = 'QL3_PROJECTED_PLUGIN_PACKAGE_SECRET_UNAVAILABLE';

  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'root_unavailable'
      | 'reference_unavailable',
    options?: ErrorOptions,
  ) {
    super(`Projected Plugin Package Secret failed: ${reason}`, options);
    this.name = 'ProjectedPluginPackageSecretExistenceError';
  }
}

function rootDirectory(value: string): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    parse(value).root === value ||
    normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_SECRET_ROOT_BYTES
  ) {
    throw new ProjectedPluginPackageSecretExistenceError(
      'invalid_configuration',
    );
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

async function resolvedRoot(path: string): Promise<string> {
  try {
    const configured = await lstat(path);
    if (!configured.isDirectory() || configured.isSymbolicLink()) {
      throw new Error('root is not a direct directory');
    }
    return await realpath(path);
  } catch (error) {
    throw new ProjectedPluginPackageSecretExistenceError('root_unavailable', {
      cause: error,
    });
  }
}

async function assertProjectedReference(
  root: string,
  secretRef: string,
): Promise<void> {
  try {
    const reference = parseSecretRef(secretRef);
    if (reference.version === undefined) {
      throw new Error('projected Secret reference is not versioned');
    }
    const candidate = join(root, secretProjectionFileName(secretRef));
    const target = await realpath(candidate);
    if (!remainsBelow(root, target)) {
      throw new Error('projected Secret escaped its root');
    }
    const metadata = await stat(target);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size < 0 ||
      (metadata.mode & 0o111) !== 0 ||
      (await realpath(candidate)) !== target
    ) {
      throw new Error('projected Secret metadata is unsafe');
    }
  } catch (error) {
    throw new ProjectedPluginPackageSecretExistenceError(
      'reference_unavailable',
      { cause: error },
    );
  }
}

/**
 * Metadata-only existence proof for the short-lived Package executor. It never
 * opens or reads projected Secret material and retains no cache or watcher.
 */
export class ProjectedPluginPackageSecretExistenceInspector
  implements PluginPackageSecretExistenceInspector
{
  private readonly rootDirectory: string;

  constructor(options: ProjectedPluginPackageSecretExistenceInspectorOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new ProjectedPluginPackageSecretExistenceError(
        'invalid_configuration',
      );
    }
    this.rootDirectory = rootDirectory(options.rootDirectory);
  }

  async assertExists(secretRefs: readonly string[]): Promise<void> {
    if (
      !Array.isArray(secretRefs) ||
      secretRefs.length < 1 ||
      secretRefs.length > 64 ||
      new Set(secretRefs).size !== secretRefs.length
    ) {
      throw new ProjectedPluginPackageSecretExistenceError(
        'reference_unavailable',
      );
    }
    const root = await resolvedRoot(this.rootDirectory);
    for (const secretRef of secretRefs) {
      await assertProjectedReference(root, secretRef);
    }
  }
}

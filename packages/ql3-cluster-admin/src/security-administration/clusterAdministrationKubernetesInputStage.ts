import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  sep,
} from 'node:path';

const INPUTS = Object.freeze([
  Object.freeze({ name: 'command.json', maximumBytes: 64 * 1024 }),
  Object.freeze({ name: 'assertion.jwt', maximumBytes: 16 * 1024 }),
  Object.freeze({ name: 'keyset.json', maximumBytes: 256 * 1024 }),
  Object.freeze({ name: 'pepper', maximumBytes: 256 }),
]);

export interface ClusterAdministrationKubernetesInputStagePaths {
  readonly sourceDirectory: string;
  readonly targetDirectory: string;
  readonly deliveryDirectory?: string;
}

export interface ClusterAdministrationKubernetesInputStageResult {
  readonly schemaVersion: 1;
  readonly component: 'qinglong3-security-administration-kubernetes-input-stage';
  readonly stagedFileCount: 4;
  readonly deliveryDirectoryPrepared: boolean;
}

export class ClusterAdministrationKubernetesInputStageError extends TypeError {
  readonly code = 'QL3_CLUSTER_ADMINISTRATION_KUBERNETES_INPUT_STAGE_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(
      `Cluster administration Kubernetes input stage is invalid: ${message}`,
    );
    this.name = 'ClusterAdministrationKubernetesInputStageError';
  }
}

function exactObject(
  value: unknown,
): asserts value is ClusterAdministrationKubernetesInputStagePaths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterAdministrationKubernetesInputStageError(
      'paths must be an object',
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [
    'sourceDirectory',
    'targetDirectory',
    ...('deliveryDirectory' in value ? ['deliveryDirectory'] : []),
  ].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ClusterAdministrationKubernetesInputStageError(
      'paths shape is invalid',
    );
  }
}

function directoryPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    parse(value).root === value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4_096
  ) {
    throw new ClusterAdministrationKubernetesInputStageError(
      `${label} must be a normalized absolute non-root path`,
    );
  }
  return value;
}

function sameFileState(
  left: Readonly<{
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  }>,
  right: Readonly<{
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  }>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function isClusterAdministrationProjectedSourceDirectoryAuthority(
  status: Readonly<{ mode: number; uid: number }>,
): boolean {
  const permissions = status.mode & 0o1777;
  return (
    (permissions & 0o002) === 0 ||
    (status.uid === 0 && permissions === 0o1777)
  );
}

function verifySourceDirectory(sourceDirectory: string): string {
  const status = lstatSync(sourceDirectory, { throwIfNoEntry: false });
  if (
    status === undefined ||
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    !isClusterAdministrationProjectedSourceDirectoryAuthority(status)
  ) {
    throw new ClusterAdministrationKubernetesInputStageError(
      'projected source directory authority is invalid',
    );
  }
  try {
    return realpathSync(sourceDirectory);
  } catch (error) {
    throw new ClusterAdministrationKubernetesInputStageError(
      'projected source directory cannot be resolved',
      error,
    );
  }
}

function confinedSourceFile(
  sourceDirectory: string,
  sourceRealDirectory: string,
  name: string,
): string {
  const candidate = join(sourceDirectory, name);
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch (error) {
    throw new ClusterAdministrationKubernetesInputStageError(
      'projected input cannot be resolved',
      error,
    );
  }
  const pathFromSource = relative(sourceRealDirectory, resolved);
  if (
    pathFromSource === '' ||
    pathFromSource === '..' ||
    pathFromSource.startsWith(`..${sep}`) ||
    isAbsolute(pathFromSource)
  ) {
    throw new ClusterAdministrationKubernetesInputStageError(
      'projected input escapes its source directory',
    );
  }
  return resolved;
}

function readStableSourceFile(filePath: string, maximumBytes: number): Buffer {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maximumBytes ||
      (before.mode & 0o027) !== 0
    ) {
      throw new ClusterAdministrationKubernetesInputStageError(
        'projected input file authority is invalid',
      );
    }
    bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== before.size || !sameFileState(before, after)) {
      throw new ClusterAdministrationKubernetesInputStageError(
        'projected input changed while being read',
      );
    }
    return bytes.subarray(0, offset);
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof ClusterAdministrationKubernetesInputStageError) {
      throw error;
    }
    throw new ClusterAdministrationKubernetesInputStageError(
      'projected input cannot be read',
      error,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function verifyPrivateDirectory(directory: string, label: string): void {
  const status = lstatSync(directory, { throwIfNoEntry: false });
  const effectiveUser = process.geteuid?.();
  if (
    status === undefined ||
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o777) !== 0o700 ||
    (effectiveUser !== undefined && status.uid !== effectiveUser)
  ) {
    throw new ClusterAdministrationKubernetesInputStageError(
      `${label} authority is invalid`,
    );
  }
}

function verifyWritableParent(parent: string, label: string): void {
  const status = lstatSync(parent, { throwIfNoEntry: false });
  if (
    status === undefined ||
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    !isClusterAdministrationProjectedSourceDirectoryAuthority(status)
  ) {
    throw new ClusterAdministrationKubernetesInputStageError(
      `${label} parent authority is invalid`,
    );
  }
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function createPrivateDirectory(directory: string, label: string): void {
  const parent = dirname(directory);
  verifyWritableParent(parent, label);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    throw new ClusterAdministrationKubernetesInputStageError(
      `${label} cannot be created`,
      error,
    );
  }
  try {
    verifyPrivateDirectory(directory, label);
    syncDirectory(parent);
  } catch (error) {
    try {
      rmdirSync(directory);
    } catch {
      // Preserve the original authority failure.
    }
    throw error;
  }
}

function prepareDeliveryDirectory(directory: string): void {
  verifyWritableParent(dirname(directory), 'delivery directory');
  const existing = lstatSync(directory, { throwIfNoEntry: false });
  if (existing === undefined) {
    createPrivateDirectory(directory, 'delivery directory');
    return;
  }
  verifyPrivateDirectory(directory, 'delivery directory');
}

function publishPrivateFile(filePath: string, bytes: Buffer): void {
  const temporary = `${filePath}.stage`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
    }
    fsyncSync(descriptor);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.size !== bytes.length ||
      (status.mode & 0o077) !== 0
    ) {
      throw new ClusterAdministrationKubernetesInputStageError(
        'private staged input file authority is invalid',
      );
    }
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, filePath);
    unlinkSync(temporary);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original publication failure.
    }
    if (error instanceof ClusterAdministrationKubernetesInputStageError) {
      throw error;
    }
    throw new ClusterAdministrationKubernetesInputStageError(
      'private staged input cannot be published',
      error,
    );
  }
}

export function stageClusterAdministrationKubernetesInputs(
  pathsValue: ClusterAdministrationKubernetesInputStagePaths,
): Readonly<ClusterAdministrationKubernetesInputStageResult> {
  exactObject(pathsValue);
  const sourceDirectory = directoryPath(
    pathsValue.sourceDirectory,
    'sourceDirectory',
  );
  const targetDirectory = directoryPath(
    pathsValue.targetDirectory,
    'targetDirectory',
  );
  const deliveryDirectory =
    pathsValue.deliveryDirectory === undefined
      ? undefined
      : directoryPath(pathsValue.deliveryDirectory, 'deliveryDirectory');
  if (
    sourceDirectory === targetDirectory ||
    sourceDirectory === deliveryDirectory ||
    targetDirectory === deliveryDirectory
  ) {
    throw new ClusterAdministrationKubernetesInputStageError(
      'source, target and delivery directories must be distinct',
    );
  }

  const sourceRealDirectory = verifySourceDirectory(sourceDirectory);
  if (lstatSync(targetDirectory, { throwIfNoEntry: false }) !== undefined) {
    throw new ClusterAdministrationKubernetesInputStageError(
      'target directory must not already exist',
    );
  }
  createPrivateDirectory(targetDirectory, 'target directory');
  const published: string[] = [];
  try {
    for (const input of INPUTS) {
      const sourceFile = confinedSourceFile(
        sourceDirectory,
        sourceRealDirectory,
        input.name,
      );
      const bytes = readStableSourceFile(sourceFile, input.maximumBytes);
      const targetFile = join(targetDirectory, input.name);
      try {
        publishPrivateFile(targetFile, bytes);
        published.push(targetFile);
      } finally {
        bytes.fill(0);
      }
    }
    syncDirectory(targetDirectory);
    if (deliveryDirectory !== undefined) {
      prepareDeliveryDirectory(deliveryDirectory);
    }
    return Object.freeze({
      schemaVersion: 1,
      component: 'qinglong3-security-administration-kubernetes-input-stage',
      stagedFileCount: 4,
      deliveryDirectoryPrepared: deliveryDirectory !== undefined,
    });
  } catch (error) {
    for (const targetFile of published.reverse()) {
      try {
        unlinkSync(targetFile);
      } catch {
        // The failed stage remains fail-closed and the Pod never starts main.
      }
    }
    try {
      syncDirectory(targetDirectory);
      rmdirSync(targetDirectory);
    } catch {
      // Preserve the original staging failure.
    }
    throw error;
  }
}

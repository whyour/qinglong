import fs from 'node:fs';
import path from 'node:path';

import {
  inspectLegacySqlitePath,
  prepareLocalSqliteActivation,
  stageLocalSqliteAdoption,
  verifyLocalSqliteAdoption,
  type LegacySqliteAdoptionPlan,
  type LocalSqliteActivation,
  type LocalSqliteAdoptionManifest,
} from '@qinglong/local-admin';

import {
  LocalSqliteAdoptionCliConfigurationError,
  normalizeLocalSqliteAdoptionProductCommand,
  type LocalSqliteAdoptionProductCommand,
} from './contract';

interface StableFileIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
  readonly mode: number;
  readonly uid: number;
}

interface StableDirectoryIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: number;
  readonly uid: number;
}

export type LocalSqliteAdoptionProductCommandResult = Readonly<{
  schemaVersion: 1;
  operation: LocalSqliteAdoptionProductCommand['operation'];
  status: 'inspected' | 'staged' | 'verified' | 'prepared';
  evidence: Readonly<Record<string, unknown>>;
}>;

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'real and effective POSIX users must match',
    );
  }
  return process.getuid();
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function directoryIdentity(
  directoryPath: string,
  uid: number,
  label: string,
): StableDirectoryIdentity {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directoryPath, { bigint: true });
  } catch (error) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      `${label} is unavailable`,
      error,
    );
  }
  const mode = Number(stat.mode) & 0o777;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    mode !== 0o700 ||
    fs.realpathSync(directoryPath) !== directoryPath
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      `${label} must be an owner-controlled 0700 canonical directory`,
    );
  }
  return Object.freeze({
    path: directoryPath,
    device: stat.dev,
    inode: stat.ino,
    mode,
    uid,
  });
}

function fileIdentity(
  filePath: string,
  uid: number,
  label: string,
  requirePrivateMode: boolean,
): StableFileIdentity {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      `${label} is unavailable`,
      error,
    );
  }
  const mode = Number(stat.mode) & 0o777;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    Number(stat.uid) !== uid ||
    (requirePrivateMode ? mode !== 0o600 : (mode & 0o022) !== 0) ||
    fs.realpathSync(filePath) !== filePath ||
    stat.size < 1n
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      `${label} identity or mode is invalid`,
    );
  }
  return Object.freeze({
    path: filePath,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNs: stat.mtimeNs,
    changedAtNs: stat.ctimeNs,
    mode,
    uid,
  });
}

function sameDirectory(expected: StableDirectoryIdentity): void {
  const actual = directoryIdentity(
    expected.path,
    expected.uid,
    'authority directory',
  );
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.mode !== expected.mode
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'authority directory changed during command execution',
    );
  }
}

function sameFile(expected: StableFileIdentity): void {
  const actual = fileIdentity(
    expected.path,
    expected.uid,
    'authority file',
    expected.mode === 0o600,
  );
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.size !== expected.size ||
    actual.modifiedAtNs !== expected.modifiedAtNs ||
    actual.changedAtNs !== expected.changedAtNs ||
    actual.mode !== expected.mode
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'authority file changed during command execution',
    );
  }
}

function assertMissing(filePath: string, label: string): void {
  try {
    fs.lstatSync(filePath);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw new LocalSqliteAdoptionCliConfigurationError(
      `${label} cannot be inspected`,
      error,
    );
  }
  throw new LocalSqliteAdoptionCliConfigurationError(
    `${label} must not already exist`,
  );
}

function authorityProof(command: Readonly<LocalSqliteAdoptionProductCommand>): {
  readonly uid: number;
  verify(): void;
  verifyCreated(paths: readonly string[]): void;
} {
  const uid = currentUid();
  const options = command.options;
  const root = directoryIdentity(options.deploymentRoot, uid, 'deploymentRoot');
  const sourcePaths =
    'sourcePath' in options ? [options.sourcePath] : ([] as string[]);
  const immutablePaths = [
    ...sourcePaths,
    ...(command.operation === 'local-sqlite.adoption.verify' ||
    command.operation === 'local-sqlite.activation.prepare'
      ? [
          command.options.targetPath,
          command.options.recoveryPath,
          command.options.manifestPath,
        ]
      : []),
  ];
  const files = immutablePaths.map((candidate) =>
    fileIdentity(
      candidate,
      uid,
      candidate === ('sourcePath' in options ? options.sourcePath : undefined)
        ? 'legacy source'
        : 'adoption evidence',
      candidate !== ('sourcePath' in options ? options.sourcePath : undefined),
    ),
  );
  const outputPaths =
    command.operation === 'local-sqlite.adoption.stage'
      ? [
          command.options.targetPath,
          command.options.recoveryPath,
          command.options.manifestPath,
        ]
      : command.operation === 'local-sqlite.activation.prepare'
      ? [command.options.activationPath]
      : [];
  const outputDirectories = [...new Set(outputPaths.map(path.dirname))].map(
    (directory) => {
      if (
        !inside(options.deploymentRoot, directory) &&
        directory !== options.deploymentRoot
      ) {
        throw new LocalSqliteAdoptionCliConfigurationError(
          'adoption outputs must remain inside deploymentRoot',
        );
      }
      return directoryIdentity(directory, uid, 'output directory');
    },
  );
  for (const outputPath of outputPaths) {
    if (!inside(options.deploymentRoot, outputPath)) {
      throw new LocalSqliteAdoptionCliConfigurationError(
        'adoption outputs must remain inside deploymentRoot',
      );
    }
    assertMissing(outputPath, 'adoption output');
  }
  const uniqueFiles = new Set(
    files.map((entry) => `${entry.device}:${entry.inode}`),
  );
  if (uniqueFiles.size !== files.length) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'adoption authority files must not share an inode',
    );
  }
  return Object.freeze({
    uid,
    verify() {
      if (currentUid() !== uid) {
        throw new LocalSqliteAdoptionCliConfigurationError(
          'POSIX user changed during command execution',
        );
      }
      sameDirectory(root);
      for (const directory of outputDirectories) sameDirectory(directory);
      for (const file of files) sameFile(file);
    },
    verifyCreated(paths: readonly string[]) {
      for (const filePath of paths) {
        fileIdentity(filePath, uid, 'created adoption output', true);
      }
    },
  });
}

function planEvidence(plan: Readonly<LegacySqliteAdoptionPlan>) {
  return Object.freeze({
    profile: plan.profile,
    planDigest: plan.planDigest,
    source: Object.freeze({
      fileName: plan.source.fileName,
      pathDigest: plan.source.pathDigest,
      bytes: plan.source.bytes,
    }),
    catalog: Object.freeze({
      digest: plan.catalog.digest,
      objectCount: plan.catalog.objectCount,
      tableCount: plan.catalog.tableNames.length,
      tableNames: plan.catalog.tableNames,
    }),
    tasks: plan.tasks,
  });
}

function adoptionEvidence(manifest: Readonly<LocalSqliteAdoptionManifest>) {
  return Object.freeze({
    profile: manifest.profile,
    planDigest: manifest.planDigest,
    manifestDigest: manifest.manifestDigest,
    createdAtMs: manifest.createdAtMs,
    source: Object.freeze({
      fileName: manifest.source.fileName,
      pathDigest: manifest.source.pathDigest,
      bytes: manifest.source.bytes,
    }),
    catalog: Object.freeze({
      digest: manifest.catalog.digest,
      objectCount: manifest.catalog.objectCount,
      tableCount: manifest.catalog.tableNames.length,
    }),
    tasks: manifest.tasks,
    recovery: manifest.recovery,
    target: manifest.target,
    readiness: manifest.readiness,
  });
}

function activationEvidence(activation: Readonly<LocalSqliteActivation>) {
  return Object.freeze({ ...activation });
}

export async function runLocalSqliteAdoptionProductCommand(
  value: unknown,
): Promise<LocalSqliteAdoptionProductCommandResult> {
  const command = normalizeLocalSqliteAdoptionProductCommand(value);
  const proof = authorityProof(command);
  if (command.operation === 'local-sqlite.adoption.inspect') {
    const options = command.options;
    const plan = inspectLegacySqlitePath({
      sourcePath: options.sourcePath,
      profile: options.profile,
      ...(options.legacyTimezone === undefined
        ? {}
        : { legacyTimezone: options.legacyTimezone }),
    });
    proof.verify();
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      status: 'inspected',
      evidence: planEvidence(plan),
    });
  }
  if (command.operation === 'local-sqlite.adoption.stage') {
    const options = command.options;
    const manifest = await stageLocalSqliteAdoption({
      sourcePath: options.sourcePath,
      targetPath: options.targetPath,
      recoveryPath: options.recoveryPath,
      manifestPath: options.manifestPath,
      profile: options.profile,
      expectedPlanDigest: options.expectedPlanDigest,
      ...(options.legacyTimezone === undefined
        ? {}
        : { legacyTimezone: options.legacyTimezone }),
    });
    proof.verify();
    proof.verifyCreated([
      options.targetPath,
      options.recoveryPath,
      options.manifestPath,
    ]);
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      status: 'staged',
      evidence: adoptionEvidence(manifest),
    });
  }
  if (command.operation === 'local-sqlite.adoption.verify') {
    const options = command.options;
    const manifest = await verifyLocalSqliteAdoption({
      targetPath: options.targetPath,
      recoveryPath: options.recoveryPath,
      manifestPath: options.manifestPath,
    });
    if (manifest.profile !== options.profile) {
      throw new LocalSqliteAdoptionCliConfigurationError(
        'verified adoption profile drifted',
      );
    }
    proof.verify();
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      status: 'verified',
      evidence: adoptionEvidence(manifest),
    });
  }
  const options = command.options;
  const activation = await prepareLocalSqliteActivation({
    sourcePath: options.sourcePath,
    targetPath: options.targetPath,
    recoveryPath: options.recoveryPath,
    manifestPath: options.manifestPath,
    activationPath: options.activationPath,
    expectedManifestDigest: options.expectedManifestDigest,
  });
  if (activation.profile !== options.profile) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'prepared activation profile drifted',
    );
  }
  proof.verify();
  proof.verifyCreated([options.activationPath]);
  return Object.freeze({
    schemaVersion: 1,
    operation: command.operation,
    status: 'prepared',
    evidence: activationEvidence(activation),
  });
}

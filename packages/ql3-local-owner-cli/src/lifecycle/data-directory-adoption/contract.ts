import path from 'node:path';

const MAX_PATH_BYTES = 4_096;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export const LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION =
  'local-data-directory.adoption.inspect' as const;
export const LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION =
  'local-data-directory.adoption.stage' as const;
export const LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION =
  'local-data-directory.adoption.verify' as const;

export type LocalDataDirectoryAdoptionOperation =
  | typeof LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION
  | typeof LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION
  | typeof LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION;

export interface InspectLocalDataDirectoryAdoptionCommand {
  readonly schemaVersion: 1;
  readonly operation: typeof LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION;
  readonly options: {
    readonly dataRoot: string;
    readonly profile: 'edge' | 'standalone';
  };
}

export interface LocalDataDirectoryAdoptionSqliteBinding {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly recoveryPath: string;
  readonly manifestPath: string;
  readonly activationPath: string;
  readonly expectedActivationDigest: string;
}

interface LocalDataDirectoryAdoptionMutationOptions {
  readonly deploymentRoot: string;
  readonly dataRoot: string;
  readonly stagingRoot: string;
  readonly profile: 'edge' | 'standalone';
  readonly sqlite: LocalDataDirectoryAdoptionSqliteBinding;
}

export interface StageLocalDataDirectoryAdoptionCommand {
  readonly schemaVersion: 1;
  readonly operation: typeof LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION;
  readonly options: LocalDataDirectoryAdoptionMutationOptions & {
    readonly expectedPlanDigest: string;
  };
}

export interface VerifyLocalDataDirectoryAdoptionCommand {
  readonly schemaVersion: 1;
  readonly operation: typeof LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION;
  readonly options: LocalDataDirectoryAdoptionMutationOptions & {
    readonly expectedManifestDigest: string;
  };
}

export type LocalDataDirectoryAdoptionCommand =
  | InspectLocalDataDirectoryAdoptionCommand
  | StageLocalDataDirectoryAdoptionCommand
  | VerifyLocalDataDirectoryAdoptionCommand;

export class LocalDataDirectoryAdoptionConfigurationError extends TypeError {
  readonly code = 'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local data directory adoption configuration is invalid: ${message}`);
    this.name = 'LocalDataDirectoryAdoptionConfigurationError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function normalizedAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.isAbsolute(value) &&
    path.parse(value).root !== value &&
    path.normalize(value) === value &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES
  );
}

export function isLocalDataDirectoryAdoptionOperation(
  value: unknown,
): value is LocalDataDirectoryAdoptionOperation {
  return (
    value === LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION ||
    value === LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION ||
    value === LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION
  );
}

function normalizeSqliteBinding(
  value: unknown,
): Readonly<LocalDataDirectoryAdoptionSqliteBinding> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'activationPath',
      'expectedActivationDigest',
      'manifestPath',
      'recoveryPath',
      'sourcePath',
      'targetPath',
    ])
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'SQLite activation binding shape is invalid',
    );
  }
  const binding = value as Record<string, unknown>;
  for (const key of [
    'activationPath',
    'manifestPath',
    'recoveryPath',
    'sourcePath',
    'targetPath',
  ]) {
    if (!normalizedAbsolutePath(binding[key])) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'SQLite activation binding path is invalid',
      );
    }
  }
  if (
    typeof binding.expectedActivationDigest !== 'string' ||
    !DIGEST_PATTERN.test(binding.expectedActivationDigest)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'SQLite activation digest is invalid',
    );
  }
  if (
    new Set(
      [
        binding.activationPath,
        binding.manifestPath,
        binding.recoveryPath,
        binding.sourcePath,
        binding.targetPath,
      ].map((candidate) => path.resolve(candidate as string)),
    ).size !== 5
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'SQLite activation paths must be distinct',
    );
  }
  return Object.freeze(value as LocalDataDirectoryAdoptionSqliteBinding);
}

export function normalizeLocalDataDirectoryAdoptionCommand(
  value: unknown,
): Readonly<LocalDataDirectoryAdoptionCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['schemaVersion', 'operation', 'options'])
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'command shape is invalid',
    );
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    !isLocalDataDirectoryAdoptionOperation(candidate.operation) ||
    !candidate.options ||
    typeof candidate.options !== 'object' ||
    Array.isArray(candidate.options)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'command value is invalid',
    );
  }
  const options = candidate.options as Record<string, unknown>;
  const expectedKeys =
    candidate.operation === LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION
      ? ['dataRoot', 'profile']
      : candidate.operation === LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION
      ? [
          'dataRoot',
          'deploymentRoot',
          'expectedPlanDigest',
          'profile',
          'sqlite',
          'stagingRoot',
        ]
      : [
          'dataRoot',
          'deploymentRoot',
          'expectedManifestDigest',
          'profile',
          'sqlite',
          'stagingRoot',
        ];
  if (
    !exactKeys(options, expectedKeys) ||
    !normalizedAbsolutePath(options.dataRoot) ||
    (options.profile !== 'edge' && options.profile !== 'standalone')
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'command options are invalid',
    );
  }
  if (candidate.operation !== LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION) {
    if (
      !normalizedAbsolutePath(options.deploymentRoot) ||
      !normalizedAbsolutePath(options.stagingRoot)
    ) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'adoption root path is invalid',
      );
    }
    normalizeSqliteBinding(options.sqlite);
    const digest =
      candidate.operation === LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION
        ? options.expectedPlanDigest
        : options.expectedManifestDigest;
    if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'reviewed adoption digest is invalid',
      );
    }
  }
  return Object.freeze(value as LocalDataDirectoryAdoptionCommand);
}

export function normalizeInspectLocalDataDirectoryAdoptionCommand(
  value: unknown,
): Readonly<InspectLocalDataDirectoryAdoptionCommand> {
  const command = normalizeLocalDataDirectoryAdoptionCommand(value);
  if (command.operation !== LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'inspection operation is invalid',
    );
  }
  return command;
}

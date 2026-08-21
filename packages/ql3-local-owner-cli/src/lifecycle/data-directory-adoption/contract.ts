import path from 'node:path';

const MAX_PATH_BYTES = 4_096;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION =
  'local-data-directory.adoption.inspect' as const;
export const LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION =
  'local-data-directory.adoption.stage' as const;
export const LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION =
  'local-data-directory.adoption.verify' as const;
export const LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_OPERATION =
  'local-data-directory.adoption.transform' as const;
export const LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_VERIFY_OPERATION =
  'local-data-directory.adoption.transform.verify' as const;
export const LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_OPERATION =
  'local-data-directory.adoption.apply' as const;
export const LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_VERIFY_OPERATION =
  'local-data-directory.adoption.apply.verify' as const;

export type LocalDataDirectoryAdoptionOperation =
  | typeof LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION
  | typeof LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION
  | typeof LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION
  | typeof LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_OPERATION
  | typeof LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_VERIFY_OPERATION
  | typeof LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_OPERATION
  | typeof LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_VERIFY_OPERATION;

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

interface LocalDataDirectoryAdoptionTransformationOptions
  extends LocalDataDirectoryAdoptionMutationOptions {
  readonly transformationRoot: string;
  readonly projectId: string;
  readonly expectedManifestDigest: string;
}

export interface TransformLocalDataDirectoryAdoptionCommand {
  readonly schemaVersion: 1;
  readonly operation: typeof LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_OPERATION;
  readonly options: LocalDataDirectoryAdoptionTransformationOptions;
}

export interface VerifyLocalDataDirectoryAdoptionTransformationCommand {
  readonly schemaVersion: 1;
  readonly operation: typeof LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_VERIFY_OPERATION;
  readonly options: LocalDataDirectoryAdoptionTransformationOptions & {
    readonly expectedTransformationDigest: string;
  };
}

interface LocalDataDirectoryAdoptionApplicationOptions
  extends LocalDataDirectoryAdoptionTransformationOptions {
  readonly expectedTransformationDigest: string;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly secretKeyringPath: string;
  readonly mutationId: string;
  readonly failureAuditEventId: string;
  readonly requestId: string;
  readonly busyTimeoutMs?: number;
}

export interface ApplyLocalDataDirectoryAdoptionCommand {
  readonly schemaVersion: 1;
  readonly operation: typeof LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_OPERATION;
  readonly options: LocalDataDirectoryAdoptionApplicationOptions;
}

export interface VerifyLocalDataDirectoryAdoptionApplicationCommand {
  readonly schemaVersion: 1;
  readonly operation: typeof LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_VERIFY_OPERATION;
  readonly options: LocalDataDirectoryAdoptionApplicationOptions & {
    readonly expectedReceiptDigest: string;
  };
}

export type LocalDataDirectoryAdoptionCommand =
  | InspectLocalDataDirectoryAdoptionCommand
  | StageLocalDataDirectoryAdoptionCommand
  | VerifyLocalDataDirectoryAdoptionCommand
  | TransformLocalDataDirectoryAdoptionCommand
  | VerifyLocalDataDirectoryAdoptionTransformationCommand
  | ApplyLocalDataDirectoryAdoptionCommand
  | VerifyLocalDataDirectoryAdoptionApplicationCommand;

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
    value === LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION ||
    value === LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_OPERATION ||
    value === LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_VERIFY_OPERATION ||
    value === LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_OPERATION ||
    value === LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_VERIFY_OPERATION
  );
}

function descendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
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
  const application =
    candidate.operation === LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_OPERATION ||
    candidate.operation ===
      LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_VERIFY_OPERATION;
  let expectedKeys: readonly string[];
  if (candidate.operation === LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION) {
    expectedKeys = ['dataRoot', 'profile'];
  } else if (
    candidate.operation === LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION
  ) {
    expectedKeys = [
      'dataRoot',
      'deploymentRoot',
      'expectedPlanDigest',
      'profile',
      'sqlite',
      'stagingRoot',
    ];
  } else {
    expectedKeys = [
      'dataRoot',
      'deploymentRoot',
      'expectedManifestDigest',
      'profile',
      'sqlite',
      'stagingRoot',
      ...(candidate.operation === LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION
        ? []
        : ['projectId', 'transformationRoot']),
      ...(candidate.operation ===
        LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_VERIFY_OPERATION || application
        ? ['expectedTransformationDigest']
        : []),
      ...(application
        ? [
            'credentialFilePath',
            'failureAuditEventId',
            'mutationId',
            'ownerPepperKeyringDirectory',
            'requestId',
            'secretKeyringPath',
            ...(options.busyTimeoutMs === undefined ? [] : ['busyTimeoutMs']),
          ]
        : []),
      ...(candidate.operation ===
      LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_VERIFY_OPERATION
        ? ['expectedReceiptDigest']
        : []),
    ];
  }
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
    if (
      candidate.operation ===
        LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_OPERATION ||
      candidate.operation ===
        LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_VERIFY_OPERATION ||
      application
    ) {
      if (
        !normalizedAbsolutePath(options.transformationRoot) ||
        typeof options.projectId !== 'string' ||
        !PROJECT_ID_PATTERN.test(options.projectId)
      ) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'transformation target binding is invalid',
        );
      }
      if (
        (candidate.operation ===
          LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_VERIFY_OPERATION ||
          application) &&
        (typeof options.expectedTransformationDigest !== 'string' ||
          !DIGEST_PATTERN.test(options.expectedTransformationDigest))
      ) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'transformation digest is invalid',
        );
      }
      if (application) {
        for (const key of [
          'ownerPepperKeyringDirectory',
          'credentialFilePath',
          'secretKeyringPath',
        ]) {
          if (
            !normalizedAbsolutePath(options[key]) ||
            !descendant(
              options.deploymentRoot as string,
              options[key] as string,
            )
          ) {
            throw new LocalDataDirectoryAdoptionConfigurationError(
              'application authority path is invalid',
            );
          }
        }
        if (
          options.credentialFilePath === options.secretKeyringPath ||
          typeof options.mutationId !== 'string' ||
          !UUID_V4_PATTERN.test(options.mutationId) ||
          typeof options.failureAuditEventId !== 'string' ||
          !UUID_V4_PATTERN.test(options.failureAuditEventId) ||
          options.failureAuditEventId === options.mutationId ||
          typeof options.requestId !== 'string' ||
          !REQUEST_ID_PATTERN.test(options.requestId) ||
          (options.busyTimeoutMs !== undefined &&
            (!Number.isSafeInteger(options.busyTimeoutMs) ||
              (options.busyTimeoutMs as number) < 100 ||
              (options.busyTimeoutMs as number) > 30_000)) ||
          (candidate.operation ===
            LOCAL_DATA_DIRECTORY_ADOPTION_APPLY_VERIFY_OPERATION &&
            (typeof options.expectedReceiptDigest !== 'string' ||
              !DIGEST_PATTERN.test(options.expectedReceiptDigest)))
        ) {
          throw new LocalDataDirectoryAdoptionConfigurationError(
            'application authority binding is invalid',
          );
        }
      }
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

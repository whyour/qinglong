import path from 'node:path';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PATH_BYTES = 4_096;

export type LocalSqliteAdoptionProductOperation =
  | 'local-sqlite.adoption.inspect'
  | 'local-sqlite.adoption.stage'
  | 'local-sqlite.adoption.verify'
  | 'local-sqlite.activation.prepare';

interface LocalSqliteAdoptionCommandOptionsBase {
  readonly deploymentRoot: string;
  readonly profile: 'edge' | 'standalone';
}

export interface InspectLocalSqliteAdoptionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local-sqlite.adoption.inspect';
  readonly options: LocalSqliteAdoptionCommandOptionsBase & {
    readonly sourcePath: string;
    readonly legacyTimezone?: string;
  };
}

export interface StageLocalSqliteAdoptionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local-sqlite.adoption.stage';
  readonly options: LocalSqliteAdoptionCommandOptionsBase & {
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly recoveryPath: string;
    readonly manifestPath: string;
    readonly expectedPlanDigest: string;
    readonly legacyTimezone?: string;
  };
}

export interface VerifyLocalSqliteAdoptionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local-sqlite.adoption.verify';
  readonly options: LocalSqliteAdoptionCommandOptionsBase & {
    readonly targetPath: string;
    readonly recoveryPath: string;
    readonly manifestPath: string;
  };
}

export interface PrepareLocalSqliteActivationCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local-sqlite.activation.prepare';
  readonly options: LocalSqliteAdoptionCommandOptionsBase & {
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly recoveryPath: string;
    readonly manifestPath: string;
    readonly activationPath: string;
    readonly expectedManifestDigest: string;
  };
}

export type LocalSqliteAdoptionProductCommand =
  | InspectLocalSqliteAdoptionCommand
  | StageLocalSqliteAdoptionCommand
  | VerifyLocalSqliteAdoptionCommand
  | PrepareLocalSqliteActivationCommand;

export class LocalSqliteAdoptionCliConfigurationError extends TypeError {
  readonly code = 'LOCAL_SQLITE_ADOPTION_CLI_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local SQLite adoption CLI configuration is invalid: ${message}`);
    this.name = 'LocalSqliteAdoptionCliConfigurationError';
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

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function optionalTimezone(options: Record<string, unknown>): string[] {
  return options.legacyTimezone === undefined ? [] : ['legacyTimezone'];
}

function assertTimezone(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 128 ||
      /[\0\r\n]/.test(value))
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'legacyTimezone is invalid',
    );
  }
}

function assertDistinct(paths: readonly string[]): void {
  const resolved = paths.map((value) => path.resolve(value));
  if (new Set(resolved).size !== resolved.length) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'SQLite adoption paths must be distinct',
    );
  }
}

export function isLocalSqliteAdoptionProductOperation(
  value: unknown,
): value is LocalSqliteAdoptionProductOperation {
  return (
    value === 'local-sqlite.adoption.inspect' ||
    value === 'local-sqlite.adoption.stage' ||
    value === 'local-sqlite.adoption.verify' ||
    value === 'local-sqlite.activation.prepare'
  );
}

export function normalizeLocalSqliteAdoptionProductCommand(
  value: unknown,
): Readonly<LocalSqliteAdoptionProductCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['schemaVersion', 'operation', 'options'])
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'command shape is invalid',
    );
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    !isLocalSqliteAdoptionProductOperation(candidate.operation) ||
    !candidate.options ||
    typeof candidate.options !== 'object' ||
    Array.isArray(candidate.options)
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'command value is invalid',
    );
  }
  const options = candidate.options as Record<string, unknown>;
  const expected =
    candidate.operation === 'local-sqlite.adoption.inspect'
      ? [
          'deploymentRoot',
          ...optionalTimezone(options),
          'profile',
          'sourcePath',
        ]
      : candidate.operation === 'local-sqlite.adoption.stage'
      ? [
          'deploymentRoot',
          'expectedPlanDigest',
          ...optionalTimezone(options),
          'manifestPath',
          'profile',
          'recoveryPath',
          'sourcePath',
          'targetPath',
        ]
      : candidate.operation === 'local-sqlite.adoption.verify'
      ? [
          'deploymentRoot',
          'manifestPath',
          'profile',
          'recoveryPath',
          'targetPath',
        ]
      : [
          'activationPath',
          'deploymentRoot',
          'expectedManifestDigest',
          'manifestPath',
          'profile',
          'recoveryPath',
          'sourcePath',
          'targetPath',
        ];
  if (
    !exactKeys(options, expected) ||
    (options.profile !== 'edge' && options.profile !== 'standalone')
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'command options are invalid',
    );
  }
  assertTimezone(options.legacyTimezone);
  boundedPath(options.deploymentRoot, 'deploymentRoot');
  for (const key of expected.filter((name) => name.endsWith('Path'))) {
    boundedPath(options[key], key);
  }
  if (
    candidate.operation === 'local-sqlite.adoption.stage' &&
    (typeof options.expectedPlanDigest !== 'string' ||
      !DIGEST_PATTERN.test(options.expectedPlanDigest))
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'expectedPlanDigest is invalid',
    );
  }
  if (
    candidate.operation === 'local-sqlite.activation.prepare' &&
    (typeof options.expectedManifestDigest !== 'string' ||
      !DIGEST_PATTERN.test(options.expectedManifestDigest))
  ) {
    throw new LocalSqliteAdoptionCliConfigurationError(
      'expectedManifestDigest is invalid',
    );
  }
  assertDistinct(
    [
      options.sourcePath,
      options.targetPath,
      options.recoveryPath,
      options.manifestPath,
      options.activationPath,
    ].filter((entry): entry is string => typeof entry === 'string'),
  );
  return Object.freeze(value as LocalSqliteAdoptionProductCommand);
}

import path from 'node:path';

const MAX_PATH_BYTES = 4_096;

export const LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION =
  'local-data-directory.adoption.inspect' as const;

export interface InspectLocalDataDirectoryAdoptionCommand {
  readonly schemaVersion: 1;
  readonly operation: typeof LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION;
  readonly options: {
    readonly dataRoot: string;
    readonly profile: 'edge' | 'standalone';
  };
}

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
): value is typeof LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION {
  return value === LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION;
}

export function normalizeInspectLocalDataDirectoryAdoptionCommand(
  value: unknown,
): Readonly<InspectLocalDataDirectoryAdoptionCommand> {
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
    Array.isArray(candidate.options) ||
    !exactKeys(candidate.options, ['dataRoot', 'profile'])
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'command value is invalid',
    );
  }
  const options = candidate.options as Record<string, unknown>;
  if (
    !normalizedAbsolutePath(options.dataRoot) ||
    (options.profile !== 'edge' && options.profile !== 'standalone')
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'command options are invalid',
    );
  }
  return Object.freeze(value as InspectLocalDataDirectoryAdoptionCommand);
}

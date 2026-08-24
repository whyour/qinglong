export const ENVIRONMENT_BUNDLE_SCHEMA =
  'qinglong/environment-bundle@v1' as const;
export const MAX_ENVIRONMENT_BUNDLE_ENTRIES = 256;
export const MAX_ENVIRONMENT_BUNDLE_VALUE_BYTES = 16 * 1024;
export const MAX_ENVIRONMENT_BUNDLE_TOTAL_BYTES = 64 * 1024;
export const MAX_ENVIRONMENT_BUNDLE_ENCODED_BYTES = 96 * 1024;

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface EnvironmentBundleEntry {
  readonly name: string;
  readonly value: string;
}

export interface EnvironmentBundle {
  readonly schema: typeof ENVIRONMENT_BUNDLE_SCHEMA;
  readonly entries: readonly EnvironmentBundleEntry[];
}

export class InvalidEnvironmentBundleError extends TypeError {
  readonly code = 'ENVIRONMENT_BUNDLE_INVALID';

  constructor(message: string) {
    super(`Environment bundle is invalid: ${message}`);
    this.name = 'InvalidEnvironmentBundleError';
  }
}

function invalid(message: string): never {
  throw new InvalidEnvironmentBundleError(message);
}

function dataObject(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    return invalid(`${label} must contain enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const canonical = [...expected].sort();
  if (
    actual.some((key) => typeof key !== 'string') ||
    actual.length !== canonical.length ||
    actual
      .map(String)
      .sort()
      .some((key, index) => key !== canonical[index])
  ) {
    return invalid(`${label} shape is invalid`);
  }
}

export function normalizeEnvironmentBundle(
  value: EnvironmentBundle,
): Readonly<EnvironmentBundle> {
  const bundle = dataObject(value, 'bundle');
  exactKeys(bundle, ['entries', 'schema'], 'bundle');
  if (bundle.schema !== ENVIRONMENT_BUNDLE_SCHEMA) {
    return invalid('schema is invalid');
  }
  if (
    !Array.isArray(bundle.entries) ||
    bundle.entries.length < 1 ||
    bundle.entries.length > MAX_ENVIRONMENT_BUNDLE_ENTRIES
  ) {
    return invalid('entry count is invalid');
  }
  const names = new Set<string>();
  let totalBytes = 0;
  const entries = bundle.entries.map((value, index) => {
    const entry = dataObject(value, `entries[${index}]`);
    exactKeys(entry, ['name', 'value'], `entries[${index}]`);
    if (
      typeof entry.name !== 'string' ||
      !ENVIRONMENT_NAME_PATTERN.test(entry.name) ||
      entry.name.startsWith('QL3_') ||
      names.has(entry.name)
    ) {
      return invalid(`entries[${index}].name is invalid or duplicated`);
    }
    if (
      typeof entry.value !== 'string' ||
      entry.value.includes('\0') ||
      Buffer.byteLength(entry.value, 'utf8') >
        MAX_ENVIRONMENT_BUNDLE_VALUE_BYTES
    ) {
      return invalid(`entries[${index}].value is invalid`);
    }
    names.add(entry.name);
    totalBytes +=
      Buffer.byteLength(entry.name, 'utf8') +
      Buffer.byteLength(entry.value, 'utf8');
    if (totalBytes > MAX_ENVIRONMENT_BUNDLE_TOTAL_BYTES) {
      return invalid('environment byte budget exceeded');
    }
    return Object.freeze({ name: entry.name, value: entry.value });
  });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const normalized = Object.freeze({
    schema: ENVIRONMENT_BUNDLE_SCHEMA,
    entries: Object.freeze(entries),
  });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_ENVIRONMENT_BUNDLE_ENCODED_BYTES
  ) {
    return invalid('encoded byte budget exceeded');
  }
  return normalized;
}

export function serializeEnvironmentBundle(value: EnvironmentBundle): string {
  return JSON.stringify(normalizeEnvironmentBundle(value));
}

export function parseEnvironmentBundle(
  serialized: string | Uint8Array,
): Readonly<EnvironmentBundle> {
  const bytes =
    typeof serialized === 'string'
      ? Buffer.from(serialized, 'utf8')
      : Buffer.from(serialized);
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > MAX_ENVIRONMENT_BUNDLE_ENCODED_BYTES
  ) {
    bytes.fill(0);
    return invalid('encoded byte size is outside the allowed range');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return invalid('payload is not valid JSON');
  } finally {
    bytes.fill(0);
  }
  return normalizeEnvironmentBundle(parsed as EnvironmentBundle);
}

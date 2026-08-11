export const SECRET_REF_PREFIX = 'qlsecret:v1:';
export const MAX_SECRET_REF_BYTES = 512;
export const MAX_SECRET_NAME_BYTES = 128;
export const MAX_SECRET_VERSION = 2_147_483_647;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface SecretReference {
  readonly projectId: string;
  readonly name: string;
  readonly version?: number;
}

export class InvalidSecretReferenceError extends TypeError {
  readonly code = 'SECRET_REFERENCE_INVALID';

  constructor(message: string) {
    super(`Secret reference is invalid: ${message}`);
    this.name = 'InvalidSecretReferenceError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function boundedIdentifier(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidSecretReferenceError(`${label} is invalid`);
  }
  return value;
}

function secretVersion(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_SECRET_VERSION
  ) {
    throw new InvalidSecretReferenceError('version is invalid');
  }
  return value as number;
}

export function createSecretRef(reference: SecretReference): string {
  if (
    !reference ||
    typeof reference !== 'object' ||
    Array.isArray(reference) ||
    !exactKeys(
      reference,
      reference.version === undefined
        ? ['projectId', 'name']
        : ['projectId', 'name', 'version'],
    )
  ) {
    throw new InvalidSecretReferenceError('shape is invalid');
  }
  const projectId = boundedIdentifier(reference.projectId, 'projectId', 128);
  const name = boundedIdentifier(reference.name, 'name', MAX_SECRET_NAME_BYTES);
  const version =
    reference.version === undefined
      ? undefined
      : secretVersion(reference.version);
  const payload = JSON.stringify({
    projectId,
    name,
    ...(version === undefined ? {} : { version }),
  });
  const result = `${SECRET_REF_PREFIX}${Buffer.from(payload, 'utf8').toString(
    'base64url',
  )}`;
  if (Buffer.byteLength(result, 'utf8') > MAX_SECRET_REF_BYTES) {
    throw new InvalidSecretReferenceError('byte budget exceeded');
  }
  return result;
}

export function parseSecretRef(value: unknown): SecretReference {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_SECRET_REF_BYTES ||
    !value.startsWith(SECRET_REF_PREFIX)
  ) {
    throw new InvalidSecretReferenceError('encoding is invalid');
  }
  const encoded = value.slice(SECRET_REF_PREFIX.length);
  if (encoded.length === 0 || !BASE64URL_PATTERN.test(encoded)) {
    throw new InvalidSecretReferenceError('encoding is invalid');
  }
  const decoded = Buffer.from(encoded, 'base64url');
  try {
    if (decoded.toString('base64url') !== encoded) {
      throw new InvalidSecretReferenceError('encoding is not canonical');
    }
    const parsed = JSON.parse(decoded.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidSecretReferenceError('payload is invalid');
    }
    const record = parsed as Record<string, unknown>;
    const reference: SecretReference = {
      projectId: record.projectId as string,
      name: record.name as string,
      ...(record.version === undefined
        ? {}
        : { version: record.version as number }),
    };
    if (createSecretRef(reference) !== value) {
      throw new InvalidSecretReferenceError('encoding is not canonical');
    }
    return Object.freeze(reference);
  } catch (error) {
    if (error instanceof InvalidSecretReferenceError) throw error;
    throw new InvalidSecretReferenceError('payload is invalid');
  } finally {
    decoded.fill(0);
  }
}

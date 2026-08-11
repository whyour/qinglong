import { MAX_EXECUTION_ENVIRONMENT_VALUE_BYTES } from './executionContext';

export const LOCAL_SECRET_ALGORITHM = 'aes-256-gcm';
export const MAX_LOCAL_SECRET_NAME_LENGTH = 128;
export const MAX_LOCAL_SECRET_VERSION = 2_147_483_647;
export const MAX_LOCAL_SECRET_REF_LENGTH = 512;
export const MAX_LOCAL_SECRET_MUTATION_ID_LENGTH = 64;
export const MAX_LOCAL_SECRET_KEY_ID_LENGTH = 128;

const SECRET_REF_PREFIX = 'qlsecret:v1:';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface LocalSecretReference {
  projectId: string;
  name: string;
  version?: number;
}

export interface LocalSecretEnvelope {
  projectId: string;
  name: string;
  version: number;
  mutationId: string;
  keyId: string;
  algorithm: typeof LOCAL_SECRET_ALGORITHM;
  nonce: string;
  ciphertext: string;
  authTag: string;
  createdAtMs: number;
}

export class InvalidLocalSecretError extends TypeError {
  constructor(message: string) {
    super(`Local Secret value is invalid: ${message}`);
    this.name = 'InvalidLocalSecretError';
  }
}

export class LocalSecretUnavailableError extends Error {
  readonly code = 'LOCAL_SECRET_UNAVAILABLE';

  constructor() {
    super('Local Secret is unavailable');
    this.name = 'LocalSecretUnavailableError';
  }
}

export class LocalSecretVersionConflictError extends Error {
  readonly code = 'LOCAL_SECRET_VERSION_CONFLICT';

  constructor() {
    super('Local Secret current version changed');
    this.name = 'LocalSecretVersionConflictError';
  }
}

export class LocalSecretMutationConflictError extends Error {
  readonly code = 'LOCAL_SECRET_MUTATION_CONFLICT';

  constructor() {
    super('Local Secret mutation does not match its previous request');
    this.name = 'LocalSecretMutationConflictError';
  }
}

function assertIdentifier(name: string, value: string, maximum: number): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidLocalSecretError(`${name} is invalid`);
  }
}

export function assertLocalSecretProjectId(value: string): void {
  assertIdentifier('projectId', value, 128);
}

export function assertLocalSecretName(value: string): void {
  assertIdentifier('name', value, MAX_LOCAL_SECRET_NAME_LENGTH);
}

export function assertLocalSecretVersion(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_LOCAL_SECRET_VERSION
  ) {
    throw new InvalidLocalSecretError('version is invalid');
  }
}

export function assertLocalSecretMutationId(value: string): void {
  assertIdentifier('mutationId', value, MAX_LOCAL_SECRET_MUTATION_ID_LENGTH);
}

export function assertLocalSecretKeyId(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_LOCAL_SECRET_KEY_ID_LENGTH ||
    !KEY_ID_PATTERN.test(value)
  ) {
    throw new InvalidLocalSecretError('keyId is invalid');
  }
}

export function assertLocalSecretPlaintext(value: string): void {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_EXECUTION_ENVIRONMENT_VALUE_BYTES
  ) {
    throw new InvalidLocalSecretError('plaintext is invalid');
  }
}

function decodeBase64Url(name: string, value: string, bytes?: number): Buffer {
  if (
    typeof value !== 'string' ||
    (value.length > 0 && !BASE64URL_PATTERN.test(value))
  ) {
    throw new InvalidLocalSecretError(`${name} is invalid`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.toString('base64url') !== value ||
    (bytes && decoded.length !== bytes)
  ) {
    throw new InvalidLocalSecretError(`${name} is invalid`);
  }
  return decoded;
}

export function localSecretBinary(
  name: 'nonce' | 'ciphertext' | 'authTag',
  value: string,
): Buffer {
  const decoded = decodeBase64Url(
    name,
    value,
    name === 'nonce' ? 12 : name === 'authTag' ? 16 : undefined,
  );
  if (
    name === 'ciphertext' &&
    decoded.length > MAX_EXECUTION_ENVIRONMENT_VALUE_BYTES
  ) {
    throw new InvalidLocalSecretError('ciphertext is too large');
  }
  return decoded;
}

export function createLocalSecretRef(reference: LocalSecretReference): string {
  assertLocalSecretProjectId(reference.projectId);
  assertLocalSecretName(reference.name);
  if (reference.version !== undefined) {
    assertLocalSecretVersion(reference.version);
  }
  const payload = JSON.stringify({
    projectId: reference.projectId,
    name: reference.name,
    ...(reference.version === undefined ? {} : { version: reference.version }),
  });
  const value =
    SECRET_REF_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
  if (value.length > MAX_LOCAL_SECRET_REF_LENGTH) {
    throw new InvalidLocalSecretError('reference is too large');
  }
  return value;
}

export function parseLocalSecretRef(value: string): LocalSecretReference {
  if (
    typeof value !== 'string' ||
    value.length > MAX_LOCAL_SECRET_REF_LENGTH ||
    !value.startsWith(SECRET_REF_PREFIX)
  ) {
    throw new InvalidLocalSecretError('reference is invalid');
  }
  const encoded = value.slice(SECRET_REF_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url('reference', encoded).toString('utf8'));
  } catch (error) {
    if (error instanceof InvalidLocalSecretError) throw error;
    throw new InvalidLocalSecretError('reference is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidLocalSecretError('reference is invalid');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys =
    record.version === undefined
      ? ['name', 'projectId']
      : ['name', 'projectId', 'version'];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new InvalidLocalSecretError('reference is invalid');
  }
  const reference: LocalSecretReference = {
    projectId: record.projectId as string,
    name: record.name as string,
    ...(record.version === undefined
      ? {}
      : { version: record.version as number }),
  };
  if (createLocalSecretRef(reference) !== value) {
    throw new InvalidLocalSecretError('reference is not canonical');
  }
  return Object.freeze(reference);
}

export function normalizeLocalSecretEnvelope(
  envelope: LocalSecretEnvelope,
): LocalSecretEnvelope {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new InvalidLocalSecretError('envelope must be an object');
  }
  assertLocalSecretProjectId(envelope.projectId);
  assertLocalSecretName(envelope.name);
  assertLocalSecretVersion(envelope.version);
  assertLocalSecretMutationId(envelope.mutationId);
  assertLocalSecretKeyId(envelope.keyId);
  if (envelope.algorithm !== LOCAL_SECRET_ALGORITHM) {
    throw new InvalidLocalSecretError('algorithm is invalid');
  }
  localSecretBinary('nonce', envelope.nonce);
  localSecretBinary('ciphertext', envelope.ciphertext);
  localSecretBinary('authTag', envelope.authTag);
  if (!Number.isSafeInteger(envelope.createdAtMs) || envelope.createdAtMs < 0) {
    throw new InvalidLocalSecretError('createdAtMs is invalid');
  }
  return Object.freeze({
    projectId: envelope.projectId,
    name: envelope.name,
    version: envelope.version,
    mutationId: envelope.mutationId,
    keyId: envelope.keyId,
    algorithm: LOCAL_SECRET_ALGORITHM,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    authTag: envelope.authTag,
    createdAtMs: envelope.createdAtMs,
  });
}

export function localSecretEnvelopeAad(
  envelope: Pick<
    LocalSecretEnvelope,
    'projectId' | 'name' | 'version' | 'mutationId' | 'keyId' | 'algorithm'
  >,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      projectId: envelope.projectId,
      name: envelope.name,
      version: envelope.version,
      mutationId: envelope.mutationId,
      keyId: envelope.keyId,
      algorithm: envelope.algorithm,
    }),
    'utf8',
  );
}

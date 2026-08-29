import type { LocalDispatchCandidate } from '../local-runtime/localDispatch';
import {
  MAX_SECRET_REF_BYTES,
  createSecretRef,
  parseSecretRef,
  type SecretReference,
} from './secretReference';

export const LOCAL_SECRET_ALGORITHM = 'aes-256-gcm';
export const MAX_LOCAL_SECRET_NAME_BYTES = 128;
export const MAX_LOCAL_SECRET_VERSION = 2_147_483_647;
export const MAX_LOCAL_SECRET_REF_BYTES = MAX_SECRET_REF_BYTES;
export const MAX_LOCAL_SECRET_MUTATION_ID_BYTES = 64;
export const MAX_LOCAL_SECRET_KEY_ID_BYTES = 128;
export const MAX_LOCAL_SECRET_PLAINTEXT_BYTES = 16 * 1024;
export const MAX_LOCAL_SECRET_BATCH_SIZE = 64;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** @deprecated Use the profile-neutral SecretReference contract. */
export type LocalSecretReference = SecretReference;

export interface LocalSecretEnvelope {
  readonly projectId: string;
  readonly name: string;
  readonly version: number;
  readonly mutationId: string;
  readonly keyId: string;
  readonly algorithm: typeof LOCAL_SECRET_ALGORITHM;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
  readonly createdAtMs: number;
}

export interface AppendLocalSecretEnvelopeCommand {
  readonly envelope: LocalSecretEnvelope;
  readonly expectedCurrentVersion: number;
}

export type AppendLocalSecretEnvelopeResult = Readonly<{
  status: 'inserted' | 'existing';
  envelope: LocalSecretEnvelope;
}>;

export interface LocalSecretEnvelopeRepository {
  appendLocalSecretEnvelope(
    command: AppendLocalSecretEnvelopeCommand,
  ): Promise<AppendLocalSecretEnvelopeResult>;
  findLocalSecretEnvelopeByMutation(
    projectId: string,
    name: string,
    mutationId: string,
  ): Promise<LocalSecretEnvelope | null>;
  resolveLocalSecretEnvelopes(
    references: readonly LocalSecretReference[],
  ): Promise<readonly (LocalSecretEnvelope | null)[]>;
}

export interface LocalSecretKeyMaterial {
  readonly keyId: string;
  /** Exactly 32 bytes. The consumer owns this copy and must wipe it. */
  readonly key: Uint8Array;
}

export interface LocalSecretKeyProvider {
  active(): Promise<LocalSecretKeyMaterial>;
  resolve(keyId: string): Promise<LocalSecretKeyMaterial | null>;
}

export interface LocalSecretEnvironmentProvider {
  resolveLocalSecretEnvironment(request: {
    readonly candidate: LocalDispatchCandidate;
    readonly secretRefs: readonly string[];
  }): Promise<readonly string[] | null>;
}

export interface LocalSecretMetadata {
  readonly projectId: string;
  readonly name: string;
  readonly currentVersion: number;
  readonly createdAtMs: number;
}

export interface LocalSecretMetadataPage {
  readonly secrets: readonly Readonly<LocalSecretMetadata>[];
  readonly truncated: boolean;
  readonly next?: Readonly<{ readonly name: string }>;
}

export interface LocalSecretMetadataSource {
  listLocalSecretMetadata(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: Readonly<{ readonly name: string }>;
  }): Promise<Readonly<LocalSecretMetadataPage>>;
}

export class LocalSecretMetadataUnavailableError extends Error {
  readonly code = 'LOCAL_SECRET_METADATA_UNAVAILABLE';

  constructor() {
    super('Local Secret metadata is unavailable');
    this.name = 'LocalSecretMetadataUnavailableError';
  }
}

export interface PutEncryptedLocalSecretCommand {
  readonly projectId: string;
  readonly name: string;
  readonly plaintext: string;
  readonly mutationId: string;
  readonly expectedCurrentVersion: number;
  readonly createdAtMs: number;
}

export interface PutEncryptedLocalSecretResult {
  readonly status: 'inserted' | 'existing';
  readonly version: number;
  readonly secretRef: string;
}

export class InvalidLocalSecretError extends TypeError {
  readonly code = 'LOCAL_SECRET_INVALID';

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

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function assertIdentifier(
  name: string,
  value: unknown,
  maximumBytes: number,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidLocalSecretError(`${name} is invalid`);
  }
}

export function assertLocalSecretProjectId(
  value: unknown,
): asserts value is string {
  assertIdentifier('projectId', value, 128);
}

export function assertLocalSecretName(value: unknown): asserts value is string {
  assertIdentifier('name', value, MAX_LOCAL_SECRET_NAME_BYTES);
}

export function assertLocalSecretVersion(
  value: unknown,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_LOCAL_SECRET_VERSION
  ) {
    throw new InvalidLocalSecretError('version is invalid');
  }
}

export function assertLocalSecretMutationId(
  value: unknown,
): asserts value is string {
  assertIdentifier('mutationId', value, MAX_LOCAL_SECRET_MUTATION_ID_BYTES);
}

export function assertLocalSecretKeyId(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_LOCAL_SECRET_KEY_ID_BYTES ||
    !KEY_ID_PATTERN.test(value)
  ) {
    throw new InvalidLocalSecretError('keyId is invalid');
  }
}

export function assertLocalSecretPlaintext(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_LOCAL_SECRET_PLAINTEXT_BYTES
  ) {
    throw new InvalidLocalSecretError('plaintext is invalid');
  }
}

export function assertLocalSecretExpectedVersion(
  value: unknown,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= MAX_LOCAL_SECRET_VERSION
  ) {
    throw new InvalidLocalSecretError('expectedCurrentVersion is invalid');
  }
}

function decodeBase64Url(name: string, value: unknown, bytes?: number): Buffer {
  if (
    typeof value !== 'string' ||
    (value.length > 0 && !BASE64URL_PATTERN.test(value))
  ) {
    throw new InvalidLocalSecretError(`${name} is invalid`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.toString('base64url') !== value ||
    (bytes !== undefined && decoded.length !== bytes)
  ) {
    decoded.fill(0);
    throw new InvalidLocalSecretError(`${name} is invalid`);
  }
  return decoded;
}

export function localSecretBinary(
  name: 'nonce' | 'ciphertext' | 'authTag',
  value: unknown,
): Buffer {
  const decoded = decodeBase64Url(
    name,
    value,
    name === 'nonce' ? 12 : name === 'authTag' ? 16 : undefined,
  );
  if (
    name === 'ciphertext' &&
    decoded.length > MAX_LOCAL_SECRET_PLAINTEXT_BYTES
  ) {
    decoded.fill(0);
    throw new InvalidLocalSecretError('ciphertext is too large');
  }
  return decoded;
}

export function createLocalSecretRef(reference: LocalSecretReference): string {
  try {
    return createSecretRef(reference);
  } catch {
    throw new InvalidLocalSecretError('reference is invalid');
  }
}

export function parseLocalSecretRef(value: unknown): LocalSecretReference {
  try {
    return parseSecretRef(value);
  } catch {
    throw new InvalidLocalSecretError('reference is invalid');
  }
}

export function normalizeLocalSecretEnvelope(
  envelope: LocalSecretEnvelope,
): LocalSecretEnvelope {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    !exactKeys(envelope, [
      'projectId',
      'name',
      'version',
      'mutationId',
      'keyId',
      'algorithm',
      'nonce',
      'ciphertext',
      'authTag',
      'createdAtMs',
    ])
  ) {
    throw new InvalidLocalSecretError('envelope is invalid');
  }
  assertLocalSecretProjectId(envelope.projectId);
  assertLocalSecretName(envelope.name);
  assertLocalSecretVersion(envelope.version);
  assertLocalSecretMutationId(envelope.mutationId);
  assertLocalSecretKeyId(envelope.keyId);
  if (envelope.algorithm !== LOCAL_SECRET_ALGORITHM) {
    throw new InvalidLocalSecretError('algorithm is invalid');
  }
  for (const name of ['nonce', 'ciphertext', 'authTag'] as const) {
    localSecretBinary(name, envelope[name]).fill(0);
  }
  if (!Number.isSafeInteger(envelope.createdAtMs) || envelope.createdAtMs < 0) {
    throw new InvalidLocalSecretError('createdAtMs is invalid');
  }
  return Object.freeze({ ...envelope });
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

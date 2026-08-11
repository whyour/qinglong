import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import { normalizeProjectPolicySubject } from '../security/project-policy/projectPolicy';
import type { SecuritySubject } from '../security/security';
import {
  MAX_TOOL_INPUT_BYTES,
  ToolDefinitionRegistry,
  type ToolJsonValue,
} from './tool-registry/toolRegistry';

export const TOOL_INVOCATION_INPUT_ARTIFACT_SCHEMA =
  'qinglong/tool-invocation-input-artifact@v1' as const;
export const TOOL_INVOCATION_PREVIEW_ARTIFACT_SCHEMA =
  'qinglong/tool-invocation-preview-artifact@v1' as const;
export const TOOL_INVOCATION_ARTIFACT_ALGORITHM = 'aes-256-gcm' as const;
export const MAX_TOOL_INVOCATION_ARTIFACT_ID_BYTES = 128;
export const MAX_TOOL_INVOCATION_ARTIFACT_KEY_ID_BYTES = 128;
export const MAX_TOOL_INVOCATION_PREVIEW_ARTIFACT_BYTES = 8 * 1024;
export const MAX_TOOL_INVOCATION_INPUT_ARTIFACT_JSON_BYTES = 96 * 1024;
export const MAX_TOOL_INVOCATION_PREVIEW_ARTIFACT_JSON_BYTES = 16 * 1024;

export interface ToolInvocationPreviewField {
  readonly kind: 'count' | 'identifier' | 'redacted' | 'text';
  readonly label: string;
  readonly value: string | null;
}

export interface ToolInvocationPreviewDocument {
  readonly title: string;
  readonly summary: string;
  readonly fields: readonly Readonly<ToolInvocationPreviewField>[];
  readonly warnings: readonly string[];
}

export interface ToolInvocationInputArtifact {
  readonly schema: typeof TOOL_INVOCATION_INPUT_ARTIFACT_SCHEMA;
  readonly artifactId: string;
  readonly projectId: string;
  readonly actionRef: string;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly tool: Readonly<{ name: string; version: string }>;
  readonly inputDigest: string;
  readonly invocationActionDigest: string;
  readonly keyId: string;
  readonly algorithm: typeof TOOL_INVOCATION_ARTIFACT_ALGORITHM;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
  readonly plaintextBytes: number;
  readonly sealedAtMs: number;
  readonly artifactDigest: string;
}

export interface ToolInvocationPreviewArtifact {
  readonly schema: typeof TOOL_INVOCATION_PREVIEW_ARTIFACT_SCHEMA;
  readonly artifactId: string;
  readonly projectId: string;
  readonly actionRef: string;
  readonly actionDigest: string;
  readonly redactionContractDigest: string;
  readonly preview: Readonly<ToolInvocationPreviewDocument>;
  readonly previewDigest: string;
  readonly byteLength: number;
  readonly sealedAtMs: number;
  readonly artifactDigest: string;
}

export interface ToolInvocationInputArtifactReference {
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly inputDigest: string;
  readonly keyId: string;
  readonly algorithm: typeof TOOL_INVOCATION_ARTIFACT_ALGORITHM;
  readonly plaintextBytes: number;
}

export interface ToolInvocationPreviewArtifactReference {
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly actionDigest: string;
  readonly previewDigest: string;
  readonly redactionContractDigest: string;
  readonly byteLength: number;
}

export interface ToolInvocationArtifactKeyMaterial {
  readonly keyId: string;
  /** Exactly 32 bytes. The consumer owns this copy and must wipe it. */
  readonly key: Uint8Array;
}

export interface ToolInvocationArtifactKeyProvider {
  active(): Promise<ToolInvocationArtifactKeyMaterial>;
  resolve(keyId: string): Promise<ToolInvocationArtifactKeyMaterial | null>;
}

export interface ToolInvocationArtifactRepository {
  put(
    inputArtifact: ToolInvocationInputArtifact,
    previewArtifact: ToolInvocationPreviewArtifact,
  ): Promise<Readonly<{ status: 'inserted' | 'existing' }>>;
  findInput(
    artifactId: string,
  ): Promise<Readonly<ToolInvocationInputArtifact> | null>;
  findPreview(
    artifactId: string,
  ): Promise<Readonly<ToolInvocationPreviewArtifact> | null>;
}

export class InvalidToolInvocationArtifactError extends TypeError {
  readonly code = 'TOOL_INVOCATION_ARTIFACT_INVALID';

  constructor(message: string) {
    super(`Tool invocation Artifact is invalid: ${message}`);
    this.name = 'InvalidToolInvocationArtifactError';
  }
}

export class ToolInvocationArtifactUnavailableError extends Error {
  readonly code = 'TOOL_INVOCATION_ARTIFACT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Tool invocation Artifact is unavailable', options);
    this.name = 'ToolInvocationArtifactUnavailableError';
  }
}

export class ToolInvocationArtifactConflictError extends Error {
  readonly code = 'TOOL_INVOCATION_ARTIFACT_CONFLICT';

  constructor() {
    super('Tool invocation Artifact identity is bound to different content');
    this.name = 'ToolInvocationArtifactConflictError';
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const WARNING_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PREVIEW_FIELD_KINDS = [
  'count',
  'identifier',
  'redacted',
  'text',
] as const;
const INPUT_DIGEST_DOMAIN = Buffer.alloc(0);
const INPUT_ARTIFACT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-invocation-input-artifact-digest@v1\0',
  'utf8',
);
const INPUT_ARTIFACT_AAD_DOMAIN = Buffer.from(
  'qinglong/tool-invocation-input-artifact-aad@v1\0',
  'utf8',
);
const PREVIEW_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-invocation-preview-digest@v1\0',
  'utf8',
);
const PREVIEW_ARTIFACT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-invocation-preview-artifact-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidToolInvocationArtifactError(message);
}

function hash(domain: Buffer, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const allowed = new Set(expected);
  if (
    actual.length !== expected.length ||
    actual.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    expected.some((key) => !actual.includes(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function actionRef(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    return invalid('action reference is invalid');
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function boundedInteger(
  value: unknown,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function boundedText(
  value: unknown,
  maximumBytes: number,
  label: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    CONTROL_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function normalizeToolInvocationPreviewDocument(
  value: ToolInvocationPreviewDocument,
): Readonly<ToolInvocationPreviewDocument> {
  const record = dataRecord(value, 'preview document');
  exactKeys(
    record,
    ['fields', 'summary', 'title', 'warnings'],
    'preview document',
  );
  if (
    !Array.isArray(value.fields) ||
    value.fields.length > 16 ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 8
  ) {
    return invalid('preview document collections are invalid');
  }
  const fields = value.fields.map((fieldValue) => {
    const field = dataRecord(fieldValue, 'preview field');
    exactKeys(field, ['kind', 'label', 'value'], 'preview field');
    if (!PREVIEW_FIELD_KINDS.includes(fieldValue.kind)) {
      return invalid('preview field kind is invalid');
    }
    if (
      (fieldValue.kind === 'redacted' && fieldValue.value !== null) ||
      (fieldValue.kind !== 'redacted' && fieldValue.value === null)
    ) {
      return invalid('preview field redaction is invalid');
    }
    return Object.freeze({
      kind: fieldValue.kind,
      label: boundedText(fieldValue.label, 128, 'preview field label'),
      value:
        fieldValue.value === null
          ? null
          : boundedText(fieldValue.value, 512, 'preview field value'),
    });
  });
  const warnings = value.warnings.map((warning) => {
    if (typeof warning !== 'string' || !WARNING_PATTERN.test(warning)) {
      return invalid('preview warning is invalid');
    }
    return warning;
  });
  if (new Set(warnings).size !== warnings.length) {
    return invalid('preview warnings are duplicated');
  }
  return Object.freeze({
    title: boundedText(value.title, 256, 'preview title'),
    summary: boundedText(value.summary, 2048, 'preview summary'),
    fields: Object.freeze(fields),
    warnings: Object.freeze([...warnings].sort()),
  });
}

function toolIdentity(
  value: Readonly<{ name: string; version: string }>,
): Readonly<{ name: string; version: string }> {
  const record = dataRecord(value, 'Tool identity');
  exactKeys(record, ['name', 'version'], 'Tool identity');
  if (
    typeof value.name !== 'string' ||
    !TOOL_NAME_PATTERN.test(value.name) ||
    typeof value.version !== 'string' ||
    !VERSION_PATTERN.test(value.version)
  ) {
    return invalid('Tool identity is invalid');
  }
  return Object.freeze({ name: value.name, version: value.version });
}

function base64url(
  value: unknown,
  label: string,
  expectedBytes?: number,
): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return invalid(`${label} is invalid`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.toString('base64url') !== value ||
    (expectedBytes !== undefined && bytes.length !== expectedBytes)
  ) {
    bytes.fill(0);
    return invalid(`${label} is invalid`);
  }
  return bytes;
}

function ownedKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new ToolInvocationArtifactUnavailableError();
  }
  return Buffer.from(value);
}

function inputArtifactAad(
  value: Omit<
    ToolInvocationInputArtifact,
    'artifactDigest' | 'authTag' | 'ciphertext' | 'nonce'
  >,
): Buffer {
  return Buffer.concat([
    INPUT_ARTIFACT_AAD_DOMAIN,
    Buffer.from(JSON.stringify(value), 'utf8'),
  ]);
}

export function normalizeToolInvocationInputArtifact(
  value: ToolInvocationInputArtifact,
): Readonly<ToolInvocationInputArtifact> {
  const record = dataRecord(value, 'input Artifact');
  exactKeys(
    record,
    [
      'actionRef',
      'algorithm',
      'artifactDigest',
      'artifactId',
      'authTag',
      'ciphertext',
      'inputDigest',
      'invocationActionDigest',
      'keyId',
      'nonce',
      'plaintextBytes',
      'projectId',
      'requestedBy',
      'schema',
      'sealedAtMs',
      'tool',
    ],
    'input Artifact',
  );
  if (
    value.schema !== TOOL_INVOCATION_INPUT_ARTIFACT_SCHEMA ||
    value.algorithm !== TOOL_INVOCATION_ARTIFACT_ALGORITHM ||
    typeof value.keyId !== 'string' ||
    !KEY_ID_PATTERN.test(value.keyId)
  ) {
    return invalid('input Artifact schema, algorithm or key is invalid');
  }
  const nonce = base64url(value.nonce, 'input Artifact nonce', 12);
  const ciphertext = base64url(value.ciphertext, 'input Artifact ciphertext');
  const authTag = base64url(value.authTag, 'input Artifact auth tag', 16);
  const plaintextBytes = boundedInteger(
    value.plaintextBytes,
    MAX_TOOL_INPUT_BYTES,
    'input Artifact plaintext bytes',
  );
  try {
    if (ciphertext.length !== plaintextBytes) {
      return invalid('input Artifact ciphertext length does not match');
    }
  } finally {
    nonce.fill(0);
    ciphertext.fill(0);
    authTag.fill(0);
  }
  const unsigned = Object.freeze({
    schema: TOOL_INVOCATION_INPUT_ARTIFACT_SCHEMA,
    artifactId: identifier(value.artifactId, 'input Artifact id'),
    projectId: identifier(value.projectId, 'input Artifact project id'),
    actionRef: actionRef(value.actionRef),
    requestedBy: normalizeProjectPolicySubject(value.requestedBy),
    tool: toolIdentity(value.tool),
    inputDigest: digest(value.inputDigest, 'input digest'),
    invocationActionDigest: digest(
      value.invocationActionDigest,
      'invocation action digest',
    ),
    keyId: value.keyId,
    algorithm: TOOL_INVOCATION_ARTIFACT_ALGORITHM,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    authTag: value.authTag,
    plaintextBytes,
    sealedAtMs: timestamp(value.sealedAtMs, 'input Artifact seal time'),
  } satisfies Omit<ToolInvocationInputArtifact, 'artifactDigest'>);
  const artifactDigest = digest(value.artifactDigest, 'input Artifact digest');
  if (
    hash(INPUT_ARTIFACT_DIGEST_DOMAIN, unsigned) !== artifactDigest ||
    Buffer.byteLength(JSON.stringify({ ...unsigned, artifactDigest }), 'utf8') >
      MAX_TOOL_INVOCATION_INPUT_ARTIFACT_JSON_BYTES
  ) {
    return invalid('input Artifact digest or size does not match');
  }
  return Object.freeze({ ...unsigned, artifactDigest });
}

export function createToolInvocationInputArtifact(
  inputValue: Readonly<{
    artifactId: string;
    projectId: string;
    actionRef: string;
    requestedBy: Readonly<SecuritySubject>;
    tool: Readonly<{ name: string; version: string }>;
    input: ToolJsonValue;
    inputDigest: string;
    invocationActionDigest: string;
    keyId: string;
    key: Uint8Array;
    sealedAtMs: number;
  }>,
  nonceFactory: () => Uint8Array = () => randomBytes(12),
): Readonly<ToolInvocationInputArtifact> {
  const inputDigest = digest(inputValue.inputDigest, 'input digest');
  if (hash(INPUT_DIGEST_DOMAIN, inputValue.input) !== inputDigest) {
    return invalid('input digest does not match plaintext');
  }
  const plaintext = Buffer.from(JSON.stringify(inputValue.input), 'utf8');
  if (plaintext.length > MAX_TOOL_INPUT_BYTES) {
    plaintext.fill(0);
    return invalid('input plaintext is too large');
  }
  const key = ownedKey(inputValue.key);
  let nonce: Buffer | undefined;
  try {
    nonce = Buffer.from(nonceFactory());
    if (nonce.length !== 12) {
      throw new ToolInvocationArtifactUnavailableError();
    }
    const metadata = Object.freeze({
      schema: TOOL_INVOCATION_INPUT_ARTIFACT_SCHEMA,
      artifactId: identifier(inputValue.artifactId, 'input Artifact id'),
      projectId: identifier(inputValue.projectId, 'input Artifact project id'),
      actionRef: actionRef(inputValue.actionRef),
      requestedBy: normalizeProjectPolicySubject(inputValue.requestedBy),
      tool: toolIdentity(inputValue.tool),
      inputDigest,
      invocationActionDigest: digest(
        inputValue.invocationActionDigest,
        'invocation action digest',
      ),
      keyId:
        typeof inputValue.keyId === 'string' &&
        KEY_ID_PATTERN.test(inputValue.keyId)
          ? inputValue.keyId
          : invalid('input Artifact key id is invalid'),
      algorithm: TOOL_INVOCATION_ARTIFACT_ALGORITHM,
      plaintextBytes: plaintext.length,
      sealedAtMs: timestamp(inputValue.sealedAtMs, 'input Artifact seal time'),
    });
    const cipher = createCipheriv(
      TOOL_INVOCATION_ARTIFACT_ALGORITHM,
      key,
      nonce,
      { authTagLength: 16 },
    );
    const aad = inputArtifactAad(metadata);
    try {
      cipher.setAAD(aad);
    } finally {
      aad.fill(0);
    }
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    try {
      const unsigned = Object.freeze({
        schema: metadata.schema,
        artifactId: metadata.artifactId,
        projectId: metadata.projectId,
        actionRef: metadata.actionRef,
        requestedBy: metadata.requestedBy,
        tool: metadata.tool,
        inputDigest: metadata.inputDigest,
        invocationActionDigest: metadata.invocationActionDigest,
        keyId: metadata.keyId,
        algorithm: metadata.algorithm,
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
        plaintextBytes: metadata.plaintextBytes,
        sealedAtMs: metadata.sealedAtMs,
      });
      return normalizeToolInvocationInputArtifact({
        ...unsigned,
        artifactDigest: hash(INPUT_ARTIFACT_DIGEST_DOMAIN, unsigned),
      });
    } finally {
      ciphertext.fill(0);
    }
  } catch (cause) {
    if (
      cause instanceof InvalidToolInvocationArtifactError ||
      cause instanceof ToolInvocationArtifactUnavailableError
    ) {
      throw cause;
    }
    throw new ToolInvocationArtifactUnavailableError({ cause });
  } finally {
    key.fill(0);
    plaintext.fill(0);
    nonce?.fill(0);
  }
}

export function openToolInvocationInputArtifact(
  artifactValue: ToolInvocationInputArtifact,
  keyValue: Uint8Array,
  registry: ToolDefinitionRegistry,
): ToolJsonValue {
  const artifact = normalizeToolInvocationInputArtifact(artifactValue);
  if (!(registry instanceof ToolDefinitionRegistry)) {
    return invalid('Tool registry is invalid');
  }
  const key = ownedKey(keyValue);
  const nonce = base64url(artifact.nonce, 'input Artifact nonce', 12);
  const ciphertext = base64url(
    artifact.ciphertext,
    'input Artifact ciphertext',
  );
  const authTag = base64url(artifact.authTag, 'input Artifact auth tag', 16);
  const metadata = {
    schema: artifact.schema,
    artifactId: artifact.artifactId,
    projectId: artifact.projectId,
    actionRef: artifact.actionRef,
    requestedBy: artifact.requestedBy,
    tool: artifact.tool,
    inputDigest: artifact.inputDigest,
    invocationActionDigest: artifact.invocationActionDigest,
    keyId: artifact.keyId,
    algorithm: artifact.algorithm,
    plaintextBytes: artifact.plaintextBytes,
    sealedAtMs: artifact.sealedAtMs,
  };
  const aad = inputArtifactAad(metadata);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
      TOOL_INVOCATION_ARTIFACT_ALGORITHM,
      key,
      nonce,
      { authTagLength: 16 },
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length !== artifact.plaintextBytes) {
      throw new ToolInvocationArtifactUnavailableError();
    }
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
    const normalized = registry.normalizeInput(
      artifact.tool.name,
      artifact.tool.version,
      parsed,
    );
    if (hash(INPUT_DIGEST_DOMAIN, normalized) !== artifact.inputDigest) {
      throw new ToolInvocationArtifactUnavailableError();
    }
    return normalized;
  } catch (cause) {
    if (cause instanceof ToolInvocationArtifactUnavailableError) throw cause;
    throw new ToolInvocationArtifactUnavailableError({ cause });
  } finally {
    key.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    authTag.fill(0);
    aad.fill(0);
    plaintext?.fill(0);
  }
}

export function toolInvocationInputArtifactReference(
  value: ToolInvocationInputArtifact,
): Readonly<ToolInvocationInputArtifactReference> {
  const artifact = normalizeToolInvocationInputArtifact(value);
  return Object.freeze({
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    inputDigest: artifact.inputDigest,
    keyId: artifact.keyId,
    algorithm: artifact.algorithm,
    plaintextBytes: artifact.plaintextBytes,
  });
}

export function normalizeToolInvocationInputArtifactReference(
  value: ToolInvocationInputArtifactReference,
): Readonly<ToolInvocationInputArtifactReference> {
  const record = dataRecord(value, 'input Artifact reference');
  exactKeys(
    record,
    [
      'algorithm',
      'artifactDigest',
      'artifactId',
      'inputDigest',
      'keyId',
      'plaintextBytes',
    ],
    'input Artifact reference',
  );
  if (
    value.algorithm !== TOOL_INVOCATION_ARTIFACT_ALGORITHM ||
    typeof value.keyId !== 'string' ||
    !KEY_ID_PATTERN.test(value.keyId)
  ) {
    return invalid('input Artifact reference algorithm or key is invalid');
  }
  return Object.freeze({
    artifactId: identifier(value.artifactId, 'input Artifact id'),
    artifactDigest: digest(value.artifactDigest, 'input Artifact digest'),
    inputDigest: digest(value.inputDigest, 'input digest'),
    keyId: value.keyId,
    algorithm: TOOL_INVOCATION_ARTIFACT_ALGORITHM,
    plaintextBytes: boundedInteger(
      value.plaintextBytes,
      MAX_TOOL_INPUT_BYTES,
      'input Artifact plaintext bytes',
    ),
  });
}

function previewArtifactUnsigned(
  value: ToolInvocationPreviewArtifact,
): Omit<ToolInvocationPreviewArtifact, 'artifactDigest'> {
  const { artifactDigest: _artifactDigest, ...unsigned } = value;
  return unsigned;
}

export function createToolInvocationPreviewArtifact(
  inputValue: Readonly<{
    artifactId: string;
    projectId: string;
    actionRef: string;
    actionDigest: string;
    redactionContractDigest: string;
    preview: Readonly<ToolInvocationPreviewDocument>;
    sealedAtMs: number;
  }>,
): Readonly<ToolInvocationPreviewArtifact> {
  const actionDigest = digest(inputValue.actionDigest, 'action digest');
  const preview = normalizeToolInvocationPreviewDocument(inputValue.preview);
  const previewDigest = hash(PREVIEW_DIGEST_DOMAIN, {
    actionDigest,
    preview,
  });
  const byteLength = Buffer.byteLength(JSON.stringify(preview), 'utf8');
  if (byteLength > MAX_TOOL_INVOCATION_PREVIEW_ARTIFACT_BYTES) {
    return invalid('preview Artifact is too large');
  }
  const unsigned = Object.freeze({
    schema: TOOL_INVOCATION_PREVIEW_ARTIFACT_SCHEMA,
    artifactId: identifier(inputValue.artifactId, 'preview Artifact id'),
    projectId: identifier(inputValue.projectId, 'preview Artifact project id'),
    actionRef: actionRef(inputValue.actionRef),
    actionDigest,
    redactionContractDigest: digest(
      inputValue.redactionContractDigest,
      'redaction contract digest',
    ),
    preview,
    previewDigest,
    byteLength,
    sealedAtMs: timestamp(inputValue.sealedAtMs, 'preview Artifact seal time'),
  } satisfies Omit<ToolInvocationPreviewArtifact, 'artifactDigest'>);
  return Object.freeze({
    ...unsigned,
    artifactDigest: hash(PREVIEW_ARTIFACT_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeToolInvocationPreviewArtifact(
  value: ToolInvocationPreviewArtifact,
): Readonly<ToolInvocationPreviewArtifact> {
  const record = dataRecord(value, 'preview Artifact');
  exactKeys(
    record,
    [
      'actionDigest',
      'actionRef',
      'artifactDigest',
      'artifactId',
      'byteLength',
      'preview',
      'previewDigest',
      'projectId',
      'redactionContractDigest',
      'schema',
      'sealedAtMs',
    ],
    'preview Artifact',
  );
  if (value.schema !== TOOL_INVOCATION_PREVIEW_ARTIFACT_SCHEMA) {
    return invalid('preview Artifact schema is invalid');
  }
  const preview = normalizeToolInvocationPreviewDocument(value.preview);
  const byteLength = boundedInteger(
    value.byteLength,
    MAX_TOOL_INVOCATION_PREVIEW_ARTIFACT_BYTES,
    'preview Artifact bytes',
  );
  if (Buffer.byteLength(JSON.stringify(preview), 'utf8') !== byteLength) {
    return invalid('preview Artifact byte length does not match');
  }
  const unsigned = Object.freeze({
    schema: TOOL_INVOCATION_PREVIEW_ARTIFACT_SCHEMA,
    artifactId: identifier(value.artifactId, 'preview Artifact id'),
    projectId: identifier(value.projectId, 'preview Artifact project id'),
    actionRef: actionRef(value.actionRef),
    actionDigest: digest(value.actionDigest, 'action digest'),
    redactionContractDigest: digest(
      value.redactionContractDigest,
      'redaction contract digest',
    ),
    preview,
    previewDigest: digest(value.previewDigest, 'preview digest'),
    byteLength,
    sealedAtMs: timestamp(value.sealedAtMs, 'preview Artifact seal time'),
  } satisfies Omit<ToolInvocationPreviewArtifact, 'artifactDigest'>);
  if (
    hash(PREVIEW_DIGEST_DOMAIN, {
      actionDigest: unsigned.actionDigest,
      preview: unsigned.preview,
    }) !== unsigned.previewDigest
  ) {
    return invalid('preview digest does not match');
  }
  const artifactDigest = digest(
    value.artifactDigest,
    'preview Artifact digest',
  );
  if (
    hash(PREVIEW_ARTIFACT_DIGEST_DOMAIN, unsigned) !== artifactDigest ||
    Buffer.byteLength(JSON.stringify({ ...unsigned, artifactDigest }), 'utf8') >
      MAX_TOOL_INVOCATION_PREVIEW_ARTIFACT_JSON_BYTES
  ) {
    return invalid('preview Artifact digest or size does not match');
  }
  return Object.freeze({ ...unsigned, artifactDigest });
}

export function toolInvocationPreviewArtifactReference(
  value: ToolInvocationPreviewArtifact,
): Readonly<ToolInvocationPreviewArtifactReference> {
  const artifact = normalizeToolInvocationPreviewArtifact(value);
  return Object.freeze({
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    actionDigest: artifact.actionDigest,
    previewDigest: artifact.previewDigest,
    redactionContractDigest: artifact.redactionContractDigest,
    byteLength: artifact.byteLength,
  });
}

export function normalizeToolInvocationPreviewArtifactReference(
  value: ToolInvocationPreviewArtifactReference,
): Readonly<ToolInvocationPreviewArtifactReference> {
  const record = dataRecord(value, 'preview Artifact reference');
  exactKeys(
    record,
    [
      'artifactDigest',
      'artifactId',
      'actionDigest',
      'byteLength',
      'previewDigest',
      'redactionContractDigest',
    ],
    'preview Artifact reference',
  );
  return Object.freeze({
    artifactId: identifier(value.artifactId, 'preview Artifact id'),
    artifactDigest: digest(value.artifactDigest, 'preview Artifact digest'),
    actionDigest: digest(value.actionDigest, 'action digest'),
    previewDigest: digest(value.previewDigest, 'preview digest'),
    redactionContractDigest: digest(
      value.redactionContractDigest,
      'redaction contract digest',
    ),
    byteLength: boundedInteger(
      value.byteLength,
      MAX_TOOL_INVOCATION_PREVIEW_ARTIFACT_BYTES,
      'preview Artifact bytes',
    ),
  });
}

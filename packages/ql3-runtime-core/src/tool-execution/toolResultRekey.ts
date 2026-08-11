import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import {
  normalizeToolExecutionResultArtifact,
  normalizeToolExecutionResultKeyBinding,
  type ToolExecutionResultArtifact,
  type ToolExecutionResultArtifactReference,
  type ToolExecutionResultKeyBinding,
} from './toolExecutionCompletion';
import {
  normalizeToolResultKeyCatalogFence,
  toolResultKeyMaterialProof,
  type ToolResultKeyCatalogFence,
} from './toolResultKeyCatalog';
import {
  MAX_TOOL_OUTPUT_BYTES,
  ToolDefinitionRegistry,
  type ToolJsonValue,
} from './tool-registry/toolRegistry';

export const TOOL_EXECUTION_RESULT_REKEY_OVERLAY_SCHEMA =
  'qinglong/tool-execution-result-rekey-overlay@v1' as const;
export const TOOL_EXECUTION_RESULT_REKEY_COMMAND_SCHEMA =
  'qinglong/tool-execution-result-rekey-command@v1' as const;
export const TOOL_RESULT_KEY_RETIREMENT_RECEIPT_SCHEMA =
  'qinglong/tool-result-key-retirement-receipt@v1' as const;
export const TOOL_RESULT_KEY_RETIREMENT_RECEIPT_COMMAND_SCHEMA =
  'qinglong/tool-result-key-retirement-receipt-command@v1' as const;
export const TOOL_EXECUTION_RESULT_REKEY_ALGORITHM = 'aes-256-gcm' as const;
export const MAX_TOOL_EXECUTION_RESULT_REKEY_OVERLAY_JSON_BYTES = 384 * 1024;

export interface ToolExecutionResultRekeyOverlay {
  readonly schema: typeof TOOL_EXECUTION_RESULT_REKEY_OVERLAY_SCHEMA;
  readonly overlayId: string;
  readonly sourceArtifact: Readonly<ToolExecutionResultArtifactReference>;
  readonly sourceBindingDigest: string;
  readonly revision: number;
  readonly previousOverlayDigest: string | null;
  readonly fromKeyId: string;
  readonly targetCatalogFence: Readonly<ToolResultKeyCatalogFence>;
  readonly algorithm: typeof TOOL_EXECUTION_RESULT_REKEY_ALGORITHM;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
  readonly plaintextBytes: number;
  readonly rekeyedAtMs: number;
  readonly overlayDigest: string;
}

export interface ToolExecutionResultRekeyCommand {
  readonly schema: typeof TOOL_EXECUTION_RESULT_REKEY_COMMAND_SCHEMA;
  readonly expectedRevision: number;
  readonly expectedOverlayDigest: string | null;
  readonly mutationId: string;
  readonly overlay: Readonly<ToolExecutionResultRekeyOverlay>;
  readonly commandDigest: string;
}

export interface CommitToolExecutionResultRekeyResult {
  readonly status: 'created' | 'existing';
  readonly overlay: Readonly<ToolExecutionResultRekeyOverlay>;
}

export interface ToolExecutionResultRekeyReader {
  findHeadByArtifactId(
    artifactId: string,
  ): Promise<Readonly<ToolExecutionResultRekeyOverlay> | null>;
}

export interface ToolExecutionResultRekeyRepository
  extends ToolExecutionResultRekeyReader {
  append(
    command: Readonly<ToolExecutionResultRekeyCommand>,
  ): Promise<Readonly<CommitToolExecutionResultRekeyResult>>;
}

export interface ToolResultKeyRetirementReceipt {
  readonly schema: typeof TOOL_RESULT_KEY_RETIREMENT_RECEIPT_SCHEMA;
  readonly catalogGeneration: number;
  readonly catalogDigest: string;
  readonly keyId: string;
  readonly materialProof: string;
  readonly mutationId: string;
  readonly bindingCount: number;
  readonly overlayHeadCount: number;
  readonly uncoveredBindingCount: 0;
  readonly uncoveredOverlayHeadCount: 0;
  readonly coverageDigest: string;
  readonly createdAtMs: number;
  readonly receiptDigest: string;
}

export interface ToolResultKeyRetirementReceiptCommand {
  readonly schema: typeof TOOL_RESULT_KEY_RETIREMENT_RECEIPT_COMMAND_SCHEMA;
  readonly expectedCatalogGeneration: number;
  readonly expectedCatalogDigest: string;
  readonly keyId: string;
  readonly mutationId: string;
  readonly commandDigest: string;
}

export interface ToolResultKeyRetirementCoverageFact {
  readonly artifactId: string;
  readonly bindingDigest: string;
  readonly bindingKeyId: string;
  readonly headOverlayDigest: string | null;
  readonly headTargetKeyId: string | null;
  readonly headTargetCatalogGeneration: number | null;
  readonly headTargetCatalogDigest: string | null;
}

export interface ToolResultKeyRetirementCoverage {
  readonly bindingCount: number;
  readonly overlayHeadCount: number;
  readonly uncoveredBindingCount: number;
  readonly uncoveredOverlayHeadCount: number;
  readonly coverageDigest: string;
}

export interface CommitToolResultKeyRetirementReceiptResult {
  readonly status: 'created' | 'existing';
  readonly receipt: Readonly<ToolResultKeyRetirementReceipt>;
}

export interface ToolResultKeyRetirementReceiptRepository {
  findByDigest(
    receiptDigest: string,
  ): Promise<Readonly<ToolResultKeyRetirementReceipt> | null>;
  create(
    command: Readonly<ToolResultKeyRetirementReceiptCommand>,
  ): Promise<Readonly<CommitToolResultKeyRetirementReceiptResult>>;
}

export class InvalidToolExecutionResultRekeyError extends TypeError {
  readonly code = 'TOOL_EXECUTION_RESULT_REKEY_INVALID';

  constructor(message: string) {
    super(`Tool execution result rekey is invalid: ${message}`);
    this.name = 'InvalidToolExecutionResultRekeyError';
  }
}

export class ToolExecutionResultRekeyConflictError extends Error {
  readonly code = 'TOOL_EXECUTION_RESULT_REKEY_CONFLICT';

  constructor() {
    super('Tool execution result rekey conflicts with durable state');
    this.name = 'ToolExecutionResultRekeyConflictError';
  }
}

export class ToolExecutionResultRekeyUnavailableError extends Error {
  readonly code = 'TOOL_EXECUTION_RESULT_REKEY_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Tool execution result rekey authority is unavailable', options);
    this.name = 'ToolExecutionResultRekeyUnavailableError';
  }
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const OUTPUT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-output-digest@v1\0',
  'utf8',
);
const OVERLAY_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-result-rekey-overlay-digest@v1\0',
  'utf8',
);
const COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-result-rekey-command-digest@v1\0',
  'utf8',
);
const RETIREMENT_RECEIPT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-result-key-retirement-receipt-digest@v1\0',
  'utf8',
);
const RETIREMENT_RECEIPT_COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-result-key-retirement-receipt-command-digest@v1\0',
  'utf8',
);
const RETIREMENT_COVERAGE_FACT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-result-key-retirement-coverage-fact-digest@v1\0',
  'utf8',
);
const RETIREMENT_COVERAGE_SET_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-result-key-retirement-coverage-set-digest@v1\0',
  'utf8',
);
const RETIREMENT_COVERAGE_FINAL_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-result-key-retirement-coverage-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidToolExecutionResultRekeyError(message);
}

function hash(domain: Uint8Array, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid(`${label} is not a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function keyId(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    return invalid('key id is invalid');
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digest(value, label);
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > 2_147_483_647
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function base64url(
  value: unknown,
  label: string,
  exactLength?: number,
): Buffer {
  if (
    typeof value !== 'string' ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    return invalid(`${label} is invalid`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.toString('base64url') !== value ||
    (exactLength !== undefined && bytes.length !== exactLength)
  ) {
    bytes.fill(0);
    return invalid(`${label} is invalid`);
  }
  return bytes;
}

function ownedKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    return invalid('key material is invalid');
  }
  return Buffer.from(value);
}

function sourceReference(
  artifact: Readonly<ToolExecutionResultArtifact>,
): Readonly<ToolExecutionResultArtifactReference> {
  return Object.freeze({
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    outputDigest: artifact.outputDigest,
    executionResultDigest: artifact.executionResultDigest,
  });
}

function normalizeSourceReference(
  value: ToolExecutionResultArtifactReference,
): Readonly<ToolExecutionResultArtifactReference> {
  const candidate = record(value, 'source Artifact reference');
  exactKeys(
    candidate,
    ['artifactDigest', 'artifactId', 'executionResultDigest', 'outputDigest'],
    'source Artifact reference',
  );
  return Object.freeze({
    artifactId: identity(value.artifactId, 'source Artifact id'),
    artifactDigest: digest(value.artifactDigest, 'source Artifact digest'),
    outputDigest: digest(value.outputDigest, 'source output digest'),
    executionResultDigest: digest(
      value.executionResultDigest,
      'source execution result digest',
    ),
  });
}

function overlayMetadata(
  value: Omit<
    ToolExecutionResultRekeyOverlay,
    'authTag' | 'ciphertext' | 'nonce' | 'overlayDigest'
  >,
) {
  return Object.freeze(value);
}

function overlayAad(value: ReturnType<typeof overlayMetadata>): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

export function normalizeToolExecutionResultRekeyOverlay(
  value: ToolExecutionResultRekeyOverlay,
): Readonly<ToolExecutionResultRekeyOverlay> {
  const candidate = record(value, 'rekey overlay');
  exactKeys(
    candidate,
    [
      'algorithm',
      'authTag',
      'ciphertext',
      'fromKeyId',
      'nonce',
      'overlayDigest',
      'overlayId',
      'plaintextBytes',
      'previousOverlayDigest',
      'rekeyedAtMs',
      'revision',
      'schema',
      'sourceArtifact',
      'sourceBindingDigest',
      'targetCatalogFence',
    ],
    'rekey overlay',
  );
  if (
    value.schema !== TOOL_EXECUTION_RESULT_REKEY_OVERLAY_SCHEMA ||
    value.algorithm !== TOOL_EXECUTION_RESULT_REKEY_ALGORITHM
  ) {
    return invalid('rekey overlay schema or algorithm is invalid');
  }
  const revision = integer(value.revision, 'rekey revision', 1);
  const previousOverlayDigest = nullableDigest(
    value.previousOverlayDigest,
    'previous overlay digest',
  );
  if ((revision === 1) !== (previousOverlayDigest === null)) {
    return invalid('rekey overlay revision fence is invalid');
  }
  const targetCatalogFence = normalizeToolResultKeyCatalogFence(
    value.targetCatalogFence,
  );
  const fromKey = keyId(value.fromKeyId);
  if (fromKey === targetCatalogFence.keyId) {
    return invalid('rekey target must differ from source key');
  }
  const nonce = base64url(value.nonce, 'rekey nonce', 12);
  const ciphertext = base64url(value.ciphertext, 'rekey ciphertext');
  const authTag = base64url(value.authTag, 'rekey auth tag', 16);
  nonce.fill(0);
  ciphertext.fill(0);
  authTag.fill(0);
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_RESULT_REKEY_OVERLAY_SCHEMA,
    overlayId: identity(value.overlayId, 'rekey overlay id'),
    sourceArtifact: normalizeSourceReference(value.sourceArtifact),
    sourceBindingDigest: digest(
      value.sourceBindingDigest,
      'source binding digest',
    ),
    revision,
    previousOverlayDigest,
    fromKeyId: fromKey,
    targetCatalogFence,
    algorithm: TOOL_EXECUTION_RESULT_REKEY_ALGORITHM,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    authTag: value.authTag,
    plaintextBytes: integer(value.plaintextBytes, 'plaintext byte count'),
    rekeyedAtMs: timestamp(value.rekeyedAtMs, 'rekey time'),
  });
  if (
    unsigned.plaintextBytes > MAX_TOOL_OUTPUT_BYTES ||
    Buffer.byteLength(JSON.stringify(unsigned), 'utf8') >
      MAX_TOOL_EXECUTION_RESULT_REKEY_OVERLAY_JSON_BYTES
  ) {
    return invalid('rekey overlay exceeds its budget');
  }
  const overlayDigest = digest(value.overlayDigest, 'rekey overlay digest');
  if (hash(OVERLAY_DIGEST_DOMAIN, unsigned) !== overlayDigest) {
    return invalid('rekey overlay digest does not match');
  }
  return Object.freeze({ ...unsigned, overlayDigest });
}

export function normalizeToolExecutionResultRekeyCommand(
  value: ToolExecutionResultRekeyCommand,
): Readonly<ToolExecutionResultRekeyCommand> {
  const candidate = record(value, 'rekey command');
  exactKeys(
    candidate,
    [
      'commandDigest',
      'expectedOverlayDigest',
      'expectedRevision',
      'mutationId',
      'overlay',
      'schema',
    ],
    'rekey command',
  );
  if (value.schema !== TOOL_EXECUTION_RESULT_REKEY_COMMAND_SCHEMA) {
    return invalid('rekey command schema is invalid');
  }
  const expectedRevision = integer(
    value.expectedRevision,
    'expected rekey revision',
  );
  const expectedOverlayDigest = nullableDigest(
    value.expectedOverlayDigest,
    'expected overlay digest',
  );
  const overlay = normalizeToolExecutionResultRekeyOverlay(value.overlay);
  if (
    overlay.revision !== expectedRevision + 1 ||
    overlay.previousOverlayDigest !== expectedOverlayDigest ||
    (expectedRevision === 0) !== (expectedOverlayDigest === null)
  ) {
    return invalid('rekey command head fence is invalid');
  }
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_RESULT_REKEY_COMMAND_SCHEMA,
    expectedRevision,
    expectedOverlayDigest,
    mutationId: identity(value.mutationId, 'rekey mutation id'),
    overlay,
  });
  const commandDigest = digest(value.commandDigest, 'rekey command digest');
  if (hash(COMMAND_DIGEST_DOMAIN, unsigned) !== commandDigest) {
    return invalid('rekey command digest does not match');
  }
  return Object.freeze({ ...unsigned, commandDigest });
}

export function createToolExecutionResultRekeyCommand(
  input: Readonly<{
    readonly artifact: ToolExecutionResultArtifact;
    readonly binding: ToolExecutionResultKeyBinding;
    readonly previousOverlay: ToolExecutionResultRekeyOverlay | null;
    readonly overlayId: string;
    readonly mutationId: string;
    readonly targetCatalogFence: ToolResultKeyCatalogFence;
    readonly targetKey: Uint8Array;
    readonly output: ToolJsonValue;
    readonly rekeyedAtMs: number;
    readonly registry: ToolDefinitionRegistry;
    readonly nonceFactory?: () => Uint8Array;
  }>,
): Readonly<ToolExecutionResultRekeyCommand> {
  const artifact = normalizeToolExecutionResultArtifact(input.artifact);
  const binding = normalizeToolExecutionResultKeyBinding(input.binding);
  if (
    binding.startId !== artifact.startId ||
    binding.artifactId !== artifact.artifactId ||
    binding.artifactDigest !== artifact.artifactDigest ||
    binding.keyId !== artifact.keyId
  ) {
    throw new ToolExecutionResultRekeyConflictError();
  }
  if (!(input.registry instanceof ToolDefinitionRegistry)) {
    return invalid('Tool registry is invalid');
  }
  const output = input.registry.normalizeOutput(
    artifact.tool.name,
    artifact.tool.version,
    input.output,
  );
  const plaintext = Buffer.from(JSON.stringify(output), 'utf8');
  if (
    plaintext.length > MAX_TOOL_OUTPUT_BYTES ||
    hash(OUTPUT_DIGEST_DOMAIN, output) !== artifact.outputDigest
  ) {
    plaintext.fill(0);
    return invalid('rekey output does not match source Artifact');
  }
  const previous =
    input.previousOverlay === null
      ? null
      : normalizeToolExecutionResultRekeyOverlay(input.previousOverlay);
  const source = sourceReference(artifact);
  if (
    previous &&
    (JSON.stringify(previous.sourceArtifact) !== JSON.stringify(source) ||
      previous.sourceBindingDigest !== binding.bindingDigest)
  ) {
    plaintext.fill(0);
    throw new ToolExecutionResultRekeyConflictError();
  }
  const targetCatalogFence = normalizeToolResultKeyCatalogFence(
    input.targetCatalogFence,
  );
  const targetKey = ownedKey(input.targetKey);
  let nonce: Buffer | undefined;
  try {
    if (
      toolResultKeyMaterialProof(targetCatalogFence.keyId, targetKey) !==
      targetCatalogFence.materialProof
    ) {
      return invalid('target key material does not match catalog fence');
    }
    const fromKeyId = previous?.targetCatalogFence.keyId ?? binding.keyId;
    nonce = Buffer.from((input.nonceFactory ?? (() => randomBytes(12)))());
    if (nonce.length !== 12) {
      throw new ToolExecutionResultRekeyUnavailableError();
    }
    const metadata = overlayMetadata({
      schema: TOOL_EXECUTION_RESULT_REKEY_OVERLAY_SCHEMA,
      overlayId: identity(input.overlayId, 'rekey overlay id'),
      sourceArtifact: source,
      sourceBindingDigest: binding.bindingDigest,
      revision: (previous?.revision ?? 0) + 1,
      previousOverlayDigest: previous?.overlayDigest ?? null,
      fromKeyId,
      targetCatalogFence,
      algorithm: TOOL_EXECUTION_RESULT_REKEY_ALGORITHM,
      plaintextBytes: plaintext.length,
      rekeyedAtMs: timestamp(input.rekeyedAtMs, 'rekey time'),
    });
    const cipher = createCipheriv(
      TOOL_EXECUTION_RESULT_REKEY_ALGORITHM,
      targetKey,
      nonce,
      { authTagLength: 16 },
    );
    const aad = overlayAad(metadata);
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
        overlayId: metadata.overlayId,
        sourceArtifact: metadata.sourceArtifact,
        sourceBindingDigest: metadata.sourceBindingDigest,
        revision: metadata.revision,
        previousOverlayDigest: metadata.previousOverlayDigest,
        fromKeyId: metadata.fromKeyId,
        targetCatalogFence: metadata.targetCatalogFence,
        algorithm: metadata.algorithm,
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
        plaintextBytes: metadata.plaintextBytes,
        rekeyedAtMs: metadata.rekeyedAtMs,
      });
      const overlay = normalizeToolExecutionResultRekeyOverlay({
        ...unsigned,
        overlayDigest: hash(OVERLAY_DIGEST_DOMAIN, unsigned),
      });
      const commandUnsigned = Object.freeze({
        schema: TOOL_EXECUTION_RESULT_REKEY_COMMAND_SCHEMA,
        expectedRevision: previous?.revision ?? 0,
        expectedOverlayDigest: previous?.overlayDigest ?? null,
        mutationId: identity(input.mutationId, 'rekey mutation id'),
        overlay,
      });
      return normalizeToolExecutionResultRekeyCommand({
        ...commandUnsigned,
        commandDigest: hash(COMMAND_DIGEST_DOMAIN, commandUnsigned),
      });
    } finally {
      ciphertext.fill(0);
    }
  } catch (cause) {
    if (
      cause instanceof InvalidToolExecutionResultRekeyError ||
      cause instanceof ToolExecutionResultRekeyConflictError ||
      cause instanceof ToolExecutionResultRekeyUnavailableError
    ) {
      throw cause;
    }
    throw new ToolExecutionResultRekeyUnavailableError({
      cause: cause instanceof Error ? cause : undefined,
    });
  } finally {
    targetKey.fill(0);
    plaintext.fill(0);
    nonce?.fill(0);
  }
}

export function openToolExecutionResultRekeyOverlay(
  value: ToolExecutionResultRekeyOverlay,
  keyValue: Uint8Array,
  registry: ToolDefinitionRegistry,
  sourceArtifactValue: ToolExecutionResultArtifact,
): ToolJsonValue {
  const overlay = normalizeToolExecutionResultRekeyOverlay(value);
  const sourceArtifact =
    normalizeToolExecutionResultArtifact(sourceArtifactValue);
  if (
    JSON.stringify(overlay.sourceArtifact) !==
    JSON.stringify(sourceReference(sourceArtifact))
  ) {
    throw new ToolExecutionResultRekeyConflictError();
  }
  if (!(registry instanceof ToolDefinitionRegistry)) {
    return invalid('Tool registry is invalid');
  }
  const key = ownedKey(keyValue);
  const nonce = base64url(overlay.nonce, 'rekey nonce', 12);
  const ciphertext = base64url(overlay.ciphertext, 'rekey ciphertext');
  const authTag = base64url(overlay.authTag, 'rekey auth tag', 16);
  const aad = overlayAad(
    overlayMetadata({
      schema: overlay.schema,
      overlayId: overlay.overlayId,
      sourceArtifact: overlay.sourceArtifact,
      sourceBindingDigest: overlay.sourceBindingDigest,
      revision: overlay.revision,
      previousOverlayDigest: overlay.previousOverlayDigest,
      fromKeyId: overlay.fromKeyId,
      targetCatalogFence: overlay.targetCatalogFence,
      algorithm: overlay.algorithm,
      plaintextBytes: overlay.plaintextBytes,
      rekeyedAtMs: overlay.rekeyedAtMs,
    }),
  );
  let plaintext: Buffer | undefined;
  try {
    if (
      toolResultKeyMaterialProof(overlay.targetCatalogFence.keyId, key) !==
      overlay.targetCatalogFence.materialProof
    ) {
      throw new ToolExecutionResultRekeyUnavailableError();
    }
    const decipher = createDecipheriv(
      TOOL_EXECUTION_RESULT_REKEY_ALGORITHM,
      key,
      nonce,
      { authTagLength: 16 },
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length !== overlay.plaintextBytes) {
      throw new ToolExecutionResultRekeyUnavailableError();
    }
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
    const output = registry.normalizeOutput(
      sourceArtifact.tool.name,
      sourceArtifact.tool.version,
      parsed,
    );
    if (
      JSON.stringify(output) !== plaintext.toString('utf8') ||
      hash(OUTPUT_DIGEST_DOMAIN, output) !== overlay.sourceArtifact.outputDigest
    ) {
      throw new ToolExecutionResultRekeyUnavailableError();
    }
    return output;
  } catch (cause) {
    if (cause instanceof InvalidToolExecutionResultRekeyError) throw cause;
    throw new ToolExecutionResultRekeyUnavailableError({
      cause: cause instanceof Error ? cause : undefined,
    });
  } finally {
    key.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    authTag.fill(0);
    aad.fill(0);
    plaintext?.fill(0);
  }
}

export function normalizeToolResultKeyRetirementReceipt(
  value: ToolResultKeyRetirementReceipt,
): Readonly<ToolResultKeyRetirementReceipt> {
  const candidate = record(value, 'retirement receipt');
  exactKeys(
    candidate,
    [
      'bindingCount',
      'catalogDigest',
      'catalogGeneration',
      'coverageDigest',
      'createdAtMs',
      'keyId',
      'materialProof',
      'mutationId',
      'overlayHeadCount',
      'receiptDigest',
      'schema',
      'uncoveredBindingCount',
      'uncoveredOverlayHeadCount',
    ],
    'retirement receipt',
  );
  if (
    value.schema !== TOOL_RESULT_KEY_RETIREMENT_RECEIPT_SCHEMA ||
    value.uncoveredBindingCount !== 0 ||
    value.uncoveredOverlayHeadCount !== 0
  ) {
    return invalid('retirement receipt is not fully covered');
  }
  const unsigned = Object.freeze({
    schema: TOOL_RESULT_KEY_RETIREMENT_RECEIPT_SCHEMA,
    catalogGeneration: integer(
      value.catalogGeneration,
      'retirement catalog generation',
      1,
    ),
    catalogDigest: digest(value.catalogDigest, 'retirement catalog digest'),
    keyId: keyId(value.keyId),
    materialProof: digest(value.materialProof, 'retirement material proof'),
    mutationId: identity(value.mutationId, 'retirement mutation id'),
    bindingCount: integer(value.bindingCount, 'retirement binding count'),
    overlayHeadCount: integer(
      value.overlayHeadCount,
      'retirement overlay head count',
    ),
    uncoveredBindingCount: 0 as const,
    uncoveredOverlayHeadCount: 0 as const,
    coverageDigest: digest(value.coverageDigest, 'retirement coverage digest'),
    createdAtMs: timestamp(value.createdAtMs, 'retirement receipt time'),
  });
  const receiptDigest = digest(
    value.receiptDigest,
    'retirement receipt digest',
  );
  if (hash(RETIREMENT_RECEIPT_DIGEST_DOMAIN, unsigned) !== receiptDigest) {
    return invalid('retirement receipt digest does not match');
  }
  return Object.freeze({ ...unsigned, receiptDigest });
}

export function createToolResultKeyRetirementReceipt(
  input: Omit<
    ToolResultKeyRetirementReceipt,
    | 'receiptDigest'
    | 'schema'
    | 'uncoveredBindingCount'
    | 'uncoveredOverlayHeadCount'
  >,
): Readonly<ToolResultKeyRetirementReceipt> {
  const unsigned = Object.freeze({
    schema: TOOL_RESULT_KEY_RETIREMENT_RECEIPT_SCHEMA,
    catalogGeneration: input.catalogGeneration,
    catalogDigest: input.catalogDigest,
    keyId: input.keyId,
    materialProof: input.materialProof,
    mutationId: input.mutationId,
    bindingCount: input.bindingCount,
    overlayHeadCount: input.overlayHeadCount,
    uncoveredBindingCount: 0 as const,
    uncoveredOverlayHeadCount: 0 as const,
    coverageDigest: input.coverageDigest,
    createdAtMs: input.createdAtMs,
  });
  return normalizeToolResultKeyRetirementReceipt({
    ...unsigned,
    receiptDigest: hash(RETIREMENT_RECEIPT_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeToolResultKeyRetirementReceiptCommand(
  value: ToolResultKeyRetirementReceiptCommand,
): Readonly<ToolResultKeyRetirementReceiptCommand> {
  const candidate = record(value, 'retirement receipt command');
  exactKeys(
    candidate,
    [
      'commandDigest',
      'expectedCatalogDigest',
      'expectedCatalogGeneration',
      'keyId',
      'mutationId',
      'schema',
    ],
    'retirement receipt command',
  );
  if (value.schema !== TOOL_RESULT_KEY_RETIREMENT_RECEIPT_COMMAND_SCHEMA) {
    return invalid('retirement receipt command schema is invalid');
  }
  const unsigned = Object.freeze({
    schema: TOOL_RESULT_KEY_RETIREMENT_RECEIPT_COMMAND_SCHEMA,
    expectedCatalogGeneration: integer(
      value.expectedCatalogGeneration,
      'expected retirement catalog generation',
      1,
    ),
    expectedCatalogDigest: digest(
      value.expectedCatalogDigest,
      'expected retirement catalog digest',
    ),
    keyId: keyId(value.keyId),
    mutationId: identity(value.mutationId, 'retirement mutation id'),
  });
  const commandDigest = digest(
    value.commandDigest,
    'retirement receipt command digest',
  );
  if (
    hash(RETIREMENT_RECEIPT_COMMAND_DIGEST_DOMAIN, unsigned) !== commandDigest
  ) {
    return invalid('retirement receipt command digest does not match');
  }
  return Object.freeze({ ...unsigned, commandDigest });
}

export function createToolResultKeyRetirementReceiptCommand(
  input: Omit<
    ToolResultKeyRetirementReceiptCommand,
    'commandDigest' | 'schema'
  >,
): Readonly<ToolResultKeyRetirementReceiptCommand> {
  const unsigned = Object.freeze({
    schema: TOOL_RESULT_KEY_RETIREMENT_RECEIPT_COMMAND_SCHEMA,
    expectedCatalogGeneration: input.expectedCatalogGeneration,
    expectedCatalogDigest: input.expectedCatalogDigest,
    keyId: input.keyId,
    mutationId: input.mutationId,
  });
  return normalizeToolResultKeyRetirementReceiptCommand({
    ...unsigned,
    commandDigest: hash(RETIREMENT_RECEIPT_COMMAND_DIGEST_DOMAIN, unsigned),
  });
}

export class ToolResultKeyRetirementCoverageBuilder {
  readonly #catalogGeneration: number;
  readonly #catalogDigest: string;
  readonly #keyId: string;
  readonly #decryptableKeyIds!: ReadonlySet<string>;
  readonly #facts = createHash('sha256');
  #lastArtifactId: string | null = null;
  #bindingCount = 0;
  #overlayHeadCount = 0;
  #uncoveredBindingCount = 0;
  #uncoveredOverlayHeadCount = 0;
  #finished = false;

  constructor(
    input: Readonly<{
      catalogGeneration: number;
      catalogDigest: string;
      keyId: string;
      decryptableKeyIds: readonly string[];
    }>,
  ) {
    this.#catalogGeneration = integer(
      input.catalogGeneration,
      'coverage catalog generation',
      1,
    );
    this.#catalogDigest = digest(
      input.catalogDigest,
      'coverage catalog digest',
    );
    this.#keyId = keyId(input.keyId);
    if (
      !Array.isArray(input.decryptableKeyIds) ||
      input.decryptableKeyIds.length < 1 ||
      input.decryptableKeyIds.length > 16
    ) {
      return invalid('coverage decryptable key set is invalid');
    }
    const normalized = input.decryptableKeyIds.map((value) => keyId(value));
    if (
      normalized.some(
        (value, index) =>
          index > 0 && value.localeCompare(normalized[index - 1]!) <= 0,
      ) ||
      normalized.includes(this.#keyId)
    ) {
      return invalid('coverage decryptable key order is invalid');
    }
    this.#decryptableKeyIds = new Set(normalized);
    this.#facts.update(RETIREMENT_COVERAGE_SET_DIGEST_DOMAIN);
    this.#facts.update(
      JSON.stringify({
        catalogGeneration: this.#catalogGeneration,
        catalogDigest: this.#catalogDigest,
        keyId: this.#keyId,
        decryptableKeyIds: normalized,
      }),
    );
  }

  add(value: ToolResultKeyRetirementCoverageFact): void {
    if (this.#finished) return invalid('coverage builder is already finished');
    const candidate = record(value, 'retirement coverage fact');
    exactKeys(
      candidate,
      [
        'artifactId',
        'bindingDigest',
        'bindingKeyId',
        'headOverlayDigest',
        'headTargetCatalogDigest',
        'headTargetCatalogGeneration',
        'headTargetKeyId',
      ],
      'retirement coverage fact',
    );
    const artifactId = identity(value.artifactId, 'coverage Artifact id');
    if (
      this.#lastArtifactId !== null &&
      artifactId.localeCompare(this.#lastArtifactId) <= 0
    ) {
      return invalid('coverage facts are not strictly ordered');
    }
    const headTargetKeyId =
      value.headTargetKeyId === null ? null : keyId(value.headTargetKeyId);
    const headOverlayDigest = nullableDigest(
      value.headOverlayDigest,
      'coverage head overlay digest',
    );
    const headTargetCatalogGeneration =
      value.headTargetCatalogGeneration === null
        ? null
        : integer(
            value.headTargetCatalogGeneration,
            'coverage head catalog generation',
            1,
          );
    const headTargetCatalogDigest = nullableDigest(
      value.headTargetCatalogDigest,
      'coverage head catalog digest',
    );
    if (
      (headTargetKeyId !== null) !==
      (headOverlayDigest !== null &&
        headTargetCatalogGeneration !== null &&
        headTargetCatalogDigest !== null)
    ) {
      return invalid('coverage head shape is invalid');
    }
    const fact = Object.freeze({
      artifactId,
      bindingDigest: digest(value.bindingDigest, 'coverage binding digest'),
      bindingKeyId: keyId(value.bindingKeyId),
      headOverlayDigest,
      headTargetKeyId,
      headTargetCatalogGeneration,
      headTargetCatalogDigest,
    });
    const bindingIsRetiring = fact.bindingKeyId === this.#keyId;
    const headTargetsRetiring = fact.headTargetKeyId === this.#keyId;
    if (!bindingIsRetiring && !headTargetsRetiring) {
      return invalid('coverage fact is unrelated to the retiring key');
    }
    if (bindingIsRetiring) {
      this.#bindingCount += 1;
      if (
        fact.headTargetKeyId === null ||
        !this.#decryptableKeyIds.has(fact.headTargetKeyId)
      ) {
        this.#uncoveredBindingCount += 1;
      }
    }
    if (fact.headTargetKeyId !== null) this.#overlayHeadCount += 1;
    if (headTargetsRetiring) this.#uncoveredOverlayHeadCount += 1;
    this.#facts.update(
      Buffer.from(hash(RETIREMENT_COVERAGE_FACT_DIGEST_DOMAIN, fact), 'hex'),
    );
    this.#lastArtifactId = artifactId;
  }

  finish(): Readonly<ToolResultKeyRetirementCoverage> {
    if (this.#finished) return invalid('coverage builder is already finished');
    this.#finished = true;
    const entriesDigest = this.#facts.digest('hex');
    const unsigned = Object.freeze({
      catalogGeneration: this.#catalogGeneration,
      catalogDigest: this.#catalogDigest,
      keyId: this.#keyId,
      bindingCount: this.#bindingCount,
      overlayHeadCount: this.#overlayHeadCount,
      uncoveredBindingCount: this.#uncoveredBindingCount,
      uncoveredOverlayHeadCount: this.#uncoveredOverlayHeadCount,
      entriesDigest,
    });
    return Object.freeze({
      bindingCount: unsigned.bindingCount,
      overlayHeadCount: unsigned.overlayHeadCount,
      uncoveredBindingCount: unsigned.uncoveredBindingCount,
      uncoveredOverlayHeadCount: unsigned.uncoveredOverlayHeadCount,
      coverageDigest: hash(RETIREMENT_COVERAGE_FINAL_DIGEST_DOMAIN, unsigned),
    });
  }
}

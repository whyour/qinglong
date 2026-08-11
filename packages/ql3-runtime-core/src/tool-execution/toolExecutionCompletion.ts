import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import { normalizeStepRunMutation, type StepRunMutation } from '../run/stepRun';
import {
  normalizeToolExecutionStartBarrierRecord,
  type ToolExecutionStartBarrierRecord,
} from './toolExecutionStartBarrier';
import {
  normalizeToolResultKeyCatalogFence,
  type ToolResultKeyCatalogFence,
} from './toolResultKeyCatalog';
import {
  MAX_TOOL_OUTPUT_BYTES,
  ToolDefinitionRegistry,
  type ToolJsonValue,
} from './tool-registry/toolRegistry';
import {
  TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
  type TrustedToolExecutionResult,
} from './trustedToolExecution';

export const TOOL_EXECUTION_RESULT_ARTIFACT_SCHEMA =
  'qinglong/tool-execution-result-artifact@v1' as const;
export const TOOL_EXECUTION_COMPLETION_SCHEMA =
  'qinglong/tool-execution-completion@v1' as const;
export const TOOL_EXECUTION_COMPLETION_COMMAND_SCHEMA =
  'qinglong/tool-execution-completion-command@v2' as const;
export const TOOL_EXECUTION_RESULT_KEY_BINDING_SCHEMA =
  'qinglong/tool-execution-result-key-binding@v1' as const;
export const TOOL_EXECUTION_RESULT_ARTIFACT_ALGORITHM = 'aes-256-gcm' as const;
export const MAX_TOOL_EXECUTION_RESULT_ARTIFACT_JSON_BYTES = 384 * 1024;
export const MAX_TOOL_EXECUTION_COMPLETION_JSON_BYTES = 24 * 1024;

export interface ToolExecutionResultArtifact {
  readonly schema: typeof TOOL_EXECUTION_RESULT_ARTIFACT_SCHEMA;
  readonly artifactId: string;
  readonly projectId: string;
  readonly startId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly tool: Readonly<{ name: string; version: string }>;
  readonly barrierDigest: string;
  readonly adapterDigest: string;
  readonly outputDigest: string;
  readonly executionResultDigest: string;
  readonly keyId: string;
  readonly algorithm: typeof TOOL_EXECUTION_RESULT_ARTIFACT_ALGORITHM;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
  readonly plaintextBytes: number;
  readonly sealedAtMs: number;
  readonly artifactDigest: string;
}

export interface ToolExecutionResultArtifactReference {
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly outputDigest: string;
  readonly executionResultDigest: string;
}

export interface ToolExecutionCompletionRecord {
  readonly schema: typeof TOOL_EXECUTION_COMPLETION_SCHEMA;
  readonly startId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly startedStepRunVersion: number;
  readonly completedStepRunVersion: number;
  readonly barrierDigest: string;
  readonly adapterDigest: string;
  readonly resultArtifact: Readonly<ToolExecutionResultArtifactReference>;
  readonly stepRunMutationId: string;
  readonly stepRunMutationDigest: string;
  readonly completedStepRunDigest: string;
  readonly runEventId: string;
  readonly completedAtMs: number;
  readonly completionDigest: string;
}

export interface ToolExecutionCompletionCommand {
  readonly schema: typeof TOOL_EXECUTION_COMPLETION_COMMAND_SCHEMA;
  readonly barrier: Readonly<ToolExecutionStartBarrierRecord>;
  readonly executionResult: Readonly<TrustedToolExecutionResult>;
  readonly resultArtifact: Readonly<ToolExecutionResultArtifact>;
  readonly resultKeyCatalogFence: Readonly<ToolResultKeyCatalogFence>;
  readonly stepRunMutation: Readonly<StepRunMutation>;
  readonly commandDigest: string;
}

export interface ToolExecutionResultKeyBinding {
  readonly schema: typeof TOOL_EXECUTION_RESULT_KEY_BINDING_SCHEMA;
  readonly startId: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly catalogGeneration: number;
  readonly catalogDigest: string;
  readonly keyId: string;
  readonly materialProof: string;
  readonly bindingDigest: string;
}

export interface CommitToolExecutionCompletionResult {
  readonly status: 'created' | 'existing';
  readonly completion: Readonly<ToolExecutionCompletionRecord>;
}

export interface ToolExecutionCompletionRepository {
  findByStartId(
    startId: string,
  ): Promise<Readonly<ToolExecutionCompletionRecord> | null>;
  findResultArtifact(
    artifactId: string,
  ): Promise<Readonly<ToolExecutionResultArtifact> | null>;
  commit(
    command: ToolExecutionCompletionCommand,
  ): Promise<Readonly<CommitToolExecutionCompletionResult>>;
}

export class InvalidToolExecutionCompletionError extends TypeError {
  readonly code = 'TOOL_EXECUTION_COMPLETION_INVALID';

  constructor(message: string) {
    super(`Tool execution completion is invalid: ${message}`);
    this.name = 'InvalidToolExecutionCompletionError';
  }
}

export class ToolExecutionCompletionConflictError extends Error {
  readonly code = 'TOOL_EXECUTION_COMPLETION_CONFLICT';

  constructor() {
    super('Tool execution completion conflicts with durable state');
    this.name = 'ToolExecutionCompletionConflictError';
  }
}

export class ToolExecutionCompletionUnavailableError extends Error {
  readonly code = 'TOOL_EXECUTION_COMPLETION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Tool execution completion authority is unavailable', options);
    this.name = 'ToolExecutionCompletionUnavailableError';
  }
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const TOOL_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const OUTPUT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-output-digest@v1\0',
  'utf8',
);
const EXECUTION_RESULT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-result-digest@v1\0',
  'utf8',
);
const RESULT_ARTIFACT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-result-artifact-digest@v1\0',
  'utf8',
);
const COMPLETION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-completion-digest@v1\0',
  'utf8',
);
const COMPLETION_COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-completion-command-digest@v1\0',
  'utf8',
);
const RESULT_KEY_BINDING_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-result-key-binding-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidToolExecutionCompletionError(message);
}

function hash(domain: Uint8Array, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
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

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
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

function version(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 2 ||
    (value as number) > 2_147_483_647
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function toolIdentity(
  value: Readonly<{ name: string; version: string }>,
): Readonly<{ name: string; version: string }> {
  const candidate = record(value, 'Tool identity');
  exactKeys(candidate, ['name', 'version'], 'Tool identity');
  if (
    typeof value.name !== 'string' ||
    !TOOL_NAME_PATTERN.test(value.name) ||
    typeof value.version !== 'string' ||
    !TOOL_VERSION_PATTERN.test(value.version)
  ) {
    return invalid('Tool identity is invalid');
  }
  return Object.freeze({ name: value.name, version: value.version });
}

function jsonValue(value: unknown, depth = 0): ToolJsonValue {
  if (depth > 16) return invalid('output nesting is too deep');
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid('output number is invalid');
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => jsonValue(item, depth + 1)));
  }
  const source = record(value, 'output value');
  const normalized: Record<string, ToolJsonValue> = {};
  for (const key of Object.keys(source)) {
    normalized[key] = jsonValue(source[key], depth + 1);
  }
  return Object.freeze(normalized);
}

function base64url(value: unknown, label: string, exactBytes?: number): Buffer {
  if (
    typeof value !== 'string' ||
    !BASE64URL_PATTERN.test(value) ||
    value.length === 0
  ) {
    return invalid(`${label} is invalid`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.toString('base64url') !== value ||
    (exactBytes !== undefined && decoded.length !== exactBytes)
  ) {
    decoded.fill(0);
    return invalid(`${label} is invalid`);
  }
  return decoded;
}

function ownedKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    return invalid('result Artifact key is invalid');
  }
  return Buffer.from(value);
}

function normalizeExecutionResult(
  value: TrustedToolExecutionResult,
): Readonly<TrustedToolExecutionResult> {
  const candidate = record(value, 'execution result');
  exactKeys(
    candidate,
    [
      'adapterDigest',
      'barrierDigest',
      'completedAtMs',
      'output',
      'outputDigest',
      'resultDigest',
      'schema',
      'startId',
    ],
    'execution result',
  );
  if (value.schema !== TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA) {
    return invalid('execution result schema is invalid');
  }
  const output = jsonValue(value.output);
  const outputJson = JSON.stringify(output);
  if (Buffer.byteLength(outputJson, 'utf8') > MAX_TOOL_OUTPUT_BYTES) {
    return invalid('execution result output exceeds its budget');
  }
  const outputDigest = digest(value.outputDigest, 'output digest');
  if (hash(OUTPUT_DIGEST_DOMAIN, output) !== outputDigest) {
    return invalid('execution result output digest does not match');
  }
  const unsigned = Object.freeze({
    schema: TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
    startId: identity(value.startId, 'execution result start id'),
    barrierDigest: digest(value.barrierDigest, 'barrier digest'),
    adapterDigest: digest(value.adapterDigest, 'adapter digest'),
    output,
    outputDigest,
    completedAtMs: timestamp(value.completedAtMs, 'completion time'),
  });
  const resultDigest = digest(value.resultDigest, 'execution result digest');
  if (hash(EXECUTION_RESULT_DIGEST_DOMAIN, unsigned) !== resultDigest) {
    return invalid('execution result digest does not match');
  }
  return Object.freeze({ ...unsigned, resultDigest });
}

function artifactMetadata(
  artifact: Omit<
    ToolExecutionResultArtifact,
    'artifactDigest' | 'authTag' | 'ciphertext' | 'nonce'
  >,
): Readonly<
  Omit<
    ToolExecutionResultArtifact,
    'artifactDigest' | 'authTag' | 'ciphertext' | 'nonce'
  >
> {
  return Object.freeze(artifact);
}

function artifactAad(metadata: ReturnType<typeof artifactMetadata>): Buffer {
  return Buffer.from(JSON.stringify(metadata), 'utf8');
}

export function normalizeToolExecutionResultArtifact(
  value: ToolExecutionResultArtifact,
): Readonly<ToolExecutionResultArtifact> {
  const candidate = record(value, 'result Artifact');
  exactKeys(
    candidate,
    [
      'adapterDigest',
      'algorithm',
      'artifactDigest',
      'artifactId',
      'authTag',
      'barrierDigest',
      'ciphertext',
      'executionResultDigest',
      'keyId',
      'nonce',
      'outputDigest',
      'plaintextBytes',
      'projectId',
      'runId',
      'schema',
      'sealedAtMs',
      'startId',
      'stepRunId',
      'tool',
    ],
    'result Artifact',
  );
  if (
    value.schema !== TOOL_EXECUTION_RESULT_ARTIFACT_SCHEMA ||
    value.algorithm !== TOOL_EXECUTION_RESULT_ARTIFACT_ALGORITHM ||
    typeof value.keyId !== 'string' ||
    !KEY_ID_PATTERN.test(value.keyId)
  ) {
    return invalid('result Artifact schema, algorithm or key id is invalid');
  }
  const nonce = base64url(value.nonce, 'result Artifact nonce', 12);
  const ciphertext = base64url(value.ciphertext, 'result Artifact ciphertext');
  const authTag = base64url(value.authTag, 'result Artifact auth tag', 16);
  nonce.fill(0);
  ciphertext.fill(0);
  authTag.fill(0);
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_RESULT_ARTIFACT_SCHEMA,
    artifactId: identity(value.artifactId, 'result Artifact id'),
    projectId: identity(value.projectId, 'result Artifact project id'),
    startId: identity(value.startId, 'result Artifact start id'),
    runId: identity(value.runId, 'result Artifact Run id'),
    stepRunId: identity(value.stepRunId, 'result Artifact StepRun id'),
    tool: toolIdentity(value.tool),
    barrierDigest: digest(
      value.barrierDigest,
      'result Artifact barrier digest',
    ),
    adapterDigest: digest(
      value.adapterDigest,
      'result Artifact adapter digest',
    ),
    outputDigest: digest(value.outputDigest, 'result Artifact output digest'),
    executionResultDigest: digest(
      value.executionResultDigest,
      'execution result digest',
    ),
    keyId: value.keyId,
    algorithm: TOOL_EXECUTION_RESULT_ARTIFACT_ALGORITHM,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    authTag: value.authTag,
    plaintextBytes: timestamp(value.plaintextBytes, 'plaintext byte count'),
    sealedAtMs: timestamp(value.sealedAtMs, 'result Artifact seal time'),
  });
  if (
    unsigned.plaintextBytes > MAX_TOOL_OUTPUT_BYTES ||
    Buffer.byteLength(JSON.stringify(unsigned), 'utf8') >
      MAX_TOOL_EXECUTION_RESULT_ARTIFACT_JSON_BYTES
  ) {
    return invalid('result Artifact exceeds its budget');
  }
  const artifactDigest = digest(value.artifactDigest, 'result Artifact digest');
  if (hash(RESULT_ARTIFACT_DIGEST_DOMAIN, unsigned) !== artifactDigest) {
    return invalid('result Artifact digest does not match');
  }
  return Object.freeze({ ...unsigned, artifactDigest });
}

export function toolExecutionResultArtifactReference(
  value: ToolExecutionResultArtifact,
): Readonly<ToolExecutionResultArtifactReference> {
  const artifact = normalizeToolExecutionResultArtifact(value);
  return Object.freeze({
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    outputDigest: artifact.outputDigest,
    executionResultDigest: artifact.executionResultDigest,
  });
}

export function createToolExecutionResultArtifact(
  input: Readonly<{
    artifactId: string;
    projectId: string;
    runId: string;
    stepRunId: string;
    tool: Readonly<{ name: string; version: string }>;
    executionResult: Readonly<TrustedToolExecutionResult>;
    keyId: string;
    key: Uint8Array;
  }>,
  registry: ToolDefinitionRegistry,
  nonceFactory: () => Uint8Array = () => randomBytes(12),
): Readonly<ToolExecutionResultArtifact> {
  if (!(registry instanceof ToolDefinitionRegistry)) {
    return invalid('Tool registry is invalid');
  }
  const result = normalizeExecutionResult(input.executionResult);
  const tool = toolIdentity(input.tool);
  const output = registry.normalizeOutput(
    tool.name,
    tool.version,
    result.output,
  );
  if (JSON.stringify(output) !== JSON.stringify(result.output)) {
    return invalid('execution output is not canonical for the Tool');
  }
  const plaintext = Buffer.from(JSON.stringify(output), 'utf8');
  const key = ownedKey(input.key);
  let nonce: Buffer | undefined;
  try {
    nonce = Buffer.from(nonceFactory());
    if (nonce.length !== 12) {
      throw new ToolExecutionCompletionUnavailableError();
    }
    const metadata = artifactMetadata({
      schema: TOOL_EXECUTION_RESULT_ARTIFACT_SCHEMA,
      artifactId: identity(input.artifactId, 'result Artifact id'),
      projectId: identity(input.projectId, 'result Artifact project id'),
      startId: result.startId,
      runId: identity(input.runId, 'result Artifact Run id'),
      stepRunId: identity(input.stepRunId, 'result Artifact StepRun id'),
      tool,
      barrierDigest: result.barrierDigest,
      adapterDigest: result.adapterDigest,
      outputDigest: result.outputDigest,
      executionResultDigest: result.resultDigest,
      keyId:
        typeof input.keyId === 'string' && KEY_ID_PATTERN.test(input.keyId)
          ? input.keyId
          : invalid('result Artifact key id is invalid'),
      algorithm: TOOL_EXECUTION_RESULT_ARTIFACT_ALGORITHM,
      plaintextBytes: plaintext.length,
      sealedAtMs: result.completedAtMs,
    });
    const cipher = createCipheriv(
      TOOL_EXECUTION_RESULT_ARTIFACT_ALGORITHM,
      key,
      nonce,
      { authTagLength: 16 },
    );
    const aad = artifactAad(metadata);
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
        startId: metadata.startId,
        runId: metadata.runId,
        stepRunId: metadata.stepRunId,
        tool: metadata.tool,
        barrierDigest: metadata.barrierDigest,
        adapterDigest: metadata.adapterDigest,
        outputDigest: metadata.outputDigest,
        executionResultDigest: metadata.executionResultDigest,
        keyId: metadata.keyId,
        algorithm: metadata.algorithm,
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
        plaintextBytes: metadata.plaintextBytes,
        sealedAtMs: metadata.sealedAtMs,
      });
      return normalizeToolExecutionResultArtifact({
        ...unsigned,
        artifactDigest: hash(RESULT_ARTIFACT_DIGEST_DOMAIN, unsigned),
      });
    } finally {
      ciphertext.fill(0);
    }
  } catch (cause) {
    if (
      cause instanceof InvalidToolExecutionCompletionError ||
      cause instanceof ToolExecutionCompletionUnavailableError
    ) {
      throw cause;
    }
    throw new ToolExecutionCompletionUnavailableError({
      cause: cause instanceof Error ? cause : undefined,
    });
  } finally {
    key.fill(0);
    plaintext.fill(0);
    nonce?.fill(0);
  }
}

export function openToolExecutionResultArtifact(
  artifactValue: ToolExecutionResultArtifact,
  keyValue: Uint8Array,
  registry: ToolDefinitionRegistry,
): ToolJsonValue {
  const artifact = normalizeToolExecutionResultArtifact(artifactValue);
  if (!(registry instanceof ToolDefinitionRegistry)) {
    return invalid('Tool registry is invalid');
  }
  const key = ownedKey(keyValue);
  const nonce = base64url(artifact.nonce, 'result Artifact nonce', 12);
  const ciphertext = base64url(
    artifact.ciphertext,
    'result Artifact ciphertext',
  );
  const authTag = base64url(artifact.authTag, 'result Artifact auth tag', 16);
  const aad = artifactAad(
    artifactMetadata({
      schema: artifact.schema,
      artifactId: artifact.artifactId,
      projectId: artifact.projectId,
      startId: artifact.startId,
      runId: artifact.runId,
      stepRunId: artifact.stepRunId,
      tool: artifact.tool,
      barrierDigest: artifact.barrierDigest,
      adapterDigest: artifact.adapterDigest,
      outputDigest: artifact.outputDigest,
      executionResultDigest: artifact.executionResultDigest,
      keyId: artifact.keyId,
      algorithm: artifact.algorithm,
      plaintextBytes: artifact.plaintextBytes,
      sealedAtMs: artifact.sealedAtMs,
    }),
  );
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
      TOOL_EXECUTION_RESULT_ARTIFACT_ALGORITHM,
      key,
      nonce,
      { authTagLength: 16 },
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length !== artifact.plaintextBytes) {
      throw new ToolExecutionCompletionUnavailableError();
    }
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
    const output = registry.normalizeOutput(
      artifact.tool.name,
      artifact.tool.version,
      parsed,
    );
    if (
      JSON.stringify(output) !== plaintext.toString('utf8') ||
      hash(OUTPUT_DIGEST_DOMAIN, output) !== artifact.outputDigest
    ) {
      throw new ToolExecutionCompletionUnavailableError();
    }
    return output;
  } catch (cause) {
    if (cause instanceof InvalidToolExecutionCompletionError) throw cause;
    throw new ToolExecutionCompletionUnavailableError({
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

export function normalizeToolExecutionCompletionRecord(
  value: ToolExecutionCompletionRecord,
): Readonly<ToolExecutionCompletionRecord> {
  const candidate = record(value, 'completion');
  exactKeys(
    candidate,
    [
      'adapterDigest',
      'barrierDigest',
      'completedAtMs',
      'completedStepRunDigest',
      'completedStepRunVersion',
      'completionDigest',
      'projectId',
      'resultArtifact',
      'runEventId',
      'runId',
      'schema',
      'startId',
      'startedStepRunVersion',
      'stepRunId',
      'stepRunMutationDigest',
      'stepRunMutationId',
    ],
    'completion',
  );
  if (value.schema !== TOOL_EXECUTION_COMPLETION_SCHEMA) {
    return invalid('completion schema is invalid');
  }
  const referenceValue = record(
    value.resultArtifact,
    'result Artifact reference',
  );
  exactKeys(
    referenceValue,
    ['artifactDigest', 'artifactId', 'executionResultDigest', 'outputDigest'],
    'result Artifact reference',
  );
  const startedStepRunVersion = version(
    value.startedStepRunVersion,
    'started StepRun version',
  );
  const completedStepRunVersion = version(
    value.completedStepRunVersion,
    'completed StepRun version',
  );
  if (completedStepRunVersion !== startedStepRunVersion + 1) {
    return invalid('completion StepRun version fence is invalid');
  }
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_COMPLETION_SCHEMA,
    startId: identity(value.startId, 'completion start id'),
    projectId: identity(value.projectId, 'completion project id'),
    runId: identity(value.runId, 'completion Run id'),
    stepRunId: identity(value.stepRunId, 'completion StepRun id'),
    startedStepRunVersion,
    completedStepRunVersion,
    barrierDigest: digest(value.barrierDigest, 'completion barrier digest'),
    adapterDigest: digest(value.adapterDigest, 'completion adapter digest'),
    resultArtifact: Object.freeze({
      artifactId: identity(
        value.resultArtifact.artifactId,
        'result Artifact id',
      ),
      artifactDigest: digest(
        value.resultArtifact.artifactDigest,
        'result Artifact digest',
      ),
      outputDigest: digest(
        value.resultArtifact.outputDigest,
        'result Artifact output digest',
      ),
      executionResultDigest: digest(
        value.resultArtifact.executionResultDigest,
        'execution result digest',
      ),
    }),
    stepRunMutationId: identity(
      value.stepRunMutationId,
      'completion mutation id',
    ),
    stepRunMutationDigest: digest(
      value.stepRunMutationDigest,
      'completion mutation digest',
    ),
    completedStepRunDigest: digest(
      value.completedStepRunDigest,
      'completed StepRun digest',
    ),
    runEventId: identity(value.runEventId, 'completion Run event id'),
    completedAtMs: timestamp(value.completedAtMs, 'completion time'),
  });
  if (
    Buffer.byteLength(JSON.stringify(unsigned), 'utf8') >
    MAX_TOOL_EXECUTION_COMPLETION_JSON_BYTES
  ) {
    return invalid('completion exceeds its budget');
  }
  const completionDigest = digest(value.completionDigest, 'completion digest');
  if (hash(COMPLETION_DIGEST_DOMAIN, unsigned) !== completionDigest) {
    return invalid('completion digest does not match');
  }
  return Object.freeze({ ...unsigned, completionDigest });
}

function completionFromParts(
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
  result: Readonly<TrustedToolExecutionResult>,
  artifact: Readonly<ToolExecutionResultArtifact>,
  mutation: Readonly<StepRunMutation>,
): Readonly<ToolExecutionCompletionRecord> {
  const reference = toolExecutionResultArtifactReference(artifact);
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_COMPLETION_SCHEMA,
    startId: barrier.startId,
    projectId: barrier.projectId,
    runId: barrier.runId,
    stepRunId: barrier.stepRunId,
    startedStepRunVersion: barrier.startedStepRunVersion,
    completedStepRunVersion: mutation.stepRun.version,
    barrierDigest: barrier.barrierDigest,
    adapterDigest: barrier.adapterDigest,
    resultArtifact: reference,
    stepRunMutationId: mutation.mutationId,
    stepRunMutationDigest: mutation.mutationDigest,
    completedStepRunDigest: mutation.stepRun.stepRunDigest,
    runEventId: mutation.event.id,
    completedAtMs: result.completedAtMs,
  });
  return normalizeToolExecutionCompletionRecord({
    ...unsigned,
    completionDigest: hash(COMPLETION_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeToolExecutionCompletionCommand(
  value: ToolExecutionCompletionCommand,
): Readonly<ToolExecutionCompletionCommand> {
  const candidate = record(value, 'completion command');
  exactKeys(
    candidate,
    [
      'barrier',
      'commandDigest',
      'executionResult',
      'resultArtifact',
      'resultKeyCatalogFence',
      'schema',
      'stepRunMutation',
    ],
    'completion command',
  );
  if (value.schema !== TOOL_EXECUTION_COMPLETION_COMMAND_SCHEMA) {
    return invalid('completion command schema is invalid');
  }
  const barrier = normalizeToolExecutionStartBarrierRecord(value.barrier);
  const executionResult = normalizeExecutionResult(value.executionResult);
  const resultArtifact = normalizeToolExecutionResultArtifact(
    value.resultArtifact,
  );
  const resultKeyCatalogFence = normalizeToolResultKeyCatalogFence(
    value.resultKeyCatalogFence,
  );
  const stepRunMutation = normalizeStepRunMutation(value.stepRunMutation);
  if (
    executionResult.startId !== barrier.startId ||
    executionResult.barrierDigest !== barrier.barrierDigest ||
    executionResult.adapterDigest !== barrier.adapterDigest ||
    executionResult.completedAtMs < barrier.startedAtMs ||
    resultArtifact.projectId !== barrier.projectId ||
    resultArtifact.startId !== barrier.startId ||
    resultArtifact.runId !== barrier.runId ||
    resultArtifact.stepRunId !== barrier.stepRunId ||
    resultArtifact.barrierDigest !== barrier.barrierDigest ||
    resultArtifact.adapterDigest !== barrier.adapterDigest ||
    resultArtifact.outputDigest !== executionResult.outputDigest ||
    resultArtifact.executionResultDigest !== executionResult.resultDigest ||
    resultArtifact.keyId !== resultKeyCatalogFence.keyId ||
    resultArtifact.sealedAtMs !== executionResult.completedAtMs ||
    stepRunMutation.runId !== barrier.runId ||
    stepRunMutation.stepRun.id !== barrier.stepRunId ||
    stepRunMutation.stepRun.kind !== 'tool' ||
    stepRunMutation.previousStatus !== 'running' ||
    stepRunMutation.expectedStepRunVersion !== barrier.startedStepRunVersion ||
    stepRunMutation.expectedStepRunDigest !== barrier.startedStepRunDigest ||
    stepRunMutation.stepRun.status !== 'succeeded' ||
    stepRunMutation.stepRun.outputRef !== resultArtifact.artifactId ||
    stepRunMutation.stepRun.finishedAtMs !== executionResult.completedAtMs ||
    stepRunMutation.stepRun.updatedAtMs !== executionResult.completedAtMs
  ) {
    throw new ToolExecutionCompletionConflictError();
  }
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_COMPLETION_COMMAND_SCHEMA,
    barrier,
    executionResult,
    resultArtifact,
    resultKeyCatalogFence,
    stepRunMutation,
  });
  const commandDigest = digest(
    value.commandDigest,
    'completion command digest',
  );
  if (hash(COMPLETION_COMMAND_DIGEST_DOMAIN, unsigned) !== commandDigest) {
    return invalid('completion command digest does not match');
  }
  return Object.freeze({ ...unsigned, commandDigest });
}

export function createToolExecutionCompletionCommand(
  value: Omit<ToolExecutionCompletionCommand, 'commandDigest' | 'schema'>,
): Readonly<ToolExecutionCompletionCommand> {
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_COMPLETION_COMMAND_SCHEMA,
    barrier: normalizeToolExecutionStartBarrierRecord(value.barrier),
    executionResult: normalizeExecutionResult(value.executionResult),
    resultArtifact: normalizeToolExecutionResultArtifact(value.resultArtifact),
    resultKeyCatalogFence: normalizeToolResultKeyCatalogFence(
      value.resultKeyCatalogFence,
    ),
    stepRunMutation: normalizeStepRunMutation(value.stepRunMutation),
  });
  return normalizeToolExecutionCompletionCommand({
    ...unsigned,
    commandDigest: hash(COMPLETION_COMMAND_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeToolExecutionResultKeyBinding(
  value: ToolExecutionResultKeyBinding,
): Readonly<ToolExecutionResultKeyBinding> {
  const candidate = record(value, 'result key binding');
  exactKeys(
    candidate,
    [
      'artifactDigest',
      'artifactId',
      'bindingDigest',
      'catalogDigest',
      'catalogGeneration',
      'keyId',
      'materialProof',
      'schema',
      'startId',
    ],
    'result key binding',
  );
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_RESULT_KEY_BINDING_SCHEMA,
    startId: identity(value.startId, 'result key binding start id'),
    artifactId: identity(value.artifactId, 'result key binding Artifact id'),
    artifactDigest: digest(
      value.artifactDigest,
      'result key binding Artifact digest',
    ),
    catalogGeneration: timestamp(
      value.catalogGeneration,
      'result key catalog generation',
    ),
    catalogDigest: digest(value.catalogDigest, 'result key catalog digest'),
    keyId:
      typeof value.keyId === 'string' && KEY_ID_PATTERN.test(value.keyId)
        ? value.keyId
        : invalid('result key binding key id is invalid'),
    materialProof: digest(value.materialProof, 'result key material proof'),
  });
  if (unsigned.catalogGeneration < 1) {
    return invalid('result key catalog generation is invalid');
  }
  const bindingDigest = digest(
    value.bindingDigest,
    'result key binding digest',
  );
  if (hash(RESULT_KEY_BINDING_DIGEST_DOMAIN, unsigned) !== bindingDigest) {
    return invalid('result key binding digest does not match');
  }
  return Object.freeze({ ...unsigned, bindingDigest });
}

export function toolExecutionResultKeyBinding(
  commandValue: ToolExecutionCompletionCommand,
): Readonly<ToolExecutionResultKeyBinding> {
  const command = normalizeToolExecutionCompletionCommand(commandValue);
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_RESULT_KEY_BINDING_SCHEMA,
    startId: command.barrier.startId,
    artifactId: command.resultArtifact.artifactId,
    artifactDigest: command.resultArtifact.artifactDigest,
    catalogGeneration: command.resultKeyCatalogFence.generation,
    catalogDigest: command.resultKeyCatalogFence.catalogDigest,
    keyId: command.resultKeyCatalogFence.keyId,
    materialProof: command.resultKeyCatalogFence.materialProof,
  });
  return normalizeToolExecutionResultKeyBinding({
    ...unsigned,
    bindingDigest: hash(RESULT_KEY_BINDING_DIGEST_DOMAIN, unsigned),
  });
}

export function toolExecutionCompletionRecord(
  commandValue: ToolExecutionCompletionCommand,
): Readonly<ToolExecutionCompletionRecord> {
  const command = normalizeToolExecutionCompletionCommand(commandValue);
  return completionFromParts(
    command.barrier,
    command.executionResult,
    command.resultArtifact,
    command.stepRunMutation,
  );
}

import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import type { GenerateResult } from '../../../model-gateway/model';
import { normalizeGenerateResult } from '../../../model-gateway/validation';
import type { FailureDiagnosisModelEgressEvidence } from '../contracts';

export const COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ARTIFACT_SCHEMA =
  'qinglong/copilot-failure-diagnosis-output-artifact@v1' as const;
export const COPILOT_FAILURE_DIAGNOSIS_OUTPUT_REFERENCE_SCHEMA =
  'qinglong/copilot-failure-diagnosis-output-reference@v1' as const;
export const COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ALGORITHM =
  'aes-256-gcm' as const;
export const MAX_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ARTIFACT_BYTES =
  1536 * 1024;

export interface CopilotFailureDiagnosisOutputArtifact {
  readonly schema: typeof COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ARTIFACT_SCHEMA;
  readonly artifactId: string;
  readonly requestId: string;
  readonly planDigest: string;
  readonly toolCompletionDigest: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly invocationId: string;
  readonly provider: string;
  readonly model: string;
  readonly egressEvidenceDigest: string;
  readonly contentDigest: string;
  readonly outputBytes: number;
  readonly keyId: string;
  readonly algorithm: typeof COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ALGORITHM;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
  readonly plaintextBytes: number;
  readonly sealedAtMs: number;
  readonly artifactDigest: string;
}

export interface CopilotFailureDiagnosisOutputReference {
  readonly schema: typeof COPILOT_FAILURE_DIAGNOSIS_OUTPUT_REFERENCE_SCHEMA;
  readonly artifactId: string;
  readonly requestId: string;
  readonly planDigest: string;
  readonly toolCompletionDigest: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly invocationId: string;
  readonly provider: string;
  readonly model: string;
  readonly egressEvidenceDigest: string;
  readonly contentDigest: string;
  readonly outputBytes: number;
  readonly keyId: string;
  readonly algorithm: typeof COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ALGORITHM;
  readonly sealedAtMs: number;
  readonly artifactDigest: string;
}

export interface CopilotFailureDiagnosisOutputKeyMaterial {
  readonly keyId: string;
  readonly key: Uint8Array;
}

export interface CopilotFailureDiagnosisOutputKeyProvider {
  active(): Promise<CopilotFailureDiagnosisOutputKeyMaterial>;
  resolve(keyId: string): Promise<CopilotFailureDiagnosisOutputKeyMaterial | null>;
}

export class InvalidCopilotFailureDiagnosisOutputArtifactError extends TypeError {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ARTIFACT_INVALID';

  constructor(message: string) {
    super(`Copilot failure diagnosis output Artifact is invalid: ${message}`);
    this.name = 'InvalidCopilotFailureDiagnosisOutputArtifactError';
  }
}

export class CopilotFailureDiagnosisOutputArtifactConflictError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ARTIFACT_CONFLICT';

  constructor() {
    super('Copilot failure diagnosis output Artifact conflicts');
    this.name = 'CopilotFailureDiagnosisOutputArtifactConflictError';
  }
}

export class CopilotFailureDiagnosisOutputArtifactUnavailableError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ARTIFACT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Copilot failure diagnosis output Artifact is unavailable', options);
    this.name = 'CopilotFailureDiagnosisOutputArtifactUnavailableError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ARTIFACT_ID_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-output-artifact-id@v1\0',
);
const CONTENT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-output-content-digest@v1\0',
);
const EGRESS_DIGEST_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-output-egress-digest@v1\0',
);
const ARTIFACT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-output-artifact-digest@v1\0',
);
const AAD_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-output-artifact-aad@v1\0',
);

function invalid(message: string): never {
  throw new InvalidCopilotFailureDiagnosisOutputArtifactError(message);
}

function hash(domain: Buffer, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, maximum: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function bytes(value: unknown, expected?: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return invalid('encoded bytes are invalid');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.toString('base64url') !== value ||
    (expected !== undefined && decoded.length !== expected)
  ) {
    decoded.fill(0);
    return invalid('encoded bytes are invalid');
  }
  return decoded;
}

function key(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new CopilotFailureDiagnosisOutputArtifactUnavailableError();
  }
  return Buffer.from(value);
}

function unsigned(
  value: CopilotFailureDiagnosisOutputArtifact,
): Omit<CopilotFailureDiagnosisOutputArtifact, 'artifactDigest'> {
  return {
    schema: value.schema,
    artifactId: value.artifactId,
    requestId: value.requestId,
    planDigest: value.planDigest,
    toolCompletionDigest: value.toolCompletionDigest,
    projectId: value.projectId,
    runId: value.runId,
    stepRunId: value.stepRunId,
    invocationId: value.invocationId,
    provider: value.provider,
    model: value.model,
    egressEvidenceDigest: value.egressEvidenceDigest,
    contentDigest: value.contentDigest,
    outputBytes: value.outputBytes,
    keyId: value.keyId,
    algorithm: value.algorithm,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    authTag: value.authTag,
    plaintextBytes: value.plaintextBytes,
    sealedAtMs: value.sealedAtMs,
  };
}

function metadata(
  value: CopilotFailureDiagnosisOutputArtifact,
): Omit<
  CopilotFailureDiagnosisOutputArtifact,
  'artifactDigest' | 'nonce' | 'ciphertext' | 'authTag'
> {
  const {
    artifactDigest: _artifactDigest,
    nonce: _nonce,
    ciphertext: _ciphertext,
    authTag: _authTag,
    ...record
  } = value;
  return record;
}

function aad(value: ReturnType<typeof metadata>): Buffer {
  return Buffer.concat([AAD_DOMAIN, Buffer.from(JSON.stringify(value))]);
}

export function copilotFailureDiagnosisOutputArtifactIdentity(
  invocationIdValue: string,
): string {
  const invocationId = text(invocationIdValue, ID_PATTERN, 'invocation id');
  return `cdo:${hash(ARTIFACT_ID_DOMAIN, invocationId).slice(0, 32)}`;
}

export function copilotFailureDiagnosisEgressEvidenceDigest(
  value: Readonly<FailureDiagnosisModelEgressEvidence>,
): string {
  return hash(EGRESS_DIGEST_DOMAIN, value);
}

export function normalizeCopilotFailureDiagnosisOutputArtifact(
  value: CopilotFailureDiagnosisOutputArtifact,
): Readonly<CopilotFailureDiagnosisOutputArtifact> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('Artifact must be an object');
  }
  const expected = [
    'algorithm', 'artifactDigest', 'artifactId', 'authTag', 'ciphertext',
    'contentDigest', 'egressEvidenceDigest', 'invocationId', 'keyId', 'model',
    'nonce', 'outputBytes', 'plaintextBytes', 'planDigest', 'projectId',
    'provider', 'requestId', 'runId', 'schema', 'sealedAtMs', 'stepRunId',
    'toolCompletionDigest',
  ];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((item) => typeof item !== 'string' || !expected.includes(item))
  ) {
    return invalid('Artifact shape is invalid');
  }
  if (
    value.schema !== COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ARTIFACT_SCHEMA ||
    value.algorithm !== COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ALGORITHM
  ) {
    return invalid('Artifact protocol is unsupported');
  }
  const normalized = Object.freeze({
    schema: value.schema,
    artifactId: text(value.artifactId, ID_PATTERN, 'Artifact id'),
    requestId: text(value.requestId, ID_PATTERN, 'request id'),
    planDigest: text(value.planDigest, DIGEST_PATTERN, 'plan digest'),
    toolCompletionDigest: text(
      value.toolCompletionDigest,
      DIGEST_PATTERN,
      'Tool completion digest',
    ),
    projectId: text(value.projectId, ID_PATTERN, 'Project id'),
    runId: text(value.runId, RUN_ID_PATTERN, 'Run id'),
    stepRunId: text(value.stepRunId, ID_PATTERN, 'StepRun id'),
    invocationId: text(value.invocationId, ID_PATTERN, 'invocation id'),
    provider: text(value.provider, ID_PATTERN, 'provider'),
    model: text(value.model, MODEL_PATTERN, 'model'),
    egressEvidenceDigest: text(
      value.egressEvidenceDigest,
      DIGEST_PATTERN,
      'egress evidence digest',
    ),
    contentDigest: text(value.contentDigest, DIGEST_PATTERN, 'content digest'),
    outputBytes: integer(value.outputBytes, 1024 * 1024, 'output bytes'),
    keyId: text(value.keyId, KEY_PATTERN, 'key id'),
    algorithm: value.algorithm,
    nonce: bytes(value.nonce, 12).toString('base64url'),
    ciphertext: bytes(value.ciphertext).toString('base64url'),
    authTag: bytes(value.authTag, 16).toString('base64url'),
    plaintextBytes: integer(
      value.plaintextBytes,
      1024 * 1024 + 4096,
      'plaintext bytes',
    ),
    sealedAtMs: integer(value.sealedAtMs, Number.MAX_SAFE_INTEGER, 'seal time'),
    artifactDigest: text(
      value.artifactDigest,
      DIGEST_PATTERN,
      'Artifact digest',
    ),
  } satisfies CopilotFailureDiagnosisOutputArtifact);
  if (
    normalized.artifactId !==
      copilotFailureDiagnosisOutputArtifactIdentity(normalized.invocationId) ||
    Buffer.byteLength(JSON.stringify(normalized)) >
      MAX_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ARTIFACT_BYTES ||
    hash(ARTIFACT_DIGEST_DOMAIN, unsigned(normalized)) !==
      normalized.artifactDigest
  ) {
    return invalid('Artifact binding is invalid');
  }
  return normalized;
}

export function copilotFailureDiagnosisOutputReference(
  value: CopilotFailureDiagnosisOutputArtifact,
): Readonly<CopilotFailureDiagnosisOutputReference> {
  const artifact = normalizeCopilotFailureDiagnosisOutputArtifact(value);
  return Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_OUTPUT_REFERENCE_SCHEMA,
    artifactId: artifact.artifactId,
    requestId: artifact.requestId,
    planDigest: artifact.planDigest,
    toolCompletionDigest: artifact.toolCompletionDigest,
    projectId: artifact.projectId,
    runId: artifact.runId,
    stepRunId: artifact.stepRunId,
    invocationId: artifact.invocationId,
    provider: artifact.provider,
    model: artifact.model,
    egressEvidenceDigest: artifact.egressEvidenceDigest,
    contentDigest: artifact.contentDigest,
    outputBytes: artifact.outputBytes,
    keyId: artifact.keyId,
    algorithm: artifact.algorithm,
    sealedAtMs: artifact.sealedAtMs,
    artifactDigest: artifact.artifactDigest,
  });
}

export function createCopilotFailureDiagnosisOutputArtifact(
  input: Readonly<{
    requestId: string;
    planDigest: string;
    toolCompletionDigest: string;
    projectId: string;
    runId: string;
    stepRunId: string;
    invocationId: string;
    result: Readonly<GenerateResult>;
    egressEvidence: Readonly<FailureDiagnosisModelEgressEvidence>;
    keyId: string;
    key: Uint8Array;
    sealedAtMs: number;
  }>,
  nonceFactory: () => Uint8Array = () => randomBytes(12),
): Readonly<CopilotFailureDiagnosisOutputArtifact> {
  const result = normalizeGenerateResult(input.result);
  const plaintext = Buffer.from(JSON.stringify(result));
  const ownedKey = key(input.key);
  let nonce: Buffer | undefined;
  try {
    nonce = Buffer.from(nonceFactory());
    if (nonce.length !== 12) {
      throw new CopilotFailureDiagnosisOutputArtifactUnavailableError();
    }
    const base = {
      schema: COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ARTIFACT_SCHEMA,
      artifactId: copilotFailureDiagnosisOutputArtifactIdentity(
        input.invocationId,
      ),
      requestId: text(input.requestId, ID_PATTERN, 'request id'),
      planDigest: text(input.planDigest, DIGEST_PATTERN, 'plan digest'),
      toolCompletionDigest: text(
        input.toolCompletionDigest,
        DIGEST_PATTERN,
        'Tool completion digest',
      ),
      projectId: text(input.projectId, ID_PATTERN, 'Project id'),
      runId: text(input.runId, RUN_ID_PATTERN, 'Run id'),
      stepRunId: text(input.stepRunId, ID_PATTERN, 'StepRun id'),
      invocationId: text(input.invocationId, ID_PATTERN, 'invocation id'),
      provider: result.provider,
      model: result.model,
      egressEvidenceDigest: copilotFailureDiagnosisEgressEvidenceDigest(
        input.egressEvidence,
      ),
      contentDigest: hash(CONTENT_DIGEST_DOMAIN, result),
      outputBytes: Buffer.byteLength(result.text),
      keyId: text(input.keyId, KEY_PATTERN, 'key id'),
      algorithm: COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ALGORITHM,
      plaintextBytes: plaintext.length,
      sealedAtMs: integer(
        input.sealedAtMs,
        Number.MAX_SAFE_INTEGER,
        'seal time',
      ),
    } as const;
    const associated = aad(base as ReturnType<typeof metadata>);
    const cipher = createCipheriv(
      COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ALGORITHM,
      ownedKey,
      nonce,
      { authTagLength: 16 },
    );
    cipher.setAAD(associated);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    try {
      const unsignedArtifact = {
        ...base,
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      };
      const candidate = {
        ...unsignedArtifact,
        artifactDigest: '0'.repeat(64),
      };
      return normalizeCopilotFailureDiagnosisOutputArtifact({
        ...candidate,
        artifactDigest: hash(ARTIFACT_DIGEST_DOMAIN, unsigned(candidate)),
      });
    } finally {
      associated.fill(0);
      ciphertext.fill(0);
    }
  } catch (cause) {
    if (cause instanceof InvalidCopilotFailureDiagnosisOutputArtifactError) {
      throw cause;
    }
    throw new CopilotFailureDiagnosisOutputArtifactUnavailableError({ cause });
  } finally {
    plaintext.fill(0);
    ownedKey.fill(0);
    nonce?.fill(0);
  }
}

export function openCopilotFailureDiagnosisOutputArtifact(
  value: CopilotFailureDiagnosisOutputArtifact,
  keyValue: Uint8Array,
): Readonly<GenerateResult> {
  const artifact = normalizeCopilotFailureDiagnosisOutputArtifact(value);
  const ownedKey = key(keyValue);
  const nonce = bytes(artifact.nonce, 12);
  const ciphertext = bytes(artifact.ciphertext);
  const authTag = bytes(artifact.authTag, 16);
  const associated = aad(metadata(artifact));
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
      COPILOT_FAILURE_DIAGNOSIS_OUTPUT_ALGORITHM,
      ownedKey,
      nonce,
      { authTagLength: 16 },
    );
    decipher.setAAD(associated);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const result = normalizeGenerateResult(JSON.parse(plaintext.toString()));
    if (
      plaintext.length !== artifact.plaintextBytes ||
      result.provider !== artifact.provider ||
      result.model !== artifact.model ||
      Buffer.byteLength(result.text) !== artifact.outputBytes ||
      hash(CONTENT_DIGEST_DOMAIN, result) !== artifact.contentDigest
    ) {
      throw new CopilotFailureDiagnosisOutputArtifactUnavailableError();
    }
    return result;
  } catch (cause) {
    if (cause instanceof CopilotFailureDiagnosisOutputArtifactUnavailableError) {
      throw cause;
    }
    throw new CopilotFailureDiagnosisOutputArtifactUnavailableError({ cause });
  } finally {
    ownedKey.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    authTag.fill(0);
    associated.fill(0);
    plaintext?.fill(0);
  }
}

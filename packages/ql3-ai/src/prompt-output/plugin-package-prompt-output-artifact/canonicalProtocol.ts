import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { normalizeProjectPolicySubject } from '@qinglong/runtime-core/project-policy';

import {
  MAX_MODEL_OUTPUT_BYTES,
  type GenerateResult,
} from '../../model-gateway/model';
import {
  InvalidPluginPackagePromptOutputArtifactError,
  MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_JSON_BYTES,
  MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_RETENTION_MS,
  MIN_PLUGIN_PACKAGE_PROMPT_OUTPUT_RETENTION_MS,
  PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM,
  PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_SCHEMA,
  PluginPackagePromptOutputArtifactUnavailableError,
  type PluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifactRetentionPolicy,
} from './contracts';

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONTENT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-content-digest@v1\0',
  'utf8',
);
const RETENTION_POLICY_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-retention-policy-digest@v1\0',
  'utf8',
);
const ARTIFACT_ID_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-artifact-id@v1\0',
  'utf8',
);
const ARTIFACT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-artifact-digest@v1\0',
  'utf8',
);
const ARTIFACT_AAD_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-artifact-aad@v1\0',
  'utf8',
);

export function invalid(message: string): never {
  throw new InvalidPluginPackagePromptOutputArtifactError(message);
}

export function hash(domain: Buffer, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

export function record(
  value: unknown,
  label: string,
): Record<string, unknown> {
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

export function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(expected);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    expected.some((key) => !keys.includes(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

export function patterned(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function digest(value: unknown, label: string): string {
  return patterned(value, DIGEST_PATTERN, label);
}

export function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

export function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

export function base64url(
  value: unknown,
  label: string,
  expectedBytes?: number,
): Buffer {
  if (
    typeof value !== 'string' ||
    (value.length > 0 && !BASE64URL_PATTERN.test(value))
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

export function ownedKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new PluginPackagePromptOutputArtifactUnavailableError();
  }
  return Buffer.from(value);
}

export function safeAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) return invalid(`${label} is invalid`);
  return value;
}

export function normalizePluginPackagePromptOutputArtifactRetentionPolicy(
  value: PluginPackagePromptOutputArtifactRetentionPolicy,
): Readonly<PluginPackagePromptOutputArtifactRetentionPolicy> {
  const candidate = record(value, 'Prompt output retention policy');
  exactKeys(
    candidate,
    ['retentionMs', 'revision'],
    'Prompt output retention policy',
  );
  return Object.freeze({
    revision: patterned(
      value.revision,
      REVISION_PATTERN,
      'retention policy revision',
    ),
    retentionMs: boundedInteger(
      value.retentionMs,
      MIN_PLUGIN_PACKAGE_PROMPT_OUTPUT_RETENTION_MS,
      MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_RETENTION_MS,
      'retention duration',
    ),
  });
}

export function pluginPackagePromptOutputArtifactRetentionPolicyDigest(
  value: PluginPackagePromptOutputArtifactRetentionPolicy,
): string {
  return hash(
    RETENTION_POLICY_DIGEST_DOMAIN,
    normalizePluginPackagePromptOutputArtifactRetentionPolicy(value),
  );
}

export function pluginPackagePromptOutputArtifactIdentity(
  invocationIdValue: string,
): string {
  const invocationId = patterned(
    invocationIdValue,
    IDENTITY_PATTERN,
    'invocation id',
  );
  return `pao:${hash(ARTIFACT_ID_DOMAIN, invocationId).slice(0, 32)}`;
}

export function contentDigest(result: Readonly<GenerateResult>): string {
  return hash(CONTENT_DIGEST_DOMAIN, result);
}

export function artifactAad(
  value: Omit<
    PluginPackagePromptOutputArtifact,
    'artifactDigest' | 'authTag' | 'ciphertext' | 'nonce'
  >,
): Buffer {
  return Buffer.concat([
    ARTIFACT_AAD_DOMAIN,
    Buffer.from(JSON.stringify(value), 'utf8'),
  ]);
}

export function artifactUnsigned(
  value: PluginPackagePromptOutputArtifact,
): Omit<PluginPackagePromptOutputArtifact, 'artifactDigest'> {
  return {
    schema: value.schema,
    artifactId: value.artifactId,
    projectId: value.projectId,
    runId: value.runId,
    stepRunId: value.stepRunId,
    invocationId: value.invocationId,
    requestedBy: value.requestedBy,
    provider: value.provider,
    model: value.model,
    contentDigest: value.contentDigest,
    outputBytes: value.outputBytes,
    retentionPolicy: value.retentionPolicy,
    retentionPolicyDigest: value.retentionPolicyDigest,
    retentionEligibleAtMs: value.retentionEligibleAtMs,
    keyId: value.keyId,
    algorithm: value.algorithm,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    authTag: value.authTag,
    plaintextBytes: value.plaintextBytes,
    sealedAtMs: value.sealedAtMs,
  };
}

export function normalizePluginPackagePromptOutputArtifact(
  value: PluginPackagePromptOutputArtifact,
): Readonly<PluginPackagePromptOutputArtifact> {
  const candidate = record(value, 'Prompt output Artifact');
  exactKeys(
    candidate,
    [
      'algorithm',
      'artifactDigest',
      'artifactId',
      'authTag',
      'ciphertext',
      'contentDigest',
      'invocationId',
      'keyId',
      'model',
      'nonce',
      'outputBytes',
      'plaintextBytes',
      'projectId',
      'provider',
      'requestedBy',
      'retentionEligibleAtMs',
      'retentionPolicy',
      'retentionPolicyDigest',
      'runId',
      'schema',
      'sealedAtMs',
      'stepRunId',
    ],
    'Prompt output Artifact',
  );
  if (
    value.schema !== PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_SCHEMA ||
    value.algorithm !== PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM
  ) {
    return invalid('Artifact schema or algorithm is invalid');
  }
  const nonce = base64url(value.nonce, 'Artifact nonce', 12);
  const ciphertext = base64url(value.ciphertext, 'Artifact ciphertext');
  const authTag = base64url(value.authTag, 'Artifact auth tag', 16);
  const outputBytes = boundedInteger(
    value.outputBytes,
    0,
    MAX_MODEL_OUTPUT_BYTES,
    'output bytes',
  );
  const plaintextBytes = boundedInteger(
    value.plaintextBytes,
    1,
    MAX_MODEL_OUTPUT_BYTES + 4096,
    'plaintext bytes',
  );
  try {
    if (ciphertext.length !== plaintextBytes) {
      return invalid('ciphertext length does not match');
    }
  } finally {
    nonce.fill(0);
    ciphertext.fill(0);
    authTag.fill(0);
  }
  const retentionPolicy =
    normalizePluginPackagePromptOutputArtifactRetentionPolicy(
      value.retentionPolicy,
    );
  const sealedAtMs = timestamp(value.sealedAtMs, 'seal time');
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_SCHEMA,
    artifactId: patterned(value.artifactId, IDENTITY_PATTERN, 'Artifact id'),
    projectId: patterned(value.projectId, IDENTITY_PATTERN, 'Project id'),
    runId: patterned(value.runId, RUN_ID_PATTERN, 'Run id'),
    stepRunId: patterned(value.stepRunId, IDENTITY_PATTERN, 'StepRun id'),
    invocationId: patterned(
      value.invocationId,
      IDENTITY_PATTERN,
      'invocation id',
    ),
    requestedBy: normalizeProjectPolicySubject(value.requestedBy),
    provider: patterned(value.provider, MODEL_ID_PATTERN, 'provider'),
    model: patterned(value.model, MODEL_ID_PATTERN, 'model'),
    contentDigest: digest(value.contentDigest, 'content digest'),
    outputBytes,
    retentionPolicy,
    retentionPolicyDigest: digest(
      value.retentionPolicyDigest,
      'retention policy digest',
    ),
    retentionEligibleAtMs: timestamp(
      value.retentionEligibleAtMs,
      'retention eligibility',
    ),
    keyId: patterned(value.keyId, KEY_ID_PATTERN, 'key id'),
    algorithm: PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    authTag: value.authTag,
    plaintextBytes,
    sealedAtMs,
    artifactDigest: digest(value.artifactDigest, 'Artifact digest'),
  } satisfies PluginPackagePromptOutputArtifact);
  if (
    normalized.artifactId !==
      pluginPackagePromptOutputArtifactIdentity(normalized.invocationId) ||
    normalized.retentionPolicyDigest !==
      pluginPackagePromptOutputArtifactRetentionPolicyDigest(retentionPolicy) ||
    normalized.retentionEligibleAtMs !==
      safeAdd(
        sealedAtMs,
        retentionPolicy.retentionMs,
        'retention eligibility',
      ) ||
    hash(ARTIFACT_DIGEST_DOMAIN, artifactUnsigned(normalized)) !==
      normalized.artifactDigest ||
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
      MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_JSON_BYTES
  ) {
    return invalid('Artifact identity, retention, digest, or size is invalid');
  }
  return normalized;
}

export const pluginPackagePromptOutputArtifactCanonicalDomains = Object.freeze({
  artifactDigest: ARTIFACT_DIGEST_DOMAIN,
  identityPattern: IDENTITY_PATTERN,
  keyIdPattern: KEY_ID_PATTERN,
  runIdPattern: RUN_ID_PATTERN,
});

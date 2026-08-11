import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

import { normalizeProjectPolicySubject } from '@qinglong/runtime-core/project-policy';
import type { SecuritySubject } from '@qinglong/runtime-core/security';

import {
  MAX_MODEL_OUTPUT_BYTES,
  type GenerateResult,
} from '../../model-gateway/model';
import { normalizeGenerateResult } from '../../model-gateway/validation';
import {
  InvalidPluginPackagePromptOutputArtifactError,
  PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM,
  PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_SCHEMA,
  PluginPackagePromptOutputArtifactUnavailableError,
  type PluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifactRetentionPolicy,
} from './contracts';
import {
  artifactAad,
  artifactUnsigned,
  base64url,
  contentDigest,
  hash,
  invalid,
  normalizePluginPackagePromptOutputArtifact,
  normalizePluginPackagePromptOutputArtifactRetentionPolicy,
  ownedKey,
  patterned,
  pluginPackagePromptOutputArtifactCanonicalDomains,
  pluginPackagePromptOutputArtifactIdentity,
  pluginPackagePromptOutputArtifactRetentionPolicyDigest,
  safeAdd,
  timestamp,
} from './canonicalProtocol';

export function createPluginPackagePromptOutputArtifact(
  input: Readonly<{
    projectId: string;
    runId: string;
    stepRunId: string;
    invocationId: string;
    requestedBy: Readonly<SecuritySubject>;
    result: Readonly<GenerateResult>;
    retentionPolicy: Readonly<PluginPackagePromptOutputArtifactRetentionPolicy>;
    keyId: string;
    key: Uint8Array;
    sealedAtMs: number;
  }>,
  nonceFactory: () => Uint8Array = () => randomBytes(12),
): Readonly<PluginPackagePromptOutputArtifact> {
  const result = normalizeGenerateResult(input.result);
  const plaintext = Buffer.from(JSON.stringify(result), 'utf8');
  const key = ownedKey(input.key);
  let nonce: Buffer | undefined;
  try {
    if (plaintext.length > MAX_MODEL_OUTPUT_BYTES + 4096) {
      return invalid('result envelope is too large');
    }
    nonce = Buffer.from(nonceFactory());
    if (nonce.length !== 12) {
      throw new PluginPackagePromptOutputArtifactUnavailableError();
    }
    const retentionPolicy =
      normalizePluginPackagePromptOutputArtifactRetentionPolicy(
        input.retentionPolicy,
      );
    const sealedAtMs = timestamp(input.sealedAtMs, 'seal time');
    const invocationId = patterned(
      input.invocationId,
      pluginPackagePromptOutputArtifactCanonicalDomains.identityPattern,
      'invocation id',
    );
    const metadata = Object.freeze({
      schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_SCHEMA,
      artifactId: pluginPackagePromptOutputArtifactIdentity(invocationId),
      projectId: patterned(
        input.projectId,
        pluginPackagePromptOutputArtifactCanonicalDomains.identityPattern,
        'Project id',
      ),
      runId: patterned(
        input.runId,
        pluginPackagePromptOutputArtifactCanonicalDomains.runIdPattern,
        'Run id',
      ),
      stepRunId: patterned(
        input.stepRunId,
        pluginPackagePromptOutputArtifactCanonicalDomains.identityPattern,
        'StepRun id',
      ),
      invocationId,
      requestedBy: normalizeProjectPolicySubject(input.requestedBy),
      provider: result.provider,
      model: result.model,
      contentDigest: contentDigest(result),
      outputBytes: Buffer.byteLength(result.text, 'utf8'),
      retentionPolicy,
      retentionPolicyDigest:
        pluginPackagePromptOutputArtifactRetentionPolicyDigest(retentionPolicy),
      retentionEligibleAtMs: safeAdd(
        sealedAtMs,
        retentionPolicy.retentionMs,
        'retention eligibility',
      ),
      keyId: patterned(
        input.keyId,
        pluginPackagePromptOutputArtifactCanonicalDomains.keyIdPattern,
        'key id',
      ),
      algorithm: PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM,
      plaintextBytes: plaintext.length,
      sealedAtMs,
    });
    const cipher = createCipheriv(
      PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM,
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
      const candidate = Object.freeze({
        schema: metadata.schema,
        artifactId: metadata.artifactId,
        projectId: metadata.projectId,
        runId: metadata.runId,
        stepRunId: metadata.stepRunId,
        invocationId: metadata.invocationId,
        requestedBy: metadata.requestedBy,
        provider: metadata.provider,
        model: metadata.model,
        contentDigest: metadata.contentDigest,
        outputBytes: metadata.outputBytes,
        retentionPolicy: metadata.retentionPolicy,
        retentionPolicyDigest: metadata.retentionPolicyDigest,
        retentionEligibleAtMs: metadata.retentionEligibleAtMs,
        keyId: metadata.keyId,
        algorithm: metadata.algorithm,
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
        plaintextBytes: metadata.plaintextBytes,
        sealedAtMs: metadata.sealedAtMs,
      });
      const unsigned = artifactUnsigned({
        ...candidate,
        artifactDigest: '0'.repeat(64),
      });
      return normalizePluginPackagePromptOutputArtifact({
        ...candidate,
        artifactDigest: hash(
          pluginPackagePromptOutputArtifactCanonicalDomains.artifactDigest,
          unsigned,
        ),
      });
    } finally {
      ciphertext.fill(0);
    }
  } catch (cause) {
    if (
      cause instanceof InvalidPluginPackagePromptOutputArtifactError ||
      cause instanceof PluginPackagePromptOutputArtifactUnavailableError
    ) {
      throw cause;
    }
    throw new PluginPackagePromptOutputArtifactUnavailableError({ cause });
  } finally {
    key.fill(0);
    plaintext.fill(0);
    nonce?.fill(0);
  }
}

export function openPluginPackagePromptOutputArtifact(
  value: PluginPackagePromptOutputArtifact,
  keyValue: Uint8Array,
): Readonly<GenerateResult> {
  const artifact = normalizePluginPackagePromptOutputArtifact(value);
  const key = ownedKey(keyValue);
  const nonce = base64url(artifact.nonce, 'Artifact nonce', 12);
  const ciphertext = base64url(artifact.ciphertext, 'Artifact ciphertext');
  const authTag = base64url(artifact.authTag, 'Artifact auth tag', 16);
  const metadata = {
    schema: artifact.schema,
    artifactId: artifact.artifactId,
    projectId: artifact.projectId,
    runId: artifact.runId,
    stepRunId: artifact.stepRunId,
    invocationId: artifact.invocationId,
    requestedBy: artifact.requestedBy,
    provider: artifact.provider,
    model: artifact.model,
    contentDigest: artifact.contentDigest,
    outputBytes: artifact.outputBytes,
    retentionPolicy: artifact.retentionPolicy,
    retentionPolicyDigest: artifact.retentionPolicyDigest,
    retentionEligibleAtMs: artifact.retentionEligibleAtMs,
    keyId: artifact.keyId,
    algorithm: artifact.algorithm,
    plaintextBytes: artifact.plaintextBytes,
    sealedAtMs: artifact.sealedAtMs,
  };
  const aad = artifactAad(metadata);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
      PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM,
      key,
      nonce,
      { authTagLength: 16 },
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length !== artifact.plaintextBytes) {
      throw new PluginPackagePromptOutputArtifactUnavailableError();
    }
    const result = normalizeGenerateResult(
      JSON.parse(plaintext.toString('utf8')) as GenerateResult,
    );
    if (
      result.provider !== artifact.provider ||
      result.model !== artifact.model ||
      Buffer.byteLength(result.text, 'utf8') !== artifact.outputBytes ||
      contentDigest(result) !== artifact.contentDigest
    ) {
      throw new PluginPackagePromptOutputArtifactUnavailableError();
    }
    return result;
  } catch (cause) {
    if (cause instanceof PluginPackagePromptOutputArtifactUnavailableError) {
      throw cause;
    }
    throw new PluginPackagePromptOutputArtifactUnavailableError({ cause });
  } finally {
    key.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    authTag.fill(0);
    aad.fill(0);
    plaintext?.fill(0);
  }
}

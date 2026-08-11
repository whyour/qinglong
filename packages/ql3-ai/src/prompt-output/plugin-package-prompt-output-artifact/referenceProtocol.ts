import { MAX_MODEL_OUTPUT_BYTES } from '../../model-gateway/model';
import {
  PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM,
  PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_REFERENCE_SCHEMA,
  type PluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifactReference,
} from './contracts';
import {
  boundedInteger,
  digest,
  exactKeys,
  invalid,
  normalizePluginPackagePromptOutputArtifact,
  patterned,
  pluginPackagePromptOutputArtifactCanonicalDomains,
  pluginPackagePromptOutputArtifactIdentity,
  record,
  timestamp,
} from './canonicalProtocol';

export function pluginPackagePromptOutputArtifactReference(
  value: PluginPackagePromptOutputArtifact,
): Readonly<PluginPackagePromptOutputArtifactReference> {
  const artifact = normalizePluginPackagePromptOutputArtifact(value);
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_REFERENCE_SCHEMA,
    artifactId: artifact.artifactId,
    projectId: artifact.projectId,
    runId: artifact.runId,
    stepRunId: artifact.stepRunId,
    invocationId: artifact.invocationId,
    contentDigest: artifact.contentDigest,
    outputBytes: artifact.outputBytes,
    retentionPolicyDigest: artifact.retentionPolicyDigest,
    retentionEligibleAtMs: artifact.retentionEligibleAtMs,
    keyId: artifact.keyId,
    algorithm: artifact.algorithm,
    artifactDigest: artifact.artifactDigest,
  });
}

export function normalizePluginPackagePromptOutputArtifactReference(
  value: PluginPackagePromptOutputArtifactReference,
): Readonly<PluginPackagePromptOutputArtifactReference> {
  const candidate = record(value, 'Prompt output Artifact reference');
  exactKeys(
    candidate,
    [
      'algorithm',
      'artifactDigest',
      'artifactId',
      'contentDigest',
      'invocationId',
      'keyId',
      'outputBytes',
      'projectId',
      'retentionEligibleAtMs',
      'retentionPolicyDigest',
      'runId',
      'schema',
      'stepRunId',
    ],
    'Prompt output Artifact reference',
  );
  if (
    value.schema !== PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_REFERENCE_SCHEMA ||
    value.algorithm !== PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM
  ) {
    return invalid('Artifact reference schema or algorithm is invalid');
  }
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_REFERENCE_SCHEMA,
    artifactId: patterned(
      value.artifactId,
      pluginPackagePromptOutputArtifactCanonicalDomains.identityPattern,
      'Artifact id',
    ),
    projectId: patterned(
      value.projectId,
      pluginPackagePromptOutputArtifactCanonicalDomains.identityPattern,
      'Project id',
    ),
    runId: patterned(
      value.runId,
      pluginPackagePromptOutputArtifactCanonicalDomains.runIdPattern,
      'Run id',
    ),
    stepRunId: patterned(
      value.stepRunId,
      pluginPackagePromptOutputArtifactCanonicalDomains.identityPattern,
      'StepRun id',
    ),
    invocationId: patterned(
      value.invocationId,
      pluginPackagePromptOutputArtifactCanonicalDomains.identityPattern,
      'invocation id',
    ),
    contentDigest: digest(value.contentDigest, 'content digest'),
    outputBytes: boundedInteger(
      value.outputBytes,
      0,
      MAX_MODEL_OUTPUT_BYTES,
      'output bytes',
    ),
    retentionPolicyDigest: digest(
      value.retentionPolicyDigest,
      'retention policy digest',
    ),
    retentionEligibleAtMs: timestamp(
      value.retentionEligibleAtMs,
      'retention eligibility',
    ),
    keyId: patterned(
      value.keyId,
      pluginPackagePromptOutputArtifactCanonicalDomains.keyIdPattern,
      'key id',
    ),
    algorithm: PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM,
    artifactDigest: digest(value.artifactDigest, 'Artifact digest'),
  });
  if (
    normalized.artifactId !==
    pluginPackagePromptOutputArtifactIdentity(normalized.invocationId)
  ) {
    return invalid('Artifact reference identity is invalid');
  }
  return normalized;
}

import type {
  SecurityPrincipal,
  SecuritySubject,
} from '@qinglong/runtime-core/security';

export const PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_SCHEMA =
  'qinglong/plugin-package-prompt-output-artifact@v1' as const;
export const PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_REFERENCE_SCHEMA =
  'qinglong/plugin-package-prompt-output-artifact-reference@v1' as const;
export const PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM =
  'aes-256-gcm' as const;
export const MIN_PLUGIN_PACKAGE_PROMPT_OUTPUT_RETENTION_MS = 60 * 60_000;
export const MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_RETENTION_MS =
  365 * 24 * 60 * 60_000;
export const MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_JSON_BYTES = 1536 * 1024;

export interface PluginPackagePromptOutputArtifactRetentionPolicy {
  readonly revision: string;
  readonly retentionMs: number;
}

export interface PluginPackagePromptOutputArtifact {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_SCHEMA;
  readonly artifactId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly invocationId: string;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly provider: string;
  readonly model: string;
  readonly contentDigest: string;
  readonly outputBytes: number;
  readonly retentionPolicy: Readonly<PluginPackagePromptOutputArtifactRetentionPolicy>;
  readonly retentionPolicyDigest: string;
  readonly retentionEligibleAtMs: number;
  readonly keyId: string;
  readonly algorithm: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
  readonly plaintextBytes: number;
  readonly sealedAtMs: number;
  readonly artifactDigest: string;
}

export interface PluginPackagePromptOutputArtifactReference {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_REFERENCE_SCHEMA;
  readonly artifactId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly invocationId: string;
  readonly contentDigest: string;
  readonly outputBytes: number;
  readonly retentionPolicyDigest: string;
  readonly retentionEligibleAtMs: number;
  readonly keyId: string;
  readonly algorithm: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_ALGORITHM;
  readonly artifactDigest: string;
}

export interface PluginPackagePromptOutputArtifactKeyMaterial {
  readonly keyId: string;
  /** Exactly 32 bytes. The consumer owns this copy and must wipe it. */
  readonly key: Uint8Array;
}

export interface PluginPackagePromptOutputArtifactKeyProvider {
  active(): Promise<PluginPackagePromptOutputArtifactKeyMaterial>;
  resolve(
    keyId: string,
  ): Promise<PluginPackagePromptOutputArtifactKeyMaterial | null>;
}

export interface PluginPackagePromptOutputArtifactRepository {
  put(
    artifact: PluginPackagePromptOutputArtifact,
  ): Promise<Readonly<{ status: 'inserted' | 'existing' }>>;
  find(
    artifactId: string,
  ): Promise<Readonly<PluginPackagePromptOutputArtifact> | null>;
}

export type PluginPackagePromptOutputArtifactReadDecision =
  | Readonly<{ effect: 'allow' }>
  | Readonly<{ effect: 'deny' | 'require_approval'; reasonCode: string }>;

export interface PluginPackagePromptOutputArtifactReadAuthorizer {
  authorize(
    request: Readonly<{
      principal: Readonly<SecurityPrincipal>;
      projectId: string;
      runId: string;
      artifactId: string;
      artifactDigest: string;
    }>,
  ): Promise<PluginPackagePromptOutputArtifactReadDecision>;
}

export class InvalidPluginPackagePromptOutputArtifactError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_INVALID';

  constructor(message: string) {
    super(`Prompt output Artifact is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePromptOutputArtifactError';
  }
}

export class PluginPackagePromptOutputArtifactUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Prompt output Artifact is unavailable', options);
    this.name = 'PluginPackagePromptOutputArtifactUnavailableError';
  }
}

export class PluginPackagePromptOutputArtifactConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_CONFLICT';

  constructor() {
    super('Prompt output Artifact identity is bound to different content');
    this.name = 'PluginPackagePromptOutputArtifactConflictError';
  }
}

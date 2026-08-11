import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';

import type { GenerateResult } from '../model-gateway/model';
import {
  PluginPackagePromptOutputArtifactUnavailableError,
  normalizePluginPackagePromptOutputArtifactReference,
  openPluginPackagePromptOutputArtifact,
  pluginPackagePromptOutputArtifactReference,
  type PluginPackagePromptOutputArtifactKeyProvider,
  type PluginPackagePromptOutputArtifactReadAuthorizer,
  type PluginPackagePromptOutputArtifactReference,
  type PluginPackagePromptOutputArtifactRepository,
} from './pluginPackagePromptOutputArtifact';

export const PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_RESULT_SCHEMA =
  'qinglong/plugin-package-prompt-output-read-result@v1' as const;

export interface PluginPackagePromptOutputReadCommand {
  readonly principal: Readonly<SecurityPrincipal>;
  readonly projectId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
}

export type PluginPackagePromptOutputArtifactRetentionState =
  | Readonly<{ state: 'retained' }>
  | Readonly<{
      state: 'tombstoned';
      tombstonedAtMs: number;
      tombstoneDigest: string;
    }>;

export interface PluginPackagePromptOutputArtifactRetentionStateReader {
  inspect(
    request: Readonly<{
      reference: Readonly<PluginPackagePromptOutputArtifactReference>;
      observedAtMs: number;
    }>,
  ): Promise<PluginPackagePromptOutputArtifactRetentionState>;
}

export type PluginPackagePromptOutputReadResult = Readonly<
  | {
      schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_RESULT_SCHEMA;
      status: 'not_found';
    }
  | {
      schema: typeof PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_RESULT_SCHEMA;
      status: 'available';
      reference: Readonly<PluginPackagePromptOutputArtifactReference>;
      result: Readonly<GenerateResult>;
    }
>;

export class InvalidPluginPackagePromptOutputReadError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_INVALID';

  constructor() {
    super('Prompt output Artifact read request is invalid');
    this.name = 'InvalidPluginPackagePromptOutputReadError';
  }
}

export class PluginPackagePromptOutputReadUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Prompt output Artifact read is unavailable', options);
    this.name = 'PluginPackagePromptOutputReadUnavailableError';
  }
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputReadUnavailableError {
  return new PluginPackagePromptOutputReadUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function invalidCommand(
  value: PluginPackagePromptOutputReadCommand,
  nowMs: number,
): Readonly<PluginPackagePromptOutputReadCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['artifactDigest', 'artifactId', 'principal', 'projectId', 'runId']
        .sort()
        .join('\0') ||
    typeof value.projectId !== 'string' ||
    !IDENTITY_PATTERN.test(value.projectId) ||
    typeof value.runId !== 'string' ||
    !RUN_ID_PATTERN.test(value.runId) ||
    typeof value.artifactId !== 'string' ||
    !IDENTITY_PATTERN.test(value.artifactId) ||
    typeof value.artifactDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.artifactDigest)
  ) {
    throw new InvalidPluginPackagePromptOutputReadError();
  }
  try {
    return Object.freeze({
      principal: normalizeSecurityPrincipal(value.principal, nowMs),
      projectId: value.projectId,
      runId: value.runId,
      artifactId: value.artifactId,
      artifactDigest: value.artifactDigest,
    });
  } catch (cause) {
    throw new InvalidPluginPackagePromptOutputReadError();
  }
}

function allowed(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw unavailable();
  }
  const decision = value as Record<string, unknown>;
  if (decision.effect === 'allow') {
    if (Object.keys(decision).length !== 1) throw unavailable();
    return true;
  }
  if (
    (decision.effect === 'deny' || decision.effect === 'require_approval') &&
    Object.keys(decision).sort().join('\0') === 'effect\0reasonCode' &&
    typeof decision.reasonCode === 'string' &&
    REASON_PATTERN.test(decision.reasonCode)
  ) {
    return false;
  }
  throw unavailable();
}

function retained(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw unavailable();
  }
  const state = value as Record<string, unknown>;
  if (state.state === 'retained') {
    if (Object.keys(state).length !== 1) throw unavailable();
    return true;
  }
  if (
    state.state === 'tombstoned' &&
    Object.keys(state).sort().join('\0') ===
      'state\0tombstoneDigest\0tombstonedAtMs' &&
    Number.isSafeInteger(state.tombstonedAtMs) &&
    (state.tombstonedAtMs as number) >= 0 &&
    typeof state.tombstoneDigest === 'string' &&
    DIGEST_PATTERN.test(state.tombstoneDigest)
  ) {
    return false;
  }
  throw unavailable();
}

function notFound(): PluginPackagePromptOutputReadResult {
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_RESULT_SCHEMA,
    status: 'not_found' as const,
  });
}

/**
 * Product read boundary. Storage metadata is inspected before policy; policy
 * and retention are resolved before key material; key material is always
 * wiped before the caller can observe a result or error.
 */
export class PluginPackagePromptOutputReadService {
  readonly #artifacts: PluginPackagePromptOutputArtifactRepository;
  readonly #authorizer: PluginPackagePromptOutputArtifactReadAuthorizer;
  readonly #retention: PluginPackagePromptOutputArtifactRetentionStateReader;
  readonly #keys: PluginPackagePromptOutputArtifactKeyProvider;
  readonly #now: () => number;

  constructor(
    options: Readonly<{
      artifacts: PluginPackagePromptOutputArtifactRepository;
      authorizer: PluginPackagePromptOutputArtifactReadAuthorizer;
      retention: PluginPackagePromptOutputArtifactRetentionStateReader;
      keys: PluginPackagePromptOutputArtifactKeyProvider;
      now?: () => number;
    }>,
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !options.artifacts ||
      typeof options.artifacts.find !== 'function' ||
      !options.authorizer ||
      typeof options.authorizer.authorize !== 'function' ||
      !options.retention ||
      typeof options.retention.inspect !== 'function' ||
      !options.keys ||
      typeof options.keys.active !== 'function' ||
      typeof options.keys.resolve !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')
    ) {
      throw unavailable();
    }
    this.#artifacts = options.artifacts;
    this.#authorizer = options.authorizer;
    this.#retention = options.retention;
    this.#keys = options.keys;
    this.#now = options.now ?? Date.now;
  }

  async read(
    value: PluginPackagePromptOutputReadCommand,
  ): Promise<PluginPackagePromptOutputReadResult> {
    const observedAtMs = this.#now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw unavailable();
    }
    const command = invalidCommand(value, observedAtMs);
    let artifact;
    try {
      artifact = await this.#artifacts.find(command.artifactId);
    } catch (cause) {
      throw unavailable(cause);
    }
    if (!artifact) return notFound();
    const reference = normalizePluginPackagePromptOutputArtifactReference(
      pluginPackagePromptOutputArtifactReference(artifact),
    );
    if (
      reference.projectId !== command.projectId ||
      reference.runId !== command.runId ||
      reference.artifactId !== command.artifactId ||
      reference.artifactDigest !== command.artifactDigest
    ) {
      return notFound();
    }
    let decision;
    try {
      decision = await this.#authorizer.authorize({
        principal: command.principal,
        projectId: reference.projectId,
        runId: reference.runId,
        artifactId: reference.artifactId,
        artifactDigest: reference.artifactDigest,
      });
    } catch (cause) {
      throw unavailable(cause);
    }
    if (!allowed(decision)) return notFound();
    let retention;
    try {
      retention = await this.#retention.inspect({
        reference,
        observedAtMs,
      });
    } catch (cause) {
      throw unavailable(cause);
    }
    if (!retained(retention)) return notFound();
    let material;
    try {
      material = await this.#keys.resolve(reference.keyId);
    } catch (cause) {
      throw unavailable(cause);
    }
    if (
      !material ||
      typeof material !== 'object' ||
      Array.isArray(material) ||
      Object.keys(material).sort().join('\0') !== 'key\0keyId' ||
      material.keyId !== reference.keyId ||
      !(material.key instanceof Uint8Array) ||
      material.key.byteLength !== 32
    ) {
      try {
        material?.key?.fill(0);
      } catch {
        // Invalid material is already unavailable; never expose it.
      }
      throw unavailable();
    }
    try {
      const result = openPluginPackagePromptOutputArtifact(
        artifact,
        material.key,
      );
      return Object.freeze({
        schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_RESULT_SCHEMA,
        status: 'available' as const,
        reference,
        result,
      });
    } catch (cause) {
      if (cause instanceof PluginPackagePromptOutputArtifactUnavailableError) {
        throw unavailable(cause);
      }
      throw unavailable(cause);
    } finally {
      try {
        material.key.fill(0);
      } catch (cause) {
        throw unavailable(cause);
      }
    }
  }
}

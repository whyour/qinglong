import type { SecurityPrincipal } from '@qinglong/runtime-core/security';

import type { GenerateResult } from '../model-gateway/model';
import { normalizeGenerateResult } from '../model-gateway/validation';
import {
  normalizePluginPackagePromptOutputArtifactReference,
  type PluginPackagePromptOutputArtifactReference,
} from './pluginPackagePromptOutputArtifact';
import {
  PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_RESULT_SCHEMA,
  type PluginPackagePromptOutputReadResult,
} from './pluginPackagePromptOutputRead';

export const PLUGIN_PACKAGE_PROMPT_EXECUTION_OUTPUT_READ_RESULT_SCHEMA =
  'qinglong/plugin-package-prompt-execution-output-read-result@v1' as const;

export interface PluginPackagePromptExecutionOutputTarget {
  readonly projectId: string;
  readonly packageName: string;
  readonly promptId: string;
  readonly executionRequestId: string;
}

export interface PluginPackagePromptExecutionOutputReference {
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
}

export interface PluginPackagePromptExecutionOutputReferenceRepository {
  find(
    target: Readonly<PluginPackagePromptExecutionOutputTarget>,
  ): Promise<Readonly<PluginPackagePromptExecutionOutputReference> | null>;
}

export interface PluginPackagePromptExecutionOutputReadCommand
  extends PluginPackagePromptExecutionOutputTarget {
  readonly principal: Readonly<SecurityPrincipal>;
}

export type PluginPackagePromptExecutionOutputReadResult = Readonly<
  | {
      schema: typeof PLUGIN_PACKAGE_PROMPT_EXECUTION_OUTPUT_READ_RESULT_SCHEMA;
      status: 'not_found';
      projectId: string;
      packageName: string;
      promptId: string;
      executionRequestId: string;
    }
  | {
      schema: typeof PLUGIN_PACKAGE_PROMPT_EXECUTION_OUTPUT_READ_RESULT_SCHEMA;
      status: 'available';
      projectId: string;
      packageName: string;
      promptId: string;
      executionRequestId: string;
      reference: Readonly<PluginPackagePromptOutputArtifactReference>;
      result: Readonly<GenerateResult>;
    }
>;

export interface PluginPackagePromptOutputReader {
  read(
    command: Readonly<{
      principal: Readonly<SecurityPrincipal>;
      projectId: string;
      runId: string;
      artifactId: string;
      artifactDigest: string;
    }>,
  ): Promise<Readonly<PluginPackagePromptOutputReadResult>>;
}

export class InvalidPluginPackagePromptExecutionOutputReadError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_EXECUTION_OUTPUT_READ_INVALID';

  constructor() {
    super('Plugin Package Prompt execution output read is invalid');
    this.name = 'InvalidPluginPackagePromptExecutionOutputReadError';
  }
}

export class PluginPackagePromptExecutionOutputReadUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_EXECUTION_OUTPUT_READ_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'Plugin Package Prompt execution output read is unavailable',
      options,
    );
    this.name = 'PluginPackagePromptExecutionOutputReadUnavailableError';
  }
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST = /^[0-9a-f]{64}$/;

function invalid(): never {
  throw new InvalidPluginPackagePromptExecutionOutputReadError();
}

function unavailable(
  cause?: unknown,
): PluginPackagePromptExecutionOutputReadUnavailableError {
  return new PluginPackagePromptExecutionOutputReadUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const normalized = [...expected].sort();
  return (
    actual.length === normalized.length &&
    actual.every((key, index) => key === normalized[index])
  );
}

function identity(value: unknown, pattern: RegExp = IDENTITY): string {
  if (typeof value !== 'string' || !pattern.test(value)) return invalid();
  return value;
}

export function normalizePluginPackagePromptExecutionOutputTarget(
  value: PluginPackagePromptExecutionOutputTarget,
): Readonly<PluginPackagePromptExecutionOutputTarget> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'executionRequestId',
      'packageName',
      'projectId',
      'promptId',
    ])
  ) {
    return invalid();
  }
  return Object.freeze({
    projectId: identity(value.projectId),
    packageName: identity(value.packageName, PACKAGE_NAME),
    promptId: identity(value.promptId),
    executionRequestId: identity(value.executionRequestId),
  });
}

export function normalizePluginPackagePromptExecutionOutputReference(
  value: PluginPackagePromptExecutionOutputReference,
): Readonly<PluginPackagePromptExecutionOutputReference> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['artifactDigest', 'artifactId', 'runId'])
  ) {
    return invalid();
  }
  return Object.freeze({
    runId: identity(value.runId, RUN_ID),
    artifactId: identity(value.artifactId),
    artifactDigest: identity(value.artifactDigest, DIGEST),
  });
}

function normalizeCommand(
  value: PluginPackagePromptExecutionOutputReadCommand,
): Readonly<PluginPackagePromptExecutionOutputReadCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'executionRequestId',
      'packageName',
      'principal',
      'projectId',
      'promptId',
    ])
  ) {
    return invalid();
  }
  const target = normalizePluginPackagePromptExecutionOutputTarget({
    projectId: value.projectId,
    packageName: value.packageName,
    promptId: value.promptId,
    executionRequestId: value.executionRequestId,
  });
  return Object.freeze({ ...target, principal: value.principal });
}

function notFound(
  target: Readonly<PluginPackagePromptExecutionOutputTarget>,
): PluginPackagePromptExecutionOutputReadResult {
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_OUTPUT_READ_RESULT_SCHEMA,
    status: 'not_found' as const,
    ...target,
  });
}

/**
 * Resolves a caller-known execution request to its immutable Artifact and then
 * delegates policy, retention, key resolution and decryption to the existing
 * product output reader. No Provider or Model Gateway authority is needed.
 */
export class PluginPackagePromptExecutionOutputReadService {
  readonly #references: PluginPackagePromptExecutionOutputReferenceRepository;
  readonly #outputs: PluginPackagePromptOutputReader;

  constructor(
    options: Readonly<{
      references: PluginPackagePromptExecutionOutputReferenceRepository;
      outputs: PluginPackagePromptOutputReader;
    }>,
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !options.references ||
      typeof options.references.find !== 'function' ||
      !options.outputs ||
      typeof options.outputs.read !== 'function'
    ) {
      throw unavailable();
    }
    this.#references = options.references;
    this.#outputs = options.outputs;
  }

  async read(
    value: PluginPackagePromptExecutionOutputReadCommand,
  ): Promise<PluginPackagePromptExecutionOutputReadResult> {
    const command = normalizeCommand(value);
    const target = Object.freeze({
      projectId: command.projectId,
      packageName: command.packageName,
      promptId: command.promptId,
      executionRequestId: command.executionRequestId,
    });
    let located;
    try {
      located = await this.#references.find(target);
    } catch (cause) {
      throw unavailable(cause);
    }
    if (located === null) return notFound(target);
    const reference =
      normalizePluginPackagePromptExecutionOutputReference(located);
    let output;
    try {
      output = await this.#outputs.read({
        principal: command.principal,
        projectId: command.projectId,
        runId: reference.runId,
        artifactId: reference.artifactId,
        artifactDigest: reference.artifactDigest,
      });
    } catch (cause) {
      throw unavailable(cause);
    }
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      throw unavailable();
    }
    if (output.status === 'not_found') {
      if (
        output.schema !== PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_RESULT_SCHEMA ||
        !exactKeys(output, ['schema', 'status'])
      ) {
        throw unavailable();
      }
      return notFound(target);
    }
    if (
      output.status !== 'available' ||
      output.schema !== PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_RESULT_SCHEMA ||
      !exactKeys(output, ['reference', 'result', 'schema', 'status'])
    ) {
      throw unavailable();
    }
    let outputReference;
    let outputResult;
    try {
      outputReference = normalizePluginPackagePromptOutputArtifactReference(
        output.reference,
      );
      outputResult = normalizeGenerateResult(output.result);
    } catch (cause) {
      throw unavailable(cause);
    }
    if (
      outputReference.projectId !== command.projectId ||
      outputReference.runId !== reference.runId ||
      outputReference.artifactId !== reference.artifactId ||
      outputReference.artifactDigest !== reference.artifactDigest
    ) {
      throw unavailable();
    }
    return Object.freeze({
      schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_OUTPUT_READ_RESULT_SCHEMA,
      status: 'available' as const,
      ...target,
      reference: outputReference,
      result: outputResult,
    });
  }
}

import type { DeploymentProfile } from '../../cluster-control/clusterControlActivation';
import {
  RUN_LOG_MODEL_CONTEXT_PROFILES,
  type RunLogModelContextProfile,
} from '../../run/log-projection/runLogModelContextProjection';
import {
  normalizeProjectToolDefinitionSnapshot,
  type ProjectToolDefinitionSnapshot,
} from '../tool-registry/projectToolDefinitionSnapshot';
import {
  ToolDefinitionRegistry,
  type ToolJsonValue,
} from '../tool-registry/toolRegistry';
import {
  createTrustedToolHandlerBinding,
  normalizeTrustedToolHandlerBinding,
  type TrustedToolHandlerBinding,
} from '../trustedToolInvocation';
import type {
  TrustedToolExecutionAdapter,
  TrustedToolExecutionAdapterContext,
} from '../trustedToolExecution';
import {
  BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS,
  BUILTIN_RUN_LOG_EXCERPT_TOOL,
  BUILTIN_RUN_LOG_EXCERPT_TOOL_DEFINITION,
  InvalidBuiltInRunLogExcerptToolError,
  executeBuiltInRunLogExcerptTool,
  type RunAttemptLogReadPort,
} from './builtInRunLogExcerptProjection';

export {
  BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS,
  BUILTIN_RUN_LOG_EXCERPT_TOOL,
  BUILTIN_RUN_LOG_EXCERPT_TOOL_DEFINITION,
  BuiltInRunLogExcerptToolUnavailableError,
  InvalidBuiltInRunLogExcerptToolError,
  executeBuiltInRunLogExcerptTool,
} from './builtInRunLogExcerptProjection';

export const BUILTIN_RUN_LOG_EXCERPT_ADAPTER = Object.freeze({
  id: 'builtin.qinglong.run-log-excerpt',
  version: '1.0.0',
});
export const BUILTIN_RUN_LOG_EXCERPT_REDACTION_CONTRACT = Object.freeze({
  id: 'redaction.qinglong.run-log-excerpt',
  version: '1.0.0',
});
export const BUILTIN_RUN_LOG_EXCERPT_AUDIT_CONTRACT = Object.freeze({
  id: 'audit.qinglong.tool-call',
  version: '1.0.0',
});

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function invalid(message: string): never {
  throw new InvalidBuiltInRunLogExcerptToolError(message);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_PATTERN.test(value)
  );
}

function profiles(
  values: readonly DeploymentProfile[],
): readonly RunLogModelContextProfile[] {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > RUN_LOG_MODEL_CONTEXT_PROFILES.length ||
    new Set(values).size !== values.length ||
    values.some(
      (profile) =>
        !RUN_LOG_MODEL_CONTEXT_PROFILES.includes(
          profile as RunLogModelContextProfile,
        ),
    )
  ) {
    return invalid('deployment profiles are invalid');
  }
  return values as readonly RunLogModelContextProfile[];
}

export function createBuiltInRunLogExcerptToolHandlerBinding(
  snapshotValue: ProjectToolDefinitionSnapshot,
  profileValues: readonly DeploymentProfile[],
): Readonly<TrustedToolHandlerBinding> {
  const snapshot = normalizeProjectToolDefinitionSnapshot(snapshotValue);
  const supportedProfiles = profiles(profileValues);
  const definition = snapshot.definitions.find(
    (entry) =>
      entry.definition.name === BUILTIN_RUN_LOG_EXCERPT_TOOL.name &&
      entry.definition.version === BUILTIN_RUN_LOG_EXCERPT_TOOL.version,
  )?.definition;
  if (
    !definition ||
    !sameValue(definition, BUILTIN_RUN_LOG_EXCERPT_TOOL_DEFINITION)
  ) {
    return invalid('reviewed Tool definition is absent or changed');
  }
  return createTrustedToolHandlerBinding(snapshot, {
    tool: BUILTIN_RUN_LOG_EXCERPT_TOOL,
    adapter: BUILTIN_RUN_LOG_EXCERPT_ADAPTER,
    executionClass: 'builtin_in_process',
    profiles: supportedProfiles,
    authorities: ['artifact.read', 'database.read'],
    timeoutSeconds: BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS,
    redactionContract: BUILTIN_RUN_LOG_EXCERPT_REDACTION_CONTRACT,
    auditContract: BUILTIN_RUN_LOG_EXCERPT_AUDIT_CONTRACT,
  });
}

export class BuiltInRunLogExcerptToolAdapter
  implements TrustedToolExecutionAdapter
{
  readonly binding!: Readonly<TrustedToolHandlerBinding>;
  readonly profile!: RunLogModelContextProfile;
  readonly recoveryMode = 'retry_safe_read' as const;
  readonly #logs!: RunAttemptLogReadPort;

  constructor(
    bindingValue: TrustedToolHandlerBinding,
    profileValue: DeploymentProfile,
    definitions: ToolDefinitionRegistry,
    logs: RunAttemptLogReadPort,
  ) {
    const binding = normalizeTrustedToolHandlerBinding(bindingValue);
    const profile = profiles([profileValue])[0]!;
    if (!(definitions instanceof ToolDefinitionRegistry)) {
      return invalid('Tool Definition registry is invalid');
    }
    let definition;
    try {
      definition = definitions.resolve(
        BUILTIN_RUN_LOG_EXCERPT_TOOL.name,
        BUILTIN_RUN_LOG_EXCERPT_TOOL.version,
      );
    } catch {
      return invalid('reviewed Tool definition is unavailable');
    }
    if (
      !sameValue(binding.tool, BUILTIN_RUN_LOG_EXCERPT_TOOL) ||
      !sameValue(binding.adapter, BUILTIN_RUN_LOG_EXCERPT_ADAPTER) ||
      binding.executionClass !== 'builtin_in_process' ||
      !sameValue(binding.authorities, ['artifact.read', 'database.read']) ||
      binding.timeoutSeconds !== BUILTIN_RUN_LOG_EXCERPT_TIMEOUT_SECONDS ||
      !sameValue(
        binding.redactionContract,
        BUILTIN_RUN_LOG_EXCERPT_REDACTION_CONTRACT,
      ) ||
      !sameValue(
        binding.auditContract,
        BUILTIN_RUN_LOG_EXCERPT_AUDIT_CONTRACT,
      ) ||
      !binding.profiles.includes(profile) ||
      !sameValue(definition, BUILTIN_RUN_LOG_EXCERPT_TOOL_DEFINITION) ||
      !logs ||
      typeof logs.read !== 'function'
    ) {
      return invalid('binding does not match the reviewed adapter contract');
    }
    this.binding = binding;
    this.profile = profile;
    this.#logs = logs;
    Object.freeze(this);
  }

  async execute(
    context: Readonly<TrustedToolExecutionAdapterContext>,
    input: ToolJsonValue,
  ): Promise<unknown> {
    if (
      !context ||
      typeof context !== 'object' ||
      !boundedText(context.projectId, 128)
    ) {
      return invalid('execution context or input is invalid');
    }
    return executeBuiltInRunLogExcerptTool(
      this.#logs,
      this.profile,
      context.projectId,
      input,
    );
  }
}

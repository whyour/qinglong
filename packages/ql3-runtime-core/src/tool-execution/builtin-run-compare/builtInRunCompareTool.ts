import type { DeploymentProfile } from '../../cluster-control/clusterControlActivation';
import type { RunRepositoryReader } from '../../run/runRepository';
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
  BUILTIN_RUN_COMPARE_TOOL,
  BUILTIN_RUN_COMPARE_TOOL_DEFINITION,
  BUILTIN_RUN_COMPARE_TIMEOUT_SECONDS,
  InvalidBuiltInRunCompareToolError,
  executeBuiltInRunCompareTool,
} from './builtInRunCompareProjection';

export {
  BUILTIN_RUN_COMPARE_TOOL,
  BUILTIN_RUN_COMPARE_TOOL_DEFINITION,
  BUILTIN_RUN_COMPARE_TIMEOUT_SECONDS,
  BuiltInRunCompareToolUnavailableError,
  InvalidBuiltInRunCompareToolError,
  executeBuiltInRunCompareTool,
} from './builtInRunCompareProjection';

export const BUILTIN_RUN_COMPARE_ADAPTER = Object.freeze({
  id: 'builtin.qinglong.run-compare',
  version: '1.0.0',
});
export const BUILTIN_RUN_COMPARE_REDACTION_CONTRACT = Object.freeze({
  id: 'redaction.qinglong.run-compare',
  version: '1.0.0',
});
export const BUILTIN_RUN_COMPARE_AUDIT_CONTRACT = Object.freeze({
  id: 'audit.qinglong.tool-call',
  version: '1.0.0',
});
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function invalid(message: string): never {
  throw new InvalidBuiltInRunCompareToolError(message);
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

export function createBuiltInRunCompareToolHandlerBinding(
  snapshotValue: ProjectToolDefinitionSnapshot,
  profiles: readonly DeploymentProfile[],
): Readonly<TrustedToolHandlerBinding> {
  const snapshot = normalizeProjectToolDefinitionSnapshot(snapshotValue);
  const definition = snapshot.definitions.find(
    (entry) =>
      entry.definition.name === BUILTIN_RUN_COMPARE_TOOL.name &&
      entry.definition.version === BUILTIN_RUN_COMPARE_TOOL.version,
  )?.definition;
  if (!definition || !sameValue(definition, BUILTIN_RUN_COMPARE_TOOL_DEFINITION)) {
    return invalid('reviewed Tool definition is absent or changed');
  }
  return createTrustedToolHandlerBinding(snapshot, {
    tool: BUILTIN_RUN_COMPARE_TOOL,
    adapter: BUILTIN_RUN_COMPARE_ADAPTER,
    executionClass: 'builtin_in_process',
    profiles,
    authorities: ['database.read'],
    timeoutSeconds: BUILTIN_RUN_COMPARE_TIMEOUT_SECONDS,
    redactionContract: BUILTIN_RUN_COMPARE_REDACTION_CONTRACT,
    auditContract: BUILTIN_RUN_COMPARE_AUDIT_CONTRACT,
  });
}

export class BuiltInRunCompareToolAdapter
  implements TrustedToolExecutionAdapter
{
  readonly binding!: Readonly<TrustedToolHandlerBinding>;
  readonly profile!: DeploymentProfile;
  readonly recoveryMode = 'retry_safe_read' as const;
  readonly #runs!: Pick<RunRepositoryReader, 'findRunById'>;

  constructor(
    bindingValue: TrustedToolHandlerBinding,
    profile: DeploymentProfile,
    definitions: ToolDefinitionRegistry,
    runs: Pick<RunRepositoryReader, 'findRunById'>,
  ) {
    const binding = normalizeTrustedToolHandlerBinding(bindingValue);
    if (!(definitions instanceof ToolDefinitionRegistry)) {
      return invalid('Tool Definition registry is invalid');
    }
    let definition;
    try {
      definition = definitions.resolve(
        BUILTIN_RUN_COMPARE_TOOL.name,
        BUILTIN_RUN_COMPARE_TOOL.version,
      );
    } catch {
      return invalid('reviewed Tool definition is unavailable');
    }
    if (
      !sameValue(binding.tool, BUILTIN_RUN_COMPARE_TOOL) ||
      !sameValue(binding.adapter, BUILTIN_RUN_COMPARE_ADAPTER) ||
      binding.executionClass !== 'builtin_in_process' ||
      !sameValue(binding.authorities, ['database.read']) ||
      binding.timeoutSeconds !== BUILTIN_RUN_COMPARE_TIMEOUT_SECONDS ||
      !sameValue(
        binding.redactionContract,
        BUILTIN_RUN_COMPARE_REDACTION_CONTRACT,
      ) ||
      !sameValue(binding.auditContract, BUILTIN_RUN_COMPARE_AUDIT_CONTRACT) ||
      !binding.profiles.includes(profile) ||
      !sameValue(definition, BUILTIN_RUN_COMPARE_TOOL_DEFINITION)
    ) {
      return invalid('binding does not match the reviewed adapter contract');
    }
    if (!runs || typeof runs.findRunById !== 'function') {
      return invalid('Run repository is invalid');
    }
    this.binding = binding;
    this.profile = profile;
    this.#runs = runs;
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
    return executeBuiltInRunCompareTool(this.#runs, context.projectId, input);
  }
}

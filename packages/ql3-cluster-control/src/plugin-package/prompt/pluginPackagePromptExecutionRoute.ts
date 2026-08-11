// Plugin Package Prompt owns bounded, Policy-fenced model execution admission.
import { randomUUID } from 'node:crypto';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';
import type { ClusterControlAdmissionResponse } from '../../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../../transport/routeRegistry';

export const CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_REQUEST_SCHEMA =
  'qinglong/cluster-plugin-package-prompt-execution-request@v2' as const;
export const CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_RESPONSE_SCHEMA =
  'qinglong/cluster-plugin-package-prompt-execution-response@v2' as const;
export const CLUSTER_CONTROL_PLUGIN_PACKAGE_PROMPT_EXECUTION_ROUTE =
  Object.freeze({
    method: 'POST' as const,
    path: '/api/v3/projects/{projectId}/packages/{packageName}/prompts/{promptId}/executions',
    operationId: 'prompt.execute',
    permission: 'model.invoke',
    projectParameter: 'projectId',
  });

export const CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_LIMITS = Object.freeze({
  maxParameters: 64,
  maxParameterValueBytes: 64 * 1024,
  maxOutputTokens: 32_768,
  maxExecutionMs: 120_000,
  minOutputRetentionMs: 60 * 60_000,
  maxOutputRetentionMs: 365 * 24 * 60 * 60_000,
});

export type ClusterPluginPackagePromptOutputIntent =
  | Readonly<{ mode: 'live_only' }>
  | Readonly<{
      mode: 'durable_artifact';
      retentionPolicy: Readonly<{
        revision: string;
        retentionMs: number;
      }>;
    }>;

export interface ClusterPluginPackagePromptExecutionCommand {
  readonly projectId: string;
  readonly packageName: string;
  readonly promptId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly auditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<{
    readonly projectVersion: number;
    readonly bindingVersion: number;
  }>;
  readonly parameters: Readonly<Record<string, string>>;
  readonly provider: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly deadlineAtMs: number;
  readonly plannedAtMs: number;
  readonly output?: Readonly<ClusterPluginPackagePromptOutputIntent>;
  readonly signal: AbortSignal;
}

export interface ClusterPluginPackagePromptExecutionCapability {
  execute(command: Readonly<ClusterPluginPackagePromptExecutionCommand>): Promise<
    Readonly<{
      readonly status: 'executed' | 'resumed' | 'existing';
      readonly admission: Readonly<{
        readonly requestId: string;
        readonly invocationId: string;
        readonly runId: string;
        readonly stepRunId: string;
      }>;
      readonly finalization: Readonly<{ readonly runStatus: string }>;
      readonly result: unknown | null;
      readonly outputArtifact?: unknown;
    }>
  >;
}

export interface ClusterPluginPackagePromptExecutionRouteOptions {
  readonly maxExecutionMs?: number;
  readonly now?: () => number;
  readonly createEventId?: () => string;
}

class InvalidPromptExecutionRequestError extends TypeError {}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(): never {
  throw new InvalidPromptExecutionRequestError();
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    invalid();
  }
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) return invalid();
  return value;
}

function positiveInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    return invalid();
  }
  return value as number;
}

function parameters(value: unknown): Readonly<Record<string, string>> {
  const record = dataRecord(value);
  const names = Object.keys(record).sort();
  if (
    names.length > CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_LIMITS.maxParameters
  ) {
    return invalid();
  }
  const normalized = Object.create(null) as Record<string, string>;
  for (const name of names) {
    const parameter = record[name];
    if (
      !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ||
      typeof parameter !== 'string' ||
      Buffer.byteLength(parameter, 'utf8') >
        CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_LIMITS.maxParameterValueBytes
    ) {
      return invalid();
    }
    normalized[name] = parameter;
  }
  return Object.freeze(normalized);
}

function outputIntent(
  value: unknown,
): Readonly<ClusterPluginPackagePromptOutputIntent> {
  const output = dataRecord(value);
  if (output.mode === 'live_only') {
    exactKeys(output, ['mode']);
    return Object.freeze({ mode: 'live_only' as const });
  }
  if (output.mode !== 'durable_artifact') return invalid();
  exactKeys(output, ['mode', 'retentionPolicy']);
  const retention = dataRecord(output.retentionPolicy);
  exactKeys(retention, ['retentionMs', 'revision']);
  if (
    typeof retention.revision !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(retention.revision) ||
    !Number.isSafeInteger(retention.retentionMs) ||
    (retention.retentionMs as number) <
      CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_LIMITS.minOutputRetentionMs ||
    (retention.retentionMs as number) >
      CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_LIMITS.maxOutputRetentionMs
  ) {
    return invalid();
  }
  return Object.freeze({
    mode: 'durable_artifact' as const,
    retentionPolicy: Object.freeze({
      revision: retention.revision,
      retentionMs: retention.retentionMs as number,
    }),
  });
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function errorCode(error: unknown): string | null {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    typeof error.code !== 'string'
  ) {
    return null;
  }
  return error.code;
}

function executionError(error: unknown): ClusterControlAdmissionResponse {
  const code = errorCode(error);
  if (
    code === 'PLUGIN_PACKAGE_PROMPT_ADMISSION_NOT_ALLOWED' ||
    code === 'PLUGIN_PACKAGE_PROMPT_ADMISSION_CONFLICT' ||
    code === 'PLUGIN_PACKAGE_PROMPT_EXECUTION_IN_PROGRESS' ||
    code === 'PLUGIN_PACKAGE_PROMPT_RESOLUTION_REQUIRED' ||
    code === 'MODEL_INVOCATION_CONFLICT' ||
    code === 'MODEL_INVOCATION_REPLAY_BLOCKED'
  ) {
    return response(409, { code: 'prompt_execution_conflict' });
  }
  if (code === 'MODEL_GATEWAY_BUSY' || code === 'MODEL_PROJECT_QUOTA_EXCEEDED') {
    return response(429, { code: 'prompt_execution_capacity_exceeded' });
  }
  if (code === 'MODEL_POLICY_DENIED' || code === 'MODEL_BUDGET_EXCEEDED') {
    return response(422, { code: 'prompt_execution_policy_rejected' });
  }
  if (code === 'MODEL_INVOCATION_DEADLINE_EXCEEDED') {
    return response(504, { code: 'prompt_execution_deadline_exceeded' });
  }
  if (code === 'MODEL_INVOCATION_ABORTED') {
    return response(408, { code: 'prompt_execution_aborted' });
  }
  if (code === 'PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_INVALID') {
    return response(400, { code: 'invalid_prompt_execution_request' });
  }
  return response(503, { code: 'prompt_execution_unavailable' });
}

function parseBody(value: unknown, maximumExecutionMs: number) {
  const body = dataRecord(value);
  exactKeys(
    body,
    [
      'schema',
      'requestId',
      'traceId',
      'parameters',
      'provider',
      'model',
      'maxOutputTokens',
      'timeoutMs',
    ],
    ['output', 'temperature'],
  );
  if (body.schema !== CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_REQUEST_SCHEMA) {
    return invalid();
  }
  const temperature = body.temperature;
  const output =
    body.output === undefined ? undefined : outputIntent(body.output);
  if (
    temperature !== undefined &&
    (typeof temperature !== 'number' ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2)
  ) {
    return invalid();
  }
  return Object.freeze({
    requestId: identifier(body.requestId),
    traceId: identifier(body.traceId),
    parameters: parameters(body.parameters),
    provider: identifier(body.provider),
    model: identifier(body.model),
    maxOutputTokens: positiveInteger(
      body.maxOutputTokens,
      CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_LIMITS.maxOutputTokens,
    ),
    timeoutMs: positiveInteger(body.timeoutMs, maximumExecutionMs),
    ...(output === undefined ? {} : { output }),
    ...(temperature === undefined ? {} : { temperature }),
  });
}

export function createClusterControlPluginPackagePromptExecutionRoute(
  capability: ClusterPluginPackagePromptExecutionCapability,
  options: ClusterPluginPackagePromptExecutionRouteOptions = {},
): Readonly<ClusterControlRouteDefinition> {
  if (!capability || typeof capability.execute !== 'function') {
    throw new TypeError('Cluster-control Prompt execution capability is invalid');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Cluster-control Prompt execution route options are invalid');
  }
  const maximumExecutionMs =
    options.maxExecutionMs ??
    CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_LIMITS.maxExecutionMs;
  if (
    !Number.isSafeInteger(maximumExecutionMs) ||
    maximumExecutionMs < 1 ||
    maximumExecutionMs >
      CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_LIMITS.maxExecutionMs ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.createEventId !== undefined &&
      typeof options.createEventId !== 'function')
  ) {
    throw new TypeError('Cluster-control Prompt execution route options are invalid');
  }
  const now = options.now ?? Date.now;
  const createEventId = options.createEventId ?? randomUUID;
  return Object.freeze({
    ...CLUSTER_CONTROL_PLUGIN_PACKAGE_PROMPT_EXECUTION_ROUTE,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      routeParameters: ClusterControlRouteParameters,
    ) {
      let body;
      try {
        body = parseBody(authorized.request.body, maximumExecutionMs);
      } catch {
        return response(400, { code: 'invalid_prompt_execution_request' });
      }
      const projectId = authorized.projectId;
      const packageName = routeParameters.packageName;
      const promptId = routeParameters.promptId;
      const fence = authorized.policyFence;
      const plannedAtMs = now();
      const auditEventId = createEventId();
      if (
        projectId === null ||
        typeof packageName !== 'string' ||
        !PACKAGE_NAME.test(packageName) ||
        typeof promptId !== 'string' ||
        !IDENTIFIER.test(promptId) ||
        !fence ||
        fence.bindingVersion === null ||
        !Number.isSafeInteger(plannedAtMs) ||
        plannedAtMs < 0 ||
        typeof auditEventId !== 'string' ||
        !UUID_V4.test(auditEventId)
      ) {
        return response(503, { code: 'prompt_execution_unavailable' });
      }
      try {
        const result = await capability.execute({
          projectId,
          packageName,
          promptId,
          requestId: body.requestId,
          traceId: body.traceId,
          auditEventId,
          principal: authorized.principal,
          policyFence: Object.freeze({
            projectVersion: fence.projectVersion,
            bindingVersion: fence.bindingVersion,
          }),
          parameters: body.parameters,
          provider: body.provider,
          model: body.model,
          maxOutputTokens: body.maxOutputTokens,
          ...(body.temperature === undefined
            ? {}
            : { temperature: body.temperature }),
          ...(body.output === undefined ? {} : { output: body.output }),
          plannedAtMs,
          deadlineAtMs: plannedAtMs + body.timeoutMs,
          signal: authorized.request.signal,
        });
        return response(200, {
          schema: CLUSTER_PLUGIN_PACKAGE_PROMPT_EXECUTION_RESPONSE_SCHEMA,
          status: result.status,
          replayed: result.status === 'existing',
          requestId: result.admission.requestId,
          invocationId: result.admission.invocationId,
          runId: result.admission.runId,
          stepRunId: result.admission.stepRunId,
          runStatus: result.finalization.runStatus,
          result: result.result,
          ...(result.outputArtifact === undefined
            ? {}
            : { outputArtifact: result.outputArtifact }),
        });
      } catch (error) {
        return executionError(error);
      }
    },
  });
}

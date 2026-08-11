// Plugin Package Prompt owns its capability-free durable output projection.
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';

import type { ClusterControlAdmissionResponse } from '../../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../../transport/routeRegistry';

export const CLUSTER_PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_RESPONSE_SCHEMA =
  'qinglong/cluster-plugin-package-prompt-output-read-response@v1' as const;
export const CLUSTER_CONTROL_PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_ROUTE =
  Object.freeze({
    method: 'GET' as const,
    path: '/api/v3/projects/{projectId}/runs/{runId}/prompt-output-artifacts/{artifactId}',
    operationId: 'prompt.output.read',
    permission: 'artifact.read',
    projectParameter: 'projectId',
    allowedQuery: Object.freeze(['artifact_digest']),
  });

export interface ClusterPluginPackagePromptOutputReadCapability {
  read(command: Readonly<{
    principal: Readonly<SecurityPrincipal>;
    projectId: string;
    runId: string;
    artifactId: string;
    artifactDigest: string;
  }>): Promise<unknown>;
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_call',
  'unknown',
]);

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...required, ...optional.filter((key) => key in record)].sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
    ? record
    : null;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function availableView(
  value: unknown,
  expected: Readonly<{
    projectId: string;
    runId: string;
    artifactId: string;
    artifactDigest: string;
  }>,
): Readonly<Record<string, unknown>> | null {
  const resultEnvelope = exactRecord(value, [
    'schema',
    'status',
    'reference',
    'result',
  ]);
  if (
    !resultEnvelope ||
    resultEnvelope.schema !==
      'qinglong/plugin-package-prompt-output-read-result@v1' ||
    resultEnvelope.status !== 'available'
  ) {
    return null;
  }
  const reference = exactRecord(resultEnvelope.reference, [
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
  ]);
  const result = exactRecord(resultEnvelope.result, [
    'finishReason',
    'model',
    'provider',
    'text',
    'usage',
  ]);
  const usage = result ? exactRecord(result.usage, [
    'inputTokens',
    'outputTokens',
    'totalTokens',
  ], ['costMicros']) : null;
  if (
    !reference ||
    !result ||
    !usage ||
    reference.schema !==
      'qinglong/plugin-package-prompt-output-artifact-reference@v1' ||
    reference.algorithm !== 'aes-256-gcm' ||
    reference.projectId !== expected.projectId ||
    reference.runId !== expected.runId ||
    reference.artifactId !== expected.artifactId ||
    reference.artifactDigest !== expected.artifactDigest ||
    typeof reference.stepRunId !== 'string' ||
    !IDENTITY.test(reference.stepRunId) ||
    typeof reference.invocationId !== 'string' ||
    !IDENTITY.test(reference.invocationId) ||
    typeof reference.contentDigest !== 'string' ||
    !DIGEST.test(reference.contentDigest) ||
    !nonNegativeInteger(reference.outputBytes) ||
    reference.outputBytes > 1024 * 1024 ||
    typeof reference.retentionPolicyDigest !== 'string' ||
    !DIGEST.test(reference.retentionPolicyDigest) ||
    !nonNegativeInteger(reference.retentionEligibleAtMs) ||
    typeof reference.keyId !== 'string' ||
    !KEY_ID.test(reference.keyId) ||
    typeof result.provider !== 'string' ||
    !MODEL_ID.test(result.provider) ||
    typeof result.model !== 'string' ||
    !MODEL_ID.test(result.model) ||
    typeof result.text !== 'string' ||
    Buffer.byteLength(result.text, 'utf8') > 1024 * 1024 ||
    !FINISH_REASONS.has(result.finishReason as string) ||
    !nonNegativeInteger(usage.inputTokens) ||
    !nonNegativeInteger(usage.outputTokens) ||
    !nonNegativeInteger(usage.totalTokens) ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    (usage.costMicros !== undefined && !nonNegativeInteger(usage.costMicros))
  ) {
    return null;
  }
  return Object.freeze({
    schema: CLUSTER_PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_RESPONSE_SCHEMA,
    status: 'available',
    reference: Object.freeze({ ...reference }),
    result: Object.freeze({
      provider: result.provider,
      model: result.model,
      text: result.text,
      finishReason: result.finishReason,
      usage: Object.freeze({ ...usage }),
    }),
  });
}

export function createClusterControlPluginPackagePromptOutputReadRoute(
  capability: ClusterPluginPackagePromptOutputReadCapability,
): Readonly<ClusterControlRouteDefinition> {
  if (!capability || typeof capability.read !== 'function') {
    throw new TypeError('Cluster-control Prompt output read capability is invalid');
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_PLUGIN_PACKAGE_PROMPT_OUTPUT_READ_ROUTE,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      const artifactDigestValues =
        authorized.request.query.artifact_digest;
      if (
        authorized.request.body !== null ||
        authorized.projectId === null ||
        typeof parameters.runId !== 'string' ||
        !RUN_ID.test(parameters.runId) ||
        typeof parameters.artifactId !== 'string' ||
        !IDENTITY.test(parameters.artifactId) ||
        !Array.isArray(artifactDigestValues) ||
        artifactDigestValues.length !== 1 ||
        typeof artifactDigestValues[0] !== 'string' ||
        !DIGEST.test(artifactDigestValues[0])
      ) {
        return response(400, { code: 'invalid_prompt_output_read_request' });
      }
      const expected = Object.freeze({
        projectId: authorized.projectId,
        runId: parameters.runId,
        artifactId: parameters.artifactId,
        artifactDigest: artifactDigestValues[0],
      });
      try {
        const result = await capability.read({
          principal: authorized.principal,
          ...expected,
        });
        const notFound = exactRecord(result, ['schema', 'status']);
        if (
          notFound &&
          notFound.schema ===
            'qinglong/plugin-package-prompt-output-read-result@v1' &&
          notFound.status === 'not_found'
        ) {
          return response(404, { code: 'prompt_output_not_found' });
        }
        const view = availableView(result, expected);
        return view
          ? response(200, view)
          : response(503, { code: 'prompt_output_read_unavailable' });
      } catch {
        return response(503, { code: 'prompt_output_read_unavailable' });
      }
    },
  });
}

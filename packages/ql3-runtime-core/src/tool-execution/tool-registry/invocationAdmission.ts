import { createHash } from 'node:crypto';
import {
  assertProjectPolicyProjectId,
  normalizeProjectPermission,
} from '../../security/project-policy/projectPolicy';
import {
  normalizeSecurityPolicyDecision,
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPolicyFence,
} from '../../security/security';
import {
  InvalidToolJsonValueError,
  TOOL_INVOCATION_SCHEMA,
  ToolPolicySnapshotConflictError,
  ToolPolicyUnavailableError,
  type ToolInvocationPlan,
  type ToolInvocationRequest,
  type ToolPolicyAuthorizer,
} from './contracts';
import { ToolDefinitionRegistry } from './registryProtocol';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function sameFence(
  left: Readonly<SecurityPolicyFence>,
  right: Readonly<SecurityPolicyFence>,
): boolean {
  return (
    left.projectVersion === right.projectVersion &&
    left.bindingVersion === right.bindingVersion
  );
}

function digest(value: unknown): string {
  const result = createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
  if (!SHA256_PATTERN.test(result)) {
    throw new Error('unreachable SHA-256 result');
  }
  return result;
}

export async function prepareToolInvocation(
  registry: ToolDefinitionRegistry,
  request: ToolInvocationRequest,
  authorizer: ToolPolicyAuthorizer,
): Promise<ToolInvocationPlan> {
  if (!(registry instanceof ToolDefinitionRegistry)) {
    throw new TypeError('Tool registry is invalid');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new InvalidToolJsonValueError('request must be an object');
  }
  const requestRecord = request as unknown as Record<string, unknown>;
  const keys = Object.keys(requestRecord).sort();
  const expected = ['input', 'nowMs', 'principal', 'projectId', 'tool'].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new InvalidToolJsonValueError('request shape is invalid');
  }
  if (
    !request.tool ||
    typeof request.tool !== 'object' ||
    Array.isArray(request.tool) ||
    Object.keys(request.tool).sort().join(',') !== 'name,version'
  ) {
    throw new InvalidToolJsonValueError('request Tool identity is invalid');
  }
  assertProjectPolicyProjectId(request.projectId);
  const principal = normalizeSecurityPrincipal(
    request.principal,
    request.nowMs,
  );
  const definition = registry.resolve(request.tool.name, request.tool.version);
  if (!authorizer || typeof authorizer.authorize !== 'function') {
    throw new ToolPolicyUnavailableError();
  }
  const permission = normalizeProjectPermission(`tool.call:${definition.name}`);
  const permissions = Object.freeze([
    permission,
    ...definition.requiredPermissions,
  ]);
  const decisions: Readonly<SecurityPolicyDecision>[] = [];
  for (const requiredPermission of permissions) {
    try {
      const decision = normalizeSecurityPolicyDecision(
        await authorizer.authorize(
          principal,
          request.projectId,
          requiredPermission,
        ),
      );
      if (decision.effect === 'deny') {
        return Object.freeze({
          status: 'denied',
          tool: Object.freeze({
            name: definition.name,
            version: definition.version,
          }),
          permission,
        });
      }
      decisions.push(decision);
    } catch {
      throw new ToolPolicyUnavailableError();
    }
  }
  const fences = decisions.map((decision) => decision.fence);
  const fence = fences[0];
  if (
    !fence ||
    fences.some(
      (candidate) => candidate === null || !sameFence(fence, candidate),
    )
  ) {
    throw new ToolPolicySnapshotConflictError();
  }

  const input = registry.normalizeInput(
    definition.name,
    definition.version,
    request.input,
  );
  const inputDigest = digest(input);
  const actionDigest = digest({
    schema: TOOL_INVOCATION_SCHEMA,
    projectId: request.projectId,
    requestedBy: principal.subject,
    tool: {
      name: definition.name,
      version: definition.version,
    },
    permission,
    requiredPermissions: definition.requiredPermissions,
    effect: definition.effect,
    risk: definition.risk,
    timeoutSeconds: definition.timeoutSeconds,
    inputDigest,
  });
  return Object.freeze({
    status: decisions.some((decision) => decision.effect === 'require_approval')
      ? 'approval_required'
      : 'ready',
    schema: TOOL_INVOCATION_SCHEMA,
    projectId: request.projectId,
    requestedBy: principal.subject,
    tool: Object.freeze({
      name: definition.name,
      version: definition.version,
    }),
    permission,
    requiredPermissions: definition.requiredPermissions,
    effect: definition.effect,
    risk: definition.risk,
    timeoutSeconds: definition.timeoutSeconds,
    fence,
    input,
    inputDigest,
    actionDigest,
  });
}

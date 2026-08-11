import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';

import {
  MAX_MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_LIFETIME_MS,
  MODEL_PROVIDER_CREDENTIAL_TEST_CONTROL_PATTERN,
  MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_SCHEMA,
  digest,
  exact,
  identifier,
  integer,
  invalid,
  sha256,
  uuid,
  type CreateModelProviderCredentialTestPlanInput,
  type ModelProviderCredentialTestPlan,
} from './contractProtocol';
import { normalizeModelProviderCredentialTestEndpoint } from './endpointAllowlistProtocol';

const PLAN_DIGEST_DOMAIN =
  'qinglong/model-provider-credential-test-plan-digest@v1\0';

function user(value: SecuritySubject): Readonly<{ type: 'user'; id: string }> {
  exact(value, ['id', 'type']);
  if (
    value.type !== 'user' ||
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    Buffer.byteLength(value.id, 'utf8') > 128 ||
    MODEL_PROVIDER_CREDENTIAL_TEST_CONTROL_PATTERN.test(value.id)
  ) {
    invalid();
  }
  return Object.freeze({ type: 'user' as const, id: value.id });
}

function fence(value: SecurityPolicyFence): Readonly<{
  projectVersion: number;
  bindingVersion: number;
}> {
  exact(value, ['bindingVersion', 'projectVersion']);
  if (value.bindingVersion === null) invalid();
  return Object.freeze({
    projectVersion: integer(value.projectVersion, 1, 2_147_483_647),
    bindingVersion: integer(value.bindingVersion, 1, 2_147_483_647),
  });
}

function planSemantic(
  input: Omit<ModelProviderCredentialTestPlan, 'planDigest'>,
) {
  return Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_SCHEMA,
    testId: input.testId,
    requestId: input.requestId,
    projectId: input.projectId,
    provider: input.provider,
    endpoint: input.endpoint,
    requestedBy: input.requestedBy,
    fence: input.fence,
    plannedAtMs: input.plannedAtMs,
    expiresAtMs: input.expiresAtMs,
  });
}

export function createModelProviderCredentialTestPlan(
  value: CreateModelProviderCredentialTestPlanInput,
): Readonly<ModelProviderCredentialTestPlan> {
  exact(value, [
    'endpoint',
    'expiresAtMs',
    'fence',
    'plannedAtMs',
    'projectId',
    'provider',
    'requestId',
    'requestedBy',
    'testId',
  ]);
  const plannedAtMs = integer(value.plannedAtMs, 0, Number.MAX_SAFE_INTEGER);
  const expiresAtMs = integer(value.expiresAtMs, 0, Number.MAX_SAFE_INTEGER);
  const endpoint = normalizeModelProviderCredentialTestEndpoint(value.endpoint);
  const provider = identifier(value.provider);
  if (
    endpoint.provider !== provider ||
    expiresAtMs <= plannedAtMs ||
    expiresAtMs - plannedAtMs >
      MAX_MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_LIFETIME_MS
  ) {
    invalid();
  }
  const semantic = planSemantic({
    schema: MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_SCHEMA,
    testId: uuid(value.testId),
    requestId: identifier(value.requestId, true),
    projectId: identifier(value.projectId),
    provider,
    endpoint,
    requestedBy: user(value.requestedBy),
    fence: fence(value.fence),
    plannedAtMs,
    expiresAtMs,
  });
  return Object.freeze({
    ...semantic,
    planDigest: sha256(PLAN_DIGEST_DOMAIN, semantic),
  });
}

export function normalizeModelProviderCredentialTestPlan(
  value: ModelProviderCredentialTestPlan,
): Readonly<ModelProviderCredentialTestPlan> {
  exact(value, [
    'endpoint',
    'expiresAtMs',
    'fence',
    'planDigest',
    'plannedAtMs',
    'projectId',
    'provider',
    'requestId',
    'requestedBy',
    'schema',
    'testId',
  ]);
  if (value.schema !== MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_SCHEMA) invalid();
  const normalized = createModelProviderCredentialTestPlan({
    testId: value.testId,
    requestId: value.requestId,
    projectId: value.projectId,
    provider: value.provider,
    endpoint: value.endpoint,
    requestedBy: value.requestedBy,
    fence: value.fence,
    plannedAtMs: value.plannedAtMs,
    expiresAtMs: value.expiresAtMs,
  });
  if (digest(value.planDigest) !== normalized.planDigest) invalid();
  return normalized;
}

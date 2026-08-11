import { createHash } from 'node:crypto';

import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';

export const MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_SCHEMA =
  'qinglong/model-provider-credential-test-allowlist@v1' as const;
export const MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_SCHEMA =
  'qinglong/model-provider-credential-test-plan@v1' as const;
export const MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTION_SCHEMA =
  'qinglong/model-provider-credential-test-execution@v1' as const;
export const MODEL_PROVIDER_CREDENTIAL_TEST_RESULT_SCHEMA =
  'qinglong/model-provider-credential-test-result@v1' as const;
export const MAX_MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_ENTRIES = 16;
export const MAX_MODEL_PROVIDER_CREDENTIAL_TEST_DEADLINE_MS = 15_000;
export const MAX_MODEL_PROVIDER_CREDENTIAL_TEST_RESPONSE_BYTES = 256 * 1_024;
export const MAX_MODEL_PROVIDER_CREDENTIAL_TEST_MODELS = 256;
export const MAX_MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_LIFETIME_MS =
  5 * 60 * 1_000;

export interface ModelProviderCredentialTestEndpointInput {
  readonly provider: string;
  readonly adapter: 'openai-compatible';
  readonly baseUrl: string;
  readonly revision: string;
  readonly deadlineMs: number;
  readonly maxResponseBytes: number;
  readonly maxModels: number;
  readonly maxCostMicrousd: 0;
  readonly retryLimit: 0;
}

export interface ModelProviderCredentialTestEndpoint
  extends ModelProviderCredentialTestEndpointInput {
  readonly configDigest: string;
}

export interface ModelProviderCredentialTestAllowlist {
  readonly schema: typeof MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_SCHEMA;
  readonly revision: string;
  readonly providers: readonly Readonly<ModelProviderCredentialTestEndpoint>[];
  readonly catalogDigest: string;
}

export interface ModelProviderCredentialTestPlan {
  readonly schema: typeof MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_SCHEMA;
  readonly testId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly endpoint: Readonly<ModelProviderCredentialTestEndpoint>;
  readonly requestedBy: Readonly<{ type: 'user'; id: string }>;
  readonly fence: Readonly<{
    projectVersion: number;
    bindingVersion: number;
  }>;
  readonly plannedAtMs: number;
  readonly expiresAtMs: number;
  readonly planDigest: string;
}

export interface CreateModelProviderCredentialTestPlanInput {
  readonly testId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly endpoint: Readonly<ModelProviderCredentialTestEndpoint>;
  readonly requestedBy: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly plannedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ModelProviderCredentialTestExecution {
  readonly schema: typeof MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTION_SCHEMA;
  readonly executionId: string;
  readonly testId: string;
  readonly planDigest: string;
  readonly startedAtMs: number;
  readonly executionDigest: string;
}

export type ModelProviderCredentialTestOutcome = 'reachable' | 'unreachable';

export interface ModelProviderCredentialTestResult {
  readonly schema: typeof MODEL_PROVIDER_CREDENTIAL_TEST_RESULT_SCHEMA;
  readonly executionId: string;
  readonly testId: string;
  readonly planDigest: string;
  readonly outcome: ModelProviderCredentialTestOutcome;
  readonly modelCount: number | null;
  readonly durationMs: number;
  readonly completedAtMs: number;
  readonly resultDigest: string;
}

export class InvalidModelProviderCredentialTestConnectionError extends TypeError {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_TEST_CONNECTION_INVALID';

  constructor() {
    super('Model provider credential test connection value is invalid');
    this.name = 'InvalidModelProviderCredentialTestConnectionError';
  }
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export const MODEL_PROVIDER_CREDENTIAL_TEST_CONTROL_PATTERN =
  /[\u0000-\u001f\u007f]/;

export function invalid(): never {
  throw new InvalidModelProviderCredentialTestConnectionError();
}

export function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const candidate = value as Record<string, unknown>;
  const actual = Reflect.ownKeys(candidate);
  const expected = [...keys].sort();
  if (
    actual.some((key) => typeof key !== 'string') ||
    actual.length !== expected.length ||
    actual
      .map(String)
      .sort()
      .some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  if (
    Object.values(descriptors).some(
      ({ get, set, enumerable }) =>
        get !== undefined || set !== undefined || enumerable !== true,
    )
  ) {
    invalid();
  }
  return candidate;
}

export function identifier(value: unknown, request = false): string {
  const pattern = request ? REQUEST_ID_PATTERN : IDENTIFIER_PATTERN;
  if (typeof value !== 'string' || !pattern.test(value)) invalid();
  return value;
}

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) invalid();
  return value;
}

export function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) invalid();
  return value;
}

export function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    invalid();
  }
  return value as number;
}

export function sha256(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

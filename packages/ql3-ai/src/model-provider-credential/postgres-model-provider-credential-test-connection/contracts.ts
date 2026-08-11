import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

import type {
  ModelProviderCredentialTestAllowlist,
  ModelProviderCredentialTestExecution,
  ModelProviderCredentialTestPlan,
  ModelProviderCredentialTestResult,
} from '../modelProviderCredentialTestConnection';

export const MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID =
  'model_provider_credential.test.plan';

type Row = Record<string, unknown>;

export interface AuthorizedModelProviderCredentialTestPlan {
  readonly plan: ModelProviderCredentialTestPlan;
  readonly audit: SecurityAuditRecord;
}

export interface CreateModelProviderCredentialTestPlanResult {
  readonly status: 'created' | 'existing';
  readonly plan: Readonly<ModelProviderCredentialTestPlan>;
}

export interface ModelProviderCredentialTestPlanRepository {
  createAuthorized(
    value: AuthorizedModelProviderCredentialTestPlan,
  ): Promise<Readonly<CreateModelProviderCredentialTestPlanResult>>;
}

export interface PostgresModelProviderCredentialTestPlanOptions {
  readonly quotaWindowMs?: number;
  readonly quotaLimit?: number;
}

export class ModelProviderCredentialTestPlanAuthorizationFenceConflictError extends Error {
  readonly code =
    'MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super('Model provider credential test plan authorization fence changed');
    this.name =
      'ModelProviderCredentialTestPlanAuthorizationFenceConflictError';
  }
}

export class ModelProviderCredentialTestPlanConflictError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_CONFLICT';

  constructor() {
    super('Model provider credential test plan conflicts with durable state');
    this.name = 'ModelProviderCredentialTestPlanConflictError';
  }
}

export class ModelProviderCredentialTestPlanQuotaExceededError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_QUOTA_EXCEEDED';

  constructor(readonly retryAfterMs: number) {
    super('Model provider credential test plan quota is exceeded');
    this.name = 'ModelProviderCredentialTestPlanQuotaExceededError';
  }
}

export class ModelProviderCredentialTestPlanUnavailableError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Model provider credential test plan is unavailable', options);
    this.name = 'ModelProviderCredentialTestPlanUnavailableError';
  }
}

export interface BeginModelProviderCredentialTestExecutionInput {
  readonly executionId: string;
  readonly testId: string;
  readonly allowlist: ModelProviderCredentialTestAllowlist;
}

export interface BeginModelProviderCredentialTestExecutionResult {
  readonly status: 'created' | 'existing';
  readonly plan: Readonly<ModelProviderCredentialTestPlan>;
  readonly execution: Readonly<ModelProviderCredentialTestExecution>;
  readonly result: Readonly<ModelProviderCredentialTestResult> | null;
}

export interface CompleteModelProviderCredentialTestExecutionResult {
  readonly status: 'created' | 'existing';
  readonly result: Readonly<ModelProviderCredentialTestResult>;
}

export interface ModelProviderCredentialTestExecutionRepository {
  beginExecution(
    value: BeginModelProviderCredentialTestExecutionInput,
  ): Promise<Readonly<BeginModelProviderCredentialTestExecutionResult>>;
  complete(
    value: ModelProviderCredentialTestResult,
  ): Promise<Readonly<CompleteModelProviderCredentialTestExecutionResult>>;
}

export interface PostgresModelProviderCredentialTesterReadinessReport {
  readonly ready: true;
  readonly currentUser: string;
  readonly migrationIds: readonly string[];
  readonly writablePrimary: true;
  readonly testerAuthority: true;
  readonly leastPrivilege: true;
}

export class ModelProviderCredentialTestExecutionRejectedError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTION_REJECTED';

  constructor() {
    super('Model provider credential test execution is rejected');
    this.name = 'ModelProviderCredentialTestExecutionRejectedError';
  }
}

export class ModelProviderCredentialTestExecutionConflictError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTION_CONFLICT';

  constructor() {
    super(
      'Model provider credential test execution conflicts with durable state',
    );
    this.name = 'ModelProviderCredentialTestExecutionConflictError';
  }
}

export class ModelProviderCredentialTestExecutionUnavailableError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Model provider credential test execution is unavailable', options);
    this.name = 'ModelProviderCredentialTestExecutionUnavailableError';
  }
}

export class PostgresModelProviderCredentialTesterNotReadyError extends Error {
  readonly code = 'POSTGRES_MODEL_PROVIDER_CREDENTIAL_TESTER_NOT_READY';

  constructor(options?: ErrorOptions) {
    super('PostgreSQL model provider credential tester is not ready', options);
    this.name = 'PostgresModelProviderCredentialTesterNotReadyError';
  }
}

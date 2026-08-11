/** Model-provider credential management application service boundary. */
import {
  InvalidModelProviderCredentialAdministrationMutationError,
  ModelProviderCredentialAdministrationAuthorizationFenceConflictError,
  ModelProviderCredentialAdministrationMutationConflictError,
  modelProviderCredentialAdministrationOperationId,
  type ModelProviderCredentialAdministrationRepository,
} from '@qinglong/ai/model-provider-credential-administration';
import {
  MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
  InvalidModelProviderCredentialTransitionError,
  ModelProviderCredentialCatalogUnavailableError,
  ModelProviderCredentialTransitionConflictError,
  createModelProviderCredentialTransitionCommand,
  type CommitModelProviderCredentialTransitionResult,
} from '@qinglong/ai/model-provider-credential-catalog';
import { MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA } from '@qinglong/ai/provider-credential';
import {
  MAX_MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_LIFETIME_MS,
  InvalidModelProviderCredentialTestConnectionError,
  createModelProviderCredentialTestPlan,
  normalizeModelProviderCredentialTestAllowlist,
  resolveModelProviderCredentialTestEndpoint,
  type ModelProviderCredentialTestAllowlist,
} from '@qinglong/ai/model-provider-credential-test-connection';
import {
  InvalidModelProviderCredentialManagementAuditQueryError,
  MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_QUERY_OPERATION_ID,
  ModelProviderCredentialManagementAuditAuthorizationFenceConflictError,
  ModelProviderCredentialManagementAuditConflictError,
  ModelProviderCredentialManagementAuditUnavailableError,
  normalizeModelProviderCredentialManagementAuditQuery,
  type ModelProviderCredentialManagementAuditCursor,
  type ModelProviderCredentialManagementAuditPage,
  type ModelProviderCredentialManagementAuditQueryRepository,
} from '@qinglong/ai/postgres-model-provider-credential-management-audit-query';
import {
  MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID,
  ModelProviderCredentialTestPlanAuthorizationFenceConflictError,
  ModelProviderCredentialTestPlanConflictError,
  ModelProviderCredentialTestPlanQuotaExceededError,
  ModelProviderCredentialTestPlanUnavailableError,
  type CreateModelProviderCredentialTestPlanResult,
  type ModelProviderCredentialTestPlanRepository,
} from '@qinglong/ai/postgres-model-provider-credential-test-connection';
import type { ProjectPermission } from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_USER_ASSURANCES = new Set(['multi_factor', 'hardware']);
const MAX_PRINCIPAL_AGE_MS = 5 * 60 * 1_000;

interface BaseMutationRequest {
  readonly requestId: string;
  readonly mutationId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly expectedGeneration: number;
  readonly principal: SecurityPrincipal;
}

export interface BindModelProviderCredentialRequest
  extends BaseMutationRequest {
  readonly revision: string;
  readonly secretRef: string;
}

export interface RevokeModelProviderCredentialRequest
  extends BaseMutationRequest {}

export interface ListModelProviderCredentialManagementAuditRequest {
  readonly requestId: string;
  readonly queryId: string;
  readonly projectId: string;
  readonly limit: number;
  readonly before?: ModelProviderCredentialManagementAuditCursor;
  readonly principal: SecurityPrincipal;
}

export interface PlanModelProviderCredentialTestRequest {
  readonly requestId: string;
  readonly testId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly principal: SecurityPrincipal;
}

export interface ClusterModelProviderCredentialManagementPolicy {
  authorize(
    principal: Readonly<SecurityPrincipal>,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<Readonly<SecurityPolicyDecision>>;
}

export interface ClusterModelProviderCredentialManagementService {
  bind(
    request: Readonly<BindModelProviderCredentialRequest>,
  ): Promise<Readonly<CommitModelProviderCredentialTransitionResult>>;
  revoke(
    request: Readonly<RevokeModelProviderCredentialRequest>,
  ): Promise<Readonly<CommitModelProviderCredentialTransitionResult>>;
  listAudit(
    request: Readonly<ListModelProviderCredentialManagementAuditRequest>,
  ): Promise<Readonly<ModelProviderCredentialManagementAuditPage>>;
  planTestConnection(
    request: Readonly<PlanModelProviderCredentialTestRequest>,
  ): Promise<Readonly<CreateModelProviderCredentialTestPlanResult>>;
}

export interface ClusterModelProviderCredentialManagementOptions {
  readonly policy: ClusterModelProviderCredentialManagementPolicy;
  readonly credentials: ModelProviderCredentialAdministrationRepository;
  readonly audit: ModelProviderCredentialManagementAuditQueryRepository;
  readonly testPlans: ModelProviderCredentialTestPlanRepository;
  readonly testAllowlist: ModelProviderCredentialTestAllowlist;
  readonly testPlanLifetimeMs?: number;
  readonly now?: () => number;
}

export class ClusterModelProviderCredentialManagementRequestError extends TypeError {
  readonly code =
    'CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_REQUEST_INVALID';

  constructor() {
    super('Cluster model provider credential management request is invalid');
    this.name = 'ClusterModelProviderCredentialManagementRequestError';
  }
}

export class ClusterModelProviderCredentialManagementAuthenticationError extends Error {
  readonly code =
    'CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUTHENTICATION_REQUIRED';

  constructor() {
    super(
      'Cluster model provider credential management requires a recent strong User',
    );
    this.name = 'ClusterModelProviderCredentialManagementAuthenticationError';
  }
}

export class ClusterModelProviderCredentialManagementAuthorizationError extends Error {
  readonly code = 'CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_FORBIDDEN';

  constructor() {
    super('Cluster model provider credential management is forbidden');
    this.name = 'ClusterModelProviderCredentialManagementAuthorizationError';
  }
}

export class ClusterModelProviderCredentialManagementConflictError extends Error {
  readonly code = 'CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_CONFLICT';

  constructor() {
    super(
      'Cluster model provider credential management conflicts with durable state',
    );
    this.name = 'ClusterModelProviderCredentialManagementConflictError';
  }
}

export class ClusterModelProviderCredentialManagementUnavailableError extends Error {
  readonly code = 'CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_UNAVAILABLE';

  constructor() {
    super('Cluster model provider credential management is unavailable');
    this.name = 'ClusterModelProviderCredentialManagementUnavailableError';
  }
}

export class ClusterModelProviderCredentialManagementQuotaExceededError extends Error {
  readonly code = 'CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_QUOTA_EXCEEDED';

  constructor(readonly retryAfterMs: number) {
    super('Cluster model provider credential management quota is exceeded');
    this.name = 'ClusterModelProviderCredentialManagementQuotaExceededError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function normalizeBaseRequest(
  value: BaseMutationRequest,
  expectedKeys: readonly string[],
): Readonly<BaseMutationRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, expectedKeys) ||
    typeof value.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    typeof value.mutationId !== 'string' ||
    !UUID_PATTERN.test(value.mutationId) ||
    typeof value.projectId !== 'string' ||
    !IDENTITY_PATTERN.test(value.projectId) ||
    typeof value.provider !== 'string' ||
    !IDENTITY_PATTERN.test(value.provider) ||
    !Number.isSafeInteger(value.expectedGeneration) ||
    value.expectedGeneration < 0 ||
    value.expectedGeneration > 2_147_483_646
  ) {
    throw new ClusterModelProviderCredentialManagementRequestError();
  }
  return value;
}

function mapMutationError(error: unknown): never {
  if (
    error instanceof
      InvalidModelProviderCredentialAdministrationMutationError ||
    error instanceof InvalidModelProviderCredentialTransitionError
  ) {
    throw new ClusterModelProviderCredentialManagementRequestError();
  }
  if (
    error instanceof
      ModelProviderCredentialAdministrationAuthorizationFenceConflictError ||
    error instanceof
      ModelProviderCredentialAdministrationMutationConflictError ||
    error instanceof ModelProviderCredentialTransitionConflictError
  ) {
    throw new ClusterModelProviderCredentialManagementConflictError();
  }
  if (error instanceof ModelProviderCredentialCatalogUnavailableError) {
    throw new ClusterModelProviderCredentialManagementUnavailableError();
  }
  throw new ClusterModelProviderCredentialManagementUnavailableError();
}

function mapAuditError(error: unknown): never {
  if (
    error instanceof InvalidModelProviderCredentialManagementAuditQueryError
  ) {
    throw new ClusterModelProviderCredentialManagementRequestError();
  }
  if (
    error instanceof
      ModelProviderCredentialManagementAuditAuthorizationFenceConflictError ||
    error instanceof ModelProviderCredentialManagementAuditConflictError
  ) {
    throw new ClusterModelProviderCredentialManagementConflictError();
  }
  if (error instanceof ModelProviderCredentialManagementAuditUnavailableError) {
    throw new ClusterModelProviderCredentialManagementUnavailableError();
  }
  throw new ClusterModelProviderCredentialManagementUnavailableError();
}

function mapTestPlanError(error: unknown): never {
  if (error instanceof InvalidModelProviderCredentialTestConnectionError) {
    throw new ClusterModelProviderCredentialManagementRequestError();
  }
  if (
    error instanceof
      ModelProviderCredentialTestPlanAuthorizationFenceConflictError ||
    error instanceof ModelProviderCredentialTestPlanConflictError
  ) {
    throw new ClusterModelProviderCredentialManagementConflictError();
  }
  if (error instanceof ModelProviderCredentialTestPlanQuotaExceededError) {
    throw new ClusterModelProviderCredentialManagementQuotaExceededError(
      error.retryAfterMs,
    );
  }
  if (error instanceof ModelProviderCredentialTestPlanUnavailableError) {
    throw new ClusterModelProviderCredentialManagementUnavailableError();
  }
  throw new ClusterModelProviderCredentialManagementUnavailableError();
}

export function createClusterModelProviderCredentialManagementService(
  options: ClusterModelProviderCredentialManagementOptions,
): Readonly<ClusterModelProviderCredentialManagementService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'policy' &&
        key !== 'credentials' &&
        key !== 'audit' &&
        key !== 'testPlans' &&
        key !== 'testAllowlist' &&
        key !== 'testPlanLifetimeMs' &&
        key !== 'now',
    ) ||
    !options.policy ||
    typeof options.policy.authorize !== 'function' ||
    !options.credentials ||
    typeof options.credentials.commitAuthorized !== 'function' ||
    typeof options.credentials.findCurrentTransition !== 'function' ||
    typeof options.credentials.commit !== 'function' ||
    !options.audit ||
    typeof options.audit.listAuthorized !== 'function' ||
    !options.testPlans ||
    typeof options.testPlans.createAuthorized !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError(
      'Cluster model provider credential management options are invalid',
    );
  }
  const now = options.now ?? Date.now;
  let testAllowlist: Readonly<ModelProviderCredentialTestAllowlist>;
  try {
    testAllowlist = normalizeModelProviderCredentialTestAllowlist(
      options.testAllowlist,
    );
  } catch {
    throw new TypeError(
      'Cluster model provider credential management options are invalid',
    );
  }
  const testPlanLifetimeMs =
    options.testPlanLifetimeMs ??
    MAX_MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_LIFETIME_MS;
  if (
    !Number.isSafeInteger(testPlanLifetimeMs) ||
    testPlanLifetimeMs < 1_000 ||
    testPlanLifetimeMs > MAX_MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_LIFETIME_MS
  ) {
    throw new TypeError(
      'Cluster model provider credential management options are invalid',
    );
  }

  const authorize = async (
    principalValue: SecurityPrincipal,
    projectId: string,
  ) => {
    const observedAtMs = now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new ClusterModelProviderCredentialManagementUnavailableError();
    }
    let principal: Readonly<SecurityPrincipal>;
    try {
      principal = normalizeSecurityPrincipal(principalValue, observedAtMs);
    } catch {
      throw new ClusterModelProviderCredentialManagementAuthenticationError();
    }
    if (
      principal.subject.type !== 'user' ||
      !STRONG_USER_ASSURANCES.has(principal.assurance) ||
      observedAtMs - principal.authenticatedAtMs > MAX_PRINCIPAL_AGE_MS
    ) {
      throw new ClusterModelProviderCredentialManagementAuthenticationError();
    }
    let decision: Readonly<SecurityPolicyDecision>;
    try {
      decision = await options.policy.authorize(
        principal,
        projectId,
        'secret.manage',
      );
    } catch {
      throw new ClusterModelProviderCredentialManagementUnavailableError();
    }
    if (
      decision.effect !== 'allow' ||
      decision.fence === null ||
      decision.fence.bindingVersion === null
    ) {
      throw new ClusterModelProviderCredentialManagementAuthorizationError();
    }
    return Object.freeze({ principal, decision, observedAtMs });
  };

  const commit = async (
    request:
      | Readonly<BindModelProviderCredentialRequest>
      | Readonly<RevokeModelProviderCredentialRequest>,
    action: 'bind' | 'revoke',
  ) => {
    const authority = await authorize(request.principal, request.projectId);
    let command;
    try {
      command = createModelProviderCredentialTransitionCommand({
        schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
        mutationId: request.mutationId,
        projectId: request.projectId,
        provider: request.provider,
        expectedGeneration: request.expectedGeneration,
        action,
        binding:
          action === 'bind'
            ? {
                schema: MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
                projectId: request.projectId,
                provider: request.provider,
                revision: (request as BindModelProviderCredentialRequest)
                  .revision,
                secretRef: (request as BindModelProviderCredentialRequest)
                  .secretRef,
                scheme: 'bearer',
              }
            : null,
        changedBy: authority.principal.subject,
      });
    } catch (error) {
      return mapMutationError(error);
    }
    try {
      return await options.credentials.commitAuthorized({
        command,
        actor: authority.principal.subject,
        fence: authority.decision.fence!,
        audit: {
          eventId: command.mutationId,
          requestId: request.requestId,
          operationId: modelProviderCredentialAdministrationOperationId(
            command.action,
          ),
          projectId: command.projectId,
          subject: authority.principal.subject,
          authenticationId: authority.principal.authenticationId,
          outcome: 'allowed',
          reasons: authority.decision.reasons,
          fence: authority.decision.fence,
          occurredAtMs: authority.observedAtMs,
        },
      });
    } catch (error) {
      return mapMutationError(error);
    }
  };

  return Object.freeze({
    async bind(request: Readonly<BindModelProviderCredentialRequest>) {
      normalizeBaseRequest(request, [
        'expectedGeneration',
        'mutationId',
        'principal',
        'projectId',
        'provider',
        'requestId',
        'revision',
        'secretRef',
      ]);
      if (
        typeof request.revision !== 'string' ||
        !IDENTITY_PATTERN.test(request.revision) ||
        typeof request.secretRef !== 'string'
      ) {
        throw new ClusterModelProviderCredentialManagementRequestError();
      }
      return commit(request, 'bind');
    },

    async revoke(request: Readonly<RevokeModelProviderCredentialRequest>) {
      normalizeBaseRequest(request, [
        'expectedGeneration',
        'mutationId',
        'principal',
        'projectId',
        'provider',
        'requestId',
      ]);
      return commit(request, 'revoke');
    },

    async listAudit(
      request: Readonly<ListModelProviderCredentialManagementAuditRequest>,
    ) {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        !exactKeys(
          request,
          request.before === undefined
            ? ['limit', 'principal', 'projectId', 'queryId', 'requestId']
            : [
                'before',
                'limit',
                'principal',
                'projectId',
                'queryId',
                'requestId',
              ],
        )
      ) {
        throw new ClusterModelProviderCredentialManagementRequestError();
      }
      let query;
      try {
        query = normalizeModelProviderCredentialManagementAuditQuery({
          schemaVersion: 1,
          queryId: request.queryId,
          requestId: request.requestId,
          projectId: request.projectId,
          limit: request.limit,
          ...(request.before === undefined ? {} : { before: request.before }),
        });
      } catch {
        throw new ClusterModelProviderCredentialManagementRequestError();
      }
      const authority = await authorize(request.principal, request.projectId);
      try {
        return await options.audit.listAuthorized({
          query,
          actor: authority.principal.subject,
          fence: authority.decision.fence!,
          audit: {
            eventId: request.queryId,
            requestId: request.requestId,
            operationId:
              MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_QUERY_OPERATION_ID,
            projectId: request.projectId,
            subject: authority.principal.subject,
            authenticationId: authority.principal.authenticationId,
            outcome: 'allowed',
            reasons: authority.decision.reasons,
            fence: authority.decision.fence,
            occurredAtMs: authority.observedAtMs,
          },
        });
      } catch (error) {
        return mapAuditError(error);
      }
    },

    async planTestConnection(
      request: Readonly<PlanModelProviderCredentialTestRequest>,
    ) {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        !exactKeys(request, [
          'principal',
          'projectId',
          'provider',
          'requestId',
          'testId',
        ]) ||
        typeof request.requestId !== 'string' ||
        !REQUEST_ID_PATTERN.test(request.requestId) ||
        typeof request.testId !== 'string' ||
        !UUID_PATTERN.test(request.testId) ||
        typeof request.projectId !== 'string' ||
        !IDENTITY_PATTERN.test(request.projectId) ||
        typeof request.provider !== 'string' ||
        !IDENTITY_PATTERN.test(request.provider)
      ) {
        throw new ClusterModelProviderCredentialManagementRequestError();
      }
      const authority = await authorize(request.principal, request.projectId);
      let plan;
      try {
        const endpoint = resolveModelProviderCredentialTestEndpoint(
          testAllowlist,
          request.provider,
        );
        if (
          authority.observedAtMs >
          Number.MAX_SAFE_INTEGER - testPlanLifetimeMs
        ) {
          throw new ModelProviderCredentialTestPlanUnavailableError();
        }
        plan = createModelProviderCredentialTestPlan({
          testId: request.testId,
          requestId: request.requestId,
          projectId: request.projectId,
          provider: request.provider,
          endpoint,
          requestedBy: authority.principal.subject,
          fence: authority.decision.fence!,
          plannedAtMs: authority.observedAtMs,
          expiresAtMs: authority.observedAtMs + testPlanLifetimeMs,
        });
        return await options.testPlans.createAuthorized({
          plan,
          audit: {
            eventId: plan.testId,
            requestId: plan.requestId,
            operationId: MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID,
            projectId: plan.projectId,
            subject: authority.principal.subject,
            authenticationId: authority.principal.authenticationId,
            outcome: 'allowed',
            reasons: authority.decision.reasons,
            fence: authority.decision.fence,
            occurredAtMs: authority.observedAtMs,
          },
        });
      } catch (error) {
        return mapTestPlanError(error);
      }
    },
  });
}

import {
  LocalProjectPolicyAuthorityProjectProtectedError,
  LocalProjectPolicyAuthorizationFenceConflictError,
  LocalProjectPolicyLastOwnerError,
  LocalProjectPolicyOwnerCredentialRequiredError,
  LocalProjectPolicyProjectCapacityError,
  LocalProjectPolicyProjectIdentityConflictError,
  LocalProjectPolicyProjectMutationConflictError,
  LocalProjectPolicyProjectVersionConflictError,
  MAX_LOCAL_PROJECT_QUERY_PAGE_SIZE,
  MAX_LOCAL_PROJECT_ROLE_BINDING_QUERY_PAGE_SIZE,
  type AppendAuthorizedProjectCommand,
  type AppendAuthorizedProjectResult,
  type InspectAuthorizedLocalProjectRoleBindingResult,
  type InspectAuthorizedLocalProjectResult,
  type ListAuthorizedLocalProjectRoleBindingsResult,
  type ListAuthorizedLocalProjectsResult,
  type LocalProjectRoleBindingQueryCursor,
  type LocalProjectRoleBindingQueryRole,
  type LocalProjectRoleBindingQueryState,
  type LocalProjectQueryCursor,
  type LocalProjectQueryStatus,
  type LocalProjectPolicyAdministrationRepository,
} from '@qinglong/runtime-core/local-project-policy-administration';
import {
  PROJECT_ROLES,
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
  ProjectRoleBindingMutationConflictError,
  ProjectRoleBindingVersionConflictError,
  assertExpectedProjectRoleBindingVersion,
  assertProjectPolicyProjectId,
  normalizeProjectRecord,
  normalizeProjectPolicySubject,
  type ProjectPolicyRepository,
  type ProjectRole,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
  type SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  SecurityAuditUnavailableError,
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

interface BaseLocalProjectRoleBindingAdministrationRequest {
  readonly projectId: string;
  readonly target: SecuritySubject;
  readonly expectedCurrentVersion: number;
  readonly mutationId: string;
  readonly requestId: string;
  readonly principal: SecurityPrincipal;
}

export interface PutLocalProjectRoleBindingRequest
  extends BaseLocalProjectRoleBindingAdministrationRequest {
  readonly state: 'active';
  readonly role: ProjectRole;
}

export interface RevokeLocalProjectRoleBindingRequest
  extends BaseLocalProjectRoleBindingAdministrationRequest {
  readonly state: 'revoked';
}

export type LocalProjectRoleBindingAdministrationRequest =
  | PutLocalProjectRoleBindingRequest
  | RevokeLocalProjectRoleBindingRequest;

interface BaseLocalProjectRoleBindingQueryRequest {
  readonly projectId: string;
  readonly auditEventId: string;
  readonly requestId: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectLocalProjectRoleBindingRequest
  extends BaseLocalProjectRoleBindingQueryRequest {
  readonly target: SecuritySubject;
}

export interface ListLocalProjectRoleBindingsRequest
  extends BaseLocalProjectRoleBindingQueryRequest {
  readonly limit: number;
  readonly state: LocalProjectRoleBindingQueryState;
  readonly role: LocalProjectRoleBindingQueryRole;
  readonly after?: LocalProjectRoleBindingQueryCursor;
}

interface BaseLocalProjectAdministrationRequest {
  readonly authorityProjectId: string;
  readonly projectId: string;
  readonly expectedCurrentVersion: number;
  readonly mutationId: string;
  readonly requestId: string;
  readonly principal: SecurityPrincipal;
}

export interface CreateLocalProjectRequest
  extends BaseLocalProjectAdministrationRequest {
  readonly operation: 'create';
  readonly name: string;
  readonly slug: string;
}

export interface TransitionLocalProjectRequest
  extends BaseLocalProjectAdministrationRequest {
  readonly operation: 'archive' | 'restore';
}

export type LocalProjectAdministrationRequest =
  | CreateLocalProjectRequest
  | TransitionLocalProjectRequest;

interface BaseLocalProjectQueryRequest {
  readonly authorityProjectId: string;
  readonly auditEventId: string;
  readonly requestId: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectLocalProjectRequest
  extends BaseLocalProjectQueryRequest {
  readonly projectId: string;
}

export interface ListLocalProjectsRequest extends BaseLocalProjectQueryRequest {
  readonly limit: number;
  readonly status: LocalProjectQueryStatus;
  readonly after?: LocalProjectQueryCursor;
}

export interface LocalProjectPolicyAdministrationService {
  inspectRoleBinding(
    request: InspectLocalProjectRoleBindingRequest,
  ): Promise<InspectAuthorizedLocalProjectRoleBindingResult>;
  listRoleBindings(
    request: ListLocalProjectRoleBindingsRequest,
  ): Promise<ListAuthorizedLocalProjectRoleBindingsResult>;
  inspectProject(
    request: InspectLocalProjectRequest,
  ): Promise<InspectAuthorizedLocalProjectResult>;
  listProjects(
    request: ListLocalProjectsRequest,
  ): Promise<ListAuthorizedLocalProjectsResult>;
  changeProject(
    request: LocalProjectAdministrationRequest,
  ): Promise<AppendAuthorizedProjectResult>;
  changeRoleBinding(
    request: LocalProjectRoleBindingAdministrationRequest,
  ): Promise<
    Readonly<{
      status: 'inserted' | 'existing';
      binding: Awaited<
        ReturnType<
          LocalProjectPolicyAdministrationRepository['appendAuthorizedProjectRoleBinding']
        >
      >['binding'];
    }>
  >;
}

export class LocalProjectPolicyAdministrationConfigurationError extends TypeError {
  readonly code = 'LOCAL_PROJECT_POLICY_ADMINISTRATION_INVALID';

  constructor(message: string) {
    super(`Local Project policy administration is invalid: ${message}`);
    this.name = 'LocalProjectPolicyAdministrationConfigurationError';
  }
}

export class LocalProjectPolicyAdministrationAuthenticationError extends Error {
  readonly code = 'LOCAL_PROJECT_POLICY_ADMINISTRATION_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Local Project policy administration requires a strong User');
    this.name = 'LocalProjectPolicyAdministrationAuthenticationError';
  }
}

export class LocalProjectPolicyAdministrationAuthorizationError extends Error {
  readonly code = 'LOCAL_PROJECT_POLICY_ADMINISTRATION_FORBIDDEN';

  constructor() {
    super('Local Project policy administration is not authorized');
    this.name = 'LocalProjectPolicyAdministrationAuthorizationError';
  }
}

export class LocalProjectPolicyAdministrationUnavailableError extends Error {
  readonly code = 'LOCAL_PROJECT_POLICY_ADMINISTRATION_UNAVAILABLE';

  constructor() {
    super('Local Project policy administration is unavailable');
    this.name = 'LocalProjectPolicyAdministrationUnavailableError';
  }
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

function normalizeRequest(
  request: LocalProjectRoleBindingAdministrationRequest,
): Readonly<LocalProjectRoleBindingAdministrationRequest> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'request must be an object',
    );
  }
  exactKeys(
    request,
    [
      'projectId',
      'target',
      'expectedCurrentVersion',
      'mutationId',
      'requestId',
      'principal',
      'state',
      ...(request.state === 'active' ? ['role'] : []),
    ],
    'request',
  );
  try {
    assertProjectPolicyProjectId(request.projectId);
    assertExpectedProjectRoleBindingVersion(request.expectedCurrentVersion);
  } catch {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'Project identity or expected version is invalid',
    );
  }
  let target: Readonly<SecuritySubject>;
  try {
    target = normalizeProjectPolicySubject(request.target);
  } catch {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'target subject is invalid',
    );
  }
  if (
    (request.state !== 'active' && request.state !== 'revoked') ||
    (request.state === 'active' &&
      (!PROJECT_ROLES.includes(request.role) ||
        (request.role === 'owner' && target.type !== 'user'))) ||
    typeof request.mutationId !== 'string' ||
    !UUID_V4_PATTERN.test(request.mutationId) ||
    typeof request.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(request.requestId)
  ) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'request value is invalid',
    );
  }
  return Object.freeze({ ...request, target });
}

function normalizeRoleBindingQueryRequest(
  request:
    | InspectLocalProjectRoleBindingRequest
    | ListLocalProjectRoleBindingsRequest,
  operation: 'inspect' | 'list',
): Readonly<
  InspectLocalProjectRoleBindingRequest | ListLocalProjectRoleBindingsRequest
> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'RoleBinding query request must be an object',
    );
  }
  const list = operation === 'list';
  exactKeys(
    request,
    [
      'projectId',
      ...(list ? ['limit', 'state', 'role'] : ['target']),
      ...(list &&
      (request as ListLocalProjectRoleBindingsRequest).after !== undefined
        ? ['after']
        : []),
      'auditEventId',
      'requestId',
      'principal',
    ],
    'RoleBinding query request',
  );
  try {
    assertProjectPolicyProjectId(request.projectId);
  } catch {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'RoleBinding query Project identity is invalid',
    );
  }
  if (
    typeof request.auditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(request.auditEventId) ||
    typeof request.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(request.requestId)
  ) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'RoleBinding query audit or request identity is invalid',
    );
  }
  if (!list) {
    let target: Readonly<SecuritySubject>;
    try {
      target = normalizeProjectPolicySubject(
        (request as InspectLocalProjectRoleBindingRequest).target,
      );
    } catch {
      throw new LocalProjectPolicyAdministrationConfigurationError(
        'RoleBinding query target is invalid',
      );
    }
    return Object.freeze({ ...request, target });
  }
  const query = request as ListLocalProjectRoleBindingsRequest;
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > MAX_LOCAL_PROJECT_ROLE_BINDING_QUERY_PAGE_SIZE ||
    !['active', 'revoked', 'all'].includes(query.state) ||
    !(query.role === 'all' || PROJECT_ROLES.includes(query.role))
  ) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'RoleBinding query limit or filter is invalid',
    );
  }
  let after: Readonly<LocalProjectRoleBindingQueryCursor> | undefined;
  if (query.after !== undefined) {
    if (
      !query.after ||
      typeof query.after !== 'object' ||
      Array.isArray(query.after)
    ) {
      throw new LocalProjectPolicyAdministrationConfigurationError(
        'RoleBinding query cursor is invalid',
      );
    }
    exactKeys(
      query.after,
      ['subjectType', 'subjectId'],
      'RoleBinding query cursor',
    );
    let subject: Readonly<SecuritySubject>;
    try {
      subject = normalizeProjectPolicySubject({
        type: query.after.subjectType,
        id: query.after.subjectId,
      });
    } catch {
      throw new LocalProjectPolicyAdministrationConfigurationError(
        'RoleBinding query cursor is invalid',
      );
    }
    after = Object.freeze({
      subjectType: subject.type,
      subjectId: subject.id,
    });
  }
  return Object.freeze({
    ...query,
    ...(after ? { after } : {}),
  });
}

function normalizeProjectRequest(
  request: LocalProjectAdministrationRequest,
): Readonly<LocalProjectAdministrationRequest> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'Project request must be an object',
    );
  }
  const create = request.operation === 'create';
  exactKeys(
    request,
    [
      'authorityProjectId',
      'projectId',
      'operation',
      ...(create ? ['name', 'slug'] : []),
      'expectedCurrentVersion',
      'mutationId',
      'requestId',
      'principal',
    ],
    'Project request',
  );
  try {
    assertProjectPolicyProjectId(request.authorityProjectId);
    assertProjectPolicyProjectId(request.projectId);
    assertExpectedProjectRoleBindingVersion(request.expectedCurrentVersion);
    if (create) {
      normalizeProjectRecord({
        id: request.projectId,
        name: request.name,
        slug: request.slug,
        status: 'active',
        version: 1,
        createdAtMs: 0,
        updatedAtMs: 0,
      });
    }
  } catch {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'Project identity, metadata or expected version is invalid',
    );
  }
  if (
    (request.operation !== 'create' &&
      request.operation !== 'archive' &&
      request.operation !== 'restore') ||
    (create
      ? request.expectedCurrentVersion !== 0
      : request.expectedCurrentVersion < 1) ||
    typeof request.mutationId !== 'string' ||
    !UUID_V4_PATTERN.test(request.mutationId) ||
    typeof request.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(request.requestId)
  ) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'Project request value is invalid',
    );
  }
  return Object.freeze({ ...request });
}

function normalizeProjectQueryRequest(
  request: InspectLocalProjectRequest | ListLocalProjectsRequest,
  operation: 'inspect' | 'list',
): Readonly<InspectLocalProjectRequest | ListLocalProjectsRequest> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'Project query request must be an object',
    );
  }
  const list = operation === 'list';
  exactKeys(
    request,
    [
      'authorityProjectId',
      ...(list ? ['limit', 'status'] : ['projectId']),
      ...(list && (request as ListLocalProjectsRequest).after !== undefined
        ? ['after']
        : []),
      'auditEventId',
      'requestId',
      'principal',
    ],
    'Project query request',
  );
  try {
    assertProjectPolicyProjectId(request.authorityProjectId);
    if (!list) {
      assertProjectPolicyProjectId(
        (request as InspectLocalProjectRequest).projectId,
      );
    }
  } catch {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'Project query identity is invalid',
    );
  }
  if (
    typeof request.auditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(request.auditEventId) ||
    typeof request.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(request.requestId)
  ) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'Project query audit or request identity is invalid',
    );
  }
  if (!list) return Object.freeze({ ...request });
  const query = request as ListLocalProjectsRequest;
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > MAX_LOCAL_PROJECT_QUERY_PAGE_SIZE ||
    !['active', 'archived', 'all'].includes(query.status)
  ) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'Project query limit or status is invalid',
    );
  }
  let after: Readonly<LocalProjectQueryCursor> | undefined;
  if (query.after !== undefined) {
    if (
      !query.after ||
      typeof query.after !== 'object' ||
      Array.isArray(query.after)
    ) {
      throw new LocalProjectPolicyAdministrationConfigurationError(
        'Project query cursor is invalid',
      );
    }
    exactKeys(query.after, ['slug', 'projectId'], 'Project query cursor');
    try {
      normalizeProjectRecord({
        id: query.after.projectId,
        name: 'cursor',
        slug: query.after.slug,
        status: 'active',
        version: 1,
        createdAtMs: 0,
        updatedAtMs: 0,
      });
    } catch {
      throw new LocalProjectPolicyAdministrationConfigurationError(
        'Project query cursor is invalid',
      );
    }
    after = Object.freeze({ ...query.after });
  }
  return Object.freeze({
    ...query,
    ...(after ? { after } : {}),
  });
}

function strongUser(
  value: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, nowMs);
  } catch {
    throw new LocalProjectPolicyAdministrationAuthenticationError();
  }
  if (
    principal.subject.type !== 'user' ||
    !STRONG_USER_ASSURANCES.has(principal.assurance)
  ) {
    throw new LocalProjectPolicyAdministrationAuthenticationError();
  }
  return principal;
}

function auditRecord(options: {
  readonly request: Readonly<LocalProjectRoleBindingAdministrationRequest>;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly fence: SecurityAuditRecord['fence'];
  readonly occurredAtMs: number;
}): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: options.request.mutationId,
    requestId: options.request.requestId,
    operationId:
      options.request.state === 'active'
        ? 'policy.role_binding.put'
        : 'policy.role_binding.revoke',
    projectId: options.request.projectId,
    subject: options.principal.subject,
    authenticationId: options.principal.authenticationId,
    outcome: options.outcome,
    reasons: options.reasons,
    fence: options.fence,
    occurredAtMs: options.occurredAtMs,
  });
}

function roleBindingQueryAuditRecord(options: {
  readonly request: Readonly<
    InspectLocalProjectRoleBindingRequest | ListLocalProjectRoleBindingsRequest
  >;
  readonly operation: 'inspect' | 'list';
  readonly principal: Readonly<SecurityPrincipal>;
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly fence: SecurityAuditRecord['fence'];
  readonly occurredAtMs: number;
}): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: options.request.auditEventId,
    requestId: options.request.requestId,
    operationId: `policy.role_binding.${options.operation}`,
    projectId: options.request.projectId,
    subject: options.principal.subject,
    authenticationId: options.principal.authenticationId,
    outcome: options.outcome,
    reasons: options.reasons,
    fence: options.fence,
    occurredAtMs: options.occurredAtMs,
  });
}

function projectAuditRecord(options: {
  readonly request: Readonly<LocalProjectAdministrationRequest>;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly fence: SecurityAuditRecord['fence'];
  readonly occurredAtMs: number;
}): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: options.request.mutationId,
    requestId: options.request.requestId,
    operationId: `policy.project.${options.request.operation}`,
    projectId: options.request.authorityProjectId,
    subject: options.principal.subject,
    authenticationId: options.principal.authenticationId,
    outcome: options.outcome,
    reasons: options.reasons,
    fence: options.fence,
    occurredAtMs: options.occurredAtMs,
  });
}

function projectQueryAuditRecord(options: {
  readonly request: Readonly<
    InspectLocalProjectRequest | ListLocalProjectsRequest
  >;
  readonly operation: 'inspect' | 'list';
  readonly principal: Readonly<SecurityPrincipal>;
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly fence: SecurityAuditRecord['fence'];
  readonly occurredAtMs: number;
}): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: options.request.auditEventId,
    requestId: options.request.requestId,
    operationId: `policy.project.${options.operation}`,
    projectId: options.request.authorityProjectId,
    subject: options.principal.subject,
    authenticationId: options.principal.authenticationId,
    outcome: options.outcome,
    reasons: options.reasons,
    fence: options.fence,
    occurredAtMs: options.occurredAtMs,
  });
}

export function createLocalProjectPolicyAdministrationService(
  projectPolicy: ProjectPolicyRepository,
  mutations: LocalProjectPolicyAdministrationRepository,
  options: { readonly now?: () => number } = {},
): LocalProjectPolicyAdministrationService {
  if (
    !projectPolicy ||
    typeof projectPolicy.resolve !== 'function' ||
    !mutations ||
    typeof mutations.inspectAuthorizedProjectRoleBinding !== 'function' ||
    typeof mutations.listAuthorizedProjectRoleBindings !== 'function' ||
    typeof mutations.inspectAuthorizedProject !== 'function' ||
    typeof mutations.listAuthorizedProjects !== 'function' ||
    typeof mutations.appendAuthorizedProject !== 'function' ||
    typeof mutations.appendAuthorizedProjectRoleBinding !== 'function' ||
    typeof mutations.record !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new LocalProjectPolicyAdministrationConfigurationError(
      'dependencies are invalid',
    );
  }
  const now = options.now ?? Date.now;
  const policy = new ProjectPolicyEngine(projectPolicy);

  async function authorizeRoleBindingQuery(
    request: Readonly<
      | InspectLocalProjectRoleBindingRequest
      | ListLocalProjectRoleBindingsRequest
    >,
    operation: 'inspect' | 'list',
    principal: Readonly<SecurityPrincipal>,
    occurredAtMs: number,
  ): Promise<SecurityPolicyFence> {
    let decision;
    try {
      decision = await policy.authorize(
        principal,
        request.projectId,
        'project.manage',
      );
    } catch {
      try {
        await mutations.record(
          roleBindingQueryAuditRecord({
            request,
            operation,
            principal,
            outcome: 'authorization_unavailable',
            reasons: ['policy_unavailable'],
            fence: null,
            occurredAtMs,
          }),
        );
      } catch {
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
      throw new LocalProjectPolicyAdministrationUnavailableError();
    }
    if (decision.effect !== 'allow' || !decision.fence?.bindingVersion) {
      try {
        await mutations.record(
          roleBindingQueryAuditRecord({
            request,
            operation,
            principal,
            outcome:
              decision.effect === 'require_approval'
                ? 'approval_required'
                : 'denied',
            reasons: decision.reasons,
            fence: decision.fence,
            occurredAtMs,
          }),
        );
      } catch {
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
      throw new LocalProjectPolicyAdministrationAuthorizationError();
    }
    return decision.fence;
  }

  async function authorizeProjectQuery(
    request: Readonly<InspectLocalProjectRequest | ListLocalProjectsRequest>,
    operation: 'inspect' | 'list',
    principal: Readonly<SecurityPrincipal>,
    occurredAtMs: number,
  ): Promise<SecurityPolicyFence> {
    let decision;
    try {
      decision = await policy.authorize(
        principal,
        request.authorityProjectId,
        'project.manage',
      );
    } catch {
      try {
        await mutations.record(
          projectQueryAuditRecord({
            request,
            operation,
            principal,
            outcome: 'authorization_unavailable',
            reasons: ['policy_unavailable'],
            fence: null,
            occurredAtMs,
          }),
        );
      } catch {
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
      throw new LocalProjectPolicyAdministrationUnavailableError();
    }
    if (decision.effect !== 'allow' || !decision.fence?.bindingVersion) {
      try {
        await mutations.record(
          projectQueryAuditRecord({
            request,
            operation,
            principal,
            outcome:
              decision.effect === 'require_approval'
                ? 'approval_required'
                : 'denied',
            reasons: decision.reasons,
            fence: decision.fence,
            occurredAtMs,
          }),
        );
      } catch {
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
      throw new LocalProjectPolicyAdministrationAuthorizationError();
    }
    return decision.fence;
  }

  return Object.freeze({
    async inspectRoleBinding(input: InspectLocalProjectRoleBindingRequest) {
      const request = normalizeRoleBindingQueryRequest(
        input,
        'inspect',
      ) as Readonly<InspectLocalProjectRoleBindingRequest>;
      const occurredAtMs = now();
      const principal = strongUser(request.principal, occurredAtMs);
      const fence = await authorizeRoleBindingQuery(
        request,
        'inspect',
        principal,
        occurredAtMs,
      );
      try {
        return await mutations.inspectAuthorizedProjectRoleBinding({
          target: request.target,
          authorization: {
            projectId: request.projectId,
            actor: principal.subject,
            fence,
          },
          audit: roleBindingQueryAuditRecord({
            request,
            operation: 'inspect',
            principal,
            outcome: 'allowed',
            reasons: ['project_owner_role_binding_inspect'],
            fence,
            occurredAtMs,
          }),
        });
      } catch (error) {
        if (
          error instanceof LocalProjectPolicyAuthorizationFenceConflictError
        ) {
          throw error;
        }
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
    },

    async listRoleBindings(input: ListLocalProjectRoleBindingsRequest) {
      const request = normalizeRoleBindingQueryRequest(
        input,
        'list',
      ) as Readonly<ListLocalProjectRoleBindingsRequest>;
      const occurredAtMs = now();
      const principal = strongUser(request.principal, occurredAtMs);
      const fence = await authorizeRoleBindingQuery(
        request,
        'list',
        principal,
        occurredAtMs,
      );
      try {
        return await mutations.listAuthorizedProjectRoleBindings({
          limit: request.limit,
          state: request.state,
          role: request.role,
          ...(request.after ? { after: request.after } : {}),
          authorization: {
            projectId: request.projectId,
            actor: principal.subject,
            fence,
          },
          audit: roleBindingQueryAuditRecord({
            request,
            operation: 'list',
            principal,
            outcome: 'allowed',
            reasons: ['project_owner_role_binding_list'],
            fence,
            occurredAtMs,
          }),
        });
      } catch (error) {
        if (
          error instanceof LocalProjectPolicyAuthorizationFenceConflictError
        ) {
          throw error;
        }
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
    },

    async inspectProject(input: InspectLocalProjectRequest) {
      const request = normalizeProjectQueryRequest(
        input,
        'inspect',
      ) as Readonly<InspectLocalProjectRequest>;
      const occurredAtMs = now();
      const principal = strongUser(request.principal, occurredAtMs);
      const fence = await authorizeProjectQuery(
        request,
        'inspect',
        principal,
        occurredAtMs,
      );
      try {
        return await mutations.inspectAuthorizedProject({
          projectId: request.projectId,
          authorization: {
            authorityProjectId: request.authorityProjectId,
            actor: principal.subject,
            fence,
          },
          audit: projectQueryAuditRecord({
            request,
            operation: 'inspect',
            principal,
            outcome: 'allowed',
            reasons: ['instance_authority_project_owner'],
            fence,
            occurredAtMs,
          }),
        });
      } catch (error) {
        if (
          error instanceof LocalProjectPolicyAuthorizationFenceConflictError
        ) {
          throw error;
        }
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
    },

    async listProjects(input: ListLocalProjectsRequest) {
      const request = normalizeProjectQueryRequest(
        input,
        'list',
      ) as Readonly<ListLocalProjectsRequest>;
      const occurredAtMs = now();
      const principal = strongUser(request.principal, occurredAtMs);
      const fence = await authorizeProjectQuery(
        request,
        'list',
        principal,
        occurredAtMs,
      );
      try {
        return await mutations.listAuthorizedProjects({
          limit: request.limit,
          status: request.status,
          ...(request.after ? { after: request.after } : {}),
          authorization: {
            authorityProjectId: request.authorityProjectId,
            actor: principal.subject,
            fence,
          },
          audit: projectQueryAuditRecord({
            request,
            operation: 'list',
            principal,
            outcome: 'allowed',
            reasons: ['instance_authority_project_owner'],
            fence,
            occurredAtMs,
          }),
        });
      } catch (error) {
        if (
          error instanceof LocalProjectPolicyAuthorizationFenceConflictError
        ) {
          throw error;
        }
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
    },

    async changeProject(input: LocalProjectAdministrationRequest) {
      const request = normalizeProjectRequest(input);
      const occurredAtMs = now();
      const principal = strongUser(request.principal, occurredAtMs);
      let decision;
      try {
        decision = await policy.authorize(
          principal,
          request.authorityProjectId,
          'project.manage',
        );
      } catch {
        const audit = projectAuditRecord({
          request,
          principal,
          outcome: 'authorization_unavailable',
          reasons: ['policy_unavailable'],
          fence: null,
          occurredAtMs,
        });
        try {
          await mutations.record(audit);
        } catch {
          throw new LocalProjectPolicyAdministrationUnavailableError();
        }
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
      if (decision.effect !== 'allow' || !decision.fence?.bindingVersion) {
        const audit = projectAuditRecord({
          request,
          principal,
          outcome:
            decision.effect === 'require_approval'
              ? 'approval_required'
              : 'denied',
          reasons: decision.reasons,
          fence: decision.fence,
          occurredAtMs,
        });
        try {
          await mutations.record(audit);
        } catch {
          throw new LocalProjectPolicyAdministrationUnavailableError();
        }
        throw new LocalProjectPolicyAdministrationAuthorizationError();
      }
      const audit = projectAuditRecord({
        request,
        principal,
        outcome: 'allowed',
        reasons: ['instance_authority_project_owner'],
        fence: decision.fence,
        occurredAtMs,
      });
      try {
        const base = {
          authorityProjectId: request.authorityProjectId,
          projectId: request.projectId,
          expectedCurrentVersion: request.expectedCurrentVersion,
          mutationId: request.mutationId,
          actor: principal.subject,
          fence: decision.fence,
          audit,
          occurredAtMs,
        };
        const command: AppendAuthorizedProjectCommand =
          request.operation === 'create'
            ? {
                ...base,
                operation: 'create',
                name: request.name,
                slug: request.slug,
              }
            : { ...base, operation: request.operation };
        return await mutations.appendAuthorizedProject(command);
      } catch (error) {
        if (
          error instanceof LocalProjectPolicyAuthorizationFenceConflictError ||
          error instanceof LocalProjectPolicyAuthorityProjectProtectedError ||
          error instanceof LocalProjectPolicyProjectCapacityError ||
          error instanceof LocalProjectPolicyProjectIdentityConflictError ||
          error instanceof LocalProjectPolicyProjectMutationConflictError ||
          error instanceof LocalProjectPolicyProjectVersionConflictError
        ) {
          throw error;
        }
        if (
          error instanceof ProjectPolicyUnavailableError ||
          error instanceof SecurityAuditUnavailableError
        ) {
          throw new LocalProjectPolicyAdministrationUnavailableError();
        }
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
    },

    async changeRoleBinding(
      input: LocalProjectRoleBindingAdministrationRequest,
    ) {
      const request = normalizeRequest(input);
      const occurredAtMs = now();
      const principal = strongUser(request.principal, occurredAtMs);
      let decision;
      try {
        decision = await policy.authorize(
          principal,
          request.projectId,
          'project.manage',
        );
      } catch {
        const audit = auditRecord({
          request,
          principal,
          outcome: 'authorization_unavailable',
          reasons: ['policy_unavailable'],
          fence: null,
          occurredAtMs,
        });
        try {
          await mutations.record(audit);
        } catch {
          throw new LocalProjectPolicyAdministrationUnavailableError();
        }
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
      if (decision.effect !== 'allow' || !decision.fence?.bindingVersion) {
        const audit = auditRecord({
          request,
          principal,
          outcome:
            decision.effect === 'require_approval'
              ? 'approval_required'
              : 'denied',
          reasons: decision.reasons,
          fence: decision.fence,
          occurredAtMs,
        });
        try {
          await mutations.record(audit);
        } catch {
          throw new LocalProjectPolicyAdministrationUnavailableError();
        }
        throw new LocalProjectPolicyAdministrationAuthorizationError();
      }
      const audit = auditRecord({
        request,
        principal,
        outcome: 'allowed',
        reasons: decision.reasons,
        fence: decision.fence,
        occurredAtMs,
      });
      try {
        const result = await mutations.appendAuthorizedProjectRoleBinding({
          expectedCurrentVersion: request.expectedCurrentVersion,
          binding: {
            projectId: request.projectId,
            subject: request.target,
            version: request.expectedCurrentVersion + 1,
            state: request.state,
            ...(request.state === 'active' ? { role: request.role } : {}),
            mutationId: request.mutationId,
            changedBy: principal.subject,
            createdAtMs: occurredAtMs,
          },
          actor: principal.subject,
          fence: decision.fence,
          audit,
        });
        return Object.freeze({
          status: result.status,
          binding: result.binding,
        });
      } catch (error) {
        if (
          error instanceof LocalProjectPolicyAuthorizationFenceConflictError ||
          error instanceof LocalProjectPolicyLastOwnerError ||
          error instanceof LocalProjectPolicyOwnerCredentialRequiredError ||
          error instanceof ProjectRoleBindingVersionConflictError ||
          error instanceof ProjectRoleBindingMutationConflictError
        ) {
          throw error;
        }
        if (
          error instanceof ProjectPolicyUnavailableError ||
          error instanceof SecurityAuditUnavailableError
        ) {
          throw new LocalProjectPolicyAdministrationUnavailableError();
        }
        throw new LocalProjectPolicyAdministrationUnavailableError();
      }
    },
  });
}

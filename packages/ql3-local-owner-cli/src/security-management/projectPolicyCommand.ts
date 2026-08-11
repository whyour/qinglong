// Security management owns Project lifecycle, role binding, and policy commands.
import path from 'node:path';

import {
  LocalProjectPolicyAdministrationAuthenticationError,
  LocalProjectPolicyAdministrationAuthorizationError,
  LocalProjectPolicyAdministrationUnavailableError,
  createLocalProjectPolicyAdministrationService,
  type LocalProjectAdministrationRequest,
  type ListLocalProjectRoleBindingsRequest,
  type ListLocalProjectsRequest,
  type LocalProjectPolicyAdministrationService,
} from '@qinglong/local-admin/project-policy-administration';
import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import {
  AuthenticatedLocalCommandAuthenticationError,
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';
import {
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from '@qinglong/local-sqlite/authenticated-management';
import {
  openLocalSqliteProjectPolicyAdministrationDatabase,
  type LocalSqliteProjectPolicyAdministrationDatabase,
} from '@qinglong/local-sqlite/project-policy-administration';
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
  type LocalProjectQueryCursor,
  type LocalProjectQueryStatus,
  type LocalProjectRoleBindingQueryCursor,
  type LocalProjectRoleBindingQueryRole,
  type LocalProjectRoleBindingQueryState,
} from '@qinglong/runtime-core/local-project-policy-administration';
import {
  PROJECT_ROLES,
  ProjectRoleBindingMutationConflictError,
  ProjectRoleBindingVersionConflictError,
  assertExpectedProjectRoleBindingVersion,
  assertProjectPolicyProjectId,
  normalizeProjectRecord,
  normalizeProjectPolicySubject,
  type ProjectRole,
  type ProjectStatus,
} from '@qinglong/runtime-core/project-policy';
import type { SecuritySubject } from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const MAX_PATH_BYTES = 4096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LocalProjectPolicyCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

interface BaseLocalProjectPolicyMutationRequest {
  readonly expectedCurrentVersion: number;
  readonly mutationId: string;
  readonly requestId: string;
  readonly failureAuditEventId: string;
}

interface BaseLocalProjectPolicyCommandRequest
  extends BaseLocalProjectPolicyMutationRequest {
  readonly projectId: string;
  readonly target: SecuritySubject;
}

interface BaseLocalProjectLifecycleCommandRequest
  extends BaseLocalProjectPolicyMutationRequest {
  readonly authorityProjectId: string;
  readonly projectId: string;
}

interface BaseLocalProjectQueryCommandRequest {
  readonly authorityProjectId: string;
  readonly requestId: string;
  readonly auditEventId: string;
}

interface BaseLocalProjectRoleBindingQueryCommandRequest {
  readonly projectId: string;
  readonly requestId: string;
  readonly auditEventId: string;
}

export interface PutLocalProjectRoleBindingCommand {
  readonly schemaVersion: 1;
  readonly operation: 'policy.role-binding.put';
  readonly options: LocalProjectPolicyCommandOptions;
  readonly request: BaseLocalProjectPolicyCommandRequest & {
    readonly role: ProjectRole;
  };
}

export interface RevokeLocalProjectRoleBindingCommand {
  readonly schemaVersion: 1;
  readonly operation: 'policy.role-binding.revoke';
  readonly options: LocalProjectPolicyCommandOptions;
  readonly request: BaseLocalProjectPolicyCommandRequest;
}

export interface InspectLocalProjectRoleBindingCommand {
  readonly schemaVersion: 1;
  readonly operation: 'policy.role-binding.inspect';
  readonly options: LocalProjectPolicyCommandOptions;
  readonly request: BaseLocalProjectRoleBindingQueryCommandRequest & {
    readonly target: SecuritySubject;
  };
}

export interface ListLocalProjectRoleBindingsCommand {
  readonly schemaVersion: 1;
  readonly operation: 'policy.role-binding.list';
  readonly options: LocalProjectPolicyCommandOptions;
  readonly request: BaseLocalProjectRoleBindingQueryCommandRequest & {
    readonly limit: number;
    readonly state: LocalProjectRoleBindingQueryState;
    readonly role: LocalProjectRoleBindingQueryRole;
    readonly after?: LocalProjectRoleBindingQueryCursor;
  };
}

export interface CreateLocalProjectCommand {
  readonly schemaVersion: 1;
  readonly operation: 'policy.project.create';
  readonly options: LocalProjectPolicyCommandOptions;
  readonly request: BaseLocalProjectLifecycleCommandRequest & {
    readonly name: string;
    readonly slug: string;
  };
}

export interface ArchiveLocalProjectCommand {
  readonly schemaVersion: 1;
  readonly operation: 'policy.project.archive';
  readonly options: LocalProjectPolicyCommandOptions;
  readonly request: BaseLocalProjectLifecycleCommandRequest;
}

export interface RestoreLocalProjectCommand {
  readonly schemaVersion: 1;
  readonly operation: 'policy.project.restore';
  readonly options: LocalProjectPolicyCommandOptions;
  readonly request: BaseLocalProjectLifecycleCommandRequest;
}

export interface InspectLocalProjectCommand {
  readonly schemaVersion: 1;
  readonly operation: 'policy.project.inspect';
  readonly options: LocalProjectPolicyCommandOptions;
  readonly request: BaseLocalProjectQueryCommandRequest & {
    readonly projectId: string;
  };
}

export interface ListLocalProjectsCommand {
  readonly schemaVersion: 1;
  readonly operation: 'policy.project.list';
  readonly options: LocalProjectPolicyCommandOptions;
  readonly request: BaseLocalProjectQueryCommandRequest & {
    readonly limit: number;
    readonly status: LocalProjectQueryStatus;
    readonly after?: LocalProjectQueryCursor;
  };
}

type LocalProjectLifecycleCommand =
  | CreateLocalProjectCommand
  | ArchiveLocalProjectCommand
  | RestoreLocalProjectCommand;

type LocalProjectQueryCommand =
  | InspectLocalProjectCommand
  | ListLocalProjectsCommand;

type LocalProjectRoleBindingQueryCommand =
  | InspectLocalProjectRoleBindingCommand
  | ListLocalProjectRoleBindingsCommand;

export type LocalProjectPolicyCommand =
  | PutLocalProjectRoleBindingCommand
  | RevokeLocalProjectRoleBindingCommand
  | LocalProjectRoleBindingQueryCommand
  | LocalProjectLifecycleCommand
  | LocalProjectQueryCommand;

export type LocalProjectRoleBindingCommandResult = Readonly<{
  schemaVersion: 1;
  operation:
    | PutLocalProjectRoleBindingCommand['operation']
    | RevokeLocalProjectRoleBindingCommand['operation'];
  status: 'inserted' | 'existing';
  projectId: string;
  target: Readonly<SecuritySubject>;
  version: number;
  state: 'active' | 'revoked';
  role?: ProjectRole;
}>;

export type LocalProjectRoleBindingInspectionCommandResult =
  | Readonly<{
      schemaVersion: 1;
      operation: InspectLocalProjectRoleBindingCommand['operation'];
      projectId: string;
      target: Readonly<SecuritySubject>;
      found: false;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: InspectLocalProjectRoleBindingCommand['operation'];
      projectId: string;
      target: Readonly<SecuritySubject>;
      found: true;
      version: number;
      state: 'active' | 'revoked';
      role?: ProjectRole;
      createdAtMs: number;
    }>;

export type LocalProjectRoleBindingListCommandResult = Readonly<{
  schemaVersion: 1;
  operation: ListLocalProjectRoleBindingsCommand['operation'];
  projectId: string;
  bindings: readonly Readonly<{
    target: Readonly<SecuritySubject>;
    version: number;
    state: 'active' | 'revoked';
    role?: ProjectRole;
    createdAtMs: number;
  }>[];
  nextCursor: Readonly<LocalProjectRoleBindingQueryCursor> | null;
}>;

export type LocalProjectLifecycleCommandResult = Readonly<{
  schemaVersion: 1;
  operation: LocalProjectLifecycleCommand['operation'];
  status: 'inserted' | 'existing';
  projectId: string;
  name: string;
  slug: string;
  projectStatus: ProjectStatus;
  version: number;
}>;

export type LocalProjectInspectionCommandResult =
  | Readonly<{
      schemaVersion: 1;
      operation: InspectLocalProjectCommand['operation'];
      authorityProjectId: string;
      projectId: string;
      found: false;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: InspectLocalProjectCommand['operation'];
      authorityProjectId: string;
      projectId: string;
      found: true;
      name: string;
      slug: string;
      projectStatus: ProjectStatus;
      version: number;
      createdAtMs: number;
      updatedAtMs: number;
    }>;

export type LocalProjectListCommandResult = Readonly<{
  schemaVersion: 1;
  operation: ListLocalProjectsCommand['operation'];
  authorityProjectId: string;
  projects: readonly Readonly<{
    projectId: string;
    name: string;
    slug: string;
    projectStatus: ProjectStatus;
    version: number;
    createdAtMs: number;
    updatedAtMs: number;
  }>[];
  nextCursor: Readonly<LocalProjectQueryCursor> | null;
}>;

export type LocalProjectPolicyCommandResult =
  | LocalProjectRoleBindingCommandResult
  | LocalProjectRoleBindingInspectionCommandResult
  | LocalProjectRoleBindingListCommandResult
  | LocalProjectLifecycleCommandResult
  | LocalProjectInspectionCommandResult
  | LocalProjectListCommandResult;

export interface LocalProjectPolicyCommandRunner {
  run(
    commandFilePath: string,
  ): Promise<Readonly<LocalProjectPolicyCommandResult>>;
}

export interface LocalProjectPolicyCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteProjectPolicyAdministrationDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly createService: typeof createLocalProjectPolicyAdministrationService;
  readonly now: () => number;
}

export class LocalProjectPolicyCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_PROJECT_POLICY_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Project policy command is invalid: ${message}`);
    this.name = 'LocalProjectPolicyCommandConfigurationError';
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalProjectPolicyCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LocalProjectPolicyCommandConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LocalProjectPolicyCommandConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function descendant(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalProjectPolicyCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function normalizeOptions(
  value: unknown,
): Readonly<LocalProjectPolicyCommandOptions> {
  const hasBusyTimeout =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'busyTimeoutMs');
  exactObject(
    value,
    [
      'deploymentRoot',
      'databasePath',
      'profile',
      'ownerPepperKeyringDirectory',
      'credentialFilePath',
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    'options',
  );
  const deploymentRoot = boundedPath(value.deploymentRoot, 'deploymentRoot');
  for (const key of [
    'databasePath',
    'ownerPepperKeyringDirectory',
    'credentialFilePath',
  ] as const) {
    descendant(deploymentRoot, boundedPath(value[key], key), key);
  }
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LocalProjectPolicyCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalProjectPolicyCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  return Object.freeze(value as unknown as LocalProjectPolicyCommandOptions);
}

function isProjectLifecycleOperation(
  operation: LocalProjectPolicyCommand['operation'],
): operation is LocalProjectLifecycleCommand['operation'] {
  return (
    operation === 'policy.project.create' ||
    operation === 'policy.project.archive' ||
    operation === 'policy.project.restore'
  );
}

function isProjectQueryOperation(
  operation: LocalProjectPolicyCommand['operation'],
): operation is LocalProjectQueryCommand['operation'] {
  return (
    operation === 'policy.project.inspect' ||
    operation === 'policy.project.list'
  );
}

function isRoleBindingQueryOperation(
  operation: LocalProjectPolicyCommand['operation'],
): operation is LocalProjectRoleBindingQueryCommand['operation'] {
  return (
    operation === 'policy.role-binding.inspect' ||
    operation === 'policy.role-binding.list'
  );
}

function isProjectLifecycleCommand(
  command: Readonly<LocalProjectPolicyCommand>,
): command is Readonly<LocalProjectLifecycleCommand> {
  return isProjectLifecycleOperation(command.operation);
}

function isProjectQueryCommand(
  command: Readonly<LocalProjectPolicyCommand>,
): command is Readonly<LocalProjectQueryCommand> {
  return isProjectQueryOperation(command.operation);
}

function normalizeRequest(
  value: unknown,
  operation: LocalProjectPolicyCommand['operation'],
): LocalProjectPolicyCommand['request'] {
  const projectLifecycle = isProjectLifecycleOperation(operation);
  const projectQuery = isProjectQueryOperation(operation);
  const roleBindingQuery = isRoleBindingQueryOperation(operation);
  const query = projectQuery || roleBindingQuery;
  const projectList = operation === 'policy.project.list';
  const roleBindingList = operation === 'policy.role-binding.list';
  const createProject = operation === 'policy.project.create';
  exactObject(
    value,
    [
      ...(projectLifecycle || projectQuery ? ['authorityProjectId'] : []),
      ...(!projectList ? ['projectId'] : []),
      ...(!projectLifecycle && !projectQuery && !roleBindingList
        ? ['target']
        : []),
      ...(createProject ? ['name', 'slug'] : []),
      ...(projectList ? ['limit', 'status'] : []),
      ...(roleBindingList ? ['limit', 'state', 'role'] : []),
      ...((projectList || roleBindingList) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(value, 'after')
        ? ['after']
        : []),
      ...(query
        ? ['auditEventId']
        : ['expectedCurrentVersion', 'mutationId', 'failureAuditEventId']),
      'requestId',
      ...(operation === 'policy.role-binding.put' ? ['role'] : []),
    ],
    'request',
  );
  try {
    if (!projectList) {
      assertProjectPolicyProjectId(value.projectId as string);
    }
    if (projectLifecycle || projectQuery) {
      assertProjectPolicyProjectId(value.authorityProjectId as string);
    }
    if (!query) {
      assertExpectedProjectRoleBindingVersion(
        value.expectedCurrentVersion as number,
      );
    }
    if (projectLifecycle) {
      if (
        (createProject && value.expectedCurrentVersion !== 0) ||
        (!createProject && (value.expectedCurrentVersion as number) < 1)
      ) {
        throw new TypeError('Project version transition is invalid');
      }
      if (createProject) {
        normalizeProjectRecord({
          id: value.projectId as string,
          name: value.name as string,
          slug: value.slug as string,
          status: 'active',
          version: 1,
          createdAtMs: 0,
          updatedAtMs: 0,
        });
      }
    } else if (!projectQuery && !roleBindingList) {
      normalizeProjectPolicySubject(value.target as SecuritySubject);
    }
  } catch (error) {
    throw new LocalProjectPolicyCommandConfigurationError(
      'Project, subject, metadata or expected version is invalid',
      error,
    );
  }
  if (query) {
    if (
      typeof value.auditEventId !== 'string' ||
      !UUID_V4_PATTERN.test(value.auditEventId) ||
      typeof value.requestId !== 'string' ||
      !REQUEST_ID_PATTERN.test(value.requestId)
    ) {
      throw new LocalProjectPolicyCommandConfigurationError(
        'Project query audit or request identity is invalid',
      );
    }
    if (projectList) {
      if (
        !Number.isSafeInteger(value.limit) ||
        (value.limit as number) < 1 ||
        (value.limit as number) > MAX_LOCAL_PROJECT_QUERY_PAGE_SIZE ||
        !['active', 'archived', 'all'].includes(value.status as string)
      ) {
        throw new LocalProjectPolicyCommandConfigurationError(
          'Project list limit or status is invalid',
        );
      }
      if (value.after !== undefined) {
        exactObject(value.after, ['slug', 'projectId'], 'Project list cursor');
        try {
          normalizeProjectRecord({
            id: value.after.projectId as string,
            name: 'cursor',
            slug: value.after.slug as string,
            status: 'active',
            version: 1,
            createdAtMs: 0,
            updatedAtMs: 0,
          });
        } catch (error) {
          throw new LocalProjectPolicyCommandConfigurationError(
            'Project list cursor is invalid',
            error,
          );
        }
      }
    }
    if (roleBindingList) {
      if (
        !Number.isSafeInteger(value.limit) ||
        (value.limit as number) < 1 ||
        (value.limit as number) >
          MAX_LOCAL_PROJECT_ROLE_BINDING_QUERY_PAGE_SIZE ||
        !['active', 'revoked', 'all'].includes(value.state as string) ||
        !(
          value.role === 'all' ||
          PROJECT_ROLES.includes(value.role as ProjectRole)
        )
      ) {
        throw new LocalProjectPolicyCommandConfigurationError(
          'RoleBinding list limit or filter is invalid',
        );
      }
      if (value.after !== undefined) {
        exactObject(
          value.after,
          ['subjectType', 'subjectId'],
          'RoleBinding list cursor',
        );
        try {
          normalizeProjectPolicySubject({
            type: value.after.subjectType as SecuritySubject['type'],
            id: value.after.subjectId as string,
          });
        } catch (error) {
          throw new LocalProjectPolicyCommandConfigurationError(
            'RoleBinding list cursor is invalid',
            error,
          );
        }
      }
    }
    return Object.freeze(
      value as unknown as LocalProjectPolicyCommand['request'],
    );
  }
  if (
    (operation === 'policy.role-binding.put' &&
      (!PROJECT_ROLES.includes(value.role as ProjectRole) ||
        (value.role === 'owner' &&
          (value.target as SecuritySubject).type !== 'user'))) ||
    typeof value.mutationId !== 'string' ||
    !UUID_V4_PATTERN.test(value.mutationId) ||
    typeof value.failureAuditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.failureAuditEventId) ||
    value.failureAuditEventId === value.mutationId ||
    typeof value.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.requestId)
  ) {
    throw new LocalProjectPolicyCommandConfigurationError(
      'request value is invalid',
    );
  }
  return Object.freeze(
    value as unknown as LocalProjectPolicyCommand['request'],
  );
}

function normalizeCommand(value: unknown): Readonly<LocalProjectPolicyCommand> {
  exactObject(
    value,
    ['schemaVersion', 'operation', 'options', 'request'],
    'command',
  );
  if (
    value.schemaVersion !== 1 ||
    (value.operation !== 'policy.role-binding.put' &&
      value.operation !== 'policy.role-binding.revoke' &&
      value.operation !== 'policy.role-binding.inspect' &&
      value.operation !== 'policy.role-binding.list' &&
      value.operation !== 'policy.project.create' &&
      value.operation !== 'policy.project.archive' &&
      value.operation !== 'policy.project.restore' &&
      value.operation !== 'policy.project.inspect' &&
      value.operation !== 'policy.project.list')
  ) {
    throw new LocalProjectPolicyCommandConfigurationError(
      'command version or operation is invalid',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: value.operation,
    options: normalizeOptions(value.options),
    request: normalizeRequest(value.request, value.operation),
  } as LocalProjectPolicyCommand);
}

function readCommandFile(
  candidatePath: string,
): Readonly<LocalProjectPolicyCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalProjectPolicyCommandConfigurationError) {
      throw error;
    }
    throw new LocalProjectPolicyCommandConfigurationError(
      'command file cannot be read',
      error,
    );
  }
}

function failureAudit(
  command: Readonly<LocalProjectPolicyCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> | null {
  if (
    error instanceof LocalProjectPolicyAdministrationAuthenticationError ||
    error instanceof LocalProjectPolicyAdministrationAuthorizationError ||
    error instanceof LocalProjectPolicyAdministrationUnavailableError
  ) {
    return null;
  }
  let outcome: SecurityAuditRecord['outcome'];
  let reason: string;
  if (
    !authenticated ||
    error instanceof AuthenticatedLocalCommandAuthenticationError
  ) {
    outcome = 'authentication_rejected';
    reason = 'credential_rejected';
  } else if (
    error instanceof LocalSqliteAuthenticatedManagementFenceError ||
    error instanceof LocalProjectPolicyAuthorizationFenceConflictError
  ) {
    outcome = 'denied';
    reason = 'credential_or_policy_fence_rejected';
  } else if (error instanceof LocalProjectPolicyLastOwnerError) {
    outcome = 'denied';
    reason = 'last_owner_required';
  } else if (error instanceof LocalProjectPolicyOwnerCredentialRequiredError) {
    outcome = 'denied';
    reason = 'owner_credential_required';
  } else if (
    error instanceof LocalProjectPolicyAuthorityProjectProtectedError
  ) {
    outcome = 'denied';
    reason = 'authority_project_protected';
  } else if (error instanceof LocalProjectPolicyProjectCapacityError) {
    outcome = 'denied';
    reason = 'project_capacity_exceeded';
  } else if (error instanceof LocalProjectPolicyProjectIdentityConflictError) {
    outcome = 'denied';
    reason = 'project_identity_conflict';
  } else if (error instanceof LocalProjectPolicyProjectVersionConflictError) {
    outcome = 'denied';
    reason = 'current_version_conflict';
  } else if (error instanceof LocalProjectPolicyProjectMutationConflictError) {
    outcome = 'denied';
    reason = 'mutation_conflict';
  } else if (error instanceof ProjectRoleBindingVersionConflictError) {
    outcome = 'denied';
    reason = 'current_version_conflict';
  } else if (error instanceof ProjectRoleBindingMutationConflictError) {
    outcome = 'denied';
    reason = 'mutation_conflict';
  } else {
    return null;
  }
  return Object.freeze({
    eventId:
      'failureAuditEventId' in command.request
        ? command.request.failureAuditEventId
        : command.request.auditEventId,
    requestId: command.request.requestId,
    operationId:
      isProjectLifecycleOperation(command.operation) ||
      isProjectQueryOperation(command.operation)
        ? command.operation
        : command.operation === 'policy.role-binding.inspect'
        ? 'policy.role_binding.inspect'
        : command.operation === 'policy.role-binding.list'
        ? 'policy.role_binding.list'
        : command.operation === 'policy.role-binding.put'
        ? 'policy.role_binding.put'
        : 'policy.role_binding.revoke',
    projectId:
      isProjectLifecycleCommand(command) || isProjectQueryCommand(command)
        ? command.request.authorityProjectId
        : command.request.projectId,
    subject: authenticated?.principal.subject ?? null,
    authenticationId: authenticated?.principal.authenticationId ?? null,
    outcome,
    reasons: Object.freeze([reason]),
    fence: null,
    occurredAtMs,
  });
}

function dependencies(
  value: LocalProjectPolicyCommandRunnerDependencies,
): Readonly<LocalProjectPolicyCommandRunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['authenticate', 'createService', 'now', 'openDatabase']
        .sort()
        .join('\0') ||
    typeof value.openDatabase !== 'function' ||
    typeof value.authenticate !== 'function' ||
    typeof value.createService !== 'function' ||
    typeof value.now !== 'function'
  ) {
    throw new LocalProjectPolicyCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

async function activateFence(
  database: LocalSqliteProjectPolicyAdministrationDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
): Promise<void> {
  await authenticated.confirm();
  database.activateUserCredentialFence(
    authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  );
}

export function createLocalProjectPolicyCommandRunner(
  candidateDependencies: LocalProjectPolicyCommandRunnerDependencies = {
    openDatabase: openLocalSqliteProjectPolicyAdministrationDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    createService: createLocalProjectPolicyAdministrationService,
    now: Date.now,
  },
): LocalProjectPolicyCommandRunner {
  const adapters = dependencies(candidateDependencies);
  return Object.freeze({
    async run(commandFilePath: string) {
      const command = readCommandFile(commandFilePath);
      const database = await adapters.openDatabase({
        databasePath: command.options.databasePath,
        profile: command.options.profile,
        ...(command.options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: command.options.busyTimeoutMs }),
      });
      let authenticated: Readonly<AuthenticatedLocalCommand> | undefined;
      try {
        try {
          authenticated = await adapters.authenticate(database, {
            deploymentRoot: command.options.deploymentRoot,
            databasePath: command.options.databasePath,
            ownerPepperKeyringDirectory:
              command.options.ownerPepperKeyringDirectory,
            credentialFilePath: command.options.credentialFilePath,
            authenticationNamespace: 'local_policy',
          });
          await activateFence(database, authenticated);
          const service: LocalProjectPolicyAdministrationService =
            adapters.createService(
              database.projectPolicy,
              database.projectPolicyAdministration,
              { now: adapters.now },
            );
          if (command.operation === 'policy.role-binding.inspect') {
            const result = await service.inspectRoleBinding({
              projectId: command.request.projectId,
              target: command.request.target,
              auditEventId: command.request.auditEventId,
              requestId: command.request.requestId,
              principal: authenticated.principal,
            });
            if (!result.binding) {
              return Object.freeze({
                schemaVersion: 1 as const,
                operation: command.operation,
                projectId: command.request.projectId,
                target: command.request.target,
                found: false as const,
              });
            }
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              projectId: result.binding.projectId,
              target: result.binding.subject,
              found: true as const,
              version: result.binding.version,
              state: result.binding.state,
              ...(result.binding.role ? { role: result.binding.role } : {}),
              createdAtMs: result.binding.createdAtMs,
            });
          }
          if (command.operation === 'policy.role-binding.list') {
            const request: ListLocalProjectRoleBindingsRequest = {
              projectId: command.request.projectId,
              limit: command.request.limit,
              state: command.request.state,
              role: command.request.role,
              ...(command.request.after
                ? { after: command.request.after }
                : {}),
              auditEventId: command.request.auditEventId,
              requestId: command.request.requestId,
              principal: authenticated.principal,
            };
            const result = await service.listRoleBindings(request);
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              projectId: command.request.projectId,
              bindings: Object.freeze(
                result.bindings.map((binding) =>
                  Object.freeze({
                    target: binding.subject,
                    version: binding.version,
                    state: binding.state,
                    ...(binding.role ? { role: binding.role } : {}),
                    createdAtMs: binding.createdAtMs,
                  }),
                ),
              ),
              nextCursor: result.nextCursor,
            });
          }
          if (command.operation === 'policy.project.inspect') {
            const result = await service.inspectProject({
              authorityProjectId: command.request.authorityProjectId,
              projectId: command.request.projectId,
              auditEventId: command.request.auditEventId,
              requestId: command.request.requestId,
              principal: authenticated.principal,
            });
            if (!result.project) {
              return Object.freeze({
                schemaVersion: 1 as const,
                operation: command.operation,
                authorityProjectId: command.request.authorityProjectId,
                projectId: command.request.projectId,
                found: false as const,
              });
            }
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              authorityProjectId: command.request.authorityProjectId,
              projectId: result.project.id,
              found: true as const,
              name: result.project.name,
              slug: result.project.slug,
              projectStatus: result.project.status,
              version: result.project.version,
              createdAtMs: result.project.createdAtMs,
              updatedAtMs: result.project.updatedAtMs,
            });
          }
          if (command.operation === 'policy.project.list') {
            const request: ListLocalProjectsRequest = {
              authorityProjectId: command.request.authorityProjectId,
              limit: command.request.limit,
              status: command.request.status,
              ...(command.request.after
                ? { after: command.request.after }
                : {}),
              auditEventId: command.request.auditEventId,
              requestId: command.request.requestId,
              principal: authenticated.principal,
            };
            const result = await service.listProjects(request);
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              authorityProjectId: command.request.authorityProjectId,
              projects: Object.freeze(
                result.projects.map((project) =>
                  Object.freeze({
                    projectId: project.id,
                    name: project.name,
                    slug: project.slug,
                    projectStatus: project.status,
                    version: project.version,
                    createdAtMs: project.createdAtMs,
                    updatedAtMs: project.updatedAtMs,
                  }),
                ),
              ),
              nextCursor: result.nextCursor,
            });
          }
          if (isProjectLifecycleCommand(command)) {
            const base = {
              authorityProjectId: command.request.authorityProjectId,
              projectId: command.request.projectId,
              expectedCurrentVersion: command.request.expectedCurrentVersion,
              mutationId: command.request.mutationId,
              requestId: command.request.requestId,
              principal: authenticated.principal,
            };
            const request: LocalProjectAdministrationRequest =
              command.operation === 'policy.project.create'
                ? {
                    ...base,
                    operation: 'create',
                    name: command.request.name,
                    slug: command.request.slug,
                  }
                : {
                    ...base,
                    operation:
                      command.operation === 'policy.project.archive'
                        ? 'archive'
                        : 'restore',
                  };
            const result = await service.changeProject(request);
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              status: result.status,
              projectId: result.project.id,
              name: result.project.name,
              slug: result.project.slug,
              projectStatus: result.project.status,
              version: result.project.version,
            });
          }
          const result = await service.changeRoleBinding({
            projectId: command.request.projectId,
            target: command.request.target,
            expectedCurrentVersion: command.request.expectedCurrentVersion,
            mutationId: command.request.mutationId,
            requestId: command.request.requestId,
            principal: authenticated.principal,
            ...(command.operation === 'policy.role-binding.put'
              ? { state: 'active' as const, role: command.request.role }
              : { state: 'revoked' as const }),
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            projectId: result.binding.projectId,
            target: result.binding.subject,
            version: result.binding.version,
            state: result.binding.state,
            ...(result.binding.role ? { role: result.binding.role } : {}),
          });
        } catch (error) {
          const audit = failureAudit(
            command,
            authenticated,
            error,
            adapters.now(),
          );
          if (audit) await database.securityAudit.record(audit);
          throw error;
        }
      } finally {
        await database.close();
      }
    },
  });
}

export function runLocalProjectPolicyCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalProjectPolicyCommandResult>> {
  return createLocalProjectPolicyCommandRunner().run(commandFilePath);
}

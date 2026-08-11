import type {
  AppendProjectRoleBindingResult,
  ProjectRecord,
  ProjectRole,
  ProjectRoleBindingRecord,
  ProjectRoleBindingState,
  ProjectStatus,
} from './projectPolicy';
import type { SecurityPolicyFence, SecuritySubject } from '../security';
import type {
  SecurityAuditRecord,
  SecurityAuditSink,
} from '../audit/securityAudit';

export const MAX_LOCAL_PROJECT_QUERY_PAGE_SIZE = 64;
export const MAX_LOCAL_PROJECT_ROLE_BINDING_QUERY_PAGE_SIZE = 64;

export interface LocalProjectQueryCursor {
  readonly slug: string;
  readonly projectId: string;
}

export type LocalProjectQueryStatus = ProjectStatus | 'all';

export interface LocalProjectAdministrationAuthorization {
  readonly authorityProjectId: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
}

export interface InspectAuthorizedLocalProjectCommand {
  readonly projectId: string;
  readonly authorization: LocalProjectAdministrationAuthorization;
  readonly audit: SecurityAuditRecord;
}

export interface InspectAuthorizedLocalProjectResult {
  readonly project: Readonly<ProjectRecord> | null;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface ListAuthorizedLocalProjectsCommand {
  readonly limit: number;
  readonly status: LocalProjectQueryStatus;
  readonly after?: LocalProjectQueryCursor;
  readonly authorization: LocalProjectAdministrationAuthorization;
  readonly audit: SecurityAuditRecord;
}

export interface ListAuthorizedLocalProjectsResult {
  readonly projects: readonly Readonly<ProjectRecord>[];
  readonly nextCursor: Readonly<LocalProjectQueryCursor> | null;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface LocalProjectRoleBindingQueryCursor {
  readonly subjectType: SecuritySubject['type'];
  readonly subjectId: string;
}

export type LocalProjectRoleBindingQueryState = ProjectRoleBindingState | 'all';
export type LocalProjectRoleBindingQueryRole = ProjectRole | 'all';

export interface LocalProjectRoleBindingAdministrationAuthorization {
  readonly projectId: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
}

export interface InspectAuthorizedLocalProjectRoleBindingCommand {
  readonly target: SecuritySubject;
  readonly authorization: LocalProjectRoleBindingAdministrationAuthorization;
  readonly audit: SecurityAuditRecord;
}

export interface InspectAuthorizedLocalProjectRoleBindingResult {
  readonly binding: Readonly<ProjectRoleBindingRecord> | null;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface ListAuthorizedLocalProjectRoleBindingsCommand {
  readonly limit: number;
  readonly state: LocalProjectRoleBindingQueryState;
  readonly role: LocalProjectRoleBindingQueryRole;
  readonly after?: LocalProjectRoleBindingQueryCursor;
  readonly authorization: LocalProjectRoleBindingAdministrationAuthorization;
  readonly audit: SecurityAuditRecord;
}

export interface ListAuthorizedLocalProjectRoleBindingsResult {
  readonly bindings: readonly Readonly<ProjectRoleBindingRecord>[];
  readonly nextCursor: Readonly<LocalProjectRoleBindingQueryCursor> | null;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface AppendAuthorizedProjectRoleBindingCommand {
  readonly expectedCurrentVersion: number;
  readonly binding: ProjectRoleBindingRecord;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface AppendAuthorizedProjectRoleBindingResult
  extends AppendProjectRoleBindingResult {
  readonly audit: Readonly<SecurityAuditRecord>;
}

export type LocalProjectAdministrationOperation =
  | 'create'
  | 'archive'
  | 'restore';

export interface LocalProjectAdministrationMutationRecord {
  readonly mutationId: string;
  readonly operation: LocalProjectAdministrationOperation;
  readonly authorityProjectId: string;
  readonly project: Readonly<ProjectRecord>;
  readonly expectedPreviousVersion: number;
  readonly changedBy: SecuritySubject;
  readonly createdAtMs: number;
}

interface AppendAuthorizedProjectBaseCommand {
  readonly authorityProjectId: string;
  readonly projectId: string;
  readonly expectedCurrentVersion: number;
  readonly mutationId: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
  readonly occurredAtMs: number;
}

export interface AppendAuthorizedProjectCreateCommand
  extends AppendAuthorizedProjectBaseCommand {
  readonly operation: 'create';
  readonly name: string;
  readonly slug: string;
}

export interface AppendAuthorizedProjectTransitionCommand
  extends AppendAuthorizedProjectBaseCommand {
  readonly operation: 'archive' | 'restore';
}

export type AppendAuthorizedProjectCommand =
  | AppendAuthorizedProjectCreateCommand
  | AppendAuthorizedProjectTransitionCommand;

export interface AppendAuthorizedProjectResult {
  readonly status: 'inserted' | 'existing';
  readonly project: Readonly<ProjectRecord>;
  readonly mutation: Readonly<LocalProjectAdministrationMutationRecord>;
  readonly initialOwnerBinding: Readonly<ProjectRoleBindingRecord> | null;
  readonly audit: Readonly<SecurityAuditRecord>;
}

/**
 * Short-lived policy administration authority. Implementations must revalidate
 * the actor's Project/RoleBinding fence and atomically commit each query or
 * mutation with its audit record.
 */
export interface LocalProjectPolicyAdministrationRepository
  extends SecurityAuditSink {
  inspectAuthorizedProjectRoleBinding(
    command: InspectAuthorizedLocalProjectRoleBindingCommand,
  ): Promise<InspectAuthorizedLocalProjectRoleBindingResult>;
  listAuthorizedProjectRoleBindings(
    command: ListAuthorizedLocalProjectRoleBindingsCommand,
  ): Promise<ListAuthorizedLocalProjectRoleBindingsResult>;
  inspectAuthorizedProject(
    command: InspectAuthorizedLocalProjectCommand,
  ): Promise<InspectAuthorizedLocalProjectResult>;
  listAuthorizedProjects(
    command: ListAuthorizedLocalProjectsCommand,
  ): Promise<ListAuthorizedLocalProjectsResult>;
  appendAuthorizedProject(
    command: AppendAuthorizedProjectCommand,
  ): Promise<AppendAuthorizedProjectResult>;
  appendAuthorizedProjectRoleBinding(
    command: AppendAuthorizedProjectRoleBindingCommand,
  ): Promise<AppendAuthorizedProjectRoleBindingResult>;
}

export class LocalProjectPolicyAuthorizationFenceConflictError extends Error {
  readonly code = 'LOCAL_PROJECT_POLICY_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super('Local Project policy authorization changed');
    this.name = 'LocalProjectPolicyAuthorizationFenceConflictError';
  }
}

export class LocalProjectPolicyLastOwnerError extends Error {
  readonly code = 'LOCAL_PROJECT_POLICY_LAST_OWNER';

  constructor() {
    super('Local Project must retain at least one active User owner');
    this.name = 'LocalProjectPolicyLastOwnerError';
  }
}

export class LocalProjectPolicyOwnerCredentialRequiredError extends Error {
  readonly code = 'LOCAL_PROJECT_POLICY_OWNER_CREDENTIAL_REQUIRED';

  constructor() {
    super('A new Local Project owner must have an active credential');
    this.name = 'LocalProjectPolicyOwnerCredentialRequiredError';
  }
}

export class LocalProjectPolicyProjectVersionConflictError extends Error {
  readonly code = 'LOCAL_PROJECT_POLICY_PROJECT_VERSION_CONFLICT';

  constructor() {
    super('Local Project current version changed');
    this.name = 'LocalProjectPolicyProjectVersionConflictError';
  }
}

export class LocalProjectPolicyProjectMutationConflictError extends Error {
  readonly code = 'LOCAL_PROJECT_POLICY_PROJECT_MUTATION_CONFLICT';

  constructor() {
    super('Local Project mutation conflicts with its previous request');
    this.name = 'LocalProjectPolicyProjectMutationConflictError';
  }
}

export class LocalProjectPolicyProjectIdentityConflictError extends Error {
  readonly code = 'LOCAL_PROJECT_POLICY_PROJECT_IDENTITY_CONFLICT';

  constructor() {
    super('Local Project identity or slug is already in use');
    this.name = 'LocalProjectPolicyProjectIdentityConflictError';
  }
}

export class LocalProjectPolicyProjectCapacityError extends Error {
  readonly code = 'LOCAL_PROJECT_POLICY_PROJECT_CAPACITY_EXCEEDED';

  constructor() {
    super('Local Project capacity is exhausted');
    this.name = 'LocalProjectPolicyProjectCapacityError';
  }
}

export class LocalProjectPolicyAuthorityProjectProtectedError extends Error {
  readonly code = 'LOCAL_PROJECT_POLICY_AUTHORITY_PROJECT_PROTECTED';

  constructor() {
    super('Local instance authority Project cannot be archived');
    this.name = 'LocalProjectPolicyAuthorityProjectProtectedError';
  }
}

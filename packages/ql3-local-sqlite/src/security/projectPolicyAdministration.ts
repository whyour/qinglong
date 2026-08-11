import type { ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
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
  type AppendAuthorizedProjectRoleBindingCommand,
  type AppendAuthorizedProjectRoleBindingResult,
  type InspectAuthorizedLocalProjectRoleBindingCommand,
  type InspectAuthorizedLocalProjectRoleBindingResult,
  type InspectAuthorizedLocalProjectCommand,
  type InspectAuthorizedLocalProjectResult,
  type ListAuthorizedLocalProjectRoleBindingsCommand,
  type ListAuthorizedLocalProjectRoleBindingsResult,
  type ListAuthorizedLocalProjectsCommand,
  type ListAuthorizedLocalProjectsResult,
  type LocalProjectAdministrationAuthorization,
  type LocalProjectAdministrationMutationRecord,
  type LocalProjectQueryCursor,
  type LocalProjectRoleBindingAdministrationAuthorization,
  type LocalProjectRoleBindingQueryCursor,
  type LocalProjectPolicyAdministrationRepository,
} from '@qinglong/runtime-core/local-project-policy-administration';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';
import {
  InvalidProjectPolicyValueError,
  PROJECT_ROLES,
  ProjectPolicyUnavailableError,
  ProjectRoleBindingMutationConflictError,
  ProjectRoleBindingVersionConflictError,
  assertExpectedProjectRoleBindingVersion,
  assertProjectPolicyProjectId,
  normalizeProjectRecord,
  normalizeProjectRoleBinding,
  normalizeProjectPolicySubject,
  type ProjectPolicyRepository,
  type ProjectRecord,
  type ProjectRoleBindingRecord,
} from '@qinglong/runtime-core/project-policy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  SecurityAuditUnavailableError,
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';

import { LocalSqliteApiCredentialRepository } from './apiCredentialRepository';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../storage/config';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteOwnerPepperRepository } from '../local-owner/ownerPepperRepository';
import {
  confirmLocalSqliteAuthenticatedUserCredentialFence,
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from '../administration/packageManagement';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';
import { resolveLocalInstanceAuthorityProjectId } from '../authority/instanceAuthorityProject';
import {
  insertLocalSecurityAudit,
  LOCAL_ROLE_BINDING_SELECT,
  LOCAL_SECURITY_AUDIT_JOIN_SELECT,
  LOCAL_SECURITY_AUDIT_SELECT,
  localRoleBindingFromRow,
  localSecurityAuditFromRow,
  sameSecurityAuditSemantic,
} from './securityPersistence';
import { LocalSqliteSecurityAuthorityStore } from './securityAuthorityStore';

type Row = Record<string, unknown>;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EDGE_PROJECT_CAPACITY = 16;
const STANDALONE_PROJECT_CAPACITY = 128;

const PROJECT_MUTATION_SELECT = `
  mutation."mutation_id" AS "projectMutationId",
  mutation."operation" AS "projectOperation",
  mutation."authority_project_id" AS "authorityProjectId",
  mutation."project_id" AS "targetProjectId",
  mutation."project_name" AS "projectName",
  mutation."project_slug" AS "projectSlug",
  mutation."project_status" AS "projectStatus",
  mutation."project_version" AS "projectVersion",
  mutation."expected_previous_version" AS "expectedPreviousVersion",
  mutation."changed_by_type" AS "projectChangedByType",
  mutation."changed_by_id" AS "projectChangedById",
  mutation."project_created_at_ms" AS "projectCreatedAtMs",
  mutation."created_at_ms" AS "projectMutationCreatedAtMs"
`;

const CURRENT_PROJECT_SELECT = `
  "id" AS "currentProjectId",
  "name" AS "currentProjectName",
  "slug" AS "currentProjectSlug",
  "status" AS "currentProjectStatus",
  "version" AS "currentProjectVersion",
  "created_at_ms" AS "currentProjectCreatedAtMs",
  "updated_at_ms" AS "currentProjectUpdatedAtMs"
`;

const CURRENT_ROLE_BINDING_SELECT = `
  binding."project_id" AS "projectId",
  binding."subject_type" AS "subjectType",
  binding."subject_id" AS "subjectId",
  binding."version" AS "version",
  binding."state" AS "state",
  binding."role" AS "role",
  binding."mutation_id" AS "mutationId",
  binding."changed_by_type" AS "changedByType",
  binding."changed_by_id" AS "changedById",
  binding."created_at_ms" AS "createdAtMs"
`;

function exactFence(value: SecurityPolicyFence): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'bindingVersion,projectVersion' ||
    !Number.isSafeInteger(value.projectVersion) ||
    value.projectVersion < 1 ||
    !Number.isSafeInteger(value.bindingVersion) ||
    (value.bindingVersion as number) < 1
  ) {
    throw new InvalidProjectPolicyValueError('authorization fence is invalid');
  }
}

function integer(row: Row | undefined, key: string): number {
  const value = row?.[key];
  if (!Number.isSafeInteger(value)) throw new ProjectPolicyUnavailableError();
  return value as number;
}

function text(row: Row | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== 'string') throw new ProjectPolicyUnavailableError();
  return value;
}

function projectFromMutationRow(row: Row): Readonly<ProjectRecord> {
  return normalizeProjectRecord({
    id: text(row, 'targetProjectId'),
    name: text(row, 'projectName'),
    slug: text(row, 'projectSlug'),
    status: text(row, 'projectStatus') as ProjectRecord['status'],
    version: integer(row, 'projectVersion'),
    createdAtMs: integer(row, 'projectCreatedAtMs'),
    updatedAtMs: integer(row, 'projectMutationCreatedAtMs'),
  });
}

function projectFromCurrentRow(row: Row): Readonly<ProjectRecord> {
  return normalizeProjectRecord({
    id: text(row, 'currentProjectId'),
    name: text(row, 'currentProjectName'),
    slug: text(row, 'currentProjectSlug'),
    status: text(row, 'currentProjectStatus') as ProjectRecord['status'],
    version: integer(row, 'currentProjectVersion'),
    createdAtMs: integer(row, 'currentProjectCreatedAtMs'),
    updatedAtMs: integer(row, 'currentProjectUpdatedAtMs'),
  });
}

function projectMutationFromRow(
  row: Row,
): Readonly<LocalProjectAdministrationMutationRecord> {
  return Object.freeze({
    mutationId: text(row, 'projectMutationId'),
    operation: text(
      row,
      'projectOperation',
    ) as LocalProjectAdministrationMutationRecord['operation'],
    authorityProjectId: text(row, 'authorityProjectId'),
    project: projectFromMutationRow(row),
    expectedPreviousVersion: integer(row, 'expectedPreviousVersion'),
    changedBy: Object.freeze({
      type: text(
        row,
        'projectChangedByType',
      ) as LocalProjectAdministrationMutationRecord['changedBy']['type'],
      id: text(row, 'projectChangedById'),
    }),
    createdAtMs: integer(row, 'projectMutationCreatedAtMs'),
  });
}

function sameBindingSemantic(
  left: Readonly<ProjectRoleBindingRecord>,
  right: Readonly<ProjectRoleBindingRecord>,
): boolean {
  const { createdAtMs: _leftTime, ...leftSemantic } = left;
  const { createdAtMs: _rightTime, ...rightSemantic } = right;
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}

function assertCommand(
  command: AppendAuthorizedProjectRoleBindingCommand,
): Readonly<{
  expectedCurrentVersion: number;
  binding: Readonly<ProjectRoleBindingRecord>;
  actor: ReturnType<typeof normalizeProjectPolicySubject>;
  fence: SecurityPolicyFence;
  audit: Readonly<SecurityAuditRecord>;
}> {
  assertExpectedProjectRoleBindingVersion(command.expectedCurrentVersion);
  const binding = normalizeProjectRoleBinding(command.binding);
  const actor = normalizeProjectPolicySubject(command.actor);
  const audit = normalizeSecurityAuditRecord(command.audit);
  exactFence(command.fence);
  if (
    binding.version !== command.expectedCurrentVersion + 1 ||
    binding.changedBy.type !== actor.type ||
    binding.changedBy.id !== actor.id ||
    (binding.role === 'owner' && binding.subject.type !== 'user') ||
    audit.eventId !== binding.mutationId ||
    audit.operationId !==
      (binding.state === 'active'
        ? 'policy.role_binding.put'
        : 'policy.role_binding.revoke') ||
    audit.projectId !== binding.projectId ||
    audit.subject?.type !== actor.type ||
    audit.subject?.id !== actor.id ||
    audit.outcome !== 'allowed' ||
    audit.fence?.projectVersion !== command.fence.projectVersion ||
    audit.fence.bindingVersion !== command.fence.bindingVersion
  ) {
    throw new InvalidProjectPolicyValueError(
      'authorized role binding command is inconsistent',
    );
  }
  return Object.freeze({
    expectedCurrentVersion: command.expectedCurrentVersion,
    binding,
    actor,
    fence: command.fence,
    audit,
  });
}

function assertProjectCommand(
  command: AppendAuthorizedProjectCommand,
): Readonly<AppendAuthorizedProjectCommand> {
  try {
    assertProjectPolicyProjectId(command.authorityProjectId);
    assertProjectPolicyProjectId(command.projectId);
    assertExpectedProjectRoleBindingVersion(command.expectedCurrentVersion);
  } catch {
    throw new InvalidProjectPolicyValueError(
      'authorized Project identity or version is invalid',
    );
  }
  const actor = normalizeProjectPolicySubject(command.actor);
  const audit = normalizeSecurityAuditRecord(command.audit);
  exactFence(command.fence);
  if (
    actor.type !== 'user' ||
    (command.operation !== 'create' &&
      command.operation !== 'archive' &&
      command.operation !== 'restore') ||
    (command.operation === 'create'
      ? command.expectedCurrentVersion !== 0
      : command.expectedCurrentVersion < 1) ||
    typeof command.mutationId !== 'string' ||
    !UUID_V4_PATTERN.test(command.mutationId) ||
    !Number.isSafeInteger(command.occurredAtMs) ||
    command.occurredAtMs < 0 ||
    audit.eventId !== command.mutationId ||
    audit.operationId !== `policy.project.${command.operation}` ||
    audit.projectId !== command.authorityProjectId ||
    audit.subject?.type !== actor.type ||
    audit.subject?.id !== actor.id ||
    audit.outcome !== 'allowed' ||
    audit.fence?.projectVersion !== command.fence.projectVersion ||
    audit.fence.bindingVersion !== command.fence.bindingVersion
  ) {
    throw new InvalidProjectPolicyValueError(
      'authorized Project command is inconsistent',
    );
  }
  if (command.operation === 'create') {
    normalizeProjectRecord({
      id: command.projectId,
      name: command.name,
      slug: command.slug,
      status: 'active',
      version: 1,
      createdAtMs: command.occurredAtMs,
      updatedAtMs: command.occurredAtMs,
    });
  }
  return Object.freeze({
    ...command,
    actor,
    audit,
    fence: Object.freeze({ ...command.fence }),
  }) as Readonly<AppendAuthorizedProjectCommand>;
}

function projectAdministrationAuthorization(
  value: LocalProjectAdministrationAuthorization,
): Readonly<LocalProjectAdministrationAuthorization> {
  try {
    assertProjectPolicyProjectId(value.authorityProjectId);
  } catch {
    throw new InvalidProjectPolicyValueError(
      'Project administration authority identity is invalid',
    );
  }
  const actor = normalizeProjectPolicySubject(value.actor);
  exactFence(value.fence);
  if (actor.type !== 'user') {
    throw new InvalidProjectPolicyValueError(
      'Project administration authority actor is invalid',
    );
  }
  return Object.freeze({
    authorityProjectId: value.authorityProjectId,
    actor,
    fence: Object.freeze({ ...value.fence }),
  });
}

function projectQueryAudit(
  value: SecurityAuditRecord,
  operation: 'inspect' | 'list',
  authorization: Readonly<LocalProjectAdministrationAuthorization>,
): Readonly<SecurityAuditRecord> {
  const audit = normalizeSecurityAuditRecord(value);
  if (
    audit.operationId !== `policy.project.${operation}` ||
    audit.projectId !== authorization.authorityProjectId ||
    audit.subject?.type !== authorization.actor.type ||
    audit.subject?.id !== authorization.actor.id ||
    audit.outcome !== 'allowed' ||
    audit.fence?.projectVersion !== authorization.fence.projectVersion ||
    audit.fence?.bindingVersion !== authorization.fence.bindingVersion
  ) {
    throw new InvalidProjectPolicyValueError(
      'authorized Project query audit is inconsistent',
    );
  }
  return audit;
}

function projectQueryCursor(
  value: LocalProjectQueryCursor,
): Readonly<LocalProjectQueryCursor> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectPolicyValueError('Project query cursor is invalid');
  }
  if (Object.keys(value).sort().join(',') !== 'projectId,slug') {
    throw new InvalidProjectPolicyValueError(
      'Project query cursor shape is invalid',
    );
  }
  try {
    normalizeProjectRecord({
      id: value.projectId,
      name: 'cursor',
      slug: value.slug,
      status: 'active',
      version: 1,
      createdAtMs: 0,
      updatedAtMs: 0,
    });
  } catch {
    throw new InvalidProjectPolicyValueError(
      'Project query cursor value is invalid',
    );
  }
  return Object.freeze({ ...value });
}

function roleBindingAdministrationAuthorization(
  value: LocalProjectRoleBindingAdministrationAuthorization,
): Readonly<LocalProjectRoleBindingAdministrationAuthorization> {
  try {
    assertProjectPolicyProjectId(value.projectId);
  } catch {
    throw new InvalidProjectPolicyValueError(
      'RoleBinding administration Project identity is invalid',
    );
  }
  const actor = normalizeProjectPolicySubject(value.actor);
  exactFence(value.fence);
  if (actor.type !== 'user') {
    throw new InvalidProjectPolicyValueError(
      'RoleBinding administration actor is invalid',
    );
  }
  return Object.freeze({
    projectId: value.projectId,
    actor,
    fence: Object.freeze({ ...value.fence }),
  });
}

function roleBindingQueryAudit(
  value: SecurityAuditRecord,
  operation: 'inspect' | 'list',
  authorization: Readonly<LocalProjectRoleBindingAdministrationAuthorization>,
): Readonly<SecurityAuditRecord> {
  const audit = normalizeSecurityAuditRecord(value);
  if (
    audit.operationId !== `policy.role_binding.${operation}` ||
    audit.projectId !== authorization.projectId ||
    audit.subject?.type !== authorization.actor.type ||
    audit.subject?.id !== authorization.actor.id ||
    audit.outcome !== 'allowed' ||
    audit.fence?.projectVersion !== authorization.fence.projectVersion ||
    audit.fence?.bindingVersion !== authorization.fence.bindingVersion
  ) {
    throw new InvalidProjectPolicyValueError(
      'authorized RoleBinding query audit is inconsistent',
    );
  }
  return audit;
}

function roleBindingQueryCursor(
  value: LocalProjectRoleBindingQueryCursor,
): Readonly<LocalProjectRoleBindingQueryCursor> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectPolicyValueError(
      'RoleBinding query cursor is invalid',
    );
  }
  if (Object.keys(value).sort().join(',') !== 'subjectId,subjectType') {
    throw new InvalidProjectPolicyValueError(
      'RoleBinding query cursor shape is invalid',
    );
  }
  let subject: Readonly<SecuritySubject>;
  try {
    subject = normalizeProjectPolicySubject({
      type: value.subjectType,
      id: value.subjectId,
    });
  } catch {
    throw new InvalidProjectPolicyValueError(
      'RoleBinding query cursor value is invalid',
    );
  }
  return Object.freeze({
    subjectType: subject.type,
    subjectId: subject.id,
  });
}

function sameProjectMutationSemantic(
  existing: Readonly<LocalProjectAdministrationMutationRecord>,
  command: Readonly<AppendAuthorizedProjectCommand>,
): boolean {
  return (
    existing.mutationId === command.mutationId &&
    existing.operation === command.operation &&
    existing.authorityProjectId === command.authorityProjectId &&
    existing.project.id === command.projectId &&
    existing.expectedPreviousVersion === command.expectedCurrentVersion &&
    existing.changedBy.type === command.actor.type &&
    existing.changedBy.id === command.actor.id &&
    (command.operation !== 'create' ||
      (existing.project.name === command.name &&
        existing.project.slug === command.slug &&
        existing.project.status === 'active' &&
        existing.project.version === 1))
  );
}

function assertProjectOwnerAuthorizationInTransaction(
  authority: LocalSqliteOperationAuthority,
  authorization: Readonly<LocalProjectRoleBindingAdministrationAuthorization>,
  beforeMutation: () => void,
): void {
  try {
    beforeMutation();
  } catch {
    throw new LocalProjectPolicyAuthorizationFenceConflictError();
  }
  const project = authority.client
    .prepare(
      `SELECT "status" AS "status", "version" AS "version"
       FROM "QingLong3Projects" WHERE "id" = ?`,
    )
    .get(authorization.projectId) as Row | undefined;
  const actorRow = authority.client
    .prepare(
      `SELECT ${LOCAL_ROLE_BINDING_SELECT}
       FROM "QingLong3ProjectRoleBindings"
       WHERE "project_id" = ? AND "subject_type" = ?
         AND "subject_id" = ?
       ORDER BY "version" DESC LIMIT 1`,
    )
    .get(
      authorization.projectId,
      authorization.actor.type,
      authorization.actor.id,
    ) as Row | undefined;
  if (
    !project ||
    project.status !== 'active' ||
    integer(project, 'version') !== authorization.fence.projectVersion ||
    !actorRow
  ) {
    throw new LocalProjectPolicyAuthorizationFenceConflictError();
  }
  const binding = localRoleBindingFromRow(actorRow);
  if (
    binding.version !== authorization.fence.bindingVersion ||
    binding.state !== 'active' ||
    binding.role !== 'owner'
  ) {
    throw new LocalProjectPolicyAuthorizationFenceConflictError();
  }
}

function assertInstanceAuthorityInTransaction(
  authority: LocalSqliteOperationAuthority,
  authorization: Readonly<LocalProjectAdministrationAuthorization>,
  beforeMutation: () => void,
): void {
  try {
    beforeMutation();
  } catch {
    throw new LocalProjectPolicyAuthorizationFenceConflictError();
  }
  const client = authority.client;
  if (
    resolveLocalInstanceAuthorityProjectId(client) !==
    authorization.authorityProjectId
  ) {
    throw new LocalProjectPolicyAuthorizationFenceConflictError();
  }
  const project = client
    .prepare(
      `SELECT "status" AS "status", "version" AS "version"
       FROM "QingLong3Projects"
       WHERE "id" = ?`,
    )
    .get(authorization.authorityProjectId) as Row | undefined;
  const actorRow = client
    .prepare(
      `SELECT ${LOCAL_ROLE_BINDING_SELECT}
       FROM "QingLong3ProjectRoleBindings"
       WHERE "project_id" = ? AND "subject_type" = ?
         AND "subject_id" = ?
       ORDER BY "version" DESC LIMIT 1`,
    )
    .get(
      authorization.authorityProjectId,
      authorization.actor.type,
      authorization.actor.id,
    ) as Row | undefined;
  if (
    !project ||
    project.status !== 'active' ||
    integer(project, 'version') !== authorization.fence.projectVersion ||
    !actorRow
  ) {
    throw new LocalProjectPolicyAuthorizationFenceConflictError();
  }
  const binding = localRoleBindingFromRow(actorRow);
  if (
    binding.version !== authorization.fence.bindingVersion ||
    binding.state !== 'active' ||
    binding.role !== 'owner'
  ) {
    throw new LocalProjectPolicyAuthorizationFenceConflictError();
  }
}

export class LocalSqliteProjectPolicyAdministrationRepository
  implements LocalProjectPolicyAdministrationRepository
{
  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    private readonly beforeMutation: () => void,
    private readonly maxProjects: number,
  ) {
    if (
      !(authority instanceof LocalSqliteOperationAuthority) ||
      typeof beforeMutation !== 'function' ||
      !Number.isSafeInteger(maxProjects) ||
      maxProjects < 1
    ) {
      throw new TypeError(
        'Local SQLite Project policy administration dependencies are invalid',
      );
    }
  }

  record(value: SecurityAuditRecord): Promise<void> {
    return new LocalSqliteSecurityAuthorityStore(this.authority).record(value);
  }

  inspectAuthorizedProjectRoleBinding(
    input: InspectAuthorizedLocalProjectRoleBindingCommand,
  ): Promise<InspectAuthorizedLocalProjectRoleBindingResult> {
    const target = normalizeProjectPolicySubject(input.target);
    const authorization = roleBindingAdministrationAuthorization(
      input.authorization,
    );
    const audit = roleBindingQueryAudit(input.audit, 'inspect', authorization);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          assertProjectOwnerAuthorizationInTransaction(
            this.authority,
            authorization,
            this.beforeMutation,
          );
          const row = client
            .prepare(
              `SELECT ${LOCAL_ROLE_BINDING_SELECT}
               FROM "QingLong3ProjectRoleBindings"
               WHERE "project_id" = ? AND "subject_type" = ?
                 AND "subject_id" = ?
               ORDER BY "version" DESC
               LIMIT 1`,
            )
            .get(authorization.projectId, target.type, target.id) as
            | Row
            | undefined;
          insertLocalSecurityAudit(client, audit);
          client.exec('COMMIT');
          return Object.freeze({
            binding: row ? localRoleBindingFromRow(row) : null,
            audit,
          });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (
            error instanceof LocalProjectPolicyAuthorizationFenceConflictError
          ) {
            throw error;
          }
          if (error instanceof SecurityAuditUnavailableError) throw error;
          throw new ProjectPolicyUnavailableError();
        }
      },
      () => new ProjectPolicyUnavailableError(),
    );
  }

  listAuthorizedProjectRoleBindings(
    input: ListAuthorizedLocalProjectRoleBindingsCommand,
  ): Promise<ListAuthorizedLocalProjectRoleBindingsResult> {
    const authorization = roleBindingAdministrationAuthorization(
      input.authorization,
    );
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_LOCAL_PROJECT_ROLE_BINDING_QUERY_PAGE_SIZE ||
      !['active', 'revoked', 'all'].includes(input.state) ||
      !(input.role === 'all' || PROJECT_ROLES.includes(input.role))
    ) {
      throw new InvalidProjectPolicyValueError(
        'RoleBinding list query is invalid',
      );
    }
    const after = input.after ? roleBindingQueryCursor(input.after) : undefined;
    const audit = roleBindingQueryAudit(input.audit, 'list', authorization);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          assertProjectOwnerAuthorizationInTransaction(
            this.authority,
            authorization,
            this.beforeMutation,
          );
          const rows = client
            .prepare(
              `SELECT ${CURRENT_ROLE_BINDING_SELECT}
               FROM "QingLong3ProjectRoleBindings" AS binding
               WHERE binding."project_id" = ?
                 AND binding."version" = (
                   SELECT max(latest."version")
                   FROM "QingLong3ProjectRoleBindings" AS latest
                   WHERE latest."project_id" = binding."project_id"
                     AND latest."subject_type" = binding."subject_type"
                     AND latest."subject_id" = binding."subject_id"
                 )
                 AND (? = 'all' OR binding."state" = ?)
                 AND (? = 'all' OR binding."role" = ?)
                 AND (
                   ? IS NULL OR binding."subject_type" > ?
                   OR (
                     binding."subject_type" = ?
                     AND binding."subject_id" > ?
                   )
                 )
               ORDER BY binding."subject_type" ASC,
                        binding."subject_id" ASC
               LIMIT ?`,
            )
            .all(
              authorization.projectId,
              input.state,
              input.state,
              input.role,
              input.role,
              after?.subjectType ?? null,
              after?.subjectType ?? null,
              after?.subjectType ?? null,
              after?.subjectId ?? null,
              input.limit + 1,
            ) as Row[];
          const hasMore = rows.length > input.limit;
          const bindings = Object.freeze(
            rows
              .slice(0, input.limit)
              .map((row) => localRoleBindingFromRow(row)),
          );
          const last = bindings.at(-1);
          insertLocalSecurityAudit(client, audit);
          client.exec('COMMIT');
          return Object.freeze({
            bindings,
            nextCursor:
              hasMore && last
                ? Object.freeze({
                    subjectType: last.subject.type,
                    subjectId: last.subject.id,
                  })
                : null,
            audit,
          });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (
            error instanceof LocalProjectPolicyAuthorizationFenceConflictError
          ) {
            throw error;
          }
          if (error instanceof SecurityAuditUnavailableError) throw error;
          throw new ProjectPolicyUnavailableError();
        }
      },
      () => new ProjectPolicyUnavailableError(),
    );
  }

  inspectAuthorizedProject(
    input: InspectAuthorizedLocalProjectCommand,
  ): Promise<InspectAuthorizedLocalProjectResult> {
    let projectId: string;
    try {
      assertProjectPolicyProjectId(input.projectId);
      projectId = input.projectId;
    } catch {
      throw new InvalidProjectPolicyValueError(
        'Project inspection identity is invalid',
      );
    }
    const authorization = projectAdministrationAuthorization(
      input.authorization,
    );
    const audit = projectQueryAudit(input.audit, 'inspect', authorization);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          assertInstanceAuthorityInTransaction(
            this.authority,
            authorization,
            this.beforeMutation,
          );
          const row = client
            .prepare(
              `SELECT ${CURRENT_PROJECT_SELECT}
               FROM "QingLong3Projects"
               WHERE "id" = ?`,
            )
            .get(projectId) as Row | undefined;
          insertLocalSecurityAudit(client, audit);
          client.exec('COMMIT');
          return Object.freeze({
            project: row ? projectFromCurrentRow(row) : null,
            audit,
          });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (
            error instanceof LocalProjectPolicyAuthorizationFenceConflictError
          ) {
            throw error;
          }
          if (error instanceof SecurityAuditUnavailableError) throw error;
          throw new ProjectPolicyUnavailableError();
        }
      },
      () => new ProjectPolicyUnavailableError(),
    );
  }

  listAuthorizedProjects(
    input: ListAuthorizedLocalProjectsCommand,
  ): Promise<ListAuthorizedLocalProjectsResult> {
    const authorization = projectAdministrationAuthorization(
      input.authorization,
    );
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_LOCAL_PROJECT_QUERY_PAGE_SIZE ||
      !['active', 'archived', 'all'].includes(input.status)
    ) {
      throw new InvalidProjectPolicyValueError('Project list query is invalid');
    }
    const after = input.after ? projectQueryCursor(input.after) : undefined;
    const audit = projectQueryAudit(input.audit, 'list', authorization);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          assertInstanceAuthorityInTransaction(
            this.authority,
            authorization,
            this.beforeMutation,
          );
          const rows = client
            .prepare(
              `SELECT ${CURRENT_PROJECT_SELECT}
               FROM "QingLong3Projects"
               WHERE (? = 'all' OR "status" = ?)
                 AND (
                   ? IS NULL OR "slug" > ?
                   OR ("slug" = ? AND "id" > ?)
                 )
               ORDER BY "slug" ASC, "id" ASC
               LIMIT ?`,
            )
            .all(
              input.status,
              input.status,
              after?.slug ?? null,
              after?.slug ?? null,
              after?.slug ?? null,
              after?.projectId ?? null,
              input.limit + 1,
            ) as Row[];
          const hasMore = rows.length > input.limit;
          const projects = Object.freeze(
            rows.slice(0, input.limit).map((row) => projectFromCurrentRow(row)),
          );
          const last = projects.at(-1);
          insertLocalSecurityAudit(client, audit);
          client.exec('COMMIT');
          return Object.freeze({
            projects,
            nextCursor:
              hasMore && last
                ? Object.freeze({
                    slug: last.slug,
                    projectId: last.id,
                  })
                : null,
            audit,
          });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (
            error instanceof LocalProjectPolicyAuthorizationFenceConflictError
          ) {
            throw error;
          }
          if (error instanceof SecurityAuditUnavailableError) throw error;
          throw new ProjectPolicyUnavailableError();
        }
      },
      () => new ProjectPolicyUnavailableError(),
    );
  }

  appendAuthorizedProject(
    input: AppendAuthorizedProjectCommand,
  ): Promise<AppendAuthorizedProjectResult> {
    const command = assertProjectCommand(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          assertInstanceAuthorityInTransaction(
            this.authority,
            command,
            this.beforeMutation,
          );
          const replayRow = client
            .prepare(
              `SELECT ${PROJECT_MUTATION_SELECT},
                      ${LOCAL_SECURITY_AUDIT_JOIN_SELECT}
               FROM "QingLong3ProjectAdministrationMutations" AS mutation
               JOIN "QingLong3SecurityAuditEvents" AS audit
                 ON audit."event_id" = mutation."audit_event_id"
               WHERE mutation."mutation_id" = ?`,
            )
            .get(command.mutationId) as Row | undefined;
          if (replayRow) {
            const mutation = projectMutationFromRow(replayRow);
            const audit = localSecurityAuditFromRow(replayRow);
            if (
              !sameProjectMutationSemantic(mutation, command) ||
              !sameSecurityAuditSemantic(audit, command.audit)
            ) {
              throw new LocalProjectPolicyProjectMutationConflictError();
            }
            const initialOwnerBinding =
              mutation.operation === 'create'
                ? normalizeProjectRoleBinding({
                    projectId: mutation.project.id,
                    subject: mutation.changedBy,
                    version: 1,
                    state: 'active',
                    role: 'owner',
                    mutationId: mutation.mutationId,
                    changedBy: mutation.changedBy,
                    createdAtMs: mutation.createdAtMs,
                  })
                : null;
            client.exec('COMMIT');
            return Object.freeze({
              status: 'existing' as const,
              project: mutation.project,
              mutation,
              initialOwnerBinding,
              audit,
            });
          }

          let project: Readonly<ProjectRecord>;
          let initialOwnerBinding: Readonly<ProjectRoleBindingRecord> | null =
            null;
          if (command.operation === 'create') {
            const conflict = client
              .prepare(
                `SELECT 1 AS "present"
                 FROM "QingLong3Projects"
                 WHERE "id" = ? OR "slug" = ?
                 LIMIT 1`,
              )
              .get(command.projectId, command.slug);
            if (conflict) {
              throw new LocalProjectPolicyProjectIdentityConflictError();
            }
            const count = client
              .prepare(
                `SELECT count(*) AS "count"
                 FROM "QingLong3Projects"`,
              )
              .get() as Row | undefined;
            if (integer(count, 'count') >= this.maxProjects) {
              throw new LocalProjectPolicyProjectCapacityError();
            }
            project = normalizeProjectRecord({
              id: command.projectId,
              name: command.name,
              slug: command.slug,
              status: 'active',
              version: 1,
              createdAtMs: command.occurredAtMs,
              updatedAtMs: command.occurredAtMs,
            });
            initialOwnerBinding = normalizeProjectRoleBinding({
              projectId: project.id,
              subject: command.actor,
              version: 1,
              state: 'active',
              role: 'owner',
              mutationId: command.mutationId,
              changedBy: command.actor,
              createdAtMs: command.occurredAtMs,
            });
            client
              .prepare(
                `INSERT INTO "QingLong3Projects" (
                   "id", "name", "slug", "status", "version",
                   "created_at_ms", "updated_at_ms"
                 ) VALUES (?, ?, ?, 'active', 1, ?, ?)`,
              )
              .run(
                project.id,
                project.name,
                project.slug,
                project.createdAtMs,
                project.updatedAtMs,
              );
            client
              .prepare(
                `INSERT INTO "QingLong3ProjectRoleBindings" (
                   "project_id", "subject_type", "subject_id", "version",
                   "state", "role", "mutation_id", "changed_by_type",
                   "changed_by_id", "created_at_ms"
                 ) VALUES (?, ?, ?, 1, 'active', 'owner', ?, ?, ?, ?)`,
              )
              .run(
                project.id,
                command.actor.type,
                command.actor.id,
                command.mutationId,
                command.actor.type,
                command.actor.id,
                command.occurredAtMs,
              );
          } else {
            if (
              command.operation === 'archive' &&
              command.projectId === command.authorityProjectId
            ) {
              throw new LocalProjectPolicyAuthorityProjectProtectedError();
            }
            const currentRow = client
              .prepare(
                `SELECT "id" AS "currentProjectId",
                        "name" AS "currentProjectName",
                        "slug" AS "currentProjectSlug",
                        "status" AS "currentProjectStatus",
                        "version" AS "currentProjectVersion",
                        "created_at_ms" AS "currentProjectCreatedAtMs",
                        "updated_at_ms" AS "currentProjectUpdatedAtMs"
                 FROM "QingLong3Projects"
                 WHERE "id" = ?`,
              )
              .get(command.projectId) as Row | undefined;
            if (!currentRow) {
              throw new LocalProjectPolicyProjectVersionConflictError();
            }
            const current = projectFromCurrentRow(currentRow);
            const expectedStatus =
              command.operation === 'archive' ? 'active' : 'archived';
            if (
              current.version !== command.expectedCurrentVersion ||
              current.status !== expectedStatus
            ) {
              throw new LocalProjectPolicyProjectVersionConflictError();
            }
            project = normalizeProjectRecord({
              ...current,
              status: command.operation === 'archive' ? 'archived' : 'active',
              version: current.version + 1,
              updatedAtMs: command.occurredAtMs,
            });
            const updated = client
              .prepare(
                `UPDATE "QingLong3Projects"
                 SET "status" = ?, "version" = ?, "updated_at_ms" = ?
                 WHERE "id" = ? AND "version" = ? AND "status" = ?`,
              )
              .run(
                project.status,
                project.version,
                project.updatedAtMs,
                project.id,
                current.version,
                current.status,
              );
            if (updated.changes !== 1) {
              throw new LocalProjectPolicyProjectVersionConflictError();
            }
          }

          insertLocalSecurityAudit(client, command.audit);
          client
            .prepare(
              `INSERT INTO "QingLong3ProjectAdministrationMutations" (
                 "mutation_id", "operation", "authority_project_id",
                 "project_id", "project_name", "project_slug",
                 "project_status", "project_version",
                 "expected_previous_version", "changed_by_type",
                 "changed_by_id", "initial_owner_binding_version",
                 "audit_event_id", "project_created_at_ms", "created_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.mutationId,
              command.operation,
              command.authorityProjectId,
              project.id,
              project.name,
              project.slug,
              project.status,
              project.version,
              command.expectedCurrentVersion,
              command.actor.type,
              command.actor.id,
              initialOwnerBinding?.version ?? null,
              command.audit.eventId,
              project.createdAtMs,
              command.occurredAtMs,
            );
          const mutation = Object.freeze({
            mutationId: command.mutationId,
            operation: command.operation,
            authorityProjectId: command.authorityProjectId,
            project,
            expectedPreviousVersion: command.expectedCurrentVersion,
            changedBy: command.actor,
            createdAtMs: command.occurredAtMs,
          });
          client.exec('COMMIT');
          return Object.freeze({
            status: 'inserted' as const,
            project,
            mutation,
            initialOwnerBinding,
            audit: command.audit,
          });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (
            error instanceof
              LocalProjectPolicyAuthorizationFenceConflictError ||
            error instanceof LocalProjectPolicyAuthorityProjectProtectedError ||
            error instanceof LocalProjectPolicyProjectCapacityError ||
            error instanceof LocalProjectPolicyProjectIdentityConflictError ||
            error instanceof LocalProjectPolicyProjectMutationConflictError ||
            error instanceof LocalProjectPolicyProjectVersionConflictError ||
            error instanceof InvalidProjectPolicyValueError
          ) {
            throw error;
          }
          if (error instanceof SecurityAuditUnavailableError) throw error;
          throw new ProjectPolicyUnavailableError();
        }
      },
      () => new ProjectPolicyUnavailableError(),
    );
  }

  appendAuthorizedProjectRoleBinding(
    input: AppendAuthorizedProjectRoleBindingCommand,
  ): Promise<AppendAuthorizedProjectRoleBindingResult> {
    const command = assertCommand(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          assertProjectOwnerAuthorizationInTransaction(
            this.authority,
            {
              projectId: command.binding.projectId,
              actor: command.actor,
              fence: command.fence,
            },
            this.beforeMutation,
          );

          const replayRow = client
            .prepare(
              `SELECT ${LOCAL_ROLE_BINDING_SELECT}
               FROM "QingLong3ProjectRoleBindings"
               WHERE "project_id" = ? AND "subject_type" = ?
                 AND "subject_id" = ? AND "mutation_id" = ?
               LIMIT 1`,
            )
            .get(
              command.binding.projectId,
              command.binding.subject.type,
              command.binding.subject.id,
              command.binding.mutationId,
            ) as Row | undefined;
          if (replayRow) {
            const existing = localRoleBindingFromRow(replayRow);
            const auditRow = client
              .prepare(
                `SELECT ${LOCAL_SECURITY_AUDIT_SELECT}
                 FROM "QingLong3SecurityAuditEvents"
                 WHERE "event_id" = ? LIMIT 1`,
              )
              .get(command.audit.eventId) as Row | undefined;
            if (
              !sameBindingSemantic(existing, command.binding) ||
              !auditRow ||
              !sameSecurityAuditSemantic(
                localSecurityAuditFromRow(auditRow),
                command.audit,
              )
            ) {
              throw new ProjectRoleBindingMutationConflictError();
            }
            client.exec('COMMIT');
            return Object.freeze({
              status: 'existing' as const,
              binding: existing,
              audit: localSecurityAuditFromRow(auditRow),
            });
          }

          const currentRow = client
            .prepare(
              `SELECT ${LOCAL_ROLE_BINDING_SELECT}
               FROM "QingLong3ProjectRoleBindings"
               WHERE "project_id" = ? AND "subject_type" = ?
                 AND "subject_id" = ?
               ORDER BY "version" DESC LIMIT 1`,
            )
            .get(
              command.binding.projectId,
              command.binding.subject.type,
              command.binding.subject.id,
            ) as Row | undefined;
          const current = currentRow
            ? localRoleBindingFromRow(currentRow)
            : null;
          if ((current?.version ?? 0) !== command.expectedCurrentVersion) {
            throw new ProjectRoleBindingVersionConflictError();
          }

          if (
            command.binding.state === 'active' &&
            command.binding.role === 'owner'
          ) {
            const ownerCredential = client
              .prepare(
                `SELECT credential."credential_id" AS "credentialId"
                 FROM "QingLong3IdentitySubjects" AS identity
                 JOIN "QingLong3ApiCredentials" AS credential
                   ON credential."subject_type" = identity."subject_type"
                  AND credential."subject_id" = identity."subject_id"
                 JOIN "QingLong3ApiCredentialPepperBindings" AS key_binding
                   ON key_binding."credential_id" = credential."credential_id"
                  AND key_binding."credential_version" = credential."version"
                 JOIN "QingLong3LocalOwnerPepperKeys" AS pepper
                   ON pepper."pepper_key_id" = key_binding."pepper_key_id"
                 WHERE identity."subject_type" = 'user'
                   AND identity."subject_id" = ?
                   AND identity."status" = 'active'
                   AND credential."state" = 'active'
                   AND CAST(unixepoch('subsec') * 1000 AS INTEGER)
                       >= credential."not_before_at_ms"
                   AND CAST(unixepoch('subsec') * 1000 AS INTEGER)
                       < credential."expires_at_ms"
                   AND pepper."state" IN ('active', 'retired')
                 LIMIT 1`,
              )
              .get(command.binding.subject.id) as Row | undefined;
            if (!ownerCredential) {
              throw new LocalProjectPolicyOwnerCredentialRequiredError();
            }
          }

          if (
            current?.state === 'active' &&
            current.role === 'owner' &&
            current.subject.type === 'user' &&
            !(
              command.binding.state === 'active' &&
              command.binding.role === 'owner'
            )
          ) {
            const ownerCount = client
              .prepare(
                `SELECT count(*) AS "count"
                 FROM "QingLong3ProjectRoleBindings" AS binding
                 WHERE binding."project_id" = ?
                   AND binding."subject_type" = 'user'
                   AND binding."state" = 'active'
                   AND binding."role" = 'owner'
                   AND binding."version" = (
                     SELECT max(latest."version")
                     FROM "QingLong3ProjectRoleBindings" AS latest
                     WHERE latest."project_id" = binding."project_id"
                       AND latest."subject_type" = binding."subject_type"
                       AND latest."subject_id" = binding."subject_id"
                   )`,
              )
              .get(command.binding.projectId) as Row | undefined;
            if (integer(ownerCount, 'count') <= 1) {
              throw new LocalProjectPolicyLastOwnerError();
            }
          }

          client
            .prepare(
              `INSERT INTO "QingLong3ProjectRoleBindings" (
                 "project_id", "subject_type", "subject_id", "version",
                 "state", "role", "mutation_id", "changed_by_type",
                 "changed_by_id", "created_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.binding.projectId,
              command.binding.subject.type,
              command.binding.subject.id,
              command.binding.version,
              command.binding.state,
              command.binding.role ?? null,
              command.binding.mutationId,
              command.binding.changedBy.type,
              command.binding.changedBy.id,
              command.binding.createdAtMs,
            );
          insertLocalSecurityAudit(client, command.audit);
          client.exec('COMMIT');
          return Object.freeze({
            status: 'inserted' as const,
            binding: command.binding,
            audit: command.audit,
          });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (
            error instanceof
              LocalProjectPolicyAuthorizationFenceConflictError ||
            error instanceof LocalProjectPolicyLastOwnerError ||
            error instanceof LocalProjectPolicyOwnerCredentialRequiredError ||
            error instanceof ProjectRoleBindingVersionConflictError ||
            error instanceof ProjectRoleBindingMutationConflictError ||
            error instanceof InvalidProjectPolicyValueError
          ) {
            throw error;
          }
          if (error instanceof SecurityAuditUnavailableError) throw error;
          throw new ProjectPolicyUnavailableError();
        }
      },
      () => new ProjectPolicyUnavailableError(),
    );
  }
}

export interface LocalSqliteProjectPolicyAdministrationDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: Pick<LocalOwnerPepperRepository, 'resolveKey'>;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly projectPolicyAdministration: LocalProjectPolicyAdministrationRepository;
  readonly securityAudit: SecurityAuditSink;
  activateUserCredentialFence(
    fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  ): void;
  close(): Promise<void>;
}

function sameCredentialFence(
  left: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  right: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
): boolean {
  return (
    left.credentialId === right.credentialId &&
    left.credentialVersion === right.credentialVersion &&
    left.pepperKeyId === right.pepperKeyId &&
    left.materialDigest === right.materialDigest &&
    left.subjectType === right.subjectType &&
    left.subjectId === right.subjectId &&
    left.secretDigest === right.secretDigest &&
    left.notBeforeAtMs === right.notBeforeAtMs &&
    left.expiresAtMs === right.expiresAtMs
  );
}

export async function openLocalSqliteProjectPolicyAdministrationDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteProjectPolicyAdministrationDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    let activeFence:
      | Readonly<LocalSqliteAuthenticatedUserCredentialFence>
      | undefined;
    const securityAuthority = new LocalSqliteSecurityAuthorityStore(authority);
    const projectPolicy: ProjectPolicyRepository = Object.freeze({
      resolve: (
        ...[projectId, subject]: Parameters<ProjectPolicyRepository['resolve']>
      ) => securityAuthority.resolve(projectId, subject),
      append: (...[command]: Parameters<ProjectPolicyRepository['append']>) =>
        securityAuthority.append(command),
    });
    const projectPolicyAdministration =
      new LocalSqliteProjectPolicyAdministrationRepository(
        authority,
        () => {
          if (!activeFence) {
            throw new LocalSqliteAuthenticatedManagementFenceError();
          }
          confirmLocalSqliteAuthenticatedUserCredentialFence(
            authority,
            activeFence,
          );
        },
        options.profile === 'edge'
          ? EDGE_PROJECT_CAPACITY
          : STANDALONE_PROJECT_CAPACITY,
      );
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      apiCredentials: new LocalSqliteApiCredentialRepository(authority),
      ownerPepper: new LocalSqliteOwnerPepperRepository(authority),
      projectPolicy,
      projectPolicyAdministration,
      securityAudit: securityAuthority,
      activateUserCredentialFence(
        fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
      ) {
        confirmLocalSqliteAuthenticatedUserCredentialFence(authority, fence);
        if (activeFence && !sameCredentialFence(activeFence, fence)) {
          throw new LocalSqliteAuthenticatedManagementFenceError();
        }
        activeFence = Object.freeze({ ...fence });
      },
      close() {
        if (closePromise) return closePromise;
        closePromise = authority.close();
        return closePromise;
      },
    });
  } catch (error) {
    if (client.isOpen) client.close();
    throw error;
  }
}

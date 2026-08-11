import {
  assertTaskDefinitionIdentifier,
  assertTaskDefinitionPageSize,
  normalizeAppendTaskDefinitionRevisionCommand,
  normalizeTaskDefinitionCursor,
  type AppendTaskDefinitionRevisionCommand,
  type TaskDefinitionCursor,
  type TaskDefinitionPage,
  type TaskDefinitionRecord,
} from './taskDefinition';
import { normalizeProjectPolicySubject } from '../security/project-policy/projectPolicy';
import type { SecurityPolicyFence, SecuritySubject } from '../security/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '../security/audit/securityAudit';

export interface AuthorizedTaskDefinitionRevisionMutation {
  readonly command: AppendTaskDefinitionRevisionCommand;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface TaskDefinitionAdministrationRepository {
  appendAuthorizedTaskDefinitionRevision(
    mutation: AuthorizedTaskDefinitionRevisionMutation,
  ): Promise<
    Readonly<{
      status: 'created' | 'updated' | 'existing';
      definition: TaskDefinitionRecord;
    }>
  >;
}

export interface AuthorizedTaskDefinitionInspection {
  readonly projectId: string;
  readonly taskId: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface AuthorizedTaskDefinitionList {
  readonly projectId: string;
  readonly limit: number;
  readonly after?: TaskDefinitionCursor;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface TaskDefinitionAdministrationSource {
  findAuthorizedCurrentTaskDefinition(
    inspection: AuthorizedTaskDefinitionInspection,
  ): Promise<TaskDefinitionRecord | null>;
  listAuthorizedTaskDefinitions(
    query: AuthorizedTaskDefinitionList,
  ): Promise<TaskDefinitionPage>;
}

export class InvalidTaskDefinitionAdministrationMutationError extends TypeError {
  readonly code = 'TASK_DEFINITION_ADMINISTRATION_MUTATION_INVALID';

  constructor(message: string) {
    super(`TaskDefinition administration mutation is invalid: ${message}`);
    this.name = 'InvalidTaskDefinitionAdministrationMutationError';
  }
}

export class TaskDefinitionAdministrationAuthorizationFenceConflictError extends Error {
  readonly code = 'TASK_DEFINITION_ADMINISTRATION_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super('TaskDefinition administration authorization fence changed');
    this.name =
      'TaskDefinitionAdministrationAuthorizationFenceConflictError';
  }
}

export class TaskDefinitionAdministrationMutationConflictError extends Error {
  readonly code = 'TASK_DEFINITION_ADMINISTRATION_MUTATION_CONFLICT';

  constructor() {
    super('TaskDefinition administration mutation conflicts with durable state');
    this.name = 'TaskDefinitionAdministrationMutationConflictError';
  }
}

export class InvalidTaskDefinitionAdministrationReadError extends TypeError {
  readonly code = 'TASK_DEFINITION_ADMINISTRATION_READ_INVALID';

  constructor(message: string) {
    super(`TaskDefinition administration read is invalid: ${message}`);
    this.name = 'InvalidTaskDefinitionAdministrationReadError';
  }
}

export class TaskDefinitionAdministrationReadConflictError extends Error {
  readonly code = 'TASK_DEFINITION_ADMINISTRATION_READ_CONFLICT';

  constructor() {
    super('TaskDefinition administration read conflicts with durable state');
    this.name = 'TaskDefinitionAdministrationReadConflictError';
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

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function normalizeFence(value: SecurityPolicyFence): SecurityPolicyFence {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['bindingVersion', 'projectVersion']) ||
    !Number.isSafeInteger(value.projectVersion) ||
    value.projectVersion < 1 ||
    !Number.isSafeInteger(value.bindingVersion) ||
    (value.bindingVersion as number) < 1
  ) {
    throw new InvalidTaskDefinitionAdministrationMutationError(
      'authorization fence is invalid',
    );
  }
  return Object.freeze({
    projectVersion: value.projectVersion,
    bindingVersion: value.bindingVersion,
  });
}

export function normalizeAuthorizedTaskDefinitionRevisionMutation(
  value: AuthorizedTaskDefinitionRevisionMutation,
): Readonly<AuthorizedTaskDefinitionRevisionMutation> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['actor', 'audit', 'command', 'fence'])
  ) {
    throw new InvalidTaskDefinitionAdministrationMutationError(
      'mutation shape is invalid',
    );
  }
  try {
    const command = normalizeAppendTaskDefinitionRevisionCommand(
      value.command,
    );
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = normalizeFence(value.fence);
    const audit = normalizeSecurityAuditRecord(value.audit);
    const operationId =
      command.expectedRevision === null ? 'task.create' : 'task.update';
    if (
      audit.eventId !== command.mutationId ||
      audit.operationId !== operationId ||
      audit.projectId !== command.projectId ||
      audit.outcome !== 'allowed' ||
      !audit.subject ||
      !sameSubject(audit.subject, actor) ||
      audit.authenticationId === null ||
      !audit.fence ||
      audit.fence.projectVersion !== fence.projectVersion ||
      audit.fence.bindingVersion !== fence.bindingVersion
    ) {
      throw new InvalidTaskDefinitionAdministrationMutationError(
        'audit binding is invalid',
      );
    }
    return Object.freeze({ command, actor, fence, audit });
  } catch (error) {
    if (error instanceof InvalidTaskDefinitionAdministrationMutationError) {
      throw error;
    }
    throw new InvalidTaskDefinitionAdministrationMutationError(
      'mutation value is invalid',
    );
  }
}

function normalizeTaskDefinitionReadAuthority(
  value: Readonly<{
    projectId: string;
    actor: SecuritySubject;
    fence: SecurityPolicyFence;
    audit: SecurityAuditRecord;
  }>,
): Readonly<{
  projectId: string;
  actor: SecuritySubject;
  fence: SecurityPolicyFence;
  audit: SecurityAuditRecord;
}> {
  const actor = normalizeProjectPolicySubject(value.actor);
  const fence = normalizeFence(value.fence);
  const audit = normalizeSecurityAuditRecord(value.audit);
  if (
    audit.operationId !== 'task.read' ||
    audit.projectId !== value.projectId ||
    audit.outcome !== 'allowed' ||
    !audit.subject ||
    !sameSubject(audit.subject, actor) ||
    audit.authenticationId === null ||
    !audit.fence ||
    audit.fence.projectVersion !== fence.projectVersion ||
    audit.fence.bindingVersion !== fence.bindingVersion
  ) {
    throw new InvalidTaskDefinitionAdministrationReadError(
      'audit binding is invalid',
    );
  }
  return Object.freeze({
    projectId: value.projectId,
    actor,
    fence,
    audit,
  });
}

export function normalizeAuthorizedTaskDefinitionInspection(
  value: AuthorizedTaskDefinitionInspection,
): Readonly<AuthorizedTaskDefinitionInspection> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['actor', 'audit', 'fence', 'projectId', 'taskId'])
  ) {
    throw new InvalidTaskDefinitionAdministrationReadError(
      'inspection shape is invalid',
    );
  }
  try {
    assertTaskDefinitionIdentifier(value.projectId, 'projectId');
    assertTaskDefinitionIdentifier(value.taskId, 'taskId');
    return Object.freeze({
      ...normalizeTaskDefinitionReadAuthority(value),
      taskId: value.taskId,
    });
  } catch (error) {
    if (error instanceof InvalidTaskDefinitionAdministrationReadError) {
      throw error;
    }
    throw new InvalidTaskDefinitionAdministrationReadError(
      'inspection value is invalid',
    );
  }
}

export function normalizeAuthorizedTaskDefinitionList(
  value: AuthorizedTaskDefinitionList,
): Readonly<AuthorizedTaskDefinitionList> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDefinitionAdministrationReadError(
      'list shape is invalid',
    );
  }
  const keys = Object.keys(value);
  if (
    !['actor', 'audit', 'fence', 'limit', 'projectId'].every((key) =>
      keys.includes(key),
    ) ||
    keys.some(
      (key) =>
        !['actor', 'after', 'audit', 'fence', 'limit', 'projectId'].includes(
          key,
        ),
    )
  ) {
    throw new InvalidTaskDefinitionAdministrationReadError(
      'list shape is invalid',
    );
  }
  try {
    assertTaskDefinitionIdentifier(value.projectId, 'projectId');
    assertTaskDefinitionPageSize(value.limit);
    const authority = normalizeTaskDefinitionReadAuthority(value);
    const after = Object.hasOwn(value, 'after')
      ? normalizeTaskDefinitionCursor(value.after as TaskDefinitionCursor)
      : undefined;
    return Object.freeze({
      ...authority,
      limit: value.limit,
      ...(after ? { after } : {}),
    });
  } catch (error) {
    if (error instanceof InvalidTaskDefinitionAdministrationReadError) {
      throw error;
    }
    throw new InvalidTaskDefinitionAdministrationReadError(
      'list value is invalid',
    );
  }
}

import {
  SECURITY_SUBJECT_TYPES,
  normalizeSecurityPolicyDecision,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
  type SecuritySubject,
} from '../security';

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export const PROJECT_ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;
export const PROJECT_ROLE_BINDING_STATES = ['active', 'revoked'] as const;
export const STATIC_PROJECT_PERMISSIONS = [
  'project.read',
  'project.manage',
  'task.read',
  'task.create',
  'task.update',
  'task.delete',
  'trigger.read',
  'trigger.create',
  'trigger.update',
  'run.read',
  'run.start',
  'run.stop',
  'run.retry',
  'model.invoke',
  'artifact.read',
  'approval.read',
  'package.manage',
  'secret.use',
  'secret.manage',
  'worker.manage',
  'policy.manage',
  'approval.decide',
  'approval.recover',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export type ProjectRoleBindingState =
  (typeof PROJECT_ROLE_BINDING_STATES)[number];
export type StaticProjectPermission =
  (typeof STATIC_PROJECT_PERMISSIONS)[number];
export type ProjectPermission = StaticProjectPermission | `tool.call:${string}`;

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: ProjectStatus;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ProjectRoleBindingRecord {
  readonly projectId: string;
  readonly subject: SecuritySubject;
  readonly version: number;
  readonly state: ProjectRoleBindingState;
  readonly role?: ProjectRole;
  readonly mutationId: string;
  readonly changedBy: SecuritySubject;
  readonly createdAtMs: number;
}

export interface ProjectPolicySnapshot {
  readonly project: Readonly<ProjectRecord>;
  readonly binding?: Readonly<ProjectRoleBindingRecord>;
}

export interface ProjectPolicyRequest {
  readonly subject: SecuritySubject;
  readonly projectId: string;
  readonly permission: ProjectPermission;
}

export interface AppendProjectRoleBindingCommand {
  readonly expectedCurrentVersion: number;
  readonly binding: ProjectRoleBindingRecord;
}

export interface AppendProjectRoleBindingResult {
  readonly status: 'inserted' | 'existing';
  readonly binding: Readonly<ProjectRoleBindingRecord>;
}

export interface ProjectPolicyRepository {
  resolve(
    projectId: string,
    subject: Readonly<SecuritySubject>,
  ): Promise<Readonly<ProjectPolicySnapshot> | null>;
  append(
    command: AppendProjectRoleBindingCommand,
  ): Promise<AppendProjectRoleBindingResult>;
}

export const MAX_PROJECT_ROLE_BINDING_VERSION = 2_147_483_647;

export class InvalidProjectPolicyValueError extends TypeError {
  constructor(message: string) {
    super(`Project policy contract is invalid: ${message}`);
    this.name = 'InvalidProjectPolicyValueError';
  }
}

export class ProjectPolicyUnavailableError extends Error {
  readonly code = 'PROJECT_POLICY_UNAVAILABLE';
  constructor() {
    super('Project policy is unavailable');
    this.name = 'ProjectPolicyUnavailableError';
  }
}

export class ProjectPolicyProjectNotFoundError extends Error {
  readonly code = 'PROJECT_NOT_FOUND';
  constructor() {
    super('Project does not exist');
    this.name = 'ProjectPolicyProjectNotFoundError';
  }
}

export class ProjectRoleBindingVersionConflictError extends Error {
  readonly code = 'PROJECT_ROLE_BINDING_VERSION_CONFLICT';
  constructor() {
    super('Project role binding current version changed');
    this.name = 'ProjectRoleBindingVersionConflictError';
  }
}

export class ProjectRoleBindingMutationConflictError extends Error {
  readonly code = 'PROJECT_ROLE_BINDING_MUTATION_CONFLICT';
  constructor() {
    super('Project role binding mutation conflicts with its previous request');
    this.name = 'ProjectRoleBindingMutationConflictError';
  }
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const MUTATION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const TOOL_PERMISSION_PATTERN =
  /^tool\.call:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function exactKeys(
  value: object,
  expected: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidProjectPolicyValueError(`${name} shape is invalid`);
  }
}

function boundedText(value: string, maximum: number, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new InvalidProjectPolicyValueError(`${name} is invalid`);
  }
  return value;
}

function timestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidProjectPolicyValueError(`${name} is invalid`);
  }
  return value;
}

function version(value: number, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PROJECT_ROLE_BINDING_VERSION
  ) {
    throw new InvalidProjectPolicyValueError(`${name} is invalid`);
  }
  return value;
}

export function normalizeProjectPolicySubject(
  value: SecuritySubject,
): Readonly<SecuritySubject> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectPolicyValueError('subject must be an object');
  }
  exactKeys(value, ['type', 'id'], 'subject');
  if (!SECURITY_SUBJECT_TYPES.includes(value.type)) {
    throw new InvalidProjectPolicyValueError('subject type is invalid');
  }
  return Object.freeze({
    type: value.type,
    id: boundedText(value.id, 255, 'subject id'),
  });
}

export function assertProjectPolicyProjectId(value: string): void {
  boundedText(value, 128, 'project id');
}

export function normalizeProjectPermission(value: string): ProjectPermission {
  if (
    STATIC_PROJECT_PERMISSIONS.includes(value as StaticProjectPermission) ||
    (typeof value === 'string' && TOOL_PERMISSION_PATTERN.test(value))
  ) {
    return value as ProjectPermission;
  }
  throw new InvalidProjectPolicyValueError('permission is invalid');
}

export function normalizeProjectRecord(
  value: ProjectRecord,
): Readonly<ProjectRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectPolicyValueError('project must be an object');
  }
  exactKeys(
    value,
    ['id', 'name', 'slug', 'status', 'version', 'createdAtMs', 'updatedAtMs'],
    'project',
  );
  const createdAtMs = timestamp(value.createdAtMs, 'project createdAtMs');
  const updatedAtMs = timestamp(value.updatedAtMs, 'project updatedAtMs');
  if (updatedAtMs < createdAtMs) {
    throw new InvalidProjectPolicyValueError('project timestamps are invalid');
  }
  if (!PROJECT_STATUSES.includes(value.status)) {
    throw new InvalidProjectPolicyValueError('project status is invalid');
  }
  if (!SLUG_PATTERN.test(value.slug)) {
    throw new InvalidProjectPolicyValueError('project slug is invalid');
  }
  assertProjectPolicyProjectId(value.id);
  return Object.freeze({
    id: value.id,
    name: boundedText(value.name, 255, 'project name'),
    slug: value.slug,
    status: value.status,
    version: version(value.version, 'project version'),
    createdAtMs,
    updatedAtMs,
  });
}

export function normalizeProjectRoleBinding(
  value: ProjectRoleBindingRecord,
): Readonly<ProjectRoleBindingRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectPolicyValueError('role binding must be an object');
  }
  exactKeys(
    value,
    value.state === 'active'
      ? [
          'projectId',
          'subject',
          'version',
          'state',
          'role',
          'mutationId',
          'changedBy',
          'createdAtMs',
        ]
      : [
          'projectId',
          'subject',
          'version',
          'state',
          'mutationId',
          'changedBy',
          'createdAtMs',
        ],
    'role binding',
  );
  if (!PROJECT_ROLE_BINDING_STATES.includes(value.state)) {
    throw new InvalidProjectPolicyValueError('role binding state is invalid');
  }
  if (
    (value.state === 'active' &&
      (!value.role || !PROJECT_ROLES.includes(value.role))) ||
    (value.state === 'revoked' && value.role !== undefined)
  ) {
    throw new InvalidProjectPolicyValueError('role binding role is invalid');
  }
  if (
    typeof value.mutationId !== 'string' ||
    !MUTATION_PATTERN.test(value.mutationId)
  ) {
    throw new InvalidProjectPolicyValueError('mutation id is invalid');
  }
  assertProjectPolicyProjectId(value.projectId);
  return Object.freeze({
    projectId: value.projectId,
    subject: normalizeProjectPolicySubject(value.subject),
    version: version(value.version, 'role binding version'),
    state: value.state,
    ...(value.role ? { role: value.role } : {}),
    mutationId: value.mutationId,
    changedBy: normalizeProjectPolicySubject(value.changedBy),
    createdAtMs: timestamp(value.createdAtMs, 'role binding createdAtMs'),
  });
}

export function normalizeProjectPolicySnapshot(
  value: ProjectPolicySnapshot,
): Readonly<ProjectPolicySnapshot> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectPolicyValueError(
      'policy snapshot must be an object',
    );
  }
  exactKeys(
    value,
    value.binding ? ['project', 'binding'] : ['project'],
    'snapshot',
  );
  const project = normalizeProjectRecord(value.project);
  const binding = value.binding
    ? normalizeProjectRoleBinding(value.binding)
    : undefined;
  if (binding && binding.projectId !== project.id) {
    throw new InvalidProjectPolicyValueError(
      'binding belongs to another project',
    );
  }
  return Object.freeze({ project, ...(binding ? { binding } : {}) });
}

export function assertExpectedProjectRoleBindingVersion(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= MAX_PROJECT_ROLE_BINDING_VERSION
  ) {
    throw new InvalidProjectPolicyValueError(
      'expected role binding version is invalid',
    );
  }
}

const READ_ONLY_PERMISSIONS = new Set<ProjectPermission>([
  'project.read',
  'task.read',
  'trigger.read',
  'run.read',
  'artifact.read',
  'approval.read',
]);
const OPERATOR_PERMISSIONS = new Set<ProjectPermission>([
  ...READ_ONLY_PERMISSIONS,
  'task.create',
  'task.update',
  'trigger.create',
  'trigger.update',
  'run.start',
  'run.stop',
  'run.retry',
  'model.invoke',
  'secret.use',
]);
const AGENT_APPROVAL_PERMISSIONS = new Set<ProjectPermission>([
  'project.manage',
  'task.create',
  'task.update',
  'task.delete',
  'trigger.create',
  'trigger.update',
  'run.start',
  'run.stop',
  'run.retry',
  'model.invoke',
  'secret.use',
  'secret.manage',
  'package.manage',
  'worker.manage',
  'policy.manage',
  'approval.decide',
]);

function roleAllows(role: ProjectRole, permission: ProjectPermission): boolean {
  if (role === 'owner') return true;
  if (role === 'admin')
    return (
      permission.startsWith('tool.call:') || permission !== 'project.manage'
    );
  if (role === 'operator')
    return (
      permission.startsWith('tool.call:') ||
      OPERATOR_PERMISSIONS.has(permission)
    );
  return READ_ONLY_PERMISSIONS.has(permission);
}

/** Evaluates one immutable Project/RoleBinding snapshot and returns its fence. */
export class ProjectPolicyEngine {
  constructor(
    private readonly repository: Pick<ProjectPolicyRepository, 'resolve'>,
  ) {
    if (!repository || typeof repository.resolve !== 'function') {
      throw new TypeError('Project policy repository is invalid');
    }
  }

  async decide(request: ProjectPolicyRequest): Promise<SecurityPolicyDecision> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new InvalidProjectPolicyValueError('request must be an object');
    }
    exactKeys(request, ['subject', 'projectId', 'permission'], 'request');
    const subject = normalizeProjectPolicySubject(request.subject);
    assertProjectPolicyProjectId(request.projectId);
    const projectId = request.projectId;
    const permission = normalizeProjectPermission(request.permission);
    let snapshot: Readonly<ProjectPolicySnapshot> | null;
    try {
      const resolved = await this.repository.resolve(projectId, subject);
      snapshot = resolved ? normalizeProjectPolicySnapshot(resolved) : null;
    } catch {
      throw new ProjectPolicyUnavailableError();
    }
    if (!snapshot) {
      return normalizeSecurityPolicyDecision({
        effect: 'deny',
        reasons: ['project_not_found'],
        fence: null,
      });
    }
    const fence = {
      projectVersion: snapshot.project.version,
      bindingVersion: snapshot.binding?.version ?? null,
    };
    if (!snapshot.binding || snapshot.binding.state === 'revoked') {
      return normalizeSecurityPolicyDecision({
        effect: 'deny',
        reasons: ['subject_unbound'],
        fence,
      });
    }
    if (
      snapshot.project.status === 'archived' &&
      !READ_ONLY_PERMISSIONS.has(permission)
    ) {
      return normalizeSecurityPolicyDecision({
        effect: 'deny',
        reasons: ['project_archived'],
        fence,
      });
    }
    if (!roleAllows(snapshot.binding.role!, permission)) {
      return normalizeSecurityPolicyDecision({
        effect: 'deny',
        reasons: ['permission_missing'],
        fence,
      });
    }
    if (
      subject.type === 'agent' &&
      (permission.startsWith('tool.call:') ||
        AGENT_APPROVAL_PERMISSIONS.has(permission))
    ) {
      return normalizeSecurityPolicyDecision({
        effect: 'require_approval',
        reasons: ['agent_action_requires_approval'],
        fence,
      });
    }
    return normalizeSecurityPolicyDecision({
      effect: 'allow',
      reasons: ['role_grant'],
      fence,
    });
  }

  async authorize(
    principal: Readonly<SecurityPrincipal>,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<SecurityPolicyDecision> {
    return this.decide({ subject: principal.subject, projectId, permission });
  }
}

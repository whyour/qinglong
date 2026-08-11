export const POLICY_SUBJECT_TYPES = [
  'user',
  'api_app',
  'mcp_client',
  'agent',
  'system',
  'worker',
] as const;

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
  'run.read',
  'run.start',
  'run.stop',
  'run.retry',
  'artifact.read',
  'secret.use',
  'secret.manage',
  'worker.manage',
  'policy.manage',
  'approval.decide',
  'approval.recover',
] as const;

export type PolicySubjectType = (typeof POLICY_SUBJECT_TYPES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export type ProjectRoleBindingState =
  (typeof PROJECT_ROLE_BINDING_STATES)[number];
export type StaticProjectPermission =
  (typeof STATIC_PROJECT_PERMISSIONS)[number];
export type ProjectPermission = StaticProjectPermission | `tool.call:${string}`;

export interface PolicySubject {
  type: PolicySubjectType;
  id: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  status: ProjectStatus;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ProjectRoleBindingRecord {
  projectId: string;
  subject: PolicySubject;
  version: number;
  state: ProjectRoleBindingState;
  role?: ProjectRole;
  mutationId: string;
  changedBy: PolicySubject;
  createdAtMs: number;
}

export interface ProjectPolicySnapshot {
  project: Readonly<ProjectRecord>;
  binding?: Readonly<ProjectRoleBindingRecord>;
}

export type ProjectPolicyEffect = 'allow' | 'deny' | 'require_approval';

export interface ProjectPolicyDecision {
  effect: ProjectPolicyEffect;
  reasons: readonly string[];
}

export interface ProjectPolicyFence {
  projectVersion: number;
  bindingVersion: number | null;
}

export interface ProjectPolicyDecisionWithFence {
  decision: Readonly<ProjectPolicyDecision>;
  fence: Readonly<ProjectPolicyFence> | null;
}

export interface ProjectPolicyRequest {
  subject: PolicySubject;
  projectId: string;
  permission: ProjectPermission;
}

export const MAX_POLICY_SUBJECT_ID_LENGTH = 255;
export const MAX_PROJECT_ID_LENGTH = 128;
export const MAX_PROJECT_NAME_LENGTH = 255;
export const MAX_PROJECT_SLUG_LENGTH = 128;
export const MAX_PROJECT_ROLE_BINDING_VERSION = 2_147_483_647;
export const MAX_PROJECT_POLICY_MUTATION_ID_LENGTH = 64;
export const MAX_PROJECT_PERMISSION_LENGTH = 255;

const IDENTIFIER_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PROJECT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const TOOL_PERMISSION_PATTERN =
  /^tool\.call:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class InvalidProjectPolicyValueError extends TypeError {
  constructor(message: string) {
    super(`Project policy value is invalid: ${message}`);
    this.name = 'InvalidProjectPolicyValueError';
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
    super('Project role binding mutation does not match its previous request');
    this.name = 'ProjectRoleBindingMutationConflictError';
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

function assertBoundedIdentifier(
  name: string,
  value: string,
  maximum: number,
): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    IDENTIFIER_CONTROL_PATTERN.test(value)
  ) {
    throw new InvalidProjectPolicyValueError(`${name} is invalid`);
  }
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidProjectPolicyValueError(`${name} is invalid`);
  }
}

function assertExactKeys(
  name: string,
  value: object,
  expected: readonly string[],
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

export function assertProjectPolicyProjectId(value: string): void {
  assertBoundedIdentifier('projectId', value, MAX_PROJECT_ID_LENGTH);
}

export function normalizePolicySubject(
  value: PolicySubject,
): Readonly<PolicySubject> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectPolicyValueError('subject must be an object');
  }
  assertExactKeys('subject', value, ['type', 'id']);
  if (!POLICY_SUBJECT_TYPES.includes(value.type)) {
    throw new InvalidProjectPolicyValueError('subject type is invalid');
  }
  assertBoundedIdentifier('subject id', value.id, MAX_POLICY_SUBJECT_ID_LENGTH);
  return Object.freeze({ type: value.type, id: value.id });
}

export function normalizeProjectPermission(value: string): ProjectPermission {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_PROJECT_PERMISSION_LENGTH
  ) {
    throw new InvalidProjectPolicyValueError('permission is invalid');
  }
  if (
    STATIC_PROJECT_PERMISSIONS.includes(value as StaticProjectPermission) ||
    TOOL_PERMISSION_PATTERN.test(value)
  ) {
    return value as ProjectPermission;
  }
  throw new InvalidProjectPolicyValueError('permission is invalid');
}

export function normalizeProjectRecord(
  value: ProjectRecord,
): Readonly<ProjectRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectPolicyValueError('Project must be an object');
  }
  assertExactKeys('Project', value, [
    'id',
    'name',
    'slug',
    'status',
    'version',
    'createdAtMs',
    'updatedAtMs',
  ]);
  assertProjectPolicyProjectId(value.id);
  assertBoundedIdentifier('Project name', value.name, MAX_PROJECT_NAME_LENGTH);
  if (
    typeof value.slug !== 'string' ||
    value.slug.length > MAX_PROJECT_SLUG_LENGTH ||
    !PROJECT_SLUG_PATTERN.test(value.slug)
  ) {
    throw new InvalidProjectPolicyValueError('Project slug is invalid');
  }
  if (!PROJECT_STATUSES.includes(value.status)) {
    throw new InvalidProjectPolicyValueError('Project status is invalid');
  }
  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    value.version > MAX_PROJECT_ROLE_BINDING_VERSION
  ) {
    throw new InvalidProjectPolicyValueError('Project version is invalid');
  }
  assertTimestamp('Project createdAtMs', value.createdAtMs);
  assertTimestamp('Project updatedAtMs', value.updatedAtMs);
  if (value.updatedAtMs < value.createdAtMs) {
    throw new InvalidProjectPolicyValueError('Project timestamps are invalid');
  }
  return Object.freeze({ ...value });
}

export function normalizeProjectRoleBindingRecord(
  value: ProjectRoleBindingRecord,
): Readonly<ProjectRoleBindingRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectPolicyValueError(
      'Project role binding must be an object',
    );
  }
  assertExactKeys(
    'Project role binding',
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
  );
  assertProjectPolicyProjectId(value.projectId);
  const subject = normalizePolicySubject(value.subject);
  const changedBy = normalizePolicySubject(value.changedBy);
  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    value.version > MAX_PROJECT_ROLE_BINDING_VERSION
  ) {
    throw new InvalidProjectPolicyValueError(
      'Project role binding version is invalid',
    );
  }
  if (!PROJECT_ROLE_BINDING_STATES.includes(value.state)) {
    throw new InvalidProjectPolicyValueError(
      'Project role binding state is invalid',
    );
  }
  if (
    (value.state === 'active' &&
      (!value.role || !PROJECT_ROLES.includes(value.role))) ||
    (value.state === 'revoked' && value.role !== undefined)
  ) {
    throw new InvalidProjectPolicyValueError(
      'Project role binding role is invalid',
    );
  }
  if (
    typeof value.mutationId !== 'string' ||
    value.mutationId.length < 1 ||
    value.mutationId.length > MAX_PROJECT_POLICY_MUTATION_ID_LENGTH ||
    !MUTATION_ID_PATTERN.test(value.mutationId)
  ) {
    throw new InvalidProjectPolicyValueError(
      'Project role binding mutationId is invalid',
    );
  }
  assertTimestamp('Project role binding createdAtMs', value.createdAtMs);
  return Object.freeze({
    projectId: value.projectId,
    subject,
    version: value.version,
    state: value.state,
    ...(value.role ? { role: value.role } : {}),
    mutationId: value.mutationId,
    changedBy,
    createdAtMs: value.createdAtMs,
  });
}

export function normalizeProjectPolicySnapshot(
  value: ProjectPolicySnapshot,
): Readonly<ProjectPolicySnapshot> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectPolicyValueError(
      'Project policy snapshot must be an object',
    );
  }
  assertExactKeys(
    'Project policy snapshot',
    value,
    value.binding ? ['project', 'binding'] : ['project'],
  );
  const project = normalizeProjectRecord(value.project);
  const binding = value.binding
    ? normalizeProjectRoleBindingRecord(value.binding)
    : undefined;
  if (binding && binding.projectId !== project.id) {
    throw new InvalidProjectPolicyValueError(
      'Project policy snapshot binding is misplaced',
    );
  }
  return Object.freeze({ project, ...(binding ? { binding } : {}) });
}

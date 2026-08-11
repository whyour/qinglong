import {
  assertProjectPolicyProjectId,
  normalizePolicySubject,
  normalizeProjectPermission,
  normalizeProjectPolicySnapshot,
  ProjectPolicyUnavailableError,
  type ProjectPermission,
  type ProjectPolicyDecision,
  type ProjectPolicyDecisionWithFence,
  type ProjectPolicyRequest,
  type ProjectRole,
  type StaticProjectPermission,
} from '../domain/projectPolicy';
import type { ProjectPolicyRepository } from '../ports/projectPolicyRepository';

const READ_ONLY_PERMISSIONS = new Set<ProjectPermission>([
  'project.read',
  'task.read',
  'run.read',
  'artifact.read',
]);

const OPERATOR_PERMISSIONS = new Set<ProjectPermission>([
  ...READ_ONLY_PERMISSIONS,
  'task.create',
  'task.update',
  'run.start',
  'run.stop',
  'run.retry',
  'secret.use',
]);

const ADMIN_EXCLUDED_PERMISSIONS = new Set<StaticProjectPermission>([
  'project.manage',
]);

const AGENT_APPROVAL_PERMISSIONS = new Set<ProjectPermission>([
  'project.manage',
  'task.create',
  'task.update',
  'task.delete',
  'run.start',
  'run.stop',
  'run.retry',
  'secret.use',
  'secret.manage',
  'worker.manage',
  'policy.manage',
  'approval.decide',
]);

function decision(
  effect: ProjectPolicyDecision['effect'],
  reason: string,
): Readonly<ProjectPolicyDecision> {
  return Object.freeze({ effect, reasons: Object.freeze([reason]) });
}

function roleAllows(role: ProjectRole, permission: ProjectPermission): boolean {
  if (role === 'owner') return true;
  if (role === 'admin') {
    return (
      permission.startsWith('tool.call:') ||
      !ADMIN_EXCLUDED_PERMISSIONS.has(permission as StaticProjectPermission)
    );
  }
  if (role === 'operator') {
    return (
      permission.startsWith('tool.call:') ||
      OPERATOR_PERMISSIONS.has(permission)
    );
  }
  return READ_ONLY_PERMISSIONS.has(permission);
}

function agentRequiresApproval(permission: ProjectPermission): boolean {
  return (
    permission.startsWith('tool.call:') ||
    AGENT_APPROVAL_PERMISSIONS.has(permission)
  );
}

export class ProjectPolicyEngine {
  constructor(private readonly repository: ProjectPolicyRepository) {}

  async decide(
    request: ProjectPolicyRequest,
  ): Promise<Readonly<ProjectPolicyDecision>> {
    return (await this.decideWithFence(request)).decision;
  }

  async decideWithFence(
    request: ProjectPolicyRequest,
  ): Promise<Readonly<ProjectPolicyDecisionWithFence>> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('Project policy request must be an object');
    }
    const requestKeys = Object.keys(request).sort();
    if (
      requestKeys.length !== 3 ||
      requestKeys[0] !== 'permission' ||
      requestKeys[1] !== 'projectId' ||
      requestKeys[2] !== 'subject'
    ) {
      throw new TypeError('Project policy request shape is invalid');
    }
    const subject = normalizePolicySubject(request.subject);
    assertProjectPolicyProjectId(request.projectId);
    const permission = normalizeProjectPermission(request.permission);
    let resolved;
    try {
      resolved = await this.repository.resolve(request.projectId, subject);
    } catch {
      throw new ProjectPolicyUnavailableError();
    }
    if (!resolved) {
      return Object.freeze({
        decision: decision('deny', 'project_not_found'),
        fence: null,
      });
    }
    let snapshot;
    try {
      snapshot = normalizeProjectPolicySnapshot(resolved);
    } catch {
      throw new ProjectPolicyUnavailableError();
    }
    if (snapshot.project.id !== request.projectId) {
      throw new ProjectPolicyUnavailableError();
    }
    const fence = Object.freeze({
      projectVersion: snapshot.project.version,
      bindingVersion: snapshot.binding?.version ?? null,
    });
    if (!snapshot.binding || snapshot.binding.state === 'revoked') {
      return Object.freeze({
        decision: decision('deny', 'subject_unbound'),
        fence,
      });
    }
    if (
      snapshot.binding.subject.type !== subject.type ||
      snapshot.binding.subject.id !== subject.id
    ) {
      throw new ProjectPolicyUnavailableError();
    }
    if (
      snapshot.project.status === 'archived' &&
      !READ_ONLY_PERMISSIONS.has(permission)
    ) {
      return Object.freeze({
        decision: decision('deny', 'project_archived'),
        fence,
      });
    }
    if (!roleAllows(snapshot.binding.role!, permission)) {
      return Object.freeze({
        decision: decision('deny', 'permission_missing'),
        fence,
      });
    }
    if (subject.type === 'agent' && agentRequiresApproval(permission)) {
      return Object.freeze({
        decision: decision(
          'require_approval',
          'agent_action_requires_approval',
        ),
        fence,
      });
    }
    return Object.freeze({
      decision: decision('allow', 'role_grant'),
      fence,
    });
  }
}

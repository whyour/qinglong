import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import type { LocalApplicationProfile } from '@qinglong/local-application';
import {
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPolicyDecision,
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditOutcome,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import {
  TaskDefinitionUnavailableError,
  type TaskDefinitionRecord,
  type TaskDefinitionSource,
} from '@qinglong/runtime-core/task-definition';

import type { AuthenticatedLocalApiRequest } from '../authentication/credentialAuthenticator';
import {
  LocalPresenceProofUnavailableError,
  type LocalPresenceBinding,
  type LocalPresenceProofManager,
} from '../authentication/localPresenceProof';
import type { LocalApiResponse } from '../transport/contract';

const LEASE_TTL_MS = 10 * 60_000;
const LEASE_PATTERN =
  /^ql3a_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface LocalApiTaskAuthoringLeaseBinding {
  readonly projectId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly contentDigest: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly subjectType: 'user';
  readonly subjectId: string;
}

export interface LocalApiTaskAuthoringLeases {
  inspect(
    presentation: string | null,
    binding: Readonly<LocalApiTaskAuthoringLeaseBinding>,
  ): boolean;
  consume(
    presentation: string | null,
    binding: Readonly<LocalApiTaskAuthoringLeaseBinding>,
  ): boolean;
}

export interface LocalApiTaskAuthoringRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly presence: string | null;
  readonly authenticated: Readonly<AuthenticatedLocalApiRequest>;
  readonly signal: AbortSignal;
}

export interface LocalApiTaskAuthoringRoute {
  readonly leases: LocalApiTaskAuthoringLeases;
  handle(
    request: Readonly<LocalApiTaskAuthoringRequest>,
  ): Promise<LocalApiResponse>;
  close(): void;
}

export interface LocalApiTaskAuthoringRouteOptions {
  readonly profile: LocalApplicationProfile;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly taskDefinitions: Pick<
    TaskDefinitionSource,
    'findCurrentTaskDefinition'
  >;
  readonly securityAudit: SecurityAuditSink;
  readonly presenceProof: LocalPresenceProofManager;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  readonly randomSecret?: () => Buffer;
}

interface PendingTaskAuthoringLease {
  readonly leaseId: string;
  readonly bindingDigest: string;
  readonly presentationDigest: Buffer;
  readonly expiresAtMs: number;
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): LocalApiResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function timestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalPresenceProofUnavailableError('clock is invalid');
  }
  return value;
}

function bindingDigest(
  binding: Readonly<LocalApiTaskAuthoringLeaseBinding>,
): string {
  if (
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    Object.keys(binding).sort().join('\0') !==
      [
        'contentDigest',
        'credentialId',
        'credentialVersion',
        'projectId',
        'revision',
        'subjectId',
        'subjectType',
        'taskId',
      ]
        .sort()
        .join('\0') ||
    typeof binding.projectId !== 'string' ||
    binding.projectId.length < 1 ||
    binding.projectId.length > 128 ||
    typeof binding.taskId !== 'string' ||
    binding.taskId.length < 1 ||
    binding.taskId.length > 128 ||
    !Number.isSafeInteger(binding.revision) ||
    binding.revision < 1 ||
    !SHA256_PATTERN.test(binding.contentDigest) ||
    typeof binding.credentialId !== 'string' ||
    binding.credentialId.length < 1 ||
    binding.credentialId.length > 64 ||
    !Number.isSafeInteger(binding.credentialVersion) ||
    binding.credentialVersion < 1 ||
    binding.subjectType !== 'user' ||
    typeof binding.subjectId !== 'string' ||
    binding.subjectId.length < 1 ||
    binding.subjectId.length > 128
  ) {
    throw new LocalPresenceProofUnavailableError(
      'Task authoring lease binding is invalid',
    );
  }
  return createHash('sha256')
    .update('qinglong3.local-api-task-authoring-lease-binding.v1\0', 'utf8')
    .update(binding.projectId, 'utf8')
    .update('\0', 'utf8')
    .update(binding.taskId, 'utf8')
    .update('\0', 'utf8')
    .update(String(binding.revision), 'utf8')
    .update('\0', 'utf8')
    .update(binding.contentDigest, 'utf8')
    .update('\0', 'utf8')
    .update(binding.credentialId, 'utf8')
    .update('\0', 'utf8')
    .update(String(binding.credentialVersion), 'utf8')
    .update('\0', 'utf8')
    .update(binding.subjectId, 'utf8')
    .digest('hex');
}

function presenceBinding(
  request: Readonly<LocalApiTaskAuthoringRequest>,
): Readonly<LocalPresenceBinding> {
  if (
    request.authenticated.principal.subject.type !== 'user' ||
    request.authenticated.credentialFence.subjectType !== 'user'
  ) {
    throw new LocalPresenceProofUnavailableError(
      'strong User credential is required',
    );
  }
  return Object.freeze({
    requestDigest: createHash('sha256')
      .update('qinglong3.local-api-task-authoring-read.v1\0', 'utf8')
      .update(request.projectId, 'utf8')
      .update('\0', 'utf8')
      .update(request.taskId, 'utf8')
      .digest('hex'),
    credentialId: request.authenticated.credentialFence.credentialId,
    credentialVersion: request.authenticated.credentialFence.credentialVersion,
    subjectType: 'user',
    subjectId: request.authenticated.credentialFence.subjectId,
  });
}

function authoringLeaseBinding(
  request: Readonly<LocalApiTaskAuthoringRequest>,
  definition: Readonly<TaskDefinitionRecord>,
): Readonly<LocalApiTaskAuthoringLeaseBinding> {
  if (request.authenticated.credentialFence.subjectType !== 'user') {
    throw new LocalPresenceProofUnavailableError(
      'Task authoring lease requires a User credential',
    );
  }
  return Object.freeze({
    projectId: request.projectId,
    taskId: request.taskId,
    revision: definition.revision,
    contentDigest: definition.contentDigest,
    credentialId: request.authenticated.credentialFence.credentialId,
    credentialVersion: request.authenticated.credentialFence.credentialVersion,
    subjectType: 'user',
    subjectId: request.authenticated.credentialFence.subjectId,
  });
}

function strongPrincipal(
  authenticated: Readonly<AuthenticatedLocalApiRequest>,
  proof: Readonly<{
    authorizationId: string;
    authenticatedAtMs: number;
    expiresAtMs: number;
  }>,
): Readonly<SecurityPrincipal> {
  return normalizeSecurityPrincipal(
    {
      subject: authenticated.principal.subject,
      authenticationId: `local_presence:${proof.authorizationId}`,
      authenticatedAtMs: proof.authenticatedAtMs,
      expiresAtMs: Math.min(
        proof.expiresAtMs,
        authenticated.principal.expiresAtMs,
      ),
      assurance: 'local_console',
    },
    proof.authenticatedAtMs,
  );
}

async function recordAudit(
  audit: SecurityAuditSink,
  values: {
    readonly eventId: string;
    readonly requestId: string;
    readonly projectId: string;
    readonly principal: Readonly<SecurityPrincipal> | null;
    readonly outcome: SecurityAuditOutcome;
    readonly reasons: readonly string[];
    readonly fence: SecurityPolicyDecision['fence'];
    readonly occurredAtMs: number;
  },
): Promise<boolean> {
  try {
    await audit.record(
      normalizeSecurityAuditRecord({
        eventId: values.eventId,
        requestId: values.requestId,
        operationId: 'task.authoring.read',
        projectId: values.projectId,
        subject: values.principal?.subject ?? null,
        authenticationId: values.principal?.authenticationId ?? null,
        outcome: values.outcome,
        reasons: values.reasons,
        fence: values.fence,
        occurredAtMs: values.occurredAtMs,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function sameFence(
  left: SecurityPolicyDecision['fence'],
  right: SecurityPolicyDecision['fence'],
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.projectVersion === right.projectVersion &&
    left.bindingVersion !== null &&
    left.bindingVersion === right.bindingVersion
  );
}

export function createLocalApiTaskAuthoringRoute(
  options: Readonly<LocalApiTaskAuthoringRouteOptions>,
): Readonly<LocalApiTaskAuthoringRoute> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    (options.profile !== 'edge' && options.profile !== 'standalone') ||
    typeof options.projectPolicy?.resolve !== 'function' ||
    typeof options.taskDefinitions?.findCurrentTaskDefinition !== 'function' ||
    typeof options.securityAudit?.record !== 'function' ||
    typeof options.presenceProof?.issue !== 'function' ||
    typeof options.presenceProof?.consume !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomUuid !== undefined &&
      typeof options.randomUuid !== 'function') ||
    (options.randomSecret !== undefined &&
      typeof options.randomSecret !== 'function')
  ) {
    throw new TypeError('Local API Task authoring route options are invalid');
  }
  const now = options.now ?? Date.now;
  const uuid = options.randomUuid ?? randomUUID;
  const secret = options.randomSecret ?? (() => randomBytes(32));
  const policy = new ProjectPolicyEngine(options.projectPolicy);
  const maximumPending = options.profile === 'edge' ? 8 : 32;
  const pending = new Map<string, PendingTaskAuthoringLease>();
  let closed = false;

  const sweep = (nowMs: number) => {
    for (const [leaseId, lease] of pending) {
      if (lease.expiresAtMs > nowMs) continue;
      lease.presentationDigest.fill(0);
      pending.delete(leaseId);
    }
  };

  const leaseMatches = (
    presentation: string | null,
    binding: Readonly<LocalApiTaskAuthoringLeaseBinding>,
    consume: boolean,
  ): boolean => {
    if (closed || typeof presentation !== 'string') return false;
    const nowMs = timestamp(now);
    sweep(nowMs);
    const match = LEASE_PATTERN.exec(presentation);
    if (!match) return false;
    const lease = pending.get(match[1]!);
    if (!lease) return false;
    const actual = createHash('sha256')
      .update('qinglong3.local-api-task-authoring-lease.v1\0', 'utf8')
      .update(presentation, 'utf8')
      .digest();
    let valid = false;
    try {
      valid =
        lease.expiresAtMs > nowMs &&
        lease.bindingDigest === bindingDigest(binding) &&
        timingSafeEqual(actual, lease.presentationDigest);
    } catch {
      valid = false;
    } finally {
      actual.fill(0);
    }
    if (valid && consume) {
      pending.delete(lease.leaseId);
      lease.presentationDigest.fill(0);
    }
    return valid;
  };

  const leases: LocalApiTaskAuthoringLeases = Object.freeze({
    inspect(
      presentation: string | null,
      binding: Readonly<LocalApiTaskAuthoringLeaseBinding>,
    ) {
      return leaseMatches(presentation, binding, false);
    },
    consume(
      presentation: string | null,
      binding: Readonly<LocalApiTaskAuthoringLeaseBinding>,
    ) {
      return leaseMatches(presentation, binding, true);
    },
  });

  const issueLease = (
    binding: Readonly<LocalApiTaskAuthoringLeaseBinding>,
  ): Readonly<{ lease: string; expiresAtMs: number }> => {
    if (closed) {
      throw new LocalPresenceProofUnavailableError(
        'Task authoring route is closed',
      );
    }
    const nowMs = timestamp(now);
    sweep(nowMs);
    if (pending.size >= maximumPending) {
      throw new LocalPresenceProofUnavailableError(
        'Task authoring lease capacity is exhausted',
      );
    }
    const leaseId = uuid();
    const material = secret();
    if (!Buffer.isBuffer(material) || material.byteLength !== 32) {
      throw new LocalPresenceProofUnavailableError(
        'Task authoring lease entropy is unavailable',
      );
    }
    let presentation: string | undefined;
    try {
      presentation = `ql3a_${leaseId}_${material.toString('base64url')}`;
      if (!LEASE_PATTERN.test(presentation)) {
        throw new LocalPresenceProofUnavailableError(
          'Task authoring lease identity is invalid',
        );
      }
      const expiresAtMs = nowMs + LEASE_TTL_MS;
      pending.set(
        leaseId,
        Object.freeze({
          leaseId,
          bindingDigest: bindingDigest(binding),
          presentationDigest: createHash('sha256')
            .update('qinglong3.local-api-task-authoring-lease.v1\0', 'utf8')
            .update(presentation, 'utf8')
            .digest(),
          expiresAtMs,
        }),
      );
      return Object.freeze({ lease: presentation, expiresAtMs });
    } finally {
      material.fill(0);
      presentation = undefined;
    }
  };

  return Object.freeze({
    leases,
    async handle(request: Readonly<LocalApiTaskAuthoringRequest>) {
      if (closed || request.signal.aborted) {
        return response(503, { code: 'request_unavailable' });
      }
      const occurredAtMs = timestamp(now);
      let initialDecision: Readonly<SecurityPolicyDecision>;
      try {
        initialDecision = normalizeSecurityPolicyDecision(
          await policy.authorize(
            request.authenticated.principal,
            request.projectId,
            'task.update',
          ),
        );
      } catch (error) {
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          projectId: request.projectId,
          principal: request.authenticated.principal,
          outcome: 'authorization_unavailable',
          reasons: ['policy_unavailable'],
          fence: null,
          occurredAtMs,
        });
        return response(503, {
          code:
            audited && error instanceof ProjectPolicyUnavailableError
              ? 'authorization_unavailable'
              : 'security_audit_unavailable',
        });
      }
      if (initialDecision.effect !== 'allow') {
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          projectId: request.projectId,
          principal: request.authenticated.principal,
          outcome:
            initialDecision.effect === 'require_approval'
              ? 'approval_required'
              : 'denied',
          reasons: initialDecision.reasons,
          fence: initialDecision.fence,
          occurredAtMs,
        });
        return audited
          ? response(403, {
              code:
                initialDecision.effect === 'require_approval'
                  ? 'approval_required'
                  : 'forbidden',
            })
          : response(503, { code: 'security_audit_unavailable' });
      }
      sweep(occurredAtMs);
      if (pending.size >= maximumPending) {
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          projectId: request.projectId,
          principal: request.authenticated.principal,
          outcome: 'authorization_unavailable',
          reasons: ['task_authoring_capacity_exhausted'],
          fence: initialDecision.fence,
          occurredAtMs,
        });
        return response(503, {
          code: audited
            ? 'task_authoring_unavailable'
            : 'security_audit_unavailable',
        });
      }
      let binding: Readonly<LocalPresenceBinding>;
      try {
        binding = presenceBinding(request);
      } catch {
        return response(401, { code: 'strong_authentication_required' });
      }
      if (!request.presence) {
        let challenge;
        try {
          challenge = options.presenceProof.issue(binding);
        } catch {
          return response(503, { code: 'local_presence_unavailable' });
        }
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          projectId: request.projectId,
          principal: request.authenticated.principal,
          outcome: 'approval_required',
          reasons: ['local_presence_required'],
          fence: initialDecision.fence,
          occurredAtMs,
        });
        return audited
          ? response(428, {
              code: 'local_presence_required',
              authorizationId: challenge.authorizationId,
              requestDigest: challenge.requestDigest,
              expiresAtMs: challenge.expiresAtMs,
              proofFileName: challenge.proofFileName,
            })
          : response(503, { code: 'security_audit_unavailable' });
      }
      let proof;
      try {
        await request.authenticated.confirm();
        proof = options.presenceProof.consume(request.presence, binding);
      } catch {
        return response(503, { code: 'authentication_unavailable' });
      }
      if (!proof) {
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          projectId: request.projectId,
          principal: null,
          outcome: 'authentication_rejected',
          reasons: ['local_presence_rejected'],
          fence: null,
          occurredAtMs,
        });
        return audited
          ? response(401, { code: 'local_presence_rejected' })
          : response(503, { code: 'security_audit_unavailable' });
      }
      if (request.signal.aborted) {
        return response(503, { code: 'request_unavailable' });
      }
      let principal: Readonly<SecurityPrincipal>;
      let readDecision: Readonly<SecurityPolicyDecision>;
      let updateDecision: Readonly<SecurityPolicyDecision>;
      try {
        principal = strongPrincipal(request.authenticated, proof);
        [readDecision, updateDecision] = await Promise.all([
          policy.authorize(principal, request.projectId, 'task.read'),
          policy.authorize(principal, request.projectId, 'task.update'),
        ]).then(
          (values) =>
            values.map(normalizeSecurityPolicyDecision) as [
              Readonly<SecurityPolicyDecision>,
              Readonly<SecurityPolicyDecision>,
            ],
        );
      } catch {
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          projectId: request.projectId,
          principal: null,
          outcome: 'authorization_unavailable',
          reasons: ['policy_unavailable'],
          fence: null,
          occurredAtMs,
        });
        return response(503, {
          code: audited
            ? 'authorization_unavailable'
            : 'security_audit_unavailable',
        });
      }
      if (
        readDecision.effect !== 'allow' ||
        updateDecision.effect !== 'allow' ||
        !sameFence(readDecision.fence, updateDecision.fence)
      ) {
        const denied =
          readDecision.effect !== 'allow' ? readDecision : updateDecision;
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          projectId: request.projectId,
          principal,
          outcome:
            denied.effect === 'require_approval'
              ? 'approval_required'
              : 'denied',
          reasons: sameFence(readDecision.fence, updateDecision.fence)
            ? denied.reasons
            : ['policy_fence_mismatch'],
          fence: denied.fence,
          occurredAtMs,
        });
        return audited
          ? response(403, {
              code:
                denied.effect === 'require_approval'
                  ? 'approval_required'
                  : 'forbidden',
            })
          : response(503, { code: 'security_audit_unavailable' });
      }
      let definition: Readonly<TaskDefinitionRecord> | null;
      try {
        definition = await options.taskDefinitions.findCurrentTaskDefinition(
          request.projectId,
          request.taskId,
        );
        await request.authenticated.confirm();
      } catch (error) {
        return response(503, {
          code:
            error instanceof TaskDefinitionUnavailableError
              ? 'task_definition_unavailable'
              : 'authentication_unavailable',
        });
      }
      if (!definition) {
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          projectId: request.projectId,
          principal,
          outcome: 'allowed',
          reasons: updateDecision.reasons,
          fence: updateDecision.fence,
          occurredAtMs,
        });
        if (!audited) {
          return response(503, { code: 'security_audit_unavailable' });
        }
        return response(404, { code: 'task_not_found' });
      }
      const authoringBinding = authoringLeaseBinding(request, definition);
      let authoring;
      try {
        authoring = issueLease(authoringBinding);
      } catch {
        return response(503, { code: 'task_authoring_unavailable' });
      }
      const audited = await recordAudit(options.securityAudit, {
        eventId: uuid(),
        requestId: request.requestId,
        projectId: request.projectId,
        principal,
        outcome: 'allowed',
        reasons: updateDecision.reasons,
        fence: updateDecision.fence,
        occurredAtMs,
      });
      if (!audited) {
        leases.consume(authoring.lease, authoringBinding);
        return response(503, { code: 'security_audit_unavailable' });
      }
      return response(200, {
        task: definition,
        authoring: Object.freeze({
          lease: authoring.lease,
          expiresAtMs: authoring.expiresAtMs,
          revision: definition.revision,
          contentDigest: definition.contentDigest,
        }),
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const lease of pending.values()) {
        lease.presentationDigest.fill(0);
      }
      pending.clear();
    },
  });
}

// Cluster Plugin Package publisher boundary; keep trust management authority explicit.
import { PostgresApprovalRequestRepository } from '@qinglong/cluster-postgres/approved-action';
import {
  PostgresPluginPackagePublisherRevocationProposalRepository,
  PostgresPluginPackagePublisherTrustAuthorityRepository,
  PostgresPluginPackagePublisherTrustTransitionProposalRepository,
} from '@qinglong/cluster-postgres/package-manager';
import { PostgresProjectPolicyRepository } from '@qinglong/cluster-postgres/project-policy';
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  MAX_APPROVAL_LIFETIME_MS,
  createApprovalRequest,
  normalizeApprovalRequestRecord,
  type ApprovalRequestRecord,
  type CreateApprovalRequestResult,
} from '@qinglong/runtime-core/approved-action';
import {
  PluginPackageManagementAuthorizationError,
  PluginPackageManagementConflictError,
  PluginPackageManagementQuotaExceededError,
  PluginPackageManagementRequestError,
  PluginPackageManagementUnavailableError,
  type PluginPackageManagementQuotaPort,
} from '@qinglong/runtime-core/plugin-package-management';
import {
  createPluginPackagePublisherRevocationProposal,
  normalizePluginPackagePublisherRevocationProposal,
  type CreatePluginPackagePublisherRevocationProposalResult,
  type PluginPackagePublisherRevocationProposal,
} from '@qinglong/runtime-core/plugin-package-publisher-revocation-proposal';
import type {
  PluginPackagePublisherTrustSnapshot,
} from '@qinglong/runtime-core/plugin-package-publisher-trust';
import {
  createPluginPackagePublisherTrustTransitionProposal,
  normalizePluginPackagePublisherTrustTransitionProposal,
  type CreatePluginPackagePublisherTrustTransitionProposalResult,
  type PluginPackagePublisherTrustTransitionMode,
  type PluginPackagePublisherTrustTransitionProposal,
} from '@qinglong/runtime-core/plugin-package-publisher-trust-transition-proposal';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
  type SecuritySubject,
} from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const DEFAULT_APPROVAL_LIFETIME_MS = 10 * 60 * 1000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const PUBLISHER_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export interface ProposeClusterPluginPackagePublisherRevocationRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly proposalAuditEventId: string;
  readonly approvalAuditEventId: string;
  readonly publisher: string;
  readonly keyId: string;
  readonly authorizationMode: 'dual_control' | 'break_glass';
  readonly reasonCode:
    | 'suspected_key_compromise'
    | 'confirmed_key_compromise';
  readonly requestedAtMs: number;
  readonly principal: SecurityPrincipal;
}

export interface ProposeClusterPluginPackagePublisherRevocationResult {
  readonly proposalStatus: CreatePluginPackagePublisherRevocationProposalResult['status'];
  readonly approvalStatus: CreateApprovalRequestResult['status'];
  readonly proposal: Readonly<PluginPackagePublisherRevocationProposal>;
  readonly approvalRequest: Readonly<ApprovalRequestRecord>;
}

export interface InspectClusterPluginPackagePublisherRevocationResult {
  readonly proposal: Readonly<PluginPackagePublisherRevocationProposal> | null;
  readonly approvalRequest: Readonly<ApprovalRequestRecord> | null;
}

export interface ProposeClusterPluginPackagePublisherTrustTransitionRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly proposalAuditEventId: string;
  readonly approvalAuditEventId: string;
  readonly mode: PluginPackagePublisherTrustTransitionMode;
  readonly publisher: string;
  readonly keyId: string;
  readonly requestedAtMs: number;
  readonly principal: SecurityPrincipal;
}

export interface ProposeClusterPluginPackagePublisherTrustTransitionResult {
  readonly proposalStatus: CreatePluginPackagePublisherTrustTransitionProposalResult['status'];
  readonly approvalStatus: CreateApprovalRequestResult['status'];
  readonly proposal: Readonly<PluginPackagePublisherTrustTransitionProposal>;
  readonly approvalRequest: Readonly<ApprovalRequestRecord>;
}

export interface InspectClusterPluginPackagePublisherTrustTransitionResult {
  readonly proposal: Readonly<PluginPackagePublisherTrustTransitionProposal> | null;
  readonly approvalRequest: Readonly<ApprovalRequestRecord> | null;
}

export interface InspectAuthorizedClusterPluginPackagePublisherTrustTransitionRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly inspectionId: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectAuthorizedClusterPluginPackagePublisherRevocationRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly inspectionId: string;
  readonly principal: SecurityPrincipal;
}

export interface ClusterPluginPackagePublisherTrustManagementService {
  propose(
    request: ProposeClusterPluginPackagePublisherRevocationRequest,
  ): Promise<
    Readonly<ProposeClusterPluginPackagePublisherRevocationResult>
  >;
  inspect(
    actionRef: string,
    approvalRequestId: string,
  ): Promise<
    Readonly<InspectClusterPluginPackagePublisherRevocationResult>
  >;
  inspectAuthorized(
    request: InspectAuthorizedClusterPluginPackagePublisherRevocationRequest,
  ): Promise<
    Readonly<InspectClusterPluginPackagePublisherRevocationResult>
  >;
  proposeTransition(
    request: ProposeClusterPluginPackagePublisherTrustTransitionRequest,
  ): Promise<
    Readonly<ProposeClusterPluginPackagePublisherTrustTransitionResult>
  >;
  inspectTransition(
    actionRef: string,
    approvalRequestId: string,
  ): Promise<
    Readonly<InspectClusterPluginPackagePublisherTrustTransitionResult>
  >;
  inspectTransitionAuthorized(
    request: InspectAuthorizedClusterPluginPackagePublisherTrustTransitionRequest,
  ): Promise<
    Readonly<InspectClusterPluginPackagePublisherTrustTransitionResult>
  >;
}

export interface ClusterPluginPackagePublisherTrustManagementOptions {
  readonly pool: PostgresPool;
  readonly authorityProjectId: string;
  readonly trustAuthorityId: string;
  readonly materialSnapshot?: PluginPackagePublisherTrustSnapshot;
  readonly approvalLifetimeMs?: number;
  readonly now?: () => number;
  readonly quota?: PluginPackageManagementQuotaPort;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginPackageManagementRequestError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new PluginPackageManagementRequestError(
      `${label} shape is invalid`,
    );
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new PluginPackageManagementRequestError(`${label} is invalid`);
  }
  return value;
}

function actionRef(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    throw new PluginPackageManagementRequestError(
      'action reference is invalid',
    );
  }
  return value;
}

function projectId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    value.includes('\0')
  ) {
    throw new TypeError('publisher trust authority project is invalid');
  }
  return value;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageManagementRequestError(
      'request time is invalid',
    );
  }
  return value as number;
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function sameApproval(
  left: Readonly<ApprovalRequestRecord>,
  right: Readonly<ApprovalRequestRecord>,
): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.action.actionRef === right.action.actionRef &&
    left.action.actionDigest === right.action.actionDigest &&
    left.action.previewDigest === right.action.previewDigest &&
    left.decisionMode === right.decisionMode &&
    left.risk === right.risk &&
    sameSubject(left.requestedBy, right.requestedBy) &&
    left.requestedAtMs === right.requestedAtMs &&
    left.expiresAtMs === right.expiresAtMs
  );
}

function audit(
  eventId: string,
  requestId: string,
  operationId: string,
  project: string,
  principal: Readonly<SecurityPrincipal>,
  outcome: 'allowed' | 'approval_required',
  reasons: readonly string[],
  fence: Readonly<{ projectVersion: number; bindingVersion: number | null }>,
  occurredAtMs: number,
): SecurityAuditRecord {
  return {
    eventId,
    requestId,
    operationId,
    projectId: project,
    subject: principal.subject,
    authenticationId: principal.authenticationId,
    outcome,
    reasons,
    fence,
    occurredAtMs,
  };
}

export function createClusterPluginPackagePublisherTrustManagementService(
  options: ClusterPluginPackagePublisherTrustManagementOptions,
): Readonly<ClusterPluginPackagePublisherTrustManagementService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          'pool',
          'authorityProjectId',
          'trustAuthorityId',
          'materialSnapshot',
          'approvalLifetimeMs',
          'now',
          'quota',
        ].includes(key),
    )
  ) {
    throw new TypeError(
      'cluster publisher trust management options are invalid',
    );
  }
  const authorityProjectId = projectId(options.authorityProjectId);
  const trustAuthorityId = identifier(
    options.trustAuthorityId,
    'publisher trust authority id',
  );
  const approvalLifetimeMs =
    options.approvalLifetimeMs ?? DEFAULT_APPROVAL_LIFETIME_MS;
  if (
    !Number.isSafeInteger(approvalLifetimeMs) ||
    approvalLifetimeMs < 1_000 ||
    approvalLifetimeMs > MAX_APPROVAL_LIFETIME_MS ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.quota !== undefined &&
      (!options.quota ||
        typeof options.quota !== 'object' ||
        typeof options.quota.consume !== 'function'))
  ) {
    throw new TypeError(
      'cluster publisher trust management bounds are invalid',
    );
  }
  const now = options.now ?? Date.now;
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );
  const proposals =
    new PostgresPluginPackagePublisherRevocationProposalRepository(
      options.pool,
    );
  const transitionProposals =
    new PostgresPluginPackagePublisherTrustTransitionProposalRepository(
      options.pool,
    );
  const approvals = new PostgresApprovalRequestRepository(options.pool);
  const trust =
    new PostgresPluginPackagePublisherTrustAuthorityRepository(
      options.pool,
    );

  const inspect = async (
    requestedActionRef: string,
    approvalRequestIdValue: string,
  ): Promise<
    Readonly<InspectClusterPluginPackagePublisherRevocationResult>
  > => {
    const normalizedActionRef = actionRef(requestedActionRef);
    const approvalRequestId = identifier(
      approvalRequestIdValue,
      'approval request id',
    );
    const [proposal, approvalRequest] = await Promise.all([
      proposals.findProposalByActionRef(normalizedActionRef),
      approvals.findById(approvalRequestId),
    ]);
    return Object.freeze({
      proposal: proposal
        ? normalizePluginPackagePublisherRevocationProposal(proposal)
        : null,
      approvalRequest: approvalRequest
        ? normalizeApprovalRequestRecord(approvalRequest)
        : null,
    });
  };

  const inspectTransition = async (
    requestedActionRef: string,
    approvalRequestIdValue: string,
  ): Promise<
    Readonly<InspectClusterPluginPackagePublisherTrustTransitionResult>
  > => {
    const normalizedActionRef = actionRef(requestedActionRef);
    const approvalRequestId = identifier(
      approvalRequestIdValue,
      'approval request id',
    );
    const [proposal, approvalRequest] = await Promise.all([
      transitionProposals.findProposalByActionRef(normalizedActionRef),
      approvals.findById(approvalRequestId),
    ]);
    return Object.freeze({
      proposal: proposal
        ? normalizePluginPackagePublisherTrustTransitionProposal(proposal)
        : null,
      approvalRequest: approvalRequest
        ? normalizeApprovalRequestRecord(approvalRequest)
        : null,
    });
  };

  return Object.freeze({
    async propose(
      request: ProposeClusterPluginPackagePublisherRevocationRequest,
    ): Promise<
      Readonly<ProposeClusterPluginPackagePublisherRevocationResult>
    > {
      exactObject(
        request,
        [
          'actionRef',
          'approvalRequestId',
          'proposalAuditEventId',
          'approvalAuditEventId',
          'publisher',
          'keyId',
          'authorizationMode',
          'reasonCode',
          'requestedAtMs',
          'principal',
        ],
        'publisher revocation request',
      );
      const requestedActionRef = actionRef(request.actionRef);
      const approvalRequestId = identifier(
        request.approvalRequestId,
        'approval request id',
      );
      const requestedAtMs = timestamp(request.requestedAtMs);
      const observedAtMs = now();
      if (
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < requestedAtMs ||
        observedAtMs >= requestedAtMs + approvalLifetimeMs
      ) {
        throw new PluginPackageManagementRequestError(
          'request time is outside the approval lifetime',
        );
      }
      if (
        typeof request.publisher !== 'string' ||
        !PUBLISHER_PATTERN.test(request.publisher) ||
        (request.authorizationMode !== 'dual_control' &&
          request.authorizationMode !== 'break_glass') ||
        (request.reasonCode !== 'suspected_key_compromise' &&
          request.reasonCode !== 'confirmed_key_compromise')
      ) {
        throw new PluginPackageManagementRequestError(
          'publisher revocation target is invalid',
        );
      }
      const keyId = identifier(request.keyId, 'publisher key id');
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(
          request.principal,
          observedAtMs,
        );
      } catch {
        throw new PluginPackageManagementAuthorizationError();
      }
      if (
        principal.subject.type !== 'user' ||
        (principal.assurance !== 'multi_factor' &&
          principal.assurance !== 'hardware') ||
        (request.authorizationMode === 'break_glass' &&
          principal.assurance !== 'hardware')
      ) {
        throw new PluginPackageManagementAuthorizationError();
      }
      let decision;
      try {
        decision = await policy.authorize(
          principal,
          authorityProjectId,
          'package.manage',
        );
      } catch (error) {
        throw new PluginPackageManagementUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (
        decision.fence === null ||
        (decision.effect !== 'allow' &&
          decision.effect !== 'require_approval')
      ) {
        throw new PluginPackageManagementAuthorizationError();
      }
      if (options.quota) {
        try {
          await options.quota.consume({
            projectId: authorityProjectId,
            subject: principal.subject,
            operation: 'plugin-package.propose',
            idempotencyKey: requestedActionRef,
          });
        } catch (error) {
          if (error instanceof PluginPackageManagementQuotaExceededError) {
            throw error;
          }
          throw new PluginPackageManagementUnavailableError({
            cause: error instanceof Error ? error : undefined,
          });
        }
      }
      const state = await trust.findAuthority(trustAuthorityId);
      if (!state) {
        throw new PluginPackageManagementConflictError(
          'Publisher trust authority has not observed its base snapshot',
        );
      }
      let expectedProposal: Readonly<PluginPackagePublisherRevocationProposal>;
      try {
        expectedProposal =
          createPluginPackagePublisherRevocationProposal({
            actionRef: requestedActionRef,
            authorityProjectId,
            trustAuthorityId,
            trustGeneration: state.head.generation,
            trustSnapshot: state.effectiveSnapshot,
            publisher: request.publisher,
            keyId,
            authorizationMode: request.authorizationMode,
            reasonCode: request.reasonCode,
            proposedBy: principal.subject,
            proposerAssurance: principal.assurance,
            proposalFence: decision.fence,
            createdAtMs: requestedAtMs,
          });
      } catch {
        throw new PluginPackageManagementConflictError(
          'Publisher key is not currently trusted',
        );
      }
      const existingProposal =
        await proposals.findProposalByActionRef(requestedActionRef);
      let proposalResult: Readonly<CreatePluginPackagePublisherRevocationProposalResult>;
      if (existingProposal) {
        const normalized =
          normalizePluginPackagePublisherRevocationProposal(
            existingProposal,
          );
        if (normalized.proposalDigest !== expectedProposal.proposalDigest) {
          throw new PluginPackageManagementConflictError(
            'Publisher revocation action identity has different content',
          );
        }
        proposalResult = Object.freeze({
          status: 'existing' as const,
          proposal: normalized,
        });
      } else {
        proposalResult = await proposals.createProposal({
          proposal: expectedProposal,
          audit: audit(
            identifier(
              request.proposalAuditEventId,
              'proposal audit event id',
            ),
            requestedActionRef,
            'plugin_package.publisher_revocation.propose',
            authorityProjectId,
            principal,
            'allowed',
            ['publisher_revocation_proposal'],
            decision.fence,
            requestedAtMs,
          ),
        });
      }
      const proposal =
        normalizePluginPackagePublisherRevocationProposal(
          proposalResult.proposal,
        );
      const approval = createApprovalRequest({
        id: approvalRequestId,
        projectId: authorityProjectId,
        action: {
          permission: proposal.permission,
          actionType: proposal.actionType,
          actionRef: proposal.actionRef,
          actionDigest: proposal.actionDigest,
          previewDigest: proposal.previewDigest,
        },
        risk: 'critical',
        decisionMode:
          request.authorizationMode === 'dual_control'
            ? 'separation_of_duty'
            : 'human_confirmation',
        requestedBy: principal.subject,
        requestedAtMs,
        expiresAtMs: requestedAtMs + approvalLifetimeMs,
        requestFence: decision.fence,
      });
      const existingApproval = await approvals.findById(approvalRequestId);
      let approvalResult: Readonly<CreateApprovalRequestResult>;
      if (existingApproval) {
        const normalized = normalizeApprovalRequestRecord(existingApproval);
        if (!sameApproval(normalized, approval)) {
          throw new PluginPackageManagementConflictError(
            'Publisher revocation approval identity has different content',
          );
        }
        approvalResult = Object.freeze({
          status: 'existing' as const,
          request: normalized,
        });
      } else {
        approvalResult = await approvals.create({
          request: approval,
          audit: audit(
            identifier(
              request.approvalAuditEventId,
              'approval audit event id',
            ),
            approvalRequestId,
            'approval.request',
            authorityProjectId,
            principal,
            'approval_required',
            ['publisher_revocation_review'],
            decision.fence,
            requestedAtMs,
          ),
        });
      }
      return Object.freeze({
        proposalStatus: proposalResult.status,
        approvalStatus: approvalResult.status,
        proposal,
        approvalRequest: approvalResult.request,
      });
    },

    async proposeTransition(
      request: ProposeClusterPluginPackagePublisherTrustTransitionRequest,
    ): Promise<
      Readonly<ProposeClusterPluginPackagePublisherTrustTransitionResult>
    > {
      exactObject(
        request,
        [
          'actionRef',
          'approvalRequestId',
          'proposalAuditEventId',
          'approvalAuditEventId',
          'mode',
          'publisher',
          'keyId',
          'requestedAtMs',
          'principal',
        ],
        'publisher trust transition request',
      );
      const requestedActionRef = actionRef(request.actionRef);
      const approvalRequestId = identifier(
        request.approvalRequestId,
        'approval request id',
      );
      const requestedAtMs = timestamp(request.requestedAtMs);
      const observedAtMs = now();
      if (
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < requestedAtMs ||
        observedAtMs >= requestedAtMs + approvalLifetimeMs
      ) {
        throw new PluginPackageManagementRequestError(
          'request time is outside the approval lifetime',
        );
      }
      if (
        (request.mode !== 'overlap_add' &&
          request.mode !== 'safe_retire') ||
        typeof request.publisher !== 'string' ||
        !PUBLISHER_PATTERN.test(request.publisher)
      ) {
        throw new PluginPackageManagementRequestError(
          'publisher trust transition target is invalid',
        );
      }
      const keyId = identifier(request.keyId, 'publisher key id');
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(
          request.principal,
          observedAtMs,
        );
      } catch {
        throw new PluginPackageManagementAuthorizationError();
      }
      if (
        principal.subject.type !== 'user' ||
        (principal.assurance !== 'multi_factor' &&
          principal.assurance !== 'hardware')
      ) {
        throw new PluginPackageManagementAuthorizationError();
      }
      let decision;
      try {
        decision = await policy.authorize(
          principal,
          authorityProjectId,
          'package.manage',
        );
      } catch (error) {
        throw new PluginPackageManagementUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (
        decision.fence === null ||
        (decision.effect !== 'allow' &&
          decision.effect !== 'require_approval')
      ) {
        throw new PluginPackageManagementAuthorizationError();
      }
      if (options.quota) {
        try {
          await options.quota.consume({
            projectId: authorityProjectId,
            subject: principal.subject,
            operation: 'plugin-package.propose',
            idempotencyKey: requestedActionRef,
          });
        } catch (error) {
          if (error instanceof PluginPackageManagementQuotaExceededError) {
            throw error;
          }
          throw new PluginPackageManagementUnavailableError({
            cause: error instanceof Error ? error : undefined,
          });
        }
      }
      const state = await trust.findAuthority(trustAuthorityId);
      if (!state) {
        throw new PluginPackageManagementConflictError(
          'Publisher trust authority has not observed its base snapshot',
        );
      }
      let expected;
      try {
        expected = createPluginPackagePublisherTrustTransitionProposal({
          actionRef: requestedActionRef,
          authorityProjectId,
          trustAuthorityId,
          trustGeneration: state.head.generation,
          mode: request.mode,
          trustSnapshot: state.effectiveSnapshot,
          ...(request.mode === 'overlap_add'
            ? {
                materialSnapshot:
                  options.materialSnapshot ??
                  (() => {
                    throw new Error('publisher material is unavailable');
                  })(),
              }
            : {}),
          publisher: request.publisher,
          keyId,
          proposedBy: principal.subject,
          proposerAssurance: principal.assurance,
          proposalFence: decision.fence,
          createdAtMs: requestedAtMs,
        });
      } catch {
        throw new PluginPackageManagementConflictError(
          request.mode === 'overlap_add'
            ? 'Publisher material does not contain one exact active candidate key'
            : 'Publisher key cannot be safely retired with an active successor',
        );
      }
      const existingProposal =
        await transitionProposals.findProposalByActionRef(
          requestedActionRef,
        );
      let proposalResult: Readonly<CreatePluginPackagePublisherTrustTransitionProposalResult>;
      if (existingProposal) {
        const normalized =
          normalizePluginPackagePublisherTrustTransitionProposal(
            existingProposal,
          );
        if (
          normalized.proposalDigest !==
          expected.proposal.proposalDigest
        ) {
          throw new PluginPackageManagementConflictError(
            'Publisher trust transition action identity has different content',
          );
        }
        proposalResult = Object.freeze({
          status: 'existing' as const,
          proposal: normalized,
        });
      } else {
        proposalResult = await transitionProposals.createProposal({
          proposal: expected.proposal,
          candidateSnapshot: expected.candidateSnapshot,
          audit: audit(
            identifier(
              request.proposalAuditEventId,
              'proposal audit event id',
            ),
            requestedActionRef,
            'plugin_package.publisher_trust_transition.propose',
            authorityProjectId,
            principal,
            'allowed',
            ['publisher_trust_transition_proposal'],
            decision.fence,
            requestedAtMs,
          ),
        });
      }
      const proposal =
        normalizePluginPackagePublisherTrustTransitionProposal(
          proposalResult.proposal,
        );
      const approval = createApprovalRequest({
        id: approvalRequestId,
        projectId: authorityProjectId,
        action: {
          permission: proposal.permission,
          actionType: proposal.actionType,
          actionRef: proposal.actionRef,
          actionDigest: proposal.actionDigest,
          previewDigest: proposal.previewDigest,
        },
        risk: 'critical',
        decisionMode: 'separation_of_duty',
        requestedBy: principal.subject,
        requestedAtMs,
        expiresAtMs: requestedAtMs + approvalLifetimeMs,
        requestFence: decision.fence,
      });
      const existingApproval = await approvals.findById(approvalRequestId);
      let approvalResult: Readonly<CreateApprovalRequestResult>;
      if (existingApproval) {
        const normalized = normalizeApprovalRequestRecord(existingApproval);
        if (!sameApproval(normalized, approval)) {
          throw new PluginPackageManagementConflictError(
            'Publisher trust transition approval identity has different content',
          );
        }
        approvalResult = Object.freeze({
          status: 'existing' as const,
          request: normalized,
        });
      } else {
        approvalResult = await approvals.create({
          request: approval,
          audit: audit(
            identifier(
              request.approvalAuditEventId,
              'approval audit event id',
            ),
            approvalRequestId,
            'approval.request',
            authorityProjectId,
            principal,
            'approval_required',
            ['publisher_trust_transition_review'],
            decision.fence,
            requestedAtMs,
          ),
        });
      }
      return Object.freeze({
        proposalStatus: proposalResult.status,
        approvalStatus: approvalResult.status,
        proposal,
        approvalRequest: approvalResult.request,
      });
    },

    inspect,
    inspectTransition,

    async inspectAuthorized(
      request: InspectAuthorizedClusterPluginPackagePublisherRevocationRequest,
    ): Promise<
      Readonly<InspectClusterPluginPackagePublisherRevocationResult>
    > {
      exactObject(
        request,
        [
          'actionRef',
          'approvalRequestId',
          'inspectionId',
          'principal',
        ],
        'publisher revocation inspection',
      );
      const inspectionId = actionRef(request.inspectionId);
      const observedAtMs = now();
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(
          request.principal,
          observedAtMs,
        );
      } catch {
        throw new PluginPackageManagementAuthorizationError();
      }
      if (
        principal.subject.type !== 'user' ||
        (principal.assurance !== 'multi_factor' &&
          principal.assurance !== 'hardware')
      ) {
        throw new PluginPackageManagementAuthorizationError();
      }
      const current = await inspect(
        request.actionRef,
        request.approvalRequestId,
      );
      if (
        (current.proposal &&
          current.approvalRequest &&
          (current.proposal.projectId !==
            current.approvalRequest.projectId ||
            current.proposal.actionRef !==
              current.approvalRequest.action.actionRef ||
            current.proposal.actionDigest !==
              current.approvalRequest.action.actionDigest)) ||
        (current.proposal &&
          current.proposal.projectId !== authorityProjectId) ||
        (current.approvalRequest &&
          current.approvalRequest.projectId !== authorityProjectId)
      ) {
        throw new PluginPackageManagementUnavailableError();
      }
      let packageDecision;
      let approvalDecision;
      try {
        packageDecision = await policy.authorize(
          principal,
          authorityProjectId,
          'package.manage',
        );
        if (
          packageDecision.fence === null ||
          (packageDecision.effect !== 'allow' &&
            packageDecision.effect !== 'require_approval')
        ) {
          approvalDecision = await policy.authorize(
            principal,
            authorityProjectId,
            'approval.decide',
          );
        }
      } catch (error) {
        throw new PluginPackageManagementUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (
        (packageDecision.fence === null ||
          (packageDecision.effect !== 'allow' &&
            packageDecision.effect !== 'require_approval')) &&
        (!approvalDecision ||
          approvalDecision.fence === null ||
          approvalDecision.effect !== 'allow')
      ) {
        throw new PluginPackageManagementAuthorizationError();
      }
      if (options.quota) {
        try {
          await options.quota.consume({
            projectId: authorityProjectId,
            subject: principal.subject,
            operation: 'plugin-package.inspect',
            idempotencyKey: inspectionId,
          });
        } catch (error) {
          if (error instanceof PluginPackageManagementQuotaExceededError) {
            throw error;
          }
          throw new PluginPackageManagementUnavailableError({
            cause: error instanceof Error ? error : undefined,
          });
        }
      }
      return current;
    },

    async inspectTransitionAuthorized(
      request: InspectAuthorizedClusterPluginPackagePublisherTrustTransitionRequest,
    ): Promise<
      Readonly<InspectClusterPluginPackagePublisherTrustTransitionResult>
    > {
      exactObject(
        request,
        [
          'actionRef',
          'approvalRequestId',
          'inspectionId',
          'principal',
        ],
        'publisher trust transition inspection',
      );
      const inspectionId = actionRef(request.inspectionId);
      const observedAtMs = now();
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(
          request.principal,
          observedAtMs,
        );
      } catch {
        throw new PluginPackageManagementAuthorizationError();
      }
      if (
        principal.subject.type !== 'user' ||
        (principal.assurance !== 'multi_factor' &&
          principal.assurance !== 'hardware')
      ) {
        throw new PluginPackageManagementAuthorizationError();
      }
      const current = await inspectTransition(
        request.actionRef,
        request.approvalRequestId,
      );
      if (
        (current.proposal &&
          current.approvalRequest &&
          (current.proposal.projectId !==
            current.approvalRequest.projectId ||
            current.proposal.actionRef !==
              current.approvalRequest.action.actionRef ||
            current.proposal.actionDigest !==
              current.approvalRequest.action.actionDigest)) ||
        (current.proposal &&
          current.proposal.projectId !== authorityProjectId) ||
        (current.approvalRequest &&
          current.approvalRequest.projectId !== authorityProjectId)
      ) {
        throw new PluginPackageManagementUnavailableError();
      }
      let packageDecision;
      let approvalDecision;
      try {
        packageDecision = await policy.authorize(
          principal,
          authorityProjectId,
          'package.manage',
        );
        if (
          packageDecision.fence === null ||
          (packageDecision.effect !== 'allow' &&
            packageDecision.effect !== 'require_approval')
        ) {
          approvalDecision = await policy.authorize(
            principal,
            authorityProjectId,
            'approval.decide',
          );
        }
      } catch (error) {
        throw new PluginPackageManagementUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (
        (packageDecision.fence === null ||
          (packageDecision.effect !== 'allow' &&
            packageDecision.effect !== 'require_approval')) &&
        (!approvalDecision ||
          approvalDecision.fence === null ||
          approvalDecision.effect !== 'allow')
      ) {
        throw new PluginPackageManagementAuthorizationError();
      }
      if (options.quota) {
        try {
          await options.quota.consume({
            projectId: authorityProjectId,
            subject: principal.subject,
            operation: 'plugin-package.inspect',
            idempotencyKey: inspectionId,
          });
        } catch (error) {
          if (error instanceof PluginPackageManagementQuotaExceededError) {
            throw error;
          }
          throw new PluginPackageManagementUnavailableError({
            cause: error instanceof Error ? error : undefined,
          });
        }
      }
      return current;
    },
  });
}

import {
  MAX_APPROVAL_LIFETIME_MS,
  createApprovalRequest,
  normalizeApprovalRequestRecord,
  type ApprovalDecision,
  type ApprovalDecisionMode,
  type ApprovalRequestRecord,
  type ApprovalRequestRepository,
  type ApprovalRisk,
  type CreateApprovalRequestResult,
  type DecideApprovalRequestResult,
  type ConsumeDurableApprovalRequestResult,
} from '../approved-action/approvedAction';
import type { ApprovedActionDispatchBatchSummary } from '../approved-action/approvedActionDispatcher';
import {
  createPluginPackageInstallProposal,
  normalizePluginPackageInstallProposal,
  type CreatePluginPackageInstallProposalResult,
  type PluginPackageInstallProposal,
  type PluginPackageInstallProposalRepository,
} from './pluginPackageProposal';
import {
  normalizePluginPackageInstallActionInput,
  type PluginPackageInstallActionInput,
} from './installation/pluginPackageInstall';
import {
  ProjectPolicyEngine,
  type ProjectPolicyRequest,
} from '../security/project-policy/projectPolicy';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
  type SecuritySubject,
} from '../security/security';
import type { SecurityAuditRecord } from '../security/audit/securityAudit';

const DEFAULT_APPROVAL_LIFETIME_MS = 15 * 60 * 1000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const AUTHENTICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface PluginPackageManagementDispatchPort {
  dispatchBatch(
    options?: Readonly<{ limit?: number }>,
  ): Promise<Readonly<ApprovedActionDispatchBatchSummary>>;
}

export const PLUGIN_PACKAGE_MANAGEMENT_QUOTA_OPERATIONS = [
  'plugin-package.propose',
  'plugin-package.decide',
  'plugin-package.inspect',
] as const;

export type PluginPackageManagementQuotaOperation =
  (typeof PLUGIN_PACKAGE_MANAGEMENT_QUOTA_OPERATIONS)[number];

export interface ConsumePluginPackageManagementQuotaCommand {
  readonly projectId: string;
  readonly subject: SecuritySubject;
  readonly operation: PluginPackageManagementQuotaOperation;
  readonly idempotencyKey: string;
}

export interface PluginPackageManagementQuotaResult {
  readonly remaining: number;
  readonly resetAtMs: number;
  readonly observedAtMs: number;
}

export interface PluginPackageManagementQuotaPort {
  consume(
    command: ConsumePluginPackageManagementQuotaCommand,
  ): Promise<Readonly<PluginPackageManagementQuotaResult>>;
}

export interface PluginPackageManagementOptions {
  readonly decisionMode: ApprovalDecisionMode;
  readonly consumer: Readonly<{
    subject: SecuritySubject;
    authenticationId: string;
  }>;
  readonly approvalLifetimeMs?: number;
  readonly risk?: ApprovalRisk;
  readonly now?: () => number;
  readonly quota?: PluginPackageManagementQuotaPort;
}

export interface ProposePluginPackageInstallRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly proposalAuditEventId: string;
  readonly approvalAuditEventId: string;
  readonly requestedAtMs: number;
  readonly actionInput: PluginPackageInstallActionInput;
  readonly principal: SecurityPrincipal;
}

export interface ProposePluginPackageInstallResult {
  readonly proposalStatus: CreatePluginPackageInstallProposalResult['status'];
  readonly approvalStatus: CreateApprovalRequestResult['status'];
  readonly proposal: Readonly<PluginPackageInstallProposal>;
  readonly approvalRequest: Readonly<ApprovalRequestRecord>;
}

export interface DecidePluginPackageInstallRequest {
  readonly approvalRequestId: string;
  readonly expectedVersion: number;
  readonly decisionId: string;
  readonly auditEventId: string;
  readonly decision: ApprovalDecision;
  readonly reasonCode: string;
  readonly decidedAtMs: number;
  readonly principal: SecurityPrincipal;
}

export interface ConsumePluginPackageInstallRequest {
  readonly approvalRequestId: string;
  readonly expectedVersion: number;
  readonly consumptionId: string;
  readonly dispatchId: string;
  readonly auditEventId: string;
  readonly consumedAtMs: number;
}

export interface InspectPluginPackageInstallResult {
  readonly proposal: Readonly<PluginPackageInstallProposal> | null;
  readonly approvalRequest: Readonly<ApprovalRequestRecord> | null;
}

export interface PluginPackageManagementService {
  propose(
    request: ProposePluginPackageInstallRequest,
  ): Promise<Readonly<ProposePluginPackageInstallResult>>;
  decide(
    request: DecidePluginPackageInstallRequest,
  ): Promise<Readonly<DecideApprovalRequestResult>>;
  consume(
    request: ConsumePluginPackageInstallRequest,
  ): Promise<Readonly<ConsumeDurableApprovalRequestResult>>;
  inspect(
    actionRef: string,
    approvalRequestId: string,
  ): Promise<Readonly<InspectPluginPackageInstallResult>>;
  dispatch(
    limit?: number,
  ): Promise<Readonly<ApprovedActionDispatchBatchSummary>>;
}

export class PluginPackageManagementConfigurationError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_MANAGEMENT_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(`Plugin Package management configuration is invalid: ${message}`);
    this.name = 'PluginPackageManagementConfigurationError';
  }
}

export class PluginPackageManagementRequestError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_MANAGEMENT_REQUEST_INVALID';

  constructor(message: string) {
    super(`Plugin Package management request is invalid: ${message}`);
    this.name = 'PluginPackageManagementRequestError';
  }
}

export class PluginPackageManagementAuthorizationError extends Error {
  readonly code = 'PLUGIN_PACKAGE_MANAGEMENT_FORBIDDEN';

  constructor() {
    super('Plugin Package management is not authorized');
    this.name = 'PluginPackageManagementAuthorizationError';
  }
}

export class PluginPackageManagementConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_MANAGEMENT_CONFLICT';

  constructor(message = 'Plugin Package management state conflicts') {
    super(message);
    this.name = 'PluginPackageManagementConflictError';
  }
}

export class PluginPackageManagementUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_MANAGEMENT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package management is unavailable', options);
    this.name = 'PluginPackageManagementUnavailableError';
  }
}

export class PluginPackageManagementQuotaExceededError extends Error {
  readonly code = 'PLUGIN_PACKAGE_MANAGEMENT_QUOTA_EXCEEDED';

  constructor(readonly retryAfterMs: number) {
    if (
      !Number.isSafeInteger(retryAfterMs) ||
      retryAfterMs < 1 ||
      retryAfterMs > 5 * 60_000
    ) {
      throw new TypeError(
        'Plugin Package management quota retry delay is invalid',
      );
    }
    super('Plugin Package management quota is exhausted');
    this.name = 'PluginPackageManagementQuotaExceededError';
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginPackageManagementRequestError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new PluginPackageManagementRequestError(`${label} shape is invalid`);
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

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageManagementRequestError(`${label} is invalid`);
  }
  return value as number;
}

function positiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new PluginPackageManagementRequestError(`${label} is invalid`);
  }
  return value as number;
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function sameProposal(
  stored: Readonly<PluginPackageInstallProposal>,
  expected: Readonly<PluginPackageInstallProposal>,
): boolean {
  return stored.proposalDigest === expected.proposalDigest;
}

function sameApprovalRequest(
  stored: Readonly<ApprovalRequestRecord>,
  expected: Readonly<ApprovalRequestRecord>,
): boolean {
  return (
    stored.id === expected.id &&
    stored.projectId === expected.projectId &&
    stored.action.actionRef === expected.action.actionRef &&
    stored.action.actionType === expected.action.actionType &&
    stored.action.permission === expected.action.permission &&
    stored.action.actionDigest === expected.action.actionDigest &&
    stored.action.previewDigest === expected.action.previewDigest &&
    stored.risk === expected.risk &&
    stored.decisionMode === expected.decisionMode &&
    sameSubject(stored.requestedBy, expected.requestedBy) &&
    stored.requestedAtMs === expected.requestedAtMs &&
    stored.expiresAtMs === expected.expiresAtMs
  );
}

function allowedPolicy(
  effect: 'allow' | 'deny' | 'require_approval',
  allowApproval: boolean,
): boolean {
  return effect === 'allow' || (allowApproval && effect === 'require_approval');
}

function audit(
  eventId: string,
  requestId: string,
  operationId: string,
  projectId: string,
  subject: Readonly<SecuritySubject>,
  authenticationId: string,
  outcome: 'allowed' | 'approval_required',
  reasons: readonly string[],
  fence: Readonly<{ projectVersion: number; bindingVersion: number | null }>,
  occurredAtMs: number,
): SecurityAuditRecord {
  return {
    eventId,
    requestId,
    operationId,
    projectId,
    subject,
    authenticationId,
    outcome,
    reasons,
    fence,
    occurredAtMs,
  };
}

export function createPluginPackageManagementService(
  policy: ProjectPolicyEngine,
  proposals: PluginPackageInstallProposalRepository,
  approvals: ApprovalRequestRepository,
  dispatcher: PluginPackageManagementDispatchPort,
  options: PluginPackageManagementOptions,
): PluginPackageManagementService {
  if (
    !policy ||
    typeof policy.authorize !== 'function' ||
    typeof policy.decide !== 'function'
  ) {
    throw new PluginPackageManagementConfigurationError(
      'Project policy is invalid',
    );
  }
  if (
    !proposals ||
    typeof proposals.findProposalByActionRef !== 'function' ||
    typeof proposals.createProposal !== 'function'
  ) {
    throw new PluginPackageManagementConfigurationError(
      'proposal repository is invalid',
    );
  }
  if (
    !approvals ||
    typeof approvals.findById !== 'function' ||
    typeof approvals.create !== 'function' ||
    typeof approvals.decide !== 'function' ||
    typeof approvals.consume !== 'function'
  ) {
    throw new PluginPackageManagementConfigurationError(
      'approval repository is invalid',
    );
  }
  if (!dispatcher || typeof dispatcher.dispatchBatch !== 'function') {
    throw new PluginPackageManagementConfigurationError(
      'dispatcher is invalid',
    );
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new PluginPackageManagementConfigurationError('options are invalid');
  }
  const optionKeys = Object.keys(options);
  if (
    optionKeys.some(
      (key) =>
        key !== 'decisionMode' &&
        key !== 'consumer' &&
        key !== 'approvalLifetimeMs' &&
        key !== 'risk' &&
        key !== 'now' &&
        key !== 'quota',
    )
  ) {
    throw new PluginPackageManagementConfigurationError(
      'options shape is invalid',
    );
  }
  if (
    options.decisionMode !== 'human_confirmation' &&
    options.decisionMode !== 'separation_of_duty'
  ) {
    throw new PluginPackageManagementConfigurationError(
      'decision mode is invalid',
    );
  }
  if (
    !options.consumer ||
    typeof options.consumer !== 'object' ||
    Array.isArray(options.consumer) ||
    Object.keys(options.consumer).length !== 2 ||
    !Object.hasOwn(options.consumer, 'subject') ||
    !Object.hasOwn(options.consumer, 'authenticationId') ||
    options.consumer.subject?.type !== 'system' ||
    typeof options.consumer.subject.id !== 'string' ||
    options.consumer.subject.id.length < 1 ||
    options.consumer.subject.id.length > 255 ||
    !AUTHENTICATION_ID_PATTERN.test(options.consumer.authenticationId)
  ) {
    throw new PluginPackageManagementConfigurationError(
      'consumer authority is invalid',
    );
  }
  const approvalLifetimeMs =
    options.approvalLifetimeMs ?? DEFAULT_APPROVAL_LIFETIME_MS;
  if (
    !Number.isSafeInteger(approvalLifetimeMs) ||
    approvalLifetimeMs < 1_000 ||
    approvalLifetimeMs > MAX_APPROVAL_LIFETIME_MS
  ) {
    throw new PluginPackageManagementConfigurationError(
      'approval lifetime is invalid',
    );
  }
  const risk = options.risk ?? 'high';
  if (!['low', 'medium', 'high', 'critical'].includes(risk)) {
    throw new PluginPackageManagementConfigurationError('risk is invalid');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new PluginPackageManagementConfigurationError('clock is invalid');
  }
  if (
    options.quota !== undefined &&
    (!options.quota ||
      typeof options.quota !== 'object' ||
      Array.isArray(options.quota) ||
      typeof options.quota.consume !== 'function')
  ) {
    throw new PluginPackageManagementConfigurationError('quota is invalid');
  }
  const now = options.now ?? Date.now;
  const consumer = Object.freeze({
    subject: Object.freeze({
      type: 'system' as const,
      id: options.consumer.subject.id,
    }),
    authenticationId: options.consumer.authenticationId,
  });

  const currentTime = (): number => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PluginPackageManagementUnavailableError();
    }
    return value;
  };

  const authorizePrincipal = async (
    principalValue: SecurityPrincipal,
    projectId: string,
    permission: 'package.manage' | 'approval.decide',
    observedAtMs: number,
    allowApproval: boolean,
  ) => {
    let principal: Readonly<SecurityPrincipal>;
    try {
      principal = normalizeSecurityPrincipal(principalValue, observedAtMs);
    } catch {
      throw new PluginPackageManagementAuthorizationError();
    }
    let decision;
    try {
      decision = await policy.authorize(principal, projectId, permission);
    } catch (error) {
      throw new PluginPackageManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (
      !allowedPolicy(decision.effect, allowApproval) ||
      decision.fence === null
    ) {
      throw new PluginPackageManagementAuthorizationError();
    }
    return Object.freeze({ principal, fence: decision.fence });
  };

  const consumeQuota = async (
    projectId: string,
    principal: Readonly<SecurityPrincipal>,
    operation: PluginPackageManagementQuotaOperation,
    idempotencyKey: string,
  ): Promise<void> => {
    if (!options.quota) return;
    try {
      await options.quota.consume({
        projectId,
        subject: principal.subject,
        operation,
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof PluginPackageManagementQuotaExceededError) {
        throw error;
      }
      throw new PluginPackageManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
  };

  const propose = async (
    request: ProposePluginPackageInstallRequest,
  ): Promise<Readonly<ProposePluginPackageInstallResult>> => {
    exactObject(
      request,
      [
        'actionRef',
        'approvalRequestId',
        'proposalAuditEventId',
        'approvalAuditEventId',
        'requestedAtMs',
        'actionInput',
        'principal',
      ],
      'proposal request',
    );
    const requestedActionRef = actionRef(request.actionRef);
    const approvalRequestId = identifier(
      request.approvalRequestId,
      'approval request id',
    );
    const requestedAtMs = timestamp(request.requestedAtMs, 'request time');
    const observedAtMs = currentTime();
    if (
      requestedAtMs > observedAtMs ||
      observedAtMs >= requestedAtMs + approvalLifetimeMs
    ) {
      throw new PluginPackageManagementRequestError(
        'request time is outside the approval lifetime',
      );
    }
    let normalizedActionInput: Readonly<PluginPackageInstallActionInput>;
    try {
      normalizedActionInput = normalizePluginPackageInstallActionInput(
        request.actionInput,
      );
    } catch {
      throw new PluginPackageManagementRequestError(
        'install action input is invalid',
      );
    }
    const { principal, fence } = await authorizePrincipal(
      request.principal,
      normalizedActionInput.projectId,
      'package.manage',
      observedAtMs,
      true,
    );
    await consumeQuota(
      normalizedActionInput.projectId,
      principal,
      'plugin-package.propose',
      requestedActionRef,
    );
    const expectedProposal = createPluginPackageInstallProposal({
      actionRef: requestedActionRef,
      actionInput: normalizedActionInput,
      proposedBy: principal.subject,
      proposalFence: fence,
      createdAtMs: requestedAtMs,
    });
    let proposalResult: Readonly<CreatePluginPackageInstallProposalResult>;
    const existingProposal = await proposals.findProposalByActionRef(
      requestedActionRef,
    );
    if (existingProposal) {
      const normalized =
        normalizePluginPackageInstallProposal(existingProposal);
      if (!sameProposal(normalized, expectedProposal)) {
        throw new PluginPackageManagementConflictError(
          'Plugin Package proposal identity already has different content',
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
          identifier(request.proposalAuditEventId, 'proposal audit event id'),
          requestedActionRef,
          'plugin_package.propose',
          expectedProposal.projectId,
          principal.subject,
          principal.authenticationId,
          'allowed',
          ['package_proposal'],
          fence,
          requestedAtMs,
        ),
      });
    }

    const proposal = normalizePluginPackageInstallProposal(
      proposalResult.proposal,
    );
    const approval = createApprovalRequest({
      id: approvalRequestId,
      projectId: proposal.projectId,
      action: {
        permission: proposal.permission,
        actionType: proposal.actionType,
        actionRef: proposal.actionRef,
        actionDigest: proposal.actionDigest,
        previewDigest: proposal.previewDigest,
      },
      risk,
      decisionMode: options.decisionMode,
      requestedBy: principal.subject,
      requestedAtMs,
      expiresAtMs: requestedAtMs + approvalLifetimeMs,
      requestFence: fence,
    });
    let approvalResult: Readonly<CreateApprovalRequestResult>;
    const existingApproval = await approvals.findById(approvalRequestId);
    if (existingApproval) {
      const normalized = normalizeApprovalRequestRecord(existingApproval);
      if (!sameApprovalRequest(normalized, approval)) {
        throw new PluginPackageManagementConflictError(
          'Approval request identity already has different content',
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
          identifier(request.approvalAuditEventId, 'approval audit event id'),
          approvalRequestId,
          'approval.request',
          proposal.projectId,
          principal.subject,
          principal.authenticationId,
          'approval_required',
          ['package_review'],
          fence,
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
  };

  const decide = async (
    request: DecidePluginPackageInstallRequest,
  ): Promise<Readonly<DecideApprovalRequestResult>> => {
    exactObject(
      request,
      [
        'approvalRequestId',
        'expectedVersion',
        'decisionId',
        'auditEventId',
        'decision',
        'reasonCode',
        'decidedAtMs',
        'principal',
      ],
      'decision request',
    );
    const approvalRequestId = identifier(
      request.approvalRequestId,
      'approval request id',
    );
    const expectedVersion = positiveInteger(
      request.expectedVersion,
      'expected version',
      2_147_483_647,
    );
    const decisionId = identifier(request.decisionId, 'decision id');
    if (request.decision !== 'approved' && request.decision !== 'rejected') {
      throw new PluginPackageManagementRequestError('decision is invalid');
    }
    if (
      typeof request.reasonCode !== 'string' ||
      !REASON_PATTERN.test(request.reasonCode)
    ) {
      throw new PluginPackageManagementRequestError(
        'decision reason is invalid',
      );
    }
    const decidedAtMs = timestamp(request.decidedAtMs, 'decision time');
    const observedAtMs = currentTime();
    if (decidedAtMs > observedAtMs) {
      throw new PluginPackageManagementRequestError(
        'decision time is in the future',
      );
    }
    const current = await approvals.findById(approvalRequestId);
    if (!current) {
      throw new PluginPackageManagementConflictError(
        'Approval request does not exist',
      );
    }
    const approval = normalizeApprovalRequestRecord(current);
    const { principal, fence } = await authorizePrincipal(
      request.principal,
      approval.projectId,
      'approval.decide',
      observedAtMs,
      false,
    );
    await consumeQuota(
      approval.projectId,
      principal,
      'plugin-package.decide',
      decisionId,
    );
    return approvals.decide({
      requestId: approvalRequestId,
      expectedVersion,
      decisionId,
      decision: request.decision,
      reasonCode: request.reasonCode,
      principal,
      decidedAtMs,
      authorizationFence: fence,
      audit: audit(
        identifier(request.auditEventId, 'decision audit event id'),
        approvalRequestId,
        'approval.decide',
        approval.projectId,
        principal.subject,
        principal.authenticationId,
        'allowed',
        ['package_review'],
        fence,
        decidedAtMs,
      ),
    });
  };

  const consume = async (
    request: ConsumePluginPackageInstallRequest,
  ): Promise<Readonly<ConsumeDurableApprovalRequestResult>> => {
    exactObject(
      request,
      [
        'approvalRequestId',
        'expectedVersion',
        'consumptionId',
        'dispatchId',
        'auditEventId',
        'consumedAtMs',
      ],
      'consumption request',
    );
    const approvalRequestId = identifier(
      request.approvalRequestId,
      'approval request id',
    );
    const expectedVersion = positiveInteger(
      request.expectedVersion,
      'expected version',
      2_147_483_647,
    );
    const consumptionId = identifier(request.consumptionId, 'consumption id');
    const dispatchId = identifier(request.dispatchId, 'dispatch id');
    const consumedAtMs = timestamp(request.consumedAtMs, 'consumption time');
    const observedAtMs = currentTime();
    if (consumedAtMs > observedAtMs) {
      throw new PluginPackageManagementRequestError(
        'consumption time is in the future',
      );
    }
    const current = await approvals.findById(approvalRequestId);
    if (!current) {
      throw new PluginPackageManagementConflictError(
        'Approval request does not exist',
      );
    }
    const approval = normalizeApprovalRequestRecord(current);
    let policyDecision;
    try {
      const policyRequest: ProjectPolicyRequest = {
        subject: approval.requestedBy,
        projectId: approval.projectId,
        permission: 'package.manage',
      };
      policyDecision = await policy.decide(policyRequest);
    } catch (error) {
      throw new PluginPackageManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (!allowedPolicy(policyDecision.effect, true) || !policyDecision.fence) {
      throw new PluginPackageManagementAuthorizationError();
    }
    const fence = policyDecision.fence;
    return approvals.consume({
      requestId: approvalRequestId,
      expectedVersion,
      consumptionId,
      dispatchId,
      action: approval.action,
      requestedBy: approval.requestedBy,
      consumedBy: consumer.subject,
      consumedAtMs,
      authorizationFence: fence,
      audit: audit(
        identifier(request.auditEventId, 'consumption audit event id'),
        approvalRequestId,
        'approval.consume',
        approval.projectId,
        consumer.subject,
        consumer.authenticationId,
        'allowed',
        ['package_review'],
        fence,
        consumedAtMs,
      ),
    });
  };

  return Object.freeze({
    propose,
    decide,
    consume,
    async inspect(requestedActionRef: string, approvalRequestIdValue: string) {
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
          ? normalizePluginPackageInstallProposal(proposal)
          : null,
        approvalRequest: approvalRequest
          ? normalizeApprovalRequestRecord(approvalRequest)
          : null,
      });
    },
    dispatch(limit?: number) {
      return dispatcher.dispatchBatch(
        limit === undefined
          ? undefined
          : { limit: positiveInteger(limit, 'dispatch limit', 64) },
      );
    },
  });
}

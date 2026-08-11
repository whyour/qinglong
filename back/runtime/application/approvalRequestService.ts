import {
  ApprovalHumanDecisionRequiredError,
  ApprovalPolicyDeniedError,
  ApprovalRequestNotFoundError,
  ApprovalSelfDecisionError,
  approvalRequestEffectiveStatus,
  assertApprovalMutationId,
  assertApprovalReasonCode,
  assertApprovalRequestId,
  assertApprovalRequestVersion,
  assertApprovalTimestamp,
  normalizeApprovalActionBinding,
  normalizeApprovalRequestRecord,
  normalizeApprovalPolicyFence,
  sameApprovalSubject,
  type ApprovalActionBinding,
  type ApprovalDecision,
  type ApprovalRequestEffectiveStatus,
  type ApprovalRequestRecord,
  type ApprovedActionDispatchRecord,
  type ApprovalRisk,
} from '../domain/approvalRequest';
import {
  assertProjectPolicyProjectId,
  normalizePolicySubject,
  type PolicySubject,
} from '../domain/projectPolicy';
import type { ApprovalRequestRepository } from '../ports/approvalRequestRepository';
import type { ProjectPolicyEngine } from './projectPolicyEngine';

export interface CreateApprovalRequestInput {
  id: string;
  projectId: string;
  action: ApprovalActionBinding;
  risk: ApprovalRisk;
  requestedBy: PolicySubject;
  requestedAtMs: number;
  expiresAtMs: number;
}

export interface DecideApprovalRequestInput {
  requestId: string;
  expectedVersion: number;
  decisionId: string;
  decision: ApprovalDecision;
  reasonCode: string;
  decidedBy: PolicySubject;
  decidedAtMs: number;
}

export interface ConsumeApprovalRequestInput {
  requestId: string;
  expectedVersion: number;
  consumptionId: string;
  dispatchId: string;
  action: ApprovalActionBinding;
  requestedBy: PolicySubject;
  consumedBy: PolicySubject;
  consumedAtMs: number;
}

export interface ApprovalRequestView {
  request: Readonly<ApprovalRequestRecord>;
  effectiveStatus: ApprovalRequestEffectiveStatus;
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
    throw new TypeError(`${name} shape is invalid`);
  }
}

function assertInput(name: string, value: unknown): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

export class ApprovalRequestService {
  constructor(
    private readonly repository: ApprovalRequestRepository,
    private readonly policy: ProjectPolicyEngine,
  ) {}

  async create(
    input: CreateApprovalRequestInput,
  ): Promise<Readonly<ApprovalRequestRecord>> {
    assertInput('Approval create input', input);
    assertExactKeys('Approval create input', input, [
      'id',
      'projectId',
      'action',
      'risk',
      'requestedBy',
      'requestedAtMs',
      'expiresAtMs',
    ]);
    const action = normalizeApprovalActionBinding(input.action);
    const requestedBy = normalizePolicySubject(input.requestedBy);
    const request = normalizeApprovalRequestRecord({
      id: input.id,
      projectId: input.projectId,
      version: 1,
      state: 'pending',
      action,
      risk: input.risk,
      requestedBy,
      requestedAtMs: input.requestedAtMs,
      expiresAtMs: input.expiresAtMs,
      decisionId: null,
      decision: null,
      decisionReasonCode: null,
      decidedBy: null,
      decidedAtMs: null,
      consumptionId: null,
      dispatchId: null,
      consumedBy: null,
      consumedAtMs: null,
    });
    const authorization = await this.policy.decideWithFence({
      projectId: request.projectId,
      subject: requestedBy,
      permission: action.permission,
    });
    if (
      authorization.decision.effect !== 'require_approval' ||
      !authorization.fence
    ) {
      throw new ApprovalPolicyDeniedError();
    }
    const result = await this.repository.create({
      request,
      authorizationFence: normalizeApprovalPolicyFence(authorization.fence),
    });
    return result.request;
  }

  async decide(
    input: DecideApprovalRequestInput,
  ): Promise<Readonly<ApprovalRequestRecord>> {
    assertInput('Approval decision input', input);
    assertExactKeys('Approval decision input', input, [
      'requestId',
      'expectedVersion',
      'decisionId',
      'decision',
      'reasonCode',
      'decidedBy',
      'decidedAtMs',
    ]);
    assertApprovalRequestId(input.requestId);
    assertApprovalRequestVersion(input.expectedVersion);
    assertApprovalMutationId(input.decisionId);
    assertApprovalReasonCode(input.reasonCode);
    assertApprovalTimestamp('decidedAtMs', input.decidedAtMs);
    const decidedBy = normalizePolicySubject(input.decidedBy);
    if (decidedBy.type !== 'user') {
      throw new ApprovalHumanDecisionRequiredError();
    }
    const existing = await this.repository.findById(input.requestId);
    if (!existing) throw new ApprovalRequestNotFoundError();
    const request = normalizeApprovalRequestRecord(existing);
    if (sameApprovalSubject(request.requestedBy, decidedBy)) {
      throw new ApprovalSelfDecisionError();
    }
    const authorization = await this.policy.decideWithFence({
      projectId: request.projectId,
      subject: decidedBy,
      permission: 'approval.decide',
    });
    if (authorization.decision.effect !== 'allow' || !authorization.fence) {
      throw new ApprovalPolicyDeniedError();
    }
    const result = await this.repository.decide({
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      decisionId: input.decisionId,
      decision: input.decision,
      reasonCode: input.reasonCode,
      decidedBy,
      decidedAtMs: input.decidedAtMs,
      authorizationFence: normalizeApprovalPolicyFence(authorization.fence),
    });
    return result.request;
  }

  async consume(input: ConsumeApprovalRequestInput): Promise<{
    request: Readonly<ApprovalRequestRecord>;
    dispatch: Readonly<ApprovedActionDispatchRecord>;
  }> {
    assertInput('Approval consumption input', input);
    assertExactKeys('Approval consumption input', input, [
      'requestId',
      'expectedVersion',
      'consumptionId',
      'dispatchId',
      'action',
      'requestedBy',
      'consumedBy',
      'consumedAtMs',
    ]);
    assertApprovalRequestId(input.requestId);
    assertApprovalRequestVersion(input.expectedVersion);
    assertApprovalMutationId(input.consumptionId);
    assertApprovalMutationId(input.dispatchId);
    assertApprovalTimestamp('consumedAtMs', input.consumedAtMs);
    const action = normalizeApprovalActionBinding(input.action);
    const requestedBy = normalizePolicySubject(input.requestedBy);
    const consumedBy = normalizePolicySubject(input.consumedBy);
    if (consumedBy.type !== 'system' && consumedBy.type !== 'worker') {
      throw new ApprovalPolicyDeniedError();
    }
    const existing = await this.repository.findById(input.requestId);
    if (!existing) throw new ApprovalRequestNotFoundError();
    const request = normalizeApprovalRequestRecord(existing);
    const authorization = await this.policy.decideWithFence({
      projectId: request.projectId,
      subject: requestedBy,
      permission: action.permission,
    });
    if (
      (authorization.decision.effect !== 'allow' &&
        authorization.decision.effect !== 'require_approval') ||
      !authorization.fence
    ) {
      throw new ApprovalPolicyDeniedError();
    }
    const result = await this.repository.consume({
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      consumptionId: input.consumptionId,
      dispatchId: input.dispatchId,
      action,
      requestedBy,
      consumedBy,
      consumedAtMs: input.consumedAtMs,
      authorizationFence: normalizeApprovalPolicyFence(authorization.fence),
    });
    return Object.freeze({
      request: result.request,
      dispatch: result.dispatch,
    });
  }

  async get(requestId: string, nowMs: number): Promise<ApprovalRequestView> {
    assertApprovalRequestId(requestId);
    assertApprovalTimestamp('nowMs', nowMs);
    const request = await this.repository.findById(requestId);
    if (!request) throw new ApprovalRequestNotFoundError();
    const normalized = normalizeApprovalRequestRecord(request);
    return Object.freeze({
      request: normalized,
      effectiveStatus: approvalRequestEffectiveStatus(normalized, nowMs),
    });
  }
}

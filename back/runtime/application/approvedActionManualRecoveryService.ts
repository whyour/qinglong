import {
  assertAuthenticatedPrincipalActive,
  normalizeAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
} from '../domain/authenticatedPrincipal';
import {
  APPROVED_ACTION_RECOVERY_STRONG_ASSURANCES,
  ApprovedActionRecoveryAuthorizationDeniedError,
  ApprovedActionRecoveryHumanRequiredError,
  ApprovedActionRecoveryNotFoundError,
  ApprovedActionRecoveryStrongAuthenticationRequiredError,
  MAX_APPROVED_ACTION_RECOVERY_AUTH_AGE_MS,
  createApprovedActionRecoveryAuthorizationFact,
} from '../domain/approvedActionRecoveryAuthorization';
import {
  assertApprovedActionEvidenceDigest,
  type ApprovedActionRecoveryDecision,
} from '../domain/approvedActionRecovery';
import { assertApprovedActionResultCode } from '../domain/approvedActionDispatchExecution';
import { assertApprovalMutationId } from '../domain/approvalRequest';
import type {
  ApprovedActionRecoveryRepository,
  ResolveApprovedActionRecoveryResult,
} from '../ports/approvedActionRecoveryRepository';
import type { ProjectPolicyEngine } from './projectPolicyEngine';

export interface ManuallyResolveApprovedActionRecoveryInput {
  dispatchId: string;
  expectedExecutionVersion: number;
  expectedRecoveryVersion: number;
  mutationId: string;
  decision: ApprovedActionRecoveryDecision;
  evidenceDigest?: string;
  reasonCode: string;
  principal: AuthenticatedPrincipal;
}

function exactKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new TypeError('Manual recovery input shape is invalid');
  }
}

function assertVersion(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} is invalid`);
  }
}

export class ApprovedActionManualRecoveryService {
  constructor(
    private readonly repository: ApprovedActionRecoveryRepository,
    private readonly policy: ProjectPolicyEngine,
    private readonly clock: () => number = Date.now,
  ) {}

  async resolve(
    input: ManuallyResolveApprovedActionRecoveryInput,
  ): Promise<ResolveApprovedActionRecoveryResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Manual recovery input must be an object');
    }
    exactKeys(input, [
      'dispatchId',
      'expectedExecutionVersion',
      'expectedRecoveryVersion',
      'mutationId',
      'decision',
      ...(input.evidenceDigest === undefined ? [] : ['evidenceDigest']),
      'reasonCode',
      'principal',
    ]);
    assertApprovalMutationId(input.dispatchId);
    assertVersion('expectedExecutionVersion', input.expectedExecutionVersion);
    assertVersion('expectedRecoveryVersion', input.expectedRecoveryVersion);
    assertApprovalMutationId(input.mutationId);
    if (
      !['confirm_succeeded', 'confirm_failed', 'abandon_unknown'].includes(
        input.decision,
      )
    ) {
      throw new TypeError('Manual recovery decision is invalid');
    }
    if (input.evidenceDigest !== undefined) {
      assertApprovedActionEvidenceDigest(input.evidenceDigest);
    }
    assertApprovedActionResultCode(input.reasonCode);
    const resolvedAtMs = this.now();
    const principal = normalizeAuthenticatedPrincipal(input.principal);
    assertAuthenticatedPrincipalActive(principal, resolvedAtMs);
    if (principal.subject.type !== 'user') {
      throw new ApprovedActionRecoveryHumanRequiredError();
    }
    if (
      !APPROVED_ACTION_RECOVERY_STRONG_ASSURANCES.includes(
        principal.assurance as (typeof APPROVED_ACTION_RECOVERY_STRONG_ASSURANCES)[number],
      ) ||
      resolvedAtMs - principal.authenticatedAtMs >
        MAX_APPROVED_ACTION_RECOVERY_AUTH_AGE_MS
    ) {
      throw new ApprovedActionRecoveryStrongAuthenticationRequiredError();
    }
    const snapshot = await this.repository.findById(input.dispatchId);
    if (!snapshot) throw new ApprovedActionRecoveryNotFoundError();
    const authorization = await this.policy.decideWithFence({
      projectId: snapshot.action.dispatch.projectId,
      subject: principal.subject,
      permission: 'approval.recover',
    });
    if (
      authorization.decision.effect !== 'allow' ||
      !authorization.fence ||
      authorization.fence.bindingVersion === null
    ) {
      throw new ApprovedActionRecoveryAuthorizationDeniedError();
    }
    const authorizationFact = createApprovedActionRecoveryAuthorizationFact({
      dispatchId: input.dispatchId,
      projectId: snapshot.action.dispatch.projectId,
      mutationId: input.mutationId,
      resolvedBy: principal.subject,
      authenticationId: principal.authenticationId,
      assurance:
        principal.assurance as (typeof APPROVED_ACTION_RECOVERY_STRONG_ASSURANCES)[number],
      authenticatedAtMs: principal.authenticatedAtMs,
      projectVersion: authorization.fence.projectVersion,
      bindingVersion: authorization.fence.bindingVersion,
      authorizedAtMs: resolvedAtMs,
    });
    return this.repository.resolve({
      dispatchId: input.dispatchId,
      expectedExecutionVersion: input.expectedExecutionVersion,
      expectedRecoveryVersion: input.expectedRecoveryVersion,
      mutationId: input.mutationId,
      source: 'human',
      decision: input.decision,
      ...(input.evidenceDigest === undefined
        ? {}
        : { evidenceDigest: input.evidenceDigest }),
      reasonCode: input.reasonCode,
      resolvedBy: principal.subject,
      resolvedAtMs,
      authorizationFact,
    });
  }

  private now(): number {
    const nowMs = this.clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError('clock must return a non-negative safe integer');
    }
    return nowMs;
  }
}

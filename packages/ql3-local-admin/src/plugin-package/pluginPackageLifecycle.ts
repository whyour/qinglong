import type { DatabaseSync } from 'node:sqlite';

import { LocalSqliteApprovalRequestRepository } from '@qinglong/local-sqlite/approved-action';
import { LocalSqliteOperationAuthority } from '@qinglong/local-sqlite/operation-authority';
import { LocalSqlitePluginPackageLifecycleRepository } from '@qinglong/local-sqlite/plugin-package-lifecycle';
import { LocalSqliteProjectPolicyRepository } from '@qinglong/local-sqlite/project-policy';
import {
  createApprovalRequest,
  normalizeApprovalRequestRecord,
  type ApprovedActionBinding,
  type ApprovalRequestRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  createPluginPackageLifecycleEvent,
  normalizePluginPackageLifecycleImpact,
  pluginPackageLifecycleActionDigest,
  PluginPackageLifecycleConflictError,
  type PluginPackageLifecycleAction,
  type PluginPackageLifecycleImpact,
  type PluginPackageLifecycleReceipt,
} from '@qinglong/runtime-core/plugin-package-lifecycle';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
  type SecuritySubject,
} from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const APPROVAL_LIFETIME_MS = 15 * 60 * 1000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const LOCAL_LIFECYCLE_CONSUMER = Object.freeze({
  subject: Object.freeze({
    type: 'system' as const,
    id: 'local_plugin_package_lifecycle_executor',
  }),
  authenticationId: 'local_plugin_package_lifecycle_executor_v1',
});

export interface LocalPluginPackageLifecycleOptions {
  readonly authority: LocalSqliteOperationAuthority | DatabaseSync;
  readonly now?: () => number;
}

export interface ExecuteLocalPluginPackageLifecycleRequest {
  readonly impact: PluginPackageLifecycleImpact;
  readonly approvalRequestId: string;
  readonly decisionId: string;
  readonly consumptionId: string;
  readonly dispatchId: string;
  readonly approvalAuditEventId: string;
  readonly decisionAuditEventId: string;
  readonly consumptionAuditEventId: string;
  readonly reasonCode: string;
  readonly principal: SecurityPrincipal;
  readonly confirmAuthorization: () => void | Promise<void>;
}

export interface LocalPluginPackageLifecycleExecutionResult {
  readonly status: 'created' | 'existing';
  readonly approval: Readonly<ApprovalRequestRecord>;
  readonly receipt: Readonly<PluginPackageLifecycleReceipt>;
}

export interface LocalPluginPackageLifecycleService {
  plan(
    action: PluginPackageLifecycleAction,
    projectId: string,
    packageName: string,
    principal: SecurityPrincipal,
  ): Promise<Readonly<PluginPackageLifecycleImpact>>;
  execute(
    request: ExecuteLocalPluginPackageLifecycleRequest,
  ): Promise<Readonly<LocalPluginPackageLifecycleExecutionResult>>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function observedTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('local Plugin Package lifecycle clock is invalid');
  }
  return value;
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function sameAction(
  left: Readonly<ApprovedActionBinding>,
  right: Readonly<ApprovedActionBinding>,
): boolean {
  return (
    left.permission === right.permission &&
    left.actionType === right.actionType &&
    left.actionRef === right.actionRef &&
    left.actionDigest === right.actionDigest &&
    left.previewDigest === right.previewDigest
  );
}

function audit(
  eventId: string,
  requestId: string,
  operationId: 'approval.request' | 'approval.decide' | 'approval.consume',
  projectId: string,
  subject: Readonly<SecuritySubject>,
  authenticationId: string,
  outcome: 'allowed' | 'approval_required',
  fence: Readonly<SecurityPolicyFence>,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  return Object.freeze({
    eventId,
    requestId,
    operationId,
    projectId,
    subject,
    authenticationId,
    outcome,
    reasons: Object.freeze(['package_lifecycle_review']),
    fence,
    occurredAtMs,
  });
}

function actionBinding(
  impact: Readonly<PluginPackageLifecycleImpact>,
): Readonly<ApprovedActionBinding> {
  return Object.freeze({
    permission: 'package.manage',
    actionType: `plugin_package.lifecycle.${impact.action}`,
    actionRef: `lifecycle:${impact.impactDigest}`,
    actionDigest: pluginPackageLifecycleActionDigest(impact),
    previewDigest: impact.impactDigest,
  });
}

export function createLocalPluginPackageLifecycleService(
  options: LocalPluginPackageLifecycleOptions,
): Readonly<LocalPluginPackageLifecycleService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) => key !== 'authority' && key !== 'now',
    ) ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError('local Plugin Package lifecycle options are invalid');
  }
  const authority =
    options.authority instanceof LocalSqliteOperationAuthority
      ? options.authority
      : new LocalSqliteOperationAuthority(options.authority);
  const now = options.now ?? Date.now;
  const policy = new ProjectPolicyEngine(
    new LocalSqliteProjectPolicyRepository(authority),
  );
  const approvals = new LocalSqliteApprovalRequestRepository(authority);
  const lifecycles = new LocalSqlitePluginPackageLifecycleRepository(authority);

  const authorize = async (
    principalValue: SecurityPrincipal,
    projectId: string,
  ): Promise<
    Readonly<{
      principal: Readonly<SecurityPrincipal>;
      fence: Readonly<SecurityPolicyFence>;
    }>
  > => {
    const at = observedTime(now);
    const principal = normalizeSecurityPrincipal(principalValue, at);
    if (
      principal.subject.type !== 'user' ||
      principal.assurance !== 'local_console'
    ) {
      throw new PluginPackageLifecycleConflictError(
        'local lifecycle requires a local-console User',
      );
    }
    const decision = await policy.authorize(
      principal,
      projectId,
      'package.manage',
    );
    if (decision.effect !== 'allow' || decision.fence === null) {
      throw new PluginPackageLifecycleConflictError(
        'local lifecycle is not authorized by current Project policy',
      );
    }
    return Object.freeze({ principal, fence: decision.fence });
  };

  return Object.freeze({
    async plan(
      action: PluginPackageLifecycleAction,
      projectId: string,
      packageName: string,
      principalValue: SecurityPrincipal,
    ) {
      await authorize(principalValue, projectId);
      return lifecycles.plan(action, projectId, packageName);
    },

    async execute(request: ExecuteLocalPluginPackageLifecycleRequest) {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(request).sort().join('\0') !==
          [
            'approvalAuditEventId',
            'approvalRequestId',
            'confirmAuthorization',
            'consumptionAuditEventId',
            'consumptionId',
            'decisionAuditEventId',
            'decisionId',
            'dispatchId',
            'impact',
            'principal',
            'reasonCode',
          ]
            .sort()
            .join('\0') ||
        typeof request.confirmAuthorization !== 'function' ||
        typeof request.reasonCode !== 'string' ||
        !REASON_PATTERN.test(request.reasonCode)
      ) {
        throw new TypeError(
          'local Plugin Package lifecycle execution request is invalid',
        );
      }
      const approvalRequestId = identifier(
        request.approvalRequestId,
        'approvalRequestId',
      );
      const decisionId = identifier(request.decisionId, 'decisionId');
      const consumptionId = identifier(
        request.consumptionId,
        'consumptionId',
      );
      const dispatchId = identifier(request.dispatchId, 'dispatchId');
      const approvalAuditEventId = identifier(
        request.approvalAuditEventId,
        'approvalAuditEventId',
      );
      const decisionAuditEventId = identifier(
        request.decisionAuditEventId,
        'decisionAuditEventId',
      );
      const consumptionAuditEventId = identifier(
        request.consumptionAuditEventId,
        'consumptionAuditEventId',
      );
      const impact = normalizePluginPackageLifecycleImpact(request.impact);
      await request.confirmAuthorization();
      let authorization = await authorize(
        request.principal,
        impact.target.projectId,
      );
      const action = actionBinding(impact);
      let approval = await approvals.findById(approvalRequestId);
      if (!approval) {
        const requestedAtMs = observedTime(now);
        const created = await approvals.create({
          request: createApprovalRequest({
            id: approvalRequestId,
            projectId: impact.target.projectId,
            action,
            risk: 'high',
            decisionMode: 'human_confirmation',
            requestedBy: authorization.principal.subject,
            requestedAtMs,
            expiresAtMs: requestedAtMs + APPROVAL_LIFETIME_MS,
            requestFence: authorization.fence,
          }),
          audit: audit(
            approvalAuditEventId,
            approvalRequestId,
            'approval.request',
            impact.target.projectId,
            authorization.principal.subject,
            authorization.principal.authenticationId,
            'approval_required',
            authorization.fence,
            requestedAtMs,
          ),
        });
        approval = created.request;
      } else {
        approval = normalizeApprovalRequestRecord(approval);
        if (
          approval.projectId !== impact.target.projectId ||
          approval.decisionMode !== 'human_confirmation' ||
          !sameSubject(
            approval.requestedBy,
            authorization.principal.subject,
          ) ||
          !sameAction(approval.action, action)
        ) {
          throw new PluginPackageLifecycleConflictError(
            'approval identity is already bound to another lifecycle action',
          );
        }
      }

      if (approval.version === 1) {
        const decidedAtMs = observedTime(now);
        authorization = await authorize(
          request.principal,
          impact.target.projectId,
        );
        const decided = await approvals.decide({
          requestId: approvalRequestId,
          expectedVersion: 1,
          decisionId,
          decision: 'approved',
          reasonCode: request.reasonCode,
          principal: authorization.principal,
          decidedAtMs,
          authorizationFence: authorization.fence,
          audit: audit(
            decisionAuditEventId,
            approvalRequestId,
            'approval.decide',
            impact.target.projectId,
            authorization.principal.subject,
            authorization.principal.authenticationId,
            'allowed',
            authorization.fence,
            decidedAtMs,
          ),
        });
        approval = decided.request;
      }
      if (
        approval.state !== 'approved' &&
        approval.state !== 'consumed'
      ) {
        throw new PluginPackageLifecycleConflictError(
          'lifecycle approval is not approved',
        );
      }
      if (
        approval.decisionId !== decisionId ||
        approval.decision !== 'approved' ||
        approval.decisionReasonCode !== request.reasonCode ||
        !approval.decidedBy ||
        !sameSubject(
          approval.decidedBy,
          authorization.principal.subject,
        )
      ) {
        throw new PluginPackageLifecycleConflictError(
          'lifecycle approval decision is bound to another command',
        );
      }

      let dispatch = await approvals.findDispatchById(dispatchId);
      if (approval.version === 2) {
        const consumedAtMs = observedTime(now);
        authorization = await authorize(
          request.principal,
          impact.target.projectId,
        );
        const consumed = await approvals.consume({
          requestId: approvalRequestId,
          expectedVersion: 2,
          consumptionId,
          dispatchId,
          action,
          requestedBy: authorization.principal.subject,
          consumedBy: LOCAL_LIFECYCLE_CONSUMER.subject,
          consumedAtMs,
          authorizationFence: authorization.fence,
          audit: audit(
            consumptionAuditEventId,
            approvalRequestId,
            'approval.consume',
            impact.target.projectId,
            LOCAL_LIFECYCLE_CONSUMER.subject,
            LOCAL_LIFECYCLE_CONSUMER.authenticationId,
            'allowed',
            authorization.fence,
            consumedAtMs,
          ),
        });
        approval = consumed.request;
        dispatch = consumed.dispatch;
      }
      if (
        approval.version !== 3 ||
        approval.state !== 'consumed' ||
        approval.consumptionId !== consumptionId ||
        approval.dispatchId !== dispatchId ||
        !dispatch ||
        !sameAction(dispatch.action, action) ||
        !sameSubject(
          dispatch.requestedBy,
          authorization.principal.subject,
        ) ||
        !sameSubject(
          dispatch.approvedBy,
          authorization.principal.subject,
        ) ||
        !sameSubject(dispatch.consumedBy, LOCAL_LIFECYCLE_CONSUMER.subject)
      ) {
        throw new PluginPackageLifecycleConflictError(
          'lifecycle dispatch is bound to another command',
        );
      }

      const event = createPluginPackageLifecycleEvent({
        dispatchId: dispatch.id,
        impact,
        requestedBy: dispatch.requestedBy,
        approvedBy: dispatch.approvedBy,
        authorizationMode: 'human_confirmation',
        occurredAtMs: dispatch.createdAtMs,
      });
      const transitioned = await lifecycles.transition(event, async () => {
        await request.confirmAuthorization();
      });
      return Object.freeze({
        status: transitioned.status,
        approval,
        receipt: transitioned.receipt,
      });
    },
  });
}

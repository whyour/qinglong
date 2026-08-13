import { createHash } from 'node:crypto';

import {
  PostgresApprovalRequestRepository,
  PostgresPluginPackageSecretBindingTransitionApprovalPlanReader,
  PostgresProjectPolicyRepository,
} from '@qinglong/cluster-postgres/package-executor';
import type { PostgresPool } from '@qinglong/runtime-core';
import { pluginPackageSecretBindingTransitionApprovedAction } from '@qinglong/runtime-core/plugin-package-secret-binding-transition-approval-plan';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';

export const CLUSTER_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_BATCH_LIMIT =
  16;

export interface ConsumeClusterPluginPackageSecretBindingTransitionApprovalsOptions {
  readonly pool: PostgresPool;
  readonly now?: () => number;
  readonly limit?: number;
}

export interface ClusterPluginPackageSecretBindingTransitionApprovalSummary {
  readonly scanned: number;
  readonly consumed: number;
  readonly existing: number;
  readonly expired: number;
  readonly blocked: number;
}

const CONSUMER = Object.freeze({
  type: 'system' as const,
  id: 'cluster_package_executor',
});

function stableDigest(domain: string, value: string): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex');
}

function stableId(prefix: string, domain: string, value: string): string {
  return `${prefix}-${stableDigest(domain, value)}`;
}

function stableAuditEventId(requestId: string): string {
  const bytes = Buffer.from(
    stableDigest(
      'qinglong/plugin-package-secret-binding-transition-consume-audit@v1',
      requestId,
    ),
    'hex',
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function consumeClusterPluginPackageSecretBindingTransitionApprovals(
  options: ConsumeClusterPluginPackageSecretBindingTransitionApprovalsOptions,
): Promise<
  Readonly<ClusterPluginPackageSecretBindingTransitionApprovalSummary>
> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !['pool', 'now', 'limit'].includes(key)) ||
    !options.pool ||
    typeof options.pool.query !== 'function' ||
    typeof options.pool.connect !== 'function'
  ) {
    throw new TypeError('Secret transition approval consumer options are invalid');
  }
  const limit =
    options.limit ??
    CLUSTER_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_BATCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
    throw new TypeError('Secret transition approval consumer limit is invalid');
  }
  const observedAtMs = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new TypeError('Secret transition approval consumer clock is invalid');
  }
  const plans =
    new PostgresPluginPackageSecretBindingTransitionApprovalPlanReader(
      options.pool,
    );
  const approvals = new PostgresApprovalRequestRepository(options.pool);
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );
  const requests = await plans.listApprovedRequests(limit);
  let consumed = 0;
  let existing = 0;
  let expired = 0;
  let blocked = 0;
  for (const request of requests) {
    const plan = await plans.findByActionRef(request.action.actionRef);
    if (
      !plan ||
      request.projectId !== plan.transitionPlan.nextTarget.projectId ||
      request.decisionMode !== 'separation_of_duty' ||
      JSON.stringify(request.action) !==
        JSON.stringify(
          pluginPackageSecretBindingTransitionApprovedAction(plan),
        ) ||
      request.requestedBy.type !== plan.requestedBy.type ||
      request.requestedBy.id !== plan.requestedBy.id
    ) {
      blocked += 1;
      continue;
    }
    if (observedAtMs >= request.expiresAtMs || observedAtMs > plan.expiresAtMs) {
      expired += 1;
      continue;
    }
    const decision = await policy.decide({
      subject: request.requestedBy,
      projectId: request.projectId,
      permission: 'secret.manage',
    });
    if (
      decision.fence === null ||
      (decision.effect !== 'allow' && decision.effect !== 'require_approval')
    ) {
      blocked += 1;
      continue;
    }
    const result = await approvals.consume({
      requestId: request.id,
      expectedVersion: request.version,
      consumptionId: stableId(
        'psbtc',
        'qinglong/plugin-package-secret-binding-transition-consumption@v1',
        request.id,
      ),
      dispatchId: stableId(
        'psbtd',
        'qinglong/plugin-package-secret-binding-transition-dispatch@v1',
        request.id,
      ),
      action: request.action,
      requestedBy: request.requestedBy,
      consumedBy: CONSUMER,
      consumedAtMs: observedAtMs,
      authorizationFence: decision.fence,
      audit: {
        eventId: stableAuditEventId(request.id),
        requestId: request.id,
        operationId: 'approval.consume',
        projectId: request.projectId,
        subject: CONSUMER,
        authenticationId: 'cluster-package-executor',
        outcome: 'allowed',
        reasons: ['package_secret_binding_transition_execution'],
        fence: decision.fence,
        occurredAtMs: observedAtMs,
      },
    });
    if (result.status === 'consumed') consumed += 1;
    else existing += 1;
  }
  return Object.freeze({
    scanned: requests.length,
    consumed,
    existing,
    expired,
    blocked,
  });
}

// Cluster Plugin Package publisher boundary; keep transition approval authority explicit.
import { createHash } from 'node:crypto';

import { PostgresApprovalRequestRepository } from '@qinglong/cluster-postgres/approved-action';
import {
  PostgresPluginPackagePublisherTrustTransitionProposalRepository,
} from '@qinglong/cluster-postgres/package-executor';
import { PostgresProjectPolicyRepository } from '@qinglong/cluster-postgres/project-policy';
import type { PostgresPool } from '@qinglong/runtime-core';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';

export const CLUSTER_PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_APPROVAL_BATCH_LIMIT =
  16;

export interface ConsumeClusterPluginPackagePublisherTrustTransitionApprovalsOptions {
  readonly pool: PostgresPool;
  readonly now?: () => number;
  readonly limit?: number;
}

export interface ClusterPluginPackagePublisherTrustTransitionApprovalSummary {
  readonly scanned: number;
  readonly consumed: number;
  readonly existing: number;
  readonly expired: number;
  readonly blocked: number;
}

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
      'qinglong/plugin-package-publisher-trust-transition-consume-audit@v1',
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

export async function consumeClusterPluginPackagePublisherTrustTransitionApprovals(
  options: ConsumeClusterPluginPackagePublisherTrustTransitionApprovalsOptions,
): Promise<
  Readonly<ClusterPluginPackagePublisherTrustTransitionApprovalSummary>
> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) => !['pool', 'now', 'limit'].includes(key),
    ) ||
    !options.pool ||
    typeof options.pool.query !== 'function' ||
    typeof options.pool.connect !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError(
      'publisher trust transition approval consumer options are invalid',
    );
  }
  const limit =
    options.limit ??
    CLUSTER_PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_APPROVAL_BATCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
    throw new TypeError(
      'publisher trust transition approval consumer limit is invalid',
    );
  }
  const now = options.now ?? Date.now;
  const observedAtMs = now();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new TypeError(
      'publisher trust transition approval consumer clock is invalid',
    );
  }
  const proposals =
    new PostgresPluginPackagePublisherTrustTransitionProposalRepository(
      options.pool,
    );
  const approvals = new PostgresApprovalRequestRepository(options.pool);
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );
  const requests = await proposals.listApprovedRequests(limit);
  let consumed = 0;
  let existing = 0;
  let expired = 0;
  let blocked = 0;
  for (const request of requests) {
    if (observedAtMs >= request.expiresAtMs) {
      expired += 1;
      continue;
    }
    if (request.decisionMode !== 'separation_of_duty') {
      blocked += 1;
      continue;
    }
    const decision = await policy.decide({
      subject: request.requestedBy,
      projectId: request.projectId,
      permission: 'package.manage',
    });
    if (
      decision.fence === null ||
      (decision.effect !== 'allow' &&
        decision.effect !== 'require_approval')
    ) {
      blocked += 1;
      continue;
    }
    const consumptionId = stableId(
      'ppttc',
      'qinglong/plugin-package-publisher-trust-transition-consumption@v1',
      request.id,
    );
    const dispatchId = stableId(
      'ppttd',
      'qinglong/plugin-package-publisher-trust-transition-dispatch@v1',
      request.id,
    );
    const result = await approvals.consume({
      requestId: request.id,
      expectedVersion: request.version,
      consumptionId,
      dispatchId,
      action: request.action,
      requestedBy: request.requestedBy,
      consumedBy: {
        type: 'system',
        id: 'cluster_package_executor',
      },
      consumedAtMs: observedAtMs,
      authorizationFence: decision.fence,
      audit: {
        eventId: stableAuditEventId(request.id),
        requestId: request.id,
        operationId: 'approval.consume',
        projectId: request.projectId,
        subject: {
          type: 'system',
          id: 'cluster_package_executor',
        },
        authenticationId: 'cluster-package-executor',
        outcome: 'allowed',
        reasons: ['publisher_trust_transition_execution'],
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

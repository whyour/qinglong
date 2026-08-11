import { PostgresApprovalRequestRepository } from '@qinglong/cluster-postgres/approved-action';
import { PostgresProjectPolicyRepository } from '@qinglong/cluster-postgres/project-policy';
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  createApprovalDecisionService,
  type ApprovalDecisionService,
} from '@qinglong/runtime-core/approval-decision';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';

export interface ClusterApprovalDecisionManagementOptions {
  readonly pool: PostgresPool;
  readonly confirmAuthorization?: () => void | Promise<void>;
  readonly now?: () => number;
}

export class ClusterApprovalDecisionManagementConfigurationError extends TypeError {
  readonly code = 'CLUSTER_APPROVAL_DECISION_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(`Cluster Approval decision configuration is invalid: ${message}`);
    this.name = 'ClusterApprovalDecisionManagementConfigurationError';
  }
}

/**
 * Composes the profile-neutral human decision contract over a caller-owned
 * PostgreSQL pool. Transport authentication and lifecycle remain outside this
 * authority so cluster nodes can reuse their existing mTLS/OIDC boundary.
 */
export function createClusterApprovalDecisionManagementService(
  options: ClusterApprovalDecisionManagementOptions,
): Readonly<ApprovalDecisionService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'pool' && key !== 'confirmAuthorization' && key !== 'now',
    ) ||
    !options.pool ||
    typeof options.pool.query !== 'function' ||
    typeof options.pool.connect !== 'function' ||
    (options.confirmAuthorization !== undefined &&
      typeof options.confirmAuthorization !== 'function') ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new ClusterApprovalDecisionManagementConfigurationError(
      'options are invalid',
    );
  }
  return createApprovalDecisionService({
    approvals: new PostgresApprovalRequestRepository(options.pool),
    policy: new ProjectPolicyEngine(
      new PostgresProjectPolicyRepository(options.pool),
    ),
    ...(options.confirmAuthorization === undefined
      ? {}
      : { confirmAuthorization: options.confirmAuthorization }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

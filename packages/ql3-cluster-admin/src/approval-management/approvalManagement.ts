import {
  PostgresApprovalManagementIdentityKeysetLedgerRepository,
  PostgresApprovedActionManualRecoveryRepository,
  PostgresApprovalRequestRepository,
  PostgresApprovalRequestSource,
  PostgresProjectPolicyRepository,
  PostgresSecurityAuditRepository,
} from '@qinglong/cluster-postgres/approval-manager';
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  createApprovedActionManualRecoveryService,
  type ApprovedActionManualRecoveryInspectRequest,
  type ApprovedActionManualRecoveryResolveRequest,
  type ApprovedActionManualRecoveryService,
} from '@qinglong/runtime-core/approved-action-manual-recovery';
import {
  createApprovalDecisionService,
  type ApprovalDecisionRequest,
  type ApprovalDecisionService,
} from '@qinglong/runtime-core/approval-decision';
import {
  createApprovalInspectionService,
  type ApprovalInspectionRequest,
  type ApprovalInspectionService,
} from '@qinglong/runtime-core/approval-inspection';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

export interface ClusterApprovalManagementService {
  inspect(
    request: ApprovalInspectionRequest,
    confirmAuthorization: () => void | Promise<void>,
  ): ReturnType<ApprovalInspectionService['inspect']>;
  decide(
    request: ApprovalDecisionRequest,
    confirmAuthorization: () => void | Promise<void>,
  ): ReturnType<ApprovalDecisionService['decide']>;
  inspectRecovery(
    request: ApprovedActionManualRecoveryInspectRequest,
    confirmAuthorization: () => void | Promise<void>,
  ): ReturnType<ApprovedActionManualRecoveryService['inspect']>;
  resolveRecovery(
    request: ApprovedActionManualRecoveryResolveRequest,
    confirmAuthorization: () => void | Promise<void>,
  ): ReturnType<ApprovedActionManualRecoveryService['resolve']>;
  recordFailure(record: SecurityAuditRecord): Promise<void>;
}

export interface ClusterApprovalManagementOptions {
  readonly pool: PostgresPool;
  readonly now?: () => number;
}

export class ClusterApprovalManagementConfigurationError extends TypeError {
  readonly code = 'CLUSTER_APPROVAL_MANAGEMENT_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(`Cluster Approval management configuration is invalid: ${message}`);
    this.name = 'ClusterApprovalManagementConfigurationError';
  }
}

/** Dedicated Approval manager composition over one caller-owned Pool. */
export function createClusterApprovalManagementService(
  options: ClusterApprovalManagementOptions,
): Readonly<ClusterApprovalManagementService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'pool' && key !== 'now') ||
    !options.pool ||
    typeof options.pool.query !== 'function' ||
    typeof options.pool.connect !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new ClusterApprovalManagementConfigurationError(
      'options are invalid',
    );
  }
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );
  const approvals = new PostgresApprovalRequestRepository(options.pool);
  const source = new PostgresApprovalRequestSource(options.pool);
  const audit = new PostgresSecurityAuditRepository(options.pool);
  const recovery = createApprovedActionManualRecoveryService({
    repository: new PostgresApprovedActionManualRecoveryRepository(options.pool),
    policy,
    audit,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return Object.freeze({
    inspect(
      request: ApprovalInspectionRequest,
      confirmAuthorization: () => void | Promise<void>,
    ) {
      return createApprovalInspectionService({
        source,
        policy,
        audit,
        confirmAuthorization,
        ...(options.now === undefined ? {} : { now: options.now }),
      }).inspect(request);
    },
    decide(
      request: ApprovalDecisionRequest,
      confirmAuthorization: () => void | Promise<void>,
    ) {
      return createApprovalDecisionService({
        approvals,
        policy,
        confirmAuthorization,
        ...(options.now === undefined ? {} : { now: options.now }),
      }).decide(request);
    },
    inspectRecovery(
      request: ApprovedActionManualRecoveryInspectRequest,
      confirmAuthorization: () => void | Promise<void>,
    ) {
      return recovery.inspect(request, confirmAuthorization);
    },
    resolveRecovery(
      request: ApprovedActionManualRecoveryResolveRequest,
      confirmAuthorization: () => void | Promise<void>,
    ) {
      return recovery.resolve(request, confirmAuthorization);
    },
    recordFailure(record: SecurityAuditRecord) {
      return audit.record(record);
    },
  });
}

export { PostgresApprovalManagementIdentityKeysetLedgerRepository };

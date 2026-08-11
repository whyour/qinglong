/** Plugin Package management service boundary. */
import { PostgresApprovalRequestRepository } from '@qinglong/cluster-postgres/approved-action';
import { PostgresPluginPackageInstallInventoryReader } from '@qinglong/cluster-postgres/package-manager';
import { PostgresPluginPackageInstallProposalRepository } from '@qinglong/cluster-postgres/plugin-package-proposal';
import { PostgresProjectPolicyRepository } from '@qinglong/cluster-postgres/project-policy';
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  PluginPackageManagementAuthorizationError,
  PluginPackageManagementConflictError,
  PluginPackageManagementQuotaExceededError,
  PluginPackageManagementRequestError,
  PluginPackageManagementUnavailableError,
  createPluginPackageManagementService,
  type InspectPluginPackageInstallResult,
  type PluginPackageManagementQuotaPort,
  type PluginPackageManagementService as RuntimePluginPackageManagementService,
} from '@qinglong/runtime-core/plugin-package-management';
import {
  MAX_PLUGIN_PACKAGE_INSTALL_INVENTORY_PAGE_SIZE,
  normalizePluginPackageInstallInventoryCursor,
  type PluginPackageInstallInventoryItem,
  type PluginPackageInstallInventoryPage,
} from '@qinglong/runtime-core/plugin-package-install';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';

export const CLUSTER_PLUGIN_PACKAGE_MANAGEMENT_DECISION_MODE =
  'separation_of_duty' as const;

type ClusterPluginPackageManagementMutationService = Pick<
  RuntimePluginPackageManagementService,
  'propose' | 'decide' | 'inspect'
>;

export interface InspectAuthorizedClusterPluginPackageRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly inspectionId: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectAuthorizedClusterPluginPackageInstallationRequest {
  readonly projectId: string;
  readonly packageName: string;
  readonly inspectionId: string;
  readonly principal: SecurityPrincipal;
}

export interface ListAuthorizedClusterPluginPackageInstallationsRequest {
  readonly projectId: string;
  readonly limit: number;
  readonly after?: Readonly<{ packageName: string }>;
  readonly inspectionId: string;
  readonly principal: SecurityPrincipal;
}

export type ClusterPluginPackageManagementService =
  ClusterPluginPackageManagementMutationService &
    Readonly<{
      inspectAuthorized(
        request: InspectAuthorizedClusterPluginPackageRequest,
      ): Promise<Readonly<InspectPluginPackageInstallResult>>;
      inspectInstallationAuthorized(
        request: InspectAuthorizedClusterPluginPackageInstallationRequest,
      ): Promise<Readonly<PluginPackageInstallInventoryItem> | null>;
      listInstallationsAuthorized(
        request: ListAuthorizedClusterPluginPackageInstallationsRequest,
      ): Promise<Readonly<PluginPackageInstallInventoryPage>>;
    }>;

export interface ClusterPluginPackageManagementOptions {
  readonly pool: PostgresPool;
  readonly approvalLifetimeMs?: number;
  readonly now?: () => number;
  readonly quota?: PluginPackageManagementQuotaPort;
}

const INSPECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function createClusterPluginPackageManagementService(
  options: ClusterPluginPackageManagementOptions,
): Readonly<ClusterPluginPackageManagementService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'pool' &&
        key !== 'approvalLifetimeMs' &&
        key !== 'now' &&
        key !== 'quota',
    )
  ) {
    throw new TypeError(
      'cluster Plugin Package management options are invalid',
    );
  }
  const now = options.now ?? Date.now;
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );
  const installations = new PostgresPluginPackageInstallInventoryReader(
    options.pool,
  );
  const service = createPluginPackageManagementService(
    policy,
    new PostgresPluginPackageInstallProposalRepository(options.pool),
    new PostgresApprovalRequestRepository(options.pool),
    Object.freeze({
      async dispatchBatch(): Promise<never> {
        throw new Error(
          'cluster Plugin Package management cannot execute approved actions',
        );
      },
    }),
    {
      decisionMode: CLUSTER_PLUGIN_PACKAGE_MANAGEMENT_DECISION_MODE,
      consumer: Object.freeze({
        subject: Object.freeze({
          type: 'system' as const,
          id: 'cluster_package_management_unreachable_consumer',
        }),
        authenticationId: 'cluster-package-management-unreachable-consumer',
      }),
      ...(options.approvalLifetimeMs === undefined
        ? {}
        : { approvalLifetimeMs: options.approvalLifetimeMs }),
      now,
      ...(options.quota === undefined ? {} : { quota: options.quota }),
    },
  );

  const allowed = (
    decision: Readonly<SecurityPolicyDecision>,
    allowApproval: boolean,
  ): boolean =>
    decision.fence !== null &&
    (decision.effect === 'allow' ||
      (allowApproval && decision.effect === 'require_approval'));

  const authorizeInstallationInventory = async (
    projectId: string,
    inspectionId: string,
    principalValue: SecurityPrincipal,
  ): Promise<Readonly<SecurityPrincipal>> => {
    const observedAtMs = now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new PluginPackageManagementUnavailableError();
    }
    let principal: Readonly<SecurityPrincipal>;
    try {
      principal = normalizeSecurityPrincipal(principalValue, observedAtMs);
    } catch {
      throw new PluginPackageManagementAuthorizationError();
    }
    let decision: Readonly<SecurityPolicyDecision>;
    try {
      decision = await policy.authorize(principal, projectId, 'package.manage');
    } catch (error) {
      throw new PluginPackageManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (!allowed(decision, true)) {
      throw new PluginPackageManagementAuthorizationError();
    }
    if (options.quota) {
      try {
        await options.quota.consume({
          projectId,
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
    return principal;
  };

  return Object.freeze({
    propose: service.propose,
    decide: service.decide,
    inspect: service.inspect,
    async inspectInstallationAuthorized(
      request: InspectAuthorizedClusterPluginPackageInstallationRequest,
    ): Promise<Readonly<PluginPackageInstallInventoryItem> | null> {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(request).sort().join('\0') !==
          ['inspectionId', 'packageName', 'principal', 'projectId']
            .sort()
            .join('\0') ||
        typeof request.projectId !== 'string' ||
        !PROJECT_ID_PATTERN.test(request.projectId) ||
        typeof request.packageName !== 'string' ||
        !PACKAGE_NAME_PATTERN.test(request.packageName) ||
        typeof request.inspectionId !== 'string' ||
        !INSPECTION_ID_PATTERN.test(request.inspectionId)
      ) {
        throw new PluginPackageManagementRequestError(
          'installation inspection request is invalid',
        );
      }
      await authorizeInstallationInventory(
        request.projectId,
        request.inspectionId,
        request.principal,
      );
      try {
        return await installations.findCurrent(
          request.projectId,
          request.packageName,
        );
      } catch (error) {
        throw new PluginPackageManagementUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
    },
    async listInstallationsAuthorized(
      request: ListAuthorizedClusterPluginPackageInstallationsRequest,
    ): Promise<Readonly<PluginPackageInstallInventoryPage>> {
      const keys =
        request && typeof request === 'object' && !Array.isArray(request)
          ? Object.keys(request)
          : [];
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        !keys.includes('projectId') ||
        !keys.includes('limit') ||
        !keys.includes('inspectionId') ||
        !keys.includes('principal') ||
        keys.some(
          (key) =>
            ![
              'after',
              'inspectionId',
              'limit',
              'principal',
              'projectId',
            ].includes(key),
        ) ||
        typeof request.projectId !== 'string' ||
        !PROJECT_ID_PATTERN.test(request.projectId) ||
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > MAX_PLUGIN_PACKAGE_INSTALL_INVENTORY_PAGE_SIZE ||
        typeof request.inspectionId !== 'string' ||
        !INSPECTION_ID_PATTERN.test(request.inspectionId)
      ) {
        throw new PluginPackageManagementRequestError(
          'installation list request is invalid',
        );
      }
      let after: Readonly<{ packageName: string }> | undefined;
      try {
        after =
          request.after === undefined
            ? undefined
            : normalizePluginPackageInstallInventoryCursor(request.after);
      } catch {
        throw new PluginPackageManagementRequestError(
          'installation list cursor is invalid',
        );
      }
      await authorizeInstallationInventory(
        request.projectId,
        request.inspectionId,
        request.principal,
      );
      try {
        return await installations.listCurrentPage({
          projectId: request.projectId,
          limit: request.limit,
          ...(after === undefined ? {} : { after }),
        });
      } catch (error) {
        throw new PluginPackageManagementUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
    },
    async inspectAuthorized(
      request: InspectAuthorizedClusterPluginPackageRequest,
    ): Promise<Readonly<InspectPluginPackageInstallResult>> {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(request).length !== 4 ||
        Object.keys(request).some(
          (key) =>
            ![
              'actionRef',
              'approvalRequestId',
              'inspectionId',
              'principal',
            ].includes(key),
        ) ||
        typeof request.inspectionId !== 'string' ||
        !INSPECTION_ID_PATTERN.test(request.inspectionId)
      ) {
        throw new PluginPackageManagementRequestError(
          'inspection request is invalid',
        );
      }
      const observedAtMs = now();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
        throw new PluginPackageManagementUnavailableError();
      }
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(request.principal, observedAtMs);
      } catch {
        throw new PluginPackageManagementAuthorizationError();
      }
      const current = await service.inspect(
        request.actionRef,
        request.approvalRequestId,
      );
      const projectId =
        current.proposal?.projectId ?? current.approvalRequest?.projectId;
      if (!projectId) {
        throw new PluginPackageManagementConflictError(
          'Plugin Package management state does not exist',
        );
      }
      if (
        (current.proposal &&
          current.approvalRequest &&
          (current.proposal.projectId !== current.approvalRequest.projectId ||
            current.approvalRequest.action.actionRef !==
              current.proposal.actionRef ||
            current.approvalRequest.action.actionDigest !==
              current.proposal.actionDigest ||
            current.approvalRequest.action.previewDigest !==
              current.proposal.previewDigest)) ||
        (current.proposal &&
          current.proposal.actionRef !== request.actionRef) ||
        (current.approvalRequest &&
          current.approvalRequest.id !== request.approvalRequestId)
      ) {
        throw new PluginPackageManagementUnavailableError();
      }
      let packageDecision: Readonly<SecurityPolicyDecision>;
      let approvalDecision: Readonly<SecurityPolicyDecision> | undefined;
      try {
        packageDecision = await policy.authorize(
          principal,
          projectId,
          'package.manage',
        );
        if (!allowed(packageDecision, true)) {
          approvalDecision = await policy.authorize(
            principal,
            projectId,
            'approval.decide',
          );
        }
      } catch (error) {
        throw new PluginPackageManagementUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (
        !allowed(packageDecision, true) &&
        (!approvalDecision || !allowed(approvalDecision, false))
      ) {
        throw new PluginPackageManagementAuthorizationError();
      }
      if (options.quota) {
        try {
          await options.quota.consume({
            projectId,
            subject: principal.subject,
            operation: 'plugin-package.inspect',
            idempotencyKey: request.inspectionId,
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

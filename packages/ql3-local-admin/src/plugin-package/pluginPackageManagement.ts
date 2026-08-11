import type { DatabaseSync } from 'node:sqlite';

import { LocalSqliteApprovalRequestRepository } from '@qinglong/local-sqlite/approved-action';
import { LocalSqliteOperationAuthority } from '@qinglong/local-sqlite/operation-authority';
import { LocalSqlitePluginPackageInstallProposalRepository } from '@qinglong/local-sqlite/plugin-package-proposal';
import { LocalSqliteProjectPolicyRepository } from '@qinglong/local-sqlite/project-policy';
import type { ApprovedActionDispatcherOptions } from '@qinglong/runtime-core/approved-action-dispatcher';
import {
  createPluginPackageManagementService,
  type PluginPackageManagementOptions,
  type PluginPackageManagementService,
} from '@qinglong/runtime-core/plugin-package-management';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';

import {
  createLocalPluginPackageApprovedActionDispatcher,
  type LocalPluginPackageDispatchProfile,
} from './pluginPackageApprovedAction';

export const LOCAL_PLUGIN_PACKAGE_MANAGEMENT_DECISION_MODE =
  'human_confirmation' as const;

export interface LocalPluginPackageManagementOptions {
  readonly authority: LocalSqliteOperationAuthority | DatabaseSync;
  readonly profile: LocalPluginPackageDispatchProfile;
  readonly consumer: PluginPackageManagementOptions['consumer'];
  readonly dispatcher: Omit<
    ApprovedActionDispatcherOptions,
    'defaultBatchSize'
  > & {
    readonly defaultBatchSize?: number;
  };
  readonly approvalLifetimeMs?: number;
  readonly now?: () => number;
}

export function createLocalPluginPackageManagementService(
  options: LocalPluginPackageManagementOptions,
): PluginPackageManagementService {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('local Plugin Package management options are invalid');
  }
  const authority =
    options.authority instanceof LocalSqliteOperationAuthority
      ? options.authority
      : new LocalSqliteOperationAuthority(options.authority);
  const dispatcher = createLocalPluginPackageApprovedActionDispatcher({
    authority,
    profile: options.profile,
    ...options.dispatcher,
  });
  return createPluginPackageManagementService(
    new ProjectPolicyEngine(
      new LocalSqliteProjectPolicyRepository(authority),
    ),
    new LocalSqlitePluginPackageInstallProposalRepository(authority),
    new LocalSqliteApprovalRequestRepository(authority),
    dispatcher,
    {
      decisionMode: LOCAL_PLUGIN_PACKAGE_MANAGEMENT_DECISION_MODE,
      consumer: options.consumer,
      ...(options.approvalLifetimeMs === undefined
        ? {}
        : { approvalLifetimeMs: options.approvalLifetimeMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );
}

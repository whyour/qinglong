import type { DatabaseSync } from 'node:sqlite';

import { LocalSqliteApprovedActionExecutionRepository } from '@qinglong/local-sqlite/approved-action-execution';
import { LocalSqliteOperationAuthority } from '@qinglong/local-sqlite/operation-authority';
import { LocalSqlitePluginPackageInstallRepository } from '@qinglong/local-sqlite/plugin-package-install';
import { LocalSqlitePluginPackageInstallProposalRepository } from '@qinglong/local-sqlite/plugin-package-proposal';
import {
  ApprovedActionDispatcher,
  type ApprovedActionDispatcherOptions,
} from '@qinglong/runtime-core/approved-action-dispatcher';
import { PluginPackageApprovedActionHandler } from '@qinglong/runtime-core/plugin-package-approved-action';

export const LOCAL_PLUGIN_PACKAGE_DISPATCH_BATCH_LIMITS = Object.freeze({
  edge: 1,
  standalone: 4,
} as const);

export type LocalPluginPackageDispatchProfile =
  keyof typeof LOCAL_PLUGIN_PACKAGE_DISPATCH_BATCH_LIMITS;

export interface LocalPluginPackageApprovedActionDispatcherOptions
  extends Omit<ApprovedActionDispatcherOptions, 'defaultBatchSize'> {
  readonly authority: LocalSqliteOperationAuthority | DatabaseSync;
  readonly profile: LocalPluginPackageDispatchProfile;
  readonly defaultBatchSize?: number;
}

export function createLocalPluginPackageApprovedActionDispatcher(
  options: LocalPluginPackageApprovedActionDispatcherOptions,
): ApprovedActionDispatcher {
  if (!options || typeof options !== 'object') {
    throw new TypeError('local Package Approved Action options are invalid');
  }
  const {
    authority: authorityValue,
    profile,
    defaultBatchSize,
    ...dispatcherOptions
  } = options;
  if (!Object.hasOwn(LOCAL_PLUGIN_PACKAGE_DISPATCH_BATCH_LIMITS, profile)) {
    throw new TypeError('local Package Approved Action profile is invalid');
  }
  const authority =
    authorityValue instanceof LocalSqliteOperationAuthority
      ? authorityValue
      : new LocalSqliteOperationAuthority(authorityValue);
  const executions = new LocalSqliteApprovedActionExecutionRepository(
    authority,
  );
  const handler = new PluginPackageApprovedActionHandler(
    new LocalSqlitePluginPackageInstallProposalRepository(authority),
    new LocalSqlitePluginPackageInstallRepository(authority),
  );
  return new ApprovedActionDispatcher(executions, [handler], {
    ...dispatcherOptions,
    defaultBatchSize:
      defaultBatchSize ?? LOCAL_PLUGIN_PACKAGE_DISPATCH_BATCH_LIMITS[profile],
  });
}

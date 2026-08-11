// Cluster Plugin Package executor boundary; keep approved-action dispatch explicit.
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  ApprovedActionDispatcher,
  type ApprovedActionDispatcherOptions,
} from '@qinglong/runtime-core/approved-action-dispatcher';
import { PluginPackageApprovedActionHandler } from '@qinglong/runtime-core/plugin-package-approved-action';
import { PostgresApprovedActionExecutionRepository } from '@qinglong/cluster-postgres/approved-action-execution';
import { PostgresPluginPackageInstallRepository } from '@qinglong/cluster-postgres/plugin-package-install';
import { PostgresPluginPackageInstallProposalRepository } from '@qinglong/cluster-postgres/plugin-package-proposal';
import {
  PostgresPluginPackagePublisherRevocationProposalRepository,
  PostgresPluginPackagePublisherTrustTransitionProposalRepository,
  PostgresPluginPackagePublisherTrustTransitionRepository,
} from '@qinglong/cluster-postgres/package-executor';

import {
  ClusterPluginPackagePublisherRevocationApprovedActionHandler,
  type ClusterPluginPackagePublisherRevocationExecutionPort,
} from '../publisher/pluginPackagePublisherRevocationApprovedAction';
import {
  ClusterPluginPackagePublisherTrustTransitionApprovedActionHandler,
  type ClusterPluginPackagePublisherTrustTransitionExecutionPort,
} from '../publisher/pluginPackagePublisherTrustTransitionApprovedAction';

export const CLUSTER_PLUGIN_PACKAGE_DISPATCH_BATCH_LIMIT = 16;

export interface ClusterPluginPackageApprovedActionDispatcherOptions
  extends Omit<ApprovedActionDispatcherOptions, 'defaultBatchSize'> {
  readonly pool: PostgresPool;
  readonly defaultBatchSize?: number;
  readonly publisherRevocations?: ClusterPluginPackagePublisherRevocationExecutionPort;
  readonly publisherTrustTransitions?: ClusterPluginPackagePublisherTrustTransitionExecutionPort;
}

export function createClusterPluginPackageApprovedActionDispatcher(
  options: ClusterPluginPackageApprovedActionDispatcherOptions,
): ApprovedActionDispatcher {
  if (!options || typeof options !== 'object') {
    throw new TypeError('cluster Package Approved Action options are invalid');
  }
  const {
    pool,
    defaultBatchSize,
    publisherRevocations,
    publisherTrustTransitions,
    ...dispatcherOptions
  } = options;
  const executions = new PostgresApprovedActionExecutionRepository(pool);
  const handler = new PluginPackageApprovedActionHandler(
    new PostgresPluginPackageInstallProposalRepository(pool),
    new PostgresPluginPackageInstallRepository(pool),
  );
  const handlers = [
    handler,
    ...(['overlap_add', 'safe_retire'] as const).map(
      (mode) =>
        new ClusterPluginPackagePublisherTrustTransitionApprovedActionHandler(
          mode,
          new PostgresPluginPackagePublisherTrustTransitionProposalRepository(
            pool,
          ),
          publisherTrustTransitions ??
            new PostgresPluginPackagePublisherTrustTransitionRepository(pool),
        ),
    ),
    ...(publisherRevocations
      ? [
          new ClusterPluginPackagePublisherRevocationApprovedActionHandler(
            new PostgresPluginPackagePublisherRevocationProposalRepository(
              pool,
            ),
            publisherRevocations,
          ),
        ]
      : []),
  ];
  return new ApprovedActionDispatcher(executions, handlers, {
    ...dispatcherOptions,
    defaultBatchSize:
      defaultBatchSize ?? CLUSTER_PLUGIN_PACKAGE_DISPATCH_BATCH_LIMIT,
  });
}

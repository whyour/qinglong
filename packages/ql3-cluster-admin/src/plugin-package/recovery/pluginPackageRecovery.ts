// Cluster Plugin Package recovery boundary; keep recovery coordination authority explicit.
import type {
  OpenPostgresDatabase,
  PostgresDatabaseResource,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE,
  assertPluginPackageInstallMatchesLock,
} from '@qinglong/runtime-core/plugin-package-install';
import {
  MAX_PLUGIN_PACKAGE_RECOVERY_PAGES,
  PluginPackageRecoveryCoordinator,
  type PluginPackageRecoveryCycleResult,
} from '@qinglong/runtime-core/plugin-package-recovery';
import {
  PluginPackageAutomationPublicationCoordinator,
  PluginPackageAutomationPublicationRecoveryCoordinator,
  type PluginPackageAutomationPublicationRecoveryCycleResult,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import type { PluginPackageResourceByteSource } from '@qinglong/runtime-core/plugin-package-resource-materialization';
import {
  MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGES,
  MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGE_SIZE,
  PluginPackageTaskPublicationCoordinator,
  PluginPackageTaskPublicationRecoveryCoordinator,
  type PluginPackageTaskPublicationRecoveryCycleResult,
} from '@qinglong/runtime-core/plugin-package-task-publication';
import {
  MAX_PROJECT_TOOL_SNAPSHOT_RECOVERY_PAGES,
  MAX_PROJECT_TOOL_SNAPSHOT_RECOVERY_PAGE_SIZE,
  MAX_PROJECT_TOOL_SNAPSHOT_SOURCE_PAGE_SIZE,
  ProjectToolDefinitionSnapshotPublicationCoordinator,
  ProjectToolDefinitionSnapshotRecoveryCoordinator,
  type ProjectToolDefinitionSnapshotRecoveryCycleResult,
} from '@qinglong/runtime-core/project-tool-definition-snapshot';
import { createBuiltInTaskSpecSemanticRegistry } from '@qinglong/runtime-core/task-spec-semantic';
import {
  assertPostgresPackageExecutorSchemaReady,
  PostgresPluginPackageAutomationPublicationRepository,
  PostgresPluginPackageMaterializedRevisionRepository,
  PostgresPluginPackageSecretBindingRepository,
  PostgresPluginPackageSecretBindingActivationPrerequisite,
  PostgresPluginPackagePublisherProvenanceRepository,
  PostgresPluginPackageTaskReconciliationRepository,
  PostgresProjectToolDefinitionSnapshotRepository,
  type PostgresSchemaReadinessReport,
} from '@qinglong/cluster-postgres/package-executor';
import { PostgresPluginPackageInstallRepository } from '@qinglong/cluster-postgres/plugin-package-install';

import {
  PluginPackageKubernetesActivationPublisher,
  type PluginPackageKubernetesConfigMapApi,
} from './pluginPackageKubernetesActivation';
import {
  ClusterPluginPackageOciResourceByteSource,
  ClusterPluginPackageOciStageAuthority,
  clusterPluginPackageActivationEvidence,
  pluginPackageStageVerificationFailure,
  type ClusterPluginPackageStageAuthority,
} from './pluginPackageOciStage';
import {
  ClusterPluginPackageProvenanceInstallRepository,
  recoverClusterPluginPackagePublisherProvenance,
  type ClusterPluginPackagePublisherProvenanceRecoveryResult,
} from '../publisher/pluginPackagePublisherProvenanceRecovery';

export interface ClusterPluginPackageRecoveryOptions {
  readonly openDatabase: OpenPostgresDatabase;
  readonly api: PluginPackageKubernetesConfigMapApi;
  readonly stageAuthority?: ClusterPluginPackageStageAuthority;
  readonly stageAuthorityFactory?: (
    pool: PostgresPool,
  ) =>
    | ClusterPluginPackageStageAuthority
    | Promise<ClusterPluginPackageStageAuthority>;
  readonly resourceByteSource?: PluginPackageResourceByteSource;
  readonly trustAuthorityId: string;
  readonly clusterIdentity: string;
  readonly namespace: string;
  readonly now: () => number | Promise<number>;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ClusterPluginPackageRecoveryResult {
  readonly evidence: PostgresSchemaReadinessReport;
  readonly provenanceRecovery: Readonly<ClusterPluginPackagePublisherProvenanceRecoveryResult>;
  readonly recovery: Readonly<PluginPackageRecoveryCycleResult>;
  readonly taskPublicationRecovery: Readonly<PluginPackageTaskPublicationRecoveryCycleResult>;
  readonly automationPublicationRecovery: Readonly<PluginPackageAutomationPublicationRecoveryCycleResult>;
  readonly toolSnapshotRecovery: Readonly<ProjectToolDefinitionSnapshotRecoveryCycleResult>;
}

export class ClusterPluginPackageRecoveryRequiredError extends Error {
  constructor(readonly recovery: Readonly<PluginPackageRecoveryCycleResult>) {
    super('Cluster has unresolved Plugin Package recovery work');
    this.name = 'ClusterPluginPackageRecoveryRequiredError';
  }
}

export class ClusterPluginPackagePublisherProvenanceRecoveryRequiredError extends Error {
  constructor(
    readonly recovery: Readonly<ClusterPluginPackagePublisherProvenanceRecoveryResult>,
  ) {
    super('Cluster has unresolved Plugin Package publisher provenance work');
    this.name = 'ClusterPluginPackagePublisherProvenanceRecoveryRequiredError';
  }
}

export class ClusterPluginPackageTaskPublicationRequiredError extends Error {
  constructor(
    readonly recovery: Readonly<PluginPackageTaskPublicationRecoveryCycleResult>,
  ) {
    super('Cluster has unresolved Plugin Package Task publication work');
    this.name = 'ClusterPluginPackageTaskPublicationRequiredError';
  }
}

export class ClusterPluginPackageAutomationPublicationRequiredError extends Error {
  constructor(
    readonly recovery: Readonly<PluginPackageAutomationPublicationRecoveryCycleResult>,
  ) {
    super(
      'Cluster has unresolved Plugin Package Workflow/Prompt publication work',
    );
    this.name = 'ClusterPluginPackageAutomationPublicationRequiredError';
  }
}

export class ClusterPluginPackageToolSnapshotRequiredError extends Error {
  constructor(
    readonly recovery: Readonly<ProjectToolDefinitionSnapshotRecoveryCycleResult>,
  ) {
    super('Cluster has unresolved Plugin Package Tool snapshot work');
    this.name = 'ClusterPluginPackageToolSnapshotRequiredError';
  }
}

function assertOptions(options: ClusterPluginPackageRecoveryOptions): void {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          'openDatabase',
          'api',
          'stageAuthority',
          'stageAuthorityFactory',
          'resourceByteSource',
          'trustAuthorityId',
          'clusterIdentity',
          'namespace',
          'now',
          'pageSize',
          'maxPages',
        ].includes(key),
    ) ||
    typeof options.openDatabase !== 'function' ||
    (options.stageAuthority === undefined) ===
      (options.stageAuthorityFactory === undefined) ||
    (options.stageAuthorityFactory !== undefined &&
      typeof options.stageAuthorityFactory !== 'function') ||
    (options.resourceByteSource !== undefined &&
      (!options.resourceByteSource ||
        typeof options.resourceByteSource.open !== 'function')) ||
    typeof options.trustAuthorityId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.trustAuthorityId) ||
    typeof options.now !== 'function' ||
    (options.pageSize !== undefined &&
      (!Number.isSafeInteger(options.pageSize) ||
        options.pageSize < 1 ||
        options.pageSize >
          Math.min(
            MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE,
            MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGE_SIZE,
            MAX_PROJECT_TOOL_SNAPSHOT_RECOVERY_PAGE_SIZE,
          ))) ||
    (options.maxPages !== undefined &&
      (!Number.isSafeInteger(options.maxPages) ||
        options.maxPages < 1 ||
        options.maxPages >
          Math.min(
            MAX_PLUGIN_PACKAGE_RECOVERY_PAGES,
            MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGES,
            MAX_PROJECT_TOOL_SNAPSHOT_RECOVERY_PAGES,
          )))
  ) {
    throw new TypeError(
      'Cluster Plugin Package recovery configuration is invalid',
    );
  }
}

function assertStageAuthority(
  stageAuthority: ClusterPluginPackageStageAuthority,
  hasResourceByteSource: boolean,
): void {
  if (
    !stageAuthority ||
    typeof stageAuthority.stage !== 'function' ||
    typeof stageAuthority.publisherEvidence !== 'function' ||
    typeof stageAuthority.verify !== 'function' ||
    (!hasResourceByteSource &&
      !(stageAuthority instanceof ClusterPluginPackageOciStageAuthority))
  ) {
    throw new TypeError(
      'Cluster Plugin Package recovery stage authority is invalid',
    );
  }
}

/**
 * One-shot admin Job composition. The database is always closed before this
 * function settles, and no repository or Kubernetes authority escapes.
 */
export async function recoverClusterPluginPackages(
  options: ClusterPluginPackageRecoveryOptions,
): Promise<Readonly<ClusterPluginPackageRecoveryResult>> {
  assertOptions(options);

  let database: PostgresDatabaseResource | undefined;
  let result: Readonly<ClusterPluginPackageRecoveryResult> | undefined;
  let failure: unknown;
  try {
    database = await options.openDatabase();
    const evidence = await assertPostgresPackageExecutorSchemaReady(
      database.pool,
    );
    const stageAuthority =
      options.stageAuthority ??
      (await options.stageAuthorityFactory!(database.pool));
    assertStageAuthority(
      stageAuthority,
      options.resourceByteSource !== undefined,
    );
    const installRepository = new PostgresPluginPackageInstallRepository(
      database.pool,
    );
    const provenanceRepository =
      new PostgresPluginPackagePublisherProvenanceRepository(database.pool);
    const provenanceRecovery =
      await recoverClusterPluginPackagePublisherProvenance(
        installRepository,
        provenanceRepository,
        stageAuthority,
        {
          trustAuthorityId: options.trustAuthorityId,
          ...(options.pageSize === undefined
            ? {}
            : { pageSize: options.pageSize }),
          ...(options.maxPages === undefined
            ? {}
            : { maxPages: options.maxPages }),
        },
      );
    if (!provenanceRecovery.safeToAdmit) {
      throw new ClusterPluginPackagePublisherProvenanceRecoveryRequiredError(
        provenanceRecovery,
      );
    }
    const repository = new ClusterPluginPackageProvenanceInstallRepository(
      installRepository,
      provenanceRepository,
      stageAuthority,
      options.trustAuthorityId,
    );
    const publisher = new PluginPackageKubernetesActivationPublisher(
      options.api,
      {
        async verify(intent) {
          try {
            const [record, lock] = await Promise.all([
              repository.find(intent.projectId, intent.packageName),
              repository.findLock(intent.lockDigest),
            ]);
            if (
              !record ||
              !lock ||
              record.installationId !== intent.installationId ||
              record.lockDigest !== intent.lockDigest ||
              record.stageReceipt === null ||
              record.stageReceipt.stageRef !== intent.stageRef ||
              record.stageReceipt.receiptDigest !== intent.stageReceiptDigest ||
              record.stageReceipt.evidenceDigest !==
                intent.stageEvidenceDigest ||
              record.stageReceipt.contentDigest !== intent.contentDigest
            ) {
              return pluginPackageStageVerificationFailure(
                new Error('durable stage identity conflict'),
              );
            }
            assertPluginPackageInstallMatchesLock(lock, record);
            await stageAuthority.verify(lock, record.stageReceipt);
            await provenanceRepository.assertInstallationNotRevoked(
              record.installationId,
            );
            return clusterPluginPackageActivationEvidence(intent);
          } catch (error) {
            return pluginPackageStageVerificationFailure(error);
          }
        },
      },
      {
        clusterIdentity: options.clusterIdentity,
        namespace: options.namespace,
        now: options.now,
      },
    );
    const resourceByteSource =
      options.resourceByteSource ??
      new ClusterPluginPackageOciResourceByteSource({
        authority: stageAuthority as ClusterPluginPackageOciStageAuthority,
        lockSource: repository,
      });
    const recovery = await new PluginPackageRecoveryCoordinator({
      repository,
      stageProvider: stageAuthority,
      publisher,
      activationPrerequisite:
        new PostgresPluginPackageSecretBindingActivationPrerequisite(
          database.pool,
        ),
      now: options.now,
    }).recover({
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    });
    if (!recovery.safeToAdmit) {
      throw new ClusterPluginPackageRecoveryRequiredError(recovery);
    }
    const taskSpecSemanticRegistry = createBuiltInTaskSpecSemanticRegistry();
    const taskReconciliationRepository =
      new PostgresPluginPackageTaskReconciliationRepository(
        database.pool,
        taskSpecSemanticRegistry,
      );
    const materializedRepository =
      new PostgresPluginPackageMaterializedRevisionRepository(
        database.pool,
        taskSpecSemanticRegistry,
      );
    const secretBindingRepository =
      new PostgresPluginPackageSecretBindingRepository(database.pool);
    const taskPublicationRecovery =
      await new PluginPackageTaskPublicationRecoveryCoordinator({
        source: taskReconciliationRepository,
        publisher: new PluginPackageTaskPublicationCoordinator({
          generationSource: publisher,
          lockSource: repository,
          byteSource: resourceByteSource,
          materializedRepository,
          secretBindingSource: secretBindingRepository,
          reconciliationRepository: taskReconciliationRepository,
          taskSpecSemanticRegistry,
        }),
      }).recover({
        ...(options.pageSize === undefined
          ? {}
          : { pageSize: options.pageSize }),
        ...(options.maxPages === undefined
          ? {}
          : { maxPages: options.maxPages }),
      });
    if (!taskPublicationRecovery.safeToAdmit) {
      throw new ClusterPluginPackageTaskPublicationRequiredError(
        taskPublicationRecovery,
      );
    }
    const automationPublicationRepository =
      new PostgresPluginPackageAutomationPublicationRepository(database.pool);
    const automationPublicationRecovery =
      await new PluginPackageAutomationPublicationRecoveryCoordinator({
        source: automationPublicationRepository,
        publisher: new PluginPackageAutomationPublicationCoordinator({
          generationSource: publisher,
          materializedRepository,
          repository: automationPublicationRepository,
          taskSpecSemanticRegistry,
          now: options.now,
        }),
      }).recover({
        ...(options.pageSize === undefined
          ? {}
          : { pageSize: options.pageSize }),
        ...(options.maxPages === undefined
          ? {}
          : { maxPages: options.maxPages }),
      });
    if (!automationPublicationRecovery.safeToAdmit) {
      throw new ClusterPluginPackageAutomationPublicationRequiredError(
        automationPublicationRecovery,
      );
    }
    const toolSnapshotRepository =
      new PostgresProjectToolDefinitionSnapshotRepository(database.pool);
    const toolSnapshotRecovery =
      await new ProjectToolDefinitionSnapshotRecoveryCoordinator({
        source: toolSnapshotRepository,
        publisher: new ProjectToolDefinitionSnapshotPublicationCoordinator({
          source: toolSnapshotRepository,
          materializedRepository,
          repository: toolSnapshotRepository,
          taskSpecSemanticRegistry,
          pageSize: Math.min(
            options.pageSize ?? 16,
            MAX_PROJECT_TOOL_SNAPSHOT_SOURCE_PAGE_SIZE,
          ),
        }),
      }).recover({
        ...(options.pageSize === undefined
          ? {}
          : { pageSize: options.pageSize }),
        ...(options.maxPages === undefined
          ? {}
          : { maxPages: options.maxPages }),
      });
    if (!toolSnapshotRecovery.safeToAdmit) {
      throw new ClusterPluginPackageToolSnapshotRequiredError(
        toolSnapshotRecovery,
      );
    }
    result = Object.freeze({
      evidence,
      provenanceRecovery,
      recovery,
      taskPublicationRecovery,
      automationPublicationRecovery,
      toolSnapshotRecovery,
    });
  } catch (error) {
    failure = error;
  }

  if (database) {
    try {
      await database.close();
    } catch (closeError) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, closeError],
          'Cluster Plugin Package recovery failed and PostgreSQL did not close',
        );
      }
      throw closeError;
    }
  }
  if (failure !== undefined) throw failure;
  if (!result) {
    throw new Error('Cluster Plugin Package recovery produced no result');
  }
  return result;
}

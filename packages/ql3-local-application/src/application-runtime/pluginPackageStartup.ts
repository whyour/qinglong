import { LocalPluginPackageActivationPublisher } from '@qinglong/local-admin/package-activation';
import {
  createLocalPluginPackageResourceActivationPrerequisite,
  LocalPluginPackageResourceByteSource,
} from '@qinglong/local-admin/package-resource-materialization';
import {
  PluginPackageRecoveryCoordinator,
  type PluginPackageRecoveryCycleResult,
} from '@qinglong/runtime-core/plugin-package-recovery';
import { sequencePluginPackageActivationPrerequisites } from '@qinglong/runtime-core/plugin-package-installation';
import {
  PluginPackageAutomationPublicationCoordinator,
  PluginPackageAutomationPublicationRecoveryCoordinator,
  type PluginPackageAutomationPublicationRecoveryCycleResult,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import {
  MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGES,
  MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGE_SIZE,
  PluginPackageTaskPublicationCoordinator,
  PluginPackageTaskPublicationRecoveryCoordinator,
  type PluginPackageTaskPublicationRecoveryCycleResult,
} from '@qinglong/runtime-core/plugin-package-task-publication';
import {
  MAX_PROJECT_TOOL_SNAPSHOT_RECOVERY_PAGES,
  MAX_PROJECT_TOOL_SNAPSHOT_SOURCE_PAGE_SIZE,
  ProjectToolDefinitionSnapshotPublicationCoordinator,
  ProjectToolDefinitionSnapshotRecoveryCoordinator,
  type ProjectToolDefinitionSnapshotRecoveryCycleResult,
} from '@qinglong/runtime-core/project-tool-definition-snapshot';
import { createBuiltInTaskSpecSemanticRegistry } from '@qinglong/runtime-core/task-spec-semantic';
import type { LocalApplicationEnabledBootstrapOptions } from './contract';
import type { LocalApplicationReadyStorage } from './storageActivation';
import {
  LocalApplicationPluginPackageAutomationPublicationRequiredError,
  LocalApplicationPluginPackageRecoveryRequiredError,
  LocalApplicationPluginPackageTaskPublicationRequiredError,
  LocalApplicationPluginPackageToolSnapshotRequiredError,
} from './startupErrors';

export interface LocalApplicationPluginPackageStartup {
  readonly pluginPackageRecovery: Readonly<PluginPackageRecoveryCycleResult>;
  readonly pluginPackageTaskPublicationRecovery: Readonly<PluginPackageTaskPublicationRecoveryCycleResult>;
  readonly pluginPackageAutomationPublicationRecovery: Readonly<PluginPackageAutomationPublicationRecoveryCycleResult>;
  readonly pluginPackageToolSnapshotRecovery: Readonly<ProjectToolDefinitionSnapshotRecoveryCycleResult>;
}

export async function recoverLocalApplicationPluginPackages(
  options: LocalApplicationEnabledBootstrapOptions,
  storage: LocalApplicationReadyStorage,
): Promise<LocalApplicationPluginPackageStartup> {
  const pluginPackageInstalls = await storage.pluginPackageInstalls();
  const pluginPackageActivationPrerequisite =
    await storage.pluginPackageActivationPrerequisite();
  const taskSpecSemanticRegistry = createBuiltInTaskSpecSemanticRegistry();
  const pluginPackageMaterializedRevisions =
    await storage.pluginPackageMaterializedRevisions();
  const pluginPackageSecretBindings =
    await storage.pluginPackageSecretBindings();
  const pluginPackageResourceByteSource =
    new LocalPluginPackageResourceByteSource({
      stagingRoot: options.pluginPackages.stagingRoot,
    });
  const pluginPackageActivation = new LocalPluginPackageActivationPublisher({
    stagingRoot: options.pluginPackages.stagingRoot,
    activationRoot: options.pluginPackages.activationRoot,
    now: options.pluginPackages.now,
  });
  const pluginPackageRecovery = await new PluginPackageRecoveryCoordinator({
    repository: pluginPackageInstalls,
    stageProvider: options.pluginPackages.stageProvider,
    publisher: pluginPackageActivation,
    activationPrerequisite: sequencePluginPackageActivationPrerequisites([
      pluginPackageActivationPrerequisite,
      createLocalPluginPackageResourceActivationPrerequisite({
        byteSource: pluginPackageResourceByteSource,
        materializedRepository: pluginPackageMaterializedRevisions,
        secretBindingSource: pluginPackageSecretBindings,
        taskSpecSemanticRegistry,
      }),
    ]),
    now: options.pluginPackages.now,
  }).recover({
    ...(options.pluginPackages.pageSize === undefined
      ? {}
      : { pageSize: options.pluginPackages.pageSize }),
    ...(options.pluginPackages.maxPages === undefined
      ? {}
      : { maxPages: options.pluginPackages.maxPages }),
  });
  if (!pluginPackageRecovery.safeToAdmit) {
    throw new LocalApplicationPluginPackageRecoveryRequiredError(
      pluginPackageRecovery,
    );
  }
  await options.applicationAudit({
    profile: options.profile,
    state: 'plugin_packages_recovered',
    pluginPackageRecovery,
  });

  const pluginPackageTaskReconciliations =
    await storage.pluginPackageTaskReconciliations();
  const pluginPackageTaskPublicationRecovery =
    await new PluginPackageTaskPublicationRecoveryCoordinator({
      source: pluginPackageTaskReconciliations,
      publisher: new PluginPackageTaskPublicationCoordinator({
        generationSource: pluginPackageActivation,
        lockSource: pluginPackageInstalls,
        byteSource: pluginPackageResourceByteSource,
        materializedRepository: pluginPackageMaterializedRevisions,
        secretBindingSource: pluginPackageSecretBindings,
        reconciliationRepository: pluginPackageTaskReconciliations,
        taskSpecSemanticRegistry,
      }),
    }).recover({
      ...(options.pluginPackages.taskPublicationPageSize === undefined
        ? {}
        : { pageSize: options.pluginPackages.taskPublicationPageSize }),
      ...(options.pluginPackages.taskPublicationMaxPages === undefined
        ? {}
        : { maxPages: options.pluginPackages.taskPublicationMaxPages }),
    });
  if (!pluginPackageTaskPublicationRecovery.safeToAdmit) {
    throw new LocalApplicationPluginPackageTaskPublicationRequiredError(
      pluginPackageTaskPublicationRecovery,
    );
  }
  await options.applicationAudit({
    profile: options.profile,
    state: 'plugin_package_tasks_published',
    pluginPackageRecovery,
    pluginPackageTaskPublicationRecovery,
  });

  const pluginPackageAutomationPublications =
    await storage.pluginPackageAutomationPublications();
  const pluginPackageAutomationPublicationRecovery =
    await new PluginPackageAutomationPublicationRecoveryCoordinator({
      source: pluginPackageAutomationPublications,
      publisher: new PluginPackageAutomationPublicationCoordinator({
        generationSource: pluginPackageActivation,
        materializedRepository: pluginPackageMaterializedRevisions,
        repository: pluginPackageAutomationPublications,
        taskSpecSemanticRegistry,
        now: options.pluginPackages.now,
      }),
    }).recover({
      ...(options.pluginPackages.taskPublicationPageSize === undefined
        ? {}
        : { pageSize: options.pluginPackages.taskPublicationPageSize }),
      ...(options.pluginPackages.taskPublicationMaxPages === undefined
        ? {}
        : { maxPages: options.pluginPackages.taskPublicationMaxPages }),
    });
  if (!pluginPackageAutomationPublicationRecovery.safeToAdmit) {
    throw new LocalApplicationPluginPackageAutomationPublicationRequiredError(
      pluginPackageAutomationPublicationRecovery,
    );
  }
  await options.applicationAudit({
    profile: options.profile,
    state: 'plugin_package_automations_published',
    pluginPackageRecovery,
    pluginPackageTaskPublicationRecovery,
    pluginPackageAutomationPublicationRecovery,
  });

  const projectToolDefinitionSnapshots =
    await storage.projectToolDefinitionSnapshots();
  const pluginPackageToolSnapshotRecovery =
    await new ProjectToolDefinitionSnapshotRecoveryCoordinator({
      source: projectToolDefinitionSnapshots,
      publisher: new ProjectToolDefinitionSnapshotPublicationCoordinator({
        source: projectToolDefinitionSnapshots,
        materializedRepository: pluginPackageMaterializedRevisions,
        repository: projectToolDefinitionSnapshots,
        taskSpecSemanticRegistry,
        pageSize: Math.min(
          options.pluginPackages.taskPublicationPageSize ??
            (options.profile === 'edge' ? 4 : 16),
          MAX_PROJECT_TOOL_SNAPSHOT_SOURCE_PAGE_SIZE,
        ),
      }),
    }).recover({
      pageSize:
        options.pluginPackages.taskPublicationPageSize ??
        (options.profile === 'edge' ? 1 : 8),
      maxPages:
        options.pluginPackages.taskPublicationMaxPages ??
        MAX_PROJECT_TOOL_SNAPSHOT_RECOVERY_PAGES,
    });
  if (!pluginPackageToolSnapshotRecovery.safeToAdmit) {
    throw new LocalApplicationPluginPackageToolSnapshotRequiredError(
      pluginPackageToolSnapshotRecovery,
    );
  }
  await options.applicationAudit({
    profile: options.profile,
    state: 'plugin_package_tools_snapshotted',
    pluginPackageRecovery,
    pluginPackageTaskPublicationRecovery,
    pluginPackageAutomationPublicationRecovery,
    pluginPackageToolSnapshotRecovery,
  });

  return Object.freeze({
    pluginPackageRecovery,
    pluginPackageTaskPublicationRecovery,
    pluginPackageAutomationPublicationRecovery,
    pluginPackageToolSnapshotRecovery,
  });
}
